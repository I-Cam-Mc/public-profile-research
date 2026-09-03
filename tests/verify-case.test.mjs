import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const verifier = path.resolve("scripts/verify-case.mjs");

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonl(filePath, rows) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function reference(root, absolutePath) {
  return { path: path.relative(root, absolutePath), sha256: sha256(absolutePath) };
}

function completeRow(evidenceReference) {
  return {
    item_id: "video-1",
    canonical_url: "https://example.test/video-1",
    item_type: "video",
    published_at: "2026-09-01T00:00:00Z",
    observed_at: "2026-09-02T00:00:00Z",
    final_state: "processed",
    required_modalities: ["creator_text", "speech", "visual"],
    modalities: { creator_text: "complete", speech: "complete", visual: "complete" },
    speech_review: {
      method: "full_duration_audio_transcript_review",
      coverage: "full_duration",
      evidence: [evidenceReference]
    },
    visual_review: {
      method: "full_duration_interval_and_scene_review",
      coverage: "full_duration",
      evidence: [evidenceReference]
    },
    evidence: [evidenceReference]
  };
}

function completeCase() {
  const root = mkdtempSync(path.join(tmpdir(), "public-profile-case-"));
  const itemEvidencePath = path.join(root, "evidence", "video-1.json");
  writeJson(itemEvidencePath, { item_id: "video-1", observed: true });
  writeJsonl(path.join(root, "ledgers", "youtube.jsonl"), [completeRow(reference(root, itemEvidencePath))]);

  const discoveryReceiptPath = path.join(root, "receipts", "discovery.json");
  writeJson(discoveryReceiptPath, {
    schema_version: 1,
    method: "first_party_identity_links_and_search",
    started_at: "2026-09-02T00:00:00Z",
    ended_at: "2026-09-02T00:01:00Z",
    source_classes_checked: ["youtube_account"],
    terminal_reason: "planned_source_classes_reconciled"
  });

  const adapterCapturePath = path.join(root, "evidence", "youtube-listing.json");
  writeJson(adapterCapturePath, { ids: ["video-1"] });
  const adapterReceiptPath = path.join(root, "receipts", "youtube.json");
  writeJson(adapterReceiptPath, {
    schema_version: 2,
    adapter_id: "official_listing",
    adapter_version: "1.0.0",
    started_at: "2026-09-02T00:00:00Z",
    ended_at: "2026-09-02T00:01:00Z",
    scope: { kind: "lifetime", account_url: "https://example.test/account" },
    returned_count: 1,
    unique_id_count: 1,
    terminal_reason: "api_listing_exhausted",
    credential_present: false,
    captures: [reference(root, adapterCapturePath)]
  });

  const accountEvidencePath = path.join(root, "evidence", "account.json");
  writeJson(accountEvidencePath, { canonical_url: "https://example.test/account" });
  const inventoryPath = path.join(root, "source-inventory.json");
  writeJson(inventoryPath, {
    schema_version: 1,
    observed_at: "2026-09-02T00:02:00Z",
    discovery_receipts: [reference(root, discoveryReceiptPath)],
    sources: [{
      id: "youtube-account",
      source_class: "youtube_account",
      platform: "youtube",
      account_url: "https://example.test/account",
      disposition: "included",
      source_family_id: "youtube",
      evidence: [reference(root, accountEvidencePath)]
    }]
  });

  const casePath = path.join(root, "case.json");
  writeJson(casePath, {
    schema_version: 2,
    case_id: "synthetic-subject",
    mode: "maximum_public_coverage",
    requested_report_status: "final",
    ledger_directory: "ledgers",
    scope: { expected_source_classes: ["youtube_account"] },
    source_inventory: reference(root, inventoryPath),
    source_families: [{
      id: "youtube",
      platform: "youtube",
      material: true,
      ledger_paths: ["ledgers/youtube.jsonl"],
      enumeration: {
        status: "closed",
        target: { kind: "lifetime" },
        denominator_basis: "complete_api_listing",
        expected_count: 1,
        enumerated_count: 1,
        approved_adapter_ids: ["official_listing"],
        adapters: [{
          id: "official_listing",
          coverage_role: "denominator",
          status: "exhausted",
          attempted_at: "2026-09-02T00:00:00Z",
          receipt: reference(root, adapterReceiptPath)
        }]
      }
    }]
  });
  return root;
}

function runVerifier(root) {
  return spawnSync(process.execPath, [verifier, "--case", path.join(root, "case.json")], {
    cwd: path.resolve("."),
    encoding: "utf8"
  });
}

function resultPayload(result) {
  return JSON.parse((result.stdout || result.stderr).trim());
}

test("a final report passes only when inventory, enumeration and modalities are complete", () => {
  const root = completeCase();
  const result = runVerifier(root);
  assert.equal(result.status, 0, result.stderr);
  const receipt = resultPayload(result);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.computed_coverage_status, "closed");
  assert.equal(receipt.source_families.youtube.status, "closed");
});

test("a sparse maximum-coverage case cannot pass with invented schema fields", () => {
  const root = completeCase();
  writeJsonl(path.join(root, "ledgers", "youtube.jsonl"), [{
    item_id: "video-1",
    canonical_url: "https://example.test/video-1",
    final_state: "processed",
    modalities: {}
  }]);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /item_type|published_at|required_modalities|evidence/i);
});

test("every expected source class must be reconciled through the source inventory", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  manifest.scope.expected_source_classes.push("x_account");
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /expected source class x_account|x_account.*inventory|inventory.*x_account/i);
});

test("a source family cannot exist without an included source-inventory owner", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  manifest.source_families.push({ ...manifest.source_families[0], id: "unowned", material: false });
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /unowned.*source inventory/i);
});

test("each source family has exactly one included account owner", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  const inventoryPath = path.join(root, manifest.source_inventory.path);
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  inventory.sources.push({
    ...inventory.sources[0],
    id: "youtube-account-2",
    account_url: "https://example.test/second-account"
  });
  writeJson(inventoryPath, inventory);
  manifest.source_inventory.sha256 = sha256(inventoryPath);
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /exactly one included account|multiple.*owners|one.*owner/i);
});

test("all hash-bound case evidence references reject out-of-tree symlinks", (context) => {
  if (process.platform === "win32") context.skip("symlink permissions are platform-specific");
  const targets = [
    "source-inventory.json",
    "receipts/discovery.json",
    "evidence/account.json",
    "receipts/youtube.json",
    "evidence/youtube-listing.json",
    "evidence/video-1.json"
  ];
  const statuses = targets.map((relativeTarget) => {
    const root = completeCase();
    const target = path.join(root, relativeTarget);
    const outside = path.join(tmpdir(), `${path.basename(root)}-${path.basename(relativeTarget)}-outside.json`);
    renameSync(target, outside);
    symlinkSync(outside, target);
    return runVerifier(root).status;
  });
  assert.deepEqual(statuses, targets.map(() => 2));
});

test("a displayed denominator mismatch remains a valid partial result but exits 6", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  const enumeration = manifest.source_families[0].enumeration;
  enumeration.status = "partial";
  enumeration.denominator_basis = "observed_displayed_total";
  enumeration.displayed_total = 20;
  delete enumeration.expected_count;
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 6, result.stderr);
  const receipt = resultPayload(result);
  assert.equal(receipt.valid, true);
  assert.equal(receipt.computed_coverage_status, "partial");
  assert.match(receipt.completion_reasons.join(" "), /displayed total/i);
});

test("recovered media with an audio stream requires speech completion even when omitted by the collector", () => {
  const root = completeCase();
  const ledgerPath = path.join(root, "ledgers", "youtube.jsonl");
  const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
  row.required_modalities = ["creator_text", "visual"];
  row.media = { recovered: true, audio_stream: true, sha256: "a".repeat(64) };
  row.modalities.speech = "unresolved";
  writeJsonl(ledgerPath, [row]);
  const result = runVerifier(root);
  assert.equal(result.status, 6, result.stderr);
  assert.match(resultPayload(result).completion_reasons.join(" "), /audio stream.*speech/i);
});

test("a video cannot close without determining whether it has an audio stream", () => {
  const root = completeCase();
  const ledgerPath = path.join(root, "ledgers", "youtube.jsonl");
  const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
  row.required_modalities = ["creator_text", "visual"];
  delete row.modalities.speech;
  delete row.speech_review;
  delete row.media;
  writeJsonl(ledgerPath, [row]);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /video.*audio|audio.*probe|speech.*determin/i);
});

test("an unknown media item type cannot bypass intrinsic modality requirements", () => {
  const root = completeCase();
  const ledgerPath = path.join(root, "ledgers", "youtube.jsonl");
  const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
  row.item_type = "short_video";
  row.required_modalities = ["creator_text"];
  row.modalities = { creator_text: "complete" };
  delete row.media;
  delete row.visual_review;
  delete row.speech_review;
  writeJsonl(ledgerPath, [row]);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /unknown.*item_type|item_type.*allowlist|media_kind/i);
});

test("visual media cannot close by declaring its required visual modality absent", () => {
  const root = completeCase();
  const ledgerPath = path.join(root, "ledgers", "youtube.jsonl");
  const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
  row.modalities.visual = "not_present";
  row.modality_absence = {
    visual: {
      method: "collector_assertion",
      evidence: row.evidence
    }
  };
  writeJsonl(ledgerPath, [row]);
  const result = runVerifier(root);
  assert.equal(result.status, 6, result.stderr);
  assert.match(resultPayload(result).completion_reasons.join(" "), /video.*visual.*complete/i);
});

test("completed video modalities require full-duration hash-bound reviews", () => {
  const root = completeCase();
  const ledgerPath = path.join(root, "ledgers", "youtube.jsonl");
  const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
  delete row.visual_review;
  writeJsonl(ledgerPath, [row]);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /completed visual modality requires visual_review/i);
});

test("required modality absence needs its own hash-bound evidence", () => {
  const root = completeCase();
  const ledgerPath = path.join(root, "ledgers", "youtube.jsonl");
  const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
  row.modalities.creator_text = "not_present";
  writeJsonl(ledgerPath, [row]);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /absence evidence.*creator_text/i);
});

test("maximum public coverage cannot hide an included partial family as non-material", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  const originalFamily = manifest.source_families[0];
  const secondLedgerPath = path.join(root, "ledgers", "x.jsonl");
  writeJsonl(secondLedgerPath, []);
  const secondFamily = JSON.parse(JSON.stringify(originalFamily));
  secondFamily.id = "x";
  secondFamily.platform = "x";
  secondFamily.material = false;
  secondFamily.ledger_paths = ["ledgers/x.jsonl"];
  secondFamily.enumeration.status = "partial";
  secondFamily.enumeration.denominator_basis = "unknown";
  secondFamily.enumeration.expected_count = 0;
  secondFamily.enumeration.enumerated_count = 0;
  manifest.source_families.push(secondFamily);

  const inventoryPath = path.join(root, manifest.source_inventory.path);
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  inventory.sources.push({
    ...inventory.sources[0],
    id: "x-account",
    source_family_id: "x",
    platform: "x"
  });
  writeJson(inventoryPath, inventory);
  manifest.source_inventory.sha256 = sha256(inventoryPath);
  writeJson(casePath, manifest);

  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /maximum public coverage.*included.*material/i);
});

test("an undeclared supplement in the ledger directory blocks completion", () => {
  const root = completeCase();
  const original = JSON.parse(readFileSync(path.join(root, "ledgers", "youtube.jsonl"), "utf8").trim());
  writeJsonl(path.join(root, "ledgers", "youtube-supplement.jsonl"), [
    { ...original, item_id: "video-2", canonical_url: "https://example.test/video-2" }
  ]);
  const result = runVerifier(root);
  assert.equal(result.status, 6, result.stderr);
  assert.match(resultPayload(result).completion_reasons.join(" "), /unregistered ledger/i);
});

test("one ledger cannot be registered to more than one family", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  manifest.source_families.push({ ...manifest.source_families[0], id: "youtube-copy", material: false });
  const inventoryPath = path.join(root, manifest.source_inventory.path);
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  inventory.sources.push({ ...inventory.sources[0], id: "youtube-copy-account", source_family_id: "youtube-copy" });
  writeJson(inventoryPath, inventory);
  manifest.source_inventory.sha256 = sha256(inventoryPath);
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /ledger.*more than one source family/i);
});

test("duplicate and derivative rows must link to a retained item", () => {
  const root = completeCase();
  const ledgerPath = path.join(root, "ledgers", "youtube.jsonl");
  const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
  row.final_state = "duplicate";
  row.linked_item_id = "missing-video";
  writeJsonl(ledgerPath, [row]);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /not retained/i);
});

test("a duplicate or derivative cannot link to itself", () => {
  const root = completeCase();
  const ledgerPath = path.join(root, "ledgers", "youtube.jsonl");
  const row = JSON.parse(readFileSync(ledgerPath, "utf8").trim());
  row.final_state = "duplicate";
  row.linked_item_id = row.item_id;
  writeJsonl(ledgerPath, [row]);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /self|distinct retained item|cannot link to itself/i);
});

test("a registered reply supplement with partial parent context blocks completion", () => {
  const root = completeCase();
  const original = JSON.parse(readFileSync(path.join(root, "ledgers", "youtube.jsonl"), "utf8").trim());
  const supplementPath = path.join(root, "ledgers", "youtube-supplement.jsonl");
  writeJsonl(supplementPath, [{
    ...original,
    item_id: "reply-2",
    canonical_url: "https://example.test/reply-2",
    item_type: "reply",
    context: { reply_parent: "partial" }
  }]);
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  manifest.source_families[0].ledger_paths.push("ledgers/youtube-supplement.jsonl");
  manifest.source_families[0].enumeration.expected_count = 2;
  manifest.source_families[0].enumeration.enumerated_count = 2;
  const adapterReference = manifest.source_families[0].enumeration.adapters[0].receipt;
  const adapterPath = path.join(root, adapterReference.path);
  const adapterReceipt = JSON.parse(readFileSync(adapterPath, "utf8"));
  adapterReceipt.returned_count = 2;
  adapterReceipt.unique_id_count = 2;
  const capturePath = path.join(root, adapterReceipt.captures[0].path);
  writeJson(capturePath, { ids: ["video-1", "reply-2"] });
  adapterReceipt.captures[0].sha256 = sha256(capturePath);
  writeJson(adapterPath, adapterReceipt);
  adapterReference.sha256 = sha256(adapterPath);
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 6, result.stderr);
  assert.match(resultPayload(result).completion_reasons.join(" "), /reply parent context/i);
});

test("maximum coverage requires an explicit target scope", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  delete manifest.source_families[0].enumeration.target;
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /target/i);
});

test("a maximum-coverage date target fails when query intervals leave a gap", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  const enumeration = manifest.source_families[0].enumeration;
  enumeration.target = { kind: "date_interval", start: "2022-01-01", end: "2026-09-03" };
  enumeration.denominator_basis = "date_bucket_exhaustion";
  enumeration.query_intervals = [
    { start: "2022-01-01", end: "2024-01-01", status: "exhausted" },
    { start: "2024-02-01", end: "2026-09-03", status: "exhausted" }
  ];
  delete enumeration.expected_count;
  const adapterReference = enumeration.adapters[0].receipt;
  const adapterPath = path.join(root, adapterReference.path);
  const adapterReceipt = JSON.parse(readFileSync(adapterPath, "utf8"));
  adapterReceipt.scope = {
    kind: "date_interval",
    start: "2022-01-01",
    end: "2026-09-03",
    account_url: "https://example.test/account"
  };
  writeJson(adapterPath, adapterReceipt);
  adapterReference.sha256 = sha256(adapterPath);
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 6, result.stderr);
  assert.match(resultPayload(result).completion_reasons.join(" "), /unqueried interval gap/i);
});

test("adapter receipts are schema-validated and hash-bound", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  const receiptReference = manifest.source_families[0].enumeration.adapters[0].receipt;
  const receiptPath = path.join(root, receiptReference.path);
  writeJson(receiptPath, { ok: true });
  receiptReference.sha256 = sha256(receiptPath);
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /adapter_id|adapter_version|receipt/i);
});

test("adapter capture hashes must resolve to real files and the family target", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  const receiptReference = manifest.source_families[0].enumeration.adapters[0].receipt;
  const receiptPath = path.join(root, receiptReference.path);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.scope.kind = "date_interval";
  receipt.captures[0].path = "evidence/missing.json";
  writeJson(receiptPath, receipt);
  receiptReference.sha256 = sha256(receiptPath);
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /scope.*target|capture.*missing/i);
});

test("a denominator adapter receipt must name the included account it enumerates", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  const receiptReference = manifest.source_families[0].enumeration.adapters[0].receipt;
  const receiptPath = path.join(root, receiptReference.path);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.scope.account_url = "https://wrong.example/account";
  writeJson(receiptPath, receipt);
  receiptReference.sha256 = sha256(receiptPath);
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /account.*scope|scope.*account|included account/i);
});

test("a denominator capture must reconcile its stable IDs to the retained family rows", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  const receiptReference = manifest.source_families[0].enumeration.adapters[0].receipt;
  const receiptPath = path.join(root, receiptReference.path);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  const capturePath = path.join(root, receipt.captures[0].path);
  writeJson(capturePath, { ids: ["unrelated-video"] });
  receipt.captures[0].sha256 = sha256(capturePath);
  writeJson(receiptPath, receipt);
  receiptReference.sha256 = sha256(receiptPath);
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /capture.*ids|stable ids|retained.*rows|reconcile/i);
});

test("an invented denominator basis is rejected", () => {
  const root = completeCase();
  const casePath = path.join(root, "case.json");
  const manifest = JSON.parse(readFileSync(casePath, "utf8"));
  manifest.source_families[0].enumeration.denominator_basis = "trust_me_complete";
  writeJson(casePath, manifest);
  const result = runVerifier(root);
  assert.equal(result.status, 2, result.stderr);
  assert.match(resultPayload(result).error, /denominator_basis/i);
});
