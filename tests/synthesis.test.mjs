import assert from "node:assert/strict";
import test from "node:test";

import { synthesiseSourceItems } from "../report/synthesise.mjs";

function item(id, overrides = {}) {
  return {
    item_id: `item:${id}`,
    evidence_id: `evidence:${id}`,
    platform: "youtube",
    item_type: "youtube_video",
    canonical_url: `https://example.com/${id}`,
    title: "Evidence systems in practice",
    text: "A public explanation of evidence systems and careful verification.",
    published_at: `2026-08-${id.padStart(2, "0")}T00:00:00.000Z`,
    subject_relation: "provided_anchor",
    ...overrides
  };
}

test("extractive synthesis cites item evidence and keeps candidate search leads separate", () => {
  const sourceItems = [
    item("01"),
    item("02", { title: "Careful evidence review" }),
    item("03", {
      platform: "web_search",
      item_type: "web_discovery_lead",
      subject_relation: "candidate",
      title: "Unverified same-name result"
    })
  ];
  const result = synthesiseSourceItems(sourceItems, { identityStatus: "confirmed" });

  assert.equal(result.state, "extractive_synthesis");
  assert.equal(result.established_item_count, 2);
  assert.equal(result.candidate_item_count, 1);
  assert.ok(result.findings.every((finding) => finding.evidence_ids.length > 0));
  assert.ok(result.findings.every((finding) => !finding.evidence_ids.includes("evidence:03")));
  assert.ok(result.repeated_topics.some((theme) => theme.term === "evidence" && theme.item_count === 2));
  assert.equal(result.timeline[0].evidence_id, "evidence:02");
  assert.equal(result.public_persona.state, "bounded_extract");
  assert.match(result.public_persona.statement, /not the whole person/i);
});

test("one item does not create a repeated-topic persona claim", () => {
  const result = synthesiseSourceItems([item("01")], { identityStatus: "confirmed" });
  assert.equal(result.public_persona.state, "insufficient_sample");
  assert.deepEqual(result.repeated_topics, []);
});

test("unconfirmed supplied profiles are not merged into a person-level synthesis", () => {
  const result = synthesiseSourceItems([
    item("01", { platform: "github", text: "Builds security tools in Perth" }),
    item("02", { platform: "instagram", text: "Fashion and travel creator in London" })
  ], { identityStatus: "candidates" });

  assert.equal(result.state, "identity_not_confirmed");
  assert.equal(result.established_item_count, 0);
  assert.equal(result.supplied_unconfirmed_item_count, 2);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.repeated_topics, []);
  assert.equal(result.public_persona.state, "identity_not_confirmed");
});

test("repeated-topic extraction ignores normaliser labels and URL fragments", () => {
  const result = synthesiseSourceItems([
    item("01", {
      platform: "github",
      title: "Evidence reader",
      text: "Description: Careful verification tooling\nLanguage: JavaScript\nHomepage: https://example.com/evidence"
    }),
    item("02", {
      platform: "github",
      title: "Evidence ledger",
      text: "Description: Careful verification records\nLanguage: JavaScript\nHomepage: https://example.com/ledger"
    })
  ], { identityStatus: "confirmed" });

  const terms = result.repeated_topics.map((theme) => theme.term);
  assert.ok(terms.includes("verification"));
  assert.ok(terms.includes("javascript"));
  assert.ok(!terms.includes("description"));
  assert.ok(!terms.includes("language"));
  assert.ok(!terms.includes("homepage"));
  assert.ok(!terms.some((term) => term.includes("example")));
});
