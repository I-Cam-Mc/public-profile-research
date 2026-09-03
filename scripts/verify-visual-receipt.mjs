#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import { assertMeaningfulScreenshot, inspectPng } from "./png-evidence.mjs";
import { verifyPlaywrightRuntimeAttestation } from "./playwright-runtime-attestation.mjs";
import { verifyBrowserReceipt } from "./verify-browser-receipt.mjs";

const EXIT_INVALID = 2;
const EXIT_INCOMPLETE = 6;
const SHA256 = /^[a-f0-9]{64}$/;
const TRUSTED_BROWSER_SHA256 = new Set([
  "11e393326c7d20a7c56641a7c65def33ea9c280da3b0b74cf8563b07989a0ee3"
]);
const TRUSTED_CAPTURE_SCRIPT_SHA256 = new Set([
  "c29cd2b3e05d19e6bc7495753fa0b690939ed61a74c57267d87fd6dd7a7d1854"
]);
const CAPTURE_REPLAY_TIMEOUT_MS = 360_000;
const CAPTURE_REPLAY_MAX_BUFFER = 5 * 1024 * 1024;

function fail(message, exitCode = EXIT_INVALID) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

export function assertResponsiveViewportCoverage(requiredMatrix, completedChecks) {
  if (!Array.isArray(requiredMatrix) || !requiredMatrix.length) fail("Responsive viewport matrix is missing");
  if (!Array.isArray(completedChecks)) fail("Responsive viewport coverage checks are missing");
  const checksByWidth = new Map();
  for (const check of completedChecks) {
    const width = check?.viewport?.width;
    if (!Number.isInteger(width) || checksByWidth.has(width)) fail(`Responsive coverage has a duplicate or invalid width ${width}`);
    checksByWidth.set(width, check);
  }
  for (const required of requiredMatrix) {
    const check = checksByWidth.get(required.width);
    if (!check) fail(`Responsive coverage is missing required breakpoint width ${required.width}`, EXIT_INCOMPLETE);
    if (check.coverage_mode !== required.coverage_mode) {
      fail(`Responsive coverage mode is wrong at ${required.width}px`, EXIT_INCOMPLETE);
    }
    if (check.dom_status !== "passed") fail(`Responsive DOM check did not pass at ${required.width}px`, EXIT_INCOMPLETE);
    if (check.interaction_status !== "passed") {
      fail(`Responsive interaction check did not pass at ${required.width}px`, EXIT_INCOMPLETE);
    }
  }
  return true;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function decodedPixelSha256(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") fail(`Screenshot is not a PNG: ${filePath}`);
  let offset = 8;
  let header;
  const imageData = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + length;
    if (payloadEnd + 4 > bytes.length) fail(`Malformed PNG chunk in ${filePath}`);
    const payload = bytes.subarray(payloadStart, payloadEnd);
    if (type === "IHDR") {
      header = {
        width: payload.readUInt32BE(0),
        height: payload.readUInt32BE(4),
        bitDepth: payload[8],
        colourType: payload[9],
        interlace: payload[12]
      };
    } else if (type === "IDAT") {
      imageData.push(payload);
    } else if (type === "IEND") {
      break;
    }
    offset = payloadEnd + 4;
  }
  if (!header || !imageData.length || header.bitDepth !== 8 || header.interlace !== 0) {
    fail(`Unsupported PNG encoding for decoded-pixel verification: ${filePath}`);
  }
  const channelsByType = new Map([[0, 1], [2, 3], [4, 2], [6, 4]]);
  const channels = channelsByType.get(header.colourType);
  if (!channels) fail(`Unsupported PNG colour type for decoded-pixel verification: ${header.colourType}`);
  const stride = header.width * channels;
  const inflated = inflateSync(Buffer.concat(imageData));
  if (inflated.length !== (stride + 1) * header.height) fail(`Unexpected decoded PNG length: ${filePath}`);
  const pixels = Buffer.alloc(stride * header.height);
  const digest = createHash("sha256");
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(header.width, 0);
  dimensions.writeUInt32BE(header.height, 4);
  digest.update(dimensions);
  for (let y = 0; y < header.height; y += 1) {
    const sourceOffset = y * (stride + 1);
    const filter = inflated[sourceOffset];
    const rowOffset = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + 1 + x];
      const left = x >= channels ? pixels[rowOffset + x - channels] : 0;
      const above = y > 0 ? pixels[rowOffset - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[rowOffset - stride + x - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + above;
      else if (filter === 3) value = raw + Math.floor((left + above) / 2);
      else if (filter === 4) value = raw + paeth(left, above, upperLeft);
      else fail(`Unsupported PNG row filter for decoded-pixel verification: ${filter}`);
      pixels[rowOffset + x] = value & 0xff;
    }
    const normalisedRow = Buffer.alloc(header.width * 4);
    for (let x = 0; x < header.width; x += 1) {
      const channelOffset = rowOffset + x * channels;
      const red = pixels[channelOffset];
      const green = header.colourType === 0 || header.colourType === 4 ? red : pixels[channelOffset + 1];
      const blue = header.colourType === 0 || header.colourType === 4 ? red : pixels[channelOffset + 2];
      const alpha = header.colourType === 4
        ? pixels[channelOffset + 1]
        : header.colourType === 6
          ? pixels[channelOffset + 3]
          : 255;
      normalisedRow.set([red, green, blue, alpha], x * 4);
    }
    digest.update(normalisedRow);
  }
  return digest.digest("hex");
}

function parseArgs(argv) {
  const values = {};
  const supported = new Set(["receipt", "html", "screenshot-dir"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--") || !supported.has(token.slice(2))) fail(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value) fail(`${token} requires a path`);
    values[token.slice(2)] = path.resolve(value);
    index += 1;
  }
  for (const key of supported) if (!values[key]) fail(`--${key} is required`);
  return values;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Cannot read ${label}: ${error.message}`);
  }
}

function verifyReference(reference, label) {
  if (!reference || typeof reference !== "object") fail(`${label} reference is missing`);
  const filePath = path.resolve(reference.path ?? "");
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`${label} is missing: ${filePath}`);
  if (fs.lstatSync(filePath).isSymbolicLink()) fail(`${label} must not be a symbolic link`);
  if (!SHA256.test(reference.sha256 ?? "") || sha256(filePath) !== reference.sha256) fail(`${label} hash mismatch`);
  return filePath;
}

function verifyMetric(actual, recorded, label) {
  if (typeof actual === "number") {
    if (typeof recorded !== "number" || Math.abs(actual - recorded) > 1e-9) fail(`${label} visual metric mismatch`);
  } else if (actual !== recorded) {
    fail(`${label} visual metric mismatch`);
  }
}

function parseScreenshotName(name, viewportByName) {
  for (const viewportName of [...viewportByName.keys()].sort((left, right) => right.length - left.length)) {
    for (const scheme of ["light", "dark"]) {
      const prefix = `${viewportName}-${scheme}-`;
      if (!name.startsWith(prefix)) continue;
      const suffix = name.slice(prefix.length);
      if (suffix === "full") return { viewportName, scheme, kind: "full", tileIndexText: null, tableIndexText: null };
      const tile = /^tile-(\d{3})$/.exec(suffix);
      if (tile) return { viewportName, scheme, kind: suffix, tileIndexText: tile[1], tableIndexText: null };
      const table = /^table-(\d{3})-right$/.exec(suffix);
      if (table) return { viewportName, scheme, kind: suffix, tileIndexText: null, tableIndexText: table[1] };
    }
  }
  return null;
}

function inspectScreenshot(screenshot, screenshotDir, viewportByName) {
  const parsed = parseScreenshotName(screenshot.name ?? "", viewportByName);
  if (!parsed) fail(`Unexpected screenshot ${screenshot.name ?? "unnamed"}`);
  const { viewportName, scheme, kind, tileIndexText, tableIndexText } = parsed;
  const viewport = viewportByName.get(viewportName);
  const expectedPath = path.join(screenshotDir, `${screenshot.name}.png`);
  if (path.resolve(screenshot.path ?? "") !== expectedPath) fail(`${screenshot.name} has an unexpected screenshot path`);
  if (!fs.existsSync(expectedPath) || !fs.statSync(expectedPath).isFile()) fail(`${screenshot.name} screenshot is missing`);
  if (fs.lstatSync(expectedPath).isSymbolicLink()) fail(`${screenshot.name} screenshot must not be a symbolic link`);
  const relativeRealPath = path.relative(fs.realpathSync(screenshotDir), fs.realpathSync(expectedPath));
  if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) fail(`${screenshot.name} escapes the screenshot directory`);
  if (!SHA256.test(screenshot.sha256 ?? "") || sha256(expectedPath) !== screenshot.sha256) {
    fail(`${screenshot.name} screenshot hash mismatch`);
  }
  const captureKind = kind === "full"
    ? "full_page"
    : kind.startsWith("table-")
      ? "viewport_table_right_edge"
      : "viewport_tile";
  if (screenshot.capture_kind !== captureKind) fail(`${screenshot.name} has the wrong capture kind`);
  if (screenshot.colour_scheme !== scheme) fail(`${screenshot.name} has the wrong colour scheme`);
  if (screenshot.viewport_width !== viewport.width || screenshot.viewport_height !== viewport.height) {
    fail(`${screenshot.name} has false viewport metadata`);
  }
  let metrics;
  try {
    metrics = inspectPng(expectedPath);
    if (captureKind === "viewport_tile") assertMeaningfulScreenshot(metrics, viewport);
    else {
      if (metrics.width !== viewport.width || metrics.height < viewport.height) {
        fail(`${screenshot.name} full-page dimensions do not cover the viewport`, EXIT_INCOMPLETE);
      }
      assertMeaningfulScreenshot(metrics, { width: metrics.width, height: metrics.height });
    }
  } catch (error) {
    if (error.exitCode) throw error;
    fail(`${screenshot.name}: ${error.message}`, EXIT_INCOMPLETE);
  }
  if (screenshot.width !== metrics.width || screenshot.height !== metrics.height) fail(`${screenshot.name} has false PNG dimensions`);
  if (screenshot.size_bytes !== fs.statSync(expectedPath).size) fail(`${screenshot.name} has false file-size metadata`);
  if (!screenshot.visual_metrics || typeof screenshot.visual_metrics !== "object") fail(`${screenshot.name} visual metrics are missing`);
  for (const [key, value] of Object.entries(metrics)) verifyMetric(value, screenshot.visual_metrics[key], `${screenshot.name}.${key}`);
  if (captureKind === "viewport_tile") {
    const tileIndex = Number(tileIndexText);
    if (screenshot.tile_index !== tileIndex) fail(`${screenshot.name} has false tile_index metadata`);
    for (const field of ["scroll_y", "coverage_start_y", "coverage_end_y", "document_height"]) {
      if (!Number.isFinite(screenshot[field]) || screenshot[field] < 0) fail(`${screenshot.name} has invalid ${field}`);
    }
  } else if (captureKind === "viewport_table_right_edge") {
    const tableIndex = Number(tableIndexText) - 1;
    if (screenshot.table_index !== tableIndex) fail(`${screenshot.name} has false table_index metadata`);
    for (const field of [
      "page_scroll_y",
      "table_scroll_left",
      "max_scroll",
      "table_document_top",
      "table_document_bottom",
      "table_viewport_top",
      "table_viewport_bottom",
      "document_height"
    ]) {
      if (!Number.isFinite(screenshot[field])) fail(`${screenshot.name} has invalid ${field}`);
    }
    if (screenshot.table_visible_in_viewport !== true || screenshot.reached_right_edge !== true) {
      fail(`${screenshot.name} does not evidence a visible table right edge`, EXIT_INCOMPLETE);
    }
  } else if (!Number.isFinite(screenshot.document_height) || screenshot.document_height <= 0) {
    fail(`${screenshot.name} has invalid document_height`);
  }
  return {
    ...screenshot,
    metrics,
    decodedPixelSha256: captureKind === "full_page" ? null : decodedPixelSha256(expectedPath),
    viewportName,
    scheme,
    tileIndex: tileIndexText ? Number(tileIndexText) : null,
    tableIndex: tableIndexText ? Number(tableIndexText) - 1 : null
  };
}

function verifyTiles(check, screenshots) {
  const tiles = screenshots.filter((shot) => shot.capture_kind === "viewport_tile").sort((left, right) => left.tile_index - right.tile_index);
  const full = screenshots.filter((shot) => shot.capture_kind === "full_page");
  if (!tiles.length || full.length !== 1) fail(`${check.name} requires complete viewport tiling and one full-page image`);
  if (!Array.isArray(check.tile_positions) || check.tile_positions.length !== tiles.length) fail(`${check.name} tile_positions do not match screenshots`);
  const documentHeight = check.dom.scroll_height;
  const tilePixelDigests = new Set();
  let coveredUntil = 0;
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    if (tilePixelDigests.has(tile.decodedPixelSha256)) {
      fail(`${check.name} contains duplicate decoded tile pixels`);
    }
    tilePixelDigests.add(tile.decodedPixelSha256);
    if (tile.tile_index !== index + 1) fail(`${check.name} tile indexes are not contiguous`);
    if (Math.abs(tile.scroll_y - check.tile_positions[index]) > 1) fail(`${tile.name} does not match its recorded tile position`);
    if (Math.abs(tile.coverage_start_y - tile.scroll_y) > 1) fail(`${tile.name} has false coverage metadata`);
    const expectedEnd = Math.min(documentHeight, tile.coverage_start_y + check.viewport.height);
    if (Math.abs(tile.coverage_end_y - expectedEnd) > 1 || tile.document_height !== documentHeight) {
      fail(`${tile.name} has false coverage metadata`);
    }
    if (index === 0 && tile.coverage_start_y > 1) fail(`${check.name} tiling does not start at the document top`);
    if (tile.coverage_start_y > coveredUntil + 1) fail(`${check.name} has a vertical coverage gap`);
    coveredUntil = Math.max(coveredUntil, tile.coverage_end_y);
  }
  if (coveredUntil < documentHeight - 1) fail(`${check.name} tiling does not reach the document end`, EXIT_INCOMPLETE);
  if (full[0].metrics.height < documentHeight - 1 || full[0].document_height !== documentHeight) {
    fail(`${check.name} full-page capture does not reach the document end`, EXIT_INCOMPLETE);
  }
  for (const block of check.dom.block_geometries ?? []) {
    const capturedReadably = tiles.some((tile) => {
      const readableStart = tile.coverage_start_y + (tile.coverage_start_y > 0 ? check.dom.sticky_header_height ?? 0 : 0);
      return block.bottom > readableStart && block.top < tile.coverage_end_y;
    });
    if (!capturedReadably) fail(`${check.name} block ${block.index} does not intersect a readable viewport tile`, EXIT_INCOMPLETE);
  }
}

function verifyTableScroll(check, screenshots, { requireVisualRightEdges = true } = {}) {
  const tableChecks = check.table_scroll_checks;
  if (!Array.isArray(tableChecks) || tableChecks.length !== check.dom.table_count) {
    fail(`${check.name} did not exercise every table scroller`, EXIT_INCOMPLETE);
  }
  const indexes = new Set();
  const referencedCaptures = new Set();
  const rightEdgePixelDigests = new Set();
  const tilePixelDigests = new Set(screenshots
    .filter((screenshot) => screenshot.capture_kind === "viewport_tile")
    .map((screenshot) => screenshot.decodedPixelSha256));
  for (const table of tableChecks) {
    if (!Number.isInteger(table.index) || indexes.has(table.index)) fail(`${check.name} has invalid table-scroll indexes`);
    indexes.add(table.index);
    if (table.visible !== true) fail(`${check.name} table ${table.index} was not visible`, EXIT_INCOMPLETE);
    if (table.overflow) {
      if (table.moved !== true || table.reached_right_edge !== true || table.returned_left_edge !== true) {
        fail(`${check.name} table ${table.index} horizontal scrolling did not reach both edges`, EXIT_INCOMPLETE);
      }
      if (!(table.max_scroll > 1 && table.right_edge > table.left_edge + 1)) {
        fail(`${check.name} table ${table.index} has false horizontal-scroll metadata`);
      }
      if (!requireVisualRightEdges) continue;
      if (typeof table.right_edge_capture !== "string" || !table.right_edge_capture.trim()) {
        fail(`${check.name} overflowing table ${table.index} has no right-edge visual capture`, EXIT_INCOMPLETE);
      }
      const rightEdge = screenshots.find((screenshot) => screenshot.name === table.right_edge_capture);
      if (!rightEdge || rightEdge.capture_kind !== "viewport_table_right_edge") {
        fail(`${check.name} table ${table.index} right-edge screenshot is missing`, EXIT_INCOMPLETE);
      }
      if (referencedCaptures.has(rightEdge.name)) fail(`${check.name} reuses one right-edge screenshot for multiple tables`);
      referencedCaptures.add(rightEdge.name);
      if (rightEdge.tableIndex !== table.index || rightEdge.sha256 !== table.right_edge_capture_sha256) {
        fail(`${check.name} table ${table.index} right-edge screenshot binding is false`);
      }
      if (
        Math.abs(rightEdge.table_scroll_left - table.right_edge) > 1 ||
        Math.abs(rightEdge.max_scroll - table.max_scroll) > 1 ||
        rightEdge.table_visible_in_viewport !== true ||
        rightEdge.reached_right_edge !== true
      ) {
        fail(`${check.name} table ${table.index} right-edge visual metadata is false`);
      }
      const readableTop = rightEdge.page_scroll_y + (check.dom.sticky_header_height ?? 0);
      const readableBottom = rightEdge.page_scroll_y + check.viewport.height;
      if (rightEdge.table_document_bottom <= readableTop || rightEdge.table_document_top >= readableBottom) {
        fail(`${check.name} table ${table.index} is not visible in its right-edge screenshot`, EXIT_INCOMPLETE);
      }
      if (tilePixelDigests.has(rightEdge.decodedPixelSha256)) {
        fail(`${check.name} table ${table.index} right-edge screenshot repeats left-edge tile pixels`, EXIT_INCOMPLETE);
      }
      if (rightEdgePixelDigests.has(rightEdge.decodedPixelSha256)) {
        fail(`${check.name} contains duplicate decoded table right-edge pixels`, EXIT_INCOMPLETE);
      }
      rightEdgePixelDigests.add(rightEdge.decodedPixelSha256);
    }
  }
  const rightEdgeScreenshots = screenshots.filter((screenshot) => screenshot.capture_kind === "viewport_table_right_edge");
  if (requireVisualRightEdges && rightEdgeScreenshots.length !== referencedCaptures.size) {
    fail(`${check.name} contains an unbound table right-edge screenshot`);
  }
}

function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalise(value));
}

function withoutKeys(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));
}

function captureTopLevelSemantics(receipt) {
  const semantic = withoutKeys(receipt, new Set(["started_at", "generated_at", "browser_checks", "screenshots"]));
  for (const field of ["html", "builder_receipt", "capture_script"]) {
    if (semantic[field]?.path && fs.existsSync(semantic[field].path)) {
      semantic[field] = { ...semantic[field], path: fs.realpathSync(semantic[field].path) };
    }
  }
  if (semantic.browser?.executable && fs.existsSync(semantic.browser.executable)) {
    semantic.browser = { ...semantic.browser, executable: fs.realpathSync(semantic.browser.executable) };
  }
  return semantic;
}

function captureCheckSemantics(checks) {
  return checks.map((check) => ({
    ...withoutKeys(check, new Set(["attempts", "table_scroll_checks"])),
    table_scroll_checks: (check.table_scroll_checks ?? []).map((table) =>
      withoutKeys(table, new Set(["right_edge_capture_sha256"]))
    )
  }));
}

function screenshotSemantics(screenshot) {
  return withoutKeys(screenshot, new Set([
    "path",
    "sha256",
    "size_bytes",
    "visual_metrics",
    "metrics",
    "decodedPixelSha256",
    "viewportName",
    "scheme",
    "tileIndex",
    "tableIndex"
  ]));
}

function assertSameCanonical(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    const differingKeys = [...new Set([
      ...Object.keys(actual && typeof actual === "object" ? actual : {}),
      ...Object.keys(expected && typeof expected === "object" ? expected : {})
    ])].filter((key) => canonicalJson(actual?.[key]) !== canonicalJson(expected?.[key]));
    fail(
      `Trusted capture replay changed ${label}${differingKeys.length ? ` (${differingKeys.join(", ")})` : ""}`,
      EXIT_INCOMPLETE
    );
  }
}

function assertFullPageMetrics(actual, expected, name) {
  for (const field of ["width", "height", "minimum_alpha", "has_transparency"]) {
    if (actual[field] !== expected[field]) fail(`Trusted capture replay changed ${name} ${field}`, EXIT_INCOMPLETE);
  }
  const uniqueTolerance = Math.max(1, expected.unique_colours * 0.01);
  if (Math.abs(actual.unique_colours - expected.unique_colours) > uniqueTolerance) {
    fail(`Trusted capture replay changed ${name} unique-colour metric beyond 1%`, EXIT_INCOMPLETE);
  }
  for (const field of ["dominant_colour_ratio", "non_dominant_ratio"]) {
    if (Math.abs(actual[field] - expected[field]) > 0.001) {
      fail(`Trusted capture replay changed ${name} ${field} beyond tolerance`, EXIT_INCOMPLETE);
    }
  }
  if (Math.abs(actual.luminance_stddev - expected.luminance_stddev) > 0.25) {
    fail(`Trusted capture replay changed ${name} luminance metric beyond tolerance`, EXIT_INCOMPLETE);
  }
}

function replayTrustedCapture({
  captureScriptPath,
  htmlPath,
  builderReceiptPath,
  runId,
  browserPath,
  originalReceipt,
  originalScreenshots,
  timeoutMs
}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "public-profile-capture-replay-"));
  const replayScreenshotDir = path.join(directory, "screenshots");
  const replayReceiptPath = path.join(directory, "capture-receipt.json");
  try {
    fs.mkdirSync(replayScreenshotDir);
    const replayEnvironment = { ...process.env, CHROMIUM_EXECUTABLE_PATH: browserPath };
    for (const variable of ["NODE_OPTIONS", "NODE_PATH", "PW_INSTRUMENT_MODULES"]) delete replayEnvironment[variable];
    const result = spawnSync(process.execPath, [
      captureScriptPath,
      "--html", htmlPath,
      "--out-dir", replayScreenshotDir,
      "--receipt", replayReceiptPath,
      "--run-id", runId,
      "--builder-receipt", builderReceiptPath
    ], {
      cwd: path.dirname(captureScriptPath),
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: CAPTURE_REPLAY_MAX_BUFFER,
      env: replayEnvironment
    });
    if (result.error || result.status !== 0) {
      const cause = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
      fail(`Trusted capture replay failed: ${cause}`, EXIT_INCOMPLETE);
    }
    if (!fs.existsSync(replayReceiptPath)) fail("Trusted capture replay did not write a receipt", EXIT_INCOMPLETE);
    const replayReceiptBytes = fs.readFileSync(replayReceiptPath);
    const replayReceipt = readJson(replayReceiptPath, "trusted capture replay receipt");
    for (const field of ["started_at", "generated_at"]) {
      if (typeof replayReceipt[field] !== "string" || Number.isNaN(Date.parse(replayReceipt[field]))) {
        fail(`Trusted capture replay ${field} is invalid`, EXIT_INCOMPLETE);
      }
    }
    if (Date.parse(replayReceipt.generated_at) < Date.parse(replayReceipt.started_at)) {
      fail("Trusted capture replay predates its start", EXIT_INCOMPLETE);
    }
    assertSameCanonical(
      captureTopLevelSemantics(replayReceipt),
      captureTopLevelSemantics(originalReceipt),
      "top-level semantic metadata"
    );
    assertSameCanonical(
      captureCheckSemantics(replayReceipt.browser_checks ?? []),
      captureCheckSemantics(originalReceipt.browser_checks ?? []),
      "browser-check semantic metadata"
    );
    if (!Array.isArray(replayReceipt.screenshots)) fail("Trusted capture replay has no screenshots", EXIT_INCOMPLETE);
    const replayViewportByName = new Map((replayReceipt.responsive?.viewport_matrix ?? [])
      .map((viewport) => [viewport.name, viewport]));
    const replayScreenshots = replayReceipt.screenshots.map((screenshot) =>
      inspectScreenshot(screenshot, replayScreenshotDir, replayViewportByName)
    );
    const replayNames = new Set(replayScreenshots.map((screenshot) => screenshot.name));
    if (replayNames.size !== replayScreenshots.length) fail("Trusted capture replay has duplicate screenshot names", EXIT_INCOMPLETE);
    const replayFiles = fs.readdirSync(replayScreenshotDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
      .map((entry) => entry.name)
      .sort();
    const expectedFiles = replayScreenshots.map((screenshot) => `${screenshot.name}.png`).sort();
    if (canonicalJson(replayFiles) !== canonicalJson(expectedFiles)) {
      fail("Trusted capture replay contains stale or unregistered PNG files", EXIT_INCOMPLETE);
    }
    const originalByName = new Map(originalScreenshots.map((screenshot) => [screenshot.name, screenshot]));
    if (originalByName.size !== replayScreenshots.length) fail("Trusted capture replay changed the screenshot set", EXIT_INCOMPLETE);
    let viewportCaptureCount = 0;
    let fullPageCaptureCount = 0;
    for (const replayScreenshot of replayScreenshots) {
      const originalScreenshot = originalByName.get(replayScreenshot.name);
      if (!originalScreenshot) fail(`Trusted capture replay added ${replayScreenshot.name}`, EXIT_INCOMPLETE);
      assertSameCanonical(
        screenshotSemantics(replayScreenshot),
        screenshotSemantics(originalScreenshot),
        `${replayScreenshot.name} semantic metadata`
      );
      if (replayScreenshot.capture_kind === "full_page") {
        fullPageCaptureCount += 1;
        assertFullPageMetrics(replayScreenshot.metrics, originalScreenshot.metrics, replayScreenshot.name);
      } else {
        viewportCaptureCount += 1;
        if (replayScreenshot.decodedPixelSha256 !== originalScreenshot.decodedPixelSha256) {
          fail(`Trusted capture replay decoded pixels differ for ${replayScreenshot.name}`, EXIT_INCOMPLETE);
        }
      }
    }
    return {
      status: "passed",
      timeout_ms: timeoutMs,
      viewport_capture_count: viewportCaptureCount,
      full_page_capture_count: fullPageCaptureCount,
      semantic_sha256: createHash("sha256").update(canonicalJson({
        top_level: captureTopLevelSemantics(replayReceipt),
        browser_checks: captureCheckSemantics(replayReceipt.browser_checks),
        screenshots: replayReceipt.screenshots.map(screenshotSemantics)
      })).digest("hex"),
      replay_receipt_sha256: createHash("sha256").update(replayReceiptBytes).digest("hex")
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function verifyVisualReceipt(receiptPath, {
  htmlPath,
  screenshotDir,
  trustedBrowserSha256 = TRUSTED_BROWSER_SHA256,
  trustedCaptureScriptSha256 = TRUSTED_CAPTURE_SCRIPT_SHA256,
  trustedBuilderSha256,
  replayBuilder = true,
  replayCapture = true,
  captureReplayTimeoutMs = CAPTURE_REPLAY_TIMEOUT_MS
}) {
  const receiptBytes = fs.readFileSync(receiptPath);
  const receipt = readJson(receiptPath, "visual capture receipt");
  if (receipt.version !== 5) fail("Visual capture receipt must use version 5");
  if (receipt.ok !== true || receipt.capture_status !== "passed") fail("Visual capture did not pass", EXIT_INCOMPLETE);
  if (typeof receipt.run_id !== "string" || !receipt.run_id.trim()) fail("Visual capture run_id is required");
  for (const field of ["started_at", "generated_at"]) {
    if (typeof receipt[field] !== "string" || Number.isNaN(Date.parse(receipt[field]))) fail(`Visual capture ${field} is invalid`);
  }
  if (Date.parse(receipt.generated_at) < Date.parse(receipt.started_at)) fail("Visual capture predates its start");
  if (receipt.visual_review_status !== "pending") fail("Capture receipt must not claim visual review approval");
  if (canonicalJson(receipt.network_policy) !== canonicalJson({
    http: "exact_report_file_and_embedded_data_only",
    websocket: "blocked",
    service_worker: "blocked"
  })) {
    fail("Exact-report HTTP and WebSocket blocking was not recorded");
  }
  const expectedHtmlPath = path.resolve(htmlPath);
  if (path.resolve(receipt.html?.path ?? "") !== expectedHtmlPath) fail("Visual receipt points to a different HTML file");
  if (!fs.existsSync(expectedHtmlPath)) fail("Visual receipt HTML is missing");
  if (!SHA256.test(receipt.html.sha256 ?? "") || sha256(expectedHtmlPath) !== receipt.html.sha256) fail("Visual receipt HTML hash mismatch");
  const builderReceiptPath = verifyReference(receipt.builder_receipt, "Builder receipt");
  const builderReceipt = readJson(builderReceiptPath, "builder receipt");
  if (builderReceipt.version !== 3 || builderReceipt.run_id !== receipt.run_id) fail("Visual capture is bound to a different builder run");
  let verifiedBuilder;
  try {
    verifiedBuilder = verifyBrowserReceipt(builderReceiptPath, {
      htmlPath: expectedHtmlPath,
      artifactPath: path.resolve(builderReceipt.artifact?.path ?? ""),
      builderScriptPath: path.resolve(builderReceipt.builder?.script?.path ?? ""),
      rawReceiptPath: path.resolve(builderReceipt.builder?.raw_receipt?.path ?? ""),
      ...(trustedBuilderSha256 ? { trustedBuilderSha256 } : {}),
      replayBuilder
    });
  } catch (error) {
    fail(`Builder receipt verification failed: ${error.message}`, error.exitCode ?? EXIT_INVALID);
  }
  if (Date.parse(receipt.started_at) < Date.parse(verifiedBuilder.generated_at)) {
    fail("Visual capture starts before the bound builder completed");
  }
  const captureScriptPath = verifyReference(receipt.capture_script, "Capture script");
  if (!trustedCaptureScriptSha256.has(receipt.capture_script.sha256)) {
    fail(`Capture script digest is not in the trusted capture allowlist: ${receipt.capture_script.sha256}`);
  }
  const runtime = receipt.runtime;
  if (!runtime || runtime.node?.version !== process.version || runtime.node?.exec_path !== process.execPath ||
      runtime.node?.platform !== process.platform || runtime.node?.architecture !== process.arch) {
    fail("Capture Node runtime does not match the verifier runtime");
  }
  const captureScriptDirectory = path.dirname(captureScriptPath);
  if (path.basename(captureScriptDirectory) !== "scripts") fail("Capture script is outside the trusted skill scripts directory");
  const captureSkillRoot = path.dirname(captureScriptDirectory);
  try {
    verifyPlaywrightRuntimeAttestation(runtime.playwright_core, { skillRoot: captureSkillRoot });
  } catch (error) {
    fail(`Playwright runtime attestation failed: ${error.message}`);
  }

  const browserPath = path.resolve(receipt.browser?.executable ?? "");
  if (!fs.existsSync(browserPath) || !fs.statSync(browserPath).isFile()) fail("Visual receipt browser executable is missing");
  if (fs.lstatSync(browserPath).isSymbolicLink()) fail("Visual receipt browser executable must not be a symbolic link");
  if (!SHA256.test(receipt.browser.sha256 ?? "") || sha256(browserPath) !== receipt.browser.sha256) fail("Visual receipt browser hash mismatch");
  if (!trustedBrowserSha256.has(receipt.browser.sha256)) {
    fail(`Browser digest is not in the trusted browser allowlist: ${receipt.browser.sha256}`);
  }
  const versionResult = spawnSync(browserPath, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (versionResult.error || versionResult.status !== 0) fail("Visual receipt browser executable could not report its version");
  const commandVersion = versionResult.stdout.trim();
  if (commandVersion !== receipt.browser.command_version || !commandVersion.includes(receipt.browser.version)) {
    fail("Visual receipt browser version does not match the executable");
  }

  const screenshotRoot = path.resolve(screenshotDir);
  if (!fs.existsSync(screenshotRoot) || !fs.statSync(screenshotRoot).isDirectory()) fail("Screenshot directory is missing");
  if (fs.lstatSync(screenshotRoot).isSymbolicLink()) fail("Screenshot directory must not be a symbolic link");
  const responsive = receipt.responsive;
  if (!responsive || !Array.isArray(responsive.css_breakpoints) || !Array.isArray(responsive.viewport_matrix)) {
    fail("Responsive breakpoint evidence is missing", EXIT_INCOMPLETE);
  }
  if (!Number.isInteger(responsive.minimum_width) || !Number.isInteger(responsive.maximum_width) ||
      !Number.isInteger(responsive.boundary_delta)) {
    fail("Responsive breakpoint bounds are invalid");
  }
  const viewportByName = new Map();
  const viewportByWidth = new Map();
  for (const viewport of responsive.viewport_matrix) {
    if (typeof viewport.name !== "string" || !viewport.name.trim() || !Number.isInteger(viewport.width) ||
        !Number.isInteger(viewport.height) || !["full_tiling", "boundary_dom_interaction"].includes(viewport.coverage_mode)) {
      fail("Responsive viewport matrix contains an invalid entry");
    }
    if (viewportByName.has(viewport.name) || viewportByWidth.has(viewport.width)) fail("Responsive viewport matrix contains duplicates");
    if (viewport.width < responsive.minimum_width || viewport.width > responsive.maximum_width) {
      fail(`Responsive viewport ${viewport.name} is outside the recorded bounds`);
    }
    viewportByName.set(viewport.name, viewport);
    viewportByWidth.set(viewport.width, viewport);
  }
  if (!viewportByName.size) fail("Responsive viewport matrix is empty", EXIT_INCOMPLETE);
  if (!Array.isArray(receipt.screenshots) || !receipt.screenshots.length) fail("Visual receipt has no screenshots");
  const screenshots = receipt.screenshots.map((screenshot) => inspectScreenshot(screenshot, screenshotRoot, viewportByName));
  const names = new Set(screenshots.map((screenshot) => screenshot.name));
  const paths = new Set(screenshots.map((screenshot) => path.resolve(screenshot.path)));
  if (names.size !== screenshots.length) fail("Visual receipt has duplicate screenshot names");
  if (paths.size !== screenshots.length) fail("Visual receipt has duplicate screenshot paths");
  const actualPngNames = fs.readdirSync(screenshotRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
    .map((entry) => entry.name)
    .sort();
  const registeredPngNames = screenshots.map((screenshot) => `${screenshot.name}.png`).sort();
  if (JSON.stringify(actualPngNames) !== JSON.stringify(registeredPngNames)) {
    fail("Screenshot directory contains stale or unregistered PNG files");
  }

  if (!Array.isArray(receipt.browser_checks) || receipt.browser_checks.length !== viewportByName.size * 2) {
    fail("Visual receipt must contain light and dark browser checks for every responsive viewport");
  }
  for (const scheme of ["light", "dark"]) {
    assertResponsiveViewportCoverage(
      responsive.viewport_matrix,
      receipt.browser_checks.filter((check) => check.colour_scheme === scheme)
    );
  }
  const checkNames = new Set();
  for (const check of receipt.browser_checks) {
    if (checkNames.has(check.name)) fail(`Duplicate browser check ${check.name}`);
    checkNames.add(check.name);
    const scheme = check.colour_scheme;
    const suffix = scheme === "light" || scheme === "dark" ? `-${scheme}` : "";
    const viewportName = suffix && check.name?.endsWith(suffix) ? check.name.slice(0, -suffix.length) : "";
    const viewport = viewportByName.get(viewportName);
    if (!viewport) fail(`Unexpected browser check ${check.name}`);
    if (!Number.isInteger(check.attempts) || check.attempts < 1 || check.attempts > 3) fail(`${check.name} has invalid attempt count`);
    if (check.viewport?.width !== viewport.width || check.viewport?.height !== viewport.height ||
        check.coverage_mode !== viewport.coverage_mode) {
      fail(`${check.name} browser check metadata is false`);
    }
    const convergence = check.render_convergence;
    if (!convergence || !Number.isInteger(convergence.attempts) || convergence.attempts < 3 || convergence.attempts > 10 ||
        !Number.isInteger(convergence.stable_samples) || convergence.stable_samples < 3 ||
        !convergence.observation || convergence.observation.scroll_height !== check.dom?.scroll_height ||
        convergence.observation.block_count !== check.dom?.block_count) {
      fail(`${check.name} does not contain bounded stable-render evidence`, EXIT_INCOMPLETE);
    }
    const dom = check.dom ?? {};
    if (dom.document_state !== "complete" || dom.visible_text_characters < 40) fail(`${check.name} did not render meaningful content`, EXIT_INCOMPLETE);
    if (dom.reader_state !== "not_applicable" && (dom.reader_state !== "ready" || dom.reader_visible !== true)) {
      fail(`${check.name} reader was not visibly ready`, EXIT_INCOMPLETE);
    }
    if (dom.scroll_width > dom.client_width + 1) fail(`${check.name} has page-level horizontal overflow`, EXIT_INCOMPLETE);
    if (dom.prefers_dark !== (scheme === "dark")) fail(`${check.name} colour scheme did not apply`, EXIT_INCOMPLETE);
    if (!Number.isInteger(dom.block_count) || dom.block_count !== (dom.block_geometries ?? []).length) fail(`${check.name} has incomplete block geometry`);
    if (!Number.isInteger(dom.table_count) || dom.table_count < 0 || !Number.isInteger(dom.chart_count) || dom.chart_count < 0) {
      fail(`${check.name} has invalid table/chart counts`);
    }
    if (check.full_page_origin_scroll_y !== 0) {
      fail(`${check.name} full-page capture did not start at the document origin`, EXIT_INCOMPLETE);
    }
    const chartText = dom.chart_text_integrity;
    if (!chartText || chartText.status !== "passed" || !Number.isInteger(chartText.inspected_chart_count) ||
        chartText.inspected_chart_count !== dom.chart_count || !Number.isInteger(chartText.inspected_tick_count) ||
        !Number.isInteger(chartText.matched_category_tick_count) || chartText.fallback_binding_failure_count !== 0 ||
        chartText.truncated_label_count !== 0 ||
        chartText.mid_word_wrap_count !== 0 || chartText.omitted_category_count !== 0 ||
        !Array.isArray(chartText.omitted_categories) || chartText.omitted_categories.length !== 0 ||
        chartText.clipped_label_count !== 0 || chartText.overlapping_label_count !== 0 || chartText.issue_count !== 0 ||
        !Array.isArray(chartText.issues) || chartText.issues.length !== 0 || chartText.issues_truncated !== false) {
      fail(`${check.name} has incomplete or failed chart text integrity evidence`, EXIT_INCOMPLETE);
    }
    if ((check.external_requests ?? []).length) fail(`${check.name} attempted external requests`, EXIT_INCOMPLETE);
    if ((check.external_websockets ?? []).length) fail(`${check.name} attempted WebSocket connections`, EXIT_INCOMPLETE);
    if ((check.page_errors ?? []).length || (check.console_errors ?? []).length) fail(`${check.name} emitted browser errors`, EXIT_INCOMPLETE);
    const group = screenshots.filter((screenshot) => screenshot.viewportName === viewport.name && screenshot.scheme === scheme);
    if (viewport.coverage_mode === "full_tiling") verifyTiles(check, group);
    else {
      const full = group.filter((screenshot) => screenshot.capture_kind === "full_page");
      const nonTableEvidence = group.filter((screenshot) => screenshot.capture_kind !== "viewport_table_right_edge");
      if (full.length !== 1 || nonTableEvidence.length !== 1 || full[0].document_height !== check.dom.scroll_height) {
        fail(`${check.name} boundary visual evidence is incomplete`, EXIT_INCOMPLETE);
      }
    }
    verifyTableScroll(check, group, { requireVisualRightEdges: true });
  }
  for (const viewport of viewportByName.values()) {
    for (const suffix of screenshots
      .filter((entry) => entry.viewportName === viewport.name && entry.scheme === "light")
      .map((entry) => entry.name.replace(`${viewport.name}-light-`, ""))) {
      const light = screenshots.find((entry) => entry.name === `${viewport.name}-light-${suffix}`);
      const dark = screenshots.find((entry) => entry.name === `${viewport.name}-dark-${suffix}`);
      if (!light || !dark || light.sha256 === dark.sha256) fail(`${viewport.name}-${suffix} light and dark captures are identical`, EXIT_INCOMPLETE);
    }
  }
  if (!Number.isInteger(captureReplayTimeoutMs) || captureReplayTimeoutMs < 1 || captureReplayTimeoutMs > CAPTURE_REPLAY_TIMEOUT_MS) {
    fail("Capture replay timeout is invalid");
  }
  const captureReplay = replayCapture
    ? replayTrustedCapture({
        captureScriptPath,
        htmlPath: expectedHtmlPath,
        builderReceiptPath,
        runId: receipt.run_id,
        browserPath,
        originalReceipt: receipt,
        originalScreenshots: screenshots,
        timeoutMs: captureReplayTimeoutMs
      })
    : { status: "skipped_by_internal_test_harness" };
  return {
    ok: true,
    run_id: receipt.run_id,
    started_at: receipt.started_at,
    generated_at: receipt.generated_at,
    capture_status: "passed",
    visual_review_status: "pending",
    receipt_path: path.resolve(receiptPath),
    receipt_sha256: createHash("sha256").update(receiptBytes).digest("hex"),
    html_sha256: receipt.html.sha256,
    screenshot_count: screenshots.length,
    browser_check_count: receipt.browser_checks.length,
    builder_verification: verifiedBuilder,
    capture_replay: captureReplay
  };
}

function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write("Usage: node verify-visual-receipt.mjs --receipt <capture.json> --html <report.html> --screenshot-dir <directory>\n");
      return;
    }
    process.stdout.write(`${JSON.stringify(verifyVisualReceipt(args.receipt, {
      htmlPath: args.html,
      screenshotDir: args["screenshot-dir"]
    }))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = error.exitCode ?? EXIT_INVALID;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) runCli();
