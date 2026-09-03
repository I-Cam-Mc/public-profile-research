import { createHash } from "node:crypto";

import { classifyPublicText, hasSubjectRecord } from "./evidence-quality.mjs";

import { canonicalJson } from "./canonical-json.mjs";

export const MAX_SOURCE_TEXT_CHARACTERS = 100_000;

const MAX_TITLE_CHARACTERS = 500;
const SOCIAL_PLATFORMS = new Set(["facebook", "instagram", "linkedin", "tiktok", "x"]);

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function cleanString(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\0/g, "").replace(/\r\n?/g, "\n").trim();
}

function boundedString(value, maximum = MAX_SOURCE_TEXT_CHARACTERS) {
  const text = cleanString(value);
  return text.length > maximum ? text.slice(0, maximum).trimEnd() : text;
}

function firstString(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function httpUrl(...values) {
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      const url = new URL(value.trim());
      if (["http:", "https:"].includes(url.protocol)) return url.href;
    } catch {
      // A missing or non-public URL is handled by the next candidate.
    }
  }
  return "";
}

function normaliseDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  const text = cleanString(value);
  if (!text || /^(?:n\/?a|none|null|unknown)$/i.test(text)) return null;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function numeric(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function metricValue(source, names) {
  for (const name of names) {
    const value = numeric(source?.[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function compactMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => (
    typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
  )));
}

function pointerToken(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function relationFor(target, receipt, attempt, providedAnchors) {
  const platform = String(target?.platform ?? receipt?.target?.platform ?? "").toLowerCase();
  const adapterId = String(attempt?.adapter_id ?? receipt?.adapter_id ?? "");
  if (platform === "web_search" || adapterId === "agent_reach_exa") return "candidate";
  if (["provided_anchor", "candidate"].includes(target?.subject_relation)) return target.subject_relation;
  if (providedAnchors.length) {
    const targetUrl = httpUrl(target?.canonical_url, receipt?.target?.canonical_url);
    return providedAnchors.some((anchor) => httpUrl(anchor) === targetUrl) ? "provided_anchor" : "candidate";
  }
  return "provided_anchor";
}

function sourceContext(input) {
  const target = input?.target ?? {};
  const attempt = input?.attempt ?? {};
  const receipt = input?.receipt ?? {};
  const platform = cleanString(target.platform || receipt.target?.platform).toLowerCase();
  const targetUrl = httpUrl(target.canonical_url, receipt.target?.canonical_url);
  const receiptPath = cleanString(attempt.receipt_path || receipt.receipt_path);
  const receiptHash = cleanString(attempt.receipt_sha256 || receipt.sha256) || sha256(receipt);
  return {
    target,
    attempt,
    receipt,
    platform,
    targetUrl,
    observedAt: normaliseDate(receipt.ended_at || attempt.ended_at),
    subjectRelation: relationFor(target, receipt, attempt, input?.providedAnchors ?? []),
    receiptPath,
    receiptHash
  };
}

function makeItem(context, value) {
  const canonicalUrl = httpUrl(value.canonicalUrl, context.targetUrl);
  if (!canonicalUrl) return null;
  const rawText = cleanString(value.text);
  const text = boundedString(rawText);
  const jsonPointer = value.jsonPointer.startsWith("/") ? value.jsonPointer : `/${value.jsonPointer}`;
  const provenance = {
    receipt_path: context.receiptPath,
    receipt_sha256: context.receiptHash,
    json_pointer: jsonPointer
  };
  const identity = {
    platform: context.platform,
    item_type: value.itemType,
    canonical_url: canonicalUrl,
    source_key: cleanString(value.sourceKey) || sha256({ title: value.title, text })
  };
  const itemId = `item:${sha256(identity)}`;
  const metrics = compactMetrics({
    ...(value.metrics ?? {}),
    source_text_characters: rawText.length,
    text_truncated: rawText.length > MAX_SOURCE_TEXT_CHARACTERS || value.metrics?.text_truncated === true
  });
  return {
    item_id: itemId,
    evidence_id: `evidence:${sha256({ item_id: itemId, provenance })}`,
    platform: context.platform,
    item_type: value.itemType,
    canonical_url: canonicalUrl,
    title: boundedString(value.title || `${context.platform} public item`, MAX_TITLE_CHARACTERS),
    text,
    published_at: normaliseDate(value.publishedAt),
    observed_at: context.observedAt,
    subject_relation: value.subjectRelation ?? context.subjectRelation,
    content_quality: "usable",
    provenance,
    metrics
  };
}

function githubText(value, fields) {
  const parts = [];
  for (const [label, key] of fields) {
    const text = cleanString(value?.[key]);
    if (text) parts.push(`${label}: ${text}`);
  }
  if (Array.isArray(value?.topics) && value.topics.length) parts.push(`Topics: ${value.topics.join(", ")}`);
  return parts.join("\n");
}

function githubItems(context) {
  const data = context.receipt.data ?? {};
  const items = [];
  if (data.profile && typeof data.profile === "object" && !Array.isArray(data.profile)) {
    const profile = data.profile;
    items.push(makeItem(context, {
      itemType: "github_profile",
      canonicalUrl: httpUrl(profile.html_url, context.targetUrl),
      title: firstString(profile.name, profile.login, "GitHub profile"),
      text: githubText(profile, [
        ["Bio", "bio"],
        ["Company", "company"],
        ["Location", "location"],
        ["Website", "blog"]
      ]),
      publishedAt: profile.created_at,
      sourceKey: firstString(profile.id, profile.login, profile.html_url),
      jsonPointer: "/data/profile",
      metrics: {
        followers: metricValue(profile, ["followers"]),
        following: metricValue(profile, ["following"]),
        public_repositories: metricValue(profile, ["public_repos"]),
        public_gists: metricValue(profile, ["public_gists"])
      }
    }));
  }
  if (Array.isArray(data.repositories)) {
    data.repositories.forEach((repository, index) => {
      if (!repository || typeof repository !== "object") return;
      items.push(makeItem(context, {
        itemType: "github_repository",
        canonicalUrl: httpUrl(repository.html_url, repository.url, context.targetUrl),
        title: firstString(repository.name, repository.full_name, "GitHub repository"),
        text: githubText(repository, [
          ["Description", "description"],
          ["Language", "language"],
          ["Homepage", "homepage"]
        ]),
        publishedAt: repository.created_at,
        sourceKey: firstString(repository.id, repository.html_url, repository.full_name, repository.name),
        jsonPointer: `/data/repositories/${index}`,
        metrics: {
          stars: metricValue(repository, ["stargazers_count", "stars"]),
          forks: metricValue(repository, ["forks_count", "forks"]),
          watchers: metricValue(repository, ["watchers_count", "watchers"]),
          open_issues: metricValue(repository, ["open_issues_count", "open_issues"]),
          updated_at: normaliseDate(repository.updated_at),
          pushed_at: normaliseDate(repository.pushed_at)
        }
      }));
    });
  }
  return items.filter(Boolean);
}

function parseJsonString(value) {
  if (typeof value !== "string") return { value, parsed: false };
  const text = value.trim();
  if (!text || !/^[{[]/.test(text)) return { value, parsed: false };
  try {
    return { value: JSON.parse(text), parsed: true };
  } catch {
    return { value, parsed: false };
  }
}

function labelledExaResults(value) {
  const text = cleanString(value);
  if (!text) return [];
  const blocks = text
    .split(/\n\s*-{3,}\s*\n/g)
    .flatMap((block) => block.split(/\n(?=Title:\s*)/g))
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split("\n");
    const result = { highlights: [] };
    let inHighlights = false;
    for (const line of lines) {
      const field = line.match(/^(Title|URL|Published|Author|Highlights):\s*(.*)$/i);
      if (field) {
        const key = field[1].toLowerCase();
        const content = field[2].trim();
        inHighlights = key === "highlights";
        if (key === "highlights") {
          if (content) result.highlights.push(content);
        } else {
          result[key] = content;
        }
      } else if (inHighlights && line.trim()) {
        result.highlights.push(line.trim());
      }
    }
    return result;
  }).filter((result) => result.url);
}

function exaResultRecords(value) {
  const decoded = parseJsonString(value);
  if (!decoded.parsed && typeof decoded.value === "string") {
    return labelledExaResults(decoded.value).map((result, index) => ({
      result,
      pointer: `/data/results/${index}`
    }));
  }
  const root = decoded.value;
  if (Array.isArray(root)) {
    return root.map((result, index) => ({ result, pointer: `/data/results/${index}` }));
  }
  if (Array.isArray(root?.results)) {
    return root.results.map((result, index) => ({ result, pointer: `/data/results/results/${index}` }));
  }
  if (Array.isArray(root?.data?.results)) {
    return root.data.results.map((result, index) => ({ result, pointer: `/data/results/data/results/${index}` }));
  }
  return [];
}

function exaItems(context) {
  return exaResultRecords(context.receipt.data?.results).map(({ result, pointer }) => {
    if (!result || typeof result !== "object") return null;
    const resultUrl = httpUrl(result.url, result.link);
    if (!resultUrl) return null;
    const highlights = Array.isArray(result.highlights) ? result.highlights.join("\n") : result.highlights;
    const author = cleanString(result.author);
    return makeItem(context, {
      itemType: "web_discovery_lead",
      canonicalUrl: resultUrl,
      title: firstString(result.title, result.name, resultUrl),
      text: [author ? `Author: ${author}` : "", firstString(highlights, result.text, result.summary, result.snippet, result.description)]
        .filter(Boolean)
        .join("\n"),
      publishedAt: result.publishedDate ?? result.published_at ?? result.published,
      sourceKey: firstString(result.id, resultUrl),
      subjectRelation: "candidate",
      jsonPointer: pointer,
      metrics: { score: metricValue(result, ["score"]) }
    });
  }).filter(Boolean);
}

function videoUrl(platform, value, targetUrl) {
  const direct = httpUrl(value?.webpage_url, value?.original_url, value?.url);
  if (direct) return direct;
  const id = cleanString(value?.id);
  if (platform === "youtube" && /^[a-z0-9_-]{3,64}$/i.test(id)) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  return targetUrl;
}

function youtubeMetrics(value) {
  return {
    views: metricValue(value, ["view_count", "views"]),
    likes: metricValue(value, ["like_count", "likes"]),
    comments: metricValue(value, ["comment_count", "comments"]),
    duration_seconds: metricValue(value, ["duration"])
  };
}

function cleanTranscript(value) {
  const lines = cleanString(value).split("\n");
  const cleaned = [];
  let skipNote = false;
  for (const sourceLine of lines) {
    const line = sourceLine.trim();
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/i.test(line)) {
      skipNote = true;
      continue;
    }
    if (skipNote && !line) {
      skipNote = false;
      continue;
    }
    if (skipNote || !line || /^WEBVTT$/i.test(line) || /^(?:Kind|Language):/i.test(line)) continue;
    if (/^(?:\d+:)?\d{2}:\d{2}[.,]\d{3}\s+-->/.test(line) || /^\d+$/.test(line)) continue;
    const content = line
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .trim();
    if (content && cleaned.at(-1) !== content) cleaned.push(content);
  }
  return cleaned.join("\n");
}

function youtubeItems(context) {
  const data = context.receipt.data ?? {};
  const hasEntries = Array.isArray(data.entries);
  const videos = hasEntries ? data.entries : [data];
  const items = [];
  const videosById = new Map();
  videos.forEach((video, index) => {
    if (!video || typeof video !== "object") return;
    const url = videoUrl(context.platform, video, context.targetUrl);
    const id = firstString(video.id, url);
    const title = firstString(video.title, "YouTube video");
    const publishedAt = video.upload_date ?? video.release_date ?? video.timestamp;
    videosById.set(cleanString(video.id), { url, title, publishedAt });
    items.push(makeItem(context, {
      itemType: context.platform === "youtube" ? "youtube_video" : "social_video",
      canonicalUrl: url,
      title,
      text: firstString(video.description, video.summary),
      publishedAt,
      sourceKey: id,
      jsonPointer: hasEntries ? `/data/entries/${index}` : "/data",
      metrics: youtubeMetrics(video)
    }));
  });

  const transcriptFiles = data.transcript_collection?.files;
  if (Array.isArray(transcriptFiles)) {
    transcriptFiles.forEach((file, index) => {
      if (!file || typeof file !== "object") return;
      const filename = cleanString(file.filename);
      const videoId = filename.split(".")[0];
      const matchedVideo = videosById.get(videoId) ?? (!hasEntries ? videosById.values().next().value : undefined);
      const fallbackVideo = { id: videoId };
      const url = matchedVideo?.url || videoUrl(context.platform, fallbackVideo, context.targetUrl);
      const title = `${firstString(matchedVideo?.title, videoId, "YouTube video")} transcript`;
      items.push(makeItem(context, {
        itemType: "video_transcript",
        canonicalUrl: url,
        title,
        text: cleanTranscript(file.text),
        publishedAt: matchedVideo?.publishedAt,
        sourceKey: `${videoId}:${filename || index}`,
        jsonPointer: `/data/transcript_collection/files/${index}`,
        metrics: {
          transcript_filename: filename,
          source_truncated: file.truncated === true
        }
      }));
    });
  }
  return items.filter(Boolean);
}

function jinaItems(context) {
  const data = context.receipt.data ?? {};
  const text = cleanString(data.text);
  if (!classifyPublicText(text).usable) return [];
  const title = text.match(/^Title:\s*(.+)$/im)?.[1]
    ?? text.match(/^#\s+(.+)$/m)?.[1]
    ?? new URL(context.targetUrl).hostname;
  const publishedAt = text.match(/^Published(?: Time)?:\s*(.+)$/im)?.[1];
  return [makeItem(context, {
    itemType: "web_page_snapshot",
    canonicalUrl: context.targetUrl,
    title,
    text,
    publishedAt,
    sourceKey: context.targetUrl,
    jsonPointer: "/data/text",
    metrics: { source_truncated: data.truncated === true }
  })].filter(Boolean);
}

function socialMetrics(value) {
  return {
    followers: metricValue(value, ["followers", "follower_count", "followers_count"]),
    following: metricValue(value, ["following", "following_count"]),
    posts: metricValue(value, ["posts", "post_count", "media_count", "statuses_count"]),
    likes: metricValue(value, ["likes", "like_count", "favorite_count", "favourite_count", "digg_count"]),
    comments: metricValue(value, ["comments", "comment_count"]),
    replies: metricValue(value, ["replies", "reply_count"]),
    shares: metricValue(value, ["shares", "share_count", "retweet_count", "repost_count"]),
    views: metricValue(value, ["views", "view_count", "play_count"])
  };
}

function postCollection(value, pointer) {
  if (Array.isArray(value)) return value.map((post, index) => ({ post, pointer: `${pointer}/${index}` }));
  if (!value || typeof value !== "object") return [];
  for (const key of ["items", "posts", "tweets", "results", "data", "edges"]) {
    if (Array.isArray(value[key])) {
      return value[key].map((post, index) => ({ post: post?.node ?? post, pointer: `${pointer}/${pointerToken(key)}/${index}` }));
    }
  }
  if (["id", "text", "caption", "content", "message"].some((key) => Object.hasOwn(value, key))) {
    return [{ post: value, pointer }];
  }
  return [];
}

function socialPostUrl(platform, post, targetUrl) {
  const direct = httpUrl(post?.url, post?.permalink, post?.link, post?.web_url);
  if (direct) return direct;
  const id = firstString(post?.id, post?.id_str, post?.pk);
  const shortcode = firstString(post?.shortcode, post?.code);
  if (platform === "instagram" && shortcode) return `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`;
  if (platform === "x" && id) {
    const handle = new URL(targetUrl).pathname.split("/").filter(Boolean)[0];
    if (handle) return `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(id)}`;
  }
  return targetUrl;
}

function socialItems(context) {
  const data = context.receipt.data ?? {};
  const items = [];
  const plainParts = [];
  const profileDecoded = parseJsonString(data.profile);
  if (profileDecoded.parsed || (profileDecoded.value && typeof profileDecoded.value === "object" && !Array.isArray(profileDecoded.value))) {
    const profile = profileDecoded.value?.data && typeof profileDecoded.value.data === "object"
      ? profileDecoded.value.data
      : profileDecoded.value;
    if (profile && typeof profile === "object" && !Array.isArray(profile) && hasSubjectRecord(profile)) {
      items.push(makeItem(context, {
        itemType: "social_profile",
        canonicalUrl: httpUrl(profile.url, profile.profile_url, profile.permalink, context.targetUrl),
        title: firstString(profile.full_name, profile.name, profile.display_name, profile.username, profile.screen_name, "Public profile"),
        text: safeJson(profile),
        publishedAt: profile.created_at ?? profile.joined_at,
        sourceKey: firstString(profile.id, profile.pk, profile.username, profile.screen_name, context.targetUrl),
        jsonPointer: "/data/profile",
        metrics: socialMetrics(profile)
      }));
    }
  } else if (classifyPublicText(data.profile).usable) {
    plainParts.push(`Profile:\n${cleanString(data.profile)}`);
  }

  const postsDecoded = parseJsonString(data.posts);
  const postRecords = postCollection(postsDecoded.value, "/data/posts");
  if (postRecords.length) {
    postRecords.forEach(({ post, pointer }, index) => {
      if (!post || typeof post !== "object" || !hasSubjectRecord(post)) return;
      const text = firstString(post.full_text, post.text, post.caption?.text, post.caption, post.content, post.description, post.message, post.body);
      const url = socialPostUrl(context.platform, post, context.targetUrl);
      items.push(makeItem(context, {
        itemType: "social_post",
        canonicalUrl: url,
        title: firstString(post.title, text.slice(0, 100), `${context.platform} public post`),
        text: text || safeJson(post),
        publishedAt: post.published_at ?? post.created_at ?? post.taken_at ?? post.timestamp ?? post.date,
        sourceKey: firstString(post.id, post.id_str, post.pk, post.shortcode, post.code, url, index),
        jsonPointer: pointer,
        metrics: socialMetrics(post)
      }));
    });
  } else if (classifyPublicText(data.posts).usable) {
    plainParts.push(`Posts:\n${cleanString(data.posts)}`);
  }

  if (plainParts.length) {
    items.push(makeItem(context, {
      itemType: "social_snapshot",
      canonicalUrl: context.targetUrl,
      title: `${context.platform.charAt(0).toUpperCase()}${context.platform.slice(1)} public snapshot`,
      text: plainParts.join("\n\n"),
      sourceKey: sha256(plainParts),
      jsonPointer: "/data",
      metrics: {}
    }));
  }

  return items.filter(Boolean);
}

/**
 * Turn one collected target attempt and its receipt into deterministic source items.
 * The input is treated as immutable and the function performs no network or file IO.
 */
export function normaliseSourceItems(input = {}) {
  const context = sourceContext(input);
  const status = cleanString(context.receipt.status || context.attempt.status);
  if (!["collected", "partial"].includes(status) || !Object.hasOwn(context.receipt, "data")) return [];

  const adapterId = cleanString(context.attempt.adapter_id || context.receipt.adapter_id);
  if (context.platform === "github" || adapterId.includes("github")) return githubItems(context);
  if (context.platform === "web_search" || adapterId === "agent_reach_exa") return exaItems(context);
  if (context.platform === "youtube" || adapterId === "yt_dlp") return youtubeItems(context);
  if (adapterId === "jina_reader") return jinaItems(context);
  if (SOCIAL_PLATFORMS.has(context.platform) || adapterId.startsWith("agent_reach_")) return socialItems(context);
  return [];
}
