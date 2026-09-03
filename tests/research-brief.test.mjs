import assert from "node:assert/strict";
import test from "node:test";

import {
  SERVICE_TIERS,
  buildPortablePrompt,
  createResearchBrief,
  validateResearchBrief
} from "../website/lib/research-brief.mjs";

test("a user can create a portable brief from one identity anchor", () => {
  const brief = createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://github.com/ada-example/"],
    purpose: "self_audit",
    depth: "quick",
    modules: ["identity", "timeline", "public_impression"]
  });

  assert.equal(brief.schema_version, 1);
  assert.equal(brief.subject.display_name, "Ada Example");
  assert.deepEqual(brief.subject.identity_anchors, ["https://github.com/ada-example/"]);
  assert.equal(brief.purpose, "self_audit");
  assert.equal(brief.depth, "quick");
  assert.equal(brief.cost_policy, "free_tools_only");
  assert.equal(brief.research_state, "not_run");
  assert.equal(brief.research_mode, "insight");
  assert.equal(brief.relationship_to_subject, "self");
  assert.equal(brief.corpus_scope, "public_only");
});

test("a subject name is inferred from a confirmed profile anchor when omitted", () => {
  const brief = createResearchBrief({
    profileUrls: ["https://github.com/ada-example"],
    purpose: "self_audit",
    depth: "quick"
  });
  assert.equal(brief.subject.display_name, "ada-example");
  assert.equal(brief.subject.identity_status, "unconfirmed");
});

test("identity is confirmed only when the user explicitly confirms the supplied anchors", () => {
  const defaultBrief = createResearchBrief({
    profileUrls: ["https://github.com/ada-example"],
    purpose: "self_audit",
    depth: "quick"
  });
  const confirmedBrief = createResearchBrief({
    profileUrls: ["https://github.com/ada-example"],
    identityStatus: "confirmed",
    purpose: "self_audit",
    depth: "quick"
  });

  assert.equal(defaultBrief.subject.identity_status, "unconfirmed");
  assert.equal(confirmedBrief.subject.identity_status, "confirmed");
  assert.throws(() => createResearchBrief({
    profileUrls: ["https://github.com/ada-example"],
    identityStatus: "verified_by_magic",
    purpose: "self_audit",
    depth: "quick"
  }), /identity status/i);
});

test("the portable brief rejects research without an identity anchor", () => {
  assert.throws(() => createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: [],
    purpose: "self_audit",
    depth: "quick"
  }), /identity anchor/i);
});

test("identity anchors discard fragments and reject credential-shaped query parameters", () => {
  const brief = createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://example.com/ada#access_token=fragment-secret"],
    purpose: "self_audit",
    depth: "quick"
  });

  assert.deepEqual(brief.subject.identity_anchors, ["https://example.com/ada"]);
  assert.throws(() => createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://example.com/ada?access_token=query-secret"],
    purpose: "self_audit",
    depth: "quick"
  }), /query parameter.*credential/i);
  assert.throws(() => createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://example.com/ada?clientSecret=query-secret"],
    purpose: "self_audit",
    depth: "quick"
  }), /query parameter.*credential/i);

  const imported = structuredClone(brief);
  imported.subject.identity_anchors = ["https://example.com/ada#token=fragment-secret"];
  assert.match(validateResearchBrief(imported).join("; "), /fragment|canonical/i);
});

test("known social hosts reject content and navigation URLs that would be mistaken for profile handles", () => {
  for (const profileUrl of [
    "https://www.instagram.com/p/ABC123/",
    "https://x.com/i/lists/123",
    "https://www.facebook.com/profile.php?id=123",
    "https://github.com/ada-example/project",
    "https://github.com/settings",
    "https://www.youtube.com/watch?v=ABC123",
    "https://youtu.be/ABC123",
    "https://www.tiktok.com/@ada.example/video/123"
  ]) {
    assert.throws(() => createResearchBrief({
      subjectName: "Ada Example",
      profileUrls: [profileUrl],
      purpose: "self_audit",
      depth: "quick"
    }), /profile URL|supported public profile/i, profileUrl);
  }

  assert.doesNotThrow(() => createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: [
      "https://www.instagram.com/ada_example/",
      "https://x.com/ada_example",
      "https://www.linkedin.com/in/ada-example",
      "https://github.com/ada-example",
      "https://www.youtube.com/@ada-example",
      "https://www.tiktok.com/@ada.example"
    ],
    purpose: "self_audit",
    depth: "quick"
  }));
});

test("the generated prompt preserves scope and evidence limits", () => {
  const brief = createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://github.com/ada-example/"],
    purpose: "marketplace_safety",
    depth: "standard",
    modules: ["identity", "credibility", "controversies"],
    customInstructions: "Check whether the trading history claims reconcile."
  });

  assert.deepEqual(validateResearchBrief(brief), []);
  const prompt = buildPortablePrompt(brief);
  assert.match(prompt, /https:\/\/github\.com\/ada-example\//);
  assert.match(prompt, /marketplace safety/i);
  assert.match(prompt, /trading history claims reconcile/i);
  assert.match(prompt, /do not turn missing evidence into reassurance/i);
});

test("hosted tiers price execution rather than hiding the open method", () => {
  assert.deepEqual(SERVICE_TIERS.map(({ priceUsd }) => priceUsd), [0, 20, 80, 200]);
  assert.equal(SERVICE_TIERS[0].methodAccess, "full_open_source_method");
  assert.ok(SERVICE_TIERS.every((tier) => tier.methodAccess === "full_open_source_method"));
  assert.ok(SERVICE_TIERS.every((tier) => Number.isInteger(tier.budget.maxItems)));
  assert.ok(SERVICE_TIERS.every((tier) => tier.scopePolicy === "same_public_scope"));
});

test("unsafe custom instructions are refused before research starts", () => {
  assert.throws(() => createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://github.com/ada-example"],
    purpose: "dating_safety",
    depth: "deep",
    customInstructions: "Find her home address and diagnose whether she has ADHD."
  }), /custom instructions.*address|diagnos/i);
});
