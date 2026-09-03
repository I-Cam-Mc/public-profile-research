#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXIT_INVALID = 2;
export const EXIT_INCOMPLETE = 6;

const MODES = new Set(["insight", "bounded_census", "maximum_public_coverage"]);
const FAMILY_STATUSES = ["unavailable", "lead_only", "partial", "high_coverage", "closed"];
const FINAL_STATES = new Set(["processed", "duplicate", "derivative", "inaccessible", "unresolved"]);
const MODALITY_STATES = new Set(["complete", "not_present", "audio_checked_no_speech", "inaccessible", "unresolved"]);
const ITEM_TYPES = new Set([
  "article",
  "audio",
  "carousel",
  "image",
  "link",
  "live_stream",
  "reply",
  "text",
  "video"
]);
const TARGET_KINDS = new Set(["lifetime", "date_interval", "current_public_surface", "bounded_listing"]);
const DENOMINATOR_BASES = new Set([
  "complete_first_party_export",
  "complete_api_listing",
  "displayed_total_reconciled",
  "terminal_pagination",
  "date_bucket_exhaustion",
  "no_denominator_marginal_yield",
  "observed_displayed_total",
  "unknown"
]);
const BARRIERS = new Set([
  "authentication_required",
  "rate_limited",
  "platform_virtualisation",
  "pagination_unavailable",
  "media_download_disabled",
  "removed_or_invalid",
  "region_or_eligibility_restricted",
  "paid_api_declined",
  "tool_missing",
  "transient_tool_failure"
]);
const DISPOSITIONS = new Set(["included", "out_of_scope", "rejected_identity", "inaccessible"]);
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message, exitCode = EXIT_INVALID, details = {}) {
  const error = new Error(message);
  error.exitCode = exitCode;
  error.details = details;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is required`);
  return value;
}

function requireStringArray(value, label, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && !value.length) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    fail(`${label} must be ${nonEmpty ? "a non-empty " : "an "}array of strings`);
  }
  if (new Set(value).size !== value.length) fail(`${label} contains duplicates`);
  return value;
}

function isIsoDateTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && /T/.test(value);
}

function requireIsoDateTime(value, label) {
  if (!isIsoDateTime(value)) fail(`${label} must be an ISO date-time`);
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (token !== "--case") fail(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value) fail("--case requires a path");
    args.casePath = path.resolve(value);
    index += 1;
  }
  if (!args.casePath) fail("--case is required");
  return args;
}

function readJson(filePath, label = filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Cannot read ${label}: ${error.message}`);
  }
}

function readJsonl(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    fail(`Cannot read ledger ${filePath}: ${error.message}`);
  }
  return source.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
    }
  });
}

function resolveInside(root, candidate, label) {
  requireString(candidate, `${label}.path`);
  if (path.isAbsolute(candidate)) fail(`${label}.path must be relative to the case directory`);
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`${label}.path escapes the case directory`);
  return resolved;
}

function verifyReference(root, reference, label, { parseJson = false } = {}) {
  if (!isObject(reference)) fail(`${label} must contain path and sha256`);
  const filePath = resolveInside(root, reference.path, label);
  if (!SHA256.test(reference.sha256 ?? "")) fail(`${label}.sha256 must be a lowercase SHA-256`);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`${label} is missing: ${reference.path}`);
  if (fs.lstatSync(filePath).isSymbolicLink()) fail(`${label} must not be a symbolic link: ${reference.path}`);
  const relativeRealPath = path.relative(fs.realpathSync(root), fs.realpathSync(filePath));
  if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
    fail(`${label} resolves outside the case directory: ${reference.path}`);
  }
  const actual = sha256(filePath);
  if (actual !== reference.sha256) fail(`${label} hash mismatch: ${reference.path}`);
  return parseJson ? { path: filePath, value: readJson(filePath, label) } : { path: filePath };
}

function verifyEvidence(root, evidence, label) {
  if (!Array.isArray(evidence) || !evidence.length) fail(`${label} requires at least one evidence reference`);
  evidence.forEach((reference, index) => verifyReference(root, reference, `${label}.evidence[${index}]`));
}

function listJsonlFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJsonlFiles(candidate));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.resolve(candidate));
  }
  return files.sort();
}

function validateDiscoveryReceipt(receipt, expectedClasses, label) {
  if (receipt.schema_version !== 1) fail(`${label} has an unsupported schema_version`);
  requireString(receipt.method, `${label}.method`);
  requireIsoDateTime(receipt.started_at, `${label}.started_at`);
  requireIsoDateTime(receipt.ended_at, `${label}.ended_at`);
  if (Date.parse(receipt.started_at) > Date.parse(receipt.ended_at)) fail(`${label} ends before it starts`);
  const checked = requireStringArray(receipt.source_classes_checked, `${label}.source_classes_checked`);
  requireString(receipt.terminal_reason, `${label}.terminal_reason`);
  for (const sourceClass of expectedClasses) {
    if (!checked.includes(sourceClass)) fail(`${label} did not check expected source class ${sourceClass}`);
  }
}

function validateSourceInventory(root, manifest) {
  const expectedClasses = requireStringArray(
    manifest.scope?.expected_source_classes,
    "scope.expected_source_classes"
  );
  const { value: inventory } = verifyReference(root, manifest.source_inventory, "source_inventory", { parseJson: true });
  if (inventory.schema_version !== 1) fail("source inventory has an unsupported schema_version");
  requireIsoDateTime(inventory.observed_at, "source inventory observed_at");
  if (!Array.isArray(inventory.discovery_receipts) || !inventory.discovery_receipts.length) {
    fail("source inventory requires discovery_receipts");
  }
  inventory.discovery_receipts.forEach((reference, index) => {
    const { value } = verifyReference(root, reference, `source inventory discovery_receipts[${index}]`, { parseJson: true });
    validateDiscoveryReceipt(value, expectedClasses, `discovery receipt ${index}`);
  });
  if (!Array.isArray(inventory.sources) || !inventory.sources.length) fail("source inventory requires sources");
  const sourceIds = new Set();
  const representedClasses = new Set();
  const familyOwners = new Map();
  for (const source of inventory.sources) {
    const sourceId = requireString(source.id, "source inventory source id");
    if (sourceIds.has(sourceId)) fail(`source inventory repeats source id ${sourceId}`);
    sourceIds.add(sourceId);
    const sourceClass = requireString(source.source_class, `${sourceId}.source_class`);
    representedClasses.add(sourceClass);
    requireString(source.platform, `${sourceId}.platform`);
    if (!DISPOSITIONS.has(source.disposition)) fail(`${sourceId} has invalid disposition ${source.disposition}`);
    verifyEvidence(root, source.evidence, `source inventory ${sourceId}`);
    if (source.disposition === "included") {
      requireString(source.account_url, `${sourceId}.account_url`);
      try {
        const url = new URL(source.account_url);
        if (url.protocol !== "https:") fail(`${sourceId}.account_url must use HTTPS`);
      } catch {
        fail(`${sourceId}.account_url must be a valid HTTPS URL`);
      }
      const familyId = requireString(source.source_family_id, `${sourceId}.source_family_id`);
      if (!familyOwners.has(familyId)) familyOwners.set(familyId, []);
      familyOwners.get(familyId).push({
        id: sourceId,
        account_url: source.account_url,
        platform: source.platform,
        source_class: sourceClass
      });
    } else {
      requireString(source.reason, `${sourceId}.reason`);
    }
  }
  for (const sourceClass of expectedClasses) {
    if (!representedClasses.has(sourceClass)) fail(`${sourceClass} is missing from the source inventory`);
  }
  for (const [familyId, owners] of familyOwners) {
    if (owners.length !== 1) {
      fail(`${familyId} must have exactly one included account owner; found ${owners.length}`);
    }
  }
  return familyOwners;
}

function validateIntervalCoverage(familyId, enumeration, incomplete) {
  const target = enumeration.target;
  if (target.kind !== "date_interval") return;
  if (!ISO_DATE.test(target.start ?? "") || !ISO_DATE.test(target.end ?? "") || target.start >= target.end) {
    fail(`${familyId} has an invalid date-interval target`);
  }
  const intervals = [...(enumeration.query_intervals ?? [])].sort((left, right) =>
    String(left.start).localeCompare(String(right.start))
  );
  if (!intervals.length) {
    incomplete.push(`${familyId} has no query intervals for its date target`);
    return;
  }
  let cursor = target.start;
  for (const interval of intervals) {
    if (!ISO_DATE.test(interval.start ?? "") || !ISO_DATE.test(interval.end ?? "") || interval.start >= interval.end) {
      fail(`${familyId} has an invalid query interval`);
    }
    if (interval.status !== "exhausted") {
      incomplete.push(`${familyId} query interval ${interval.start}..${interval.end} is not exhausted`);
    }
    if (interval.end <= cursor) continue;
    if (interval.start > cursor) {
      incomplete.push(`${familyId} has an unqueried interval gap ${cursor}..${interval.start}`);
    }
    cursor = interval.end;
    if (cursor >= target.end) break;
  }
  if (cursor < target.end) incomplete.push(`${familyId} has an unqueried interval gap ${cursor}..${target.end}`);
}

function validateAdapterReceipt(root, familyId, adapter, target, rows, ownerSources) {
  requireString(adapter.id, `${familyId} adapter id`);
  if (!new Set(["denominator", "supplement"]).has(adapter.coverage_role)) {
    fail(`${familyId} adapter ${adapter.id} must declare coverage_role denominator or supplement`);
  }
  if (!new Set(["exhausted", "inapplicable"]).has(adapter.status)) {
    fail(`${familyId} adapter ${adapter.id} has invalid status ${adapter.status}`);
  }
  requireIsoDateTime(adapter.attempted_at, `${familyId} adapter ${adapter.id} attempted_at`);
  const { value: receipt } = verifyReference(root, adapter.receipt, `${familyId} adapter ${adapter.id} receipt`, { parseJson: true });
  if (receipt.schema_version !== 2) fail(`${familyId} adapter ${adapter.id} receipt has an unsupported schema_version`);
  if (receipt.adapter_id !== adapter.id) fail(`${familyId} adapter ${adapter.id} receipt adapter_id does not match`);
  requireString(receipt.adapter_version, `${familyId} adapter ${adapter.id} receipt adapter_version`);
  requireIsoDateTime(receipt.started_at, `${familyId} adapter ${adapter.id} receipt started_at`);
  requireIsoDateTime(receipt.ended_at, `${familyId} adapter ${adapter.id} receipt ended_at`);
  if (Date.parse(receipt.started_at) > Date.parse(receipt.ended_at)) fail(`${familyId} adapter ${adapter.id} receipt ends before it starts`);
  if (!isObject(receipt.scope) || !Object.keys(receipt.scope).length) fail(`${familyId} adapter ${adapter.id} receipt scope is required`);
  if (isObject(target) && receipt.scope.kind !== target.kind) {
    fail(`${familyId} adapter ${adapter.id} receipt scope does not match the family target`);
  }
  if (target?.kind === "date_interval" && (receipt.scope.start !== target.start || receipt.scope.end !== target.end)) {
    fail(`${familyId} adapter ${adapter.id} receipt date scope does not match the family target`);
  }
  const includedAccountUrls = new Set(ownerSources.map((source) => source.account_url));
  if (!includedAccountUrls.has(receipt.scope.account_url)) {
    fail(`${familyId} adapter ${adapter.id} account scope does not match an included account`);
  }
  for (const field of ["returned_count", "unique_id_count"]) {
    if (!Number.isInteger(receipt[field]) || receipt[field] < 0) fail(`${familyId} adapter ${adapter.id} receipt ${field} is invalid`);
  }
  if (receipt.unique_id_count > receipt.returned_count) fail(`${familyId} adapter ${adapter.id} has more unique IDs than returned rows`);
  requireString(receipt.terminal_reason, `${familyId} adapter ${adapter.id} receipt terminal_reason`);
  if (typeof receipt.credential_present !== "boolean") fail(`${familyId} adapter ${adapter.id} receipt credential_present must be boolean`);
  if (!Array.isArray(receipt.captures) || !receipt.captures.length) {
    fail(`${familyId} adapter ${adapter.id} receipt captures must contain hash-bound file references`);
  }
  const capturedIds = new Set();
  receipt.captures.forEach((reference, index) => {
    const { value: capture } = verifyReference(
      root,
      reference,
      `${familyId} adapter ${adapter.id} capture ${index}`,
      { parseJson: true }
    );
    const ids = capture.item_ids ?? capture.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim())) {
      fail(`${familyId} adapter ${adapter.id} capture ${index} must contain stable item IDs`);
    }
    for (const id of ids) capturedIds.add(id);
  });
  if (capturedIds.size !== receipt.unique_id_count) {
    fail(`${familyId} adapter ${adapter.id} capture IDs do not reconcile to unique_id_count`);
  }
  const rowIds = new Set(rows.map((row) => row.item_id));
  if (adapter.coverage_role === "denominator" && adapter.status === "exhausted" && receipt.unique_id_count !== rows.length) {
    fail(`${familyId} denominator adapter ${adapter.id} unique_id_count does not match retained ledger rows`);
  }
  if (
    adapter.coverage_role === "denominator" &&
    adapter.status === "exhausted" &&
    (capturedIds.size !== rowIds.size || [...capturedIds].some((id) => !rowIds.has(id)))
  ) {
    fail(`${familyId} denominator adapter ${adapter.id} capture stable IDs do not reconcile to retained rows`);
  }
  if (adapter.status === "inapplicable" && !BARRIERS.has(receipt.barrier)) {
    fail(`${familyId} adapter ${adapter.id} inapplicable receipt needs a classified barrier`);
  }
  return receipt;
}

function validateRow(root, familyId, row, incomplete) {
  const itemId = requireString(row.item_id, `${familyId} row item_id`);
  requireString(row.canonical_url, `${familyId}:${itemId} canonical_url`);
  try {
    const url = new URL(row.canonical_url);
    if (url.protocol !== "https:") fail(`${familyId}:${itemId} canonical_url must use HTTPS`);
  } catch {
    fail(`${familyId}:${itemId} canonical_url must be a valid HTTPS URL`);
  }
  requireString(row.item_type, `${familyId}:${itemId} item_type`);
  if (!ITEM_TYPES.has(row.item_type)) {
    fail(`${familyId}:${itemId} has unknown item_type ${row.item_type}; use the item_type allowlist`);
  }
  requireIsoDateTime(row.published_at, `${familyId}:${itemId} published_at`);
  requireIsoDateTime(row.observed_at, `${familyId}:${itemId} observed_at`);
  if (!FINAL_STATES.has(row.final_state)) fail(`${familyId}:${itemId} has invalid final_state ${row.final_state}`);
  const requiredModalities = requireStringArray(row.required_modalities, `${familyId}:${itemId} required_modalities`);
  if (!isObject(row.modalities)) fail(`${familyId}:${itemId} modalities must be an object`);
  for (const [modality, state] of Object.entries(row.modalities)) {
    if (!MODALITY_STATES.has(state)) fail(`${familyId}:${itemId} has invalid ${modality} modality state ${state}`);
  }
  verifyEvidence(root, row.evidence, `${familyId}:${itemId}`);

  if (row.final_state === "processed") {
    for (const modality of requiredModalities) {
      if (!new Set(["complete", "not_present", "audio_checked_no_speech"]).has(row.modalities[modality])) {
        incomplete.push(`${familyId}:${itemId} has incomplete required modality ${modality}`);
      }
      if (row.modalities[modality] === "not_present") {
        const absence = row.modality_absence?.[modality];
        if (!isObject(absence)) fail(`${familyId}:${itemId} absence evidence is required for ${modality}`);
        requireString(absence.method, `${familyId}:${itemId} ${modality} absence method`);
        verifyEvidence(root, absence.evidence, `${familyId}:${itemId} ${modality} absence`);
      }
    }
  } else if (row.final_state === "duplicate" || row.final_state === "derivative") {
    requireString(row.linked_item_id, `${familyId}:${itemId} linked_item_id`);
  } else if (row.final_state === "inaccessible") {
    if (!BARRIERS.has(row.access?.barrier)) fail(`${familyId}:${itemId} inaccessible row needs a classified barrier`);
    if (row.access?.fallbacks_exhausted !== true || !Array.isArray(row.access?.attempt_receipts) || !row.access.attempt_receipts.length) {
      fail(`${familyId}:${itemId} inaccessible row needs exhausted fallback receipts`);
    }
    row.access.attempt_receipts.forEach((reference, index) =>
      verifyReference(root, reference, `${familyId}:${itemId} access attempt ${index}`)
    );
    incomplete.push(`${familyId}:${itemId} remains inaccessible`);
  } else {
    requireString(row.unresolved_reason, `${familyId}:${itemId} unresolved_reason`);
    incomplete.push(`${familyId}:${itemId} remains unresolved`);
  }

  if (row.media !== undefined) {
    if (!isObject(row.media)) fail(`${familyId}:${itemId} media must be an object`);
    if (row.media.recovered === true && !SHA256.test(row.media.sha256 ?? "")) {
      fail(`${familyId}:${itemId} recovered media requires sha256`);
    }
    if (
      row.media.recovered === true &&
      row.media.audio_stream === true &&
      !new Set(["complete", "audio_checked_no_speech"]).has(row.modalities.speech)
    ) {
      incomplete.push(`${familyId}:${itemId} has an audio stream but speech is not complete`);
    }
  }
  if (["video", "live_stream"].includes(row.item_type) && !requiredModalities.includes("visual")) {
    fail(`${familyId}:${itemId} video requires the visual modality`);
  }
  if (
    ["video", "live_stream"].includes(row.item_type) &&
    !requiredModalities.includes("speech") &&
    row.media?.audio_stream !== true
  ) {
    fail(`${familyId}:${itemId} video audio or speech determination is missing`);
  }
  if (
    ["video", "live_stream"].includes(row.item_type) &&
    !requiredModalities.includes("speech") &&
    row.media?.audio_stream === true
  ) {
    incomplete.push(`${familyId}:${itemId} has an audio stream but speech is not declared as a required modality`);
  }
  if (["video", "live_stream"].includes(row.item_type) && row.modalities.visual !== "complete") {
    incomplete.push(`${familyId}:${itemId} video visual modality must be complete`);
  }
  if (["image", "carousel"].includes(row.item_type) && !requiredModalities.includes("visual")) {
    fail(`${familyId}:${itemId} image content requires the visual modality`);
  }
  if (["image", "carousel"].includes(row.item_type) && row.modalities.visual !== "complete") {
    incomplete.push(`${familyId}:${itemId} image visual modality must be complete`);
  }
  if (row.item_type === "audio" && !requiredModalities.includes("speech")) {
    fail(`${familyId}:${itemId} audio content requires the speech modality`);
  }
  if (
    row.item_type === "audio" &&
    !new Set(["complete", "audio_checked_no_speech"]).has(row.modalities.speech)
  ) {
    incomplete.push(`${familyId}:${itemId} audio speech modality must be complete or audio-checked with no speech`);
  }
  if (row.item_type === "reply" && row.context?.reply_parent !== "complete") {
    incomplete.push(`${familyId}:${itemId} reply parent context is not complete`);
  }
  if (row.final_state === "processed" && requiredModalities.includes("visual") && row.modalities.visual === "complete") {
    if (!isObject(row.visual_review)) fail(`${familyId}:${itemId} completed visual modality requires visual_review`);
    requireString(row.visual_review.method, `${familyId}:${itemId} visual_review.method`);
    requireString(row.visual_review.coverage, `${familyId}:${itemId} visual_review.coverage`);
    verifyEvidence(root, row.visual_review.evidence, `${familyId}:${itemId} visual_review`);
    const requiredCoverage = ["video", "live_stream"].includes(row.item_type)
      ? "full_duration"
      : row.item_type === "carousel"
        ? "all_assets"
        : "full_resolution";
    if (row.visual_review.coverage !== requiredCoverage) {
      incomplete.push(`${familyId}:${itemId} visual review coverage is ${row.visual_review.coverage}, not ${requiredCoverage}`);
    }
  }
  if (
    row.final_state === "processed" &&
    requiredModalities.includes("speech") &&
    new Set(["complete", "audio_checked_no_speech"]).has(row.modalities.speech)
  ) {
    if (!isObject(row.speech_review)) fail(`${familyId}:${itemId} completed speech modality requires speech_review`);
    requireString(row.speech_review.method, `${familyId}:${itemId} speech_review.method`);
    if (row.speech_review.coverage !== "full_duration") {
      incomplete.push(`${familyId}:${itemId} speech review coverage is not full_duration`);
    }
    verifyEvidence(root, row.speech_review.evidence, `${familyId}:${itemId} speech_review`);
  }
  return itemId;
}

function validateFamily(root, family, mode, ownerSources) {
  const incomplete = [];
  const familyId = requireString(family.id, "source family id");
  requireString(family.platform, `${familyId}.platform`);
  if (typeof family.material !== "boolean") fail(`${familyId}.material must be boolean`);
  if (mode === "maximum_public_coverage" && family.material !== true) {
    fail(`maximum public coverage included family ${familyId} must be material; move a genuinely excluded source to an out_of_scope inventory disposition`);
  }
  if (!Array.isArray(family.ledger_paths) || !family.ledger_paths.length) fail(`${familyId} requires ledger_paths`);
  const rows = family.ledger_paths.flatMap((relativePath, index) => {
    const ledgerPath = resolveInside(root, relativePath, `${familyId}.ledger_paths[${index}]`);
    return readJsonl(ledgerPath);
  });
  const seen = new Set();
  for (const row of rows) {
    const itemId = validateRow(root, familyId, row, incomplete);
    if (seen.has(itemId)) fail(`${familyId} repeats item_id ${itemId}`);
    seen.add(itemId);
  }
  for (const row of rows) {
    if (["duplicate", "derivative"].includes(row.final_state)) {
      if (row.linked_item_id === row.item_id) {
        fail(`${familyId}:${row.item_id} cannot link to itself as a duplicate or derivative`);
      }
      if (!seen.has(row.linked_item_id)) {
        fail(`${familyId}:${row.item_id} links to an item that is not retained in the family ledger`);
      }
      const linked = rows.find((candidate) => candidate.item_id === row.linked_item_id);
      if (linked?.final_state !== "processed") {
        fail(`${familyId}:${row.item_id} must link to a processed retained item, not ${linked?.final_state ?? "missing"}`);
      }
    }
  }

  const enumeration = family.enumeration;
  if (!isObject(enumeration)) fail(`${familyId}.enumeration is required`);
  if (!FAMILY_STATUSES.includes(enumeration.status)) fail(`${familyId} has invalid enumeration status ${enumeration.status}`);
  if (mode === "maximum_public_coverage" && (!isObject(enumeration.target) || !TARGET_KINDS.has(enumeration.target.kind))) {
    fail(`${familyId} maximum coverage requires an explicit target`);
  }
  if (enumeration.target && !TARGET_KINDS.has(enumeration.target.kind)) fail(`${familyId} has invalid target kind`);
  if (!DENOMINATOR_BASES.has(enumeration.denominator_basis)) fail(`${familyId} has invalid denominator_basis`);
  if (!Number.isInteger(enumeration.enumerated_count) || enumeration.enumerated_count < 0) {
    fail(`${familyId}.enumerated_count must be a non-negative integer`);
  }
  if (enumeration.enumerated_count !== rows.length) incomplete.push(`${familyId} enumerated_count does not match ledger rows`);
  if (Number.isInteger(enumeration.expected_count) && enumeration.expected_count !== rows.length) {
    incomplete.push(`${familyId} expected_count does not match ledger rows`);
  }
  if (enumeration.denominator_basis === "observed_displayed_total") {
    if (!Number.isInteger(enumeration.displayed_total) || enumeration.displayed_total < 0) fail(`${familyId} displayed_total is invalid`);
    if (enumeration.displayed_total !== rows.length) {
      incomplete.push(`${familyId} displayed total ${enumeration.displayed_total} does not match ${rows.length} retained rows`);
    }
    if (enumeration.status === "closed") incomplete.push(`${familyId} cannot close from an observed displayed total alone`);
  }
  if (enumeration.denominator_basis === "displayed_total_reconciled") {
    if (!Number.isInteger(enumeration.displayed_total) || enumeration.displayed_total !== rows.length) {
      incomplete.push(`${familyId} displayed total is not reconciled to retained rows`);
    }
  }
  if (
    ["complete_first_party_export", "complete_api_listing"].includes(enumeration.denominator_basis) &&
    !Number.isInteger(enumeration.expected_count)
  ) {
    fail(`${familyId} ${enumeration.denominator_basis} requires expected_count`);
  }
  if (enumeration.denominator_basis === "no_denominator_marginal_yield") {
    const passes = enumeration.no_growth_passes;
    if (!Array.isArray(passes) || passes.length < 2 || passes.some((pass) => pass.unique_new_ids !== 0 || !isIsoDateTime(pass.observed_at))) {
      incomplete.push(`${familyId} lacks two evidenced no-growth passes`);
    }
  }
  if (["observed_displayed_total", "unknown"].includes(enumeration.denominator_basis) && enumeration.status === "closed") {
    incomplete.push(`${familyId} denominator basis cannot support closed status`);
  }
  validateIntervalCoverage(familyId, enumeration, incomplete);

  const approved = requireStringArray(enumeration.approved_adapter_ids, `${familyId}.approved_adapter_ids`);
  if (!Array.isArray(enumeration.adapters)) fail(`${familyId}.adapters must be an array`);
  const adapterIds = enumeration.adapters.map((adapter) => adapter.id);
  if (new Set(adapterIds).size !== adapterIds.length) fail(`${familyId} repeats an adapter id`);
  for (const adapterId of approved) {
    if (!adapterIds.includes(adapterId)) incomplete.push(`${familyId} approved adapter ${adapterId} has no attempt receipt`);
  }
  let denominatorAdapters = 0;
  for (const adapter of enumeration.adapters) {
    if (!approved.includes(adapter.id)) fail(`${familyId} adapter ${adapter.id} is not in approved_adapter_ids`);
    validateAdapterReceipt(root, familyId, adapter, enumeration.target, rows, ownerSources);
    if (adapter.coverage_role === "denominator" && adapter.status === "exhausted") denominatorAdapters += 1;
  }
  if (
    enumeration.status === "closed" &&
    !new Set(["observed_displayed_total", "unknown", "no_denominator_marginal_yield"]).has(enumeration.denominator_basis) &&
    denominatorAdapters === 0
  ) {
    incomplete.push(`${familyId} has no exhausted denominator adapter for its closed enumeration`);
  }
  if (enumeration.status === "closed" && enumeration.denominator_basis === "no_denominator_marginal_yield") {
    incomplete.push(`${familyId} cannot close from marginal-yield sampling without a denominator`);
  }

  if (mode === "maximum_public_coverage" && enumeration.status !== "closed") {
    incomplete.push(`${familyId} enumeration is ${enumeration.status}, not closed`);
  }
  let effectiveStatus = enumeration.status;
  if (incomplete.length && FAMILY_STATUSES.indexOf(effectiveStatus) > FAMILY_STATUSES.indexOf("partial")) {
    effectiveStatus = "partial";
  }
  return {
    status: effectiveStatus,
    declared_status: enumeration.status,
    material: family.material,
    enumerated_count: rows.length,
    completion_reasons: incomplete
  };
}

export function verifyCase(casePath) {
  const manifest = readJson(casePath, "case manifest");
  if (manifest.schema_version !== 2) fail("Unsupported schema_version; use evidence contract version 2");
  requireString(manifest.case_id, "case_id");
  if (!MODES.has(manifest.mode)) fail(`Invalid mode ${manifest.mode}`);
  if (!new Set(["draft", "final"]).has(manifest.requested_report_status)) fail("requested_report_status must be draft or final");
  if (!Array.isArray(manifest.source_families) || !manifest.source_families.length) {
    fail("source_families must be a non-empty array");
  }
  const root = path.dirname(casePath);
  const familyOwners = validateSourceInventory(root, manifest);
  const familyIds = new Set();
  for (const family of manifest.source_families) {
    if (familyIds.has(family.id)) fail(`Duplicate source family ${family.id}`);
    familyIds.add(family.id);
    if (!familyOwners.has(family.id)) fail(`${family.id} has no included source inventory owner`);
  }
  for (const ownedFamilyId of familyOwners.keys()) {
    if (!familyIds.has(ownedFamilyId)) fail(`source inventory points to missing source family ${ownedFamilyId}`);
  }

  const declaredLedgers = new Map();
  for (const family of manifest.source_families) {
    for (const [index, ledgerPath] of (family.ledger_paths ?? []).entries()) {
      const absolutePath = resolveInside(root, ledgerPath, `${family.id}.ledger_paths[${index}]`);
      if (declaredLedgers.has(absolutePath)) {
        fail(`ledger ${ledgerPath} belongs to more than one source family`);
      }
      declaredLedgers.set(absolutePath, family.id);
    }
  }

  const sourceFamilies = {};
  const completionReasons = [];
  for (const family of manifest.source_families) {
    const result = validateFamily(root, family, manifest.mode, familyOwners.get(family.id) ?? []);
    sourceFamilies[family.id] = result;
    completionReasons.push(...result.completion_reasons);
  }
  const ledgerDirectory = resolveInside(root, manifest.ledger_directory ?? "ledgers", "ledger_directory");
  const unregistered = listJsonlFiles(ledgerDirectory).filter((filePath) => !declaredLedgers.has(filePath));
  if (unregistered.length) {
    completionReasons.push(
      `Unregistered ledger files exist: ${unregistered.map((filePath) => path.relative(root, filePath)).join(", ")}`
    );
  }

  const materialStatuses = Object.values(sourceFamilies)
    .filter((family) => manifest.mode === "maximum_public_coverage" || family.material)
    .map((family) => family.status);
  if (!materialStatuses.length) fail("At least one source family must be material");
  const computedCoverageStatus = materialStatuses.reduce((weakest, status) =>
    FAMILY_STATUSES.indexOf(status) < FAMILY_STATUSES.indexOf(weakest) ? status : weakest,
  "closed");
  if (
    manifest.requested_report_status === "final" &&
    manifest.mode !== "insight" &&
    computedCoverageStatus !== "closed"
  ) {
    completionReasons.push(`Requested final report is bounded by ${computedCoverageStatus} coverage`);
  }
  const uniqueReasons = [...new Set(completionReasons)];
  return {
    ok: uniqueReasons.length === 0,
    valid: true,
    case_id: manifest.case_id,
    mode: manifest.mode,
    requested_report_status: manifest.requested_report_status,
    computed_coverage_status: computedCoverageStatus,
    source_families: sourceFamilies,
    completion_reasons: uniqueReasons
  };
}

export function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write("Usage: node verify-case.mjs --case <case.json>\n");
      return;
    }
    const result = verifyCase(args.casePath);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = EXIT_INCOMPLETE;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, valid: false, error: error.message, details: error.details ?? {} })}\n`);
    process.exitCode = error.exitCode ?? EXIT_INVALID;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) runCli();
