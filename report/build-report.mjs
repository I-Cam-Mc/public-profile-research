import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { canonicalJson } from "../runner/canonical-json.mjs";
import { synthesiseSourceItems } from "./synthesise.mjs";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safePublicUrl(value) {
  try {
    const url = new URL(String(value));
    return ["https:", "http:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}

function evidenceId(attempt) {
  return `receipt:${attempt.receipt_sha256}`;
}

function safeEvidenceHref(value) {
  const candidate = String(value ?? "");
  if (/^receipts\/[a-z0-9][a-z0-9._/-]*\.json$/i.test(candidate) && !candidate.includes("..")) {
    return `../${candidate}`;
  }
  if (/^evidence\/items\/[a-f0-9]{64}\.json$/.test(candidate)) return `../${candidate}`;
  return "#";
}

function evidenceLookup(run, sourceItems) {
  const lookup = new Map();
  for (const target of run.targets ?? []) {
    for (const attempt of target.attempts ?? []) {
      lookup.set(evidenceId(attempt), {
        evidence_id: evidenceId(attempt),
        path: attempt.receipt_path,
        href: safeEvidenceHref(attempt.receipt_path),
        kind: "collection_receipt"
      });
    }
  }
  for (const item of sourceItems) {
    lookup.set(item.evidence_id, {
      evidence_id: item.evidence_id,
      path: item.archive_path,
      href: safeEvidenceHref(item.archive_path),
      kind: "source_item"
    });
  }
  return lookup;
}

function attachEvidenceReferences(findingItem, lookup) {
  return {
    ...findingItem,
    evidence_refs: (findingItem.evidence_ids ?? []).map((id) => lookup.get(id) ?? {
      evidence_id: id,
      path: null,
      href: "#",
      kind: "unresolved"
    })
  };
}

function receiptDigest(receipt) {
  const { sha256: _storedDigest, ...payload } = receipt;
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function languageCounts(repositories) {
  const counts = new Map();
  for (const repository of repositories) {
    const language = String(repository?.language ?? "").trim();
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function coverageSource(target) {
  const lastAttempt = target.attempts?.at(-1);
  const collectedAttempt = target.attempts?.find((attempt) => attempt.status === "collected");
  const selected = collectedAttempt ?? lastAttempt;
  return {
    platform: target.platform,
    url: target.canonical_url,
    status: target.status,
    adapter: selected?.adapter_id ?? "none",
    message: selected?.message ?? target.message ?? "",
    evidence_id: selected ? evidenceId(selected) : null,
    source_role: target.platform === "web_search"
      ? "discovery_query"
      : (target.optional_discovery === true
        || target.source_role === "optional_discovery"
        || target.platform === "web_lead"
        ? "discovery_lead"
        : "supplied_material")
  };
}

function finding(category, statement, evidence, confidence = "observed") {
  return {
    category,
    statement,
    evidence_ids: [evidence],
    confidence
  };
}

function githubHighlights(target, receipt, evidence) {
  const profile = receipt?.data?.profile ?? {};
  const repositories = Array.isArray(receipt?.data?.repositories) ? receipt.data.repositories : [];
  const publicRepositoryCount = Number.isFinite(profile.public_repos) ? profile.public_repos : repositories.length;
  const findings = [];

  if (profile.bio) findings.push(finding("identity", `Public GitHub biography: ${profile.bio}`, evidence, "public_self_report"));
  if (profile.company) findings.push(finding("career", `GitHub company field: ${profile.company}`, evidence, "public_self_report"));
  findings.push(finding("code", `GitHub exposed ${publicRepositoryCount} public repositories at the observation time.`, evidence));
  if (Number.isFinite(profile.followers)) findings.push(finding("audience", `GitHub showed ${profile.followers} followers at the observation time.`, evidence));

  const latest = [...repositories]
    .filter((repository) => repository?.updated_at)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  if (latest) {
    findings.push(finding("current_activity", `The most recently updated repository in the collected GitHub page was ${latest.name}, updated ${latest.updated_at}.`, evidence));
  }

  return {
    profile_url: target.canonical_url,
    login: profile.login ?? "",
    name: profile.name ?? "",
    bio: profile.bio ?? "",
    company: profile.company ?? "",
    location: profile.location ?? "",
    blog: profile.blog ?? "",
    followers: Number.isFinite(profile.followers) ? profile.followers : null,
    public_repositories: publicRepositoryCount,
    account_created_at: profile.created_at ?? null,
    languages: languageCounts(repositories),
    repositories: repositories.slice(0, 20).map((repository) => ({
      name: repository.name ?? "Untitled repository",
      url: repository.html_url ?? target.canonical_url,
      description: repository.description ?? "",
      language: repository.language ?? "",
      stars: Number.isFinite(repository.stargazers_count) ? repository.stargazers_count : 0,
      forks: Number.isFinite(repository.forks_count) ? repository.forks_count : 0,
      updated_at: repository.updated_at ?? null,
      evidence_id: evidence
    })),
    findings
  };
}

function boundedText(value, limit = 800) {
  const text = Array.isArray(value) ? value.join(" ") : String(value ?? "");
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function discoveryLead(item, evidence) {
  if (!item || typeof item !== "object") return null;
  const rawUrl = item.url ?? item.link ?? item.source_url ?? "";
  const url = safePublicUrl(rawUrl);
  const title = boundedText(item.title ?? item.name ?? rawUrl, 240);
  if (!title && url === "#") return null;
  return {
    title: title || url,
    url,
    published: boundedText(item.published ?? item.publishedDate ?? item.published_at ?? item.date ?? "", 100),
    author: boundedText(item.author ?? item.source ?? "", 160),
    highlight: boundedText(item.highlight ?? item.highlights ?? item.text ?? item.content ?? item.description ?? ""),
    evidence_id: evidence,
    status: "discovery_lead"
  };
}

function parseLabelledDiscoveryBlock(block, evidence) {
  const field = (label) => block.match(new RegExp(`^${label}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
  const highlight = block.match(/^Highlights?:\s*\n?([\s\S]*)$/im)?.[1]?.trim() ?? "";
  return discoveryLead({
    title: field("Title"),
    url: field("URL"),
    published: field("Published"),
    author: field("Author"),
    highlight
  }, evidence);
}

function parseDiscoveryResults(value, evidence) {
  let candidates = [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      return parseDiscoveryResults(JSON.parse(trimmed), evidence);
    } catch {
      candidates = trimmed.split(/\n\s*---\s*\n/g).map((block) => parseLabelledDiscoveryBlock(block, evidence));
    }
  } else if (Array.isArray(value)) {
    candidates = value.map((item) => discoveryLead(item, evidence));
  } else if (value && typeof value === "object") {
    const results = Array.isArray(value.results) ? value.results : [value];
    candidates = results.map((item) => discoveryLead(item, evidence));
  }

  const seen = new Set();
  return candidates.filter((lead) => {
    if (!lead) return false;
    const key = `${lead.url}\n${lead.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 20);
}

export function buildReportModel(run, receipts = {}, sourceItems = []) {
  if (!run?.research_brief?.subject) throw new TypeError("A research run with a subject is required");
  if (!Array.isArray(sourceItems)) throw new TypeError("sourceItems must be an array");
  const sources = (run.targets ?? []).map(coverageSource);
  const materialSources = sources.filter((source) => source.source_role === "supplied_material");
  const discoverySources = sources.filter((source) => source.source_role === "discovery_lead");
  const collectedTargets = materialSources.filter((source) => source.status === "collected").length;
  const partialTargets = materialSources.filter((source) => source.status === "partial").length;
  const unavailableTargets = materialSources.filter((source) => ["unavailable", "failed"].includes(source.status)).length;
  const collectedDiscoveryTargets = discoverySources.filter((source) => source.status === "collected").length;
  const notAttemptedDiscoveryTargets = discoverySources.filter((source) => source.status === "not_attempted").length;
  const findings = [];
  const highlights = {};
  const identity = run.identity ?? {
    status: run.research_brief.subject.identity_status ?? "unconfirmed",
    confirmed_by: null,
    reasons: ["No separate identity-resolution result was supplied"]
  };
  const identityConfirmed = identity.status === "confirmed";
  const synthesis = synthesiseSourceItems(sourceItems, { identityStatus: identity.status });

  for (const target of run.targets ?? []) {
    for (const attempt of target.attempts ?? []) {
      if (attempt.status !== "collected") continue;
      const receipt = receipts[attempt.receipt_path];
      if (!receipt) continue;
      const evidence = evidenceId(attempt);
      if (target.platform === "github" && receipt.data?.profile) {
        highlights.github = githubHighlights(target, receipt, evidence);
        if (identityConfirmed) findings.push(...highlights.github.findings);
      } else if (target.platform === "web_search" && receipt.data?.results) {
        if (!sourceItems.some((item) => item.item_type === "web_discovery_lead")) {
          const leads = parseDiscoveryResults(receipt.data.results, evidence);
          highlights.web_discovery = [...(highlights.web_discovery ?? []), ...leads];
        }
      } else if (identityConfirmed && !sourceItems.some((item) => item.provenance?.receipt_path === attempt.receipt_path)) {
        findings.push(finding(
          target.platform,
          `${target.platform} public material was collected through ${attempt.adapter_id}.`,
          evidence
        ));
      }
    }
  }

  const discoveredItems = sourceItems.filter((item) => item.item_type === "web_discovery_lead");
  if (discoveredItems.length) {
    highlights.web_discovery = discoveredItems.map((item) => ({
      title: boundedText(item.title, 240) || item.canonical_url,
      url: safePublicUrl(item.canonical_url),
      published: boundedText(item.published_at, 100),
      author: "",
      highlight: boundedText(item.text),
      evidence_id: item.evidence_id,
      evidence_href: safeEvidenceHref(item.archive_path),
      status: "discovery_lead"
    }));
  }
  findings.push(...synthesis.findings);
  const lookup = evidenceLookup(run, sourceItems);
  const evidenceRegister = sourceItems.map((item) => ({
    evidence_id: item.evidence_id,
    platform: item.platform,
    item_type: item.item_type,
    title: item.title,
    canonical_url: item.canonical_url,
    published_at: item.published_at,
    observed_at: item.observed_at,
    subject_relation: item.subject_relation,
    archive_path: item.archive_path,
    archive_sha256: item.archive_sha256,
    href: safeEvidenceHref(item.archive_path)
  }));

  const closure = run.closure ?? null;
  const researchGoalSatisfied = closure?.research_mode?.satisfied === true
    || (!closure && run.research_mode_satisfied === true);
  const moduleRequirementsSatisfied = closure?.module_requirements?.satisfied !== false;
  const collectionState = closure?.collection?.status
    ?? (collectedTargets === materialSources.length && materialSources.length ? "complete" : (collectedTargets || partialTargets ? "partial" : "failed"));
  const complete = run.status === "completed" && researchGoalSatisfied && moduleRequirementsSatisfied && identity.status === "confirmed" && collectionState !== "failed";
  const optionalGapCount = closure?.gaps?.optional_discovery?.length ?? 0;
  const coverageStatement = complete
    ? `The selected ${run.research_brief.research_mode} goal was satisfied from the supplied material. ${collectedTargets} of ${materialSources.length} supplied collection targets returned collected material${optionalGapCount ? `; ${optionalGapCount} optional discovery ${optionalGapCount === 1 ? "gap remains" : "gaps remain"}` : ""}. This is not a claim that every public source or historical item was found.`
    : researchGoalSatisfied
      ? moduleRequirementsSatisfied
        ? `The ${run.research_brief.research_mode} collection goal was satisfied, but the overall run remains partial because identity is ${identity.status}. ${collectedTargets} of ${materialSources.length} supplied collection targets yielded collected material; all remaining gaps stay visible below.`
        : `The ${run.research_brief.research_mode} collection goal was satisfied, but requested analysis remains open because one or more requested modules or custom instructions are incomplete. ${collectedTargets} of ${materialSources.length} supplied collection targets yielded collected material; all remaining gaps stay visible below.`
      : `This is a partial run and the selected ${run.research_brief.research_mode} goal remains open. ${collectedTargets} of ${materialSources.length} supplied collection targets yielded collected material; unavailable and unresolved sources remain visible below.`;

  return {
    schema_version: 1,
    report_type: "public_profile_research",
    run_id: run.run_id,
    generated_at: run.generated_at,
    research_state: complete ? "complete" : run.status === "failed" ? "failed" : "partial",
    subject: { ...run.research_brief.subject, identity_status: identity.status },
    identity,
    closure,
    purpose: run.research_brief.purpose,
    research_mode: run.research_brief.research_mode,
    coverage: {
      statement: coverageStatement,
      declared_targets: materialSources.length,
      collected_targets: collectedTargets,
      partial_targets: partialTargets,
      unavailable_targets: unavailableTargets,
      discovery_targets: discoverySources.length,
      collected_discovery_targets: collectedDiscoveryTargets,
      not_attempted_discovery_targets: notAttemptedDiscoveryTargets,
      collection_state: collectionState,
      research_goal_satisfied: researchGoalSatisfied,
      module_requirements_satisfied: moduleRequirementsSatisfied,
      optional_discovery_gaps: optionalGapCount,
      sources
    },
    findings: findings.map((item) => attachEvidenceReferences(item, lookup)),
    highlights,
    synthesis,
    evidence_register: evidenceRegister,
    analysis: {
      public_persona: {
        state: "not_synthesised",
        statement: "The deterministic runner did not perform an evidence-linked interpretive public-persona pass. Repeated observable topic signals, if any, remain extractive synthesis only.",
        evidence_ids: []
      },
      credibility: {
        state: "claim_specific_only",
        statement: "No overall trust score is produced. Credibility findings must be attached to a specific public claim and supporting or contradicting evidence."
      }
    },
    limitations: [
      "A public profile is not a complete account of a person.",
      "Missing evidence supports neither reassurance nor suspicion.",
      "Counts and current-activity signals are snapshots taken at the stated observation time.",
      "Public persona is not private personality and cannot establish a diagnosis."
    ]
  };
}

function renderFinding(findingItem) {
  const references = (findingItem.evidence_refs ?? []).map((reference) => {
    const label = escapeHtml(reference.evidence_id);
    return reference.href && reference.href !== "#"
      ? `<a class="evidence-link" href="${escapeHtml(reference.href)}">${label}</a>`
      : `<code>${label}</code>`;
  }).join(" ");
  return `<li><span class="finding-kind">${escapeHtml(findingItem.confidence)}</span><p>${escapeHtml(findingItem.statement)}</p><div class="evidence-links">${references}</div></li>`;
}

function renderRepository(repository) {
  const description = repository.description ? `<p>${escapeHtml(repository.description)}</p>` : "";
  const language = repository.language ? `<span>${escapeHtml(repository.language)}</span>` : "";
  return `<article class="repo-card"><h3><a href="${escapeHtml(safePublicUrl(repository.url))}">${escapeHtml(repository.name)}</a></h3>${description}<div class="repo-meta">${language}<span>${repository.stars} stars</span><span>${repository.forks} forks</span></div><code>${escapeHtml(repository.evidence_id)}</code></article>`;
}

function renderDiscoveryLead(lead) {
  const link = lead.url === "#"
    ? `<h3>${escapeHtml(lead.title)}</h3>`
    : `<h3><a href="${escapeHtml(lead.url)}">${escapeHtml(lead.title)}</a></h3>`;
  const metadata = [lead.author, lead.published].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join("");
  const highlight = lead.highlight ? `<p>${escapeHtml(lead.highlight)}</p>` : "";
  const evidence = lead.evidence_href && lead.evidence_href !== "#"
    ? `<a class="evidence-link" href="${escapeHtml(lead.evidence_href)}">${escapeHtml(lead.evidence_id)}</a>`
    : `<code>${escapeHtml(lead.evidence_id)}</code>`;
  return `<article class="discovery-card">${link}<div class="discovery-meta">${metadata}</div>${highlight}${evidence}</article>`;
}

function renderEvidenceItem(item) {
  const archive = item.href && item.href !== "#"
    ? `<a class="evidence-link" href="${escapeHtml(item.href)}">Open archived item</a>`
    : "<span class=\"muted\">Archive link unavailable</span>";
  const date = item.published_at || item.observed_at || "Date not observed";
  return `<tr><td>${escapeHtml(item.platform)}</td><td>${escapeHtml(item.item_type)}</td><td><a href="${escapeHtml(safePublicUrl(item.canonical_url))}">${escapeHtml(item.title || item.canonical_url)}</a></td><td>${escapeHtml(date)}</td><td>${escapeHtml(item.subject_relation)}</td><td>${archive}</td></tr>`;
}

function renderTimelineItem(item) {
  const reference = item.evidence_id ? `<code>${escapeHtml(item.evidence_id)}</code>` : "";
  return `<li><time>${escapeHtml(item.date)}</time><div><span class="finding-kind">${escapeHtml(item.platform)}</span><a href="${escapeHtml(safePublicUrl(item.url))}">${escapeHtml(item.title)}</a>${reference}</div></li>`;
}

export function buildReportHtml(model) {
  const github = model.highlights.github;
  const findings = model.findings.length ? model.findings.map(renderFinding).join("") : "<li><p>No factual highlights were extracted automatically. Inspect the evidence archive and run synthesis.</p></li>";
  const repositories = github?.repositories?.length ? github.repositories.map(renderRepository).join("") : "<p class=\"muted\">No repository cards were collected.</p>";
  const sources = model.coverage.sources.map((source) => `<tr><td>${escapeHtml(source.platform)}</td><td>${escapeHtml(source.source_role.replaceAll("_", " "))}</td><td><a href="${escapeHtml(safePublicUrl(source.url))}">${escapeHtml(source.url)}</a></td><td><span class="status status-${escapeHtml(source.status)}">${escapeHtml(source.status)}</span></td><td>${escapeHtml(source.adapter)}</td><td>${escapeHtml(source.message || "Collected without a reported barrier")}</td></tr>`).join("");
  const languages = github?.languages?.length ? github.languages.map((language) => `<li><span>${escapeHtml(language.name)}</span><strong>${language.count}</strong></li>`).join("") : "<li><span>Not observed</span><strong>0</strong></li>";
  const discovery = model.highlights.web_discovery?.length
    ? model.highlights.web_discovery.map(renderDiscoveryLead).join("")
    : "<p class=\"muted\">No web discovery leads were extracted in this run.</p>";
  const evidenceRows = model.evidence_register?.length
    ? model.evidence_register.slice(0, 200).map(renderEvidenceItem).join("")
    : "<tr><td colspan=\"6\" class=\"muted\">No normalised source items were produced.</td></tr>";
  const evidenceOverflow = model.evidence_register?.length > 200
    ? `<p class="muted">Showing 200 of ${model.evidence_register.length} items. The complete register is preserved in evidence-ledger.json.</p>`
    : "";
  const timeline = model.synthesis?.timeline?.length
    ? `<section><h2>Observed timeline</h2><p class="muted">Dated items from supplied-anchor material, newest first. Dates are reported by the source.</p><ol class="timeline">${model.synthesis.timeline.map(renderTimelineItem).join("")}</ol></section>`
    : "";
  const githubSection = github ? `<section><h2>Public GitHub snapshot</h2><div class="facts"><div class="fact"><small>Biography</small><strong>${escapeHtml(github.bio || "Not observed")}</strong></div><div class="fact"><small>Company field</small><strong>${escapeHtml(github.company || "Not observed")}</strong></div><div class="fact"><small>Public repositories</small><strong>${escapeHtml(github.public_repositories ?? "Not observed")}</strong></div><div class="fact"><small>Followers</small><strong>${escapeHtml(github.followers ?? "Not observed")}</strong></div></div><h3>Observed repository languages</h3><ul class="language-list">${languages}</ul><div class="repo-grid">${repositories}</div></section>` : "";
  const statusLabel = model.research_state === "complete"
    ? "All required gates satisfied"
    : model.research_state === "failed"
      ? "No subject evidence collected"
      : model.coverage.research_goal_satisfied
        ? model.coverage.module_requirements_satisfied
          ? "Collection goal satisfied, identity open"
          : "Collection goal satisfied, requested analysis open"
        : "Research goal remains open";
  const identityLabel = model.subject.identity_status === "confirmed" ? "Identity confirmed" : `Identity ${model.subject.identity_status || "unconfirmed"}`;
  const collectionLabel = model.coverage.collection_state || "unknown";
  const modeLabel = model.closure?.research_mode?.status ?? (model.coverage.research_goal_satisfied ? "satisfied" : "open");
  const identityReason = model.identity?.reasons?.[0] ?? "Identity was not separately resolved.";
  const modeReason = model.closure?.research_mode?.reasons?.[0] ?? "No separate research-mode closure assessment was supplied.";
  const moduleAssessment = model.closure?.module_requirements;
  const moduleLabel = moduleAssessment?.status ?? "not assessed";
  const moduleReason = moduleAssessment?.gaps?.length
    ? moduleAssessment.gaps.map((gap) => {
        const label = String(gap.module).replaceAll("_", " ");
        return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${gap.reason}`;
      }).join(" ")
    : moduleAssessment?.reasons?.[0] ?? "No separate requested-module assessment was supplied.";
  const discoveryCoverage = `${model.coverage.collected_discovery_targets} of ${model.coverage.discovery_targets} discovered candidate pages were readable.${model.coverage.not_attempted_discovery_targets ? ` ${model.coverage.not_attempted_discovery_targets} were not attempted because the follow-up budget was reached.` : ""}`;

  return `<!doctype html>
<html lang="en-AU">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(model.subject.display_name)} | Public profile research</title>
  <style>
    :root{color-scheme:light dark;--paper:#f5f2e9;--ink:#15201c;--muted:#5a6660;--line:#c8cec8;--card:#fffdf5;--signal:#d8ff4f;--rust:#b9482d;--blue:#3264dc;--shadow:0 18px 50px rgba(22,34,29,.1)}
    @media(prefers-color-scheme:dark){:root{--paper:#111714;--ink:#eef4ed;--muted:#a6b3ab;--line:#36423b;--card:#19211d;--signal:#c7ef48;--rust:#ff886a;--blue:#80a5ff;--shadow:0 18px 50px rgba(0,0,0,.24)}}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}main{width:min(1160px,calc(100% - 32px));margin:auto;padding:24px 0 80px;min-width:0}.masthead{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(240px,.7fr);gap:24px;padding:clamp(28px,6vw,72px);background:var(--ink);color:var(--paper);border-radius:28px;box-shadow:var(--shadow)}.eyebrow{margin:0 0 12px;text-transform:uppercase;letter-spacing:.13em;font-weight:750;font-size:.74rem}.masthead h1{font-size:clamp(2.7rem,8vw,6.8rem);line-height:.9;letter-spacing:-.065em;margin:0;max-width:12ch}.lede{font-size:clamp(1.05rem,2vw,1.35rem);max-width:50ch}.badge{display:inline-flex;padding:8px 12px;border-radius:999px;background:var(--signal);color:#101510;font-weight:800}.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-self:end}.stat{border:1px solid color-mix(in srgb,var(--paper) 30%,transparent);padding:16px;border-radius:18px}.stat strong{display:block;font-size:2rem}.stat span{font-size:.78rem;text-transform:uppercase;letter-spacing:.08em}section{margin-top:28px;padding:clamp(22px,4vw,42px);background:var(--card);border:1px solid var(--line);border-radius:24px;min-width:0}h2{font-size:clamp(1.55rem,3vw,2.35rem);letter-spacing:-.04em;margin:0 0 16px}h3{margin:.1rem 0}.muted{color:var(--muted)}.coverage-note{border-left:5px solid var(--rust);padding:12px 16px;background:color-mix(in srgb,var(--rust) 8%,transparent)}.assessment-grid,.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.assessment-card,.fact{padding:18px;border:1px solid var(--line);border-radius:16px}.assessment-card strong{display:block;font-size:1.2rem;text-transform:capitalize}.assessment-card p{margin-bottom:0}.fact small,.finding-kind{display:block;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-size:.72rem;font-weight:800}.fact strong{font-size:1.2rem}.findings{list-style:none;padding:0;margin:0;display:grid;gap:12px}.findings li{padding:16px;border-left:3px solid var(--blue);background:color-mix(in srgb,var(--blue) 6%,transparent)}code{font-size:.72rem;color:var(--muted);overflow-wrap:anywhere}.evidence-links{display:flex;gap:8px;flex-wrap:wrap}.evidence-link{font:700 .72rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--blue)}.repo-grid,.discovery-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.repo-card,.discovery-card,.assessment-card,.fact,.analysis-card{min-width:0}.repo-card,.discovery-card{padding:18px;border:1px solid var(--line);border-radius:16px}.repo-card p,.discovery-card p,.fact strong,.timeline time{overflow-wrap:anywhere;word-break:break-word}.repo-meta,.discovery-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:.82rem}.discovery-card{border-top:4px solid var(--signal)}.language-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;padding:0;list-style:none}.language-list li{display:flex;justify-content:space-between;padding:10px 12px;border:1px solid var(--line);border-radius:12px}.timeline{list-style:none;padding:0;margin:0}.timeline li{display:grid;grid-template-columns:minmax(120px,.3fr) minmax(0,1fr);gap:18px;padding:14px 0;border-bottom:1px solid var(--line)}.timeline time{font-variant-numeric:tabular-nums;color:var(--muted)}.timeline a,.timeline code{display:block}.table-wrap{overflow-x:auto;max-width:100%}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:12px 10px}th{font-size:.73rem;text-transform:uppercase;letter-spacing:.08em}.status{display:inline-flex;padding:3px 8px;border-radius:999px;border:1px solid currentColor;font-size:.76rem;font-weight:750}.status-collected{color:#277542}.status-unavailable,.status-failed{color:var(--rust)}.analysis-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.analysis-card{padding:18px;border-radius:18px;background:color-mix(in srgb,var(--signal) 13%,var(--card));border:1px solid var(--line)}footer{padding:30px 4px;color:var(--muted);font-size:.84rem;overflow-wrap:anywhere}
    @media(max-width:720px){main{width:min(100% - 20px,1160px);padding-top:10px}.masthead{grid-template-columns:1fr;border-radius:20px;padding:26px}.stats,.analysis-grid{grid-template-columns:1fr}section{border-radius:18px;padding:20px}.masthead h1{font-size:clamp(2.5rem,15vw,4.5rem)}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  </style>
</head>
<body>
<main>
  <header class="masthead">
    <div><p class="eyebrow">Public profile research</p><span class="badge">${escapeHtml(statusLabel)}</span> <span class="badge">${escapeHtml(identityLabel)}</span><h1>${escapeHtml(model.subject.display_name)}</h1><p class="lede">An evidence-linked view of the public material reached in this run, with access gaps kept visible. Source collection is not identity confirmation.</p></div>
    <div class="stats"><div class="stat"><strong>${model.coverage.collected_targets}</strong><span>supplied targets collected</span></div><div class="stat"><strong>${model.coverage.unavailable_targets}</strong><span>supplied targets unavailable</span></div><div class="stat"><strong>${model.findings.length}</strong><span>extracted findings</span></div><div class="stat"><strong>${escapeHtml(model.research_mode)}</strong><span>research mode</span></div></div>
  </header>
  <section><h2>Research assessment</h2><p class="coverage-note">${escapeHtml(model.coverage.statement)}</p><div class="assessment-grid"><article class="assessment-card"><span class="finding-kind">Collection</span><strong>${escapeHtml(collectionLabel.replaceAll("_", " "))}</strong><p>${escapeHtml(`${model.coverage.collected_targets} collected, ${model.coverage.partial_targets} partial and ${model.coverage.unavailable_targets} unavailable supplied targets. ${discoveryCoverage}`)}</p></article><article class="assessment-card"><span class="finding-kind">Identity</span><strong>${escapeHtml(model.identity.status.replaceAll("_", " "))}</strong><p>${escapeHtml(identityReason)}</p></article><article class="assessment-card"><span class="finding-kind">${escapeHtml(model.research_mode.replaceAll("_", " "))}</span><strong>${escapeHtml(modeLabel.replaceAll("_", " "))}</strong><p>${escapeHtml(modeReason)}</p></article><article class="assessment-card"><span class="finding-kind">Requested modules</span><strong>${escapeHtml(moduleLabel.replaceAll("_", " "))}</strong><p>${escapeHtml(moduleReason)}</p></article></div></section>
  <section><h2>What this run establishes</h2><ul class="findings">${findings}</ul></section>
  <section><h2>Web discovery leads</h2><p class="muted">Candidate pages found through public search. These are leads for identity checking, not confirmed matches.</p><div class="discovery-grid">${discovery}</div></section>
  ${githubSection}
  ${timeline}
  <section><h2>Analysis state</h2><div class="analysis-grid"><article class="analysis-card"><p class="eyebrow">Public persona</p><h3>${escapeHtml(model.analysis.public_persona.state.replaceAll("_", " "))}</h3><p>${escapeHtml(model.analysis.public_persona.statement)}</p></article><article class="analysis-card"><p class="eyebrow">Credibility</p><h3>${escapeHtml(model.analysis.credibility.state.replaceAll("_", " "))}</h3><p>${escapeHtml(model.analysis.credibility.statement)}</p></article></div></section>
  <section><h2>Normalised public items</h2><p class="muted">Each row links the public source to its hash-bound archived item. Candidate search results are kept separate from supplied-anchor material.</p>${evidenceOverflow}<div class="table-wrap"><table><thead><tr><th>Platform</th><th>Type</th><th>Public source</th><th>Date</th><th>Relation</th><th>Evidence</th></tr></thead><tbody>${evidenceRows}</tbody></table></div></section>
  <section><h2>Source coverage</h2><div class="table-wrap"><table><thead><tr><th>Platform</th><th>Role</th><th>Target</th><th>Status</th><th>Adapter</th><th>Result or barrier</th></tr></thead><tbody>${sources}</tbody></table></div></section>
  <section><h2>Limits</h2><ul>${model.limitations.map((limit) => `<li>${escapeHtml(limit)}</li>`).join("")}</ul></section>
  <footer>Run ${escapeHtml(model.run_id)}. Generated ${escapeHtml(model.generated_at)}. Findings link to hash-bound source items or collection receipts. The evidence ledger is the complete machine-readable register.</footer>
</main>
</body>
</html>`;
}

export async function writeReportBundle(run, receipts, outputDirectory, sourceItems = []) {
  const reportDirectory = path.resolve(outputDirectory, "report");
  const model = buildReportModel(run, receipts, sourceItems);
  const html = buildReportHtml(model);
  const modelBytes = `${JSON.stringify(model, null, 2)}\n`;
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(path.join(reportDirectory, "report.json"), modelBytes, { encoding: "utf8", mode: 0o600 }),
    writeFile(path.join(reportDirectory, "index.html"), html, { encoding: "utf8", mode: 0o600 })
  ]);
  return {
    model,
    html,
    reportDirectory,
    model_sha256: createHash("sha256").update(modelBytes).digest("hex"),
    html_sha256: createHash("sha256").update(html).digest("hex")
  };
}

export async function loadReceipts(run, runDirectory) {
  const root = path.resolve(runDirectory);
  const receipts = {};
  for (const target of run.targets ?? []) {
    for (const attempt of target.attempts ?? []) {
      const receiptPath = path.resolve(root, attempt.receipt_path);
      if (receiptPath !== root && !receiptPath.startsWith(`${root}${path.sep}`)) {
        throw new TypeError(`Receipt path escapes the run directory: ${attempt.receipt_path}`);
      }
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      const computed = receiptDigest(receipt);
      if (receipt.sha256 !== computed || attempt.receipt_sha256 !== computed) {
        throw new Error(`Receipt integrity check failed for ${attempt.receipt_path}`);
      }
      if (receipt.adapter_id !== attempt.adapter_id || receipt.status !== attempt.status) {
        throw new Error(`Receipt metadata integrity check failed for ${attempt.receipt_path}`);
      }
      if (receipt.target?.platform !== target.platform || receipt.target?.canonical_url !== target.canonical_url) {
        throw new Error(`Receipt target integrity check failed for ${attempt.receipt_path}`);
      }
      receipts[attempt.receipt_path] = receipt;
    }
  }
  return receipts;
}
