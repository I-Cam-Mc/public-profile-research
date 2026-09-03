import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_SOURCE_TEXT_CHARACTERS,
  normaliseSourceItems
} from "../runner/source-items.mjs";

const target = (platform, canonicalUrl) => ({
  platform,
  canonical_url: canonicalUrl,
  status: "collected"
});

const attempt = (adapterId, hash = "a".repeat(64)) => ({
  adapter_id: adapterId,
  status: "collected",
  receipt_path: `receipts/01-${adapterId}.json`,
  receipt_sha256: hash
});

const receipt = (adapterId, data, extra = {}) => ({
  adapter_id: adapterId,
  status: "collected",
  ended_at: "2026-09-03T12:00:00.000Z",
  data,
  ...extra
});

function assertItemContract(item) {
  assert.match(item.item_id, /^item:[a-f0-9]{64}$/);
  assert.match(item.evidence_id, /^evidence:[a-f0-9]{64}$/);
  assert.equal(typeof item.platform, "string");
  assert.equal(typeof item.item_type, "string");
  assert.match(item.canonical_url, /^https?:\/\//);
  assert.equal(typeof item.title, "string");
  assert.equal(typeof item.text, "string");
  assert.ok(item.published_at === null || typeof item.published_at === "string");
  assert.equal(item.observed_at, "2026-09-03T12:00:00.000Z");
  assert.ok(["provided_anchor", "candidate"].includes(item.subject_relation));
  assert.equal(typeof item.provenance.receipt_path, "string");
  assert.equal(typeof item.provenance.receipt_sha256, "string");
  assert.match(item.provenance.json_pointer, /^\//);
  assert.equal(typeof item.metrics, "object");
}

test("normalises GitHub profile and repository records with stable identities", () => {
  const sourceTarget = target("github", "https://github.com/ada-example");
  const sourceAttempt = attempt("github_public_api");
  const sourceReceipt = receipt("github_public_api", {
    profile: {
      login: "ada-example",
      name: "Ada Example",
      html_url: "https://github.com/ada-example",
      bio: "Builds evidence systems",
      company: "Example Labs",
      location: "Perth",
      followers: 42,
      following: 7,
      public_repos: 2,
      created_at: "2020-01-02T00:00:00Z"
    },
    repositories: [
      {
        id: 101,
        name: "ledger",
        full_name: "ada-example/ledger",
        html_url: "https://github.com/ada-example/ledger",
        description: "An evidence ledger",
        language: "TypeScript",
        stargazers_count: 8,
        forks_count: 2,
        updated_at: "2026-09-01T00:00:00Z",
        created_at: "2025-04-01T00:00:00Z"
      },
      {
        id: 102,
        name: "reader",
        html_url: "https://github.com/ada-example/reader",
        description: "A public reader",
        stargazers_count: 3
      }
    ]
  });

  const input = { target: sourceTarget, attempt: sourceAttempt, receipt: sourceReceipt };
  const before = structuredClone(input);
  const items = normaliseSourceItems(input);
  const repeat = normaliseSourceItems(input);

  assert.deepEqual(input, before, "normalisation must not mutate receipts");
  assert.deepEqual(items, repeat, "identical evidence must produce identical records");
  assert.equal(items.length, 3);
  items.forEach(assertItemContract);

  assert.equal(items[0].item_type, "github_profile");
  assert.equal(items[0].title, "Ada Example");
  assert.match(items[0].text, /Builds evidence systems/);
  assert.equal(items[0].metrics.followers, 42);
  assert.equal(items[0].subject_relation, "provided_anchor");
  assert.equal(items[0].provenance.json_pointer, "/data/profile");

  assert.equal(items[1].item_type, "github_repository");
  assert.equal(items[1].canonical_url, "https://github.com/ada-example/ledger");
  assert.equal(items[1].metrics.stars, 8);
  assert.equal(items[1].metrics.forks, 2);
  assert.equal(items[1].metrics.updated_at, "2026-09-01T00:00:00.000Z");
  assert.equal(items[1].provenance.json_pointer, "/data/repositories/0");

  const reversed = normaliseSourceItems({
    target: sourceTarget,
    attempt: sourceAttempt,
    receipt: receipt("github_public_api", {
      ...sourceReceipt.data,
      repositories: [...sourceReceipt.data.repositories].reverse()
    })
  });
  const ledgerId = items.find((item) => item.title === "ledger").item_id;
  assert.equal(reversed.find((item) => item.title === "ledger").item_id, ledgerId);
});

test("normalises Exa JSON and labelled-text results as candidate leads", () => {
  const sourceTarget = target("web_search", "https://github.com/ada-example");
  const sourceAttempt = attempt("agent_reach_exa", "b".repeat(64));
  const jsonItems = normaliseSourceItems({
    target: sourceTarget,
    attempt: sourceAttempt,
    receipt: receipt("agent_reach_exa", {
      results: {
        results: [{
          id: "lead-1",
          title: "Ada Example at ExampleConf",
          url: "https://example.com/talk",
          publishedDate: "2025-04-10",
          highlights: ["A public talk about evidence systems."],
          score: 0.93
        }]
      }
    })
  });

  assert.equal(jsonItems.length, 1);
  assertItemContract(jsonItems[0]);
  assert.equal(jsonItems[0].item_type, "web_discovery_lead");
  assert.equal(jsonItems[0].subject_relation, "candidate");
  assert.equal(jsonItems[0].published_at, "2025-04-10");
  assert.equal(jsonItems[0].metrics.score, 0.93);
  assert.equal(jsonItems[0].provenance.json_pointer, "/data/results/results/0");

  const labelledItems = normaliseSourceItems({
    target: sourceTarget,
    attempt: sourceAttempt,
    receipt: receipt("agent_reach_exa", {
      results: "Title: Independent profile\nURL: https://example.org/ada\nPublished: 2024-11-09\nAuthor: Example Org\nHighlights:\nA candidate independent profile.\n\n---\n\nTitle: Second lead\nURL: https://example.net/ada\nHighlights:\nAnother lead."
    })
  });

  assert.equal(labelledItems.length, 2);
  assert.equal(labelledItems[0].title, "Independent profile");
  assert.match(labelledItems[0].text, /Example Org/);
  assert.equal(labelledItems[0].subject_relation, "candidate");
  assert.equal(labelledItems[0].provenance.json_pointer, "/data/results/0");
  assert.equal(labelledItems[1].canonical_url, "https://example.net/ada");
});

test("normalises YouTube playlist entries and transcript files", () => {
  const items = normaliseSourceItems({
    target: target("youtube", "https://www.youtube.com/@ada/videos"),
    attempt: attempt("yt_dlp", "c".repeat(64)),
    receipt: receipt("yt_dlp", {
      id: "ada-channel",
      title: "Ada Example",
      entries: [{
        id: "video123",
        title: "How evidence works",
        webpage_url: "https://www.youtube.com/watch?v=video123",
        description: "A detailed explanation.",
        upload_date: "20250809",
        view_count: 1200,
        like_count: 50,
        duration: 321
      }],
      transcript_collection: {
        status: "collected",
        files: [{
          filename: "video123.en.vtt",
          text: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello <b>world</b>\n\n00:00:02.000 --> 00:00:04.000\nEvidence matters"
        }]
      }
    })
  });

  assert.equal(items.length, 2);
  items.forEach(assertItemContract);
  assert.equal(items[0].item_type, "youtube_video");
  assert.equal(items[0].published_at, "2025-08-09");
  assert.equal(items[0].metrics.views, 1200);
  assert.equal(items[0].provenance.json_pointer, "/data/entries/0");
  assert.equal(items[1].item_type, "video_transcript");
  assert.equal(items[1].canonical_url, "https://www.youtube.com/watch?v=video123");
  assert.equal(items[1].title, "How evidence works transcript");
  assert.equal(items[1].text, "Hello world\nEvidence matters");
  assert.equal(items[1].provenance.json_pointer, "/data/transcript_collection/files/0");
});

test("normalises a single YouTube video", () => {
  const [item] = normaliseSourceItems({
    target: target("youtube", "https://youtu.be/video456"),
    attempt: attempt("yt_dlp"),
    receipt: receipt("yt_dlp", {
      id: "video456",
      title: "One video",
      webpage_url: "https://www.youtube.com/watch?v=video456",
      description: "Single item metadata",
      timestamp: 1754697600,
      comment_count: 12
    })
  });

  assertItemContract(item);
  assert.equal(item.item_type, "youtube_video");
  assert.equal(item.canonical_url, "https://www.youtube.com/watch?v=video456");
  assert.equal(item.metrics.comments, 12);
  assert.equal(item.provenance.json_pointer, "/data");
});

test("normalises yt-dlp TikTok results as social videos rather than YouTube items", () => {
  const [item] = normaliseSourceItems({
    target: target("tiktok", "https://www.tiktok.com/@ada_example"),
    attempt: attempt("yt_dlp", "9".repeat(64)),
    receipt: receipt("yt_dlp", {
      id: "7412345678901234567",
      title: "A public project update",
      webpage_url: "https://www.tiktok.com/@ada_example/video/7412345678901234567",
      description: "A short public project update",
      timestamp: 1754697600,
      view_count: 800
    })
  });

  assertItemContract(item);
  assert.equal(item.platform, "tiktok");
  assert.equal(item.item_type, "social_video");
  assert.equal(item.canonical_url, "https://www.tiktok.com/@ada_example/video/7412345678901234567");
  assert.equal(item.metrics.views, 800);
});

test("normalises and bounds Jina page text", () => {
  const longBody = "x".repeat(MAX_SOURCE_TEXT_CHARACTERS + 200);
  const [item] = normaliseSourceItems({
    target: target("web", "https://example.com/about"),
    attempt: attempt("jina_reader", "d".repeat(64)),
    receipt: receipt("jina_reader", {
      text: `Title: About Ada\nURL Source: https://example.com/about\nPublished Time: 2026-01-02\nMarkdown Content:\n${longBody}`,
      truncated: false
    })
  });

  assertItemContract(item);
  assert.equal(item.item_type, "web_page_snapshot");
  assert.equal(item.title, "About Ada");
  assert.equal(item.published_at, "2026-01-02");
  assert.ok(item.text.length <= MAX_SOURCE_TEXT_CHARACTERS);
  assert.equal(item.metrics.text_truncated, true);
  assert.equal(item.provenance.json_pointer, "/data/text");
  assert.equal(item.content_quality, "usable");
});

test("does not turn access walls or operational metadata into source evidence", () => {
  const blockedPage = normaliseSourceItems({
    target: target("web", "https://example.com/about"),
    attempt: attempt("jina_reader", "1".repeat(64)),
    receipt: receipt("jina_reader", {
      text: "Please sign in to continue. Cookies are required.",
      truncated: false
    })
  });
  const backendOnly = normaliseSourceItems({
    target: target("instagram", "https://www.instagram.com/ada.example/"),
    attempt: attempt("agent_reach_instagram", "2".repeat(64)),
    receipt: receipt("agent_reach_instagram", {
      backend: "OpenCLI",
      health: { status: "ok" },
      diagnostics: "collector initialised"
    })
  });

  assert.deepEqual(blockedPage, []);
  assert.deepEqual(backendOnly, []);
});

test("normalises Agent Reach social JSON and keeps plain text as a snapshot", () => {
  const sourceTarget = target("instagram", "https://www.instagram.com/ada.example/");
  const sourceAttempt = attempt("agent_reach_instagram", "e".repeat(64));
  const jsonItems = normaliseSourceItems({
    target: sourceTarget,
    attempt: sourceAttempt,
    receipt: receipt("agent_reach_instagram", {
      profile: JSON.stringify({
        username: "ada.example",
        full_name: "Ada Example",
        biography: "Public-interest technologist",
        follower_count: 900
      }),
      posts: JSON.stringify({
        items: [{
          id: "post-1",
          shortcode: "abc123",
          caption: "A public project update",
          taken_at: 1754697600,
          like_count: 45,
          comment_count: 3
        }]
      })
    })
  });

  assert.equal(jsonItems.length, 2);
  jsonItems.forEach(assertItemContract);
  assert.equal(jsonItems[0].item_type, "social_profile");
  assert.equal(jsonItems[0].title, "Ada Example");
  assert.equal(jsonItems[0].metrics.followers, 900);
  assert.equal(jsonItems[0].provenance.json_pointer, "/data/profile");
  assert.equal(jsonItems[1].item_type, "social_post");
  assert.equal(jsonItems[1].canonical_url, "https://www.instagram.com/p/abc123/");
  assert.equal(jsonItems[1].metrics.likes, 45);
  assert.equal(jsonItems[1].provenance.json_pointer, "/data/posts/items/0");

  const [snapshot] = normaliseSourceItems({
    target: target("x", "https://x.com/ada_example"),
    attempt: attempt("agent_reach_x", "f".repeat(64)),
    receipt: receipt("agent_reach_x", {
      profile: "Name: Ada Example\nBio: Researcher",
      posts: "- First public post\n- Second public post"
    })
  });

  assertItemContract(snapshot);
  assert.equal(snapshot.item_type, "social_snapshot");
  assert.match(snapshot.text, /First public post/);
  assert.equal(snapshot.provenance.json_pointer, "/data");
});

test("returns no items for non-collected receipts", () => {
  const items = normaliseSourceItems({
    target: target("linkedin", "https://www.linkedin.com/in/ada-example"),
    attempt: { ...attempt("agent_reach_linkedin"), status: "unavailable" },
    receipt: { status: "unavailable", barrier: "authentication_required" }
  });

  assert.deepEqual(items, []);
});
