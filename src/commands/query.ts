import { encode } from "@toon-format/toon";
import type { GscCtx } from "../config.js";
import { searchAnalytics, resolveProperty, type SearchAnalyticsResponse, type SearchAnalyticsRow } from "../http.js";
import { requireKey } from "../errors.js";
import { AxiError } from "../errors.js";
import { rejectUnknownFlags, getFlag, takeFlag, takeBoolFlag, getAllFlags } from "../args.js";
import { renderOutput, renderHelp } from "../toon.js";
import { formatCountLine, formatPercent, formatPosition } from "../format.js";
import { isValidIsoDate, shiftIsoDate, latestDataDate, toIsoDate } from "../dates.js";

export const QUERY_HELP = `usage: gsc-axi query [flags]
Run the Search Analytics report: clicks, impressions, CTR, and average position,
sliceable by date / query / page / country / device / searchAppearance / hour.
Outputs one row per dimension combination; with no --dimension, returns a single
aggregate row for the whole property.

flags:
  --site <hint> (or GSC_SITE)       property hint (bare domain / full URL / sc-domain:)
  --last <n>                         last n days of data (default 28). Ends 3 days before today (final data lag)
  --start <YYYY-MM-DD>               explicit start date (PT)
  --end <YYYY-MM-DD>                 explicit end date (PT). If set, --last is ignored
  --dimension <dim>                  repeatable: query|page|country|device|date|hour|searchAppearance
  --type <T>                         web (default)|image|video|news|discover|googleNews
  --filter "<dim><op><value>"        repeatable. ops: == != ~= (contains) !~= (notContains) ^= (regex incl) !^= (regex excl)
  --aggregation <T>                  auto (default)|byProperty|byPage
  --data-state <T>                   final (default)|all (fresh)|hourly_all
  --limit <n>                        row cap (default 1000, max 25000)
  --offset <n>                       zero-based start row (default 0)
  --json                             raw API response
  --help
examples:
  gsc-axi query --site example.com --last 7 --dimension query --limit 20
  gsc-axi query --site sc-domain:example.com --start 2026-06-01 --end 2026-06-30 --dimension page --dimension country
  gsc-axi query --site example.com --dimension device --filter "device==MOBILE" --filter "country==USA"
  gsc-axi query --site example.com --dimension query --filter "query~=how to"
`;

const DIMENSIONS = new Set(["query", "page", "country", "device", "date", "hour", "searchAppearance"]);
const TYPES = new Set(["web", "image", "video", "news", "discover", "googleNews"]);
const AGGREGATIONS = new Set(["auto", "byProperty", "byPage"]);
const DATA_STATES = new Set(["final", "all", "hourly_all"]);

const OPERATORS: { lit: string; op: string }[] = [
  { lit: "!~=", op: "notContains" },
  { lit: "!^=", op: "excludingRegex" },
  { lit: "~=", op: "contains" },
  { lit: "^=", op: "includingRegex" },
  { lit: "!=", op: "notEquals" },
  { lit: "==", op: "equals" },
  { lit: "=", op: "equals" },
];

interface ParsedFilter {
  dimension: string;
  operator: string;
  expression: string;
}

function parseFilter(raw: string): ParsedFilter {
  const lower = raw.toLowerCase();
  // Find the dimension prefix (letters only).
  const match = lower.match(/^([a-z]+)/);
  if (!match) throw new AxiError(`bad --filter (no dimension): ${raw}`, "VALIDATION_ERROR");
  const dimension = match[1];
  if (!DIMENSIONS.has(dimension)) {
    throw new AxiError(`bad --filter dimension "${dimension}": ${raw}`, "VALIDATION_ERROR", [
      `valid dimensions: ${[...DIMENSIONS].join(", ")}`,
    ]);
  }
  for (const cand of OPERATORS) {
    const fullOp = dimension + cand.lit;
    if (raw.toLowerCase().startsWith(fullOp)) {
      return { dimension, operator: cand.op, expression: raw.slice(dimension.length + cand.lit.length) };
    }
  }
  throw new AxiError(`bad --filter (no operator recognized): ${raw}`, "VALIDATION_ERROR", [
    'ops: == (equals), != (notEquals), ~= (contains), !~= (notContains), ^= (regex incl), !^= (regex excl)',
    'example: --filter "country==USA"  or  --filter "query~=how to"',
  ]);
}

export async function queryCommand(args: string[], ctx: GscCtx): Promise<string> {
  if (args.includes("--help")) return QUERY_HELP;
  rejectUnknownFlags(
    args,
    ["--last", "--start", "--end", "--dimension", "--type", "--filter", "--aggregation", "--data-state", "--limit", "--offset"],
    ["--json"],
  );
  requireKey(ctx);

  const dimensions = getAllFlags(args, "--dimension");
  for (const d of dimensions) {
    if (!DIMENSIONS.has(d)) {
      throw new AxiError(`invalid --dimension: ${d}`, "VALIDATION_ERROR", [
        `valid dimensions: ${[...DIMENSIONS].join(", ")}`,
      ]);
    }
  }
  // dedupe while preserving order; the API forbids grouping by the same dimension twice.
  const dimList = [...new Set(dimensions)];

  const filterRaws = getAllFlags(args, "--filter");
  const filters = filterRaws.map(parseFilter);

  const type = getFlag(args, "--type") ?? "web";
  if (!TYPES.has(type)) {
    throw new AxiError(`invalid --type: ${type}`, "VALIDATION_ERROR", [
      `valid types: ${[...TYPES].join(", ")}`,
    ]);
  }
  const aggregation = getFlag(args, "--aggregation") ?? "auto";
  if (!AGGREGATIONS.has(aggregation)) {
    throw new AxiError(`invalid --aggregation: ${aggregation}`, "VALIDATION_ERROR", [
      `valid: ${[...AGGREGATIONS].join(", ")}`,
    ]);
  }
  const dataState = (getFlag(args, "--data-state") ?? "final") as "final" | "all" | "hourly_all";
  if (!DATA_STATES.has(dataState)) {
    throw new AxiError(`invalid --data-state: ${dataState}`, "VALIDATION_ERROR", [
      `valid: ${[...DATA_STATES].join(", ")}`,
    ]);
  }

  // Date range: explicit --start/--end wins; else --last N (default 28) ending at latestDataDate.
  const explicitStart = takeFlag(args, "--start");
  const explicitEnd = takeFlag(args, "--end");
  const lastRaw = takeFlag(args, "--last") ?? "28";
  const lastN = parseInt(lastRaw, 10);
  if (isNaN(lastN) || lastN < 1) {
    throw new AxiError(`invalid --last: ${lastRaw}`, "VALIDATION_ERROR");
  }
  let startDate: string;
  let endDate: string;
  if (explicitStart && explicitEnd) {
    if (!isValidIsoDate(explicitStart) || !isValidIsoDate(explicitEnd)) {
      throw new AxiError("--start/--end must be YYYY-MM-DD", "VALIDATION_ERROR");
    }
    if (explicitStart > explicitEnd) {
      throw new AxiError(`--start (${explicitStart}) is after --end (${explicitEnd})`, "VALIDATION_ERROR");
    }
    startDate = explicitStart;
    endDate = explicitEnd;
  } else if (explicitStart || explicitEnd) {
    throw new AxiError("set both --start and --end (or use --last)", "VALIDATION_ERROR");
  } else {
    const end = latestDataDate(dataState);
    startDate = toIsoDate(new Date(end.getTime() - (lastN - 1) * 86400_000));
    endDate = toIsoDate(end);
  }

  const limit = parseInt(getFlag(args, "--limit") ?? "1000", 10);
  if (isNaN(limit) || limit < 1 || limit > 25000) {
    throw new AxiError(`invalid --limit: ${getFlag(args, "--limit") ?? ""} (1..25000)`, "VALIDATION_ERROR");
  }
  const offset = parseInt(getFlag(args, "--offset") ?? "0", 10);
  if (isNaN(offset) || offset < 0) {
    throw new AxiError(`invalid --offset: ${getFlag(args, "--offset") ?? ""}`, "VALIDATION_ERROR");
  }
  const asJson = takeBoolFlag(args, "--json");

  const site = await resolveProperty(ctx);

  const body: Record<string, unknown> = {
    startDate,
    endDate,
    type,
    aggregationType: aggregation,
    rowLimit: limit,
    startRow: offset,
    dataState,
  };
  if (dimList.length > 0) body.dimensions = dimList;
  if (filters.length > 0) {
    body.dimensionFilterGroups = [{ groupType: "and", filters }];
  }

  const res = await searchAnalytics(ctx, site.siteUrl, body);
  if (asJson) return JSON.stringify(res, null, 2);

  return renderSearchAnalytics(res, { startDate, endDate, dimensions: dimList, limit, offset });
}

function renderSearchAnalytics(
  res: SearchAnalyticsResponse,
  opts: { startDate: string; endDate: string; dimensions: string[]; limit: number; offset: number },
): string {
  const rows = Array.isArray(res.rows) ? res.rows : [];
  const shown = rows;
  const columns = [...opts.dimensions, "clicks", "impressions", "ctr", "position"];

  const header: Record<string, unknown> = {
    range: `${opts.startDate}..${opts.endDate}`,
    rows: rows.length,
  };
  if (res.responseAggregationType) header.aggregation = res.responseAggregationType;
  if (rows.length === opts.limit) {
    header.note = `showing first ${opts.limit}; pass --offset ${opts.offset + opts.limit} for more`;
  }
  const blocks: string[] = [encode({ count: header })];
  if (columns.length > 0) blocks.push(encode({ columns }));

  const objectRows = shown.map((row) => rowToObject(row, opts.dimensions));
  blocks.push(encode({ rows: objectRows }));

  const hints: string[] = [];
  if (rows.length === opts.limit) {
    hints.push(`Re-run with \`--offset ${opts.offset + opts.limit}\` to see more rows (up to 25000 per call)`);
  }
  hints.push("Add --dimension date for a daily time series");
  hints.push("Add --filter \"query~=<text>\" to narrow to matching queries");
  if (hints.length) blocks.push(renderHelp(hints));
  return renderOutput(blocks);
}

function rowToObject(row: SearchAnalyticsRow, dimensions: string[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  const keys = Array.isArray(row.keys) ? row.keys : [];
  dimensions.forEach((dim, i) => {
    obj[dim] = keys[i] ?? null;
  });
  obj.clicks = row.clicks ?? 0;
  obj.impressions = row.impressions ?? 0;
  obj.ctr = formatPercent(row.ctr);
  obj.position = formatPosition(row.position);
  return obj;
}
