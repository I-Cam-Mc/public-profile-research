import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadReceipts } from "../report/build-report.mjs";
import { planResearch, runResearch } from "../runner/research-runner.mjs";
import { createResearchBrief } from "../website/lib/research-brief.mjs";

function exampleBrief() {
  return createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://github.com/ada-example"],
    purpose: "self_audit",
    depth: "quick",
    modules: ["identity", "timeline"]
  });
}

test("the runner plans real platform adapters and evidence-preserving fallbacks", () => {
  const plan = planResearch(createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: [
      "https://github.com/ada-example",
      "https://www.youtube.com/@ada-example",
      "https://www.instagram.com/ada_example/",
      "https://www.tiktok.com/@ada_example"
    ],
    purpose: "self_audit",
    depth: "standard",
    modules: ["identity", "timeline"]
  }));

  assert.deepEqual(plan.targets.map(({ platform }) => platform), ["github", "youtube", "instagram", "tiktok"]);
  assert.deepEqual(plan.targets[0].adapter_ids, ["github_public_api"]);
  assert.deepEqual(plan.targets[1].adapter_ids, ["yt_dlp", "jina_reader"]);
  assert.deepEqual(plan.targets[2].adapter_ids, ["agent_reach_instagram", "jina_reader"]);
  assert.deepEqual(plan.targets[3].adapter_ids, ["yt_dlp", "jina_reader"]);
  assert.ok(plan.targets.every((target) => target.terminal_states.includes("unavailable")));
  assert.equal(plan.research_mode, "insight");
});

test("a research run writes collected evidence and adapter receipts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "public-profile-run-"));
  const outputDirectory = path.join(root, "run");
  const result = await runResearch(exampleBrief(), {
    outputDirectory,
    adapters: {
      github_public_api: {
        async collect(target) {
          return {
            status: "collected",
            coverage: "public_profile_and_repositories",
            data: { login: "ada-example", public_repos: 4 },
            source_urls: [target.canonical_url]
          };
        }
      }
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.targets[0].status, "collected");
  assert.equal(result.targets[0].attempts[0].adapter_id, "github_public_api");
  const receipt = JSON.parse(readFileSync(path.join(outputDirectory, result.targets[0].attempts[0].receipt_path), "utf8"));
  assert.equal(receipt.data.login, "ada-example");
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(statSync(outputDirectory).mode & 0o077, 0);
  assert.equal(statSync(path.join(outputDirectory, result.targets[0].attempts[0].receipt_path)).mode & 0o077, 0);
});

test("receipt hashes survive JSON persistence when adapter results contain undefined values", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "public-profile-run-"));
  const outputDirectory = path.join(root, "run");
  const result = await runResearch(exampleBrief(), {
    outputDirectory,
    adapters: {
      github_public_api: {
        async collect() {
          return {
            status: "collected",
            data: {
              omitted_property: undefined,
              array_value: ["kept", undefined]
            }
          };
        }
      }
    }
  });

  const receipts = await loadReceipts(result, outputDirectory);
  const persisted = receipts[result.targets[0].attempts[0].receipt_path];
  assert.equal(Object.hasOwn(persisted.data, "omitted_property"), false);
  assert.deepEqual(persisted.data.array_value, ["kept", null]);
});

test("missing adapters produce a failed run instead of claiming a useful partial result", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "public-profile-run-"));
  const outputDirectory = path.join(root, "run");
  const result = await runResearch(exampleBrief(), { outputDirectory, adapters: {} });

  assert.equal(result.status, "failed");
  assert.equal(result.targets[0].status, "unavailable");
  assert.match(result.targets[0].attempts[0].message, /not available/i);
});

test("maximum-public-coverage remains partial when an adapter returns capped material", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "public-profile-run-"));
  const brief = createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://github.com/ada-example"],
    purpose: "self_audit",
    depth: "maximum",
    researchMode: "maximum_public_coverage",
    modules: ["identity", "code"]
  });
  const result = await runResearch(brief, {
    outputDirectory: path.join(root, "run"),
    adapters: {
      github_public_api: {
        async collect() {
          return { status: "collected", coverage_complete: false, data: { profile: {}, repositories: [] } };
        }
      }
    }
  });

  assert.equal(result.status, "partial");
  assert.equal(result.research_mode_satisfied, false);
});

test("a run refuses to mix evidence into an existing output directory", async () => {
  const outputDirectory = mkdtempSync(path.join(tmpdir(), "public-profile-run-existing-"));
  await assert.rejects(
    () => runResearch(exampleBrief(), { outputDirectory, adapters: {} }),
    /exist|output directory/i
  );
});
