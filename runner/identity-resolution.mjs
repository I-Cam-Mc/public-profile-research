const IDENTITY_STATES = new Set(["unconfirmed", "candidates", "confirmed", "conflict"]);

function unique(values) {
  return [...new Set(values)];
}

function normaliseHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new TypeError(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new TypeError(`${label} must be a credential-free HTTPS URL`);
  }
  parsed.hash = "";
  return parsed.href;
}

function checkedSubject(subject) {
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) {
    throw new TypeError("subject is required");
  }
  const anchors = unique((subject.identity_anchors ?? []).map((value) => normaliseHttpsUrl(value, "identity anchor")));
  if (!anchors.length) throw new TypeError("subject.identity_anchors must contain at least one anchor");
  const intakeStatus = String(subject.identity_status ?? "unconfirmed");
  if (!IDENTITY_STATES.has(intakeStatus)) throw new TypeError(`Unsupported identity status: ${intakeStatus}`);
  return { anchors, intakeStatus };
}

/**
 * Resolve identity without interpreting names, biographies or search ranking.
 *
 * The caller supplies already-classified observations. This pure boundary keeps
 * collection separate from identity judgement and deliberately treats a
 * collected supplied profile as a candidate, not as proof of identity.
 *
 * Direct confirmation can only extend from a supplied anchor whose source is
 * already confirmed: it must be collected, first-party, backed by an evidence
 * ID and link to another supplied anchor. Two collected supplied anchors may
 * instead confirm each other through reciprocal evidenced first-party links.
 * `agent_reach_exa`, search-result and `discovery_only` observations always
 * remain leads regardless of any other flags.
 */
export function resolveIdentity({ subject, observations = [] } = {}) {
  const { anchors, intakeStatus } = checkedSubject(subject);
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");

  const collectedObservations = observations
    .filter((observation) => observation?.status === "collected")
    .map((observation) => {
      if (observation.links_to !== undefined && !Array.isArray(observation.links_to)) {
        throw new TypeError("observation.links_to must be an array");
      }
      if (observation.evidence_ids !== undefined && !Array.isArray(observation.evidence_ids)) {
        throw new TypeError("observation.evidence_ids must be an array");
      }
      return {
        ...observation,
        url: normaliseHttpsUrl(observation.url, "observation.url"),
        linksTo: unique((observation.links_to ?? []).map((value) => normaliseHttpsUrl(value, "observation.links_to item"))),
        evidenceIds: unique((observation.evidence_ids ?? []).map((value) => String(value).trim()).filter(Boolean)),
        discoveryOnly: observation?.discovery_only === true
          || observation?.source_kind === "search_result"
          || String(observation?.adapter_id ?? "").toLowerCase().includes("exa")
      };
    });
  const collected = collectedObservations.map((observation) => observation.url);
  const candidateAnchors = anchors.filter((anchor) => collected.includes(anchor));
  const discoveryLeads = unique(
    collectedObservations.filter((observation) => observation.discoveryOnly).map((observation) => observation.url)
  );
  const anchorSet = new Set(anchors);
  const directCorroboration = collectedObservations.flatMap((observation) => {
    if (observation.first_party !== true || observation.discoveryOnly || !observation.evidenceIds.length) return [];
    if (!anchorSet.has(observation.url) || observation.source_identity_status !== "confirmed") return [];
    const linkedAnchors = observation.linksTo.filter((url) => anchorSet.has(url) && url !== observation.url);
    if (!linkedAnchors.length) return [];
    return [{
      kind: "direct_first_party_link",
      source_url: observation.url,
      target_urls: linkedAnchors,
      adapter_id: String(observation.adapter_id ?? "") || null,
      evidence_ids: observation.evidenceIds
    }];
  });
  const firstPartyObservations = collectedObservations.filter(
    (observation) => observation.first_party === true && !observation.discoveryOnly && observation.evidenceIds.length > 0
  );
  const mutualCorroboration = [];
  for (let leftIndex = 0; leftIndex < firstPartyObservations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < firstPartyObservations.length; rightIndex += 1) {
      const left = firstPartyObservations[leftIndex];
      const right = firstPartyObservations[rightIndex];
      if (left.url === right.url) continue;
      if (!left.linksTo.includes(right.url) || !right.linksTo.includes(left.url)) continue;
      if (!anchorSet.has(left.url) || !anchorSet.has(right.url)) continue;
      mutualCorroboration.push({
        kind: "mutual_first_party_links",
        source_urls: [left.url, right.url],
        evidence_ids: unique([...left.evidenceIds, ...right.evidenceIds])
      });
    }
  }
  const reasons = candidateAnchors.length
    ? ["A collected supplied anchor is an identity candidate, not identity confirmation"]
    : ["No collected supplied identity anchor is available"];
  if (discoveryLeads.length) {
    reasons.push("Search discovery and Exa name matches are leads only and cannot confirm identity");
  }
  const unevidencedFirstPartyClaim = collectedObservations.some((observation) =>
    observation.first_party === true
      && !observation.discoveryOnly
      && observation.evidenceIds.length === 0
      && (observation.direct_identity_corroboration === true || observation.linksTo.some((url) => anchorSet.has(url)))
  );
  if (unevidencedFirstPartyClaim) reasons.push("A first-party corroboration flag without evidence remains a candidate only");
  const conflicts = collectedObservations
    .filter((observation) => observation.first_party === true
      && !observation.discoveryOnly
      && observation.contradicts_identity === true
      && observation.evidenceIds.length > 0)
    .map((observation) => ({
      kind: "first_party_contradiction",
      source_url: observation.url,
      evidence_ids: observation.evidenceIds
    }));
  if (intakeStatus === "conflict") {
    conflicts.unshift({ kind: "intake_conflict", evidence_ids: [] });
  }
  if (conflicts.length) reasons.unshift("Identity evidence contains an unresolved conflict");
  const hasConflict = conflicts.length > 0;
  const explicitlyConfirmed = intakeStatus === "confirmed";
  const mutuallyConfirmed = mutualCorroboration.length > 0;
  const directlyConfirmed = directCorroboration.length > 0;
  if (explicitlyConfirmed) reasons.unshift("The intake explicitly confirms the supplied identity anchors");
  else if (mutuallyConfirmed) reasons.unshift("Collected first-party sources mutually corroborate each other");
  else if (directlyConfirmed) reasons.unshift("Collected first-party material directly corroborates the supplied identity anchors");
  const confirmationMethod = hasConflict
    ? null
    : (explicitlyConfirmed
      ? "explicit_confirmed_intake"
      : (mutuallyConfirmed
        ? "mutual_first_party_corroboration"
        : (directlyConfirmed ? "direct_first_party_corroboration" : null)));
  const corroboratedAnchorSet = new Set();
  for (const item of directCorroboration) {
    if (anchorSet.has(item.source_url)) corroboratedAnchorSet.add(item.source_url);
    for (const targetUrl of item.target_urls) corroboratedAnchorSet.add(targetUrl);
  }
  for (const item of mutualCorroboration) {
    for (const sourceUrl of item.source_urls) {
      if (anchorSet.has(sourceUrl)) corroboratedAnchorSet.add(sourceUrl);
    }
  }
  const confirmedAnchors = hasConflict
    ? []
    : (explicitlyConfirmed ? anchors : anchors.filter((anchor) => corroboratedAnchorSet.has(anchor)));

  return {
    status: hasConflict
      ? "conflict"
      : (confirmationMethod ? "confirmed" : (candidateAnchors.length ? "candidates" : "unconfirmed")),
    confirmed_by: confirmationMethod,
    supplied_anchors: anchors,
    candidate_anchors: candidateAnchors,
    confirmed_anchors: confirmedAnchors,
    discovery_leads: discoveryLeads,
    corroboration: [...mutualCorroboration, ...directCorroboration],
    conflicts,
    reasons
  };
}
