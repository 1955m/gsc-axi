# gsc-axi

Agent-ergonomic CLI (an [AXI](https://github.com/kunchenguid/axi)) for [Google Search Console](https://search.google.com/search-console). Token-efficient [TOON](https://toonformat.dev/) output for **search analytics** (clicks / impressions / CTR / position), **sitemaps**, **URL inspection**, and a **monitor** health summary for daily cron regression alerts — designed so autonomous agents can read and act on Search Console data through the shell with minimal tokens. Service-account auth.

```
$ gsc-axi monitor --site example.com
monitor:
  property: "sc-domain:example.com"
  verdict: REGRESSION
  regression: true
  window_days: 28
  current:
    range: 2026-06-18..2026-07-15
    clicks: 80
    impressions: 900
    ctr: 8.9%
    position: "14.2"
    clicks_delta: "-60.0%"
    impressions_delta: "-55.0%"
    ...
  prior:
    ...
  sitemaps:
    count: 1
    errors: 3
    warnings: 1
  reasons[2]: clicks down -60.0% (threshold -20%),3 sitemap error(s) across 1 sitemap(s)
help[2]:
  regression: clicks down -60.0% (threshold -20%)
  regression: 3 sitemap error(s) across 1 sitemap(s)
```

On regression the command exits non-zero so a scheduler can alert.

## Why

Reading Search Console usually means clicking around the web UI or hand-writing `curl` against a verbose JSON API. `gsc-axi` wraps the [Search Console API](https://developers.google.com/webmaster-tools/v1/api_reference_index) in an agent-first surface: compact schemas, pre-computed counts, truncated previews with `--full`/`--json` escape hatches, idempotent mutations, structured errors, and a session hook that orients the agent at startup.

## Install

```sh
npm install -g gsc-axi
```

Or run without a global install (the agent skill examples use this form):

```sh
npx -y gsc-axi --help
```

From source:

```sh
git clone https://github.com/1955m/gsc-axi
cd gsc-axi
npm install && npm run build
node dist/bin/gsc-axi.js --help
```

## Configure (Google service account)

`gsc-axi` authenticates as a **Google service account** (no user OAuth dance, no
browser). One-time setup:

1. **Create a service account.** In [Google Cloud Console](https://console.cloud.google.com/):
   *IAM & Admin → Service Accounts → Create service account*. Give it a name (e.g. `gsc-monitor`).
2. **Create and download a JSON key.** On the service account, *Keys → Add key →
   Create new key → JSON*. Save it somewhere private, e.g. `~/gsc-monitor/service-account.json`.
3. **Enable the Search Console API.** *APIs & Services → Library → search
   "Google Search Console API" → Enable*. (If it's already enabled, skip.)
4. **Add the service account as a user on the property.** Open
   [Search Console](https://search.google.com/search-console), open the property,
   *Settings → Users and permissions → Add user*. Paste the service account's
   **client_email** (e.g. `gsc-monitor@your-project.iam.gserviceaccount.com`).
   *Restricted* is enough for all reads (`sites`, `query`, `sitemaps` list/get,
   `inspect`, `monitor`); choose **Full** if you also want `sitemaps submit`
   (which needs the write scope).

Then point `gsc-axi` at the key:

```sh
export GSC_SA_KEY=~/gsc-monitor/service-account.json   # or pass --key <path>
export GSC_SITE=example.com                                  # or pass --site <hint>
```

- **`GSC_SA_KEY`** — path to the service-account JSON key. `--key <path>`
  overrides per-command. Default: `~/gsc-monitor/service-account.json`.
- **`GSC_SITE`** — a property hint. Accepted forms: bare domain (`example.com`),
  full URL (`https://example.com/`), or the canonical `sc-domain:example.com`. The CLI
  lists your properties (`gsc-axi sites`) and matches the hint to the real
  `siteUrl`; it prefers `sc-domain:`, then an exact-hostname URL-prefix, then
  `www.<hint>`.
- **`GSC_HOST`** — override the API base (default `https://www.googleapis.com`).
  **`GSC_INSPECTION_HOST`** — override the URL-Inspection host (default
  `https://searchconsole.googleapis.com`). Rarely needed.

> **Scopes.** Reads use `https://www.googleapis.com/auth/webmasters.readonly`.
> `sitemaps submit` requests `https://www.googleapis.com/auth/webmasters`
> (write) automatically — the SA must be a Full user on the property for it to
> succeed. Never commit the key file (it's gitignored).

## Commands

```
gsc-axi [command] [args] [flags]
commands[6]:
  (none)=dashboard, sites, query, sitemaps, inspect, monitor, setup
```

| Command | Subcommands | Highlights |
| --- | --- | --- |
| `sites` | — | List the account's properties + permission level. |
| `query` | — | Search Analytics: clicks/impressions/CTR/position, sliceable by date/query/page/country/device/searchAppearance/hour, with `--filter` and date-range flags. |
| `sitemaps` | `list`, `view <feedpath>`, `submit <feedpath>` | Sitemap status (submitted/indexed counts, errors, warnings, lastDownloaded, isPending). `submit` needs the write scope. |
| `inspect` | — | URL Inspection API: index verdict, coverage state, canonical, last crawl, mobile/rich-results/AMP verdicts. |
| `monitor` | — | One-shot health summary: 28d organic vs prior 28d (with % deltas), sitemap error counts, REGRESSION verdict. Exits non-zero on regression. |
| `setup` | `hooks` | Install agent SessionStart hooks (Claude Code, Codex, OpenCode). |

Built-in: `update` / `update --check` (self-upgrade). Every subcommand supports
`--help`, and most accept `--json` for the raw API response.

### `query` — the organic-traffic core

```sh
# Top queries over the last 7 days
gsc-axi query --site example.com --last 7 --dimension query --limit 20

# Daily time series for June
gsc-axi query --site sc-domain:example.com --start 2026-06-01 --end 2026-06-30 --dimension date

# Top pages, mobile-only in the US
gsc-axi query --site example.com --dimension page --filter "device==MOBILE" --filter "country==USA" --last 28

# Single aggregate row for the whole property
gsc-axi query --site example.com --last 28
```

- `--last <n>` (default 28): last n days of final data, ending 3 days before
  today (Search Console final data lags ~3 days). Use `--data-state all` to
  include fresh data (ends ~1 day before today).
- `--start <YYYY-MM-DD>` / `--end <YYYY-MM-DD>`: explicit range (both required
  if either is set; `--last` is then ignored). Dates are in Pacific time.
- `--dimension <dim>` (repeatable): `query | page | country | device | date |
  hour | searchAppearance`.
- `--filter "<dim><op><value>"` (repeatable): `==` equals, `!=` notEquals,
  `~=` contains, `!~=` notContains, `^=` regex-includes, `!^=` regex-excludes.
  Example: `--filter "query~=how to"`.
- `--type <web|image|video|news|discover|googleNews>` (default `web`),
  `--aggregation <auto|byProperty|byPage>`, `--data-state <final|all|hourly_all>`,
  `--limit <n>` (1..25000, default 1000), `--offset <n>`.

### `monitor` — the cron headline

```sh
gsc-axi monitor --site example.com                          # TOON, exit 1 on regression
gsc-axi monitor --site example.com --window 7 --threshold 15
gsc-axi monitor --site example.com --json                   # machine shape, exit 0
gsc-axi monitor --site example.com --no-fail                # always exit 0
```

A regression is flagged when **either** organic clicks dropped >20% vs the prior
window **or** any submitted sitemap has `errors > 0`. Tune the click threshold
with `--threshold <pct>` (default 20) and the window with `--window <n>` (default
28). On regression the command exits **1** by default so a scheduler can alert;
`--no-fail` keeps exit 0, and `--json` always keeps exit 0 (consume
`regression: true/false` programmatically).

### `inspect` — URL index status

```sh
gsc-axi inspect https://example.com/about --site example.com
gsc-axi inspect https://example.com/post-1 --site sc-domain:example.com --full
```

Returns the index verdict (pass / fail / excluded), coverage state, indexing
state, robots.txt / page-fetch state, last crawl, Google + user canonicals,
referring-URL count, and mobile-usability / rich-results / AMP verdicts. Only
the version in Google's index is inspected — **live** index testing is not
exposed by the public API (use the Search Console UI for a live test).

## Output format (AXI)

Output is [TOON](https://toonformat.dev/) — token-oriented, schema-aware. Lists
default to 3–5 fields; detail views truncate large fields with a `--full` escape
hatch; counts include totals; empty states are explicit (`count: 0 …`);
mutations are idempotent. Unknown flags are rejected with exit code 2 and the
valid set inlined; auth/scope/rate-limit errors are translated to actionable
messages (never raw API JSON or stack traces).

## Agent integration

Two complementary paths — install whichever fits (or both):

1. **Session hook (recommended).** Ambient dashboard on every session start.
   ```sh
   gsc-axi setup hooks
   ```
   Installs a `SessionStart` hook for Claude Code, Codex, and OpenCode that
   prints a compact Search Console dashboard (active property, 7d organic
   summary, sitemap error count, top queries) plus next-step hints.

2. **Installable skill (secondary).** On-demand discovery in any agent that
   supports the skill format:
   ```sh
   npx skills add 1955m/gsc-axi --skill gsc-axi
   ```

## What's not in the API (documented honestly)

`gsc-axi` only wraps endpoints that actually exist in the public [Search Console
API](https://developers.google.com/webmaster-tools/v1/api_reference_index).
These reports are **not** available via the public API and are therefore not
faked:

- **Crawl Stats** (response codes, fetch types, host) — UI / BigQuery bulk
  export only.
- **Full Coverage / Video indexing / Enhancements reports** — the UI surfaces
  these; the public API only exposes the per-URL inspection
  (`urlInspection.index:inspect`).
- **Live-index test** — `inspect` returns the indexed version only.
- **Indexing API** (`urlNotifications`) — a separate API for job-posting /
  broadcast notifications; not wrapped here.

## Development

```sh
npm run build     # tsc -> dist/
npm test          # vitest (mocks globalThis.fetch + signs a throwaway RSA key; no live GSC key needed)
npm run dev       # tsx bin/gsc-axi.ts ...
```

## License

MIT
