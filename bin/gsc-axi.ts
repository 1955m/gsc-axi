#!/usr/bin/env node
import { main } from "../src/cli.js";

main().catch((error) => {
  // The SDK handles structured errors inside runAxiCli; this is a last-resort
  // guard so a thrown bug never dumps a raw stack trace to an agent.
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`error: ${message}\ncode: UNKNOWN\n`);
  process.exitCode = 1;
});
