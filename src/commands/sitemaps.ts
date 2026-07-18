import { encode } from "@toon-format/toon";
import type { GscCtx } from "../config.js";
import { listSitemaps, getSitemap, submitSitemap, resolveProperty, type SitemapResource } from "../http.js";
import { requireKey } from "../errors.js";
import { AxiError } from "../errors.js";
import { rejectUnknownFlags, getPositional, takeFlag, takeBoolFlag } from "../args.js";
import { field, custom, relativeTime, renderList, renderDetail, renderHelp, renderOutput } from "../toon.js";
import { formatCountLine, truncateJson } from "../format.js";

export const SITEMAPS_HELP = `usage: gsc-axi sitemaps <subcommand> [flags]
subcommands[3]:
  (none)=list, view <feedpath>, submit <feedpath>
flags{list}:
  --site <hint> (or GSC_SITE), --json, --help
flags{view}:
  --site <hint>, --full, --json, --help
flags{submit}:
  --site <hint>, --json, --help
  Note: submit requires the webmasters (write) scope; the SA must be a Full user on the property.
examples:
  gsc-axi sitemaps --site example.com
  gsc-axi sitemaps view https://example.com/sitemap.xml --site example.com
  gsc-axi sitemaps submit https://example.com/sitemap.xml --site example.com
`;

export async function sitemapsCommand(args: string[], ctx: GscCtx): Promise<string> {
  if (args.includes("--help")) return SITEMAPS_HELP;
  const sub = getPositional(args);
  if (sub && !sub.startsWith("--")) args.splice(args.indexOf(sub), 1);
  switch (sub) {
    case "submit":
      return submitSitemapCmd(args, ctx);
    case "view":
      return viewSitemap(args, ctx);
    case "list":
    case undefined:
      return listSitemapsCmd(args, ctx);
    default:
      throw new AxiError(`unknown sitemaps subcommand: ${sub}`, "VALIDATION_ERROR", [
        "valid subcommands: list, view <feedpath>, submit <feedpath>",
      ]);
  }
}

async function listSitemapsCmd(args: string[], ctx: GscCtx): Promise<string> {
  rejectUnknownFlags(args, [], ["--json"]);
  const asJson = takeBoolFlag(args, "--json");
  requireKey(ctx);
  const site = await resolveProperty(ctx);
  const items = await listSitemaps(ctx, site.siteUrl);
  if (asJson) return JSON.stringify({ sitemap: items }, null, 2);

  const blocks: string[] = [formatCountLine({ count: items.length, totalCount: items.length })];
  if (items.length === 0) {
    blocks.push(`sitemaps: 0 submitted for ${site.siteUrl}`);
  } else {
    const totalErrors = items.reduce((s, i) => s + toNum(i.errors), 0);
    const totalWarnings = items.reduce((s, i) => s + toNum(i.warnings), 0);
    blocks.push(encode({ sitemap_errors: totalErrors, sitemap_warnings: totalWarnings }));
    blocks.push(
      renderList("sitemaps", items, [
        field("path"),
        custom("type", (i) => i.type ?? "unknown"),
        custom("submitted_urls", (i) => sumContents(i, "submitted")),
        custom("indexed_urls", (i) => sumContents(i, "indexed")),
        custom("errors", (i) => toNum(i.errors)),
        custom("warnings", (i) => toNum(i.warnings)),
        custom("pending", (i) => (i.isPending ? "yes" : "no")),
        relativeTime("lastDownloaded", "last_downloaded"),
      ]),
    );
  }
  blocks.push(
    renderHelp([
      "Run `gsc-axi sitemaps view <feedpath> --site <hint>` for one sitemap's full status",
      "Run `gsc-axi sitemaps submit <feedpath> --site <hint>` to (re)submit a sitemap",
    ]),
  );
  return renderOutput(blocks);
}

async function viewSitemap(args: string[], ctx: GscCtx): Promise<string> {
  rejectUnknownFlags(args, [], ["--full", "--json"]);
  const full = takeBoolFlag(args, "--full");
  const asJson = takeBoolFlag(args, "--json");
  requireKey(ctx);
  const feedpath = getPositional(args);
  if (!feedpath) {
    throw new AxiError("sitemaps view requires a <feedpath> (the sitemap URL)", "VALIDATION_ERROR", [
      "Example: gsc-axi sitemaps view https://example.com/sitemap.xml --site example.com",
    ]);
  }
  const site = await resolveProperty(ctx);
  const sm = await getSitemap(ctx, site.siteUrl, feedpath);
  if (asJson) return JSON.stringify(sm, null, 2);
  return renderOutput([
    renderDetail("sitemap", sm, [
      field("path"),
      custom("type", (i) => i.type ?? "unknown"),
      custom("submitted_urls", (i) => sumContents(i, "submitted")),
      custom("indexed_urls", (i) => sumContents(i, "indexed")),
      custom("errors", (i) => toNum(i.errors)),
      custom("warnings", (i) => toNum(i.warnings)),
      custom("pending", (i) => (i.isPending ? "yes" : "no")),
      custom("is_index", (i) => (i.isSitemapsIndex ? "yes" : "no")),
      relativeTime("lastSubmitted", "last_submitted"),
      relativeTime("lastDownloaded", "last_downloaded"),
      custom("contents", (i) => (full ? truncateJson(i.contents, 100000) : truncateJson(i.contents, 600))),
    ]),
    full ? "" : renderHelp(["Run `gsc-axi sitemaps view <feedpath> --full` for the full contents array"]),
  ]);
}

async function submitSitemapCmd(args: string[], ctx: GscCtx): Promise<string> {
  rejectUnknownFlags(args, [], ["--json"]);
  const asJson = takeBoolFlag(args, "--json");
  requireKey(ctx);
  const feedpath = getPositional(args);
  if (!feedpath) {
    throw new AxiError("sitemaps submit requires a <feedpath> (the sitemap URL)", "VALIDATION_ERROR", [
      "Example: gsc-axi sitemaps submit https://example.com/sitemap.xml --site example.com",
      "submit needs the webmasters (write) scope; the SA must be a Full user on the property",
    ]);
  }
  const site = await resolveProperty(ctx);
  await submitSitemap(ctx, site.siteUrl, feedpath);
  if (asJson) return JSON.stringify({ submitted: feedpath, site: site.siteUrl }, null, 2);
  return renderOutput([
    encode({ sitemap: feedpath, site: site.siteUrl, status: "submitted" }),
    renderHelp([
      "Submission is asynchronous; run `gsc-axi sitemaps --site <hint>` later to see processing",
      "Run `gsc-axi sitemaps view <feedpath> --site <hint>` for this sitemap's status",
    ]),
  ]);
}

function toNum(v: number | string | undefined | null): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

function sumContents(i: SitemapResource, key: "submitted" | "indexed"): number {
  if (!Array.isArray(i.contents)) return 0;
  return i.contents.reduce((s, c) => s + toNum(c?.[key]), 0);
}
