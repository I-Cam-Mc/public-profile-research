import { readFile } from "node:fs/promises";
import path from "node:path";

import { runResearchProduct } from "../runner/research-product.mjs";
import { verifyResearchRunDirectory } from "../scripts/verify-run.mjs";
import { validateResearchBrief } from "../website/lib/research-brief.mjs";
import { detectLocalCapabilities } from "../runner/capabilities.mjs";

const HELP = `Public Profile Research

Run a canonical intake contract through the local research engine:
  node bin/ppr.mjs run --intake ./intake.json [--output ./public-profile-run]

Inspect optional local research routes without exposing credentials:
  node bin/ppr.mjs doctor

Verify a saved schema-v1 runner output:
  node bin/ppr.mjs verify --run ./public-profile-run

Outputs include research-run.json, receipts/, evidence/, evidence-ledger.json,
report/report.json and report/index.html.

Exit codes:
  0  research closure was satisfied, or verification passed
  2  a useful partial run was saved with coverage gaps
  64 invalid command or intake
  1  research failed before a useful run, or verification failed`;

function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv[0] === "help") return { command: "help" };
  const [command, ...rest] = argv;
  if (command === "doctor") {
    if (rest.length) throw new TypeError("doctor does not accept options");
    return { command };
  }
  if (command === "verify") {
    if (rest.length !== 2 || rest[0] !== "--run" || !rest[1] || rest[1].startsWith("--")) {
      throw new TypeError("verify requires exactly one --run directory");
    }
    return { command, run: rest[1] };
  }
  if (command !== "run") throw new TypeError(`Unknown command: ${command}`);
  const parsed = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (!["--intake", "--output"].includes(flag)) throw new TypeError(`Unknown option: ${flag}`);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${flag} requires a path`);
    const key = flag === "--intake" ? "intake" : "output";
    if (parsed[key]) throw new TypeError(`${flag} may only be supplied once`);
    parsed[key] = value;
    index += 1;
  }
  if (!parsed.intake) throw new TypeError("--intake is required");
  return parsed;
}

function defaultOutputName(now) {
  return `public-profile-run-${now.toISOString().replace(/[-:]/g, "").replace(".", "")}-${crypto.randomUUID().slice(0, 8)}`;
}

function summaryLines(run, outputDirectory) {
  const completion = run.completion ?? {};
  const lines = [
    "",
    `Research result: ${String(run.status ?? "unknown").toUpperCase()}`,
    `Coverage: ${completion.collected_targets ?? 0} of ${completion.declared_targets ?? run.targets?.length ?? 0} declared targets collected`,
    `Research goal: ${run.research_mode_satisfied === true ? "satisfied" : "open"}`,
    `Identity: ${run.identity?.status ?? completion.identity_status ?? "unconfirmed"}`,
    `Saved to: ${outputDirectory}`
  ];
  const moduleGaps = Array.isArray(run.closure?.gaps?.module_requirements)
    ? run.closure.gaps.module_requirements
    : [];
  if (moduleGaps.length) {
    lines.push(`Requested analysis: open (${moduleGaps.map((gap) => gap.module).join(", ")})`);
  }
  for (const target of run.targets ?? []) {
    const message = target.attempts?.at(-1)?.message;
    lines.push(`  ${target.platform}: ${target.status}`);
    if (message) lines.push(`    ${message}`);
  }
  if (run.artifacts?.html_report_path) {
    lines.push(`Report: ${path.join(outputDirectory, run.artifacts.html_report_path)}`);
  }
  const hasVisibleGaps = run.status !== "completed"
    || Object.values(run.closure?.gaps ?? {}).some((value) => Array.isArray(value) && value.length > 0);
  if (hasVisibleGaps) {
    lines.push("Coverage gaps are preserved in the report and evidence ledger. Nothing was silently skipped.");
  }
  return lines;
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout ?? console.log;
  const stderr = dependencies.stderr ?? console.error;
  const now = dependencies.now ?? new Date();
  const cwd = dependencies.cwd ?? process.cwd();
  const readFileImpl = dependencies.readFile ?? readFile;
  const executeResearch = dependencies.executeResearch ?? runResearchProduct;
  const verifyRun = dependencies.verifyRun ?? verifyResearchRunDirectory;
  const inspectCapabilities = dependencies.detectCapabilities ?? detectLocalCapabilities;
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    stderr(`Input error: ${error.message}`);
    stderr("Run `node bin/ppr.mjs --help` for usage.");
    return 64;
  }
  if (parsed.command === "help") {
    stdout(HELP);
    return 0;
  }
  if (parsed.command === "doctor") {
    const capabilities = await inspectCapabilities();
    stdout(capabilities.summary.text);
    for (const tool of Object.values(capabilities.tools)) stdout(`  ${tool.label}: ${tool.state_label}${tool.version ? ` (${tool.version})` : ""}`);
    for (const platform of capabilities.platforms) {
      const support = platform.runner_collectable === false ? " (detected only, collector not implemented)" : "";
      stdout(`  ${platform.label}: ${platform.state_label}${platform.backend ? ` via ${platform.backend}` : ""}${support}`);
    }
    return 0;
  }
  if (parsed.command === "verify") {
    const runDirectory = path.resolve(cwd, parsed.run);
    try {
      const result = await verifyRun(runDirectory);
      stdout(`Verification passed for schema-v1 research run ${result.run_id}.`);
      stdout(`${result.receipts} receipts, ${result.evidence_files} evidence files and ${result.source_items} source-item archives verified.`);
      return 0;
    } catch (error) {
      stderr(`Verification failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const intakePath = path.resolve(cwd, parsed.intake);
  const outputDirectory = path.resolve(cwd, parsed.output ?? defaultOutputName(now));
  let brief;
  try {
    brief = JSON.parse(await readFileImpl(intakePath, "utf8"));
  } catch (error) {
    stderr(`Input error: could not read a JSON intake from ${intakePath}`);
    stderr(String(error.message ?? error));
    return 64;
  }
  const errors = validateResearchBrief(brief);
  if (errors.length) {
    stderr(`Input error: ${errors.join("; ")}`);
    return 64;
  }

  stdout(`Researching ${brief.subject.display_name} from ${brief.subject.identity_anchors.length} declared public profile${brief.subject.identity_anchors.length === 1 ? "" : "s"}.`);
  const run = await executeResearch(brief, { outputDirectory });
  for (const line of summaryLines(run, outputDirectory)) stdout(line);
  if (run.status === "completed") return 0;
  return run.status === "partial" ? 2 : 1;
}

export { HELP };
