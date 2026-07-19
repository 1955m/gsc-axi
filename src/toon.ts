import { encode } from "@toon-format/toon";

// Field-schema helpers — keep output schemas minimal (AXI §2). Each helper
// declares how to pull a single value out of a raw JSON object for rendering.

export function field(key: string, as?: string) {
  return { type: "field", key, as } as const;
}
export function pluck(key: string, subkey: string, as?: string) {
  return { type: "pluck", key, subkey, as } as const;
}
export function joinArray(key: string, subkey: string, as?: string, empty = "none") {
  return { type: "joinArray", key, subkey, as, empty } as const;
}
export function relativeTime(key: string, as?: string) {
  return { type: "relativeTime", key, as } as const;
}
export function boolYesNo(key: string, as?: string) {
  return { type: "boolYesNo", key, as } as const;
}
export function mapEnum(
  key: string,
  map: Record<string, string>,
  fallback: string,
  as?: string,
) {
  return { type: "mapEnum", key, map, fallback, as } as const;
}
export function lower(key: string, as?: string) {
  return { type: "lower", key, as } as const;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function custom(as: string, fn: (item: any) => any) {
  return { type: "custom", as, fn } as const;
}

type FieldDef =
  | ReturnType<typeof field>
  | ReturnType<typeof pluck>
  | ReturnType<typeof joinArray>
  | ReturnType<typeof relativeTime>
  | ReturnType<typeof boolYesNo>
  | ReturnType<typeof mapEnum>
  | ReturnType<typeof lower>
  | ReturnType<typeof custom>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extract(item: any, schema: FieldDef[]): Record<string, any> {
  const result: Record<string, any> = {};
  for (const def of schema) {
    const outputKey = "as" in def && def.as ? def.as : ("key" in def ? def.key : "");
    switch (def.type) {
      case "field":
        result[outputKey] = item[def.key] ?? null;
        break;
      case "pluck":
        result[outputKey] = item[def.key]?.[def.subkey] ?? null;
        break;
      case "joinArray": {
        const arr = item[def.key];
        if (Array.isArray(arr) && arr.length > 0) {
          result[outputKey] = arr
            .map((x) => (typeof x === "string" ? x : x[def.subkey]))
            .join(",");
        } else {
          result[outputKey] = def.empty;
        }
        break;
      }
      case "relativeTime":
        result[outputKey] = formatRelativeTime(item[def.key]);
        break;
      case "boolYesNo":
        result[outputKey] = item[def.key] ? "yes" : "no";
        break;
      case "mapEnum": {
        const val = item[def.key];
        if (typeof val === "string" && val !== "" && val in def.map) {
          result[outputKey] = def.map[val];
        } else {
          result[outputKey] = def.fallback ?? val ?? "none";
        }
        break;
      }
      case "lower":
        result[outputKey] =
          typeof item[def.key] === "string" ? item[def.key].toLowerCase() : item[def.key];
        break;
      case "custom":
        result[outputKey] = def.fn(item);
        break;
    }
  }
  return result;
}

/** Render a labeled list of items as TOON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderList(label: string, items: any[], schema: FieldDef[]): string {
  const extracted = items.map((item) => extract(item, schema));
  return encode({ [label]: extracted });
}

/** Render a single labeled detail object as TOON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function renderDetail(label: string, item: any, schema: FieldDef[]): string {
  const extracted = extract(item, schema);
  return encode({ [label]: extracted });
}

/** Render help suggestions (manual formatting — encode() inlines primitive arrays). */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) return "";
  const indented = lines.map((l) => `  ${l}`).join("\n");
  return `help[${lines.length}]:\n${indented}`;
}

/** Render an error in TOON format. */
export function renderError(message: string, code: string, suggestions: string[] = []): string {
  const blocks = [encode({ error: message, code })];
  if (suggestions.length > 0) blocks.push(renderHelp(suggestions));
  return blocks.join("\n");
}

/** Combine multiple TOON blocks into a single output string. */
export function renderOutput(blocks: (string | undefined)[]): string {
  return blocks.filter(Boolean).join("\n");
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "unknown";
  const diffMs = Date.now() - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 0) return "unknown"; // future timestamps (clock skew)
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return `${diffMon}mo ago`;
  return `${Math.floor(diffMon / 12)}y ago`;
}
