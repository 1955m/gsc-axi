import { encode } from "@toon-format/toon";
import type { GscCtx } from "../config.js";
import { resolveProperty, listSitemaps, searchAnalytics, type SearchAnalyticsResponse } from "../http.js";
import { requireKey } from "../errors.js";
import { AxiError } from "../errors.js";
import { rejectUnknownFlags, takeFlag, takeBoolFlag } from "../args.js";
import { renderOutput, renderHelp } from "../toon.js";
import { formatPercent, formatPosition, formatDelta } from "../format.js";
import { toIsoDate, latestDataDate, addDays } from "../dates.js";

export const MONITOR_HELP = `usage: gsc-axi monitor [flags]
One-shot health summary for a daily cron: 28d organic clicks / impressions / CTR /
position vs the prior 28d (with % deltas), sitemap error + warning counts, and a
REGRESSION verdict. On regression the command exits non-zero (default) so a
scheduler can alert; pass --no-fail to keep exit 0. --json gives a machine shape.

A regression is flagged when EITHER:
  - organic clicks dropped >20% vs the prior 28d, OR
  - any submitted sitemap has errors > 0 (new/standing sitemap errors).
Tune the click threshold with --threshold <pct> (default 20).

flags:
  --site <hint> (or GSC_SITE)       property hint
  --window <n>                       comparison window in days (default 28)
  --threshold <pct>                  click-drop regression threshold (default 20)
  --no-fail                          keep exit code 0 even on regression
  --json                             machine-readable summary
  --help
examples:
  gsc-axi monitor --site example.com
  gsc-axi monitor --site example.com --window 7 --threshold 15
  gsc-axi monitor --site example.com --json
  # cron: alert on non-zero exit
  gsc-axi monitor --site example.com || alert-command
notes:
  Search Console final data lags ~3 days, so the current window ends 3 days before
  today. Crawl Stats and full Coverage/Video-indexing reports are NOT in the
  public API (UI / BigQuery bulk export only) and are therefore not included.
`;

interface Metrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

function emptyMetrics(): Metrics {
  return { clicks: 0, impressions: 0, ctr: 0, position: 0 };
}

function toMetrics(res: SearchAnalyticsResponse): Metrics {
  const rows = Array.isArray(res.rows) ? res.rows : [];
  if (rows.length === 0) return emptyMetrics();
  // No-dimension query returns a single aggregate row.
  const row = rows[0];
  return {
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  };
}

function toNum(v: number | string | undefined | null): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

export async function monitorCommand(args: string[], ctx: GscCtx): Promise<string> {
  if (args.includes("--help")) return MONITOR_HELP;
  rejectUnknownFlags(args, ["--window", "--threshold"], ["--no-fail", "--json"]);
  requireKey(ctx);

  const windowRaw = takeFlag(args, "--window") ?? "28";
  const window = parseInt(windowRaw, 10);
  if (isNaN(window) || window < 1) {
    throw new AxiError(`invalid --window: ${windowRaw}`, "VALIDATION_ERROR");
  }
  const thresholdRaw = takeFlag(args, "--threshold") ?? "20";
  const threshold = parseInt(thresholdRaw, 10);
  if (isNaN(threshold) || threshold < 0 || threshold > 100) {
    throw new AxiError(`invalid --threshold: ${thresholdRaw} (0..100)`, "VALIDATION_ERROR");
  }
  const noFail = takeBoolFlag(args, "--no-fail");
  const asJson = takeBoolFlag(args, "--json");

  const site = await resolveProperty(ctx);

  // Current window ends at the latest final data date; prior window is the
  // immediately preceding same-length span (no gap, no overlap).
  const end = latestDataDate("final");
  const curStart = addDays(end, -(window - 1));
  const prevEnd = addDays(curStart, -1);
  const prevStart = addDays(prevEnd, -(window - 1));
  const curRange = `${toIsoDate(curStart)}..${toIsoDate(end)}`;
  const prevRange = `${toIsoDate(prevStart)}..${toIsoDate(prevEnd)}`;

  const [curRes, prevRes, sitemaps] = await Promise.all([
    searchAnalytics(ctx, site.siteUrl, {
      startDate: toIsoDate(curStart),
      endDate: toIsoDate(end),
      rowLimit: 1,
      dataState: "final",
    }),
    searchAnalytics(ctx, site.siteUrl, {
      startDate: toIsoDate(prevStart),
      endDate: toIsoDate(prevEnd),
      rowLimit: 1,
      dataState: "final",
    }),
    listSitemaps(ctx, site.siteUrl).catch(() => []),
  ]);

  const cur = toMetrics(curRes);
  const prev = toMetrics(prevRes);

  const sitemapErrors = sitemaps.reduce((s, i) => s + toNum(i.errors), 0);
  const sitemapWarnings = sitemaps.reduce((s, i) => s + toNum(i.warnings), 0);
  const sitemapCount = sitemaps.length;

  const clicksDelta = prev.clicks === 0 ? null : ((cur.clicks - prev.clicks) / prev.clicks) * 100;
  const regression =
    (clicksDelta !== null && clicksDelta < -threshold) || sitemapErrors > 0;
  const reasons: string[] = [];
  if (clicksDelta !== null && clicksDelta < -threshold) {
    reasons.push(`clicks down ${clicksDelta.toFixed(1)}% (threshold -${threshold}%)`);
  }
  if (sitemapErrors > 0) {
    reasons.push(`${sitemapErrors} sitemap error(s) across ${sitemapCount} sitemap(s)`);
  }

  const summary = {
    property: site.siteUrl,
    verdict: regression ? "REGRESSION" : "OK",
    regression,
    window_days: window,
    current: {
      range: curRange,
      clicks: cur.clicks,
      impressions: cur.impressions,
      ctr: formatPercent(cur.ctr),
      position: formatPosition(cur.position),
      clicks_delta: clicksDelta === null ? "n/a (prior 0)" : formatDelta(cur.clicks, prev.clicks),
      impressions_delta: formatDelta(cur.impressions, prev.impressions),
      ctr_delta: formatDelta(cur.ctr, prev.ctr),
      position_delta: formatDelta(cur.position, prev.position),
    },
    prior: {
      range: prevRange,
      clicks: prev.clicks,
      impressions: prev.impressions,
      ctr: formatPercent(prev.ctr),
      position: formatPosition(prev.position),
    },
    sitemaps: {
      count: sitemapCount,
      errors: sitemapErrors,
      warnings: sitemapWarnings,
    },
    reasons: regression ? reasons : [],
  };

  const blocks: string[] = [];
  if (asJson) {
    blocks.push(JSON.stringify(summary, null, 2));
  } else {
    blocks.push(encode({ monitor: summary }));
  }
  if (regression) {
    blocks.push(renderHelp(reasons.length ? reasons.map((r) => `regression: ${r}`) : ["regression detected"]));
  } else {
    blocks.push(renderHelp([
      "Run `gsc-axi query --dimension query --site <hint> --last <window>` to see top queries",
      "Run `gsc-axi sitemaps --site <hint>` to inspect sitemap errors",
    ]));
  }

  // On regression, exit non-zero so a scheduler can alert — unless --no-fail.
  // --json keeps exit 0 so a machine reader doesn't treat findings as a CLI error.
  if (regression && !noFail && !asJson) {
    process.exitCode = 1;
  }

  return renderOutput(blocks);
}
