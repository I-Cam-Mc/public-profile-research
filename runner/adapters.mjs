const USER_AGENT = "public-profile-research/1.0 (+https://github.com/I-Cam-Mc/public-profile-research)";
const MAX_READER_CHARACTERS = 1_000_000;

import { classifyPublicText } from "./evidence-quality.mjs";

function redactDiagnostics(value) {
  return String(value ?? "")
    .replace(/\b(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|twitter_auth_token|twitter_ct0|cookie|session)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function profileHandle(target) {
  const url = new URL(target.canonical_url);
  const handle = url.pathname.split("/").filter(Boolean)[0]?.replace(/^@/, "");
  if (!handle || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(handle)) {
    throw new TypeError(`${target.platform} profile URL must contain a valid public handle`);
  }
  return handle;
}

function commandAdapter(execFileImpl, collect) {
  return {
    async collect(target, context = {}) {
      try {
        return await collect(target, context, async (command, args, options = {}) => execFileImpl(command, args, {
          timeout: 90_000,
          maxBuffer: 8 * 1024 * 1024,
          encoding: "utf8",
          shell: false,
          signal: context.signal,
          ...options
        }));
      } catch (error) {
        if (error?.code === "ENOENT") {
          return { status: "unavailable", barrier: "tool_missing", message: `${error.path ?? "Required command"} is not installed` };
        }
        throw error;
      }
    }
  };
}

async function responseJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT },
    redirect: "follow",
    signal
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  return response.json();
}

function githubUsername(target) {
  const url = new URL(target.canonical_url);
  const username = url.pathname.split("/").filter(Boolean)[0];
  if (!username || !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(username) || username.endsWith("-")) {
    throw new TypeError("GitHub profile URL must contain a valid public username");
  }
  return username;
}

function githubAdapter(fetchImpl) {
  return {
    async collect(target, context = {}) {
      const username = githubUsername(target);
      const profileUrl = `https://api.github.com/users/${encodeURIComponent(username)}`;
      const repositoriesUrl = `${profileUrl}/repos?per_page=100&sort=updated`;
      const [profile, repositories] = await Promise.all([
        responseJson(fetchImpl, profileUrl, context.signal),
        responseJson(fetchImpl, repositoriesUrl, context.signal)
      ]);
      return {
        status: "collected",
        coverage: "public_profile_and_up_to_100_public_repositories",
        coverage_complete: Number.isFinite(profile?.public_repos) && repositories.length >= profile.public_repos,
        data: { profile, repositories },
        source_urls: [target.canonical_url, profileUrl, repositoriesUrl]
      };
    }
  };
}

function jinaAdapter(fetchImpl) {
  return {
    async collect(target, context = {}) {
      const readerUrl = `https://r.jina.ai/${target.canonical_url}`;
      const response = await fetchImpl(readerUrl, {
        headers: { accept: "text/plain", "user-agent": USER_AGENT },
        redirect: "follow",
        signal: context.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from r.jina.ai`);
      const text = (await response.text()).slice(0, MAX_READER_CHARACTERS);
      if (!text.trim()) return { status: "partial", coverage: "reader_visible_page", message: "Reader returned no text", data: { text: "" }, source_urls: [target.canonical_url, readerUrl] };
      const quality = classifyPublicText(text);
      if (!quality.usable) {
        return {
          status: quality.barrier === "insufficient_subject_material" ? "partial" : "unavailable",
          barrier: quality.barrier,
          coverage: "reader_visible_page",
          coverage_complete: false,
          message: "Reader returned a public access barrier rather than subject material",
          data: { text, truncated: text.length === MAX_READER_CHARACTERS },
          source_urls: [target.canonical_url, readerUrl]
        };
      }
      return {
        status: "collected",
        coverage: "reader_visible_page",
        coverage_complete: true,
        data: { text, truncated: text.length === MAX_READER_CHARACTERS },
        source_urls: [target.canonical_url, readerUrl]
      };
    }
  };
}

function youtubeAdapter(execFileImpl) {
  return commandAdapter(execFileImpl, async (target, context, execute) => {
    const limits = { quick: 10, standard: 50, deep: 200, maximum: 1000 };
    const limit = limits[context.brief?.depth] ?? limits.standard;
    const { stdout, stderr } = await execute("yt-dlp", [
      "--dump-single-json",
      "--skip-download",
      "--playlist-end",
      String(limit),
      target.canonical_url
    ]);
    const data = JSON.parse(stdout);
    return {
      status: "collected",
      coverage: `yt_dlp_metadata_up_to_${limit}_items`,
      coverage_complete: !Array.isArray(data.entries) || data.entries.length < limit,
      data,
      diagnostics: redactDiagnostics(stderr).slice(0, 20_000),
      source_urls: [target.canonical_url]
    };
  });
}

function agentReachInstagramAdapter(execFileImpl) {
  return commandAdapter(execFileImpl, async (target, context, execute) => {
    const handle = profileHandle(target);
    const limits = { quick: 12, standard: 50, deep: 200, maximum: 1000 };
    const limit = limits[context.brief?.depth] ?? limits.standard;
    const doctor = await execute("agent-reach", ["doctor", "--json"]);
    const health = JSON.parse(doctor.stdout);
    const backend = health.instagram?.active_backend;
    if (health.instagram?.status === "off") {
      return {
        status: "unavailable",
        barrier: "tool_missing",
        message: health.instagram.message,
        data: { health: health.instagram }
      };
    }
    const profile = await execute("opencli", ["instagram", "profile", handle, "-f", "json"]);
    const posts = await execute("opencli", ["instagram", "user", handle, "--limit", String(limit), "-f", "json"]);
    return {
      status: "collected",
      coverage: `authenticated_public_profile_and_up_to_${limit}_recent_posts`,
      coverage_complete: false,
      data: { backend: backend ?? "OpenCLI", profile: profile.stdout, posts: posts.stdout },
      source_urls: [target.canonical_url]
    };
  });
}

export function createDefaultAdapters(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const execFileImpl = options.execFileImpl;
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required");
  const adapters = {
    github_public_api: githubAdapter(fetchImpl),
    jina_reader: jinaAdapter(fetchImpl)
  };
  if (typeof execFileImpl === "function") {
    adapters.yt_dlp = youtubeAdapter(execFileImpl);
    adapters.agent_reach_instagram = agentReachInstagramAdapter(execFileImpl);
  }
  return adapters;
}
