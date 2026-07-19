import { AxiError } from "./errors.js";

/** Get a flag's value from `--flag value` or `--flag=value` without modifying args. */
export function getFlag(args: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) return args[i + 1];
    if (arg.startsWith(equalsPrefix)) return arg.slice(equalsPrefix.length);
  }
  return undefined;
}

/** Get a flag's value and remove it (and its value) from args. */
export function takeFlag(args: string[], flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag) {
      const val = args[i + 1];
      args.splice(i, 2);
      return val;
    }
    if (arg.startsWith(equalsPrefix)) {
      const val = arg.slice(equalsPrefix.length);
      args.splice(i, 1);
      return val;
    }
  }
  return undefined;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function takeBoolFlag(args: string[], flag: string): boolean {
  const idx = args.indexOf(flag);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

/** Collect all values for a repeatable flag (`--flag value` or `--flag=value`). */
export function getAllFlags(args: string[], flag: string): string[] {
  const result: string[] = [];
  const equalsPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === flag && i + 1 < args.length) {
      result.push(args[i + 1]);
      i++;
    } else if (arg.startsWith(equalsPrefix)) {
      result.push(arg.slice(equalsPrefix.length));
    }
  }
  return result;
}

/** Get the first positional arg (non-flag) starting from startIndex. */
export function getPositional(args: string[], startIndex = 0): string | undefined {
  for (let i = startIndex; i < args.length; i++) {
    if (!args[i].startsWith("--")) return args[i];
  }
  return undefined;
}

export function requireNumber(raw: string | undefined, label: string): number {
  if (!raw) throw new AxiError(`Missing ${label}`, "VALIDATION_ERROR");
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new AxiError(`Invalid ${label}: ${raw}`, "VALIDATION_ERROR");
  return n;
}

/**
 * Reject unknown flags (AXI §6). `valueFlags` consume the following arg as a
 * value; `boolFlags` stand alone. Globals (`--key`, `--site`, `--json`,
 * `--help`) always pass. Exit code 2 with the valid flags inlined so the
 * agent self-corrects in one turn.
 */
export function rejectUnknownFlags(
  args: string[],
  valueFlags: string[],
  boolFlags: string[] = [],
): void {
  const globals = ["--key", "--site", "--json", "--help"];
  const allowed = new Set([...valueFlags, ...boolFlags, ...globals]);
  const valueSet = new Set(valueFlags);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (allowed.has(name)) {
      // Consume the value of a value-flag given as `--flag value` (not `--flag=v`).
      if (valueSet.has(name) && !arg.includes("=")) i++;
      continue;
    }
    const valid = [...valueFlags, ...boolFlags].filter((f) => !globals.includes(f)).sort();
    throw new AxiError(
      `unknown flag ${name}`,
      "VALIDATION_ERROR",
      valid.length > 0
        ? [`valid flags: ${valid.join(", ")} (--help always allowed)`]
        : ["this subcommand takes no flags (other than --help)"],
    );
  }
}
