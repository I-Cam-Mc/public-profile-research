---
name: public-profile-research
description: Build an auditable public-person research corpus and briefing with explicit discovery, enumeration, modality, access and browser-QA gates. Use for biography, career, code, video, social-post, collaborator, public-persona or comprehensive public-corpus research about a named person.
---

# Public profile research

Build a source-bound briefing from public material without turning a partial platform view into a completeness claim. The skill is successful when its evidence and limits are reproducible, not when every platform happens to be accessible.

## Select the research mode first

Choose one mode and record it in `case.json`:

- `insight`: gather enough independent evidence to answer a bounded question. Sampling is allowed and must be labelled.
- `bounded_census`: enumerate and process every item inside named, measurable platform boundaries.
- `maximum_public_coverage`: exhaust the approved public and legitimately authenticated adapter ladder, including date buckets and supplements.

Requests containing “all”, “every”, “comprehensive”, “complete corpus” or equivalent select `maximum_public_coverage` automatically. Do not silently downgrade the mode when a platform is difficult.

## Preflight before collection

1. Resolve identity from first-party pages and keep rejected account candidates separate.
2. Freeze the expected source classes, create a hash-bound `source-inventory.json`, and define the target kind and time interval for every included family. Give each family exactly one included account owner; separate accounts need separate families and denominator receipts. A discovered source may be included, rejected as a different identity, explicitly out of scope or inaccessible, but it may not disappear between discovery and verification.
3. Run live backend checks before planning collection. Use purpose-built connectors or official APIs first, then maintained local tools, then an authorised signed-in browser.
4. Surface login, eligibility and cost decisions early. A free-only constraint changes the achievable closure status and must be recorded before collection.
5. Register every base ledger and supplement in one schema-version-2 case manifest. Each ledger has exactly one owning family. Files found under the ledger directory but absent from that manifest are a completion error.
6. For an HTML deliverable, preflight the real browser verifier before synthesis. Read [browser-qa.md](references/browser-qa.md).

Read [platform-routes.md](references/platform-routes.md) when X, TikTok or LinkedIn is in scope. It explains the adapter ladders and current hard boundaries that caused earlier false-completion results.

## Keep two gates separate

An item can be terminal while its source family remains incomplete.

### Item processing gate

Every retained row must end as one of:

- `processed` with every required modality complete;
- `duplicate` or `derivative`, linked to the retained evidence package;
- `inaccessible`, with every approved fallback receipt and a classified barrier;
- `unresolved`, with the exact missing context, modality or access step.

An inaccessible or unresolved state is honest terminal bookkeeping. It is not proof that enumeration or processing is complete.

### Source-family closure gate

Each family is independently labelled `closed`, `high_coverage`, `partial`, `lead_only` or `unavailable`. A `closed` maximum-coverage family requires:

- all declared pagination, date buckets and stable-ID routes reached their terminal condition;
- displayed, API or export denominators reconcile when one exists;
- a fixed approved-adapter list, with every adapter exhausted or evidenced as inapplicable through a schema-validated, hash-bound receipt;
- all ledgers and supplements are registered;
- each retained row satisfies its modality and context requirements;
- repeated passes or marginal-yield stopping rules are recorded where no denominator exists.

The report status cannot exceed its weakest material source family. For maximum-coverage work, partial enumeration remains valid evidence, exits with code 6 and blocks a final claim. Do not turn a valid partial result into a schema error merely to make the status disappear.

## Review every exposed modality

Determine requirements from the item itself, not from what the collector happened to download.

Normalise every ledger row to the closed `item_type` allowlist in the evidence contract. Do not create a platform-specific alias that escapes the intrinsic media gates.

- creator text: review the full exposed text;
- reply: preserve parent or conversation context;
- video or live stream: explicitly determine its audio/speech state rather than omitting speech because a collector did not return audio;
- audio stream: require a complete transcript, an audio-checked no-speech result, or an evidenced access barrier;
- video: require full-duration interval plus scene-change visual coverage;
- image or carousel: review every exposed child in order;
- inaccessible media: preserve bounded attempts and the terminal platform error.

Visual completion never satisfies speech completion. If media bytes are recovered, retain them until probing, transcription, semantic review and provenance sidecars finish. Do not delete temporary media merely because its hash was recorded.

For local transcription, use the dedicated transcription skill and preserve source/audio hashes, engine and model revisions, decode settings and precision limits. Generated text is approximate until consequential wording is checked against the original audio.

## Record adapter exhaustion and barriers

Every adapter attempt needs a time, scope, result, cursor or end condition and receipt path. Classify failures as:

- `authentication_required`
- `rate_limited`
- `platform_virtualisation`
- `pagination_unavailable`
- `media_download_disabled`
- `removed_or_invalid`
- `region_or_eligibility_restricted`
- `paid_api_declined`
- `tool_missing`
- `transient_tool_failure`

Retry only according to the documented adapter ladder and a bounded stopping rule. A single failed extractor run is not adapter exhaustion. Conversely, another wrapper around the same blocked endpoint is not an independent fallback.

## Maintain evidence and inference discipline

Use these labels: `documented_fact`, `public_self_report`, `demonstrated_skill`, `repeated_public_pattern`, `bounded_inference`, `weak_signal`, and `unknown`.

Collapse duplicates and derivatives before counting corroboration. Public persona is not private personality. Do not infer diagnoses, hidden employers, private relationships, precise locations or removed/private content. A private report may be candid, but privacy does not make unsupported claims accurate.

## Parallelise by ownership

Assign non-overlapping source families or row ranges to workers. Give each one a fixed manifest and output path. Keep collection, integration and independent review as separate roles. Do not multiply agents over the same account merely to produce several summaries.

## Verify before final delivery

The executable evidence contract is in [evidence-contract.md](references/evidence-contract.md).

Resolve this skill's absolute directory from the loaded `SKILL.md`, then run:

```bash
node /absolute/path/to/skill/scripts/verify-case.mjs --case /absolute/path/to/case.json
```

Exit codes:

- `0`: all requested closure gates pass;
- `2`: manifest, schema or provenance is invalid;
- `6`: evidence is valid but the requested coverage or modality gate is incomplete.

For HTML, do not accept `structural_only` in final mode. Follow [browser-qa.md](references/browser-qa.md) end to end:

1. bind the canonical builder's raw receipt to the exact artifact, HTML, builder hashes and timeout settings;
2. validate that attestation with `verify-browser-receipt.mjs`;
3. before loading Playwright, attest the pinned Playwright 1.61.1 runtime and lockfile, then select the exact Chromium headless-shell revision declared by that runtime;
4. run `capture-report-screenshots.mjs` in light and dark modes with external HTTP, service workers and WebSockets blocked, bounded 3-of-10 render convergence, full tiling at widths 390 and 1440, document-origin-normalised full-page probes below, at and above every supported inline raw-HTML `@media` width breakpoint (`px`/`rem`/`em` min/max, single-sided or chained range syntax), fail-closed portable chart-to-fallback binding and label-integrity checks, and a separate right-edge image for every overflowing table at every tested width;
5. independently replay the trusted capture and validate its responsive matrix, DOM, chart-text and interaction observations, screenshot paths, hashes, dimensions and decoded pixel content with `verify-visual-receipt.mjs`;
6. inspect every representative and breakpoint image, then record and validate a separate visual-review receipt.

Capture success is not visual approval. The capture helper creates a pending review template only. A named reviewer must inspect every registered image and record image-specific decisions before `verify-visual-review.mjs` can pass. The verifier can reject missing and obviously templated review text, but it cannot prove an honest human inspection from text alone. A blank, stale, unregistered, out-of-tree, truncated, transparent, metrics-free or replay-divergent screenshot blocks final delivery.

Finish with an independent coverage, citation, duplication, inference and usefulness review. Report exact frozen counts, processing outcomes, inaccessible items, unresolved residuals and observation dates. Say “every post ever” only when a complete first-party export or equivalent archive proves it.
