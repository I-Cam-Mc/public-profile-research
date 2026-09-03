import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../bin/ppr-cli.mjs";
import { createResearchBrief } from "../website/lib/research-brief.mjs";

test("CLI runs an intake file and clearly reports partial coverage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppr-cli-"));
  try {
    const intakePath = path.join(directory, "intake.json");
    const outputPath = path.join(directory, "run");
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://www.linkedin.com/in/alice-example"],
      purpose: "self_audit",
      depth: "quick",
      modules: ["identity", "career"]
    });
    await writeFile(intakePath, JSON.stringify(brief), "utf8");
    const stdout = [];
    const stderr = [];
    const calls = [];

    const exitCode = await runCli([
      "run", "--intake", intakePath, "--output", outputPath
    ], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      executeResearch: async (receivedBrief, options) => {
        calls.push({ receivedBrief, options });
        return {
          status: "partial",
          completion: {
            declared_targets: 1,
            collected_targets: 0,
            partial_targets: 0,
            unavailable_targets: 1,
            failed_targets: 0
          },
          closure: {
            gaps: {
              module_requirements: [{
                module: "career",
                reason: "The requested career module requires an active cited pass"
              }]
            }
          },
          targets: [{
            platform: "linkedin",
            status: "unavailable",
            attempts: [{ message: "Sign in to LinkedIn before retrying" }]
          }],
          artifacts: { html_report_path: "report/index.html" }
        };
      }
    });

    assert.equal(exitCode, 2);
    assert.equal(stderr.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].receivedBrief.subject.display_name, "Alice Example");
    assert.equal(calls[0].options.outputDirectory, path.resolve(outputPath));
    assert.match(stdout.join("\n"), /PARTIAL/);
    assert.match(stdout.join("\n"), /0 of 1 declared targets collected/);
    assert.match(stdout.join("\n"), /linkedin: unavailable/);
    assert.match(stdout.join("\n"), /Sign in to LinkedIn before retrying/);
    assert.match(stdout.join("\n"), /Requested analysis: open \(career\)/i);
    assert.match(stdout.join("\n"), /report\/index\.html/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI returns failure when no public subject evidence was collected", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ppr-cli-failed-"));
  try {
    const intakePath = path.join(directory, "intake.json");
    const brief = createResearchBrief({
      subjectName: "Alice Example",
      profileUrls: ["https://example.com/alice"],
      purpose: "self_audit",
      depth: "quick",
      modules: ["identity"]
    });
    await writeFile(intakePath, JSON.stringify(brief), "utf8");
    const exitCode = await runCli(["run", "--intake", intakePath], {
      cwd: directory,
      stdout: () => {},
      stderr: () => {},
      executeResearch: async () => ({
        status: "failed",
        completion: { declared_targets: 1, collected_targets: 0 },
        targets: [{ platform: "web", status: "failed", attempts: [{ message: "No evidence collected" }] }],
        artifacts: { html_report_path: "report/index.html" }
      })
    });
    assert.equal(exitCode, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI doctor prints safe research capability states", async () => {
  const output = [];
  const exitCode = await runCli(["doctor"], {
    stdout: (line) => output.push(line),
    stderr: () => {},
    detectCapabilities: async () => ({
      summary: { text: "Two routes checked." },
      tools: { agent_reach: { label: "Agent Reach", state_label: "Ready" } },
      platforms: [
        { label: "Instagram", state_label: "Check needed", backend: "OpenCLI", runner_collectable: true },
        { label: "Reddit", state_label: "Ready", backend: "OpenCLI", runner_collectable: false }
      ]
    })
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /Agent Reach: Ready/);
  assert.match(output.join("\n"), /Instagram: Check needed via OpenCLI/);
  assert.match(output.join("\n"), /Reddit: Ready via OpenCLI \(detected only, collector not implemented\)/);
});
