import { AxiError, installSessionStartHooks } from "axi-sdk-js";
import { renderHelp, renderOutput } from "../toon.js";

export const SETUP_HELP = `usage: gsc-axi setup hooks
Install or repair agent SessionStart hooks so every session begins with a
compact Search Console dashboard (active property, 7d organic summary, sitemap
error count, top queries). The hook runs \`gsc-axi\` (home view) at SessionStart
so the agent sees live state before taking action.

examples:
  gsc-axi setup hooks
`;

export async function setupCommand(args: string[]): Promise<string> {
  if (args.length === 1 && args[0] === "--help") return SETUP_HELP;
  if (args.length !== 1 || args[0] !== "hooks") {
    throw new AxiError("Unknown setup action", "VALIDATION_ERROR", ["Run `gsc-axi setup hooks`"]);
  }
  installSessionStartHooks();
  return renderOutput([
    "hooks:\n  status: installed\n  integrations: Claude Code, Codex, OpenCode",
    renderHelp([
      "Restart your agent session to receive gsc-axi ambient context",
      "The hook runs `gsc-axi` (home view) at SessionStart — set GSC_SA_KEY and GSC_SITE so it shows live data",
      "Default key path: ~/gsc-monitor/service-account.json",
    ]),
  ]);
}
