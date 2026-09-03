import assert from "node:assert/strict";
import test from "node:test";

import {
  assessClosure,
  assessCollectionClosure,
  assessIdentityClosure,
  assessModuleRequirements,
  assessResearchModeClosure
} from "../runner/closure.mjs";

function exhaustedDenominator(id = "listing") {
  return {
    id,
    coverage_role: "denominator",
    status: "exhausted",
    receipt: { path: `receipts/${id}.json`, sha256: "a".repeat(64) }
  };
}

function closedListing(accountUrl, count = 1) {
  return {
    status: "closed",
    target: { kind: "bounded_listing", account_url: accountUrl },
    denominator_basis: "terminal_pagination",
    enumerated_count: count,
    adapters: [exhaustedDenominator()]
  };
}

test("insight closes on useful supplied material while optional discovery gaps remain visible", () => {
  const result = assessClosure({
    researchMode: "insight",
    identity: { status: "candidates" },
    targets: [
      {
        id: "github",
        platform: "github",
        source_role: "supplied_material",
        material: true,
        status: "collected"
      },
      {
        id: "discovery",
        platform: "web_search",
        source_role: "optional_discovery",
        material: false,
        status: "unavailable",
        barrier: "tool_missing"
      }
    ]
  });

  assert.equal(result.collection.status, "complete");
  assert.equal(result.identity.status, "candidates");
  assert.equal(result.identity.satisfied, false);
  assert.equal(result.research_mode.status, "satisfied_with_optional_gaps");
  assert.equal(result.research_mode.satisfied, true);
  assert.equal(result.run_status, "partial");
  assert.equal(result.run_status_scope, "collection_identity_research_mode_and_module_requirements");
  assert.deepEqual(result.gaps.optional_discovery.map((gap) => gap.id), ["discovery"]);
});

test("insight remains partial when a supplied material target has no useful evidence", () => {
  const result = assessClosure({
    researchMode: "insight",
    identity: { status: "confirmed" },
    targets: [
      { id: "github", platform: "github", material: true, status: "collected" },
      { id: "youtube", platform: "youtube", material: true, status: "unavailable" }
    ]
  });

  assert.equal(result.collection.status, "partial");
  assert.equal(result.research_mode.satisfied, false);
  assert.equal(result.run_status, "partial");
  assert.deepEqual(result.gaps.material.map((gap) => gap.id), ["youtube"]);
});

test("bounded census does not close without an explicit boundary and denominator", () => {
  const result = assessClosure({
    researchMode: "bounded_census",
    identity: { status: "confirmed" },
    targets: [{ id: "youtube", platform: "youtube", status: "collected" }],
    sourceFamilies: [{ id: "youtube", material: true, coverage_complete: true }]
  });

  assert.equal(result.collection.status, "complete");
  assert.equal(result.research_mode.satisfied, false);
  assert.equal(result.research_mode.status, "unsatisfied");
  assert.equal(result.run_status, "partial");
  assert.match(result.research_mode.gaps[0].reason, /boundary|denominator/i);
});

test("bounded census closes when each material family has a reconciled explicit boundary", () => {
  const result = assessClosure({
    researchMode: "bounded_census",
    identity: { status: "confirmed" },
    targets: [{ id: "youtube", platform: "youtube", status: "collected" }],
    sourceFamilies: [{
      id: "youtube",
      material: true,
      enumeration: {
        status: "closed",
        target: {
          kind: "date_interval",
          account_url: "https://www.youtube.com/@ada-example",
          start: "2025-01-01",
          end: "2026-01-01"
        },
        denominator_basis: "complete_api_listing",
        expected_count: 12,
        enumerated_count: 12,
        query_intervals: [{ start: "2025-01-01", end: "2026-01-01", status: "exhausted" }],
        adapters: [exhaustedDenominator("youtube-listing")]
      }
    }]
  });

  assert.equal(result.research_mode.status, "satisfied");
  assert.equal(result.research_mode.satisfied, true);
  assert.equal(result.run_status, "completed");
  assert.deepEqual(result.gaps.research_mode, []);
});

test("maximum public coverage stays open when any material family lacks coverage_complete", () => {
  const result = assessClosure({
    researchMode: "maximum_public_coverage",
    identity: { status: "confirmed" },
    targets: [
      { id: "github", platform: "github", status: "collected" },
      { id: "youtube", platform: "youtube", status: "collected" }
    ],
    sourceFamilies: [
      { id: "github", material: true, coverage_complete: true, enumeration: closedListing("https://github.com/ada-example") },
      { id: "youtube", material: true, coverage_complete: false },
      { id: "web-search", material: false, optional_discovery: true, coverage_complete: false }
    ]
  });

  assert.equal(result.collection.status, "complete");
  assert.equal(result.research_mode.satisfied, false);
  assert.equal(result.run_status, "partial");
  assert.deepEqual(result.research_mode.gaps.map((gap) => gap.id), ["youtube"]);
  assert.deepEqual(result.research_mode.optional_gaps.map((gap) => gap.id), ["web-search"]);
});

test("maximum public coverage closes only when every material family is complete", () => {
  const result = assessClosure({
    researchMode: "maximum_public_coverage",
    identity: "confirmed",
    targets: [
      { id: "github", platform: "github", status: "collected" },
      { id: "youtube", platform: "youtube", status: "collected" }
    ],
    sourceFamilies: [
      { id: "github", material: true, coverage_complete: true, enumeration: closedListing("https://github.com/ada-example") },
      { id: "youtube", material: true, coverage_complete: true, enumeration: closedListing("https://www.youtube.com/@ada-example") }
    ]
  });

  assert.equal(result.research_mode.status, "satisfied");
  assert.equal(result.research_mode.satisfied, true);
  assert.equal(result.run_status, "completed");
});

test("bounded census rejects an unbounded date interval", () => {
  const result = assessClosure({
    researchMode: "bounded_census",
    identity: "confirmed",
    targets: [{ id: "posts", platform: "x", status: "collected" }],
    sourceFamilies: [{
      id: "posts",
      material: true,
      enumeration: {
        status: "closed",
        target: { kind: "date_interval" },
        denominator_basis: "terminal_pagination",
        expected_count: 8,
        enumerated_count: 8
      }
    }]
  });

  assert.equal(result.research_mode.satisfied, false);
  assert.match(result.research_mode.gaps[0].reason, /start.*end|date interval/i);
});

test("terminal pagination supplies a denominator without a predeclared expected count", () => {
  const result = assessClosure({
    researchMode: "bounded_census",
    identity: "confirmed",
    targets: [{ id: "posts", platform: "x", status: "collected" }],
    sourceFamilies: [{
      id: "posts",
      material: true,
      enumeration: {
        status: "closed",
        target: { kind: "bounded_listing", account_url: "https://x.com/ada-example" },
        denominator_basis: "terminal_pagination",
        enumerated_count: 31,
        adapters: [exhaustedDenominator("x-pagination")]
      }
    }]
  });

  assert.equal(result.research_mode.satisfied, true);
});

test("bounded census cannot close from a declared count without exhausted denominator evidence", () => {
  const result = assessClosure({
    researchMode: "bounded_census",
    identity: "confirmed",
    targets: [{ id: "posts", platform: "x", status: "collected" }],
    sourceFamilies: [{
      id: "posts",
      material: true,
      enumeration: {
        status: "closed",
        target: { kind: "bounded_listing", account_url: "https://x.com/ada-example" },
        denominator_basis: "terminal_pagination",
        enumerated_count: 31
      }
    }]
  });

  assert.equal(result.research_mode.satisfied, false);
  assert.match(result.research_mode.gaps[0].reason, /denominator.*evidence|exhausted/i);
});

test("date-bounded census requires gap-free exhausted query intervals", () => {
  const result = assessClosure({
    researchMode: "bounded_census",
    identity: "confirmed",
    targets: [{ id: "posts", platform: "x", status: "collected" }],
    sourceFamilies: [{
      id: "posts",
      material: true,
      enumeration: {
        status: "closed",
        target: { kind: "date_interval", account_url: "https://x.com/ada-example", start: "2025-01-01", end: "2026-01-01" },
        denominator_basis: "date_bucket_exhaustion",
        enumerated_count: 0,
        adapters: [exhaustedDenominator("x-dates")]
      }
    }]
  });

  assert.equal(result.research_mode.satisfied, false);
  assert.match(result.research_mode.gaps[0].reason, /query interval|date interval/i);
});

test("maximum coverage cannot close from a bare coverage_complete flag", () => {
  const result = assessClosure({
    researchMode: "maximum_public_coverage",
    identity: "confirmed",
    targets: [{ id: "github", platform: "github", status: "collected" }],
    sourceFamilies: [{ id: "github", material: true, coverage_complete: true }]
  });

  assert.equal(result.research_mode.satisfied, false);
  assert.match(result.research_mode.gaps[0].reason, /boundary|denominator|enumeration/i);
});

test("maximum coverage rejects demoting a supplied family to non-material", () => {
  const result = assessClosure({
    researchMode: "maximum_public_coverage",
    identity: "confirmed",
    targets: [
      { id: "github", platform: "github", status: "collected" },
      { id: "youtube", platform: "youtube", status: "collected" }
    ],
    sourceFamilies: [
      { id: "github", material: true, coverage_complete: true, enumeration: closedListing("https://github.com/ada-example") },
      { id: "youtube", material: false, coverage_complete: false }
    ]
  });

  assert.equal(result.research_mode.satisfied, false);
  assert.ok(result.research_mode.gaps.some((gap) => gap.id === "youtube"));
});

test("maximum coverage cannot omit a supplied target from its source families", () => {
  const result = assessClosure({
    researchMode: "maximum_public_coverage",
    identity: "confirmed",
    targets: [
      { id: "github", platform: "github", status: "collected" },
      { id: "youtube", platform: "youtube", status: "collected" }
    ],
    sourceFamilies: [
      { id: "github", material: true, coverage_complete: true, enumeration: closedListing("https://github.com/ada-example") }
    ]
  });

  assert.equal(result.research_mode.satisfied, false);
  assert.ok(result.research_mode.gaps.some((gap) => gap.id === "youtube"));
});

test("useful partial collection can satisfy insight without claiming collection completeness", () => {
  const result = assessClosure({
    researchMode: "insight",
    identity: "candidates",
    targets: [{
      id: "youtube",
      platform: "youtube",
      status: "partial",
      useful_material: true
    }]
  });

  assert.equal(result.collection.status, "partial");
  assert.equal(result.research_mode.satisfied, true);
  assert.equal(result.run_status, "partial");
  assert.deepEqual(result.gaps.collection_coverage.map((gap) => gap.id), ["youtube"]);
});

test("bounded census rejects calendar-invalid interval dates", () => {
  const result = assessClosure({
    researchMode: "bounded_census",
    identity: "confirmed",
    targets: [{ id: "posts", platform: "x", status: "collected" }],
    sourceFamilies: [{
      id: "posts",
      material: true,
      enumeration: {
        status: "closed",
        target: { kind: "date_interval", start: "2025-13-40", end: "2026-01-01" },
        denominator_basis: "terminal_pagination",
        enumerated_count: 0
      }
    }]
  });

  assert.equal(result.research_mode.satisfied, false);
});

test("each closure axis is independently callable", () => {
  const collection = assessCollectionClosure([{ id: "github", platform: "github", status: "collected" }]);
  const identity = assessIdentityClosure("candidates");
  const researchMode = assessResearchModeClosure({
    researchMode: "insight",
    collection
  });

  assert.equal(collection.status, "complete");
  assert.equal(identity.status, "candidates");
  assert.equal(researchMode.satisfied, true);
});

test("module closure accounts for every requested module instead of silently unevaluating some", () => {
  const requestedModules = [
    "identity",
    "current_activity",
    "timeline",
    "career",
    "projects",
    "companies",
    "public_impression",
    "public_persona",
    "credibility",
    "controversies",
    "professional_network",
    "media",
    "code",
    "commercial_activity"
  ];
  const result = assessModuleRequirements({
    requestedModules,
    identity: { status: "confirmed" },
    observedAt: "2026-09-03T00:00:00.000Z",
    sourceItems: [{
      evidence_id: "evidence:repository",
      subject_relation: "provided_anchor",
      content_quality: "usable",
      platform: "github",
      item_type: "github_repository",
      canonical_url: "https://github.com/alice-example/research",
      published_at: "2024-01-01T00:00:00.000Z",
      metrics: { updated_at: "2026-08-15T00:00:00.000Z" }
    }]
  });

  assert.deepEqual(result.results.map((entry) => entry.module), requestedModules);
  assert.deepEqual(result.unevaluated_modules, []);
  assert.equal(result.results.find((entry) => entry.module === "identity").satisfied, true);
  assert.equal(result.results.find((entry) => entry.module === "current_activity").satisfied, true);
  assert.equal(result.results.find((entry) => entry.module === "timeline").satisfied, true);
  assert.equal(result.results.find((entry) => entry.module === "projects").satisfied, true);
  assert.equal(result.results.find((entry) => entry.module === "code").barrier, "active_cited_pass_not_run");
  assert.equal(result.results.find((entry) => entry.module === "media").barrier, "media_modality_unavailable");
  assert.equal(result.satisfied, false);
});

test("current activity does not close from an account or repository creation date", () => {
  const result = assessModuleRequirements({
    requestedModules: ["current_activity"],
    observedAt: "2026-09-03T00:00:00.000Z",
    sourceItems: [{
      evidence_id: "evidence:profile-created",
      subject_relation: "provided_anchor",
      content_quality: "usable",
      item_type: "github_profile",
      published_at: "2026-08-20T00:00:00.000Z",
      metrics: {}
    }]
  });

  assert.equal(result.satisfied, false);
  assert.equal(result.gaps[0].barrier, "recent_activity_evidence_unavailable");
  assert.equal(result.gaps[0].observation_window.days, 365);
  assert.equal(result.gaps[0].observation_window.end, "2026-09-03T00:00:00.000Z");
});

test("active modules and custom instructions close only from exact evidence-linked completion records", () => {
  const sourceItems = [{
    evidence_id: "evidence:source",
    subject_relation: "provided_anchor",
    content_quality: "usable",
    item_type: "github_repository"
  }];
  const open = assessModuleRequirements({
    requestedModules: ["code"],
    sourceItems,
    customInstructions: "Review the implementation quality."
  });

  assert.deepEqual(open.gaps.map((gap) => gap.module), ["code", "custom_instructions"]);

  const contentFreeRecord = assessModuleRequirements({
    requestedModules: ["code"],
    sourceItems,
    completionRecords: [{
      module: "code",
      status: "satisfied",
      method: "active_evidence_linked_pass",
      evidence_ids: ["evidence:source"]
    }]
  });
  assert.equal(contentFreeRecord.satisfied, false);
  assert.equal(contentFreeRecord.gaps[0].barrier, "invalid_completion_record");

  const completed = assessModuleRequirements({
    requestedModules: ["code"],
    sourceItems,
    customInstructions: "Review the implementation quality.",
    completionRecords: [
      {
        module: "code",
        status: "satisfied",
        method: "active_evidence_linked_pass",
        statement: "Reviewed the collected repository implementation and recorded the cited result.",
        evidence_ids: ["evidence:source"]
      },
      {
        module: "custom_instructions",
        instructions: "Review the implementation quality.",
        status: "satisfied",
        method: "active_evidence_linked_pass",
        statement: "Reconciled the requested implementation-quality question against the cited repository.",
        evidence_ids: ["evidence:source"]
      }
    ]
  });

  assert.equal(completed.satisfied, true);
  assert.deepEqual(completed.gaps, []);
  assert.deepEqual(completed.results.map((entry) => entry.module), ["code", "custom_instructions"]);
});

test("a collected target explicitly marked unusable cannot close collection", () => {
  const result = assessClosure({
    researchMode: "insight",
    identity: "confirmed",
    targets: [
      { id: "github", platform: "github", status: "collected" },
      { id: "empty", platform: "youtube", status: "collected", useful_material: false }
    ]
  });

  assert.equal(result.collection.status, "partial");
  assert.equal(result.research_mode.satisfied, false);
  assert.deepEqual(result.gaps.material.map((gap) => gap.id), ["empty"]);
});

test("a boundary kind without an account boundary cannot close a census", () => {
  const result = assessClosure({
    researchMode: "bounded_census",
    identity: "confirmed",
    targets: [{ id: "posts", platform: "x", status: "collected" }],
    sourceFamilies: [{
      id: "posts",
      material: true,
      enumeration: {
        status: "closed",
        target: { kind: "lifetime" },
        denominator_basis: "terminal_pagination",
        enumerated_count: 31
      }
    }]
  });

  assert.equal(result.research_mode.satisfied, false);
  assert.match(result.research_mode.gaps[0].reason, /account|boundary/i);
});

test("useful but partial optional discovery remains a visible coverage gap", () => {
  const result = assessClosure({
    researchMode: "insight",
    identity: "candidates",
    targets: [
      { id: "github", platform: "github", status: "collected" },
      { id: "search", platform: "web_search", status: "partial", useful_material: true }
    ]
  });

  assert.equal(result.run_status, "partial");
  assert.deepEqual(result.gaps.optional_discovery.map((gap) => gap.id), ["search"]);
});

test("an identity conflict keeps the overall run partial even when collection and research mode close", () => {
  const result = assessClosure({
    researchMode: "insight",
    identity: "conflict",
    targets: [{ id: "github", platform: "github", status: "collected" }]
  });

  assert.equal(result.collection.status, "complete");
  assert.equal(result.research_mode.satisfied, true);
  assert.equal(result.identity.satisfied, false);
  assert.equal(result.run_status, "partial");
});
