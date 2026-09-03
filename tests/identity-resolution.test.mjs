import assert from "node:assert/strict";
import test from "node:test";

import { resolveIdentity } from "../runner/identity-resolution.mjs";

test("a collected supplied anchor remains a candidate until corroborated", () => {
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "unconfirmed",
      identity_anchors: ["https://github.com/ada-example"]
    },
    observations: [{
      url: "https://github.com/ada-example",
      status: "collected",
      adapter_id: "github_public_api",
      first_party: true
    }]
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.confirmed_by, null);
  assert.deepEqual(result.candidate_anchors, ["https://github.com/ada-example"]);
  assert.match(result.reasons.join(" "), /collected supplied anchor/i);
});

test("an Exa name match remains a discovery lead even when labelled as direct corroboration", () => {
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "unconfirmed",
      identity_anchors: [
        "https://github.com/ada-example",
        "https://conference.example/speakers/ada-example"
      ]
    },
    observations: [
      {
        url: "https://github.com/ada-example",
        status: "collected",
        adapter_id: "github_public_api",
        first_party: true
      },
      {
        url: "https://conference.example/speakers/ada-example",
        status: "collected",
        adapter_id: "agent_reach_exa",
        first_party: true,
        direct_identity_corroboration: true,
        source_identity_status: "confirmed",
        links_to: ["https://github.com/ada-example"],
        evidence_ids: ["evidence:exa-result"],
        name_match: "exact"
      }
    ]
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.confirmed_by, null);
  assert.deepEqual(result.discovery_leads, ["https://conference.example/speakers/ada-example"]);
  assert.match(result.reasons.join(" "), /discovery.*cannot confirm/i);
});

test("an explicitly confirmed intake confirms the supplied anchors", () => {
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "confirmed",
      identity_anchors: [
        "https://github.com/ada-example",
        "https://www.youtube.com/@ada-example"
      ]
    }
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmed_by, "explicit_confirmed_intake");
  assert.deepEqual(result.confirmed_anchors, [
    "https://github.com/ada-example",
    "https://www.youtube.com/@ada-example"
  ]);
});

test("a direct first-party link corroborates supplied anchors", () => {
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "unconfirmed",
      identity_anchors: [
        "https://github.com/ada-example",
        "https://www.youtube.com/@ada-example"
      ]
    },
    observations: [{
      url: "https://github.com/ada-example",
      status: "collected",
      adapter_id: "github_public_api",
      first_party: true,
      source_identity_status: "confirmed",
      evidence_ids: ["receipt:github"],
      links_to: ["https://www.youtube.com/@ada-example"]
    }]
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmed_by, "direct_first_party_corroboration");
  assert.deepEqual(result.confirmed_anchors, [
    "https://github.com/ada-example",
    "https://www.youtube.com/@ada-example"
  ]);
  assert.equal(result.corroboration[0].kind, "direct_first_party_link");
});

test("reciprocal first-party links record mutual corroboration", () => {
  const github = "https://github.com/ada-example";
  const youtube = "https://www.youtube.com/@ada-example";
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "unconfirmed",
      identity_anchors: [github, youtube]
    },
    observations: [
      {
        url: github,
        status: "collected",
        adapter_id: "github_public_api",
        first_party: true,
        evidence_ids: ["receipt:github"],
        links_to: [youtube]
      },
      {
        url: youtube,
        status: "collected",
        adapter_id: "yt_dlp",
        first_party: true,
        evidence_ids: ["receipt:youtube"],
        links_to: [github]
      }
    ]
  });

  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmed_by, "mutual_first_party_corroboration");
  assert.ok(result.corroboration.some((item) => item.kind === "mutual_first_party_links"));
});

test("an intake conflict blocks confirmation until it is resolved", () => {
  const github = "https://github.com/ada-example";
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "conflict",
      identity_anchors: [github]
    },
    observations: [{
      url: github,
      status: "collected",
      adapter_id: "github_public_api",
      first_party: true,
      source_identity_status: "confirmed",
      evidence_ids: ["receipt:github"],
      direct_identity_corroboration: true
    }]
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.confirmed_by, null);
  assert.deepEqual(result.confirmed_anchors, []);
  assert.ok(result.conflicts.length > 0);
});

test("first-party corroboration does not promote an unrelated supplied anchor", () => {
  const github = "https://github.com/ada-example";
  const youtube = "https://www.youtube.com/@ada-example";
  const linkedin = "https://www.linkedin.com/in/ada-example";
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "unconfirmed",
      identity_anchors: [github, youtube, linkedin]
    },
    observations: [{
      url: github,
      status: "collected",
      adapter_id: "github_public_api",
      first_party: true,
      source_identity_status: "confirmed",
      evidence_ids: ["receipt:github"],
      links_to: [youtube]
    }]
  });

  assert.equal(result.status, "confirmed");
  assert.deepEqual(result.confirmed_anchors, [github, youtube]);
  assert.ok(!result.confirmed_anchors.includes(linkedin));
});

test("an unevidenced first-party flag cannot confirm identity", () => {
  const github = "https://github.com/ada-example";
  const youtube = "https://www.youtube.com/@ada-example";
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "unconfirmed",
      identity_anchors: [github, youtube]
    },
    observations: [{
      url: github,
      status: "collected",
      adapter_id: "github_public_api",
      first_party: true,
      links_to: [youtube]
    }]
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.confirmed_by, null);
  assert.match(result.reasons.join(" "), /evidence/i);
});

test("evidenced first-party contradiction produces a conflict", () => {
  const github = "https://github.com/ada-example";
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "unconfirmed",
      identity_anchors: [github]
    },
    observations: [{
      url: github,
      status: "collected",
      adapter_id: "github_public_api",
      first_party: true,
      contradicts_identity: true,
      evidence_ids: ["receipt:github-conflict"]
    }]
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.confirmed_by, null);
  assert.deepEqual(result.confirmed_anchors, []);
  assert.equal(result.conflicts[0].evidence_ids[0], "receipt:github-conflict");
});

test("mutual links between unrelated discovered pages cannot confirm a supplied anchor", () => {
  const github = "https://github.com/ada-example";
  const first = "https://first.example/ada";
  const second = "https://second.example/ada";
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "unconfirmed",
      identity_anchors: [github]
    },
    observations: [
      { url: github, status: "collected", adapter_id: "github_public_api" },
      { url: first, status: "collected", first_party: true, links_to: [second], evidence_ids: ["receipt:first"] },
      { url: second, status: "collected", first_party: true, links_to: [first], evidence_ids: ["receipt:second"] }
    ]
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.confirmed_by, null);
  assert.deepEqual(result.confirmed_anchors, []);
});

test("a lone supplied profile cannot confirm itself with a direct flag", () => {
  const github = "https://github.com/ada-example";
  const result = resolveIdentity({
    subject: {
      display_name: "Ada Example",
      identity_status: "unconfirmed",
      identity_anchors: [github]
    },
    observations: [{
      url: github,
      status: "collected",
      adapter_id: "github_public_api",
      first_party: true,
      source_identity_status: "unconfirmed",
      direct_identity_corroboration: true,
      evidence_ids: ["receipt:github"]
    }]
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.confirmed_by, null);
});

test("duplicate observations of one self-linking anchor cannot mutually confirm identity", () => {
  const anchor = "https://example.com/alice";
  const result = resolveIdentity({
    subject: { identity_anchors: [anchor], identity_status: "unconfirmed" },
    observations: [
      { url: anchor, status: "collected", first_party: true, links_to: [anchor], evidence_ids: ["evidence:one"] },
      { url: anchor, status: "collected", first_party: true, links_to: [anchor], evidence_ids: ["evidence:two"] }
    ]
  });

  assert.equal(result.status, "candidates");
  assert.equal(result.confirmed_by, null);
  assert.deepEqual(result.corroboration, []);
});
