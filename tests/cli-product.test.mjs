import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadReceipts } from "../report/build-report.mjs";
import { buildDiscoveryQueries, runResearchProduct } from "../runner/research-product.mjs";
import { createResearchBrief } from "../website/lib/research-brief.mjs";

const publicLookup = async () => [{ address: "140.82.121.3", family: 4 }];

test("discovery query planning scales by depth without accepting identity fields as search operators", () => {
  const base = {
    subject: {
      display_name: "Alice Example\" site:attacker.example",
      identity_anchors: ["https://github.com/alice-example", "https://example.com/%2D%2Dsite%3Aevil"]
    },
    modules: ["identity", "career", "projects", "media"]
  };
  const expected = { quick: 1, standard: 5, deep: 9, maximum: 14 };
  for (const [depth, count] of Object.entries(expected)) {
    const queries = buildDiscoveryQueries({ ...base, depth });
    assert.equal(queries.length, count);
    assert.equal(new Set(queries.map(({ query }) => query)).size, count);
    assert.ok(queries.every(({ query }) => !query.includes("site:attacker.example")));
    assert.ok(queries.every(({ query }) => !query.includes("--site:evil")));
    assert.ok(queries.every(({ max_results }) => max_results === (depth === "quick" ? 10 : 6)));
  }
  const standard = buildDiscoveryQueries({ ...base, depth: "standard" });
  assert.ok(standard.some(({ strategy }) => strategy.startsWith("module_")));
  assert.ok(standard.some(({ query }) => /site:(?:linkedin\.com\/in|github\.com|youtube\.com)/.test(query)));
});

test("research product writes receipts, evidence, a ledger, run metadata and an HTML report", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-product-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://github.com/alice-example"],
      purpose: "self_audit",
      depth: "quick",
      modules: ["identity"]
    });
    brief.subject.identity_status = "confirmed";
    const discoveryQueries = [];
    const followedDiscoveryUrls = [];
    const adapters = {
      github_public_api: {
        async collect(target) {
          return {
            status: "collected",
            coverage: "public_profile_and_repositories",
            source_urls: [target.canonical_url],
            data: {
              profile: { login: "alice-example", name: "Alice Example", public_repos: 1 },
              repositories: [
                { id: 77, name: "public-project", html_url: "https://github.com/alice-example/public-project" },
                { id: 77, name: "public-project", html_url: "https://github.com/alice-example/public-project" }
              ]
            }
          };
        }
      },
      agent_reach_exa: {
        async collect(target) {
          discoveryQueries.push(target.query);
          return {
            status: "collected",
            coverage: "exa_semantic_search_up_to_10_results",
            source_urls: ["https://example.com/alice"],
            data: { results: [{ title: "Alice Example", url: "https://example.com/alice" }] }
          };
        }
      },
      jina_reader: {
        async collect(target) {
          followedDiscoveryUrls.push(target.canonical_url);
          return {
            status: "collected",
            coverage: "reader_visible_page",
            coverage_complete: true,
            source_urls: [target.canonical_url],
            data: { text: "Alice Example spoke publicly about reliable evidence systems." }
          };
        }
      }
    };

    const run = await runResearchProduct(brief, { outputDirectory: directory, adapters, lookup: publicLookup });
    const savedRun = JSON.parse(await readFile(path.join(directory, "research-run.json"), "utf8"));
    const ledger = JSON.parse(await readFile(path.join(directory, "evidence-ledger.json"), "utf8"));
    const evidence = JSON.parse(await readFile(path.join(directory, ledger.items[0].evidence_path), "utf8"));
    const report = await readFile(path.join(directory, "report", "index.html"), "utf8");

    assert.equal(run.status, "completed");
    assert.equal(savedRun.identity.status, "confirmed");
    assert.equal(savedRun.closure.identity.satisfied, true);
    assert.equal(savedRun.closure.research_mode.satisfied, true);
    assert.equal(savedRun.closure.run_status_scope, "collection_identity_research_mode_and_module_requirements");
    assert.equal(savedRun.completion.declared_targets, 1);
    assert.equal(savedRun.completion.collected_targets, 1);
    assert.equal(savedRun.completion.discovery_queries, 1);
    assert.equal(savedRun.completion.discovery_targets, 1);
    assert.equal(savedRun.completion.collected_discovery_targets, 1);
    assert.equal(savedRun.artifacts.evidence_ledger_path, "evidence-ledger.json");
    assert.match(savedRun.artifacts.evidence_ledger_sha256, /^[a-f0-9]{64}$/);
    assert.equal(savedRun.artifacts.html_report_path, "report/index.html");
    assert.match(savedRun.artifacts.html_report_sha256, /^[a-f0-9]{64}$/);
    assert.match(savedRun.artifacts.report_model_sha256, /^[a-f0-9]{64}$/);
    assert.equal(savedRun.runtime.node_version, process.version);
    assert.equal(savedRun.collection_policy.public_https_targets_only, true);
    assert.equal(savedRun.collection_policy.read_only_network_requests, true);
    assert.equal(ledger.items.length, 3);
    assert.equal(ledger.items[0].status, "collected");
    assert.match(ledger.items[0].evidence_sha256, /^[a-f0-9]{64}$/);
    assert.equal(ledger.source_items.length, 4);
    assert.equal(ledger.deduplicated_observations, 1);
    assert.ok(ledger.source_items.every((item) => item.evidence_id.startsWith("evidence:")));
    assert.ok(ledger.source_items.every((item) => item.archive_path.startsWith("evidence/items/")));
    const profileItem = ledger.source_items.find((item) => item.item_type === "github_profile");
    assert.ok(profileItem);
    const archivedItem = JSON.parse(await readFile(path.join(directory, profileItem.archive_path), "utf8"));
    assert.equal(archivedItem.item_id, profileItem.item_id);
    assert.equal(evidence.data.profile.login, "alice-example");
    assert.deepEqual(discoveryQueries, ["\"Alice Example\" alice-example"]);
    assert.deepEqual(followedDiscoveryUrls, ["https://example.com/alice"]);
    assert.equal(savedRun.targets[1].platform, "web_search");
    assert.equal(savedRun.targets[1].attempts[0].adapter_id, "agent_reach_exa");
    assert.equal(savedRun.targets[2].platform, "web_lead");
    assert.equal(savedRun.targets[2].subject_relation, "candidate");
    assert.equal(savedRun.targets[2].required, false);
    assert.match(report, /Alice Example/);
    assert.match(report, /public-project/);
    assert.match(report, /All required gates satisfied/i);
    assert.match(report, /Identity confirmed/i);
    assert.match(report, /normalised public items/i);
    assert.match(report, /\.\.\/evidence\/items\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional Agent Reach discovery failure stays visible without blocking an insight run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-product-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://github.com/alice-example"],
      purpose: "self_audit",
      depth: "quick",
      researchMode: "insight",
      modules: ["identity"]
    });
    brief.subject.identity_status = "confirmed";
    const run = await runResearchProduct(brief, {
      outputDirectory: directory,
      lookup: publicLookup,
      adapters: {
        github_public_api: {
          async collect() {
            return {
              status: "collected",
              coverage_complete: true,
              data: { profile: { login: "alice-example" }, repositories: [] }
            };
          }
        },
        agent_reach_exa: {
          async collect() {
            return { status: "unavailable", barrier: "tool_missing", message: "Agent Reach is not installed" };
          }
        }
      }
    });

    assert.equal(run.status, "completed");
    assert.equal(run.research_mode_satisfied, true);
    assert.equal(run.closure.collection.status, "complete");
    assert.equal(run.closure.gaps.optional_discovery.length, 1);
    assert.equal(run.targets.at(-1).platform, "web_search");
    assert.equal(run.targets.at(-1).status, "unavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requested media stays open when YouTube yields metadata without a usable transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-media-closure-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://www.youtube.com/@alice-example"],
      purpose: "self_audit",
      depth: "quick",
      researchMode: "insight",
      modules: ["identity", "media"]
    });
    brief.subject.identity_status = "confirmed";
    const run = await runResearchProduct(brief, {
      outputDirectory: directory,
      discovery: false,
      lookup: publicLookup,
      adapters: {
        yt_dlp: {
          async collect(target) {
            return {
              status: "collected",
              coverage_complete: false,
              source_urls: [target.canonical_url],
              data: {
                id: "video-1",
                title: "Metadata-only video",
                webpage_url: "https://www.youtube.com/watch?v=video-1",
                description: "A public video description without the spoken content.",
                transcript_collection: {
                  status: "unavailable",
                  barrier: "captions_not_available_or_returned",
                  files: []
                }
              }
            };
          }
        }
      }
    });
    const report = await readFile(path.join(directory, "report", "index.html"), "utf8");

    assert.equal(run.closure.collection.status, "complete");
    assert.equal(run.closure.research_mode.satisfied, true);
    assert.equal(run.status, "partial");
    assert.equal(run.closure.module_requirements.satisfied, false);
    assert.deepEqual(run.closure.gaps.module_requirements.map((gap) => gap.module), ["media"]);
    assert.match(run.closure.gaps.module_requirements[0].reason, /transcript|speech|modality/i);
    assert.doesNotMatch(report, /All required gates satisfied/i);
    assert.match(report, /requested analysis remains open/i);
    assert.match(report, /Media: 1 of 1 collected video has no usable transcript or speech review/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requested media can close when every collected video has a usable transcript", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-media-closure-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://www.youtube.com/@alice-example"],
      purpose: "self_audit",
      depth: "quick",
      researchMode: "insight",
      modules: ["identity", "media"]
    });
    brief.subject.identity_status = "confirmed";
    const run = await runResearchProduct(brief, {
      outputDirectory: directory,
      discovery: false,
      lookup: publicLookup,
      adapters: {
        yt_dlp: {
          async collect(target) {
            return {
              status: "collected",
              coverage_complete: true,
              source_urls: [target.canonical_url],
              data: {
                entries: [{
                  id: "video-1",
                  title: "Transcript-backed video",
                  webpage_url: "https://www.youtube.com/watch?v=video-1"
                }],
                transcript_collection: {
                  status: "collected",
                  files: [{
                    filename: "video-1.en.vtt",
                    text: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nThis is the spoken content."
                  }]
                }
              }
            };
          }
        }
      }
    });

    assert.equal(run.status, "completed");
    assert.equal(run.closure.module_requirements.status, "satisfied");
    const mediaResult = run.closure.module_requirements.results.find((result) => result.module === "media");
    assert.ok(mediaResult);
    assert.ok(mediaResult.evidence_ids.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interpretive modules stay open when the deterministic run only collected metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-interpretive-closure-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://github.com/alice-example"],
      purpose: "self_audit",
      depth: "quick",
      researchMode: "insight",
      modules: ["identity", "public_persona"]
    });
    brief.subject.identity_status = "confirmed";
    const run = await runResearchProduct(brief, {
      outputDirectory: directory,
      discovery: false,
      lookup: publicLookup,
      adapters: {
        github_public_api: {
          async collect() {
            return {
              status: "collected",
              coverage_complete: true,
              data: {
                profile: { login: "alice-example", bio: "Builds reliable evidence systems" },
                repositories: [{ id: 1, name: "evidence-one", html_url: "https://github.com/alice-example/evidence-one" }]
              }
            };
          }
        }
      }
    });
    const reportModel = JSON.parse(await readFile(path.join(directory, "report", "report.json"), "utf8"));
    const report = await readFile(path.join(directory, "report", "index.html"), "utf8");

    assert.equal(run.closure.collection.status, "complete");
    assert.equal(run.closure.research_mode.satisfied, true);
    assert.equal(run.status, "partial");
    assert.deepEqual(run.closure.gaps.module_requirements.map((gap) => gap.module), ["public_persona"]);
    assert.equal(run.closure.gaps.module_requirements[0].barrier, "active_cited_pass_not_run");
    assert.match(run.closure.gaps.module_requirements[0].reason, /active cited pass/i);
    assert.equal(reportModel.analysis.public_persona.state, "not_synthesised");
    assert.doesNotMatch(report, /All required gates satisfied/i);
    assert.match(report, /requested analysis remains open/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-empty custom instructions remain an explicit gap without a matching completion record", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-custom-closure-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://github.com/alice-example"],
      purpose: "self_audit",
      depth: "quick",
      researchMode: "insight",
      modules: ["identity"],
      customInstructions: "Reconcile the public project dates."
    });
    brief.subject.identity_status = "confirmed";
    const run = await runResearchProduct(brief, {
      outputDirectory: directory,
      discovery: false,
      lookup: publicLookup,
      adapters: {
        github_public_api: {
          async collect() {
            return {
              status: "collected",
              coverage_complete: true,
              data: { profile: { login: "alice-example" }, repositories: [] }
            };
          }
        }
      }
    });

    assert.equal(run.status, "partial");
    assert.deepEqual(run.closure.gaps.module_requirements.map((gap) => gap.module), ["custom_instructions"]);
    assert.equal(run.closure.gaps.module_requirements[0].barrier, "custom_instructions_not_completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovery coverage records candidates that exceed the follow-up budget", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-discovery-coverage-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://github.com/alice-example"],
      purpose: "self_audit",
      depth: "quick",
      modules: ["identity"]
    });
    brief.subject.identity_status = "confirmed";
    const followed = [];
    await runResearchProduct(brief, {
      outputDirectory: directory,
      lookup: publicLookup,
      adapters: {
        github_public_api: {
          async collect() {
            return {
              status: "collected",
              coverage_complete: true,
              data: { profile: { login: "alice-example" }, repositories: [] }
            };
          }
        },
        agent_reach_exa: {
          async collect() {
            return {
              status: "collected",
              data: {
                results: Array.from({ length: 4 }, (_, index) => ({
                  title: `Candidate ${index + 1}`,
                  url: `https://example.com/candidate-${index + 1}`
                }))
              }
            };
          }
        },
        jina_reader: {
          async collect(target) {
            followed.push(target.canonical_url);
            return {
              status: "collected",
              coverage_complete: true,
              data: { text: `Readable public page for ${target.canonical_url}` }
            };
          }
        }
      }
    });

    const savedRun = JSON.parse(await readFile(path.join(directory, "research-run.json"), "utf8"));
    const reportModel = JSON.parse(await readFile(path.join(directory, "report", "report.json"), "utf8"));
    const reportHtml = await readFile(path.join(directory, "report", "index.html"), "utf8");
    const leads = savedRun.targets.filter((target) => target.platform === "web_lead");

    assert.deepEqual(followed, [
      "https://example.com/candidate-1",
      "https://example.com/candidate-2"
    ]);
    assert.equal(leads.length, 4);
    assert.deepEqual(leads.map((target) => target.status), [
      "collected",
      "collected",
      "not_attempted",
      "not_attempted"
    ]);
    assert.ok(leads.slice(2).every((target) => target.barrier === "follow_up_budget_reached"));
    assert.equal(savedRun.completion.discovery_targets, 4);
    assert.equal(savedRun.completion.collected_discovery_targets, 2);
    assert.equal(savedRun.completion.not_attempted_discovery_targets, 2);
    assert.equal(
      savedRun.closure.gaps.optional_discovery.filter((gap) => gap.status === "not_attempted")[0].barrier,
      "follow_up_budget_reached"
    );
    assert.equal(reportModel.coverage.discovery_targets, 4);
    assert.equal(reportModel.coverage.collected_discovery_targets, 2);
    assert.equal(reportModel.coverage.not_attempted_discovery_targets, 2);
    assert.match(reportHtml, /2 of 4 discovered candidate pages were readable/i);
    assert.match(reportHtml, /2 were not attempted because the follow-up budget was reached/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standard discovery fans out bounded queries, keeps separate receipts and deduplicates candidate URLs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-discovery-fanout-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://github.com/alice-example"],
      purpose: "self_audit",
      depth: "standard",
      researchMode: "insight",
      modules: ["identity"]
    });
    brief.subject.identity_status = "confirmed";
    const searchTargets = [];
    const followed = [];
    const run = await runResearchProduct(brief, {
      outputDirectory: directory,
      lookup: publicLookup,
      adapters: {
        github_public_api: {
          async collect() {
            return {
              status: "collected",
              coverage_complete: true,
              data: { profile: { login: "alice-example" }, repositories: [] }
            };
          }
        },
        agent_reach_exa: {
          async collect(target) {
            const queryIndex = searchTargets.length;
            searchTargets.push(structuredClone(target));
            return {
              status: "collected",
              coverage_complete: false,
              data: {
                results: [
                  { title: "Common candidate", url: `https://example.com/common?utm_source=query-${queryIndex}` },
                  ...Array.from({ length: 8 }, (_, resultIndex) => ({
                    title: `Query ${queryIndex} result ${resultIndex}`,
                    url: `https://example.com/query-${queryIndex}/result-${resultIndex}`
                  }))
                ]
              }
            };
          }
        },
        jina_reader: {
          async collect(target) {
            followed.push(target.canonical_url);
            return {
              status: "collected",
              coverage_complete: true,
              data: { text: `Readable candidate page for ${target.canonical_url}` }
            };
          }
        }
      }
    });
    const saved = JSON.parse(await readFile(path.join(directory, "research-run.json"), "utf8"));
    const ledger = JSON.parse(await readFile(path.join(directory, "evidence-ledger.json"), "utf8"));
    const searchTargetsInRun = saved.targets.filter((target) => target.platform === "web_search");
    const leadTargets = saved.targets.filter((target) => target.platform === "web_lead");

    assert.equal(searchTargets.length, 5);
    assert.equal(searchTargetsInRun.length, 5);
    assert.equal(new Set(searchTargetsInRun.map((target) => target.attempts[0].receipt_path)).size, 5);
    assert.ok(searchTargets.every((target) => target.max_results === 6));
    assert.ok(searchTargets.every((target) => target.query.includes('"Alice Example"')));
    assert.ok(searchTargets.some((target) => /site:(?:linkedin\.com\/in|github\.com|youtube\.com)/.test(target.query)));
    assert.equal(leadTargets.length, 26);
    assert.equal(new Set(leadTargets.map((target) => target.canonical_url)).size, 26);
    assert.equal(followed.length, 5);
    assert.equal(leadTargets.filter((target) => target.status === "not_attempted").length, 21);
    assert.equal(saved.completion.discovery_queries, 5);
    assert.equal(saved.completion.discovery_targets, 26);
    assert.deepEqual(saved.discovery, {
      depth: "standard",
      query_budget: 5,
      planned_queries: 5,
      attempted_queries: 5,
      per_query_result_limit: 6,
      maximum_result_occurrences: 30,
      candidate_occurrences: 30,
      unique_candidate_urls: 26,
      duplicates_removed: 4,
      follow_up_page_budget: 5,
      followed_candidate_pages: 5,
      not_attempted_candidate_pages: 21
    });
    assert.equal(ledger.source_items.filter((item) => item.item_type === "web_discovery_lead").length, 26);
    assert.equal(run.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("research product validates every declared target before collection begins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-product-"));
  const directory = path.join(root, "run");
  let collections = 0;
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://github.com/alice-example", "https://127.0.0.1/private"],
      purpose: "self_audit",
      depth: "quick",
      modules: ["identity"]
    });
    const adapters = {
      github_public_api: { async collect() { collections += 1; return { status: "collected", data: {} }; } },
      jina_reader: { async collect() { collections += 1; return { status: "collected", data: {} }; } }
    };

    await assert.rejects(
      () => runResearchProduct(brief, { outputDirectory: directory, adapters, lookup: publicLookup }),
      /public IP address/i
    );
    assert.equal(collections, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt content is hash-verified before it is trusted as report evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-integrity-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://github.com/alice-example"],
      purpose: "self_audit",
      depth: "quick",
      modules: ["identity"]
    });
    const run = await runResearchProduct(brief, {
      outputDirectory: directory,
      discovery: false,
      lookup: publicLookup,
      adapters: {
        github_public_api: {
          async collect() {
            return { status: "collected", coverage_complete: true, data: { profile: { login: "alice-example" }, repositories: [] } };
          }
        }
      }
    });
    const attempt = run.targets[0].attempts[0];
    const receiptPath = path.join(directory, attempt.receipt_path);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.data.profile.login = "tampered-person";
    await import("node:fs/promises").then(({ writeFile }) => writeFile(receiptPath, JSON.stringify(receipt), "utf8"));

    await assert.rejects(() => loadReceipts(run, directory), /hash|integrity/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a login wall cannot satisfy collection merely because an adapter returned text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-login-wall-"));
  const directory = path.join(root, "run");
  try {
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://example.com/alice"],
      purpose: "self_audit",
      depth: "quick",
      modules: ["identity"]
    });
    brief.subject.identity_status = "confirmed";
    const run = await runResearchProduct(brief, {
      outputDirectory: directory,
      discovery: false,
      lookup: publicLookup,
      adapters: {
        jina_reader: {
          async collect() {
            return {
              status: "collected",
              coverage_complete: true,
              data: { text: "Please sign in to continue. Cookies are required." }
            };
          }
        }
      }
    });

    assert.equal(run.status, "failed");
    assert.equal(run.closure.collection.useful_supplied_material_targets, 0);
    assert.equal(run.source_item_inventory.total_items, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
