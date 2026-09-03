import { validateResearchBrief } from "../website/lib/research-brief.mjs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "./canonical-json.mjs";

const PLATFORM_RULES = [
  { platform: "github", hosts: new Set(["github.com", "www.github.com"]), adapter_ids: ["github_public_api"] },
  { platform: "youtube", hosts: new Set(["youtube.com", "www.youtube.com", "youtu.be"]), adapter_ids: ["yt_dlp", "jina_reader"] },
  { platform: "instagram", hosts: new Set(["instagram.com", "www.instagram.com"]), adapter_ids: ["agent_reach_instagram", "jina_reader"] },
  { platform: "x", hosts: new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]), adapter_ids: ["agent_reach_x", "jina_reader"] },
  { platform: "linkedin", hosts: new Set(["linkedin.com", "www.linkedin.com"]), adapter_ids: ["agent_reach_linkedin", "jina_reader"] },
  { platform: "tiktok", hosts: new Set(["tiktok.com", "www.tiktok.com"]), adapter_ids: ["yt_dlp", "jina_reader"] },
  { platform: "facebook", hosts: new Set(["facebook.com", "www.facebook.com"]), adapter_ids: ["agent_reach_facebook", "jina_reader"] }
];

function targetFor(anchor) {
  const url = new URL(anchor);
  const match = PLATFORM_RULES.find((rule) => rule.hosts.has(url.hostname.toLowerCase()));
  const platform = match?.platform ?? "web";
  return {
    id: `${platform}-${crypto.randomUUID()}`,
    platform,
    canonical_url: url.href,
    adapter_ids: match?.adapter_ids ?? ["jina_reader"],
    terminal_states: ["collected", "partial", "unavailable", "failed"]
  };
}

export function planResearch(brief) {
  const errors = validateResearchBrief(brief);
  if (errors.length) throw new TypeError(errors.join("; "));
  return {
    schema_version: 1,
    created_at: new Date().toISOString(),
    subject: brief.subject,
    research_mode: brief.research_mode,
    depth: brief.depth,
    cost_policy: brief.cost_policy,
    purpose: brief.purpose,
    modules: brief.modules,
    custom_instructions: brief.custom_instructions,
    targets: brief.subject.identity_anchors.map(targetFor)
  };
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function receiptName(targetIndex, adapterId) {
  return `${String(targetIndex + 1).padStart(2, "0")}-${adapterId.replace(/[^a-z0-9_-]/gi, "-")}.json`;
}

async function writeReceipt(outputDirectory, targetIndex, adapterId, payload) {
  const relativePath = path.join("receipts", receiptName(targetIndex, adapterId));
  const absolutePath = path.join(outputDirectory, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
  const receipt = { ...payload, sha256: digest(payload) };
  await writeFile(absolutePath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { receipt, relativePath };
}

function attemptClosesCoverage(attempt) {
  return attempt.status === "collected" && attempt.coverage_complete === true;
}

export function assessRunStatus(brief, targets) {
  const evidenceTargets = targets.filter((target) => ["collected", "partial"].includes(target.status)).length;
  if (evidenceTargets === 0) return { status: "failed", research_mode_satisfied: false };
  const everyTargetCollected = targets.length > 0 && targets.every((target) => target.status === "collected");
  if (brief.research_mode === "insight") {
    return { status: everyTargetCollected ? "completed" : "partial", research_mode_satisfied: everyTargetCollected };
  }
  const everyTargetClosed = everyTargetCollected && targets.every((target) => target.attempts.some(attemptClosesCoverage));
  return { status: everyTargetClosed ? "completed" : "partial", research_mode_satisfied: everyTargetClosed };
}

export async function runResearch(brief, options = {}) {
  const outputDirectory = path.resolve(options.outputDirectory ?? `public-profile-run-${Date.now()}`);
  const adapters = options.adapters ?? {};
  const plan = planResearch(brief);
  options.signal?.throwIfAborted();
  await mkdir(path.dirname(outputDirectory), { recursive: true, mode: 0o700 });
  try {
    await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new TypeError(`Output directory already exists: ${outputDirectory}`);
    throw error;
  }
  const targets = [];

  for (const [targetIndex, target] of plan.targets.entries()) {
    options.signal?.throwIfAborted();
    const attempts = [];
    let targetStatus = "unavailable";
    for (const adapterId of target.adapter_ids) {
      options.signal?.throwIfAborted();
      const startedAt = new Date().toISOString();
      const adapter = adapters[adapterId];
      let result;
      if (!adapter || typeof adapter.collect !== "function") {
        result = { status: "unavailable", message: `Adapter ${adapterId} is not available in this environment` };
      } else {
        try {
          result = await adapter.collect(target, { brief, plan, signal: options.signal });
        } catch (error) {
          result = { status: "failed", message: error instanceof Error ? error.message : String(error) };
        }
      }
      const payload = {
        schema_version: 1,
        adapter_id: adapterId,
        target: { platform: target.platform, canonical_url: target.canonical_url },
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        ...result
      };
      const { receipt, relativePath } = await writeReceipt(outputDirectory, targetIndex, adapterId, payload);
      attempts.push({
        adapter_id: adapterId,
        status: receipt.status,
        message: receipt.message ?? "",
        receipt_path: relativePath,
        receipt_sha256: receipt.sha256,
        coverage_complete: receipt.coverage_complete === true
      });
      if (receipt.status === "collected") {
        targetStatus = "collected";
        if (brief.depth === "quick") break;
      } else if (receipt.status === "partial" && targetStatus !== "collected") {
        targetStatus = "partial";
      } else if (receipt.status === "failed" && targetStatus === "unavailable") {
        targetStatus = "failed";
      }
    }
    targets.push({ ...target, status: targetStatus, attempts });
  }

  const assessment = assessRunStatus(brief, targets);
  const run = {
    schema_version: 1,
    run_id: crypto.randomUUID(),
    generated_at: new Date().toISOString(),
    status: assessment.status,
    research_mode_satisfied: assessment.research_mode_satisfied,
    research_brief: brief,
    plan,
    targets
  };
  await writeFile(path.join(outputDirectory, "research-run.json"), `${JSON.stringify(run, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return run;
}
