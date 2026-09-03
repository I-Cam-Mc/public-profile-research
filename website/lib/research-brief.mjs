const PURPOSES = new Set([
  "self_audit",
  "founder_diligence",
  "investor_diligence",
  "dating_safety",
  "marketplace_safety",
  "journalism",
  "general"
]);

const DEPTHS = new Set(["quick", "standard", "deep", "maximum"]);
const RESEARCH_MODES = new Set(["insight", "bounded_census", "maximum_public_coverage"]);
const RELATIONSHIPS = new Set(["self", "authorised_representative", "third_party"]);
const CORPUS_SCOPES = new Set(["public_only", "public_plus_subject_provided"]);
const IDENTITY_STATES = new Set(["unconfirmed", "candidates", "confirmed", "conflict"]);
const MAX_ANCHORS = 25;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 200;
const MAX_INSTRUCTIONS_LENGTH = 10_000;
const CREDENTIAL_QUERY_PARAMETER_NAMES = new Set([
  "accesstoken", "apikey", "apitoken", "auth", "authtoken", "authorization",
  "bearer", "clientsecret", "credential", "credentials", "idtoken", "jwt", "key",
  "oauthcode", "password", "passwd", "refreshtoken", "secret", "session", "sessionid",
  "sessionkey", "sessiontoken", "sig", "signature", "token", "xamzcredential",
  "xamzsecuritytoken", "xamzsignature", "xgoogcredential", "xgoogsignature"
]);

const RESERVED_PROFILE_PATHS = Object.freeze({
  facebook: new Set(["events", "groups", "login", "marketplace", "people", "profile.php", "reel", "share", "stories", "watch"]),
  github: new Set(["about", "apps", "collections", "contact", "customer-stories", "enterprise", "events", "explore", "features", "issues", "login", "marketplace", "new", "notifications", "organizations", "orgs", "pricing", "pulls", "search", "security", "settings", "site", "sponsors", "topics", "trending"]),
  instagram: new Set(["accounts", "direct", "explore", "p", "reel", "reels", "stories"]),
  x: new Set(["compose", "explore", "home", "i", "intent", "messages", "notifications", "search", "settings", "share"])
});

const MODULES = new Set([
  "identity",
  "current_activity",
  "timeline",
  "career",
  "projects",
  "companies",
  "public_impression",
  "public_persona",
  "credibility",
  "controversies",
  "professional_network",
  "media",
  "code",
  "commercial_activity"
]);

export const SERVICE_TIERS = Object.freeze([
  {
    id: "open",
    name: "Open",
    priceUsd: 0,
    depth: "quick",
    methodAccess: "full_open_source_method",
    scopePolicy: "same_public_scope",
    budget: { maxItems: 20, maxQueries: 6, maxMediaMinutes: 0, maxRuntimeMinutes: 10 }
  },
  {
    id: "snapshot",
    name: "Snapshot",
    priceUsd: 20,
    depth: "quick",
    methodAccess: "full_open_source_method",
    scopePolicy: "same_public_scope",
    budget: { maxItems: 60, maxQueries: 15, maxMediaMinutes: 0, maxRuntimeMinutes: 30 }
  },
  {
    id: "profile",
    name: "Profile",
    priceUsd: 80,
    depth: "deep",
    methodAccess: "full_open_source_method",
    scopePolicy: "same_public_scope",
    budget: { maxItems: 250, maxQueries: 50, maxMediaMinutes: 60, maxRuntimeMinutes: 180 }
  },
  {
    id: "diligence",
    name: "Diligence",
    priceUsd: 200,
    depth: "maximum",
    methodAccess: "full_open_source_method",
    scopePolicy: "same_public_scope",
    budget: { maxItems: 1000, maxQueries: 150, maxMediaMinutes: 240, maxRuntimeMinutes: 480 }
  }
]);

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function isCredentialQueryParameter(name) {
  return CREDENTIAL_QUERY_PARAMETER_NAMES.has(String(name).toLowerCase().replace(/[^a-z0-9]+/g, ""));
}

function checkedIdentityAnchor(value) {
  const anchor = String(value).trim();
  if (anchor.length > MAX_URL_LENGTH) throw new TypeError("Identity anchor URLs are too long");
  const url = new URL(anchor);
  if (url.protocol !== "https:") throw new TypeError("Identity anchors must use HTTPS URLs");
  if (url.username || url.password) throw new TypeError("Identity anchors must not contain credentials");
  if ([...url.searchParams.keys()].some(isCredentialQueryParameter)) {
    throw new TypeError("Identity anchor query parameters must not contain credentials");
  }
  const shapeError = publicProfileShapeError(url);
  if (shapeError) throw new TypeError(shapeError);
  url.hash = "";
  return url.href;
}

function identityAnchors(values) {
  const supplied = (values ?? []).map((value) => String(value).trim()).filter(Boolean);
  const anchors = [...new Set(supplied.map(checkedIdentityAnchor))];
  if (!anchors.length) throw new TypeError("At least one identity anchor is required");
  if (anchors.length > MAX_ANCHORS) throw new TypeError(`At most ${MAX_ANCHORS} identity anchors may be researched in one local run`);
  return anchors;
}

function publicProfileShapeError(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const first = parts[0]?.replace(/^@/, "") ?? "";
  if (host === "github.com") {
    return parts.length === 1 && /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(first) && !RESERVED_PROFILE_PATHS.github.has(first.toLowerCase())
      ? null
      : "GitHub identity anchors must be a supported public profile URL with one username segment";
  }
  if (host === "instagram.com") {
    return parts.length === 1 && /^[a-z0-9](?:[a-z0-9._]{0,28}[a-z0-9_])?$/i.test(first) && !RESERVED_PROFILE_PATHS.instagram.has(first.toLowerCase())
      ? null
      : "Instagram identity anchors must be a supported public profile URL, not a post or navigation URL";
  }
  if (host === "x.com" || host === "twitter.com") {
    return parts.length === 1 && /^[a-z0-9_]{1,15}$/i.test(first) && !RESERVED_PROFILE_PATHS.x.has(first.toLowerCase())
      ? null
      : "X identity anchors must be a supported public profile URL with one valid handle";
  }
  if (host === "linkedin.com") {
    return parts.length === 2 && parts[0].toLowerCase() === "in" && /^[a-z0-9][a-z0-9._-]{0,99}$/i.test(parts[1])
      ? null
      : "LinkedIn identity anchors must use a supported public /in/handle profile URL";
  }
  if (host === "facebook.com") {
    return parts.length === 1 && /^[a-z0-9][a-z0-9.\-]{0,99}$/i.test(first) && !RESERVED_PROFILE_PATHS.facebook.has(first.toLowerCase())
      ? null
      : "Facebook identity anchors must use a supported public vanity profile URL";
  }
  if (host === "youtube.com") {
    const isHandle = parts.length === 1 && /^@[a-z0-9][a-z0-9._-]{1,29}$/i.test(parts[0]);
    const isLegacyProfile = parts.length === 2
      && ["c", "channel", "user"].includes(parts[0].toLowerCase())
      && /^[a-z0-9][a-z0-9._-]{1,99}$/i.test(parts[1]);
    return isHandle || isLegacyProfile
      ? null
      : "YouTube identity anchors must use a supported public channel or handle profile URL";
  }
  if (host === "youtu.be") {
    return "YouTube identity anchors must use a supported public channel or handle profile URL, not a video URL";
  }
  if (host === "tiktok.com") {
    return parts.length === 1 && /^@[a-z0-9][a-z0-9._]{1,23}$/i.test(parts[0])
      ? null
      : "TikTok identity anchors must use a supported public @handle profile URL, not a post URL";
  }
  return null;
}

function inferDisplayName(anchors) {
  const url = new URL(anchors[0]);
  const ignored = new Set(["in", "user", "users", "channel", "c", "profile"]);
  const parts = url.pathname.split("/").map((part) => decodeURIComponent(part).replace(/^@/, "").trim()).filter(Boolean);
  const candidate = [...parts].reverse().find((part) => !ignored.has(part.toLowerCase()));
  return candidate || url.hostname.replace(/^www\./, "").split(".")[0];
}

function checkedCustomInstructions(value) {
  const text = String(value ?? "").trim();
  if (text.length > MAX_INSTRUCTIONS_LENGTH) throw new TypeError(`Custom instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`);
  const restricted = /\b(home|residential|street) address\b|\bprecise (?:home )?location\b|\bdiagnos(?:e|is|ing|ed)\b|\b(?:has|have) (?:adhd|autism|bipolar|depression)\b|\b(?:private|hidden|locked) account\b|\b(?:password|login credential|authentication token)\b|\bcontact (?:their |his |her )?(?:family|friends|colleagues|associates)\b|\bidentify (?:a |the )?minor\b|\b(?:biometric identification|face recognition)\b/i;
  if (restricted.test(text)) {
    throw new TypeError("Custom instructions cannot request home addresses, diagnoses or other restricted personal research");
  }
  return text;
}

export function createResearchBrief(input) {
  const purpose = requiredText(input?.purpose, "purpose");
  const depth = requiredText(input?.depth, "depth");
  if (!PURPOSES.has(purpose)) throw new TypeError(`Unsupported purpose: ${purpose}`);
  if (!DEPTHS.has(depth)) throw new TypeError(`Unsupported depth: ${depth}`);
  const researchMode = String(input?.researchMode ?? "insight");
  if (!RESEARCH_MODES.has(researchMode)) throw new TypeError(`Unsupported research mode: ${researchMode}`);
  const relationship = String(input?.relationshipToSubject ?? (purpose === "self_audit" ? "self" : "third_party"));
  if (!RELATIONSHIPS.has(relationship)) throw new TypeError(`Unsupported relationship to subject: ${relationship}`);
  const corpusScope = String(input?.corpusScope ?? "public_only");
  if (!CORPUS_SCOPES.has(corpusScope)) throw new TypeError(`Unsupported corpus scope: ${corpusScope}`);
  if (corpusScope === "public_plus_subject_provided" && !["self", "authorised_representative"].includes(relationship)) {
    throw new TypeError("Subject-provided material requires self research or authorised representation");
  }

  const modules = [...new Set(input?.modules ?? [])];
  for (const moduleName of modules) {
    if (!MODULES.has(moduleName)) throw new TypeError(`Unsupported module: ${moduleName}`);
  }

  const anchors = identityAnchors(input?.profileUrls);
  const displayName = String(input?.subjectName ?? "").trim() || inferDisplayName(anchors);
  if (displayName.length > MAX_NAME_LENGTH) throw new TypeError(`Subject name must be at most ${MAX_NAME_LENGTH} characters`);
  const identityStatus = String(input?.identityStatus ?? "unconfirmed");
  if (!IDENTITY_STATES.has(identityStatus)) throw new TypeError(`Unsupported identity status: ${identityStatus}`);

  return {
    schema_version: 1,
    contract_type: "research_intake",
    research_state: "not_run",
    research_mode: researchMode,
    relationship_to_subject: relationship,
    corpus_scope: corpusScope,
    delivery_visibility: "private",
    retention_policy: "local_until_deleted",
    subject: {
      display_name: displayName,
      identity_anchors: anchors,
      identity_status: identityStatus
    },
    purpose,
    depth,
    cost_policy: "free_tools_only",
    modules,
    custom_instructions: checkedCustomInstructions(input?.customInstructions),
    analysis_policy: {
      distinguish_public_persona_from_private_personality: true,
      controversies_require_corroboration_and_response_context: true,
      credibility_is_claim_specific_not_a_global_score: true,
      missing_evidence_supports_neither_reassurance_nor_suspicion: true
    }
  };
}

export function validateResearchBrief(brief) {
  const errors = [];
  if (brief?.schema_version !== 1) errors.push("schema_version must be 1");
  if (brief?.contract_type !== "research_intake") errors.push("contract_type must be research_intake");
  const displayName = String(brief?.subject?.display_name ?? "").trim();
  if (!displayName) errors.push("subject.display_name is required");
  if (displayName.length > MAX_NAME_LENGTH) errors.push(`subject.display_name must be at most ${MAX_NAME_LENGTH} characters`);
  if (!Array.isArray(brief?.subject?.identity_anchors) || !brief.subject.identity_anchors.length) {
    errors.push("at least one identity anchor is required");
  } else {
    if (brief.subject.identity_anchors.length > MAX_ANCHORS) errors.push(`at most ${MAX_ANCHORS} identity anchors are allowed`);
    if (new Set(brief.subject.identity_anchors).size !== brief.subject.identity_anchors.length) errors.push("identity anchors must be unique");
    for (const anchor of brief.subject.identity_anchors) {
      try {
        if (typeof anchor !== "string" || anchor.length > MAX_URL_LENGTH) throw new Error("invalid length");
        const url = new URL(anchor);
        if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid public URL");
        if (url.hash) throw new Error("identity anchor fragments must be removed before research");
        if ([...url.searchParams.keys()].some(isCredentialQueryParameter)) throw new Error("credential query parameter");
        const shapeError = publicProfileShapeError(url);
        if (shapeError) throw new Error(shapeError);
      } catch {
        errors.push("identity anchors must be canonical, fragment-free and credential-free HTTPS URLs using a supported public profile shape");
        break;
      }
    }
  }
  if (!IDENTITY_STATES.has(brief?.subject?.identity_status)) errors.push("subject.identity_status is unsupported");
  if (!PURPOSES.has(brief?.purpose)) errors.push("purpose is unsupported");
  if (!DEPTHS.has(brief?.depth)) errors.push("depth is unsupported");
  if (!RESEARCH_MODES.has(brief?.research_mode)) errors.push("research_mode is unsupported");
  if (!RELATIONSHIPS.has(brief?.relationship_to_subject)) errors.push("relationship_to_subject is unsupported");
  if (!CORPUS_SCOPES.has(brief?.corpus_scope)) errors.push("corpus_scope is unsupported");
  if (brief?.corpus_scope === "public_plus_subject_provided" && !["self", "authorised_representative"].includes(brief?.relationship_to_subject)) {
    errors.push("subject-provided material requires self research or authorised representation");
  }
  if (brief?.research_state !== "not_run") errors.push("research_state must be not_run for an intake contract");
  if (brief?.delivery_visibility !== "private") errors.push("delivery_visibility must be private");
  if (!String(brief?.retention_policy ?? "").trim()) errors.push("retention_policy is required");
  if (brief?.cost_policy !== "free_tools_only") errors.push("cost_policy must be free_tools_only");
  if (!Array.isArray(brief?.modules)) {
    errors.push("modules must be an array");
  } else if (brief.modules.some((moduleName) => !MODULES.has(moduleName))) {
    errors.push("modules contain an unsupported value");
  } else if (new Set(brief.modules).size !== brief.modules.length) {
    errors.push("modules must be unique");
  }
  try {
    checkedCustomInstructions(brief?.custom_instructions);
  } catch (error) {
    errors.push(error.message);
  }
  if (!brief?.analysis_policy || typeof brief.analysis_policy !== "object" || Array.isArray(brief.analysis_policy)) {
    errors.push("analysis_policy must be an object");
  }
  return errors;
}

function readablePurpose(value) {
  return value.replaceAll("_", " ");
}

export function buildPortablePrompt(brief) {
  const errors = validateResearchBrief(brief);
  if (errors.length) throw new TypeError(errors.join("; "));
  const modules = brief.modules.length ? brief.modules.join(", ") : "identity, current activity, timeline and public impression";
  const custom = brief.custom_instructions ? `\nAdditional direction: ${brief.custom_instructions}` : "";
  return `Use the Public Profile Research workflow to research ${brief.subject.display_name} for ${readablePurpose(brief.purpose)}.

Identity anchors:
${brief.subject.identity_anchors.map((anchor) => `- ${anchor}`).join("\n")}

Depth: ${brief.depth}
Analysis modules: ${modules}
Cost policy: free tools only.${custom}

Begin with the adaptive intake and restate the proposed research contract for confirmation. Then perform real source collection with available browsing, search, platform and media tools. Maintain a complete evidence ledger, separate documented facts from public self-report and bounded inference, and report inaccessible or unresolved material. Do not turn missing evidence into reassurance. Do not assign a global trustworthiness score. Produce a Wikipedia-style profile with evidence-linked subpages and a coverage assessment.`;
}
