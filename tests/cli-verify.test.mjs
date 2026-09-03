import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../bin/ppr-cli.mjs";

test("CLI verifies a saved schema-v1 research run", async () => {
  const output = [];
  const calls = [];
  const exitCode = await runCli(["verify", "--run", "./saved-run"], {
    cwd: "/tmp/ppr-cli-verify",
    stdout: (line) => output.push(line),
    stderr: () => {},
    verifyRun: async (runDirectory) => {
      calls.push(runDirectory);
      return { run_id: "run-example", receipts: 2, evidence_files: 2, source_items: 3 };
    }
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ["/tmp/ppr-cli-verify/saved-run"]);
  assert.match(output.join("\n"), /verification passed/i);
  assert.match(output.join("\n"), /run-example/);
});

test("CLI reports verification failures without claiming success", async () => {
  const output = [];
  const errors = [];
  const exitCode = await runCli(["verify", "--run", "./saved-run"], {
    cwd: "/tmp/ppr-cli-verify",
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
    verifyRun: async () => { throw new Error("Evidence ledger hash mismatch"); }
  });

  assert.equal(exitCode, 1);
  assert.doesNotMatch(output.join("\n"), /passed/i);
  assert.match(errors.join("\n"), /verification failed.*ledger hash mismatch/i);
});

test("CLI requires exactly one run directory for verification", async () => {
  const errors = [];
  const exitCode = await runCli(["verify"], {
    stdout: () => {},
    stderr: (line) => errors.push(line)
  });

  assert.equal(exitCode, 64);
  assert.match(errors.join("\n"), /verify requires.*--run/i);
});
