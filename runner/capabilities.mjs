import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(nodeExecFile);

const COMMAND_OPTIONS = Object.freeze({
  encoding: "utf8",
  maxBuffer: 512 * 1024,
  shell: false,
  timeout: 15_000,
  windowsHide: true
});

const TOOL_DEFINITIONS = Object.freeze([
  { id: "github_cli", label: "GitHub CLI", command: "gh", args: ["--version"], versionKind: "github" },
  { id: "yt_dlp", label: "yt-dlp", command: "yt-dlp", args: ["--version"], versionKind: "generic" },
  { id: "agent_reach", label: "Agent Reach", command: "agent-reach", args: ["doctor", "--json"], doctor: true }
]);

const PLATFORM_LABELS = Object.freeze({
  github: "GitHub",
  twitter: "X (Twitter)",
  youtube: "YouTube",
  reddit: "Reddit",
  facebook: "Facebook",
  instagram: "Instagram",
  bilibili: "Bilibili",
  xiaohongshu: "Xiaohongshu",
  linkedin: "LinkedIn",
  xiaoyuzhou: "Xiaoyuzhou podcasts",
  v2ex: "V2EX",
  xueqiu: "Xueqiu",
  rss: "RSS and Atom feeds",
  exa_search: "Web discovery (Exa)",
  web: "Public web pages"
});

const SAFE_BACKENDS = Object.freeze({
  github: Object.freeze({ "gh cli": "GitHub CLI" }),
  twitter: Object.freeze({ "twitter-cli": "twitter-cli", opencli: "OpenCLI", "bird cli (legacy)": "bird CLI (legacy)" }),
  youtube: Object.freeze({ "yt-dlp": "yt-dlp", opencli: "OpenCLI" }),
  reddit: Object.freeze({ opencli: "OpenCLI", "rdt-cli": "rdt-cli" }),
  facebook: Object.freeze({ opencli: "OpenCLI" }),
  instagram: Object.freeze({ opencli: "OpenCLI" }),
  bilibili: Object.freeze({ "bili-cli": "bili-cli", opencli: "OpenCLI" }),
  xiaohongshu: Object.freeze({ opencli: "OpenCLI", "xiaohongshu-mcp": "xiaohongshu-mcp", "xhs-cli": "xhs-cli" }),
  linkedin: Object.freeze({ "mcp-server-linkedin": "LinkedIn MCP", "jina reader": "Jina Reader" }),
  xiaoyuzhou: Object.freeze({ "groq-whisper": "Groq Whisper" }),
  v2ex: Object.freeze({ "v2ex api (public)": "V2EX public API" }),
  xueqiu: Object.freeze({ "xueqiu api": "Xueqiu API" }),
  rss: Object.freeze({ feedparser: "feedparser" }),
  exa_search: Object.freeze({ "exa via mcporter": "Exa via mcporter" }),
  web: Object.freeze({ "jina reader": "Jina Reader" })
});

const RUNNER_COLLECTABLE_PLATFORMS = new Set([
  "exa_search",
  "facebook",
  "github",
  "instagram",
  "linkedin",
  "twitter",
  "web",
  "youtube"
]);

const STATE_LABELS = Object.freeze({
  ready: "Ready",
  check_needed: "Check needed",
  unavailable: "Unavailable",
  check_failed: "Check failed",
  unknown: "Unknown"
});

function toolState(definition, state, detail, version) {
  return {
    id: definition.id,
    label: definition.label,
    state,
    state_label: STATE_LABELS[state],
    ...(version ? { version } : {}),
    detail
  };
}

function safeVersion(stdout, kind) {
  const text = String(stdout ?? "").slice(0, 512);
  const match = kind === "github"
    ? text.match(/\bgh version\s+([0-9]+(?:\.[0-9A-Za-z-]+){1,4})\b/i)
    : text.match(/\b([0-9]{1,4}(?:\.[0-9A-Za-z-]+){1,4})\b/);
  return match?.[1]?.slice(0, 40);
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalisePlatformState(value) {
  if (value === "ok") {
    return {
      state: "ready",
      detail: "A local read route is available."
    };
  }
  if (value === "warn") {
    return {
      state: "check_needed",
      detail: "A route may be configured, but it has not been live-verified."
    };
  }
  if (value === "off") {
    return {
      state: "unavailable",
      detail: "No local read route is currently available."
    };
  }
  return {
    state: "unknown",
    detail: "Agent Reach returned an unrecognised route state."
  };
}

function safeBackend(platformId, value) {
  if (typeof value !== "string") return undefined;
  return SAFE_BACKENDS[platformId]?.[value.trim().toLowerCase()];
}

function parseDoctorReport(stdout) {
  let report;
  try {
    report = JSON.parse(String(stdout ?? "").slice(0, COMMAND_OPTIONS.maxBuffer));
  } catch {
    return { ok: false, platforms: [] };
  }
  if (!isPlainRecord(report)) return { ok: false, platforms: [] };

  const platforms = [];
  for (const [id, rawCapability] of Object.entries(report)) {
    if (!Object.hasOwn(PLATFORM_LABELS, id) || !isPlainRecord(rawCapability)) continue;
    const normalised = normalisePlatformState(rawCapability.status);
    const backend = safeBackend(id, rawCapability.active_backend);
    const runnerCollectable = RUNNER_COLLECTABLE_PLATFORMS.has(id);
    platforms.push({
      id,
      label: PLATFORM_LABELS[id],
      state: normalised.state,
      state_label: STATE_LABELS[normalised.state],
      ...(backend ? { backend } : {}),
      detail: normalised.detail,
      runner_collectable: runnerCollectable,
      runner_support: runnerCollectable ? "implemented" : "detected_only",
      runner_detail: runnerCollectable
        ? "This runner has a collection adapter for the route."
        : "Agent Reach detected this route, but its collector is not implemented by this runner yet."
    });
  }
  return { ok: true, platforms };
}

async function runCheck(execFileImpl, definition) {
  try {
    const result = await execFileImpl(definition.command, [...definition.args], { ...COMMAND_OPTIONS });
    return { kind: "success", stdout: String(result?.stdout ?? "").slice(0, COMMAND_OPTIONS.maxBuffer) };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    if (error?.killed || error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT") {
      return { kind: "timeout" };
    }
    return { kind: "failed" };
  }
}

function platformCounts(platforms) {
  const counts = { ready: 0, check_needed: 0, unavailable: 0, unknown: 0 };
  for (const platform of platforms) counts[platform.state] += 1;
  return counts;
}

function summaryFor(tools, platforms) {
  const toolValues = Object.values(tools);
  const toolsReady = toolValues.filter(({ state }) => state === "ready").length;
  const counts = platformCounts(platforms);
  const collectableReady = platforms.filter(({ state, runner_collectable: collectable }) => state === "ready" && collectable).length;
  const detectedOnlyReady = platforms.filter(({ state, runner_collectable: collectable }) => state === "ready" && !collectable).length;
  let text;
  if (toolValues.every(({ state }) => state === "unavailable")) {
    text = "No optional research tools were detected. Install only the routes needed for this research job.";
  } else {
    text = `${toolsReady} of ${toolValues.length} research tools are ready.`;
    if (platforms.length > 0) {
      text += ` Agent Reach reports ${counts.ready} ready platform ${counts.ready === 1 ? "route" : "routes"}, ${counts.check_needed} needing a check and ${counts.unavailable} unavailable.`;
      if (detectedOnlyReady) text += ` ${collectableReady} ready ${collectableReady === 1 ? "route is" : "routes are"} collectable by this runner; ${detectedOnlyReady} ${detectedOnlyReady === 1 ? "route is" : "routes are"} detection-only.`;
    }
  }
  return {
    tools_ready: toolsReady,
    tools_total: toolValues.length,
    platforms_ready: counts.ready,
    platforms_check_needed: counts.check_needed,
    platforms_unavailable: counts.unavailable,
    platforms_unknown: counts.unknown,
    platforms_collectable_ready: collectableReady,
    platforms_detected_only_ready: detectedOnlyReady,
    text
  };
}

/**
 * Detect read-only research capabilities available on the local machine.
 * Command output and environment values are deliberately excluded from the result.
 */
export async function detectLocalCapabilities({ execFileImpl = execFileAsync, now = () => new Date() } = {}) {
  const checks = await Promise.all(TOOL_DEFINITIONS.map((definition) => runCheck(execFileImpl, definition)));
  const tools = {};
  let platforms = [];

  for (let index = 0; index < TOOL_DEFINITIONS.length; index += 1) {
    const definition = TOOL_DEFINITIONS[index];
    const check = checks[index];
    if (check.kind === "missing") {
      tools[definition.id] = toolState(definition, "unavailable", "Not installed. This research route is optional.");
      continue;
    }
    if (check.kind === "timeout") {
      tools[definition.id] = toolState(definition, "check_failed", "The local check timed out.");
      continue;
    }
    if (check.kind === "failed") {
      tools[definition.id] = toolState(definition, "check_failed", "The local check did not complete successfully.");
      continue;
    }

    if (definition.doctor) {
      const doctor = parseDoctorReport(check.stdout);
      if (!doctor.ok) {
        tools[definition.id] = toolState(definition, "check_failed", "Agent Reach returned an unreadable capability report.");
      } else {
        tools[definition.id] = toolState(
          definition,
          "ready",
          "Installed and its capability report was read successfully."
        );
        platforms = doctor.platforms;
      }
      continue;
    }

    const version = safeVersion(check.stdout, definition.versionKind);
    tools[definition.id] = toolState(
      definition,
      "ready",
      version ? `Installed (version ${version}).` : "Installed.",
      version
    );
  }

  return {
    checked_at: new Date(now()).toISOString(),
    tools,
    platforms,
    summary: summaryFor(tools, platforms)
  };
}
