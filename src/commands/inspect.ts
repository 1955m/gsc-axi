import { encode } from "@toon-format/toon";
import type { GscCtx } from "../config.js";
import { inspectUrl, resolveProperty, type UrlInspectionResult } from "../http.js";
import { requireKey } from "../errors.js";
import { AxiError } from "../errors.js";
import { rejectUnknownFlags, getPositional, takeFlag, takeBoolFlag } from "../args.js";
import { field, custom, relativeTime, renderDetail, renderHelp, renderOutput } from "../toon.js";
import { truncateJson } from "../format.js";

export const INSPECT_HELP = `usage: gsc-axi inspect <url> [flags]
Run the URL Inspection API for a single URL: index status, coverage state,
canonical URLs, last crawl, robots.txt/fetch state, and mobile/rich-results/AMP
verdicts. Only the version in Google's index is inspected — not a live test.

flags:
  --site <hint> (or GSC_SITE)       property the URL belongs to (required unless GSC_SITE set)
  --full                            include the full rich-results detected items (truncated by default)
  --language <code>                 IETF BCP-47 code for translated issue messages (default en-US)
  --json                             raw API response
  --help
examples:
  gsc-axi inspect https://example.com/about --site example.com
  gsc-axi inspect https://example.com/post-1 --site sc-domain:example.com --full
  gsc-axi inspect https://example.com/ --site example.com --language de-CH
`;

const VERDICT_MAP: Record<string, string> = {
  VERDICT_UNSPECIFIED: "unknown",
  PASS: "pass",
  PARTIAL: "partial",
  FAIL: "fail",
  NEUTRAL: "excluded",
};

export async function inspectCommand(args: string[], ctx: GscCtx): Promise<string> {
  if (args.includes("--help")) return INSPECT_HELP;
  rejectUnknownFlags(args, ["--language"], ["--full", "--json"]);
  requireKey(ctx);

  const url = getPositional(args);
  if (!url) {
    throw new AxiError("inspect requires a <url> to inspect", "VALIDATION_ERROR", [
      "Example: gsc-axi inspect https://example.com/about --site example.com",
    ]);
  }
  const language = takeFlag(args, "--language");
  const full = takeBoolFlag(args, "--full");
  const asJson = takeBoolFlag(args, "--json");

  const site = await resolveProperty(ctx);
  const result = await inspectUrl(ctx, url, site.siteUrl, language);
  if (asJson) return JSON.stringify({ inspectionResult: result }, null, 2);

  const index = result?.indexStatusResult ?? {};
  const rich = result?.richResultsResult;
  const mobile = result?.mobileUsabilityResult;
  const amp = result?.ampResult;

  const blocks: string[] = [
    encode({ url, property: site.siteUrl, link: result?.inspectionResultLink ?? null }),
  ];

  blocks.push(
    renderDetail("index_status", index, [
      custom("verdict", (i) => VERDICT_MAP[i.verdict] ?? i.verdict ?? "unknown"),
      field("coverageState", "coverage_state"),
      custom("indexing_state", (i) => mapEnum(i.indexingState, {
        INDEXING_STATE_UNSPECIFIED: "unknown",
        INDEXING_ALLOWED: "allowed",
        BLOCKED_BY_META_TAG: "blocked(noindex meta)",
        BLOCKED_BY_HTTP_HEADER: "blocked(noindex header)",
        BLOCKED_BY_ROBOTS_TXT: "blocked(robots.txt)",
      })),
      custom("robots_txt", (i) => mapEnum(i.robotsTxtState, {
        ROBOTS_TXT_STATE_UNSPECIFIED: "unknown",
        ALLOWED: "allowed",
        DISALLOWED: "blocked",
      })),
      custom("page_fetch", (i) => snakeCase(i.pageFetchState)),
      relativeTime("lastCrawlTime", "last_crawl"),
      custom("crawled_as", (i) => snakeCase(i.crawledAs)),
      field("googleCanonical", "google_canonical"),
      field("userCanonical", "user_canonical"),
      custom("sitemaps", (i) => (Array.isArray(i.sitemap) && i.sitemap.length ? i.sitemap.join(",") : "none")),
      custom("referring_urls", (i) => (Array.isArray(i.referringUrls) ? i.referringUrls.length : 0)),
    ]),
  );

  if (rich) {
    const detected = Array.isArray(rich.detectedItems) ? rich.detectedItems.length : 0;
    blocks.push(
      renderDetail("rich_results", rich, [
        custom("verdict", (i) => VERDICT_MAP[i.verdict] ?? i.verdict ?? "unknown"),
        custom("detected_types", () => detected),
        custom("items", (i) => (full ? truncateJson(i.detectedItems, 100000) : truncateJson(i.detectedItems, 600))),
      ]),
    );
  }
  if (mobile) {
    const issues = Array.isArray(mobile.issues) ? mobile.issues.length : 0;
    blocks.push(
      renderDetail("mobile_usability", mobile, [
        custom("verdict", (i) => VERDICT_MAP[i.verdict] ?? i.verdict ?? "unknown"),
        custom("issues", () => issues),
      ]),
    );
  }
  if (amp) {
    blocks.push(
      renderDetail("amp", amp, [
        custom("verdict", (i) => VERDICT_MAP[i.verdict] ?? i.verdict ?? "unknown"),
        custom("amp_index_verdict", (i) => VERDICT_MAP[i.ampIndexStatusVerdict] ?? i.ampIndexStatusVerdict ?? "unknown"),
        relativeTime("lastCrawlTime", "last_crawl"),
      ]),
    );
  }

  blocks.push(
    renderHelp([
      "Run `gsc-axi inspect <url> --full` for the complete rich-results breakdown",
      "Run `gsc-axi query --dimension page --site <hint>` for this URL's traffic",
      "Live-index testing is not exposed by the public API; use the Search Console UI for a live test",
    ]),
  );
  return renderOutput(blocks);
}

function mapEnum(value: unknown, map: Record<string, string>): string {
  if (typeof value === "string" && value in map) return map[value];
  if (value == null) return "unknown";
  return String(value);
}

function snakeCase(value: unknown): string {
  if (value == null) return "unknown";
  if (typeof value === "string") return value.toLowerCase();
  return String(value);
}
