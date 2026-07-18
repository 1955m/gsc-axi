/** Standard count phrasing so totals are never ambiguous (AXI §4, §5). */
export function formatCountLine(opts: {
  count: number;
  limit?: number;
  totalCount?: number | null;
}): string {
  const { count, limit, totalCount } = opts;
  if (totalCount !== undefined && totalCount !== null) {
    return `count: ${count} of ${totalCount} total`;
  }
  if (limit !== undefined && count === limit && count > 0) {
    return `count: ${count} (showing first ${count}; pass --limit N for more)`;
  }
  return `count: ${count}`;
}

/** Truncate a long text field, preserving a preview and reporting total size (AXI §3). */
export function truncateString(value: unknown, limit = 500): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}... (truncated, ${s.length} chars total)`;
}

/** Compact JSON for inline property previews (used in detail views). */
export function truncateJson(value: unknown, limit = 800): string {
  if (value == null) return "none";
  const s = JSON.stringify(value);
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}... (truncated, ${s.length} chars total)`;
}

/** Format a 0..1 ratio as a percentage with one decimal (CTR). */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio == null || isNaN(ratio)) return "unknown";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Format a signed percentage delta (e.g. clicks vs prior period). */
export function formatDelta(current: number, prior: number): string {
  if (prior === 0) {
    return current > 0 ? "+∞%" : current < 0 ? "-∞%" : "0%";
  }
  const delta = ((current - prior) / prior) * 100;
  const sign = delta > 0 ? "+" : delta < 0 ? "" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

/** Round a search position to one decimal. */
export function formatPosition(pos: number | null | undefined): string {
  if (pos == null || isNaN(pos)) return "unknown";
  return pos.toFixed(1);
}
