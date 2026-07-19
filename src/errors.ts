import { AxiError as SdkAxiError, exitCodeForError as sdkExitCode } from "axi-sdk-js";
import type { GscCtx } from "./config.js";

export { SdkAxiError as AxiError, sdkExitCode as exitCodeForError };

import type { GscCtx as Ctx } from "./config.js";

/** Throw a clear, actionable error when the SA key file is missing. */
export function requireKey(ctx: Ctx): void {
  if (!ctx.keyExists) {
    throw new SdkAxiError(
      `Service-account key not found at ${ctx.keyPath}`,
      "AUTH_REQUIRED",
      [
        "Create a Google service account in Google Cloud Console (IAM & Admin > Service Accounts)",
        "Create and download a JSON key, then either:",
        `  export GSC_SA_KEY=/path/to/service-account.json   (or pass --key <path>)`,
        `  Default location: ~/gsc-monitor/service-account.json`,
        "Add the SA's client_email as a user on the Search Console property (Restricted or Full)",
        "Enable the Search Console API in Google Cloud Console (APIs & Services > Library)",
      ],
    );
  }
}

interface HttpLikeError {
  status: number;
  body: unknown;
  url: string;
}

/**
 * Map a Google Search Console HTTP failure to an actionable AxiError (never
 * leak raw API JSON). Google's error envelope is:
 * `{ error: { code, message, status, errors: [{ reason, message }] } }`.
 */
export function mapHttpError(e: HttpLikeError): SdkAxiError {
  const { status, body } = e;
  const gerr = pick(body, "error");
  const bodyObj = (typeof body === "object" && body ? (body as Record<string, unknown>) : {}) as Record<string, unknown>;
  const message =
    (typeof gerr === "object" && gerr && typeof gerr.message === "string" && gerr.message) ||
    (typeof bodyObj.message === "string" ? bodyObj.message : "") ||
    "";
  const reason =
    (typeof gerr === "object" &&
      gerr &&
      Array.isArray(gerr.errors) &&
      gerr.errors[0]?.reason) ||
    (typeof gerr === "object" && gerr && gerr.status) ||
    "";

  if (status === 401 || status === 403) {
    // Distinguish "SA lacks the property" (403 forbidden) from "bad key" (401).
    if (status === 403 || /forbidden|access.*denied|does not have/i.test(message)) {
      return new SdkAxiError(
        "The service account is not a user on this Search Console property (403)",
        "FORBIDDEN",
        [
          "In Search Console, add the SA's client_email as a user on the property (Restricted or Full)",
          "If using sc-domain: the SA needs the domain property added, not just a URL-prefix",
          "Verify the property in sites list: `gsc-axi sites`",
        ],
      );
    }
    return new SdkAxiError("Authentication failed — the service-account key is invalid or expired", "AUTH_REQUIRED", [
      "Check the key file is a valid service-account JSON with a private_key",
      "Re-download the key from Google Cloud Console if the private key was rotated",
      "Enable the Search Console API in Google Cloud Console",
    ]);
  }
  if (status === 404) {
    return new SdkAxiError("Property or resource not found (404)", "NOT_FOUND", [
      "Run `gsc-axi sites` to list properties the SA can access",
      "Confirm --site matches a property exactly (sc-domain: or full URL-prefix)",
    ]);
  }
  if (status === 429) {
    return new SdkAxiError("Google API rate limit hit (429) — wait and retry", "RATE_LIMITED", [
      "Search Console API quota: 200 queries/min, 1,800/day per property",
      "Wait ~60s and retry",
    ]);
  }
  if (status === 400 || status === 422) {
    return new SdkAxiError(
      `Google rejected the request (HTTP ${status}): ${message || reason || "bad request"}`,
      "VALIDATION_ERROR",
      ["Check field names and values against `gsc-axi <cmd> --help`"],
    );
  }
  if (status >= 500) {
    return new SdkAxiError(`Google server error (HTTP ${status})`, "SERVER_ERROR", [
      "Retry in a few seconds; check https://status.google.com if it persists",
    ]);
  }
  return new SdkAxiError(`Google API error (HTTP ${status})`, "UNKNOWN", [
    message ? `Google: ${message}` : "Run with --help to verify the command shape",
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(body: unknown, key: string): any {
  if (typeof body !== "object" || body === null) return undefined;
  return (body as Record<string, unknown>)[key] as any;
}
