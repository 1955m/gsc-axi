import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Resolve Google Search Console connection config from flags + environment.
 *
 * Auth is a Google service account (SA) JSON key. The key path is resolved in
 * this priority order: `--key <path>` flag, `GSC_SA_KEY` env, then the default
 * `~/gsc-monitor/service-account.json`. The property (site) is resolved by
 * matching the `GSC_SITE`/`--site` hint against the account's verified
 * properties — the actual matching happens in `resolveProperty()` after a
 * `sites list` call, because we can't know the property's exact `siteUrl`
 * form (URL-prefix vs `sc-domain:`) until we enumerate them.
 */
export interface GscCtx {
  /** Absolute path to the service-account JSON key file (may not exist yet). */
  keyPath: string;
  /** Whether the key file was found to exist at resolve time. */
  keyExists: boolean;
  /** The SA client email, once the key has been read. */
  clientEmail?: string;
  /** Property hint (bare domain, full URL, or `sc-domain:...`). */
  siteHint?: string;
  /** Source of the site hint: flag, env, or unset. */
  siteSource: "flag" | "env" | "unset";
  /** Read-only or read/write scope. */
  scope: "readonly" | "write";
  /** API base host (default https://www.googleapis.com). */
  host: string;
  /** URL Inspection lives on a separate host. */
  inspectionHost: string;
}

const DEFAULT_HOST = "https://www.googleapis.com";
const INSPECTION_HOST = "https://searchconsole.googleapis.com";
const DEFAULT_KEY_REL = "gsc-monitor/service-account.json";

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function defaultKeyPath(): string {
  return resolve(homedir(), DEFAULT_KEY_REL);
}

export function resolveConfig(opts: {
  keyFlag?: string;
  siteFlag?: string;
  write?: boolean;
}): GscCtx {
  let keyPath: string;
  if (opts.keyFlag) {
    keyPath = resolve(opts.keyFlag);
  } else if (process.env.GSC_SA_KEY) {
    keyPath = resolve(process.env.GSC_SA_KEY);
  } else {
    keyPath = defaultKeyPath();
  }

  let siteHint: string | undefined;
  let siteSource: "flag" | "env" | "unset" = "unset";
  if (opts.siteFlag) {
    siteHint = opts.siteFlag;
    siteSource = "flag";
  } else if (process.env.GSC_SITE) {
    siteHint = process.env.GSC_SITE;
    siteSource = "env";
  }

  const envHost = process.env.GSC_HOST ? stripTrailingSlash(process.env.GSC_HOST) : undefined;
  const envInspection = process.env.GSC_INSPECTION_HOST
    ? stripTrailingSlash(process.env.GSC_INSPECTION_HOST)
    : undefined;

  return {
    keyPath,
    keyExists: existsSync(keyPath),
    siteHint,
    siteSource,
    scope: opts.write ? "write" : "readonly",
    host: envHost ?? DEFAULT_HOST,
    inspectionHost: envInspection ?? INSPECTION_HOST,
  };
}

/** The OAuth scope URL for the configured access level. */
export function scopeUrl(scope: "readonly" | "write"): string {
  return scope === "write"
    ? "https://www.googleapis.com/auth/webmasters"
    : "https://www.googleapis.com/auth/webmasters.readonly";
}

/**
 * Encode a `siteUrl` path segment for the Search Console REST paths.
 * `https://www.example.com/` -> `https%3A%2F%2Fwww.example.com%2F`;
 * `sc-domain:example.com` -> `sc-domain%3Aexample.com`.
 */
export function encodeSiteUrl(siteUrl: string): string {
  return encodeURIComponent(siteUrl);
}
