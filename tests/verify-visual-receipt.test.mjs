import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import fs from "node:fs";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { inspectPng } from "../scripts/capture-report-screenshots.mjs";
import {
  attestPlaywrightRuntime,
  PLAYWRIGHT_CORE_CRITICAL_PATHS
} from "../scripts/playwright-runtime-attestation.mjs";
import { verifyVisualReceipt } from "../scripts/verify-visual-receipt.mjs";

const verifier = path.resolve("scripts/verify-visual-receipt.mjs");

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + payload.length);
  output.writeUInt32BE(payload.length, 0);
  typeBytes.copy(output, 4);
  payload.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 8 + payload.length);
  return output;
}

function writeRgbPng(filePath, width, height, seed, uniform = false, changeLastPixel = false) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      const value = uniform ? 24 : (x * 3 + y * 5 + seed * 17) % 256;
      row[offset] = value;
      row[offset + 1] = uniform ? 24 : (value + 50 + seed) % 256;
      row[offset + 2] = uniform ? 24 : (value + 120 + seed * 2) % 256;
      if (changeLastPixel && x === width - 1 && y === height - 1) row[offset + 2] ^= 1;
    }
    rows.push(row);
  }
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0))
  ]));
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "visual-receipt-"));
  const sourceSkillRoot = path.resolve(import.meta.dirname, "..");
  const fixtureSkillRoot = path.join(root, "fixture-skill");
  const fixtureScriptsDir = path.join(fixtureSkillRoot, "scripts");
  fs.mkdirSync(fixtureScriptsDir, { recursive: true });
  fs.copyFileSync(
    path.join(sourceSkillRoot, "package-lock.json"),
    path.join(fixtureSkillRoot, "package-lock.json")
  );
  for (const relativePath of PLAYWRIGHT_CORE_CRITICAL_PATHS) {
    const source = path.join(sourceSkillRoot, "node_modules", "playwright-core", relativePath);
    const destination = path.join(fixtureSkillRoot, "node_modules", "playwright-core", relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const playwrightRuntime = attestPlaywrightRuntime({ skillRoot: fixtureSkillRoot });
  const screenshotDir = path.join(root, "screenshots");
  fs.mkdirSync(screenshotDir);
  const htmlPath = path.join(root, "report.html");
  const browserPath = path.join(root, "chromium-test");
  const artifactPath = path.join(root, "artifact.json");
  const builderReceiptPath = path.join(root, "builder-receipt.json");
  const builderScriptPath = path.join(root, "builder.mjs");
  const rawBuilderReceiptPath = path.join(root, "raw-builder-receipt.json");
  const captureScriptPath = path.join(fixtureScriptsDir, "capture-script.mjs");
  const html = "<!doctype html><main>Report</main>\n";
  fs.writeFileSync(htmlPath, html);
  fs.writeFileSync(artifactPath, '{"schemaVersion":1}\n');
  fs.writeFileSync(builderScriptPath, `
import fs from "node:fs";
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--") && all[index + 1]) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
fs.writeFileSync(args.output, ${JSON.stringify(html)});
console.log(JSON.stringify({
  ok: true,
  html: args.output,
  stages: { validation: "passed", package: "passed", verification: "passed" },
  counts: { blocks: 1, charts: 1, tables: 1 },
  sourceDialog: "passed",
  sourceInteraction: "keyboard_menu_semantic_click",
  viewports: [1440, 390]
}));
`);
  fs.writeFileSync(rawBuilderReceiptPath, `${JSON.stringify({
    ok: true,
    html: htmlPath,
    stages: { validation: "passed", package: "passed", verification: "passed" },
    counts: { blocks: 1, charts: 1, tables: 1 },
    sourceDialog: "passed",
    sourceInteraction: "keyboard_menu_semantic_click",
    viewports: [1440, 390]
  })}\n`);
  fs.writeFileSync(browserPath, "#!/bin/sh\necho 'Test Chromium 149.0'\n");
  chmodSync(browserPath, 0o755);
  const builderReceipt = {
    version: 3,
    ok: true,
    run_id: "qa-run",
    started_at: "2026-09-02T00:00:00Z",
    generated_at: "2026-09-02T00:01:00Z",
    html: { path: htmlPath, sha256: sha256(htmlPath) },
    artifact: { path: artifactPath, sha256: sha256(artifactPath) },
    builder: {
      script: { path: builderScriptPath, sha256: sha256(builderScriptPath) },
      raw_receipt: { path: rawBuilderReceiptPath, sha256: sha256(rawBuilderReceiptPath) },
      options: { timeout_ms: 120000, ready_timeout_ms: 30000, action_timeout_ms: 30000 }
    }
  };
  fs.writeFileSync(builderReceiptPath, `${JSON.stringify(builderReceipt)}\n`);
  fs.writeFileSync(captureScriptPath, "export const capture = true;\n");
  const screenshots = [];
  const checks = [];
  let seed = 1;
  for (const scheme of ["light", "dark"]) {
    for (const viewport of [
      { name: "desktop", width: 1440, height: 1000, documentHeight: 1500 },
      { name: "mobile", width: 390, height: 844, documentHeight: 1200 }
    ]) {
      const baseName = `${viewport.name}-${scheme}`;
      const tilePositions = [0, viewport.documentHeight - viewport.height];
      for (let index = 0; index < tilePositions.length; index += 1) {
        const name = `${baseName}-tile-${String(index + 1).padStart(3, "0")}`;
        const filePath = path.join(screenshotDir, `${name}.png`);
        writeRgbPng(filePath, viewport.width, viewport.height, seed++);
        screenshots.push({
          name,
          path: filePath,
          capture_kind: "viewport_tile",
          tile_index: index + 1,
          scroll_y: tilePositions[index],
          coverage_start_y: tilePositions[index],
          coverage_end_y: Math.min(viewport.documentHeight, tilePositions[index] + viewport.height),
          document_height: viewport.documentHeight,
          viewport_width: viewport.width,
          viewport_height: viewport.height,
          width: viewport.width,
          height: viewport.height,
          colour_scheme: scheme,
          sha256: sha256(filePath),
          size_bytes: fs.statSync(filePath).size,
          visual_metrics: inspectPng(filePath)
        });
      }
      const fullName = `${baseName}-full`;
      const fullPath = path.join(screenshotDir, `${fullName}.png`);
      writeRgbPng(fullPath, viewport.width, viewport.documentHeight, seed++);
      screenshots.push({
        name: fullName,
        path: fullPath,
        capture_kind: "full_page",
        document_height: viewport.documentHeight,
        viewport_width: viewport.width,
        viewport_height: viewport.height,
        width: viewport.width,
        height: viewport.documentHeight,
        colour_scheme: scheme,
        sha256: sha256(fullPath),
        size_bytes: fs.statSync(fullPath).size,
        visual_metrics: inspectPng(fullPath)
      });
      const mobileOverflow = viewport.name === "mobile";
      let rightEdgeCapture = null;
      if (mobileOverflow) {
        const rightName = `${baseName}-table-001-right`;
        const rightPath = path.join(screenshotDir, `${rightName}.png`);
        writeRgbPng(rightPath, viewport.width, viewport.height, seed++);
        const rightRecord = {
          name: rightName,
          path: rightPath,
          capture_kind: "viewport_table_right_edge",
          table_index: 0,
          page_scroll_y: 0,
          table_scroll_left: 340,
          max_scroll: 340,
          table_document_top: 100,
          table_document_bottom: 500,
          table_viewport_top: 100,
          table_viewport_bottom: 500,
          table_visible_in_viewport: true,
          reached_right_edge: true,
          document_height: viewport.documentHeight,
          viewport_width: viewport.width,
          viewport_height: viewport.height,
          width: viewport.width,
          height: viewport.height,
          colour_scheme: scheme,
          sha256: sha256(rightPath),
          size_bytes: fs.statSync(rightPath).size,
          visual_metrics: inspectPng(rightPath)
        };
        screenshots.push(rightRecord);
        rightEdgeCapture = rightRecord;
      }
      checks.push({
        attempts: 1,
        name: baseName,
        viewport,
        coverage_mode: "full_tiling",
        dom_status: "passed",
        interaction_status: "passed",
        colour_scheme: scheme,
        tile_positions: tilePositions,
        table_scroll_checks: [{
          index: 0,
          visible: true,
          client_width: viewport.width - 40,
          scroll_width: mobileOverflow ? viewport.width + 300 : viewport.width - 40,
          max_scroll: mobileOverflow ? 340 : 0,
          left_edge: 0,
          right_edge: mobileOverflow ? 340 : 0,
          overflow: mobileOverflow,
          moved: true,
          reached_right_edge: true,
          returned_left_edge: true,
          ...(rightEdgeCapture ? {
            right_edge_capture: rightEdgeCapture.name,
            right_edge_capture_sha256: rightEdgeCapture.sha256
          } : {})
        }],
        dom: {
          document_state: "complete",
          reader_state: "ready",
          reader_visible: true,
          visible_text_characters: 500,
          viewport_width: viewport.width,
          viewport_height: viewport.height,
          scroll_width: viewport.width,
          client_width: viewport.width,
          scroll_height: viewport.documentHeight,
          sticky_header_height: viewport.name === "desktop" ? 48 : 0,
          block_count: 2,
          block_geometries: [
            { index: 0, top: 20, bottom: 400, width: viewport.width - 40, height: 380 },
            { index: 1, top: 900, bottom: 1100, width: viewport.width - 40, height: 200 }
          ],
          chart_count: 1,
          table_count: 1,
          chart_text_integrity: {
            status: "passed",
            inspected_chart_count: 1,
            inspected_tick_count: 2,
            matched_category_tick_count: 1,
            fallback_binding_failure_count: 0,
            truncated_label_count: 0,
            mid_word_wrap_count: 0,
            omitted_category_count: 0,
            omitted_categories: [],
            clipped_label_count: 0,
            overlapping_label_count: 0,
            issue_count: 0,
            issues: [],
            issues_truncated: false
          },
          prefers_dark: scheme === "dark"
        },
        render_convergence: {
          attempts: 3,
          stable_samples: 3,
          observation: {
            scroll_height: viewport.documentHeight,
            scroll_width: viewport.width,
            client_width: viewport.width,
            visible_text_characters: 500,
            block_count: 2,
            table_count: 1,
            chart_count: 1
          }
        },
        full_page_origin_scroll_y: 0,
        external_requests: [],
        external_websockets: [],
        page_errors: [],
        console_errors: []
      });
    }
  }
  const receiptPath = path.join(root, "capture-receipt.json");
  const receipt = {
    version: 5,
    ok: true,
    run_id: "qa-run",
    started_at: "2026-09-02T00:01:00Z",
    generated_at: "2026-09-02T00:02:00Z",
    capture_status: "passed",
    visual_review_status: "pending",
    html: { path: htmlPath, sha256: sha256(htmlPath) },
    builder_receipt: { path: builderReceiptPath, sha256: sha256(builderReceiptPath) },
    capture_script: { path: captureScriptPath, sha256: sha256(captureScriptPath) },
    runtime: {
      node: {
        version: process.version,
        exec_path: process.execPath,
        platform: process.platform,
        architecture: process.arch
      },
      playwright_core: playwrightRuntime
    },
    browser: {
      executable: browserPath,
      version: "149.0",
      command_version: "Test Chromium 149.0",
      sha256: sha256(browserPath)
    },
    network_policy: {
      http: "exact_report_file_and_embedded_data_only",
      websocket: "blocked",
      service_worker: "blocked"
    },
    responsive: {
      css_breakpoints: [],
      minimum_width: 320,
      maximum_width: 1920,
      boundary_delta: 1,
      viewport_matrix: [
        { name: "mobile", width: 390, height: 844, coverage_mode: "full_tiling" },
        { name: "desktop", width: 1440, height: 1000, coverage_mode: "full_tiling" }
      ]
    },
    browser_checks: checks,
    screenshots
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  return {
    root,
    screenshotDir,
    htmlPath,
    browserPath,
    artifactPath,
    builderReceiptPath,
    builderScriptPath,
    rawBuilderReceiptPath,
    captureScriptPath,
    receiptPath,
    receipt,
    builderReceipt
  };
}

function verify(state) {
  return verifyVisualReceipt(state.receiptPath, {
    htmlPath: state.htmlPath,
    screenshotDir: state.screenshotDir,
    trustedBrowserSha256: new Set([sha256(state.browserPath)]),
    trustedCaptureScriptSha256: new Set([state.receipt.capture_script.sha256]),
    trustedBuilderSha256: new Set([sha256(state.builderScriptPath)]),
    replayBuilder: true,
    replayCapture: false
  });
}

function enableFakeCaptureReplay(state, { mutateReplay, assertSanitisedEnvironment = false } = {}) {
  const goldenDir = path.join(state.root, "golden-screenshots");
  const templatePath = path.join(state.root, "golden-capture-template.json");
  fs.mkdirSync(goldenDir);
  for (const screenshot of state.receipt.screenshots) {
    fs.copyFileSync(screenshot.path, path.join(goldenDir, path.basename(screenshot.path)));
  }
  const fakeCaptureScript = `
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--") && all[index + 1]) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
if (${JSON.stringify(assertSanitisedEnvironment)}) {
  for (const variable of ["NODE_OPTIONS", "NODE_PATH", "PW_INSTRUMENT_MODULES"]) {
    if (Object.prototype.hasOwnProperty.call(process.env, variable)) {
      throw new Error("Capture replay leaked untrusted environment variable: " + variable);
    }
  }
}
const hash = (filePath) => createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
const payload = JSON.parse(fs.readFileSync(${JSON.stringify(templatePath)}, "utf8"));
fs.mkdirSync(args["out-dir"], { recursive: true });
payload.run_id = args["run-id"];
payload.started_at = "2031-01-01T01:02:03.000Z";
payload.generated_at = "2031-01-01T01:02:04.000Z";
payload.html = { path: path.resolve(args.html), sha256: hash(path.resolve(args.html)) };
payload.builder_receipt = {
  path: path.resolve(args["builder-receipt"]),
  sha256: hash(path.resolve(args["builder-receipt"]))
};
const scriptPath = fileURLToPath(import.meta.url);
payload.capture_script = { path: scriptPath, sha256: hash(scriptPath) };
for (const check of payload.browser_checks) check.attempts = check.attempts === 1 ? 3 : 2;
for (const screenshot of payload.screenshots) {
  const source = path.join(${JSON.stringify(goldenDir)}, path.basename(screenshot.path));
  const destination = path.join(path.resolve(args["out-dir"]), path.basename(screenshot.path));
  fs.copyFileSync(source, destination);
  screenshot.path = destination;
  screenshot.sha256 = hash(destination);
  screenshot.size_bytes = fs.statSync(destination).size;
}
for (const check of payload.browser_checks) {
  for (const table of check.table_scroll_checks) {
    if (!table.right_edge_capture) continue;
    const screenshot = payload.screenshots.find((entry) => entry.name === table.right_edge_capture);
    table.right_edge_capture_sha256 = screenshot.sha256;
  }
}
fs.writeFileSync(path.resolve(args.receipt), JSON.stringify(payload) + "\\n");
process.stdout.write(JSON.stringify(payload) + "\\n");
`;
  fs.writeFileSync(state.captureScriptPath, fakeCaptureScript);
  state.receipt.capture_script = {
    path: state.captureScriptPath,
    sha256: sha256(state.captureScriptPath)
  };
  const replayTemplate = structuredClone(state.receipt);
  mutateReplay?.({ receipt: replayTemplate, goldenDir });
  fs.writeFileSync(templatePath, `${JSON.stringify(replayTemplate)}\n`);
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  return () => verifyVisualReceipt(state.receiptPath, {
    htmlPath: state.htmlPath,
    screenshotDir: state.screenshotDir,
    trustedBrowserSha256: new Set([sha256(state.browserPath)]),
    trustedCaptureScriptSha256: new Set([state.receipt.capture_script.sha256]),
    trustedBuilderSha256: new Set([sha256(state.builderScriptPath)]),
    replayBuilder: true,
    replayCapture: true
  });
}

test("a fully tiled responsive capture receipt passes", () => {
  const state = fixture();
  const result = verify(state);
  assert.equal(result.screenshot_count, 14);
  assert.equal(result.run_id, "qa-run");
});

test("trusted capture replay normalises timestamps, temporary paths and attempt counts", () => {
  const state = fixture();
  const verifyWithReplay = enableFakeCaptureReplay(state);
  const result = verifyWithReplay();
  assert.equal(result.capture_replay.status, "passed");
  assert.equal(result.capture_replay.viewport_capture_count, 10);
  assert.equal(result.builder_verification.builder_replay.status, "passed");
});

test("trusted capture replay strips Node preload and instrumentation environment variables", () => {
  const state = fixture();
  const verifyWithReplay = enableFakeCaptureReplay(state, { assertSanitisedEnvironment: true });
  const variables = ["NODE_OPTIONS", "NODE_PATH", "PW_INSTRUMENT_MODULES"];
  const original = Object.fromEntries(variables.map((variable) => [variable, process.env[variable]]));
  try {
    process.env.NODE_OPTIONS = "";
    process.env.NODE_PATH = path.join(state.root, "untrusted-node-path");
    process.env.PW_INSTRUMENT_MODULES = "untrusted-instrumentation";
    assert.equal(verifyWithReplay().capture_replay.status, "passed");
  } finally {
    for (const variable of variables) {
      if (original[variable] === undefined) delete process.env[variable];
      else process.env[variable] = original[variable];
    }
  }
});

test("trusted capture replay rejects a forged viewport tile even with internally consistent receipt metadata", () => {
  const state = fixture();
  const verifyWithReplay = enableFakeCaptureReplay(state);
  const shot = state.receipt.screenshots.find((entry) => entry.name === "mobile-light-tile-001");
  writeRgbPng(shot.path, shot.width, shot.height, 211);
  shot.sha256 = sha256(shot.path);
  shot.size_bytes = fs.statSync(shot.path).size;
  shot.visual_metrics = inspectPng(shot.path);
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verifyWithReplay(), /capture replay.*(?:viewport|decoded|pixels)|decoded.*capture replay/i);
});

test("trusted capture replay rejects a forged table right-edge viewport", () => {
  const state = fixture();
  const verifyWithReplay = enableFakeCaptureReplay(state);
  const shot = state.receipt.screenshots.find((entry) => entry.name === "mobile-dark-table-001-right");
  writeRgbPng(shot.path, shot.width, shot.height, 223);
  shot.sha256 = sha256(shot.path);
  shot.size_bytes = fs.statSync(shot.path).size;
  shot.visual_metrics = inspectPng(shot.path);
  const check = state.receipt.browser_checks.find((entry) => entry.name === "mobile-dark");
  check.table_scroll_checks[0].right_edge_capture_sha256 = shot.sha256;
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verifyWithReplay(), /capture replay.*(?:right-edge|decoded|pixels)|decoded.*capture replay/i);
});

test("trusted capture replay permits bounded full-page pixel variation", () => {
  const state = fixture();
  const verifyWithReplay = enableFakeCaptureReplay(state, {
    mutateReplay: ({ receipt, goldenDir }) => {
      const shot = receipt.screenshots.find((entry) => entry.name === "desktop-light-full");
      const goldenPath = path.join(goldenDir, path.basename(shot.path));
      writeRgbPng(goldenPath, shot.width, shot.height, 3, false, true);
      shot.visual_metrics = inspectPng(goldenPath);
    }
  });
  assert.equal(verifyWithReplay().capture_replay.status, "passed");
});

test("the production CLI rejects a fake browser executable", () => {
  const state = fixture();
  const result = spawnSync(process.execPath, [
    verifier,
    "--receipt", state.receiptPath,
    "--html", state.htmlPath,
    "--screenshot-dir", state.screenshotDir
  ], { cwd: path.resolve("."), encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(JSON.parse(result.stderr).error, /trusted .*allowlist/i);
});

test("a correctly hashed but uniform mobile dark tile fails", () => {
  const state = fixture();
  const shot = state.receipt.screenshots.find((entry) => entry.name === "mobile-dark-tile-001");
  writeRgbPng(shot.path, 390, 844, 1, true);
  shot.sha256 = sha256(shot.path);
  shot.visual_metrics = inspectPng(shot.path);
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), (error) => error.exitCode === 6 && /blank or visually empty/i.test(error.message));
});

test("a vertical coverage gap fails", () => {
  const state = fixture();
  const shot = state.receipt.screenshots.find((entry) => entry.name === "mobile-light-tile-002");
  shot.coverage_start_y = 1000;
  shot.scroll_y = 1000;
  const check = state.receipt.browser_checks.find((entry) => entry.name === "mobile-light");
  check.tile_positions[1] = 1000;
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), /coverage gap|coverage metadata/i);
});

test("mobile overflow tables must demonstrably reach their right edge", () => {
  const state = fixture();
  const check = state.receipt.browser_checks.find((entry) => entry.name === "mobile-light");
  check.table_scroll_checks[0].moved = false;
  check.table_scroll_checks[0].reached_right_edge = false;
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), (error) => error.exitCode === 6 && /table.*right edge|horizontal scrolling/i.test(error.message));
});

test("a receipt cannot claim success when chart labels were truncated", () => {
  const state = fixture();
  const check = state.receipt.browser_checks.find((entry) => entry.name === "mobile-light");
  check.dom.chart_text_integrity = {
    ...check.dom.chart_text_integrity,
    status: "failed",
    truncated_label_count: 1,
    issue_count: 1,
    issues: [{ chart_id: "coverage", label: "Long-form video", reason: "Category-axis label is truncated" }]
  };
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(
    () => verify(state),
    (error) => error.exitCode === 6 && /chart text integrity/i.test(error.message)
  );
});

test("a receipt cannot claim success when a portable chart lost its fallback binding", () => {
  const state = fixture();
  const check = state.receipt.browser_checks.find((entry) => entry.name === "mobile-light");
  check.dom.chart_text_integrity.fallback_binding_failure_count = 1;
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(
    () => verify(state),
    (error) => error.exitCode === 6 && /chart text integrity/i.test(error.message)
  );
});

test("a receipt cannot claim a clean full-page capture from a non-zero document scroll", () => {
  const state = fixture();
  const check = state.receipt.browser_checks.find((entry) => entry.name === "desktop-light");
  check.full_page_origin_scroll_y = 7_200;
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(
    () => verify(state),
    (error) => error.exitCode === 6 && /full-page.*origin|scroll/i.test(error.message)
  );
});

test("a symlinked out-of-tree screenshot fails provenance", (context) => {
  if (process.platform === "win32") context.skip("symlink permissions are platform-specific");
  const state = fixture();
  const shot = state.receipt.screenshots[0];
  const outside = path.join(state.root, "outside.png");
  fs.copyFileSync(shot.path, outside);
  fs.unlinkSync(shot.path);
  fs.symlinkSync(outside, shot.path);
  assert.throws(() => verify(state), /symbolic link|screenshot path/i);
});

test("stale unregistered screenshots cannot survive a new capture", () => {
  const state = fixture();
  writeRgbPng(path.join(state.screenshotDir, "desktop-light.png"), 1440, 1000, 99);
  assert.throws(() => verify(state), /stale or unregistered/i);
});

test("old pre-attestation capture receipts are rejected", () => {
  const state = fixture();
  state.receipt.version = 3;
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), /version 5/i);
});

test("a visual capture requires full verification of its builder receipt", () => {
  const state = fixture();
  fs.writeFileSync(state.builderReceiptPath, '{"version":3,"run_id":"qa-run"}\n');
  state.receipt.builder_receipt.sha256 = sha256(state.builderReceiptPath);
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(
    () => verify(state),
    /builder.*(receipt|successful|started_at|artifact|script|replay)|browser receipt/i
  );
});

test("the verified builder receipt must bind the exact captured HTML and run", () => {
  const state = fixture();
  const differentHtmlPath = path.join(state.root, "different-report.html");
  fs.writeFileSync(differentHtmlPath, "<!doctype html><main>Different report</main>\n");
  state.builderReceipt.html = { path: differentHtmlPath, sha256: sha256(differentHtmlPath) };
  fs.writeFileSync(state.builderReceiptPath, `${JSON.stringify(state.builderReceipt)}\n`);
  state.receipt.builder_receipt.sha256 = sha256(state.builderReceiptPath);
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), /builder.*html|different html|html.*bind/i);
});

test("repeated tile pixels cannot masquerade as vertical visual coverage", () => {
  const state = fixture();
  const first = state.receipt.screenshots.find((entry) => entry.name === "mobile-light-tile-001");
  const second = state.receipt.screenshots.find((entry) => entry.name === "mobile-light-tile-002");
  fs.copyFileSync(first.path, second.path);
  second.sha256 = sha256(second.path);
  second.size_bytes = fs.statSync(second.path).size;
  second.visual_metrics = inspectPng(second.path);
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), /duplicate.*tile|tile.*duplicate|repeated.*pixels|hash sequence/i);
});

test("duplicate decoded tile pixels fail even when the PNG file hashes differ", () => {
  const state = fixture();
  const first = state.receipt.screenshots.find((entry) => entry.name === "mobile-light-tile-001");
  const second = state.receipt.screenshots.find((entry) => entry.name === "mobile-light-tile-002");
  fs.writeFileSync(second.path, Buffer.concat([fs.readFileSync(first.path), Buffer.from([0])]));
  second.sha256 = sha256(second.path);
  second.size_bytes = fs.statSync(second.path).size;
  second.visual_metrics = inspectPng(second.path);
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), /duplicate.*decoded|decoded.*pixels|pixel digest/i);
});

test("capture chronology starts after the bound builder has completed", () => {
  const state = fixture();
  state.receipt.started_at = "2026-09-02T00:00:30Z";
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), /capture.*(?:before|predates).*builder|builder.*completed/i);
});

test("table right-edge captures require unique decoded pixels within each viewport and theme", () => {
  const state = fixture();
  for (const scheme of ["light", "dark"]) {
    const first = state.receipt.screenshots.find((entry) => entry.name === `mobile-${scheme}-table-001-right`);
    const secondName = `mobile-${scheme}-table-002-right`;
    const secondPath = path.join(state.screenshotDir, `${secondName}.png`);
    fs.writeFileSync(secondPath, Buffer.concat([fs.readFileSync(first.path), Buffer.from([0])]));
    const second = {
      ...first,
      name: secondName,
      path: secondPath,
      table_index: 1,
      sha256: sha256(secondPath),
      size_bytes: fs.statSync(secondPath).size,
      visual_metrics: inspectPng(secondPath)
    };
    state.receipt.screenshots.push(second);
    const check = state.receipt.browser_checks.find((entry) => entry.name === `mobile-${scheme}`);
    check.dom.table_count = 2;
    check.table_scroll_checks.push({
      ...check.table_scroll_checks[0],
      index: 1,
      right_edge_capture: secondName,
      right_edge_capture_sha256: second.sha256
    });
  }
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), /duplicate.*table|table.*duplicate|right-edge.*pixel/i);
});

test("every overflowing table requires a registered right-edge visual capture", () => {
  const state = fixture();
  for (const check of state.receipt.browser_checks) {
    for (const table of check.table_scroll_checks) {
      if (table.overflow) delete table.right_edge_capture;
    }
  }
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(() => verify(state), /right[- ]edge.*(visual|capture|screenshot)|overflow.*screenshot/i);
});

test("breakpoint boundary checks require visual table right-edge evidence, not DOM scrolling alone", () => {
  const state = fixture();
  const mobileViewport = state.receipt.responsive.viewport_matrix.find((entry) => entry.name === "mobile");
  mobileViewport.coverage_mode = "boundary_dom_interaction";
  for (const check of state.receipt.browser_checks.filter((entry) => entry.viewport.name === "mobile")) {
    check.coverage_mode = "boundary_dom_interaction";
    check.tile_positions = [];
  }
  const removedTiles = state.receipt.screenshots.filter((entry) =>
    entry.name.startsWith("mobile-") && entry.capture_kind === "viewport_tile"
  );
  for (const screenshot of removedTiles) fs.unlinkSync(screenshot.path);
  state.receipt.screenshots = state.receipt.screenshots.filter((entry) => !removedTiles.includes(entry));
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.equal(verify(state).capture_status, "passed");

  const check = state.receipt.browser_checks.find((entry) => entry.name === "mobile-light");
  const rightEdgeName = check.table_scroll_checks[0].right_edge_capture;
  delete check.table_scroll_checks[0].right_edge_capture;
  delete check.table_scroll_checks[0].right_edge_capture_sha256;
  const rightEdge = state.receipt.screenshots.find((entry) => entry.name === rightEdgeName);
  fs.unlinkSync(rightEdge.path);
  state.receipt.screenshots = state.receipt.screenshots.filter((entry) => entry !== rightEdge);
  fs.writeFileSync(state.receiptPath, `${JSON.stringify(state.receipt)}\n`);
  assert.throws(
    () => verify(state),
    (error) => error.exitCode === 6 && /right[- ]edge.*(visual|capture|screenshot)/i.test(error.message)
  );
});
