#!/usr/bin/env node

import { runCli } from "./ppr-cli.mjs";

try {
  process.exitCode = await runCli();
} catch (error) {
  console.error(`Research failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

