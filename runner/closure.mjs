const RESEARCH_MODES = new Set(["insight", "bounded_census", "maximum_public_coverage"]);
const IDENTITY_STATES = new Set(["unconfirmed", "candidates", "confirmed", "conflict"]);
const BOUNDARY_KINDS = new Set(["lifetime", "date_interval", "current_public_surface", "bounded_listing"]);
const CLOSING_DENOMINATORS = new Set([
  "complete_first_party_export",
  "complete_api_listing",
  "displayed_total_reconciled",
  "terminal_pagination",
  "date_bucket_exhaustion"
]);
const ACTIVE_CITED_PASS_MODULES = new Set([
  "career",
  "companies",
  "code",
  "professional_network",
  "commercial_activity",
  "public_impression",
  "public_persona",
  "credibility",
  "controversies"
]);
const VIDEO_ITEM_TYPES = new Set(["youtube_video", "social_video"]);
const CURRENT_ACTIVITY_ITEM_TYPES = new Set(["social_post", "youtube_video", "social_video", "web_page_snapshot"]);
const PROJECT_ITEM_TYPES = new Set(["github_repository", "project", "repository"]);
const CURRENT_ACTIVITY_WINDOW_DAYS = 365;

function checkedArray(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function targetId(target, index) {
  return String(target?.id ?? target?.canonical_url ?? `${target?.platform ?? "target"}-${index + 1}`);
}

function isOptionalDiscovery(target) {
  return target?.optional_discovery === true
    || target?.source_role === "optional_discovery"
    || target?.platform === "web_search";
}

function isMaterialTarget(target) {
  return !isOptionalDiscovery(target) && target?.material !== false;
}

function hasUsefulMaterial(target) {
  if (target?.useful_material === false) return false;
  if (target?.status === "collected") return true;
  if (target?.status !== "partial") return false;
  return target?.useful_material === true
    || (Number.isInteger(target?.evidence_count) && target.evidence_count > 0);
}

function gapFor(target, index) {
  return {
    id: targetId(target, index),
    platform: String(target?.platform ?? "unknown"),
    status: String(target?.status ?? "unknown"),
    barrier: target?.barrier ?? null,
    material: isMaterialTarget(target),
    source_role: isOptionalDiscovery(target) ? "optional_discovery" : "supplied_material"
  };
}

export function assessCollectionClosure(targets = []) {
  checkedArray(targets, "targets");
  const materialTargets = targets.filter(isMaterialTarget);
  const usefulMaterialTargets = materialTargets.filter(hasUsefulMaterial);
  const materialGaps = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => isMaterialTarget(target) && !hasUsefulMaterial(target))
    .map(({ target, index }) => gapFor(target, index));
  const coverageGaps = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => isMaterialTarget(target) && target?.status !== "collected")
    .map(({ target, index }) => gapFor(target, index));
  const optionalDiscoveryGaps = targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => isOptionalDiscovery(target) && (target?.status !== "collected" || !hasUsefulMaterial(target)))
    .map(({ target, index }) => gapFor(target, index));
  const status = usefulMaterialTargets.length === 0
    ? "failed"
    : ((materialGaps.length || coverageGaps.length) ? "partial" : "complete");

  return {
    status,
    supplied_material_targets: materialTargets.length,
    useful_supplied_material_targets: usefulMaterialTargets.length,
    optional_discovery_targets: targets.filter(isOptionalDiscovery).length,
    material_gaps: materialGaps,
    coverage_gaps: coverageGaps,
    optional_discovery_gaps: optionalDiscoveryGaps,
    reasons: status === "complete"
      ? ["Every supplied material target returned useful material"]
      : (status === "partial"
        ? [materialGaps.length
          ? "Some supplied material targets did not return useful material"
          : "Useful material was returned, but source collection coverage remains partial"]
        : ["No supplied material target returned useful material"])
  };
}

export function assessIdentityClosure(identity) {
  const status = String(identity?.status ?? identity ?? "unconfirmed");
  if (!IDENTITY_STATES.has(status)) throw new TypeError(`Unsupported identity status: ${status}`);
  return {
    status,
    satisfied: status === "confirmed",
    independent_from_collection: true,
    reason: status === "confirmed"
      ? "Identity has an accepted confirmation basis"
      : `Identity remains ${status}; collection success does not promote identity`
  };
}

function usableProvidedItem(item) {
  return item?.subject_relation === "provided_anchor" && item?.content_quality !== "unusable";
}

function moduleResult(module, satisfied, reason, options = {}) {
  return {
    module,
    status: satisfied ? "satisfied" : "unsatisfied",
    satisfied,
    barrier: satisfied ? null : options.barrier,
    evidence_ids: satisfied ? (options.evidenceIds ?? []) : [],
    reason,
    ...(options.observationWindow ? { observation_window: options.observationWindow } : {})
  };
}

function validTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function timelineRequirement(sourceItems) {
  const dated = sourceItems.filter((item) => usableProvidedItem(item) && validTimestamp(item?.published_at) !== null);
  return moduleResult(
    "timeline",
    dated.length > 0,
    dated.length
      ? `${dated.length} dated supplied-source ${dated.length === 1 ? "item supports" : "items support"} a timeline`
      : "The requested timeline module has no dated supplied-source items",
    { barrier: "dated_evidence_unavailable", evidenceIds: dated.map((item) => item.evidence_id) }
  );
}

function currentActivityTimestamp(item) {
  for (const key of ["pushed_at", "updated_at", "last_activity_at"]) {
    const timestamp = validTimestamp(item?.metrics?.[key]);
    if (timestamp !== null) return timestamp;
  }
  if (CURRENT_ACTIVITY_ITEM_TYPES.has(item?.item_type)) return validTimestamp(item?.published_at);
  return null;
}

function currentActivityRequirement(sourceItems, observedAt) {
  const end = validTimestamp(observedAt);
  const window = end === null ? null : {
    start: new Date(end - CURRENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    end: new Date(end).toISOString(),
    days: CURRENT_ACTIVITY_WINDOW_DAYS,
    basis: "explicit publication, update or push timestamp on supplied-source material"
  };
  const recent = end === null ? [] : sourceItems.filter((item) => {
    if (!usableProvidedItem(item)) return false;
    const timestamp = currentActivityTimestamp(item);
    return timestamp !== null && timestamp <= end && timestamp >= end - CURRENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  });
  return moduleResult(
    "current_activity",
    recent.length > 0,
    recent.length
      ? `${recent.length} supplied-source ${recent.length === 1 ? "item has" : "items have"} an explicit activity timestamp inside the stated observation window`
      : end === null
        ? "Current activity cannot close without a valid observation timestamp"
        : `No supplied-source item has an explicit publication, update or push timestamp inside the ${CURRENT_ACTIVITY_WINDOW_DAYS}-day observation window`,
    {
      barrier: end === null ? "observation_window_unavailable" : "recent_activity_evidence_unavailable",
      evidenceIds: recent.map((item) => item.evidence_id),
      observationWindow: window
    }
  );
}

function projectsRequirement(sourceItems) {
  const projects = sourceItems.filter((item) => usableProvidedItem(item) && PROJECT_ITEM_TYPES.has(item?.item_type));
  return moduleResult(
    "projects",
    projects.length > 0,
    projects.length
      ? `${projects.length} supplied-source project or repository ${projects.length === 1 ? "item was" : "items were"} collected`
      : "The requested projects module has no supplied-source project or repository item",
    { barrier: "project_evidence_unavailable", evidenceIds: projects.map((item) => item.evidence_id) }
  );
}

function explicitCompletion(moduleName, completionRecords, sourceItems, customInstructions = null) {
  const record = completionRecords.find((candidate) => candidate?.module === moduleName);
  if (!record) return null;
  const usableEvidenceIds = new Set(sourceItems.filter(usableProvidedItem).map((item) => item.evidence_id));
  const evidenceIds = Array.isArray(record.evidence_ids) ? [...new Set(record.evidence_ids.map(String))] : [];
  const statement = String(record.statement ?? "").trim();
  const instructionsMatch = customInstructions === null || record.instructions === customInstructions;
  const valid = record.status === "satisfied"
    && record.method === "active_evidence_linked_pass"
    && statement.length > 0
    && evidenceIds.length > 0
    && evidenceIds.every((id) => usableEvidenceIds.has(id))
    && instructionsMatch;
  return { valid, evidenceIds, statement };
}

function activePassRequirement(moduleName, completionRecords, sourceItems) {
  const completion = explicitCompletion(moduleName, completionRecords, sourceItems);
  return moduleResult(
    moduleName,
    completion?.valid === true,
    completion?.valid
      ? `An explicit active evidence-linked pass completed the requested ${moduleName.replaceAll("_", " ")} module`
      : `The requested ${moduleName.replaceAll("_", " ")} module requires an active cited pass; collected metadata does not satisfy it`,
    {
      barrier: completion ? "invalid_completion_record" : "active_cited_pass_not_run",
      evidenceIds: completion?.evidenceIds ?? []
    }
  );
}

function mediaRequirement(sourceItems) {
  const videos = sourceItems.filter((item) => usableProvidedItem(item) && VIDEO_ITEM_TYPES.has(item?.item_type));
  const transcriptUrls = new Set(sourceItems
    .filter((item) => usableProvidedItem(item)
      && item?.item_type === "video_transcript"
      && String(item?.text ?? "").trim())
    .map((item) => String(item.canonical_url)));
  const missingTranscripts = videos.filter((item) => !transcriptUrls.has(String(item.canonical_url)));
  const satisfied = videos.length > 0 && missingTranscripts.length === 0;
  return {
    module: "media",
    status: satisfied ? "satisfied" : "unsatisfied",
    satisfied,
    barrier: satisfied ? null : "media_modality_unavailable",
    evidence_ids: satisfied
      ? sourceItems.filter((item) => usableProvidedItem(item) && item?.item_type === "video_transcript").map((item) => item.evidence_id)
      : [],
    reason: satisfied
      ? `Usable transcript evidence was collected for all ${videos.length} collected ${videos.length === 1 ? "video" : "videos"}`
      : videos.length
        ? `${missingTranscripts.length} of ${videos.length} collected ${videos.length === 1 ? "video has" : "videos have"} no usable transcript or speech review`
        : "The requested media module has no collected video with a usable transcript or speech review"
  };
}

function customInstructionsRequirement(customInstructions, completionRecords, sourceItems) {
  const completion = explicitCompletion("custom_instructions", completionRecords, sourceItems, customInstructions);
  return moduleResult(
    "custom_instructions",
    completion?.valid === true,
    completion?.valid
      ? "An explicit evidence-linked completion record covers the exact custom instructions"
      : "Non-empty custom instructions require an explicit evidence-linked completion record for the exact instruction text",
    {
      barrier: completion ? "invalid_completion_record" : "custom_instructions_not_completed",
      evidenceIds: completion?.evidenceIds ?? []
    }
  );
}

/**
 * Assess every requested module and any custom instructions. The local
 * deterministic runner can close only the factual modules for which it has a
 * declared evidence rule. It cannot treat source metadata as an active cited
 * pass.
 */
export function assessModuleRequirements({
  requestedModules = [],
  sourceItems = [],
  identity,
  observedAt,
  completionRecords = [],
  customInstructions = ""
} = {}) {
  checkedArray(requestedModules, "requestedModules");
  checkedArray(sourceItems, "sourceItems");
  checkedArray(completionRecords, "completionRecords");
  const requested = [...new Set(requestedModules.map(String))];
  const identitySatisfied = identity?.satisfied === true || identity?.status === "confirmed" || identity === "confirmed";
  const results = requested.map((moduleName) => {
    if (moduleName === "identity") {
      return moduleResult(
        moduleName,
        identitySatisfied,
        identitySatisfied ? "The identity closure axis is confirmed" : "The identity closure axis remains open",
        { barrier: "identity_not_confirmed" }
      );
    }
    if (moduleName === "current_activity") return currentActivityRequirement(sourceItems, observedAt);
    if (moduleName === "timeline") return timelineRequirement(sourceItems);
    if (moduleName === "projects") return projectsRequirement(sourceItems);
    if (moduleName === "media") return mediaRequirement(sourceItems);
    if (ACTIVE_CITED_PASS_MODULES.has(moduleName)) return activePassRequirement(moduleName, completionRecords, sourceItems);
    return moduleResult(moduleName, false, `No closure rule is implemented for the requested ${moduleName.replaceAll("_", " ")} module`, {
      barrier: "module_closure_rule_unavailable"
    });
  });
  if (String(customInstructions).trim()) {
    results.push(customInstructionsRequirement(String(customInstructions), completionRecords, sourceItems));
  }
  const gaps = results.filter((result) => !result.satisfied);
  return {
    status: gaps.length ? "unsatisfied" : (results.length ? "satisfied" : "not_applicable"),
    satisfied: gaps.length === 0,
    scope: "all_requested_modules_and_custom_instructions",
    requested_modules: requested,
    evaluated_modules: results.map((result) => result.module),
    unevaluated_modules: [],
    results,
    gaps,
    reasons: gaps.length
      ? ["One or more requested modules or custom instructions still require evidence, modality collection or an active cited pass"]
      : [results.length
        ? "Every requested module and custom instruction requirement was satisfied"
        : "No module or custom instruction requirement was requested"]
  };
}

function assessInsight(collection) {
  const satisfied = collection.supplied_material_targets > 0
    && collection.useful_supplied_material_targets === collection.supplied_material_targets;
  const optionalGaps = collection.optional_discovery_gaps.length > 0;
  const collectionGaps = collection.coverage_gaps.length > 0;
  return {
    mode: "insight",
    status: satisfied
      ? (collectionGaps
        ? "satisfied_with_collection_gaps"
        : (optionalGaps ? "satisfied_with_optional_gaps" : "satisfied"))
      : "unsatisfied",
    satisfied,
    reasons: satisfied
      ? ["All supplied material targets returned useful material; optional discovery does not block insight closure"]
      : ["Insight closure requires useful material from every supplied material target"]
  };
}

function familyId(family, index) {
  return String(family?.id ?? family?.platform ?? `family-${index + 1}`);
}

function isoDateTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return null;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}

function isCredentialFreeHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isEvidenceReceiptReference(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-z0-9._/-]+\.json$/i.test(String(value.path ?? ""))
    && /^[a-f0-9]{64}$/.test(String(value.sha256 ?? ""));
}

function hasExhaustedDenominatorEvidence(enumeration) {
  return Array.isArray(enumeration?.adapters) && enumeration.adapters.some((adapter) => (
    adapter?.coverage_role === "denominator"
    && adapter?.status === "exhausted"
    && isEvidenceReceiptReference(adapter?.receipt)
  ));
}

function dateIntervalGap(enumeration, family, index) {
  if (enumeration?.target?.kind !== "date_interval") return null;
  const intervals = Array.isArray(enumeration.query_intervals) ? [...enumeration.query_intervals] : [];
  if (!intervals.length) {
    return { id: familyId(family, index), reason: "A date interval requires gap-free exhausted query intervals" };
  }
  intervals.sort((left, right) => String(left?.start ?? "").localeCompare(String(right?.start ?? "")));
  let expectedStart = enumeration.target.start;
  for (const interval of intervals) {
    const startTimestamp = isoDateTimestamp(interval?.start);
    const endTimestamp = isoDateTimestamp(interval?.end);
    if (interval?.status !== "exhausted" || startTimestamp === null || endTimestamp === null || startTimestamp >= endTimestamp || interval.start !== expectedStart) {
      return { id: familyId(family, index), reason: "Date query intervals must be valid, exhausted and gap-free" };
    }
    expectedStart = interval.end;
  }
  if (expectedStart !== enumeration.target.end) {
    return { id: familyId(family, index), reason: "Date query intervals do not cover the complete declared interval" };
  }
  return null;
}

function boundedFamilyGap(family, index) {
  const enumeration = family?.enumeration;
  if (!enumeration || typeof enumeration !== "object" || Array.isArray(enumeration)) {
    return { id: familyId(family, index), reason: "An explicit boundary and denominator closure are missing" };
  }
  if (enumeration.status !== "closed") {
    return { id: familyId(family, index), reason: "The declared boundary is not closed" };
  }
  if (!enumeration.target || !BOUNDARY_KINDS.has(enumeration.target.kind)) {
    return { id: familyId(family, index), reason: "The enumeration does not declare a supported boundary" };
  }
  if (enumeration.target.kind === "date_interval") {
    const { start, end } = enumeration.target;
    const startTimestamp = isoDateTimestamp(start);
    const endTimestamp = isoDateTimestamp(end);
    if (startTimestamp === null || endTimestamp === null || startTimestamp >= endTimestamp) {
      return { id: familyId(family, index), reason: "A date interval requires valid start and end dates with start before end" };
    }
    const intervalGap = dateIntervalGap(enumeration, family, index);
    if (intervalGap) return intervalGap;
  }
  const accountBoundary = enumeration.target.account_url ?? family?.account_url;
  if (!isCredentialFreeHttpsUrl(accountBoundary)) {
    return { id: familyId(family, index), reason: "The boundary requires a credential-free HTTPS account URL" };
  }
  if (!CLOSING_DENOMINATORS.has(enumeration.denominator_basis)) {
    return { id: familyId(family, index), reason: "The enumeration has no denominator capable of closing the boundary" };
  }
  if (!hasExhaustedDenominatorEvidence(enumeration)) {
    return { id: familyId(family, index), reason: "Closed enumeration requires hash-referenced exhausted denominator evidence" };
  }
  if (!Number.isInteger(enumeration.enumerated_count) || enumeration.enumerated_count < 0) {
    return { id: familyId(family, index), reason: "The enumerated denominator count must be a non-negative integer" };
  }
  if (["complete_first_party_export", "complete_api_listing"].includes(enumeration.denominator_basis)
      && (!Number.isInteger(enumeration.expected_count)
        || enumeration.expected_count < 0
        || enumeration.expected_count !== enumeration.enumerated_count)) {
    return { id: familyId(family, index), reason: "The expected denominator count must equal the enumerated count" };
  }
  if (enumeration.denominator_basis === "displayed_total_reconciled"
      && (!Number.isInteger(enumeration.displayed_total)
        || enumeration.displayed_total < 0
        || enumeration.displayed_total !== enumeration.enumerated_count)) {
    return { id: familyId(family, index), reason: "The displayed total must be reconciled to the enumerated count" };
  }
  if (enumeration.expected_count !== undefined
      && (!Number.isInteger(enumeration.expected_count)
        || enumeration.expected_count < 0
        || enumeration.expected_count !== enumeration.enumerated_count)) {
    return { id: familyId(family, index), reason: "The declared expected count does not match the enumerated count" };
  }
  return null;
}

function assessBoundedCensus(sourceFamilies) {
  const materialFamilies = sourceFamilies.filter((family) => family?.material !== false);
  const gaps = materialFamilies
    .map(boundedFamilyGap)
    .filter(Boolean);
  if (!materialFamilies.length) gaps.push({ id: null, reason: "No material source family declares the census boundary" });
  const satisfied = materialFamilies.length > 0 && gaps.length === 0;
  return {
    mode: "bounded_census",
    status: satisfied ? "satisfied" : "unsatisfied",
    satisfied,
    material_families: materialFamilies.length,
    gaps,
    reasons: satisfied
      ? ["Every material source family has an explicit closed boundary and reconciled denominator"]
      : ["Bounded census closure requires an explicit closed boundary and reconciled denominator for every material family"]
  };
}

function coverageGap(family, index) {
  return {
    id: familyId(family, index),
    reason: "Material family coverage_complete is not true"
  };
}

function assessMaximumCoverage(sourceFamilies) {
  const indexed = sourceFamilies.map((family, index) => ({ family, index }));
  const optionalFamilies = indexed.filter(({ family }) => family?.material === false && (
    family?.optional_discovery === true || family?.source_role === "optional_discovery"
  ));
  const optionalIndexes = new Set(optionalFamilies.map(({ index }) => index));
  const materialFamilies = indexed.filter(({ index }) => !optionalIndexes.has(index));
  const gaps = materialFamilies.flatMap(({ family, index }) => {
    if (family?.material === false) {
      return [{ id: familyId(family, index), reason: "A supplied family cannot be demoted to non-material in maximum coverage" }];
    }
    if (family?.coverage_complete !== true) return [coverageGap(family, index)];
    const enumerationGap = boundedFamilyGap(family, index);
    return enumerationGap ? [enumerationGap] : [];
  });
  if (!materialFamilies.length) gaps.push({ id: null, reason: "No material source family was declared" });
  const optionalGaps = optionalFamilies
    .filter(({ family }) => family?.coverage_complete !== true)
    .map(({ family, index }) => ({ ...coverageGap(family, index), material: false }));
  const satisfied = materialFamilies.length > 0 && gaps.length === 0;
  return {
    mode: "maximum_public_coverage",
    status: satisfied
      ? (optionalGaps.length ? "satisfied_with_optional_gaps" : "satisfied")
      : "unsatisfied",
    satisfied,
    material_families: materialFamilies.length,
    gaps,
    optional_gaps: optionalGaps,
    reasons: satisfied
      ? ["Every material source family explicitly records coverage_complete"]
      : ["Maximum public coverage requires coverage_complete for every material source family"]
  };
}

export function assessResearchModeClosure({ researchMode, collection, sourceFamilies = [] } = {}) {
  if (!RESEARCH_MODES.has(researchMode)) throw new TypeError(`Unsupported research mode: ${researchMode}`);
  if (!collection || typeof collection !== "object" || Array.isArray(collection)) {
    throw new TypeError("collection assessment is required");
  }
  checkedArray(sourceFamilies, "sourceFamilies");
  if (researchMode === "insight") return assessInsight(collection);
  if (researchMode === "bounded_census") return assessBoundedCensus(sourceFamilies);
  return assessMaximumCoverage(sourceFamilies);
}

function familyReconciliationGaps(targets, sourceFamilies) {
  const familyById = new Map(sourceFamilies.map((family, index) => [familyId(family, index), family]));
  return targets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => isMaterialTarget(target))
    .flatMap(({ target, index }) => {
      const id = targetId(target, index);
      const family = familyById.get(id);
      if (!family) return [{ id, reason: "A supplied material target has no matching source family" }];
      if (family.material === false) return [{ id, reason: "A supplied material target cannot be represented by a non-material source family" }];
      return [];
    });
}

/**
 * Assess source collection, identity, research-mode closure and every requested
 * module or custom instruction. Identity does not silently promote or demote a
 * collection result, so callers can describe each state precisely. Targets
 * default to supplied and material; `platform: "web_search"`,
 * `source_role: "optional_discovery"` or `optional_discovery: true` marks an
 * optional discovery target. Bounded and maximum modes also require explicit
 * source-family records.
 */
export function assessClosure({
  researchMode,
  targets = [],
  sourceFamilies = [],
  identity,
  requestedModules = [],
  sourceItems = [],
  observedAt,
  completionRecords = [],
  customInstructions = ""
} = {}) {
  if (!RESEARCH_MODES.has(researchMode)) throw new TypeError(`Unsupported research mode: ${researchMode}`);
  checkedArray(sourceFamilies, "sourceFamilies");
  const collection = assessCollectionClosure(targets);
  const identityAxis = assessIdentityClosure(identity);
  const moduleRequirements = assessModuleRequirements({
    requestedModules,
    sourceItems,
    identity: identityAxis,
    observedAt,
    completionRecords,
    customInstructions
  });
  let researchModeAxis = assessResearchModeClosure({ researchMode, collection, sourceFamilies });
  if (researchMode !== "insight") {
    const reconciliationGaps = familyReconciliationGaps(targets, sourceFamilies);
    if (reconciliationGaps.length) {
      researchModeAxis = {
        ...researchModeAxis,
        status: "unsatisfied",
        satisfied: false,
        gaps: [...(researchModeAxis.gaps ?? []), ...reconciliationGaps],
        reasons: [...researchModeAxis.reasons, "Every supplied material target must have one material source family"]
      };
    }
  }

  return {
    collection,
    identity: identityAxis,
    research_mode: researchModeAxis,
    module_requirements: moduleRequirements,
    run_status: collection.status === "failed"
      ? "failed"
      : (identityAxis.satisfied && researchModeAxis.satisfied && moduleRequirements.satisfied ? "completed" : "partial"),
    run_status_scope: "collection_identity_research_mode_and_module_requirements",
    research_mode_satisfied: researchModeAxis.satisfied,
    gaps: {
      material: collection.material_gaps,
      collection_coverage: collection.coverage_gaps,
      optional_discovery: collection.optional_discovery_gaps,
      identity: identityAxis.satisfied ? [] : [{ status: identityAxis.status, reason: identityAxis.reason }],
      research_mode: researchModeAxis.gaps ?? [],
      module_requirements: moduleRequirements.gaps
    }
  };
}
