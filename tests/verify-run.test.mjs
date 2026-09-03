import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../bin/ppr-cli.mjs";
import { canonicalJson } from "../runner/canonical-json.mjs";
import { runResearchProduct } from "../runner/research-product.mjs";
import { verifyResearchRunDirectory } from "../scripts/verify-run.mjs";
import { createResearchBrief } from "../website/lib/research-brief.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, bytes, "utf8");
  return hash(bytes);
}

async function createRunFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ppr-verify-run-"));
  const runDirectory = path.join(root, "run");
  const brief = createResearchBrief({
    subjectName: "Ada Example",
    profileUrls: ["https://github.com/ada-example"],
    purpose: "self_audit",
    depth: "quick",
    modules: ["identity"]
  });
  const run = await runResearchProduct(brief, {
    outputDirectory: runDirectory,
    discovery: false,
    lookup: async () => [{ address: "140.82.121.3", family: 4 }],
    adapters: {
      github_public_api: {
        async collect(target) {
          return {
            status: "collected",
            coverage: "public_profile_and_repositories",
            source_urls: [target.canonical_url],
            data: {
              profile: {
                id: 42,
                login: "ada-example",
                name: "Ada Example",
                html_url: target.canonical_url,
                public_repos: 1
              },
              repositories: [{
                id: 77,
                name: "public-project",
                html_url: "https://github.com/ada-example/public-project"
              }]
            }
          };
        }
      }
    }
  });
  return { root, runDirectory, run };
}

test("verifies a complete schema-v1 runner artifact graph", async () => {
  const fixture = await createRunFixture();
  try {
    const result = verifyResearchRunDirectory(fixture.runDirectory);

    assert.equal(result.run_id, fixture.run.run_id);
    assert.equal(result.receipts, 1);
    assert.equal(result.evidence_files, 1);
    assert.equal(result.source_items, 2);

    const output = [];
    const exitCode = await runCli(["verify", "--run", fixture.runDirectory], {
      stdout: (line) => output.push(line),
      stderr: () => {}
    });
    assert.equal(exitCode, 0);
    assert.match(output.join("\n"), new RegExp(fixture.run.run_id));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects receipt digest and receipt-to-target linkage tampering", async (t) => {
  await t.test("changed receipt bytes", async () => {
    const fixture = await createRunFixture();
    try {
      const receiptPath = path.join(fixture.runDirectory, fixture.run.targets[0].attempts[0].receipt_path);
      const receipt = await readJson(receiptPath);
      receipt.data.profile.login = "tampered";
      await writeJson(receiptPath, receipt);

      assert.throws(() => verifyResearchRunDirectory(fixture.runDirectory), /receipt.*digest/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("rehashed receipt linked to the wrong adapter", async () => {
    const fixture = await createRunFixture();
    try {
      const runPath = path.join(fixture.runDirectory, "research-run.json");
      const run = await readJson(runPath);
      const attempt = run.targets[0].attempts[0];
      const receiptPath = path.join(fixture.runDirectory, attempt.receipt_path);
      const receipt = await readJson(receiptPath);
      receipt.adapter_id = "different_adapter";
      const { sha256: _oldDigest, ...payload } = receipt;
      receipt.sha256 = hash(canonicalJson(payload));
      attempt.receipt_sha256 = receipt.sha256;
      await writeJson(receiptPath, receipt);
      await writeJson(runPath, run);

      assert.throws(() => verifyResearchRunDirectory(fixture.runDirectory), /metadata linkage/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("rejects changed evidence, ledger and report bytes", async (t) => {
  const cases = [
    {
      label: "evidence file",
      expected: /evidence file hash/i,
      select(run, directory) { return path.join(directory, run.evidence_inventory[0].evidence_path); }
    },
    {
      label: "evidence ledger",
      expected: /evidence ledger hash/i,
      select(_run, directory) { return path.join(directory, "evidence-ledger.json"); }
    },
    {
      label: "source-item archive",
      expected: /source-item archive.*hash/i,
      async select(_run, directory) {
        const ledger = await readJson(path.join(directory, "evidence-ledger.json"));
        return path.join(directory, ledger.source_items[0].archive_path);
      }
    },
    {
      label: "report model",
      expected: /report model hash/i,
      select(_run, directory) { return path.join(directory, "report", "report.json"); }
    },
    {
      label: "HTML report",
      expected: /HTML report hash/i,
      select(_run, directory) { return path.join(directory, "report", "index.html"); }
    }
  ];

  for (const item of cases) {
    await t.test(item.label, async () => {
      const fixture = await createRunFixture();
      try {
        const selectedPath = await item.select(fixture.run, fixture.runDirectory);
        if (selectedPath.endsWith(".json")) {
          const value = await readJson(selectedPath);
          value.tampered = true;
          await writeJson(selectedPath, value);
        } else {
          await writeFile(selectedPath, "tampered\n", "utf8");
        }
        assert.throws(() => verifyResearchRunDirectory(fixture.runDirectory), item.expected);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("rejects a rehashed report carrying a different run ID", async () => {
  const fixture = await createRunFixture();
  try {
    const runPath = path.join(fixture.runDirectory, "research-run.json");
    const modelPath = path.join(fixture.runDirectory, "report", "report.json");
    const run = await readJson(runPath);
    const model = await readJson(modelPath);
    model.run_id = "different-run";
    run.artifacts.report_model_sha256 = await writeJson(modelPath, model);
    await writeJson(runPath, run);

    assert.throws(() => verifyResearchRunDirectory(fixture.runDirectory), /report model run ID linkage/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a fabricated report finding even when the manifest hash is updated", async () => {
  const fixture = await createRunFixture();
  try {
    const runPath = path.join(fixture.runDirectory, "research-run.json");
    const modelPath = path.join(fixture.runDirectory, "report", "report.json");
    const run = await readJson(runPath);
    const model = await readJson(modelPath);
    model.findings.push({
      category: "credibility",
      statement: "Fabricated verifier-bypass finding",
      evidence_ids: [],
      confidence: "observed",
      evidence_refs: []
    });
    run.artifacts.report_model_sha256 = await writeJson(modelPath, model);
    await writeJson(runPath, run);

    assert.throws(() => verifyResearchRunDirectory(fixture.runDirectory), /report model.*semantic|report model.*linkage/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects replacement HTML even when its manifest hash and run ID are updated", async () => {
  const fixture = await createRunFixture();
  try {
    const runPath = path.join(fixture.runDirectory, "research-run.json");
    const htmlPath = path.join(fixture.runDirectory, "report", "index.html");
    const run = await readJson(runPath);
    const forgedHtml = `<!doctype html><title>Forged report</title><p>Run ${run.run_id}.</p>`;
    await writeFile(htmlPath, forgedHtml, "utf8");
    run.artifacts.html_report_sha256 = hash(forgedHtml);
    await writeJson(runPath, run);

    assert.throws(() => verifyResearchRunDirectory(fixture.runDirectory), /HTML report.*semantic|HTML report.*linkage/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a rehashed source-item archive that no longer derives from its receipt", async () => {
  const fixture = await createRunFixture();
  try {
    const runPath = path.join(fixture.runDirectory, "research-run.json");
    const ledgerPath = path.join(fixture.runDirectory, "evidence-ledger.json");
    const run = await readJson(runPath);
    const ledger = await readJson(ledgerPath);
    const sourceItem = ledger.source_items[0];
    const archivePath = path.join(fixture.runDirectory, sourceItem.archive_path);
    const archive = await readJson(archivePath);
    archive.title = "Forged title";
    sourceItem.title = archive.title;
    sourceItem.archive_sha256 = await writeJson(archivePath, archive);
    run.artifacts.evidence_ledger_sha256 = await writeJson(ledgerPath, ledger);
    await writeJson(runPath, run);

    assert.throws(() => verifyResearchRunDirectory(fixture.runDirectory), /source-item archive.*content|source item.*linkage/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects symlinks and paths escaping the run directory", async (t) => {
  await t.test("symbolic link", async () => {
    const fixture = await createRunFixture();
    try {
      const htmlPath = path.join(fixture.runDirectory, "report", "index.html");
      const movedPath = path.join(fixture.root, "outside.html");
      await rename(htmlPath, movedPath);
      await symlink(movedPath, htmlPath);

      assert.throws(() => verifyResearchRunDirectory(fixture.runDirectory), /symbolic link/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("escaping artifact path", async () => {
    const fixture = await createRunFixture();
    try {
      const runPath = path.join(fixture.runDirectory, "research-run.json");
      const run = await readJson(runPath);
      run.artifacts.report_model_path = "../outside.json";
      await writeJson(runPath, run);

      assert.throws(() => verifyResearchRunDirectory(fixture.runDirectory), /escapes the research run/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
