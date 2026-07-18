---
name: gsc-axi
description: Use when a task involves Google Search Console — running search-analytics reports (clicks/impressions/CTR/position by query/page/country/device), inspecting sitemap status or submitting a sitemap, URL-inspecting a page's index status, or running a daily health/regression check for a property. Prefer this over the Search Console UI or raw curl for agent-driven work.
---

# gsc-axi — an AXI for Google Search Console

`gsc-axi` is an agent-ergonomic CLI for Google Search Console. It wraps the
[Search Console API](https://developers.google.com/webmaster-tools/v1/api_reference_index)
in token-efficient [TOON](https://toonformat.dev/) output so agents can read
and act on Search Console data through the shell. Service-account auth.

These examples use `npx -y gsc-axi` so they work without a global install. If
`gsc-axi` is already on PATH, drop the `npx -y ` prefix.

## Configure (once)

```sh
export GSC_SA_KEY=~/gsc-monitor/service-account.json   # path to the SA JSON key
export GSC_SITE=example.com                                  # property hint (bare domain / URL / sc-domain:)
```

- `GSC_SA_KEY`: a Google service-account JSON key. Create the SA in Google
  Cloud Console, enable the **Search Console API**, download a JSON key, and
  add the SA's **client_email** as a user on the property in Search Console
  (Restricted for reads; Full if you want `sitemaps submit`).
- `GSC_SITE`: a property hint. Accepted: bare domain (`example.com`), full URL
  (`https://example.com/`), or canonical `sc-domain:example.com`. The CLI lists
  properties and matches the hint; `--site` overrides per command.

## What it can do

Run `npx -y gsc-axi --help` for the full surface. Headline capabilities:

- **Query (Search Analytics)** — the organic-traffic core:
  ```sh
  npx -y gsc-axi query --site example.com --last 7 --dimension query --limit 20
  npx -y gsc-axi query --site example.com --dimension date --start 2026-06-01 --end 2026-06-30
  npx -y gsc-axi query --site example.com --dimension page --filter "country==USA" --filter "device==MOBILE" --last 28
  ```
  Dimensions: `query | page | country | device | date | hour | searchAppearance`.
  Filters use `==` `!=` `~=` (contains) `!~=` (notContains) `^=`/`!^=` (regex).
- **Sitemaps** — list, view, or submit:
  ```sh
  npx -y gsc-axi sitemaps --site example.com
  npx -y gsc-axi sitemaps view https://example.com/sitemap.xml --site example.com
  npx -y gsc-axi sitemaps submit https://example.com/sitemap.xml --site example.com   # write scope; Full user
  ```
- **URL Inspection** — index verdict, coverage, canonicals, last crawl,
  mobile/rich-results/AMP:
  ```sh
  npx -y gsc-axi inspect https://example.com/about --site example.com
  ```
- **Monitor** — daily cron health summary (28d vs prior 28d, % deltas, sitemap
  error counts, REGRESSION verdict; exits non-zero on regression):
  ```sh
  npx -y gsc-axi monitor --site example.com
  npx -y gsc-axi monitor --site example.com --json        # machine shape, exit 0
  npx -y gsc-axi monitor --site example.com --window 7 --threshold 15
  ```
- **Sites** — list accessible properties:
  ```sh
  npx -y gsc-axi sites
  ```

## Output conventions (AXI)

- TOON on stdout — compact, schema-aware. Lists show 3–5 fields; `--full`/`--json`
  escape hatches exist where useful.
- Counts include totals; empty states are explicit (`count: 0 …`).
- Unknown flags exit 2 with the valid set inlined; auth/scope/rate-limit errors
  are translated to actionable messages (never raw API JSON or stack traces).
- `monitor` exits 1 on regression (clicks down >20% vs prior 28d OR any sitemap
  has errors) so a scheduler can alert; `--no-fail` keeps exit 0.

## Orientation

- No args → a compact dashboard (active property, 7d organic summary, sitemap
  error count, top 5 queries).
- `npx -y gsc-axi sites` lists accessible properties.
- `npx -y gsc-axi setup hooks` installs a SessionStart hook (Claude Code, Codex,
  OpenCode) so future sessions start with that dashboard already in context.

## Notes

- Search Console final data lags ~3 days (Pacific time); the default `--last`
  window and `monitor`'s current window end 3 days before today. Pass
  `--data-state all` for fresher (still partial) data.
- **Crawl Stats**, **full Coverage / Video indexing**, and **live-index
  testing** are NOT in the public Search Console API — `gsc-axi` does not fake
  them. Use the Search Console UI or the BigQuery bulk export for those.
- `inspect` returns the version in Google's index only, not a live test.
