import { encode } from "@toon-format/toon";
import { homedir } from "node:os";
import type { GscCtx } from "../config.js";
import { resolveProperty, listSitemaps, searchAnalytics } from "../http.js";
import { field, custom, renderList, renderHelp, renderOutput } from "../toon.js";
import { formatPercent, formatPosition } from "../format.js";
import { toIsoDate, latestDataDate, addDays } from "../dates.js";

function collapseHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export async function homeCommand(_args: string[], ctx: GscCtx): Promise<string> {
  const blocks: string[] = [];

  blocks.push(
    encode({
      config: {
        key: collapseHome(ctx.keyPath),
        key_status: ctx.keyExists ? "found" : "missing",
        site: ctx.siteHint
          ? `${ctx.siteHint} (from ${ctx.siteSource})`
          : "unset — set GSC_SITE or pass --site",
        scope: ctx.scope,
      },
    }),
  );

  if (!ctx.keyExists) {
    blocks.push(
      renderHelp([
        "Create a Google service account and download a JSON key, then:",
        `  export GSC_SA_KEY=/path/to/service-account.json   (or pass --key <path>)`,
        `  Default location: ~/gsc-monitor/service-account.json`,
        "Add the SA client_email as a user on the property in Search Console",
        "Run `gsc-axi setup hooks` to install session ambient context",
      ]),
    );
    return renderOutput(blocks);
  }

  // Best-effort live dashboard — never hard-fail the home view on an API error.
  const property = await resolveProperty(ctx).catch(() => null);
  if (!property) {
    blocks.push("live: unavailable (could not resolve property; run `gsc-axi sites` to check access)");
    blocks.push(
      renderHelp([
        "Run `gsc-axi sites` to list accessible properties",
        "Run `gsc-axi query --site <hint> --last 7 --dimension query` once access is wired",
      ]),
    );
    return renderOutput(blocks);
  }

  const end = latestDataDate("final");
  const start = addDays(end, -6); // last 7 days
  const [summary, topQueries, sitemaps] = await Promise.all([
    searchAnalytics(ctx, property.siteUrl, {
      startDate: toIsoDate(start),
      endDate: toIsoDate(end),
      rowLimit: 1,
      dataState: "final",
    }).catch(() => null),
    searchAnalytics(ctx, property.siteUrl, {
      startDate: toIsoDate(start),
      endDate: toIsoDate(end),
      dimensions: ["query"],
      rowLimit: 5,
      dataState: "final",
    }).catch(() => null),
    listSitemaps(ctx, property.siteUrl).catch(() => null),
  ]);

  const organic = summary?.rows?.[0] ?? null;
  blocks.push(
    encode({
      property: property.siteUrl,
      range: `${toIsoDate(start)}..${toIsoDate(end)}`,
      organic: organic
        ? {
            clicks: organic.clicks ?? 0,
            impressions: organic.impressions ?? 0,
            ctr: formatPercent(organic.ctr),
            position: formatPosition(organic.position),
          }
        : { clicks: 0, impressions: 0, ctr: "0.0%", position: "unknown" },
      sitemaps: {
        count: sitemaps?.length ?? 0,
        errors: sitemaps?.reduce((s, i) => s + toNum(i.errors), 0) ?? 0,
        warnings: sitemaps?.reduce((s, i) => s + toNum(i.warnings), 0) ?? 0,
      },
    }),
  );

  const qRows = (topQueries?.rows ?? []).slice(0, 5);
  blocks.push(
    qRows.length
      ? renderList("top_queries", qRows, [
          custom("query", (r) => (Array.isArray(r.keys) ? r.keys[0] : null)),
          field("clicks"),
          field("impressions"),
          custom("ctr", (r) => formatPercent(r.ctr)),
          custom("position", (r) => formatPosition(r.position)),
        ])
      : "top_queries: 0 (no query data in the last 7 days)",
  );

  blocks.push(
    renderHelp([
      "Run `gsc-axi monitor --site <hint>` for the 28d health summary (cron-friendly)",
      "Run `gsc-axi query --dimension page --site <hint> --last 7` for top pages",
      "Run `gsc-axi inspect <url> --site <hint>` for a URL's index status",
      "Run `gsc-axi sitemaps --site <hint>` for sitemap health",
    ]),
  );

  return renderOutput(blocks);
}

function toNum(v: number | string | undefined | null): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}
