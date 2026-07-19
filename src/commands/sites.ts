import { encode } from "@toon-format/toon";
import type { GscCtx } from "../config.js";
import { listSites } from "../http.js";
import { requireKey } from "../errors.js";
import { rejectUnknownFlags, takeBoolFlag } from "../args.js";
import { field, custom, renderList, renderHelp, renderOutput } from "../toon.js";
import { formatCountLine } from "../format.js";

export const SITES_HELP = `usage: gsc-axi sites [flags]
List the Search Console properties the service account can access (with the SA's
permission level on each). This is the first command to run after wiring auth.

flags:
  --json (raw API response), --help
examples:
  gsc-axi sites
  gsc-axi sites --json
`;

export async function sitesCommand(args: string[], ctx: GscCtx): Promise<string> {
  if (args.includes("--help")) return SITES_HELP;
  rejectUnknownFlags(args, [], ["--json"]);
  const asJson = takeBoolFlag(args, "--json");
  requireKey(ctx);

  const sites = await listSites(ctx);
  if (asJson) return JSON.stringify({ siteEntry: sites }, null, 2);

  const blocks: string[] = [formatCountLine({ count: sites.length, totalCount: sites.length })];
  if (sites.length === 0) {
    blocks.push("sites: 0 accessible — add the SA client_email as a user on a property");
  } else {
    blocks.push(
      renderList("sites", sites, [
        field("siteUrl", "url"),
        custom("permission", (i) => i.permissionLevel ?? "unknown"),
      ]),
    );
  }
  blocks.push(
    renderHelp([
      "Run `gsc-axi query --site <hint> --last 7 --dimension query` for top queries",
      "Run `gsc-axi monitor --site <hint>` for a 28d health summary",
      "Run `gsc-axi inspect <url> --site <hint>` for a URL's index status",
    ]),
  );
  return renderOutput(blocks);
}
