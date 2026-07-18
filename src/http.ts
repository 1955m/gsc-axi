import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { AxiError, mapHttpError, requireKey } from "./errors.js";
import type { GscCtx } from "./config.js";
import { encodeSiteUrl, scopeUrl } from "./config.js";

const WEBMASTERS_ROOT = "/webmasters/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_TIMEOUT_MS = 60_000;
const QUERY_TIMEOUT_MS = 120_000;

// ─────────────────────────────────────────────────────────────────────────────
// Service-account auth (RS256 JWT → OAuth2 access token), with in-process cache.
// No googleapis SDK: we sign with node:crypto and POST the assertion ourselves,
// matching the sibling axi tools' "raw fetch, no vendor SDK" approach.
// ─────────────────────────────────────────────────────────────────────────────

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
  scope: string;
}

const keyCache = new Map<string, ServiceAccountKey>();
const tokenCache = new Map<string, CachedToken>();

/** Read + parse the service-account JSON key (cached by path). */
function readServiceAccount(ctx: GscCtx): ServiceAccountKey {
  requireKey(ctx);
  const cached = keyCache.get(ctx.keyPath);
  if (cached) return cached;
  let raw: string;
  try {
    raw = readFileSync(ctx.keyPath, "utf8");
  } catch {
    // The file vanished between resolveConfig and now.
    keyCache.delete(ctx.keyPath);
    throw new AxiError(
      `Could not read service-account key at ${ctx.keyPath}`,
      "AUTH_REQUIRED",
      [`Point to a readable key: export GSC_SA_KEY=/path/to/service-account.json`],
    );
  }
  let key: ServiceAccountKey;
  try {
    key = JSON.parse(raw) as ServiceAccountKey;
  } catch {
    throw new AxiError(
      `Key at ${ctx.keyPath} is not valid JSON`,
      "AUTH_REQUIRED",
      ["Re-download the service-account JSON key from Google Cloud Console"],
    );
  }
  if (!key.client_email || !key.private_key) {
    throw new AxiError(
      `Key at ${ctx.keyPath} is missing client_email or private_key`,
      "AUTH_REQUIRED",
      ["Use a service-account JSON key, not an API key or OAuth client secret"],
    );
  }
  keyCache.set(ctx.keyPath, key);
  ctx.clientEmail = key.client_email;
  return key;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign a Google OAuth2 JWT assertion (RS256) for the given scope. */
function signJwt(key: ServiceAccountKey, scope: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const payload = {
    iss: key.client_email,
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(key.private_key);
  return `${signingInput}.${b64url(signature)}`;
}

/** Acquire (or reuse a cached) OAuth2 access token for the given scope. */
export async function getAccessToken(ctx: GscCtx, scopeOverride?: GscCtx["scope"]): Promise<string> {
  const scope = scopeUrl(scopeOverride ?? ctx.scope);
  const cacheKey = `${ctx.keyPath}:${scope}`;
  const cached = tokenCache.get(cacheKey);
  // Refresh a minute before expiry so a slow query doesn't hit a 401 mid-flight.
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }
  const key = readServiceAccount(ctx);
  const assertion = signJwt(key, scope);
  const res = await fetchJson<{ access_token?: string; expires_in?: number; error?: string; error_description?: string }>(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    },
    DEFAULT_TIMEOUT_MS,
    // Token endpoint errors should map to AUTH_REQUIRED, not the generic GSC mapper.
    (status, body) => mapTokenError(status, body),
  );
  if (!res.body.access_token) {
    throw new AxiError("Google token endpoint returned no access_token", "AUTH_REQUIRED", [
      "Re-check the service-account key; the private key may have been rotated or revoked",
    ]);
  }
  const expiresIn = res.body.expires_in ?? 3600;
  tokenCache.set(cacheKey, {
    accessToken: res.body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    scope,
  });
  return res.body.access_token;
}

function mapTokenError(status: number, body: unknown): AxiError {
  const err =
    typeof body === "object" && body && "error" in body
      ? String((body as Record<string, unknown>).error)
      : "";
  const desc =
    typeof body === "object" && body && "error_description" in body
      ? String((body as Record<string, unknown>).error_description)
      : "";
  if (status === 400 && err === "invalid_grant") {
    return new AxiError("Service-account token request rejected (invalid_grant)", "AUTH_REQUIRED", [
      desc ? `Google: ${desc}` : "The private key may be invalid or revoked; re-download the JSON key",
      "Confirm the Search Console API is enabled in Google Cloud Console",
    ]);
  }
  return new AxiError(`Google token endpoint error (HTTP ${status}): ${err || desc || "unknown"}`, "AUTH_REQUIRED", [
    "Re-check the service-account key file",
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP core
// ─────────────────────────────────────────────────────────────────────────────

interface FetchResult<T> {
  status: number;
  body: T;
}

async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onError?: (status: number, body: unknown) => AxiError,
): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: T;
    if (text.length === 0) {
      body = null as T; // sitemap submit returns an empty body on success
    } else {
      try {
        body = JSON.parse(text) as T;
      } catch {
        body = text as unknown as T;
      }
    }
    if (!res.ok) {
      throw onError ? onError(res.status, body) : mapHttpError({ status: res.status, body, url });
    }
    return { status: res.status, body };
  } catch (error) {
    if (error instanceof AxiError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AxiError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, "TIMEOUT", [
        "Search Console data may be slow; narrow the date range or reduce --limit",
      ]);
    }
    throw new AxiError(
      `Could not reach Google: ${error instanceof Error ? error.message : "network error"}`,
      "NETWORK_ERROR",
      ["Check your network connection and GSC_HOST if overridden"],
    );
  } finally {
    clearTimeout(timer);
  }
}

async function authHeaders(ctx: GscCtx, scopeOverride?: GscCtx["scope"]): Promise<Record<string, string>> {
  const token = await getAccessToken(ctx, scopeOverride);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/** Build a webmasters API path: /webmasters/v3/sites/<encoded>/... */
function sitesPath(siteUrl: string, sub: string): string {
  return `${WEBMASTERS_ROOT}/sites/${encodeSiteUrl(siteUrl)}${sub}`;
}

/** GET a webmasters API path (read-only scope). */
export async function gscGet<T = unknown>(
  ctx: GscCtx,
  path: string,
  params?: Record<string, string | undefined>,
  timeoutMs?: number,
): Promise<T> {
  const headers = await authHeaders(ctx);
  const url = new URL(ctx.host + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const { body } = await fetchJson<T>(url.toString(), { headers }, timeoutMs);
  return body;
}

/** POST a webmasters API path (read-only scope; used by searchanalytics query). */
export async function gscPost<T = unknown>(
  ctx: GscCtx,
  path: string,
  body?: unknown,
  timeoutMs?: number,
): Promise<T> {
  const headers = await authHeaders(ctx);
  const { body: resBody } = await fetchJson<T>(
    ctx.host + path,
    { method: "POST", headers, body: body ? JSON.stringify(body) : undefined },
    timeoutMs,
  );
  return resBody;
}

/** PUT a webmasters API path with the WRITE scope (used only by `sitemaps submit`). */
export async function gscPutWrite<T = unknown>(
  ctx: GscCtx,
  path: string,
  timeoutMs?: number,
): Promise<T> {
  const headers = await authHeaders(ctx, "write");
  const { body } = await fetchJson<T>(
    ctx.host + path,
    { method: "PUT", headers },
    timeoutMs,
  );
  return body;
}

/** Read all of stdin as a string (for `--stdin` flags). */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed API surfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface SiteEntry {
  siteUrl: string;
  permissionLevel?: string;
}

export interface SitesListResponse {
  siteEntry?: SiteEntry[];
}

/** GET /webmasters/v3/sites — list properties the SA can access. */
export async function listSites(ctx: GscCtx): Promise<SiteEntry[]> {
  const res = await gscGet<SitesListResponse>(ctx, `${WEBMASTERS_ROOT}/sites`);
  return res.siteEntry ?? [];
}

export interface SitemapResource {
  path?: string;
  lastSubmitted?: string;
  lastDownloaded?: string;
  isPending?: boolean;
  isSitemapsIndex?: boolean;
  type?: string;
  errors?: number | string;
  warnings?: number | string;
  contents?: { type?: string; submitted?: number | string; indexed?: number | string }[];
}

export interface SitemapsListResponse {
  sitemap?: SitemapResource[];
}

/** GET /sites/<siteUrl>/sitemaps — list submitted sitemaps. */
export async function listSitemaps(ctx: GscCtx, siteUrl: string, sitemapIndex?: string): Promise<SitemapResource[]> {
  const res = await gscGet<SitemapsListResponse>(
    ctx,
    sitesPath(siteUrl, "/sitemaps"),
    sitemapIndex ? { sitemapIndex } : undefined,
  );
  return res.sitemap ?? [];
}

/** GET /sites/<siteUrl>/sitemaps/<feedpath> — a single sitemap's status. */
export async function getSitemap(ctx: GscCtx, siteUrl: string, feedpath: string): Promise<SitemapResource> {
  return gscGet<SitemapResource>(ctx, sitesPath(siteUrl, `/sitemaps/${encodeURIComponent(feedpath)}`));
}

/** PUT /sites/<siteUrl>/sitemaps/<feedpath> — submit a sitemap (write scope). */
export async function submitSitemap(ctx: GscCtx, siteUrl: string, feedpath: string): Promise<void> {
  await gscPutWrite<unknown>(ctx, sitesPath(siteUrl, `/sitemaps/${encodeURIComponent(feedpath)}`));
}

export interface SearchAnalyticsRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: any;
}

/** POST /sites/<siteUrl>/searchAnalytics/query — search traffic data. */
export async function searchAnalytics(
  ctx: GscCtx,
  siteUrl: string,
  body: Record<string, unknown>,
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<SearchAnalyticsResponse> {
  return gscPost<SearchAnalyticsResponse>(ctx, sitesPath(siteUrl, "/searchAnalytics/query"), body, timeoutMs);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UrlInspectionResult = any; // the inspection result is rich and varies

interface InspectRequestResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inspectionResult?: any;
}

/** POST /v1/urlInspection/index:inspect (host: searchconsole.googleapis.com). */
export async function inspectUrl(
  ctx: GscCtx,
  inspectionUrl: string,
  siteUrl: string,
  languageCode?: string,
): Promise<UrlInspectionResult> {
  const headers = await authHeaders(ctx);
  const body: Record<string, unknown> = { inspectionUrl, siteUrl };
  if (languageCode) body.languageCode = languageCode;
  const { body: resBody } = await fetchJson<InspectRequestResponse>(
    `${ctx.inspectionHost}/v1/urlInspection/index:inspect`,
    { method: "POST", headers, body: JSON.stringify(body) },
    DEFAULT_TIMEOUT_MS,
  );
  return resBody.inspectionResult ?? {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Property (site) resolution — match the GSC_SITE/--site hint to a real siteUrl.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the property the CLI should target. Requires `sites list` access;
 * the canonical `siteUrl` form (sc-domain: or URL-prefix) comes from Google.
 *
 * - With a hint: match against accessible properties (sc-domain exact first,
 *   then hostname match, then www.<hint>). 403-style if no match.
 * - Without a hint: use the sole property, or 400 if multiple are accessible.
 */
export async function resolveProperty(ctx: GscCtx): Promise<SiteEntry> {
  const sites = await listSites(ctx);
  if (sites.length === 0) {
    throw new AxiError(
      "The service account has access to no Search Console properties",
      "AUTH_REQUIRED",
      [
        "In Search Console, add the SA's client_email as a user on the property",
        "Verify with: gsc-axi sites",
      ],
    );
  }
  const hint = ctx.siteHint?.trim();
  if (!hint) {
    if (sites.length === 1) return sites[0];
    const sample = sites.slice(0, 8).map((s) => s.siteUrl).join("\n  ");
    throw new AxiError(
      `${sites.length} properties accessible — set GSC_SITE or pass --site <hint>`,
      "VALIDATION_ERROR",
      [
        "Hint forms accepted: bare domain (example.com), full URL (https://example.com/), or sc-domain:example.com",
        `Accessible properties:\n  ${sample}${sites.length > 8 ? `\n  ...(${sites.length - 8} more, run \`gsc-axi sites\` to see all)` : ""}`,
      ],
    );
  }
  const match = matchPropertyHint(hint, sites);
  if (!match) {
    const sample = sites.slice(0, 8).map((s) => s.siteUrl).join("\n  ");
    throw new AxiError(
      `No accessible property matches "${hint}"`,
      "NOT_FOUND",
      [
        "Hint forms accepted: bare domain (example.com), full URL (https://example.com/), or sc-domain:example.com",
        `Accessible properties:\n  ${sample}${sites.length > 8 ? `\n  ...(${sites.length - 8} more, run \`gsc-axi sites\` to see all)` : ""}`,
      ],
    );
  }
  return match;
}

/**
 * Pick the best-matching property for a hint. Score:
 *   4 = sc-domain:<bare-domain> exact
 *   3 = URL-prefix exact (full URL hint) — siteUrl === hint
 *   2 = URL-prefix hostname === hint
 *   1 = URL-prefix hostname === www.<hint>
 */
export function matchPropertyHint(hint: string, sites: SiteEntry[]): SiteEntry | undefined {
  const trimmed = hint.trim().replace(/\/+$/, "");
  const lower = trimmed.toLowerCase();

  // sc-domain: form
  if (lower.startsWith("sc-domain:")) {
    return sites.find((s) => s.siteUrl.toLowerCase() === lower);
  }

  let hintHostname: string | undefined;
  try {
    // If the hint parses as a URL, extract the hostname.
    const u = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    hintHostname = u.hostname.toLowerCase();
  } catch {
    hintHostname = undefined;
  }

  let best: { entry: SiteEntry; score: number } | undefined;
  for (const entry of sites) {
    const site = entry.siteUrl;
    if (site.toLowerCase() === lower) {
      return entry; // exact URL-prefix match — unbeatable
    }
    let score = 0;
    if (lower.startsWith("sc-domain:") === false && hintHostname) {
      // Bare-domain hint: prefer sc-domain:<hint>, then hostname equality, then www.
      if (site.toLowerCase() === `sc-domain:${hintHostname}`) score = 4;
      else {
        try {
          const host = new URL(site).hostname.toLowerCase();
          if (host === hintHostname) score = 3;
          else if (host === `www.${hintHostname}`) score = 1;
        } catch {
          // sc-domain entries: host extraction fails — handled by the sc-domain branch above.
        }
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry;
}
