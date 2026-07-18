import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import type { AxiCliCommand } from "axi-sdk-js";
import { resolveConfig, type GscCtx } from "./config.js";
import { takeFlag } from "./args.js";
import { homeCommand } from "./commands/home.js";
import { sitesCommand, SITES_HELP } from "./commands/sites.js";
import { queryCommand, QUERY_HELP } from "./commands/query.js";
import { sitemapsCommand, SITEMAPS_HELP } from "./commands/sitemaps.js";
import { inspectCommand, INSPECT_HELP } from "./commands/inspect.js";
import { monitorCommand, MONITOR_HELP } from "./commands/monitor.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";

export const DESCRIPTION =
  "Agent-ergonomic CLI for Google Search Console. Token-efficient TOON output for search analytics (clicks/impressions/CTR/position), sitemaps, URL inspection, and a monitor health summary for daily cron regression alerts. Service-account auth.";

function readVersion(): string {
  // Walk up from the entrypoint to the nearest package.json (works for both
  // the built dist/ tree and `tsx` dev runs).
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const p = join(dir, "package.json");
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (typeof j.version === "string") return j.version;
    } catch {
      // continue up
    }
    dir = dirname(dir);
  }
  return "0.0.0";
}

export const VERSION = readVersion();

export const TOP_HELP = `usage: gsc-axi [command] [args] [flags]
commands[6]:
  (none)=dashboard, sites, query, sitemaps, inspect, monitor, setup
flags[3]:
  --key <path> (after command) or GSC_SA_KEY env (default ~/gsc-monitor/service-account.json), --site <hint> (after command) or GSC_SITE env (bare domain / full URL / sc-domain:), --json (raw API JSON), --help
auth:
  Google service-account JSON key. Scope webmasters.readonly for all reads; sitemap submit needs webmasters (write) — requested automatically.
  Enable the Search Console API in Google Cloud Console and add the SA client_email as a user on the property.
examples:
  gsc-axi
  gsc-axi sites
  gsc-axi query --site example.com --last 7 --dimension query --limit 20
  gsc-axi sitemaps --site example.com
  gsc-axi inspect https://example.com/about --site example.com
  gsc-axi monitor --site example.com
  gsc-axi setup hooks
`;

const COMMAND_HELP: Record<string, string> = {
  sites: SITES_HELP,
  query: QUERY_HELP,
  sitemaps: SITEMAPS_HELP,
  inspect: INSPECT_HELP,
  monitor: MONITOR_HELP,
  setup: SETUP_HELP,
};

type CommandHandler = (args: string[], ctx: GscCtx) => Promise<string> | string;

/**
 * Wrap a command handler so the global context flags (--key, --site) are
 * stripped from the args the handler inspects — keeping positional extraction
 * and unknown-flag validation correct when those flags precede positionals.
 * The context itself is resolved once by the SDK's resolveContext and passed in.
 */
function withCtx(handler: CommandHandler): AxiCliCommand<GscCtx> {
  return async (args, ctx) => {
    const copy = [...args];
    takeFlag(copy, "--key");
    takeFlag(copy, "--site");
    return handler(copy, (ctx as GscCtx | undefined) ?? resolveConfig({}));
  };
}

export async function main(options: { argv?: string[] } = {}): Promise<void> {
  await runAxiCli<GscCtx>({
    ...(options.argv ? { argv: options.argv } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: withCtx(homeCommand),
    commands: {
      sites: withCtx(sitesCommand),
      query: withCtx(queryCommand),
      sitemaps: withCtx(sitemapsCommand),
      inspect: withCtx(inspectCommand),
      monitor: withCtx(monitorCommand),
      setup: setupCommand,
    },
    getCommandHelp: (command) => COMMAND_HELP[command],
    resolveContext: ({ args }) => {
      const keyFlag = takeFlag([...args], "--key");
      const siteFlag = takeFlag([...args], "--site");
      return resolveConfig({ keyFlag, siteFlag });
    },
  });
}
