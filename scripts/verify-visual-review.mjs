#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyVisualReceipt } from "./verify-visual-receipt.mjs";

const EXIT_INVALID = 2;
const EXIT_INCOMPLETE = 6;
const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_CHECKS = ["content_visible", "no_clipping", "text_readable", "theme_legible"];
const NO_INSPECTION_PATTERN = /\b(?:automated|automatically|automation|auto-generated|no[- ]inspection|without (?:opening|inspecting)|not (?:opened|inspected)|did not (?:open|inspect))\b/i;
const GENERIC_OBSERVATION_PATTERN = /^(?:screenshot|image|capture)\s+\S+\s+(?:passes|passed|meets|met)\s+(?:every|all|the)\s+required\s+visual\s+checks?\.?$/i;

function fail(message, exitCode = EXIT_INVALID) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseArgs(argv) {
  const values = {};
  const supported = new Set(["review", "capture-receipt", "html", "screenshot-dir"]);
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

export function verifyVisualReviewDocument(reviewPath, { captureReceiptPath, htmlPath }) {
  const reviewBytes = fs.readFileSync(reviewPath);
  const review = readJson(reviewPath, "visual review");
  const capture = readJson(captureReceiptPath, "visual capture receipt");
  if (review.version !== 2) fail("Visual review must use version 2");
  if (typeof review.run_id !== "string" || !review.run_id.trim()) fail("Visual review run_id is required");
  if (review.status !== "passed") fail("Visual review status did not pass", EXIT_INCOMPLETE);
  if (typeof review.reviewer !== "string" || !review.reviewer.trim()) fail("Visual review reviewer is required");
  if (NO_INSPECTION_PATTERN.test(review.reviewer)) fail("Visual review cannot be approved by an automated no-inspection reviewer");
  if (review.inspection_method !== "manual_image_inspection") {
    fail("Visual review inspection_method must be manual_image_inspection");
  }
  if (typeof review.reviewed_at !== "string" || Number.isNaN(Date.parse(review.reviewed_at))) {
    fail("Visual review reviewed_at is invalid");
  }
  if (path.resolve(review.capture_receipt?.path ?? "") !== path.resolve(captureReceiptPath)) {
    fail("Visual review points to a different capture receipt");
  }
  if (!SHA256.test(review.capture_receipt?.sha256 ?? "") || review.capture_receipt.sha256 !== sha256(captureReceiptPath)) {
    fail("Visual review capture receipt hash mismatch");
  }
  if (path.resolve(review.html?.path ?? "") !== path.resolve(htmlPath)) fail("Visual review points to a different HTML file");
  if (!SHA256.test(review.html?.sha256 ?? "") || review.html.sha256 !== sha256(htmlPath)) {
    fail("Visual review HTML hash mismatch");
  }
  if (capture.version !== 5 || !Array.isArray(capture.screenshots) || !capture.screenshots.length) {
    fail("Visual review requires a version-5 capture receipt");
  }
  if (review.run_id !== capture.run_id) fail("Visual review run_id does not match the capture run_id");
  if (Date.parse(review.reviewed_at) < Date.parse(capture.generated_at)) {
    fail("Visual review predates capture completion");
  }
  if (!Array.isArray(review.decisions) || review.decisions.length !== capture.screenshots.length) {
    fail("Visual review must contain one decision per screenshot");
  }
  const captureByName = new Map(capture.screenshots.map((screenshot) => [screenshot.name, screenshot]));
  const seen = new Set();
  const observations = new Set();
  const observationTemplates = new Set();
  for (const decision of review.decisions) {
    if (seen.has(decision.name)) fail(`Visual review repeats ${decision.name}`);
    seen.add(decision.name);
    const screenshot = captureByName.get(decision.name);
    if (!screenshot) fail(`Visual review contains unknown screenshot ${decision.name}`);
    if (decision.sha256 !== screenshot.sha256) fail(`Visual review screenshot hash mismatch: ${decision.name}`);
    if (decision.status !== "passed") fail(`Visual review ${decision.name} failed`, EXIT_INCOMPLETE);
    if (!decision.checks || typeof decision.checks !== "object" || Array.isArray(decision.checks)) {
      fail(`Visual review ${decision.name} checks are missing`);
    }
    for (const required of REQUIRED_CHECKS) {
      if (decision.checks[required] !== true) fail(`Visual review ${decision.name} did not pass ${required}`);
    }
    if (screenshot.capture_kind === "full_page" && decision.checks.document_end_present !== true) {
      fail(`Visual review ${decision.name} did not check the document end`);
    }
    if (
      screenshot.capture_kind === "viewport_table_right_edge" &&
      decision.checks.right_edge_content_visible !== true
    ) {
      fail(`Visual review ${decision.name} did not confirm visible right-edge table content`);
    }
    if (typeof decision.observation !== "string" || decision.observation.trim().length < 30) {
      fail(`Visual review ${decision.name} needs a specific observation of at least 30 characters`);
    }
    if (NO_INSPECTION_PATTERN.test(decision.observation)) {
      fail(`Visual review ${decision.name} admits automation or no image inspection`);
    }
    if (GENERIC_OBSERVATION_PATTERN.test(decision.observation.trim())) {
      fail(`Visual review ${decision.name} uses a generic screenshot template instead of specific visible content`);
    }
    const normalisedObservation = decision.observation.trim().toLowerCase();
    if (observations.has(normalisedObservation)) fail(`Visual review repeats a generic observation for ${decision.name}`);
    if (new Set(["readable and complete.", "looks good.", "passed."]).has(normalisedObservation)) {
      fail(`Visual review ${decision.name} uses a canned observation`);
    }
    const observationTemplate = normalisedObservation.split(decision.name.toLowerCase()).join("<screenshot>");
    if (observationTemplates.has(observationTemplate)) {
      fail(`Visual review repeats a templated observation for ${decision.name}`);
    }
    observations.add(normalisedObservation);
    observationTemplates.add(observationTemplate);
  }
  for (const name of captureByName.keys()) if (!seen.has(name)) fail(`Visual review is missing ${name}`);
  if (typeof review.overall_notes !== "string" || !review.overall_notes.trim()) fail("Visual review overall_notes are required");
  if (NO_INSPECTION_PATTERN.test(review.overall_notes)) {
    fail("Visual review overall_notes admit automation or no image inspection");
  }
  return {
    ok: true,
    status: "passed",
    run_id: review.run_id,
    reviewer: review.reviewer,
    reviewed_at: review.reviewed_at,
    review_path: path.resolve(reviewPath),
    review_sha256: createHash("sha256").update(reviewBytes).digest("hex"),
    capture_receipt_sha256: review.capture_receipt.sha256,
    html_sha256: review.html.sha256,
    decision_count: review.decisions.length
  };
}

export function verifyVisualReview(reviewPath, { captureReceiptPath, htmlPath, screenshotDir }) {
  verifyVisualReceipt(captureReceiptPath, { htmlPath, screenshotDir });
  return verifyVisualReviewDocument(reviewPath, { captureReceiptPath, htmlPath });
}

function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(
        "Usage: node verify-visual-review.mjs --review <review.json> --capture-receipt <capture.json> " +
        "--html <report.html> --screenshot-dir <directory>\n"
      );
      return;
    }
    process.stdout.write(`${JSON.stringify(verifyVisualReview(args.review, {
      captureReceiptPath: args["capture-receipt"],
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
