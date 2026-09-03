import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPendingReviewTemplate } from "../scripts/record-visual-review.mjs";
import { verifyVisualReviewDocument } from "../scripts/verify-visual-review.mjs";

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "visual-review-"));
  const htmlPath = path.join(root, "report.html");
  fs.writeFileSync(htmlPath, "<!doctype html><main>Report</main>\n");
  const capturePath = path.join(root, "capture.json");
  const screenshots = [
    { name: "desktop-light-tile-001", capture_kind: "viewport_tile" },
    { name: "desktop-light-full", capture_kind: "full_page" },
    { name: "mobile-dark-tile-001", capture_kind: "viewport_tile" },
    { name: "mobile-dark-full", capture_kind: "full_page" }
  ].map((entry, index) => ({
    ...entry,
    sha256: String(index + 1).repeat(64).slice(0, 64)
  }));
  const capture = {
    version: 5,
    run_id: "qa-run-123",
    started_at: "2026-09-02T00:01:00Z",
    generated_at: "2026-09-02T00:02:00Z",
    html: { path: htmlPath, sha256: sha256(htmlPath) },
    screenshots
  };
  fs.writeFileSync(capturePath, `${JSON.stringify(capture)}\n`);
  const reviewPath = path.join(root, "review.json");
  const review = {
    version: 2,
    run_id: capture.run_id,
    status: "passed",
    reviewer: "independent-agent",
    inspection_method: "manual_image_inspection",
    reviewed_at: "2026-09-02T00:03:00Z",
    capture_receipt: { path: capturePath, sha256: sha256(capturePath) },
    html: { path: htmlPath, sha256: sha256(htmlPath) },
    decisions: screenshots.map((screenshot, index) => ({
      name: screenshot.name,
      sha256: screenshot.sha256,
      status: "passed",
      checks: {
        content_visible: true,
        no_clipping: true,
        text_readable: true,
        theme_legible: true,
        document_end_present: screenshot.capture_kind === "full_page" ? true : null
      },
      observation: `Capture ${index + 1} shows distinct report content with readable headings and intact card edges.`
    })),
    overall_notes: "Every supplied image was opened at readable scale and compared with its adjacent vertical capture."
  };
  fs.writeFileSync(reviewPath, `${JSON.stringify(review)}\n`);
  return { root, htmlPath, capturePath, reviewPath, review, capture };
}

test("an explicit image-by-image visual review passes its document gate", () => {
  const state = fixture();
  const result = verifyVisualReviewDocument(state.reviewPath, {
    captureReceiptPath: state.capturePath,
    htmlPath: state.htmlPath
  });
  assert.equal(result.decision_count, 4);
  assert.equal(result.run_id, "qa-run-123");
});

test("a pending template cannot manufacture visual approval", () => {
  const state = fixture();
  const template = buildPendingReviewTemplate(state.capture, {
    captureReceiptPath: state.capturePath,
    htmlPath: state.htmlPath
  });
  assert.equal(template.status, "pending");
  assert.equal(template.reviewer, null);
  assert.ok(template.decisions.every((decision) => decision.status === "pending"));
  fs.writeFileSync(state.reviewPath, `${JSON.stringify(template)}\n`);
  assert.throws(
    () => verifyVisualReviewDocument(state.reviewPath, {
      captureReceiptPath: state.capturePath,
      htmlPath: state.htmlPath
    }),
    (error) => error.exitCode === 6 && /did not pass/i.test(error.message)
  );
});

test("generic repeated observations cannot stand in for image inspection", () => {
  const state = fixture();
  for (const decision of state.review.decisions) decision.observation = "Readable and complete.";
  fs.writeFileSync(state.reviewPath, `${JSON.stringify(state.review)}\n`);
  assert.throws(
    () => verifyVisualReviewDocument(state.reviewPath, {
      captureReceiptPath: state.capturePath,
      htmlPath: state.htmlPath
    }),
    /specific|observation|repeated/i
  );
});

test("a review admitting automation or no image inspection cannot approve delivery", () => {
  const state = fixture();
  state.review.reviewer = "automated-no-inspection";
  state.review.overall_notes = "This review was generated automatically without opening or inspecting any screenshot.";
  for (const decision of state.review.decisions) {
    decision.observation = `Automatically asserted ${decision.name} is readable without opening or inspecting its image.`;
  }
  fs.writeFileSync(state.reviewPath, `${JSON.stringify(state.review)}\n`);
  assert.throws(
    () => verifyVisualReviewDocument(state.reviewPath, {
      captureReceiptPath: state.capturePath,
      htmlPath: state.htmlPath
    }),
    /automated|automation|no inspection|without.*inspect|without.*open/i
  );
});

test("screenshot names inserted into a generic template do not prove image-specific inspection", () => {
  const state = fixture();
  state.review.overall_notes = "Each registered screenshot was checked and accepted.";
  for (const decision of state.review.decisions) {
    decision.observation = `Screenshot ${decision.name} passes every required visual check.`;
  }
  fs.writeFileSync(state.reviewPath, `${JSON.stringify(state.review)}\n`);
  assert.throws(
    () => verifyVisualReviewDocument(state.reviewPath, {
      captureReceiptPath: state.capturePath,
      htmlPath: state.htmlPath
    }),
    /specific visible content|templated|generic.*screenshot/i
  );
});

test("a table right-edge image needs an explicit manual visibility decision", () => {
  const state = fixture();
  const screenshot = {
    name: "mobile-light-table-001-right",
    capture_kind: "viewport_table_right_edge",
    sha256: "a".repeat(64)
  };
  state.capture.screenshots.push(screenshot);
  fs.writeFileSync(state.capturePath, `${JSON.stringify(state.capture)}\n`);
  state.review.capture_receipt.sha256 = sha256(state.capturePath);
  state.review.decisions.push({
    name: screenshot.name,
    sha256: screenshot.sha256,
    status: "passed",
    checks: {
      content_visible: true,
      no_clipping: true,
      text_readable: true,
      theme_legible: true,
      right_edge_content_visible: false,
      document_end_present: null
    },
    observation: "The mobile table is visible, but its rightmost columns were not confirmed during inspection."
  });
  fs.writeFileSync(state.reviewPath, `${JSON.stringify(state.review)}\n`);
  assert.throws(
    () => verifyVisualReviewDocument(state.reviewPath, {
      captureReceiptPath: state.capturePath,
      htmlPath: state.htmlPath
    }),
    /right-edge table content/i
  );
});

test("a review bound to a different capture receipt is rejected", () => {
  const state = fixture();
  state.review.capture_receipt.sha256 = "f".repeat(64);
  fs.writeFileSync(state.reviewPath, `${JSON.stringify(state.review)}\n`);
  assert.throws(
    () => verifyVisualReviewDocument(state.reviewPath, {
      captureReceiptPath: state.capturePath,
      htmlPath: state.htmlPath
    }),
    /capture receipt hash mismatch/i
  );
});

test("a review from a different run or before capture completion is rejected", () => {
  const state = fixture();
  state.review.run_id = "old-run";
  state.review.reviewed_at = "2026-09-02T00:00:00Z";
  fs.writeFileSync(state.reviewPath, `${JSON.stringify(state.review)}\n`);
  assert.throws(
    () => verifyVisualReviewDocument(state.reviewPath, {
      captureReceiptPath: state.capturePath,
      htmlPath: state.htmlPath
    }),
    /run_id|capture completion/i
  );
});
