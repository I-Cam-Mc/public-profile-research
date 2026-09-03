#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXIT_INVALID = 2;
const EXIT_INCOMPLETE = 6;
const SHA256 = /^[a-f0-9]{64}$/;
const TRUSTED_BUILDER_SHA256 = new Set([
  "09d7afe25f76429ba1e99d08a5793af44c27738482d91e9b0bd2351ffd516066"
]);
const BUILDER_OPTION_FIELDS = ["timeout_ms", "ready_timeout_ms", "action_timeout_ms"];

function fail(message, exitCode = EXIT_INVALID) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256(filePath) {
  return hashBytes(fs.readFileSync(filePath));
}

function parseArgs(argv) {
  const values = {};
  const supported = new Set(["receipt", "html", "artifact", "builder-script", "raw-receipt"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--") || !supported.has(token.slice(2))) fail(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value) fail(`${token} requires a path`);
    values[token.slice(2)] = path.resolve(value);
    index += 1;
  }
  for (const key of supported) {
    if (!values[key]) fail(`--${key} is required`);
  }
  return values;
}

function verifyFileReference(reference, expectedPath, label) {
  if (!reference || typeof reference !== "object") fail(`${label} reference is missing`);
  const referencedPath = path.resolve(reference.path ?? "");
  if (expectedPath && referencedPath !== path.resolve(expectedPath)) fail(`${label} points to a different file`);
  if (!fs.existsSync(referencedPath) || !fs.statSync(referencedPath).isFile()) fail(`${label} is missing: ${referencedPath}`);
  if (expectedPath && fs.realpathSync(referencedPath) !== fs.realpathSync(path.resolve(expectedPath))) {
    fail(`${label} resolves to a different file`);
  }
  if (!SHA256.test(reference.sha256 ?? "")) fail(`${label} has an invalid SHA-256`);
  const actual = sha256(referencedPath);
  if (actual !== reference.sha256) fail(`${label} hash mismatch`);
  return referencedPath;
}

function validateRawReceipt(raw, expectedHtmlPath) {
  if (raw.ok !== true) fail("Raw builder receipt is not successful", EXIT_INCOMPLETE);
  if (path.resolve(raw.html ?? "") !== path.resolve(expectedHtmlPath)) fail("Raw builder receipt points to a different HTML file");
  for (const stage of ["validation", "package", "verification"]) {
    if (raw.stages?.[stage] !== "passed") {
      fail(`Browser verification did not pass: ${stage}=${raw.stages?.[stage] ?? "missing"}`, EXIT_INCOMPLETE);
    }
  }
  if (raw.browserWarning) fail("Browser receipt contains a capability warning", EXIT_INCOMPLETE);
  const viewports = new Set(raw.viewports ?? []);
  for (const width of [1440, 390]) {
    if (!viewports.has(width)) fail(`Browser receipt is missing the ${width}px viewport`, EXIT_INCOMPLETE);
  }
  if (!["passed", "not_applicable"].includes(raw.sourceDialog)) {
    fail("Browser source-dialog interaction was not verified", EXIT_INCOMPLETE);
  }
  if (raw.sourceDialog === "passed" && !String(raw.sourceInteraction ?? "").startsWith("keyboard_")) {
    fail("Browser source-dialog interaction was not keyboard verified", EXIT_INCOMPLETE);
  }
  return viewports;
}

function parseReceiptLine(stdout, label) {
  const line = String(stdout ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean).at(-1);
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`${label} did not return a JSON receipt: ${error.message}`);
  }
}

function validateBuilderOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("Builder options are missing");
  const result = {};
  for (const field of BUILDER_OPTION_FIELDS) {
    const value = options[field];
    if (!Number.isInteger(value) || value < 1 || value > 300_000) fail(`Builder option ${field} is invalid`);
    result[field] = value;
  }
  return result;
}

function replayTrustedBuilder(builderScriptPath, artifactPath, expectedHtmlPath, options) {
  const directory = mkdtempSync(path.join(tmpdir(), "public-profile-builder-replay-"));
  const replayHtmlPath = path.join(directory, "replay.html");
  const failureScreenshotPath = path.join(directory, "failure.png");
  try {
    const failures = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      fs.rmSync(replayHtmlPath, { force: true });
      fs.rmSync(failureScreenshotPath, { force: true });
      const result = spawnSync(process.execPath, [
        builderScriptPath,
        "--input", artifactPath,
        "--output", replayHtmlPath,
        "--timeout-ms", String(options.timeout_ms),
        "--ready-timeout-ms", String(options.ready_timeout_ms),
        "--action-timeout-ms", String(options.action_timeout_ms),
        "--screenshot", failureScreenshotPath
      ], {
        cwd: path.dirname(artifactPath),
        encoding: "utf8",
        timeout: Math.min(300_000, options.timeout_ms + 180_000)
      });
      if (result.error || result.status !== 0) {
        failures.push(`attempt ${attempt}: ${result.error?.message ?? result.stderr ?? result.status}`);
        continue;
      }
      const replayReceipt = parseReceiptLine(result.stdout, "Trusted builder replay");
      validateRawReceipt(replayReceipt, replayHtmlPath);
      if (!fs.existsSync(replayHtmlPath) || sha256(replayHtmlPath) !== sha256(expectedHtmlPath)) {
        fail("Trusted builder replay did not reproduce the attested HTML", EXIT_INCOMPLETE);
      }
      return {
        status: "passed",
        attempts: attempt,
        prior_failures: failures,
        html_sha256: sha256(replayHtmlPath),
        options,
        observation: replayReceipt
      };
    }
    fail(
      `Trusted builder replay failed after 3 attempts: ${failures.join(" | ")}. ` +
      "On a managed macOS agent host, a Chromium Mach-port permission failure means the exact verifier " +
      "needs browser execution approval outside the outer tool sandbox; do not disable Chromium's own sandbox.",
      EXIT_INCOMPLETE
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function verifyBrowserReceipt(receiptPath, {
  htmlPath,
  artifactPath,
  builderScriptPath,
  rawReceiptPath,
  trustedBuilderSha256 = TRUSTED_BUILDER_SHA256,
  replayBuilder = true
}) {
  let receiptBytes;
  let receipt;
  try {
    receiptBytes = fs.readFileSync(receiptPath);
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch (error) {
    fail(`Cannot read browser receipt: ${error.message}`);
  }
  if (receipt.version !== 3) fail("Browser receipt must use replay-bound schema version 3");
  if (receipt.ok !== true) fail("Browser delivery receipt is not successful", EXIT_INCOMPLETE);
  if (typeof receipt.run_id !== "string" || !receipt.run_id.trim()) fail("Browser receipt run_id is required");
  if (typeof receipt.started_at !== "string" || Number.isNaN(Date.parse(receipt.started_at))) {
    fail("Browser receipt started_at is invalid");
  }
  if (typeof receipt.generated_at !== "string" || Number.isNaN(Date.parse(receipt.generated_at))) {
    fail("Browser receipt generated_at is invalid");
  }
  if (Date.parse(receipt.generated_at) < Date.parse(receipt.started_at)) fail("Browser receipt predates its run start");
  const verifiedHtmlPath = verifyFileReference(receipt.html, htmlPath, "HTML");
  const verifiedArtifactPath = verifyFileReference(receipt.artifact, artifactPath, "Artifact");
  const verifiedBuilderPath = verifyFileReference(receipt.builder?.script, builderScriptPath, "Builder script");
  if (!trustedBuilderSha256.has(receipt.builder.script.sha256)) {
    fail(`Builder script digest is not in the trusted allowlist: ${receipt.builder.script.sha256}`);
  }
  const verifiedRawReceiptPath = verifyFileReference(receipt.builder?.raw_receipt, rawReceiptPath, "Raw builder receipt");
  const builderOptions = validateBuilderOptions(receipt.builder?.options);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(verifiedRawReceiptPath, "utf8"));
  } catch (error) {
    fail(`Raw builder receipt is not valid JSON: ${error.message}`);
  }
  const viewports = validateRawReceipt(raw, verifiedHtmlPath);
  const builderReplay = replayBuilder
    ? replayTrustedBuilder(verifiedBuilderPath, verifiedArtifactPath, verifiedHtmlPath, builderOptions)
    : { status: "skipped_by_internal_test_harness" };
  return {
    ok: true,
    run_id: receipt.run_id,
    started_at: receipt.started_at,
    generated_at: receipt.generated_at,
    receipt_path: path.resolve(receiptPath),
    receipt_sha256: hashBytes(receiptBytes),
    html: verifiedHtmlPath,
    html_sha256: receipt.html.sha256,
    artifact: verifiedArtifactPath,
    artifact_sha256: receipt.artifact.sha256,
    raw_receipt_sha256: receipt.builder.raw_receipt.sha256,
    builder_options: builderOptions,
    builder_replay: builderReplay,
    viewports: [...viewports].sort((left, right) => right - left),
    source_dialog: raw.sourceDialog,
    counts: raw.counts,
    observation: raw
  };
}

function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(
        "Usage: node verify-browser-receipt.mjs --receipt <attestation.json> --html <report.html> " +
        "--artifact <artifact.json> --builder-script <trusted.mjs> --raw-receipt <raw.json>\n"
      );
      return;
    }
    process.stdout.write(`${JSON.stringify(verifyBrowserReceipt(args.receipt, {
      htmlPath: args.html,
      artifactPath: args.artifact,
      builderScriptPath: args["builder-script"],
      rawReceiptPath: args["raw-receipt"]
    }))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = error.exitCode ?? EXIT_INVALID;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) runCli();
