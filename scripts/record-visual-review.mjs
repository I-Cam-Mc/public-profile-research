#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifyVisualReceipt } from "./verify-visual-receipt.mjs";

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseArgs(argv) {
  const values = {};
  const supported = new Set([
    "capture-receipt",
    "html",
    "screenshot-dir",
    "output"
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--") || !supported.has(token.slice(2))) throw new Error(`Unknown argument: ${token}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${token} requires a value`);
    values[token.slice(2)] = value;
    index += 1;
  }
  for (const key of supported) if (!values[key]?.trim()) throw new Error(`--${key} is required`);
  for (const key of ["capture-receipt", "html", "screenshot-dir", "output"]) values[key] = path.resolve(values[key]);
  return values;
}

export function buildPendingReviewTemplate(capture, { captureReceiptPath, htmlPath }) {
  return {
    version: 2,
    run_id: capture.run_id,
    status: "pending",
    reviewer: null,
    inspection_method: null,
    reviewed_at: null,
    capture_receipt: {
      path: captureReceiptPath,
      sha256: sha256(captureReceiptPath)
    },
    html: {
      path: htmlPath,
      sha256: sha256(htmlPath)
    },
    decisions: capture.screenshots.map((screenshot) => ({
      name: screenshot.name,
      sha256: screenshot.sha256,
      status: "pending",
      checks: {
        content_visible: null,
        no_clipping: null,
        text_readable: null,
        theme_legible: null,
        right_edge_content_visible: screenshot.capture_kind === "viewport_table_right_edge" ? null : "not_applicable",
        document_end_present: screenshot.capture_kind === "full_page" ? null : "not_applicable"
      },
      observation: null
    })),
    overall_notes: null,
    instructions: [
      "Open every screenshot at a readable scale.",
      "Set reviewer, inspection_method=manual_image_inspection and reviewed_at after inspection.",
      "For every decision, set status, every applicable check and a screenshot-specific observation.",
      "For every table right-edge capture, confirm right_edge_content_visible=true and identify the rightmost content observed.",
      "Set overall status to passed only when every decision passes."
    ]
  };
}

export function recordVisualReview(options) {
  verifyVisualReceipt(options["capture-receipt"], {
    htmlPath: options.html,
    screenshotDir: options["screenshot-dir"]
  });
  const capture = JSON.parse(fs.readFileSync(options["capture-receipt"], "utf8"));
  const review = buildPendingReviewTemplate(capture, {
    captureReceiptPath: options["capture-receipt"],
    htmlPath: options.html
  });
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return review;
}

function runCli(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(
        "Create a pending review template, then manually inspect and complete it:\n" +
        "record-visual-review.mjs --capture-receipt <capture.json> --html <report.html> " +
        "--screenshot-dir <dir> --output <review.json>\n"
      );
      return;
    }
    const review = recordVisualReview(options);
    process.stdout.write(`${JSON.stringify({ ok: true, status: "pending", output: options.output, decisions: review.decisions.length })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) runCli();
