const ACCESS_BARRIERS = Object.freeze([
  { barrier: "authentication_required", pattern: /\b(?:please\s+)?(?:sign|log)\s+in\s+(?:to\s+)?(?:continue|view|see|access)\b/i },
  { barrier: "authentication_required", pattern: /\bcookies? (?:are |is )?required\b/i },
  { barrier: "access_denied", pattern: /\baccess denied\b/i },
  { barrier: "challenge_required", pattern: /\b(?:captcha|verify you are human|checking your browser)\b/i },
  { barrier: "javascript_required", pattern: /\benable javascript\b/i },
  { barrier: "public_content_not_found", pattern: /\b(?:page|content|profile) (?:is |was )?(?:not found|not available|unavailable)\b/i },
  { barrier: "platform_rate_limited", pattern: /\b(?:too many requests|rate limit(?:ed)?)\b/i }
]);

const OPERATIONAL_KEYS = new Set([
  "adapter", "adapter_id", "backend", "barrier", "command", "diagnostic", "diagnostics",
  "health", "message", "route", "runtime", "status", "stderr", "stdout", "tool", "version"
]);

const SUBJECT_RECORD_KEYS = new Set([
  "author", "bio", "biography", "body", "caption", "code", "content", "created_at",
  "description", "display_name", "full_name", "id", "id_str", "joined_at", "message",
  "name", "permalink", "pk", "profile_url", "published_at", "screen_name", "shortcode",
  "taken_at", "text", "timestamp", "title", "url", "username", "web_url"
]);

export function classifyPublicText(value, options = {}) {
  const text = String(value ?? "").replace(/\0/g, "").trim();
  const minimumCharacters = options.minimumCharacters ?? 8;
  if (!text) return { usable: false, barrier: "empty_response" };
  if (text.length <= 2_000) {
    const match = ACCESS_BARRIERS.find(({ pattern }) => pattern.test(text));
    if (match) return { usable: false, barrier: match.barrier };
  }
  if (text.length < minimumCharacters) return { usable: false, barrier: "insufficient_subject_material" };
  return { usable: true, barrier: null };
}

export function hasSubjectRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).some(([key, field]) => (
    SUBJECT_RECORD_KEYS.has(key.toLowerCase())
    && field !== null
    && field !== undefined
    && (typeof field !== "string" || field.trim().length > 0)
  ));
}

export function isOperationalMetadataOnly(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => OPERATIONAL_KEYS.has(key.toLowerCase()));
}
