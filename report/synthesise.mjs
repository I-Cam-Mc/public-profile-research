const STOP_WORDS = new Set([
  "about", "after", "again", "also", "author", "been", "before", "being", "between", "build", "built", "company", "could", "description", "does", "facebook", "from", "github", "have", "homepage", "instagram", "into", "language", "linkedin", "location", "more", "post", "posts", "profile", "public", "repository", "research", "snapshot", "their", "there", "these", "they", "this", "through", "tiktok", "topics", "transcript", "twitter", "using", "video", "website", "what", "when", "where", "which", "with", "would", "youtube", "your"
]);

function bounded(value, limit = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function usableItems(items) {
  return items.filter((item) => (
    item?.subject_relation === "provided_anchor"
    && item?.content_quality !== "unusable"
    && item?.evidence_id
    && item?.canonical_url
  ));
}

function tokensFor(item) {
  const text = `${item.title ?? ""}\n${item.text ?? ""}`
    .replace(/https?:\/\/[^\s<>()]+/gi, " ")
    .replace(/^\s*["']?[a-z][a-z0-9 _-]*["']?\s*:\s*/gim, "")
    .replace(/[{}\[\]",]/g, " ")
    .toLowerCase();
  const words = text.match(/[a-z][a-z0-9+#.-]{2,}/g) ?? [];
  return new Set(words
    .map((word) => word.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((word) => word.length >= 3 && word.length <= 32 && !STOP_WORDS.has(word) && !/^https?$/.test(word)));
}

function repeatedThemes(items) {
  const evidenceByTerm = new Map();
  for (const item of items) {
    for (const term of tokensFor(item)) {
      const evidence = evidenceByTerm.get(term) ?? [];
      evidence.push(item.evidence_id);
      evidenceByTerm.set(term, evidence);
    }
  }
  return [...evidenceByTerm.entries()]
    .filter(([, evidenceIds]) => evidenceIds.length >= 2)
    .map(([term, evidenceIds]) => ({ term, item_count: evidenceIds.length, evidence_ids: evidenceIds.slice(0, 12) }))
    .sort((a, b) => b.item_count - a.item_count || a.term.localeCompare(b.term))
    .slice(0, 8);
}

function platformSummaries(items) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.platform) ?? [];
    group.push(item);
    groups.set(item.platform, group);
  }
  return [...groups.entries()].map(([platform, group]) => {
    const types = Object.entries(group.reduce((counts, item) => {
      counts[item.item_type] = (counts[item.item_type] ?? 0) + 1;
      return counts;
    }, {})).map(([type, count]) => ({ type, count }));
    return {
      platform,
      item_count: group.length,
      types,
      evidence_ids: group.slice(0, 20).map((item) => item.evidence_id),
      observation: `The supplied ${platform} material yielded ${group.length} normalised public ${group.length === 1 ? "item" : "items"}.`
    };
  }).sort((a, b) => a.platform.localeCompare(b.platform));
}

function timeline(items) {
  return items
    .filter((item) => item.published_at)
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
    .slice(0, 40)
    .map((item) => ({
      date: item.published_at,
      platform: item.platform,
      title: bounded(item.title, 240),
      url: item.canonical_url,
      evidence_id: item.evidence_id
    }));
}

export function synthesiseSourceItems(sourceItems = [], options = {}) {
  const identityConfirmed = options.identityStatus === "confirmed";
  const supplied = usableItems(sourceItems);
  const established = identityConfirmed ? supplied : [];
  const candidates = sourceItems.filter((item) => item?.subject_relation === "candidate");
  const themes = repeatedThemes(established);
  const platforms = platformSummaries(established);
  const dated = timeline(established);
  const findings = platforms.map((platform) => ({
    category: "source_summary",
    statement: platform.observation,
    evidence_ids: platform.evidence_ids,
    confidence: "observed"
  }));
  if (dated.length) {
    findings.push({
      category: "current_activity",
      statement: `The latest dated item in the collected supplied-anchor material was “${dated[0].title}” on ${dated[0].date}.`,
      evidence_ids: [dated[0].evidence_id],
      confidence: "observed_snapshot"
    });
  }
  if (themes.length) {
    findings.push({
      category: "repeated_public_topics",
      statement: `Across ${established.length} collected supplied-anchor items, repeated terms included ${themes.slice(0, 5).map((theme) => `${theme.term} (${theme.item_count} items)`).join(", ")}. This is an automated topic signal, not a personality claim.`,
      evidence_ids: [...new Set(themes.slice(0, 5).flatMap((theme) => theme.evidence_ids))],
      confidence: "bounded_extract"
    });
  }
  return {
    state: established.length
      ? "extractive_synthesis"
      : (supplied.length && !identityConfirmed ? "identity_not_confirmed" : "not_synthesised"),
    established_item_count: established.length,
    supplied_unconfirmed_item_count: identityConfirmed ? 0 : supplied.length,
    candidate_item_count: candidates.length,
    platforms,
    timeline: dated,
    repeated_topics: themes,
    findings,
    public_persona: !identityConfirmed && supplied.length
      ? {
          state: "identity_not_confirmed",
          statement: "Supplied profiles have not been confirmed as one person, so no person-level public-persona synthesis was produced.",
          evidence_ids: []
        }
      : themes.length
      ? {
          state: "bounded_extract",
          statement: `The collected public material repeatedly foregrounded ${themes.slice(0, 5).map((theme) => theme.term).join(", ")}. This describes topics in the observed sample, not the whole person or a private psychological trait.`,
          evidence_ids: [...new Set(themes.slice(0, 5).flatMap((theme) => theme.evidence_ids))]
        }
      : {
          state: "insufficient_sample",
          statement: "The collected sample did not contain enough repeated item-level signals for an automated public-persona extract.",
          evidence_ids: []
        }
  };
}
