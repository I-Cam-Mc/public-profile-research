import assert from "node:assert/strict";
import test from "node:test";

import { buildReportHtml, buildReportModel } from "../report/build-report.mjs";

function fixtureRun() {
  return {
    schema_version: 1,
    run_id: "run-example",
    generated_at: "2026-09-03T10:00:00.000Z",
    status: "partial",
    research_brief: {
      schema_version: 1,
      contract_type: "research_intake",
      research_state: "not_run",
      research_mode: "insight",
      relationship_to_subject: "self",
      corpus_scope: "public_only",
      subject: {
        display_name: "Ada Example",
        identity_anchors: ["https://github.com/ada-example"],
        identity_status: "unconfirmed"
      },
      purpose: "self_audit",
      depth: "quick",
      cost_policy: "free_tools_only",
      modules: ["identity", "career", "code"],
      custom_instructions: "",
      analysis_policy: {}
    },
    targets: [
      {
        platform: "github",
        canonical_url: "https://github.com/ada-example",
        status: "collected",
        attempts: [{
          adapter_id: "github_public_api",
          status: "collected",
          receipt_path: "receipts/00-github_public_api.json",
          receipt_sha256: "a".repeat(64)
        }]
      },
      {
        platform: "linkedin",
        canonical_url: "https://www.linkedin.com/in/ada-example",
        status: "unavailable",
        attempts: [{
          adapter_id: "agent_reach_linkedin",
          status: "unavailable",
          message: "Authentication required",
          receipt_path: "receipts/01-agent_reach_linkedin.json",
          receipt_sha256: "b".repeat(64)
        }]
      }
    ]
  };
}

const receipts = {
  "receipts/00-github_public_api.json": {
    schema_version: 1,
    adapter_id: "github_public_api",
    status: "collected",
    coverage: "public_profile_and_up_to_100_public_repositories",
    ended_at: "2026-09-03T09:59:00.000Z",
    source_urls: ["https://github.com/ada-example"],
    data: {
      profile: {
        login: "ada-example",
        name: "Ada Example",
        bio: "Builds careful software",
        company: "Example Labs",
        public_repos: 2,
        followers: 42,
        created_at: "2020-01-01T00:00:00Z"
      },
      repositories: [
        { name: "ledger", html_url: "https://github.com/ada-example/ledger", description: "Evidence ledger", language: "JavaScript", stargazers_count: 8, forks_count: 1, updated_at: "2026-09-01T00:00:00Z" },
        { name: "reader", html_url: "https://github.com/ada-example/reader", description: "Public reader", language: "TypeScript", stargazers_count: 3, forks_count: 0, updated_at: "2026-08-01T00:00:00Z" }
      ]
    }
  }
};

test("the report exposes actual collected facts with evidence references", () => {
  const run = fixtureRun();
  run.identity = { status: "confirmed", confirmed_by: "explicit_subject_confirmation", reasons: ["Confirmed for this fixture"] };
  const model = buildReportModel(run, receipts);

  assert.equal(model.subject.display_name, "Ada Example");
  assert.equal(model.research_state, "partial");
  assert.equal(model.coverage.collected_targets, 1);
  assert.equal(model.coverage.unavailable_targets, 1);
  assert.equal(model.highlights.github.public_repositories, 2);
  assert.deepEqual(model.highlights.github.languages, [{ name: "JavaScript", count: 1 }, { name: "TypeScript", count: 1 }]);
  assert.ok(model.findings.length >= 4);
  assert.ok(model.findings.every((finding) => finding.evidence_ids.length > 0));
  assert.ok(!("trust_score" in model));
  assert.equal(model.analysis.public_persona.state, "not_synthesised");
});

test("the report keeps inaccessible sources visible and does not claim completeness", () => {
  const model = buildReportModel(fixtureRun(), receipts);
  const linkedin = model.coverage.sources.find((source) => source.platform === "linkedin");

  assert.equal(linkedin.status, "unavailable");
  assert.match(linkedin.message, /authentication required/i);
  assert.match(model.coverage.statement, /partial/i);
  assert.doesNotMatch(model.coverage.statement, /complete corpus/i);
});

test("the HTML is a self-contained evidence-linked profile rather than an empty shell", () => {
  const model = buildReportModel(fixtureRun(), receipts);
  const html = buildReportHtml(model);

  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Ada Example/);
  assert.match(html, /Builds careful software/);
  assert.match(html, /Evidence ledger/);
  assert.match(html, /Authentication required/);
  assert.match(html, /Source coverage/);
  assert.match(html, /not synthesised/i);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+rel=["']stylesheet/i);
});

test("the generated report contains narrow-screen overflow containment", () => {
  const html = buildReportHtml(buildReportModel(fixtureRun(), receipts));

  assert.match(html, /\.repo-card p,\.discovery-card p,\.fact strong,\.timeline time\{overflow-wrap:anywhere;word-break:break-word\}/);
  assert.match(html, /\.table-wrap\{overflow-x:auto;max-width:100%\}/);
  assert.match(html, /main\{[^}]*min-width:0\}/);
  assert.match(html, /section\{[^}]*min-width:0\}/);
});

test("untrusted collected text and URLs cannot become executable report markup", () => {
  const poisonedReceipts = structuredClone(receipts);
  poisonedReceipts["receipts/00-github_public_api.json"].data.profile.bio = '<script>alert("x")</script>';
  poisonedReceipts["receipts/00-github_public_api.json"].data.repositories[0].html_url = "javascript:alert(1)";
  const html = buildReportHtml(buildReportModel(fixtureRun(), poisonedReceipts));

  assert.doesNotMatch(html, /<script>alert/i);
  assert.match(html, /&lt;script&gt;alert/);
  assert.doesNotMatch(html, /href=["']javascript:/i);
});

test("Agent Reach discovery results become visible evidence-linked leads", () => {
  const run = fixtureRun();
  run.targets.push({
    platform: "web_search",
    canonical_url: "https://github.com/ada-example",
    status: "collected",
    attempts: [{
      adapter_id: "agent_reach_exa",
      status: "collected",
      receipt_path: "receipts/02-agent_reach_exa.json",
      receipt_sha256: "c".repeat(64)
    }]
  });
  run.targets.push({
    platform: "web_lead",
    canonical_url: "https://example.com/talk",
    source_role: "optional_discovery",
    optional_discovery: true,
    status: "collected",
    attempts: [{
      adapter_id: "jina_reader",
      status: "collected",
      receipt_path: "receipts/03-jina_reader.json",
      receipt_sha256: "d".repeat(64)
    }]
  });
  run.targets.push({
    platform: "web_lead",
    canonical_url: "https://example.org/ada",
    source_role: "optional_discovery",
    optional_discovery: true,
    status: "not_attempted",
    barrier: "follow_up_budget_reached",
    message: "Not attempted because the quick follow-up budget was reached",
    attempts: []
  });
  const withDiscovery = {
    ...receipts,
    "receipts/02-agent_reach_exa.json": {
      status: "collected",
      adapter_id: "agent_reach_exa",
      data: {
        results: "Title: Ada Example at ExampleConf\nURL: https://example.com/talk\nPublished: 2025-04-10\nAuthor: ExampleConf\nHighlights:\nA public talk about evidence systems.\n\n---\n\nTitle: Ada Example profile\nURL: https://example.org/ada\nPublished: N/A\nAuthor: N/A\nHighlights:\nA candidate independent profile."
      }
    }
  };

  const model = buildReportModel(run, withDiscovery);
  assert.equal(model.highlights.web_discovery.length, 2);
  assert.equal(model.coverage.declared_targets, 2);
  assert.equal(model.coverage.discovery_targets, 2);
  assert.equal(model.coverage.collected_targets, 1);
  assert.equal(model.coverage.collected_discovery_targets, 1);
  assert.equal(model.coverage.not_attempted_discovery_targets, 1);
  assert.equal(model.highlights.web_discovery[0].title, "Ada Example at ExampleConf");
  assert.ok(model.highlights.web_discovery.every((lead) => lead.evidence_id === `receipt:${"c".repeat(64)}`));
  const html = buildReportHtml(model);
  assert.match(html, /Ada Example at ExampleConf/);
  assert.match(html, /A public talk about evidence systems/);
});

test("a collected source run keeps unresolved identity visible", () => {
  const model = buildReportModel(fixtureRun(), receipts);
  const html = buildReportHtml(model);

  assert.equal(model.subject.identity_status, "unconfirmed");
  assert.match(html, /Identity unconfirmed/i);
  assert.match(html, /source collection.*not identity confirmation/i);
});
