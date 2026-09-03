import { createDefaultAdapters } from "./adapters.mjs";
import { classifyPublicText } from "./evidence-quality.mjs";
import { assertPublicTargetUrl, createPublicFetch } from "./public-target.mjs";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const COMMAND_DEFAULTS = Object.freeze({
  timeout: 90_000,
  maxBuffer: 8 * 1024 * 1024,
  encoding: "utf8"
});
const READER_MAX_BYTES = 1_000_000;
const TRANSCRIPT_MAX_BYTES = 5_000_000;
const USER_AGENT = "public-profile-research/1.0 (+https://github.com/I-Cam-Mc/public-profile-research)";

function safeExecFile(execFileImpl) {
  return (command, args, options = {}) => {
    if (typeof command !== "string" || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new TypeError("Commands require a program name and a string argument array");
    }
    return execFileImpl(command, args, { ...COMMAND_DEFAULTS, ...options, shell: false });
  };
}

function scopedExecute(execute, context = {}) {
  return (command, args, options = {}) => execute(command, args, { signal: context.signal, ...options });
}

function profileHandle(target) {
  const url = new URL(target.canonical_url);
  const handle = url.pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "");
  if (!handle || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(handle)) {
    throw new TypeError(`${target.platform} profile URL must contain a valid public handle`);
  }
  return handle;
}

function linkedinHandle(target) {
  const parts = new URL(target.canonical_url).pathname.split("/").filter(Boolean);
  const marker = parts.findIndex((part) => part.toLowerCase() === "in");
  const handle = marker >= 0 ? parts[marker + 1] : undefined;
  if (!handle || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(handle)) {
    throw new TypeError("LinkedIn profile URL must use the /in/valid-public-handle form");
  }
  return handle;
}

function commandFailure(error) {
  return classifiedAdapterFailure(error);
}

function redactDiagnostics(value) {
  return String(value ?? "")
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|twitter_auth_token|twitter_ct0|cookie|session)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function classifiedAdapterFailure(error) {
  if (error?.code === "ENOENT") {
    return { status: "unavailable", barrier: "tool_missing", message: `${error.path ?? "Required command"} is not installed` };
  }
  const message = redactDiagnostics(error?.stderr || error?.message || error).slice(0, 20_000);
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) {
    return { status: "partial", barrier: "platform_rate_limited", message };
  }
  if (/\b(?:401|403)\b|login required|sign.?in|auth(?:entication|orisation|orization)?|cookie|session expired/i.test(message)) {
    return { status: "unavailable", barrier: "authentication_required", message };
  }
  if (/\b404\b|not found|does not exist/i.test(message)) {
    return { status: "unavailable", barrier: "public_content_not_found", message };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket|fetch failed|aborted|deadline|timed? ?out/i.test(message)) {
    return { status: "unavailable", barrier: "network_unavailable", message };
  }
  return { status: "failed", barrier: "adapter_error", message };
}

function agentReachXAdapter(execute, environment) {
  return {
    async collect(target, context = {}) {
      try {
        const run = scopedExecute(execute, context);
        const handle = profileHandle(target);
        const doctor = await run("agent-reach", ["doctor", "--json"]);
        const health = JSON.parse(doctor.stdout).twitter ?? {};
        if (health.status === "off") {
          return {
            status: "unavailable",
            barrier: "backend_unavailable",
            message: health.message || "No X backend is available",
            data: { health }
          };
        }
        const limits = { quick: 20, standard: 100, deep: 500, maximum: 2000 };
        const limit = limits[context.brief?.depth] ?? limits.standard;
        const backend = String(health.active_backend ?? "").toLowerCase();
        let profile;
        let posts;
        let coverage;
        let selectedBackend = health.active_backend;
        if (backend.includes("opencli")) {
          posts = await run("opencli", ["twitter", "user-posts", `@${handle}`, "-f", "json"]);
          coverage = "authenticated_public_profile_and_backend_default_recent_posts";
        } else if (!backend) {
          try {
            posts = await run("opencli", ["twitter", "user-posts", `@${handle}`, "-f", "json"]);
            coverage = "authenticated_public_profile_and_backend_default_recent_posts";
            selectedBackend = "OpenCLI (task probe)";
          } catch (openCliError) {
            if (environment.TWITTER_AUTH_TOKEN && environment.TWITTER_CT0) {
              profile = await run("twitter", ["user", `@${handle}`], { env: environment });
              posts = await run("twitter", ["user-posts", `@${handle}`, "-n", String(limit)], { env: environment });
              coverage = `authenticated_public_profile_and_up_to_${limit}_recent_posts`;
              selectedBackend = "twitter-cli";
            } else {
              return commandFailure(openCliError);
            }
          }
        } else if (environment.TWITTER_AUTH_TOKEN && environment.TWITTER_CT0) {
          profile = await run("twitter", ["user", `@${handle}`], { env: environment });
          posts = await run("twitter", ["user-posts", `@${handle}`, "-n", String(limit)], { env: environment });
          coverage = `authenticated_public_profile_and_up_to_${limit}_recent_posts`;
        } else {
          return {
            status: "unavailable",
            barrier: "authentication_required",
            message: health.message || "X access requires an authenticated Agent Reach backend",
            data: { health }
          };
        }
        return {
          status: "collected",
          coverage,
          coverage_complete: false,
          data: {
            backend: selectedBackend,
            profile: profile?.stdout ?? "",
            posts: posts.stdout
          },
          source_urls: [target.canonical_url]
        };
      } catch (error) {
        return commandFailure(error);
      }
    }
  };
}

function agentReachFacebookAdapter(execute) {
  return {
    async collect(target, context = {}) {
      try {
        const run = scopedExecute(execute, context);
        const handle = profileHandle(target);
        const doctor = await run("agent-reach", ["doctor", "--json"]);
        const health = JSON.parse(doctor.stdout).facebook ?? {};
        if (health.status === "off") {
          return {
            status: "unavailable",
            barrier: "backend_unavailable",
            message: health.message || "No Facebook backend is available",
            data: { health }
          };
        }
        if (!String(health.active_backend ?? "").toLowerCase().includes("opencli")) {
          return {
            status: "unavailable",
            barrier: "authentication_required",
            message: health.message || "Facebook access requires a signed-in OpenCLI session",
            data: { health }
          };
        }
        const profile = await run("opencli", ["facebook", "profile", handle, "-f", "json"]);
        return {
          status: "collected",
          coverage: "authenticated_public_profile",
          coverage_complete: false,
          data: { backend: health.active_backend, profile: profile.stdout },
          source_urls: [target.canonical_url]
        };
      } catch (error) {
        return commandFailure(error);
      }
    }
  };
}

function agentReachLinkedinAdapter(execute) {
  return {
    async collect(target, context = {}) {
      try {
        const run = scopedExecute(execute, context);
        const handle = linkedinHandle(target);
        const doctor = await run("agent-reach", ["doctor", "--json"]);
        const health = JSON.parse(doctor.stdout).linkedin ?? {};
        if (health.status === "off") {
          return {
            status: "unavailable",
            barrier: "backend_unavailable",
            message: health.message || "No LinkedIn backend is available",
            data: { health }
          };
        }
        const profile = await run("mcporter", [
          "call",
          "linkedin.get_person_profile",
          `linkedin_username=${handle}`,
          "sections=experience,education"
        ]);
        return {
          status: "collected",
          coverage: "authenticated_public_profile_experience_and_education",
          coverage_complete: false,
          data: { backend: health.active_backend ?? "mcp-server-linkedin", profile: profile.stdout },
          source_urls: [target.canonical_url]
        };
      } catch (error) {
        return commandFailure(error);
      }
    }
  };
}

function maybeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function publicHttpUrls(value, limit = 100) {
  const discovered = [];
  const seen = new Set();
  const add = (candidate) => {
    if (discovered.length >= limit || typeof candidate !== "string") return;
    try {
      const url = new URL(candidate.trim());
      if (!["https:", "http:"].includes(url.protocol) || seen.has(url.href)) return;
      seen.add(url.href);
      discovered.push(url.href);
    } catch {
      // Non-URL strings are inspected for embedded links below.
    }
  };
  const visit = (item) => {
    if (discovered.length >= limit || item == null) return;
    if (typeof item === "string") {
      add(item);
      for (const match of item.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        add(match[0].replace(/[),.;:!?]+$/, ""));
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (typeof item === "object") {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
  return discovered;
}

function agentReachExaAdapter(execute) {
  return {
    async collect(target, context = {}) {
      try {
        const run = scopedExecute(execute, context);
        const doctor = await run("agent-reach", ["doctor", "--json"]);
        const health = JSON.parse(doctor.stdout).exa_search ?? {};
        if (health.status === "off") {
          return {
            status: "unavailable",
            barrier: "backend_unavailable",
            message: health.message || "No Exa search backend is available",
            data: { health }
          };
        }
        const limits = { quick: 10, standard: 25, deep: 50, maximum: 100 };
        const depthLimit = limits[context.brief?.depth] ?? limits.standard;
        const requestedLimit = Number.isInteger(target.max_results) ? target.max_results : depthLimit;
        const limit = Math.max(1, Math.min(depthLimit, requestedLimit));
        const query = String(target.query ?? context.brief?.subject?.display_name ?? "").trim();
        if (!query) throw new TypeError("A public discovery query is required");
        const search = await run("mcporter", [
          "call",
          "exa.web_search_exa",
          `query=${query}`,
          `numResults=${limit}`
        ]);
        if (!String(search.stdout ?? "").trim()) {
          return {
            status: "partial",
            barrier: "empty_response",
            coverage: `exa_semantic_search_up_to_${limit}_results`,
            message: "Exa returned no search material",
            data: { health, results: "" }
          };
        }
        const results = maybeJson(search.stdout);
        const anchors = context.brief?.subject?.identity_anchors ?? [target.canonical_url];
        return {
          status: "collected",
          coverage: `exa_semantic_search_up_to_${limit}_results`,
          coverage_complete: false,
          data: { backend: health.active_backend ?? "Exa via mcporter", results },
          source_urls: [...new Set([...anchors, ...publicHttpUrls(results)])]
        };
      } catch (error) {
        return commandFailure(error);
      }
    }
  };
}

function isTextContentType(value) {
  const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  return type.startsWith("text/") || [
    "application/json",
    "application/xml",
    "application/xhtml+xml",
    "application/rss+xml",
    "application/atom+xml"
  ].includes(type);
}

async function boundedResponseText(response, maxBytes = READER_MAX_BYTES) {
  if (!response.body?.getReader) {
    const bytes = new TextEncoder().encode(await response.text());
    return { text: new TextDecoder().decode(bytes.slice(0, maxBytes)), truncated: bytes.length > maxBytes };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  let truncated = false;
  while (bytesRead < maxBytes) {
    const { done, value } = await reader.read();
    if (done) {
      text += decoder.decode();
      return { text, truncated };
    }
    const remaining = maxBytes - bytesRead;
    const included = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    text += decoder.decode(included, { stream: true });
    bytesRead += included.byteLength;
    if (value.byteLength > remaining) {
      truncated = true;
      await reader.cancel("public reader byte limit reached");
      break;
    }
  }
  if (bytesRead === maxBytes) {
    const { done } = await reader.read();
    truncated = !done;
    if (!done) await reader.cancel("public reader byte limit reached");
  }
  text += decoder.decode();
  return { text, truncated };
}

function boundedJinaAdapter(fetchImpl) {
  return {
    async collect(target, context = {}) {
      const readerUrl = `https://r.jina.ai/${target.canonical_url}`;
      const response = await fetchImpl(readerUrl, {
        headers: { accept: "text/plain", "user-agent": USER_AGENT },
        signal: context.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from r.jina.ai`);
      const contentType = response.headers.get("content-type") ?? "";
      if (!isTextContentType(contentType)) {
        return {
          status: "unavailable",
          barrier: "unsupported_content_type",
          message: `Reader returned unsupported content type ${contentType || "unknown"}`,
          source_urls: [target.canonical_url, readerUrl]
        };
      }
      const { text, truncated } = await boundedResponseText(response);
      if (!text.trim()) {
        return {
          status: "partial",
          barrier: "empty_response",
          coverage: "reader_visible_page_up_to_1000000_bytes",
          message: "Reader returned no text",
          data: { text: "", truncated },
          source_urls: [target.canonical_url, readerUrl]
        };
      }
      const quality = classifyPublicText(text);
      if (!quality.usable) {
        return {
          status: quality.barrier === "insufficient_subject_material" ? "partial" : "unavailable",
          barrier: quality.barrier,
          coverage: "reader_visible_page_up_to_1000000_bytes",
          coverage_complete: false,
          message: "Reader returned a public access barrier rather than subject material",
          data: { text, truncated },
          source_urls: [target.canonical_url, readerUrl]
        };
      }
      return {
        status: "collected",
        coverage: "reader_visible_page_up_to_1000000_bytes",
        coverage_complete: true,
        data: { text, truncated },
        source_urls: [target.canonical_url, readerUrl]
      };
    }
  };
}

function authenticatedGithubAdapter(execute, fallback) {
  return {
    async collect(target, context = {}) {
      const username = profileHandle(target);
      const run = scopedExecute(execute, context);
      try {
        const profileResult = await run("gh", ["api", `users/${username}`]);
        const repositoriesResult = await run("gh", ["api", `users/${username}/repos?per_page=100&sort=updated`]);
        const profile = JSON.parse(profileResult.stdout);
        const repositories = JSON.parse(repositoriesResult.stdout);
        return {
          status: "collected",
          coverage: "authenticated_github_profile_and_up_to_100_public_repositories",
          coverage_complete: Number.isFinite(profile?.public_repos) && repositories.length >= profile.public_repos,
          data: {
            backend: "authenticated_gh_cli",
            profile,
            repositories
          },
          source_urls: [
            target.canonical_url,
            `https://api.github.com/users/${encodeURIComponent(username)}`,
            `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=updated`
          ]
        };
      } catch {
        const result = await fallback.collect(target, context);
        if (result?.data && typeof result.data === "object") {
          result.data = { backend: "anonymous_github_public_api", ...result.data };
        }
        return result;
      }
    }
  };
}

async function readTranscriptFiles(directory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(?:vtt|srt)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  let remaining = TRANSCRIPT_MAX_BYTES;
  let truncated = false;
  for (const entry of entries) {
    if (remaining === 0) {
      truncated = true;
      break;
    }
    const filePath = path.join(directory, entry.name);
    const handle = await open(filePath, "r");
    try {
      const stats = await handle.stat();
      const length = Math.min(stats.size, remaining);
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, 0);
      files.push({
        filename: entry.name,
        text: bytes.subarray(0, bytesRead).toString("utf8"),
        truncated: stats.size > length
      });
      remaining -= bytesRead;
      if (stats.size > length) truncated = true;
    } finally {
      await handle.close();
    }
  }
  return { files, truncated };
}

function enhancedYoutubeAdapter(execute, metadataAdapter) {
  return {
    async collect(target, context = {}) {
      const metadata = await metadataAdapter.collect(target, context);
      if (metadata.status !== "collected") return metadata;
      const limits = { quick: 10, standard: 50, deep: 200, maximum: 1000 };
      const limit = limits[context.brief?.depth] ?? limits.standard;
      const directory = await mkdtemp(path.join(os.tmpdir(), "ppr-youtube-"));
      const run = scopedExecute(execute, context);
      let transcriptCollection;
      try {
        try {
          const result = await run("yt-dlp", [
            "--skip-download",
            "--write-subs",
            "--write-auto-subs",
            "--sub-langs",
            "en.*,en",
            "--sub-format",
            "vtt",
            "--playlist-end",
            String(limit),
            "--paths",
            directory,
            "--output",
            "%(id)s.%(ext)s",
            target.canonical_url
          ], { timeout: context.brief?.depth === "quick" ? 120_000 : 900_000 });
          const transcriptFiles = await readTranscriptFiles(directory);
          transcriptCollection = transcriptFiles.files.length ? {
            status: "collected",
            coverage: `available_english_captions_up_to_${limit}_videos_and_${TRANSCRIPT_MAX_BYTES}_bytes`,
            ...transcriptFiles,
            diagnostics: redactDiagnostics(result.stderr).slice(0, 20_000)
          } : {
            status: "unavailable",
            barrier: "captions_not_available_or_returned",
            message: "yt-dlp returned no English subtitle files",
            files: [],
            truncated: false,
            diagnostics: redactDiagnostics(result.stderr).slice(0, 20_000)
          };
        } catch (error) {
          transcriptCollection = { ...classifiedAdapterFailure(error), files: [], truncated: false };
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      return {
        ...metadata,
        coverage: `yt_dlp_metadata_up_to_${limit}_items_with_caption_attempt`,
        coverage_complete: metadata.coverage_complete === true && (!context.brief?.modules?.includes("media") || transcriptCollection.status === "collected"),
        data: { ...metadata.data, transcript_collection: transcriptCollection }
      };
    }
  };
}

function protectAdapter(adapter, lookup) {
  return {
    async collect(target, context) {
      await assertPublicTargetUrl(target?.canonical_url, { lookup });
      try {
        return await adapter.collect(target, context);
      } catch (error) {
        return classifiedAdapterFailure(error);
      }
    }
  };
}

export function createSafeDefaultAdapters(options = {}) {
  const lookup = options.lookup;
  const execute = typeof options.execFileImpl === "function" ? safeExecFile(options.execFileImpl) : null;
  const fetchImpl = createPublicFetch({
    fetchImpl: options.fetchImpl,
    lookup
  });
  const adapters = createDefaultAdapters({ fetchImpl, execFileImpl: execute });
  adapters.jina_reader = boundedJinaAdapter(fetchImpl);
  if (execute) {
    adapters.github_public_api = authenticatedGithubAdapter(execute, adapters.github_public_api);
    adapters.yt_dlp = enhancedYoutubeAdapter(execute, adapters.yt_dlp);
    adapters.agent_reach_x = agentReachXAdapter(execute, options.environment ?? process.env);
    adapters.agent_reach_facebook = agentReachFacebookAdapter(execute);
    adapters.agent_reach_linkedin = agentReachLinkedinAdapter(execute);
    adapters.agent_reach_exa = agentReachExaAdapter(execute);
  }
  return Object.fromEntries(
    Object.entries(adapters).map(([id, adapter]) => [id, protectAdapter(adapter, lookup)])
  );
}
