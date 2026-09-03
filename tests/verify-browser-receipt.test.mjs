import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { verifyBrowserReceipt } from "../scripts/verify-browser-receipt.mjs";

const verifier = path.resolve("scripts/verify-browser-receipt.mjs");

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "browser-receipt-"));
  const htmlPath = path.join(directory, "report.html");
  const artifactPath = path.join(directory, "artifact.json");
  const builderPath = path.join(directory, "builder.mjs");
  const rawReceiptPath = path.join(directory, "raw-builder-receipt.json");
  const html = "<!doctype html><title>Report</title><main>Evidence</main>\n";
  writeFileSync(htmlPath, html, "utf8");
  writeFileSync(artifactPath, '{"schemaVersion":1}\n', "utf8");
  writeFileSync(builderPath, `
import fs from "node:fs";
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--") && all[index + 1]) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
fs.writeFileSync(args.output, ${JSON.stringify(html)});
console.log(JSON.stringify({
  ok: true,
  html: args.output,
  stages: { validation: "passed", package: "passed", verification: "passed" },
  counts: { blocks: 1, charts: 1, tables: 1 },
  sourceDialog: "passed",
  sourceInteraction: "keyboard_menu_semantic_click",
  viewports: [1440, 390]
}));
`, "utf8");
  writeFileSync(rawReceiptPath, `${JSON.stringify({
    ok: true,
    html: htmlPath,
    stages: { validation: "passed", package: "passed", verification: "passed" },
    counts: { blocks: 1, charts: 1, tables: 1 },
    sourceDialog: "passed",
    sourceInteraction: "keyboard_menu_semantic_click",
    viewports: [1440, 390]
  })}\n`, "utf8");
  const receiptPath = path.join(directory, "builder-receipt.json");
  const receipt = {
    version: 3,
    ok: true,
    run_id: "browser-run-1",
    started_at: "2026-09-02T00:00:00Z",
    generated_at: "2026-09-02T00:01:00Z",
    html: { path: htmlPath, sha256: sha256(htmlPath) },
    artifact: { path: artifactPath, sha256: sha256(artifactPath) },
    builder: {
      script: { path: builderPath, sha256: sha256(builderPath) },
      raw_receipt: { path: rawReceiptPath, sha256: sha256(rawReceiptPath) },
      options: { timeout_ms: 120000, ready_timeout_ms: 30000, action_timeout_ms: 30000 }
    }
  };
  writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
  return { directory, htmlPath, artifactPath, builderPath, rawReceiptPath, receiptPath, receipt };
}

function verify(state, overrides = {}) {
  return verifyBrowserReceipt(state.receiptPath, {
    htmlPath: state.htmlPath,
    artifactPath: state.artifactPath,
    builderScriptPath: state.builderPath,
    rawReceiptPath: state.rawReceiptPath,
    trustedBuilderSha256: new Set([sha256(state.builderPath)]),
    replayBuilder: true,
    ...overrides
  });
}

test("a trusted builder is actually replayed before its attestation passes", () => {
  const state = fixture();
  const result = verify(state);
  assert.equal(result.ok, true);
  assert.equal(result.run_id, "browser-run-1");
  assert.equal(result.html_sha256, sha256(state.htmlPath));
  assert.equal(result.builder_replay.status, "passed");
});

test("the production CLI rejects an arbitrary caller-supplied builder", () => {
  const state = fixture();
  const result = spawnSync(process.execPath, [
    verifier,
    "--receipt", state.receiptPath,
    "--html", state.htmlPath,
    "--artifact", state.artifactPath,
    "--builder-script", state.builderPath,
    "--raw-receipt", state.rawReceiptPath
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(JSON.parse(result.stderr).error, /trusted|allowlist/i);
});

test("structural-only fallback is rejected for final delivery", () => {
  const state = fixture();
  const raw = JSON.parse(readFileSync(state.rawReceiptPath, "utf8"));
  raw.stages.verification = "structural_only";
  raw.sourceDialog = "not_verified";
  raw.viewports = [];
  raw.browserWarning = { code: "browser_unavailable" };
  writeFileSync(state.rawReceiptPath, `${JSON.stringify(raw)}\n`, "utf8");
  state.receipt.builder.raw_receipt.sha256 = sha256(state.rawReceiptPath);
  writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`, "utf8");
  assert.throws(() => verify(state), (error) => error.exitCode === 6 && /browser verification did not pass/i.test(error.message));
});

test("a fabricated receipt cannot point to a missing HTML file", () => {
  const state = fixture();
  state.receipt.html.path = path.join(state.directory, "missing.html");
  state.receipt.html.sha256 = "a".repeat(64);
  writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`, "utf8");
  assert.throws(() => verify(state), /different file|missing/i);
});

test("changing the generated HTML after browser verification invalidates the attestation", () => {
  const state = fixture();
  writeFileSync(state.htmlPath, "<!doctype html><title>Tampered</title>\n", "utf8");
  assert.throws(() => verify(state), /HTML hash mismatch/i);
});

test("canonical builder and raw receipt paths are required", () => {
  const state = fixture();
  const alternateBuilder = path.join(state.directory, "alternate-builder.mjs");
  writeFileSync(alternateBuilder, readFileSync(state.builderPath));
  state.receipt.builder.script = { path: alternateBuilder, sha256: sha256(alternateBuilder) };
  writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`, "utf8");
  assert.throws(() => verify(state), /builder script points to a different file/i);
});

test("a replay process failure explains the managed browser permission boundary", () => {
  const state = fixture();
  writeFileSync(state.builderPath, "process.stderr.write('Chromium exited before verification completed\\n'); process.exit(9);\n", "utf8");
  state.receipt.builder.script.sha256 = sha256(state.builderPath);
  writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`, "utf8");
  assert.throws(
    () => verify(state, { trustedBuilderSha256: new Set([sha256(state.builderPath)]) }),
    (error) => error.exitCode === 6 && /managed.*sandbox|browser execution approval|mach.?port/i.test(error.message)
  );
});
