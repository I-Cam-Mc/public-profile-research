import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { buildReportHtml, buildReportModel } from "../report/build-report.mjs";
import { canonicalJson } from "../runner/canonical-json.mjs";
import { normaliseSourceItems } from "../runner/source-items.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertJsonEqual(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} linkage mismatch`);
}

function assertNoSymlinks(directory, root = directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || fs.lstatSync(entryPath).isSymbolicLink()) {
      fail(`Research run must not contain symbolic links: ${path.relative(root, entryPath) || entry.name}`);
    }
    if (entry.isDirectory()) assertNoSymlinks(entryPath, root);
  }
}

function resolveInside(root, candidate, label, expectedType = "file") {
  if (typeof candidate !== "string" || !candidate.trim()) fail(`${label} path is required`);
  if (path.isAbsolute(candidate)) fail(`${label} path must be relative to the research run`);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label} path escapes the research run`);
  }
  let stats;
  try {
    stats = fs.lstatSync(resolved);
  } catch (error) {
    fail(`${label} is missing: ${candidate} (${error.message})`);
  }
  if (stats.isSymbolicLink()) fail(`${label} must not be a symbolic link: ${candidate}`);
  const real = fs.realpathSync(resolved);
  const realRelative = path.relative(root, real);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    fail(`${label} resolves outside the research run: ${candidate}`);
  }
  if (expectedType === "file" && !stats.isFile()) fail(`${label} must be a file: ${candidate}`);
  if (expectedType === "directory" && !stats.isDirectory()) fail(`${label} must be a directory: ${candidate}`);
  return real;
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function secureJson(root, candidate, label) {
  const filePath = resolveInside(root, candidate, label);
  const bytes = fs.readFileSync(filePath);
  return { filePath, bytes, value: parseJson(bytes, label) };
}

function receiptPayload(receipt) {
  const { sha256: _digest, ...payload } = receipt;
  return payload;
}

function verifyReceipts(run, root) {
  if (!Array.isArray(run.targets)) fail("research-run targets must be an array");
  const receiptsRoot = resolveInside(root, run.artifacts.receipts_directory, "receipts directory", "directory");
  const receipts = new Map();
  for (const [targetIndex, target] of run.targets.entries()) {
    if (!isObject(target) || !Array.isArray(target.attempts)) fail(`target ${targetIndex} attempts must be an array`);
    for (const [attemptIndex, attempt] of target.attempts.entries()) {
      const label = `target ${targetIndex} attempt ${attemptIndex} receipt`;
      if (receipts.has(attempt.receipt_path)) fail(`Receipt path is repeated: ${attempt.receipt_path}`);
      const receiptFile = secureJson(root, attempt.receipt_path, label);
      const relativeToReceipts = path.relative(receiptsRoot, receiptFile.filePath);
      if (!relativeToReceipts || relativeToReceipts.startsWith("..") || path.isAbsolute(relativeToReceipts)) {
        fail(`${label} path is outside the receipts directory`);
      }
      const { value: receipt } = receiptFile;
      const computed = sha256(canonicalJson(receiptPayload(receipt)));
      if (!SHA256.test(receipt.sha256 ?? "") || receipt.sha256 !== computed || attempt.receipt_sha256 !== computed) {
        fail(`${label} digest mismatch`);
      }
      if (receipt.adapter_id !== attempt.adapter_id || receipt.status !== attempt.status) {
        fail(`${label} metadata linkage mismatch`);
      }
      if (receipt.target?.platform !== target.platform || receipt.target?.canonical_url !== target.canonical_url) {
        fail(`${label} target linkage mismatch`);
      }
      receipts.set(attempt.receipt_path, { targetIndex, target, attempt, receipt });
    }
  }
  return receipts;
}

function expectedEvidence(entry, run) {
  const { target, attempt, receipt } = entry;
  return {
    schema_version: 1,
    run_id: run.run_id,
    target: { platform: target.platform, canonical_url: target.canonical_url },
    adapter_id: attempt.adapter_id,
    observed_at: receipt.ended_at,
    coverage: receipt.coverage ?? null,
    source_urls: Array.isArray(receipt.source_urls) ? receipt.source_urls : [],
    receipt: { path: attempt.receipt_path, sha256: attempt.receipt_sha256 },
    data: receipt.data
  };
}

function verifyLedger(run, root, receipts) {
  const ledgerReference = run.artifacts;
  const { bytes, value: ledger } = secureJson(root, ledgerReference.evidence_ledger_path, "evidence ledger");
  if (!SHA256.test(ledgerReference.evidence_ledger_sha256 ?? "") || sha256(bytes) !== ledgerReference.evidence_ledger_sha256) {
    fail("Evidence ledger hash mismatch");
  }
  if (ledger.schema_version !== 1 || ledger.run_id !== run.run_id || ledger.generated_at !== run.generated_at) {
    fail("Evidence ledger run linkage mismatch");
  }
  if (!Array.isArray(ledger.items) || ledger.items.length !== receipts.size) {
    fail("Evidence ledger attempt inventory mismatch");
  }

  const receiptEntries = [...receipts.values()];
  let evidenceFiles = 0;
  for (const [index, entry] of receiptEntries.entries()) {
    const { targetIndex, target, attempt, receipt } = entry;
    const actual = ledger.items[index];
    const sourceUrls = Array.isArray(receipt.source_urls) ? receipt.source_urls : [];
    const hasEvidence = ["collected", "partial"].includes(attempt.status) && Object.hasOwn(receipt, "data");
    let evidencePath = null;
    let evidenceHash = null;
    if (hasEvidence) {
      evidencePath = path.posix.join(
        "evidence",
        `${String(targetIndex + 1).padStart(2, "0")}-${attempt.adapter_id.replace(/[^a-z0-9_-]/gi, "-")}.json`
      );
      if (actual?.evidence_path !== evidencePath) fail(`Evidence file path linkage mismatch for ${attempt.receipt_path}`);
      const evidenceFile = secureJson(root, actual.evidence_path, `evidence file for ${attempt.receipt_path}`);
      evidenceHash = sha256(evidenceFile.bytes);
      if (!SHA256.test(actual.evidence_sha256 ?? "") || actual.evidence_sha256 !== evidenceHash) {
        fail(`Evidence file hash mismatch for ${attempt.receipt_path}`);
      }
      assertJsonEqual(evidenceFile.value, expectedEvidence(entry, run), `Evidence file for ${attempt.receipt_path}`);
      evidenceFiles += 1;
    } else if (actual?.evidence_path !== null || actual?.evidence_sha256 !== null) {
      fail(`Evidence file must be absent for ${attempt.receipt_path}`);
    }
    const expectedItem = {
      target_index: targetIndex,
      platform: target.platform,
      target_url: target.canonical_url,
      adapter_id: attempt.adapter_id,
      status: attempt.status,
      barrier: receipt.barrier ?? null,
      message: attempt.message || receipt.message || "",
      coverage: receipt.coverage ?? null,
      source_urls: sourceUrls,
      receipt_path: attempt.receipt_path,
      receipt_sha256: attempt.receipt_sha256,
      evidence_path: evidencePath,
      evidence_sha256: evidenceHash
    };
    assertJsonEqual(actual, expectedItem, `Evidence ledger item ${index}`);
  }
  assertJsonEqual(run.evidence_inventory, ledger.items, "Research-run evidence inventory");
  return { ledger, evidenceFiles };
}

function expectedSourceItems(run, receipts) {
  const sourceItems = [];
  const seen = new Set();
  let duplicates = 0;
  for (const { target, attempt, receipt } of receipts.values()) {
    const normalised = normaliseSourceItems({
      target,
      attempt,
      receipt,
      providedAnchors: run.research_brief?.subject?.identity_anchors ?? []
    });
    for (const item of normalised) {
      if (seen.has(item.item_id)) {
        duplicates += 1;
        continue;
      }
      seen.add(item.item_id);
      sourceItems.push(item);
    }
  }
  return { sourceItems, duplicates };
}

function verifySourceItemArchives(run, root, receipts, ledger) {
  if (!Array.isArray(ledger.source_items)) fail("Evidence ledger source_items must be an array");
  const expected = expectedSourceItems(run, receipts);
  if (ledger.deduplicated_observations !== expected.duplicates || ledger.source_items.length !== expected.sourceItems.length) {
    fail("Source-item inventory linkage mismatch");
  }
  for (const [index, expectedItem] of expected.sourceItems.entries()) {
    const actual = ledger.source_items[index];
    const digest = expectedItem.evidence_id.match(/^evidence:([a-f0-9]{64})$/)?.[1];
    if (!digest) fail(`Source item ${index} has an invalid evidence ID`);
    const expectedPath = `evidence/items/${digest}.json`;
    resolveInside(root, actual?.archive_path, `source-item archive ${index}`);
    if (actual.archive_path !== expectedPath) fail(`Source-item archive ${index} path linkage mismatch`);
    const archive = secureJson(root, actual.archive_path, `source-item archive ${index}`);
    const archiveHash = sha256(archive.bytes);
    if (!SHA256.test(actual.archive_sha256 ?? "") || actual.archive_sha256 !== archiveHash) {
      fail(`Source-item archive ${index} hash mismatch`);
    }
    assertJsonEqual(archive.value, expectedItem, `Source-item archive ${index} content`);
    assertJsonEqual(actual, { ...expectedItem, archive_path: expectedPath, archive_sha256: archiveHash }, `Source item ${index}`);
    const provenance = receipts.get(expectedItem.provenance?.receipt_path);
    if (!provenance || expectedItem.provenance.receipt_sha256 !== provenance.attempt.receipt_sha256) {
      fail(`Source-item archive ${index} receipt linkage mismatch`);
    }
  }
  return expected.sourceItems.length;
}

function verifyReports(run, root, receipts, ledger) {
  const model = secureJson(root, run.artifacts.report_model_path, "report model");
  if (!SHA256.test(run.artifacts.report_model_sha256 ?? "") || sha256(model.bytes) !== run.artifacts.report_model_sha256) {
    fail("Report model hash mismatch");
  }
  if (model.value.schema_version !== 1 || model.value.report_type !== "public_profile_research" || model.value.run_id !== run.run_id) {
    fail("Report model run ID linkage mismatch");
  }
  const receiptValues = Object.fromEntries(
    [...receipts.entries()].map(([receiptPath, entry]) => [receiptPath, entry.receipt])
  );
  const expectedModel = buildReportModel(run, receiptValues, ledger.source_items);
  assertJsonEqual(model.value, expectedModel, "Report model semantic");
  const htmlPath = resolveInside(root, run.artifacts.html_report_path, "HTML report");
  const htmlBytes = fs.readFileSync(htmlPath);
  if (!SHA256.test(run.artifacts.html_report_sha256 ?? "") || sha256(htmlBytes) !== run.artifacts.html_report_sha256) {
    fail("HTML report hash mismatch");
  }
  if (!htmlBytes.toString("utf8").includes(`Run ${run.run_id}.`)) fail("HTML report run ID linkage mismatch");
  const expectedHtml = buildReportHtml(expectedModel);
  if (!htmlBytes.equals(Buffer.from(expectedHtml, "utf8"))) fail("HTML report semantic linkage mismatch");
}

export function verifyResearchRunDirectory(runDirectory) {
  const requestedRoot = path.resolve(runDirectory);
  let rootStats;
  try {
    rootStats = fs.lstatSync(requestedRoot);
  } catch (error) {
    fail(`Research run directory is missing: ${requestedRoot} (${error.message})`);
  }
  if (rootStats.isSymbolicLink()) fail("Research run directory must not be a symbolic link");
  if (!rootStats.isDirectory()) fail("Research run path must be a directory");
  const root = fs.realpathSync(requestedRoot);
  assertNoSymlinks(root);

  const runPath = resolveInside(root, "research-run.json", "research-run metadata");
  const run = parseJson(fs.readFileSync(runPath), "research-run metadata");
  if (run.schema_version !== 1 || typeof run.run_id !== "string" || !run.run_id.trim()) {
    fail("research-run metadata must be a schema-v1 runner output with a run ID");
  }
  if (!isObject(run.artifacts)) fail("research-run artifacts are required");
  if (run.artifacts.run_metadata_path !== "research-run.json") fail("research-run metadata path linkage mismatch");
  if (run.artifacts.receipts_directory !== "receipts" || run.artifacts.evidence_directory !== "evidence") {
    fail("research-run artifact directory linkage mismatch");
  }
  resolveInside(root, run.artifacts.receipts_directory, "receipts directory", "directory");
  resolveInside(root, run.artifacts.evidence_directory, "evidence directory", "directory");

  const receipts = verifyReceipts(run, root);
  const { ledger, evidenceFiles } = verifyLedger(run, root, receipts);
  const sourceItems = verifySourceItemArchives(run, root, receipts, ledger);
  verifyReports(run, root, receipts, ledger);
  return { run_id: run.run_id, receipts: receipts.size, evidence_files: evidenceFiles, source_items: sourceItems };
}
