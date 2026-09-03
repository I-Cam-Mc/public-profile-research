import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { loadReceipts, writeReportBundle } from "../report/build-report.mjs";
import { assessClosure } from "./closure.mjs";
import { canonicalJson } from "./canonical-json.mjs";
import { resolveIdentity } from "./identity-resolution.mjs";
import { assertPublicTargetUrl } from "./public-target.mjs";
import { assessRunStatus, runResearch } from "./research-runner.mjs";
import { createSafeDefaultAdapters } from "./safe-adapters.mjs";
import { normaliseSourceItems } from "./source-items.mjs";

const systemExecFile = promisify(execFile);
const DISCOVERY_FOLLOW_UP_BUDGET = Object.freeze({ quick: 2, standard: 5, deep: 10, maximum: 20 });
const DISCOVERY_QUERY_POLICY = Object.freeze({
  quick: Object.freeze({ queryBudget: 1, perQueryResultLimit: 10 }),
  standard: Object.freeze({ queryBudget: 5, perQueryResultLimit: 6 }),
  deep: Object.freeze({ queryBudget: 9, perQueryResultLimit: 6 }),
  maximum: Object.freeze({ queryBudget: 14, perQueryResultLimit: 6 })
});

const DISCOVERY_MODULE_FOCUS = Object.freeze({
  identity: "profile biography about",
  current_activity: "latest update announcement",
  timeline: "biography timeline interview",
  career: "career work role",
  projects: "projects portfolio work",
  companies: "company team role",
  public_impression: "interview podcast talk",
  public_persona: "interview podcast talk",
  credibility: "claims evidence profile",
  controversies: "controversy criticism response",
  professional_network: "team collaborator conference",
  media: "interview podcast video",
  code: "software repository projects",
  commercial_activity: "business sponsorship partner"
});

const DISCOVERY_SITE_MODULES = Object.freeze([
  ["linkedin.com/in", new Set(["identity", "current_activity", "career", "companies", "professional_network"])],
  ["github.com", new Set(["identity", "current_activity", "projects", "code"])],
  ["youtube.com", new Set(["identity", "current_activity", "timeline", "public_impression", "public_persona", "media"])],
  ["instagram.com", new Set(["identity", "current_activity", "timeline", "public_impression", "public_persona", "media", "commercial_activity"])],
  ["x.com", new Set(["identity", "current_activity", "timeline", "public_impression", "public_persona", "credibility", "controversies", "professional_network", "commercial_activity"])],
  ["tiktok.com", new Set(["identity", "current_activity", "public_impression", "public_persona", "media", "commercial_activity"])]
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9_-]/gi, "-");
}

async function validateTargets(brief, lookup) {
  await Promise.all(
    brief.subject.identity_anchors.map((url) => assertPublicTargetUrl(url, { lookup }))
  );
}

function discoveryIdentityTerms(brief) {
  const displayName = String(brief.subject.display_name ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N} .,'’_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  if (!displayName) throw new TypeError("A public display name is required for discovery");
  const terms = [JSON.stringify(displayName)];
  for (const anchor of brief.subject.identity_anchors) {
    const parts = new URL(anchor).pathname.split("/").filter(Boolean);
    let candidate = parts.at(-1)?.replace(/^@/, "");
    try {
      candidate = decodeURIComponent(candidate ?? "");
    } catch {
      candidate = "";
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(candidate)) candidate = "";
    if (candidate && !terms.includes(candidate)) terms.push(candidate);
  }
  return terms;
}

export function buildDiscoveryQueries(brief) {
  const policy = DISCOVERY_QUERY_POLICY[brief.depth] ?? DISCOVERY_QUERY_POLICY.quick;
  const identityTerms = discoveryIdentityTerms(brief);
  const exactName = identityTerms[0];
  const handleTerms = identityTerms.slice(1);
  const baseQuery = identityTerms.join(" ");
  if (policy.queryBudget === 1) {
    return [{ strategy: "identity_compact", query: baseQuery, max_results: policy.perQueryResultLimit }];
  }

  const requestedModules = new Set(brief.modules ?? []);
  const candidates = [{ strategy: "identity_compact", query: baseQuery }];
  const moduleCandidates = [];
  const seenFocuses = new Set();
  for (const module of brief.modules ?? []) {
    const focus = DISCOVERY_MODULE_FOCUS[module];
    if (!focus || seenFocuses.has(focus)) continue;
    seenFocuses.add(focus);
    moduleCandidates.push({ strategy: `module_${module}`, query: `${baseQuery} ${focus}` });
  }

  const siteCandidates = [];
  for (const [site, relevantModules] of DISCOVERY_SITE_MODULES) {
    if (![...requestedModules].some((module) => relevantModules.has(module))) continue;
    siteCandidates.push({ strategy: `site_${site.replace(/[^a-z0-9]+/gi, "_")}`, query: `${baseQuery} site:${site}` });
  }
  candidates.push(...moduleCandidates.slice(0, 2), ...siteCandidates.slice(0, 3));
  candidates.push(...moduleCandidates.slice(2), ...siteCandidates.slice(3));

  const broadThemes = [
    ["biography_context", "profile biography about"],
    ["spoken_appearances", "interview podcast conference talk"],
    ["work_context", "projects portfolio company role"],
    ["written_appearances", "articles publications guest"],
    ["recent_context", "latest update announcement"],
    ["collaboration_context", "team collaborator community"],
    ["reputation_context", "claims criticism response"]
  ];
  for (const [strategy, terms] of broadThemes) {
    candidates.push({ strategy, query: `${baseQuery} ${terms}` });
  }
  for (const handle of handleTerms) {
    candidates.push({ strategy: "handle_exact", query: `${exactName} "${handle}"` });
  }
  for (const [site] of DISCOVERY_SITE_MODULES) {
    candidates.push({ strategy: `site_${site.replace(/[^a-z0-9]+/gi, "_")}`, query: `${baseQuery} site:${site}` });
  }

  const seenQueries = new Set();
  return candidates.filter(({ query }) => {
    if (seenQueries.has(query)) return false;
    seenQueries.add(query);
    return true;
  }).slice(0, policy.queryBudget).map((candidate) => ({
    ...candidate,
    max_results: policy.perQueryResultLimit
  }));
}

function capDiscoveryResults(value, limit) {
  const capArray = (array) => ({ value: array.slice(0, limit), count: Math.min(array.length, limit), truncated: array.length > limit });
  if (Array.isArray(value)) return capArray(value);
  if (value && typeof value === "object") {
    if (Array.isArray(value.results)) {
      const capped = capArray(value.results);
      return { ...capped, value: { ...value, results: capped.value } };
    }
    if (Array.isArray(value.data?.results)) {
      const capped = capArray(value.data.results);
      return { ...capped, value: { ...value, data: { ...value.data, results: capped.value } } };
    }
    return { value, count: 0, truncated: false };
  }
  if (typeof value !== "string") return { value, count: 0, truncated: false };
  const text = value.trim();
  if (!text) return { value, count: 0, truncated: false };
  if (/^[{[]/.test(text)) {
    try {
      const capped = capDiscoveryResults(JSON.parse(text), limit);
      return { ...capped, value: JSON.stringify(capped.value) };
    } catch {
      // Fall through to the labelled-text format understood by source normalisation.
    }
  }
  const blocks = text
    .split(/\n\s*-{3,}\s*\n/g)
    .flatMap((block) => block.split(/\n(?=Title:\s*)/g))
    .map((block) => block.trim())
    .filter(Boolean);
  if (!blocks.some((block) => /^Title:\s*/im.test(block) && /^URL:\s*https?:\/\//im.test(block))) {
    return { value, count: 0, truncated: false };
  }
  return {
    value: blocks.slice(0, limit).join("\n\n---\n\n"),
    count: Math.min(blocks.length, limit),
    truncated: blocks.length > limit
  };
}

function capDiscoveryResult(result, limit) {
  if (!result || !Object.hasOwn(result, "data") || !Object.hasOwn(result.data ?? {}, "results")) return result;
  const capped = capDiscoveryResults(result.data.results, limit);
  return {
    ...result,
    discovery_result_limit: limit,
    discovery_result_count: capped.count,
    discovery_results_truncated: capped.truncated,
    data: { ...result.data, results: capped.value }
  };
}

async function appendDiscoveryAttempt(run, brief, adapter, outputDirectory, signal, queryPlan, queryIndex, queryCount) {
  const target = {
    id: `web-search-${crypto.randomUUID()}`,
    platform: "web_search",
    canonical_url: brief.subject.identity_anchors[0],
    query: queryPlan.query,
    query_strategy: queryPlan.strategy,
    query_index: queryIndex + 1,
    query_count: queryCount,
    max_results: queryPlan.max_results,
    source_role: "optional_discovery",
    optional_discovery: true,
    material: false,
    required: false,
    adapter_ids: ["agent_reach_exa"],
    terminal_states: ["collected", "partial", "unavailable", "failed"]
  };
  const startedAt = new Date().toISOString();
  let result;
  if (!adapter || typeof adapter.collect !== "function") {
    result = { status: "unavailable", barrier: "tool_missing", message: "Adapter agent_reach_exa is not available in this environment" };
  } else {
    try {
      result = await adapter.collect(target, { brief, plan: run.plan, signal });
    } catch (error) {
      result = { status: "failed", barrier: "adapter_error", message: error instanceof Error ? error.message : String(error) };
    }
  }
  result = capDiscoveryResult(result, queryPlan.max_results);
  const payload = {
    schema_version: 1,
    adapter_id: "agent_reach_exa",
    target: {
      platform: target.platform,
      canonical_url: target.canonical_url,
      query: target.query,
      query_strategy: target.query_strategy,
      query_index: target.query_index,
      query_count: target.query_count,
      max_results: target.max_results
    },
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    ...result
  };
  const receipt = { ...payload, sha256: createHash("sha256").update(canonicalJson(payload)).digest("hex") };
  const receiptPath = path.posix.join("receipts", `${String((run.targets?.length ?? 0) + 1).padStart(2, "0")}-agent_reach_exa.json`);
  const absoluteReceiptPath = path.join(outputDirectory, ...receiptPath.split("/"));
  await mkdir(path.dirname(absoluteReceiptPath), { recursive: true, mode: 0o700 });
  await writeFile(absoluteReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const completedTarget = {
    ...target,
    status: receipt.status,
    attempts: [{
      adapter_id: "agent_reach_exa",
      status: receipt.status,
      message: receipt.message ?? "",
      receipt_path: receiptPath,
      receipt_sha256: receipt.sha256,
      coverage_complete: receipt.coverage_complete === true
    }]
  };
  run.plan.targets.push(target);
  run.targets.push(completedTarget);
  const assessment = assessRunStatus(brief, run.targets);
  run.status = assessment.status;
  run.research_mode_satisfied = assessment.research_mode_satisfied;
  return { target: completedTarget, attempt: completedTarget.attempts[0], receipt };
}

function canonicalCandidateUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(lower)) {
        url.searchParams.delete(key);
      }
    }
    return url.href;
  } catch {
    return null;
  }
}

function candidateUrlsFromDiscoveries(discoveries, brief) {
  const supplied = new Set(brief.subject.identity_anchors.map(canonicalCandidateUrl).filter(Boolean));
  const seen = new Set();
  const urls = [];
  let candidateOccurrences = 0;
  for (const discovery of discoveries ?? []) {
    if (!discovery?.receipt) continue;
    const items = normaliseSourceItems({
      target: discovery.target,
      attempt: discovery.attempt,
      receipt: discovery.receipt,
      providedAnchors: brief.subject.identity_anchors
    });
    for (const item of items) {
      if (item.subject_relation !== "candidate") continue;
      const canonicalUrl = canonicalCandidateUrl(item.canonical_url);
      if (!canonicalUrl || supplied.has(canonicalUrl)) continue;
      candidateOccurrences += 1;
      if (seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      urls.push(canonicalUrl);
    }
  }
  return {
    urls,
    candidateOccurrences,
    duplicatesRemoved: candidateOccurrences - urls.length
  };
}

async function appendDiscoveryFollowUps(run, brief, discoveries, adapter, outputDirectory, options = {}) {
  const budget = DISCOVERY_FOLLOW_UP_BUDGET[brief.depth] ?? DISCOVERY_FOLLOW_UP_BUDGET.quick;
  const candidates = candidateUrlsFromDiscoveries(discoveries, brief);
  const completed = [];
  for (const [candidateIndex, canonicalUrl] of candidates.urls.entries()) {
    options.signal?.throwIfAborted();
    const target = {
      id: `web-lead-${crypto.randomUUID()}`,
      platform: "web_lead",
      canonical_url: canonicalUrl,
      adapter_ids: ["jina_reader"],
      terminal_states: ["collected", "partial", "unavailable", "failed"],
      source_role: "optional_discovery",
      optional_discovery: true,
      subject_relation: "candidate",
      required: false,
      material: false
    };
    if (candidateIndex >= budget) {
      const completedTarget = {
        ...target,
        status: "not_attempted",
        barrier: "follow_up_budget_reached",
        message: `Not attempted because the ${brief.depth} follow-up budget is ${budget} candidate pages`,
        attempts: []
      };
      run.plan.targets.push(target);
      run.targets.push(completedTarget);
      completed.push({ target: completedTarget, attempt: null, receipt: null });
      continue;
    }
    try {
      await assertPublicTargetUrl(canonicalUrl, { lookup: options.lookup });
    } catch (error) {
      const completedTarget = {
        ...target,
        status: "not_attempted",
        barrier: "public_target_rejected",
        message: error instanceof Error ? error.message : String(error),
        attempts: []
      };
      run.plan.targets.push(target);
      run.targets.push(completedTarget);
      completed.push({ target: completedTarget, attempt: null, receipt: null });
      continue;
    }
    const startedAt = new Date().toISOString();
    let result;
    if (!adapter || typeof adapter.collect !== "function") {
      result = { status: "unavailable", barrier: "tool_missing", message: "Adapter jina_reader is not available in this environment" };
    } else {
      try {
        result = await adapter.collect(target, { brief, plan: run.plan, signal: options.signal });
      } catch (error) {
        result = { status: "failed", barrier: "adapter_error", message: error instanceof Error ? error.message : String(error) };
      }
    }
    const payload = {
      schema_version: 1,
      adapter_id: "jina_reader",
      target: { platform: target.platform, canonical_url: target.canonical_url },
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      ...result
    };
    const receipt = { ...payload, sha256: sha256(canonicalJson(payload)) };
    const targetIndex = run.targets.length;
    const receiptPath = path.posix.join("receipts", `${String(targetIndex + 1).padStart(2, "0")}-jina_reader.json`);
    const absoluteReceiptPath = path.join(outputDirectory, ...receiptPath.split("/"));
    await mkdir(path.dirname(absoluteReceiptPath), { recursive: true, mode: 0o700 });
    await writeFile(absoluteReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const attempt = {
      adapter_id: "jina_reader",
      status: receipt.status,
      message: receipt.message ?? "",
      receipt_path: receiptPath,
      receipt_sha256: receipt.sha256,
      coverage_complete: receipt.coverage_complete === true
    };
    const completedTarget = { ...target, status: receipt.status, attempts: [attempt] };
    run.plan.targets.push(target);
    run.targets.push(completedTarget);
    completed.push({ target: completedTarget, attempt, receipt });
  }
  return {
    completed,
    candidateOccurrences: candidates.candidateOccurrences,
    uniqueCandidateUrls: candidates.urls.length,
    duplicatesRemoved: candidates.duplicatesRemoved,
    followedCandidatePages: completed.filter(({ attempt }) => attempt !== null).length,
    notAttemptedCandidatePages: completed.filter(({ target }) => target.status === "not_attempted").length
  };
}

async function writeEvidenceArchive(run, receipts, outputDirectory) {
  const items = [];
  const sourceItems = [];
  const seenSourceItems = new Set();
  let deduplicatedObservations = 0;
  for (const [targetIndex, target] of (run.targets ?? []).entries()) {
    for (const attempt of target.attempts ?? []) {
      const receipt = receipts[attempt.receipt_path];
      const item = {
        target_index: targetIndex,
        platform: target.platform,
        target_url: target.canonical_url,
        adapter_id: attempt.adapter_id,
        status: attempt.status,
        barrier: receipt?.barrier ?? null,
        message: attempt.message || receipt?.message || "",
        coverage: receipt?.coverage ?? null,
        source_urls: Array.isArray(receipt?.source_urls) ? receipt.source_urls : [],
        receipt_path: attempt.receipt_path,
        receipt_sha256: attempt.receipt_sha256,
        evidence_path: null,
        evidence_sha256: null
      };

      if (["collected", "partial"].includes(attempt.status) && Object.hasOwn(receipt ?? {}, "data")) {
        const relativePath = path.posix.join(
          "evidence",
          `${String(targetIndex + 1).padStart(2, "0")}-${safeName(attempt.adapter_id)}.json`
        );
        const evidence = {
          schema_version: 1,
          run_id: run.run_id,
          target: { platform: target.platform, canonical_url: target.canonical_url },
          adapter_id: attempt.adapter_id,
          observed_at: receipt.ended_at,
          coverage: receipt.coverage ?? null,
          source_urls: item.source_urls,
          receipt: { path: attempt.receipt_path, sha256: attempt.receipt_sha256 },
          data: receipt.data
        };
        const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
        const absolutePath = path.join(outputDirectory, ...relativePath.split("/"));
        await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
        await writeFile(absolutePath, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
        item.evidence_path = relativePath;
        item.evidence_sha256 = sha256(bytes);
      }

      const normalised = normaliseSourceItems({
        target,
        attempt,
        receipt,
        providedAnchors: run.research_brief?.subject?.identity_anchors ?? []
      });
      for (const sourceItem of normalised) {
        const canonicalDiscoveryUrl = sourceItem.item_type === "web_discovery_lead"
          ? canonicalCandidateUrl(sourceItem.canonical_url)
          : null;
        const deduplicationKey = canonicalDiscoveryUrl
          ? `web_discovery_lead:${canonicalDiscoveryUrl}`
          : sourceItem.item_id;
        if (seenSourceItems.has(deduplicationKey)) {
          deduplicatedObservations += 1;
          continue;
        }
        seenSourceItems.add(deduplicationKey);
        const archiveName = sourceItem.evidence_id.replace(/^evidence:/, "");
        const archivePath = path.posix.join("evidence", "items", `${archiveName}.json`);
        const archiveBytes = `${JSON.stringify(sourceItem, null, 2)}\n`;
        const absoluteArchivePath = path.join(outputDirectory, ...archivePath.split("/"));
        await mkdir(path.dirname(absoluteArchivePath), { recursive: true, mode: 0o700 });
        await writeFile(absoluteArchivePath, archiveBytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
        sourceItems.push({
          ...sourceItem,
          archive_path: archivePath,
          archive_sha256: sha256(archiveBytes)
        });
      }
      items.push(item);
    }
  }

  const ledger = {
    schema_version: 1,
    run_id: run.run_id,
    generated_at: run.generated_at,
    statement: "This ledger records every adapter attempt and every normalised public-source item. An absent evidence file means the adapter did not return subject material.",
    deduplicated_observations: deduplicatedObservations,
    items,
    source_items: sourceItems
  };
  const ledgerBytes = `${JSON.stringify(ledger, null, 2)}\n`;
  await writeFile(path.join(outputDirectory, "evidence-ledger.json"), ledgerBytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { ...ledger, ledger_sha256: sha256(ledgerBytes) };
}

function linkedIdentityAnchors(text, anchors) {
  const anchorSet = new Set(anchors.map((value) => new URL(value).href));
  const links = [];
  for (const match of String(text ?? "").matchAll(/https:\/\/[^\s<>"']+/gi)) {
    const candidate = match[0].replace(/[),.;!?]+$/, "");
    try {
      const normalised = new URL(candidate).href;
      if (anchorSet.has(normalised)) links.push(normalised);
    } catch {
      // Ignore malformed text fragments. Identity confirmation remains closed.
    }
  }
  return [...new Set(links)];
}

function identityObservations(run, sourceItems) {
  const anchors = run.research_brief.subject.identity_anchors;
  const itemsByReceipt = new Map();
  for (const item of sourceItems) {
    const group = itemsByReceipt.get(item.provenance?.receipt_path) ?? [];
    group.push(item);
    itemsByReceipt.set(item.provenance?.receipt_path, group);
  }
  const observations = [];
  for (const target of run.targets ?? []) {
    const optionalDiscovery = target.optional_discovery === true || target.source_role === "optional_discovery" || target.material === false;
    for (const attempt of target.attempts ?? []) {
      const items = itemsByReceipt.get(attempt.receipt_path) ?? [];
      if (optionalDiscovery) {
        for (const item of items) {
          observations.push({
            url: item.canonical_url,
            status: "collected",
            adapter_id: attempt.adapter_id,
            discovery_only: true,
            source_kind: item.item_type === "web_discovery_lead" ? "search_result" : item.item_type,
            evidence_ids: [item.evidence_id],
            links_to: []
          });
        }
        continue;
      }
      if (!items.length) continue;
      observations.push({
        url: target.canonical_url,
        status: "collected",
        adapter_id: attempt.adapter_id,
        first_party: true,
        source_identity_status: run.research_brief.subject.identity_status,
        evidence_ids: items.map((item) => item.evidence_id),
        links_to: linkedIdentityAnchors(items.map((item) => item.text).join("\n"), anchors)
      });
    }
  }
  return observations;
}

function closureInputs(run, ledger, receipts) {
  const countsByReceipt = new Map();
  for (const item of ledger.source_items) {
    const key = item.provenance?.receipt_path;
    countsByReceipt.set(key, (countsByReceipt.get(key) ?? 0) + 1);
  }
  const targets = (run.targets ?? []).map((target) => {
    const evidenceCount = (target.attempts ?? []).reduce((total, attempt) => total + (countsByReceipt.get(attempt.receipt_path) ?? 0), 0);
    const lastAttempt = target.attempts?.at(-1);
    const receipt = lastAttempt ? receipts[lastAttempt.receipt_path] : null;
    const optionalDiscovery = target.optional_discovery === true || target.source_role === "optional_discovery" || target.platform === "web_search";
    return {
      ...target,
      material: optionalDiscovery ? false : target.material,
      source_role: optionalDiscovery ? "optional_discovery" : (target.source_role ?? "supplied_material"),
      useful_material: evidenceCount > 0,
      evidence_count: evidenceCount,
      barrier: receipt?.barrier ?? target.barrier ?? null
    };
  });
  const sourceFamilies = targets.map((target) => ({
    id: target.id,
    platform: target.platform,
    account_url: target.canonical_url,
    material: target.material !== false,
    optional_discovery: target.source_role === "optional_discovery",
    source_role: target.source_role,
    coverage_complete: (target.attempts ?? []).some((attempt) => attempt.status === "collected" && attempt.coverage_complete === true),
    ...(target.enumeration ? { enumeration: target.enumeration } : {})
  }));
  return { targets, sourceFamilies };
}

function completionSummary(run) {
  const isDiscoveryQuery = (target) => target.platform === "web_search";
  const isDiscoveryCandidate = (target) => target.platform === "web_lead";
  const isOptionalDiscovery = (target) => target.optional_discovery === true
    || target.source_role === "optional_discovery"
    || isDiscoveryQuery(target)
    || isDiscoveryCandidate(target);
  const suppliedTargets = (run.targets ?? []).filter((target) => !isOptionalDiscovery(target));
  const discoveryQueries = (run.targets ?? []).filter(isDiscoveryQuery);
  const discoveryTargets = (run.targets ?? []).filter(isDiscoveryCandidate);
  const countStatuses = (targets) => targets.reduce((counts, target) => {
    if (Object.hasOwn(counts, target.status)) counts[target.status] += 1;
    return counts;
  }, { collected: 0, partial: 0, unavailable: 0, failed: 0, not_attempted: 0 });
  const counts = countStatuses(suppliedTargets);
  const discoveryCounts = countStatuses(discoveryTargets);
  return {
    declared_targets: suppliedTargets.length,
    collected_targets: counts.collected,
    partial_targets: counts.partial,
    unavailable_targets: counts.unavailable,
    failed_targets: counts.failed,
    discovery_queries: discoveryQueries.length,
    discovery_targets: discoveryTargets.length,
    collected_discovery_targets: discoveryCounts.collected,
    partial_discovery_targets: discoveryCounts.partial,
    unavailable_discovery_targets: discoveryCounts.unavailable,
    failed_discovery_targets: discoveryCounts.failed,
    not_attempted_discovery_targets: discoveryCounts.not_attempted,
    all_declared_targets_collected: counts.collected === suppliedTargets.length && counts.collected > 0,
    research_mode_satisfied: run.research_mode_satisfied === true,
    identity_status: run.identity?.status ?? "unconfirmed",
    identity_confirmed: run.closure?.identity?.satisfied === true
  };
}

export async function runResearchProduct(brief, options = {}) {
  const outputDirectory = path.resolve(options.outputDirectory ?? `public-profile-run-${Date.now()}`);
  await validateTargets(brief, options.lookup);
  const adapters = options.adapters ?? createSafeDefaultAdapters({
    fetchImpl: options.fetchImpl,
    execFileImpl: options.execFileImpl ?? systemExecFile,
    lookup: options.lookup,
    environment: options.environment
  });
  options.signal?.throwIfAborted();
  const run = await runResearch(brief, { outputDirectory, adapters, signal: options.signal });
  if (options.discovery !== false) {
    const queryPlans = buildDiscoveryQueries(brief);
    const discoveries = [];
    for (const [queryIndex, queryPlan] of queryPlans.entries()) {
      options.signal?.throwIfAborted();
      discoveries.push(await appendDiscoveryAttempt(
        run,
        brief,
        adapters.agent_reach_exa,
        outputDirectory,
        options.signal,
        queryPlan,
        queryIndex,
        queryPlans.length
      ));
    }
    const followUps = await appendDiscoveryFollowUps(run, brief, discoveries, adapters.jina_reader, outputDirectory, {
      signal: options.signal,
      lookup: options.lookup
    });
    const policy = DISCOVERY_QUERY_POLICY[brief.depth] ?? DISCOVERY_QUERY_POLICY.quick;
    run.discovery = {
      depth: brief.depth,
      query_budget: policy.queryBudget,
      planned_queries: queryPlans.length,
      attempted_queries: discoveries.length,
      per_query_result_limit: policy.perQueryResultLimit,
      maximum_result_occurrences: queryPlans.reduce((total, query) => total + query.max_results, 0),
      candidate_occurrences: followUps.candidateOccurrences,
      unique_candidate_urls: followUps.uniqueCandidateUrls,
      duplicates_removed: followUps.duplicatesRemoved,
      follow_up_page_budget: DISCOVERY_FOLLOW_UP_BUDGET[brief.depth] ?? DISCOVERY_FOLLOW_UP_BUDGET.quick,
      followed_candidate_pages: followUps.followedCandidatePages,
      not_attempted_candidate_pages: followUps.notAttemptedCandidatePages
    };
  }
  const receipts = await loadReceipts(run, outputDirectory);
  const ledger = await writeEvidenceArchive(run, receipts, outputDirectory);

  run.identity = resolveIdentity({
    subject: brief.subject,
    observations: identityObservations(run, ledger.source_items)
  });
  const { targets: closureTargets, sourceFamilies } = closureInputs(run, ledger, receipts);
  const completionRecords = options.completionRecords ?? [];
  run.source_families = sourceFamilies;
  run.module_completion_records = completionRecords;
  run.closure = assessClosure({
    researchMode: brief.research_mode,
    targets: closureTargets,
    sourceFamilies,
    identity: run.identity,
    requestedModules: brief.modules,
    sourceItems: ledger.source_items,
    observedAt: run.generated_at,
    completionRecords,
    customInstructions: brief.custom_instructions
  });
  run.status = run.closure.run_status;
  run.research_mode_satisfied = run.closure.research_mode_satisfied;

  run.completion = completionSummary(run);
  run.evidence_inventory = ledger.items;
  run.source_item_inventory = {
    total_items: ledger.source_items.length,
    established_items: run.identity.status === "confirmed"
      ? ledger.source_items.filter((item) => item.subject_relation === "provided_anchor" && item.content_quality !== "unusable").length
      : 0,
    supplied_unconfirmed_items: run.identity.status === "confirmed"
      ? 0
      : ledger.source_items.filter((item) => item.subject_relation === "provided_anchor" && item.content_quality !== "unusable").length,
    candidate_items: ledger.source_items.filter((item) => item.subject_relation === "candidate").length
  };
  run.runtime = {
    engine: "public-profile-research-local-runner",
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch
  };
  run.collection_policy = {
    public_https_targets_only: true,
    read_only_network_requests: true,
    redirect_targets_revalidated: true,
    credentials_in_urls_forbidden: true,
    missing_sources_remain_visible: true
  };
  const reportBundle = await writeReportBundle(run, receipts, outputDirectory, ledger.source_items);
  run.artifacts = {
    run_metadata_path: "research-run.json",
    receipts_directory: "receipts",
    evidence_directory: "evidence",
    evidence_ledger_path: "evidence-ledger.json",
    evidence_ledger_sha256: ledger.ledger_sha256,
    report_model_path: "report/report.json",
    report_model_sha256: reportBundle.model_sha256,
    html_report_path: "report/index.html",
    html_report_sha256: reportBundle.html_sha256
  };
  await writeFile(path.join(outputDirectory, "research-run.json"), `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return run;
}

export async function readSavedResearchRun(outputDirectory) {
  return JSON.parse(await readFile(path.resolve(outputDirectory, "research-run.json"), "utf8"));
}
