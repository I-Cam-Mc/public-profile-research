# Browser and visual QA gate

Final HTML delivery requires three distinct receipts:

1. a hash-bound receipt from the canonical report builder's real browser checks;
2. an automated responsive capture receipt with observable DOM and PNG checks;
3. a separate screenshot-by-screenshot visual-review receipt.

Structural validation alone is draft-only. Screenshot generation alone is not visual approval.

## One-time environment setup

From this skill directory, install the pinned library without running package lifecycle scripts:

```bash
npm install --ignore-scripts
npx --yes playwright-core@1.61.1 install --only-shell chromium
```

The first command installs the dependency declared in `package-lock.json`. The second writes the matching Chromium headless shell to the user's Playwright cache. Neither command uses `sudo`. Request approval before downloading either dependency.

Do not substitute full Chrome for a report verifier that requires the matching headless shell. The helper reads the `chromium-headless-shell` entry from the attested Playwright `browsers.json` and resolves only that cache revision. For Playwright 1.61.1 this is revision 1228. It must not select whichever cached browser happens to be newest. A caller-supplied `CHROMIUM_EXECUTABLE_PATH` is accepted only when its path identifies the same pinned revision. The capture helper launches Chromium with its sandbox enabled.

On managed macOS agent hosts, Chromium may be killed by the outer execution sandbox with a `MachPortRendezvousServer` permission error 1100 even though Chromium's own sandbox is enabled and the same command succeeds in Terminal. This is an outer sandbox permission boundary, not evidence that the report or Chromium sandbox failed. Ask for approval to run the exact pinned browser command outside that managed sandbox; do not disable Chromium's sandbox as a workaround.

## Runtime attestation before browser loading

The capture process must attest its execution runtime before dynamically importing `playwright-core`. The attestation binds:

- package name and exact version `playwright-core@1.61.1`;
- the sorted SHA-256 manifest and aggregate digest of seven execution-critical files: `browsers.json`, `index.js`, `index.mjs`, `lib/bootstrap.js`, `lib/coreBundle.js`, `lib/utilsBundle.js` and `package.json`;
- the root `package-lock.json` hash, lockfile version, dependency path, package version, resolved package URL and integrity value;
- the Node version, executable path, platform and architecture used for capture.

Reject missing files, symbolic links, paths that resolve outside the installed skill, an unreviewed aggregate digest or any lockfile identity mismatch. `verify-visual-receipt.mjs` recomputes the attestation from the installed skill and requires the same Node runtime. This is a controlled release boundary for the reviewed runtime files, not a claim that every byte in Node, the operating system or Chromium has been cryptographically vouched for.

## Hash-bound builder attestation

Preserve the builder's raw JSON receipt. Wrap it in an attestation containing:

- schema `version: 3`;
- a unique run ID and generation time;
- the exact artifact path and hash;
- the exact generated HTML path and hash;
- the builder script path and hash;
- the raw builder-receipt path and hash;
- the whole-run, reader-readiness and action timeout values used by the builder.

The raw observation still must show validation, package and browser verification `passed`, no capability warning, widths 1440 and 390, and keyboard source-dialog interaction when sources exist. Keep the timeout values large enough for the report size and current machine, and preserve them in the attestation so replay cannot silently use a smaller budget.

Verify it with explicit expected files:

```bash
node /absolute/path/to/skill/scripts/verify-browser-receipt.mjs \
  --receipt /absolute/path/to/builder-receipt.json \
  --html /absolute/path/to/report.html \
  --artifact /absolute/path/to/artifact.json \
  --builder-script /absolute/path/to/reviewed-builder.mjs \
  --raw-receipt /absolute/path/to/raw-builder-receipt.json
```

A caller-supplied `passed` flag, a nonexistent HTML path or a receipt from an older output must fail. The verifier requires canonical paths, a reviewed builder digest and an exact raw-receipt path, then executes the trusted builder in a temporary directory and requires it to reproduce the attested HTML byte for byte. Update the digest allowlist only after reviewing and testing a deliberate builder change.

## Responsive capture

Run:

```bash
node /absolute/path/to/skill/scripts/capture-report-screenshots.mjs \
  --html /absolute/path/to/report.html \
  --out-dir /absolute/path/to/qa/screenshots \
  --receipt /absolute/path/to/qa/capture-receipt.json \
  --run-id "the-builder-attestation-run-id" \
  --builder-receipt /absolute/path/to/builder-receipt.json
```

The helper produces a schema-version-5 receipt. It scans the raw inline HTML for `@media` width predicates expressed in `px`, `rem` or `em`, recognising classic `min-width`/`max-width`, either single-sided range form and chained ranges. It builds a bounded responsive matrix and exercises every matrix width in light and dark modes. Widths 390 x 844 and 1440 x 1000 are the representative full-document viewports. For each discovered breakpoint inside the supported 320 to 1600 pixel range, it adds the widths one pixel below, exactly at and one pixel above, deduplicating overlaps. Each boundary probe uses a 900-pixel-high viewport. The matrix is capped at 100 distinct widths. Linked stylesheets, unresolved `calc()`/`var()` widths and `@container` width queries fail capture explicitly instead of being silently omitted; convert them to auditable inline viewport queries or add a separate fit-for-purpose test.

For every matrix entry, the helper:

- waits for document completion, fonts and the enhanced reader's positive ready state;
- waits two animation frames after readiness;
- repeatedly traverses the full document so lazy content can render, then requires three identical DOM observations within at most ten observations;
- samples document height and width, client width, visible-text length, and visible block, table and chart counts for render convergence;
- permits only the exact local report plus embedded `data:` and `blob:` resources, blocks service workers, and blocks and records every other HTTP request and every WebSocket attempt;
- fails on page errors or console errors;
- checks visible text and non-zero reader geometry;
- checks whole-document horizontal overflow;
- identifies all rendered content blocks, charts and horizontally scrollable tables;
- requires portable live charts to bind to actual fallback data tables by stable chart identity, fails closed when that contract is missing or malformed, then rejects ellipsised labels, mid-word wraps, clipped or overlapping category ticks, and omitted labels when a categorical chart has at most 12 categories;
- drives every table to its right edge and back at every width;
- returns the document to scroll position zero after interaction probes and records that origin before every full-page capture, preventing sticky headers from being rasterised over mid-document content;
- checks the requested colour scheme actually applied;
- captures a full-page image at every representative and breakpoint width;
- decodes every PNG and rejects wrong dimensions, transparency, uniform frames and near-empty renders;
- retries a bounded three times after deleting stale outputs;
- records the shared run ID, builder receipt, trusted capture-script digest, runtime attestation, browser executable/version/digest, responsive matrix, network policy, convergence evidence, HTML, screenshot and visual-metric hashes.

At the representative 390 and 1440 widths, it additionally captures overlapping viewport-height tiles from the document start to its measured end. At every representative and below/at/above breakpoint width, it saves a separate viewport image at the right edge of every overflowing table. Boundary probes do not pretend to provide full-document tiling, but they do provide full-page, chart-text, table-interaction and table-right-edge visual evidence.

The screenshot count is intentionally dynamic because it depends on document height. Every tile range must form gap-free coverage of the measured document. The helper removes old matching images before capture, and the verifier rejects any unregistered PNG left in the screenshot directory. Capture leaves visual review pending by design.

Verify the capture independently:

```bash
node /absolute/path/to/skill/scripts/verify-visual-receipt.mjs \
  --receipt /absolute/path/to/qa/capture-receipt.json \
  --html /absolute/path/to/report.html \
  --screenshot-dir /absolute/path/to/qa/screenshots
```

The verifier requires schema version 5, the matching run ID and fully replayed builder receipt, the exact runtime and lockfile attestation, reviewed browser and capture-script digests, canonical in-directory paths and exact name-to-path mappings. It executes the recorded browser to verify its version, recomputes PNG dimensions and content metrics, rejects symlinks and stale images, checks light/dark differences, reconstructs the required breakpoint matrix, requires both colour schemes at every width, and validates the 3-of-10 convergence, zero-scroll full-page origin and network-policy evidence. At representative widths it verifies that every recorded content block intersects a readable tile and confirms gap-free tile coverage. At every tested width it checks all table-scroll observations and requires a separate right-edge screenshot for each overflowing table. It also rejects missing portable chart fallback bindings and truncated, mid-word-wrapped, omitted, clipped or overlapping category labels in small categorical charts. Breakpoint boundaries retain a full-page visual plus the DOM, chart-text and table-interaction evidence.

Production verification also reruns the exact hash-approved capture script in a temporary directory with the attested runtime, pinned browser, HTML, builder receipt and run ID. It normalises timestamps, retry counts and temporary absolute paths, then requires exact semantic runtime, responsive-matrix, network, convergence, browser, DOM, tiling and table metadata. It requires exact decoded RGBA pixels for every representative viewport tile and table-right-edge image. Full-page images can vary narrowly because fixed or sticky elements can move during Playwright's stitched full-page capture; their dimensions and document height must match exactly and their meaningful-image metrics must remain within the documented narrow tolerances. Gap-free viewport tiles are the canonical whole-document proof at 390 and 1440, while the boundary full pages are required visual evidence for each discovered responsive transition. A digest allowlist remains a controlled release boundary, not a substitute for reviewing code changes.

## Visual review

Generate the pending template:

```bash
node /absolute/path/to/skill/scripts/record-visual-review.mjs \
  --capture-receipt /absolute/path/to/qa/capture-receipt.json \
  --html /absolute/path/to/report.html \
  --screenshot-dir /absolute/path/to/qa/screenshots \
  --output /absolute/path/to/qa/visual-review.json
```

The command cannot approve the report. Open every registered image at readable scale, including every below/at/above breakpoint full page, then manually complete the version-2 template with a reviewer identity, `inspection_method: "manual_image_inspection"`, a review time after capture, and one decision per image. Every applicable check must be true and every observation must be unique, image-specific and at least 30 characters. Full-page decisions must explicitly confirm the final section is present. Table right-edge decisions must describe the visible rightmost content and set `right_edge_content_visible: true`.

Validate the completed receipt:

```bash
node /absolute/path/to/skill/scripts/verify-visual-review.mjs \
  --review /absolute/path/to/qa/visual-review.json \
  --capture-receipt /absolute/path/to/qa/capture-receipt.json \
  --html /absolute/path/to/report.html \
  --screenshot-dir /absolute/path/to/qa/screenshots
```

The verifier reruns the automated capture-receipt checks and binds every manual decision to the exact run, capture receipt, HTML and screenshot hashes. It rejects missing decisions, repeated or obvious filename-substitution templates and admissions that no inspection occurred. The review receipt is still a named reviewer's self-attestation; text validation cannot prove that a human honestly looked at an image. Keep reviewer independence and process evidence separate from the schema gate. A failed or missing image blocks finalisation.

## Remaining boundaries

These checks certify the selected Chromium engine at the recorded viewports on the current rendering environment. They are an auditable replay and consistency chain, not cryptographic signing against an operator who deliberately changes trusted code and its allowlists, or falsifies a manual-review identity. Linked stylesheets, unresolved `calc()`/`var()` widths and `@container` width queries are rejected rather than guessed. Print, touch behaviour, other engines and cross-browser pixel parity need explicit separate tests when material to the deliverable. Browser QA verifies presentation only: it cannot turn inaccessible platform content or a partial public-source corpus into complete research coverage.
