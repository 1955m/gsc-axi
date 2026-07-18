# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Build & test

- `npm run build` (tsc) → `dist/`. `npm run dev` (tsx) for live runs. `npm test` (vitest) mocks `globalThis.fetch` and signs a throwaway RSA keypair in `beforeAll` — **no live Google key or network needed**.
- TypeScript is `NodeNext` ESM: relative imports must use the `.js` suffix even for `.ts` sources.
- `dist/` and `node_modules/` are gitignored; the service-account key is gitignored under several patterns (`service-account.json`, `*-service-account.json`, `*.pem`, `gsc-monitor/`). The published `bin` is `dist/bin/gsc-axi.js` (built by `prepublishOnly`).

## Architecture

- Node/TypeScript ESM, built on `axi-sdk-js` (the `runAxiCli` runner, `AxiError`, `exitCodeForError`, `installSessionStartHooks`, self-`update`) and `@toon-format/toon` (output encoding). Local `src/toon.ts` provides the field/render helpers (the SDK does not export them).
- `src/cli.ts` wires commands through `withCtx`, which strips the global context flags (`--key`, `--site`) from args before the handler sees them, so positional extraction and unknown-flag validation stay correct when those flags precede positionals. `--json` is NOT stripped globally — each command reads it with `takeBoolFlag`.
- Seams: `src/config.ts` (`resolveConfig`/`encodeSiteUrl`/`scopeUrl`), `src/http.ts` (SA-JWT auth + `gscGet`/`gscPost`/`gscPutWrite` + typed API surfaces + `resolveProperty`), `src/dates.ts` (Pacific-time date math), `src/errors.ts` (`requireKey` + `mapHttpError`).

## Auth model (service account, no SDK)

- No `googleapis` dependency. `src/http.ts` signs an RS256 JWT with `node:crypto` (`createSign("RSA-SHA256")`), exchanges it at `https://oauth2.googleapis.com/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`), and caches the access token in-process keyed by `${keyPath}:${scopeUrl}`. Refresh 60s before expiry.
- Read scope: `https://www.googleapis.com/auth/webmasters.readonly`. Write scope (sitemap submit only): `https://www.googleapis.com/auth/webmasters` — `gscPutWrite` passes `scopeOverride: "write"`; `ctx.scope` is otherwise readonly.
- Key path resolution: `--key <path>` → `GSC_SA_KEY` → `~/gsc-monitor/service-account.json`. `requireKey(ctx)` throws AUTH_REQUIRED with the exact Google setup steps when the file is missing.

## Property resolution

- `resolveProperty(ctx)` calls `sites list` then matches the `GSC_SITE`/`--site` hint via `matchPropertyHint` (`src/http.ts`). Score: `sc-domain:<bare-domain>` exact (4) > URL-prefix exact (return immediately) > URL-prefix hostname === hint (3) > hostname === `www.<hint>` (1). Without a hint: use the sole property, else VALIDATION_ERROR listing accessible siteUrls. A hint that matches nothing → NOT_FOUND with the list.
- The canonical `siteUrl` (e.g. `sc-domain:example.com` or `https://example.com/`) is what every per-property endpoint uses, URL-encoded with `encodeURIComponent` via `encodeSiteUrl`.

## API surface (grounded in developers.google.com/webmaster-tools/v1/)

- `GET /webmasters/v3/sites` → `{ siteEntry: [{ siteUrl, permissionLevel }] }`.
- `POST /sites/<siteUrl>/searchAnalytics/query` body `{ startDate, endDate, dimensions, type, dimensionFilterGroups: [{ groupType: "and", filters: [{ dimension, operator, expression }] }], aggregationType, rowLimit (1..25000), startRow, dataState }` → `{ rows: [{ keys, clicks, impressions, ctr, position }], responseAggregationType, metadata }`. Sorted by clicks desc (or by date asc when grouped by date).
- `GET /sites/<siteUrl>/sitemaps?sitemapIndex=` → `{ sitemap: [{ path, lastSubmitted, lastDownloaded, isPending, isSitemapsIndex, type, errors, warnings, contents: [{ type, submitted, indexed(deprecated) }] }] }`.
- `GET /sites/<siteUrl>/sitemaps/<feedpath>` → a single sitemap resource. `PUT /sites/<siteUrl>/sitemaps/<feedpath>` (empty body, write scope) → empty 200.
- `POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect` body `{ inspectionUrl, siteUrl, languageCode }` → `{ inspectionResult: { inspectionResultLink, indexStatusResult, ampResult, mobileUsabilityResult (deprecated), richResultsResult } }`. **Note the different host** (`searchconsole.googleapis.com`, not `www.googleapis.com`); `inspectUrl` uses `ctx.inspectionHost`.

## Monitor regression policy

- Current window = `[latestDataDate("final") - (window-1), latestDataDate("final")]`; prior window = the immediately preceding same-length span (no gap, no overlap). `latestDataDate` = PT-today − 3 for final data, − 1 for `all`/`hourly_all`.
- Regression when EITHER clicks drop > `--threshold`% (default 20) vs prior OR any sitemap has `errors > 0`. On regression (non-`--json`, non-`--no-fail`): sets `process.exitCode = 1` after writing the TOON summary. `--json` keeps exit 0 so a machine reader doesn't treat findings as a CLI error.
- No history is persisted: "new sitemap errors" is approximated as "any standing sitemap error" since the API gives no prior state.

## Sharp edges

- **Crawl Stats / Coverage / Video indexing / live-index test are NOT in the public API** — documented honestly in README and `monitor --help`. Don't fake them.
- Search Console final data lags ~3 days (PT). The default `--last` window and `monitor`'s current window end at PT-today − 3 to avoid empty recent days; pass `--data-state all` for fresher (still partial) data.
- Dates are in `America/Los_Angeles`. `src/dates.ts` computes "today" via `Intl.DateTimeFormat` with `timeZone: "America/Los_Angeles"` and treats the resulting calendar date as UTC-midnight for safe day arithmetic.
- Google's error envelope is `{ error: { code, message, status, errors: [{ reason, message }] } }`. `mapHttpError` extracts `.error.message`; 403 maps to FORBIDDEN ("SA not a user on the property"), 401 to AUTH_REQUIRED, 429 to RATE_LIMITED (200/min, 1,800/day per property).
- `@types/node` `generateKeyPairSync("rsa", …)` requires BOTH `publicKeyEncoding` and `privateKeyEncoding` or no overload matches (the test generates a throwaway keypair in `beforeAll`).
- `axi-sdk-js` public surface: `runAxiCli`, `AxiError`, `exitCodeForError`, `installSessionStartHooks`, `runUpdate`. It does NOT export the output helpers — use the local `src/toon.ts`. The SDK auto-appends the `update` built-in block to top-level `--help`, so don't duplicate it in `TOP_HELP`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
