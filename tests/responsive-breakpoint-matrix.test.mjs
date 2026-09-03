import assert from "node:assert/strict";
import test from "node:test";

import * as capture from "../scripts/capture-report-screenshots.mjs";
import * as visualVerifier from "../scripts/verify-visual-receipt.mjs";

const MATRIX_OPTIONS = {
  representativeViewports: [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 1000 }
  ],
  breakpoints: [600, 760, 600, 200, 1800],
  minimumWidth: 320,
  maximumWidth: 1600,
  boundaryDelta: 1,
  boundaryHeight: 900
};

test("responsive CSS breakpoints are discovered, normalised, deduplicated and bounded", () => {
  assert.equal(
    typeof capture.discoverCssBreakpoints,
    "function",
    "capture helper must export discoverCssBreakpoints"
  );
  const breakpoints = capture.discoverCssBreakpoints([
    "@media (min-width: 600px) { .panel { display: grid; } }",
    "@media screen and (max-width: 760px) { .nav { position: sticky; } }",
    "@media (min-width: 37.5rem) { .panel { gap: 1rem; } }",
    "@media (min-width: 200px) { body { margin: 0; } }",
    "@media (max-width: 1800px) { body { max-width: none; } }"
  ], {
    minimumWidth: 320,
    maximumWidth: 1600,
    rootFontSize: 16
  });
  assert.deepEqual(breakpoints, [600, 760]);
});

test("responsive discovery supports em units and both endpoints of chained width ranges", () => {
  const breakpoints = capture.discoverCssBreakpoints([
    "@media (min-width: 48em) { .wide { display: grid; } }",
    "@media (30rem <= width < 75rem) { .middle { display: block; } }"
  ]);

  assert.deepEqual(breakpoints, [480, 768, 1200]);
});

test("responsive discovery fails closed on unresolved width syntax and container queries", () => {
  assert.throws(
    () => capture.discoverCssBreakpoints(["@media (min-width: calc(40rem + 1px)) { body { margin: 0; } }"]),
    /unsupported.*width|width.*unsupported/i
  );
  assert.throws(
    () => capture.discoverCssBreakpoints(["@container card (min-width: 40rem) { .item { display: grid; } }"]),
    /container.*unsupported|unsupported.*container/i
  );
});

test("responsive capture rejects linked stylesheets instead of silently missing their breakpoints", () => {
  assert.equal(typeof capture.assertSelfContainedStylesheets, "function");
  assert.throws(
    () => capture.assertSelfContainedStylesheets('<link rel="stylesheet" href="report.css">'),
    /linked stylesheet/i
  );
  assert.doesNotThrow(() => capture.assertSelfContainedStylesheets("<style>@media (min-width: 40rem) {}</style>"));
});

test("the viewport matrix fully tiles representative widths and probes below, at and above each breakpoint", () => {
  assert.equal(
    typeof capture.buildResponsiveViewportMatrix,
    "function",
    "capture helper must export buildResponsiveViewportMatrix"
  );
  const matrix = capture.buildResponsiveViewportMatrix(MATRIX_OPTIONS);
  assert.deepEqual(
    matrix.map(({ width, coverage_mode: coverageMode }) => [width, coverageMode]),
    [
      [390, "full_tiling"],
      [599, "boundary_dom_interaction"],
      [600, "boundary_dom_interaction"],
      [601, "boundary_dom_interaction"],
      [759, "boundary_dom_interaction"],
      [760, "boundary_dom_interaction"],
      [761, "boundary_dom_interaction"],
      [1440, "full_tiling"]
    ]
  );
  assert.equal(new Set(matrix.map(({ width }) => width)).size, matrix.length);
  assert.ok(matrix.every(({ width }) => width >= 320 && width <= 1600));
});

test("the receipt contract rejects fixed representative-only checks and incomplete boundary interactions", () => {
  assert.equal(
    typeof visualVerifier.assertResponsiveViewportCoverage,
    "function",
    "visual verifier must export assertResponsiveViewportCoverage"
  );
  const requiredMatrix = [
    { width: 390, coverage_mode: "full_tiling" },
    { width: 599, coverage_mode: "boundary_dom_interaction" },
    { width: 600, coverage_mode: "boundary_dom_interaction" },
    { width: 601, coverage_mode: "boundary_dom_interaction" },
    { width: 759, coverage_mode: "boundary_dom_interaction" },
    { width: 760, coverage_mode: "boundary_dom_interaction" },
    { width: 761, coverage_mode: "boundary_dom_interaction" },
    { width: 1440, coverage_mode: "full_tiling" }
  ];
  const completedCheck = (entry) => ({
    viewport: { width: entry.width, height: entry.coverage_mode === "full_tiling" ? 844 : 900 },
    coverage_mode: entry.coverage_mode,
    dom_status: "passed",
    interaction_status: "passed"
  });
  const fixedRepresentativeOnly = requiredMatrix
    .filter(({ coverage_mode: coverageMode }) => coverageMode === "full_tiling")
    .map(completedCheck);
  assert.throws(
    () => visualVerifier.assertResponsiveViewportCoverage(requiredMatrix, fixedRepresentativeOnly),
    /missing.*breakpoint|responsive.*coverage|599|600|760/i
  );

  const completeChecks = requiredMatrix.map(completedCheck);
  assert.doesNotThrow(() => visualVerifier.assertResponsiveViewportCoverage(requiredMatrix, completeChecks));

  const interactionNotRun = completeChecks.map((entry) => ({ ...entry }));
  interactionNotRun.find(({ viewport }) => viewport.width === 760).interaction_status = "pending";
  assert.throws(
    () => visualVerifier.assertResponsiveViewportCoverage(requiredMatrix, interactionNotRun),
    /interaction.*760|760.*interaction/i
  );
});
