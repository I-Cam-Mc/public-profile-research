# Public Profile Research

An auditable Codex skill for building evidence-bound public-person research corpora and briefings.

The skill is designed to prevent a common research failure: collecting a partial platform view and then describing it as comprehensive. It separates item processing from source-family coverage, records inaccessible material explicitly, checks text, images, video and speech as separate modalities, and provides executable verification for corpus and HTML-report quality.

## What it does

- Selects an `insight`, `bounded_census` or `maximum_public_coverage` research mode.
- Freezes the target identity, accounts, source families, time ranges and expected denominators before collection.
- Tracks every retained item to a terminal state without treating inaccessible material as successfully processed.
- Requires reply context, full exposed creator text, complete transcript or no-speech evidence, and full-duration visual review where applicable.
- Records adapter attempts, pagination endpoints, barriers and provenance receipts.
- Labels facts, self-reports, demonstrated skills, repeated public patterns and inferences separately.
- Validates responsive HTML reports with trusted browser replay, screenshot provenance, chart-text checks and explicit visual review.

## Requirements

- Node.js 22 or newer
- A compatible Chromium headless-shell installation for browser verification

Install dependencies:

```bash
npm ci
```

Run the test suite:

```bash
npm test
```

The current suite contains 100 tests.

## Use as a Codex skill

Copy this repository into your Codex skills directory as `public-profile-research`, then invoke `$public-profile-research` with a named person and research objective.

Read [SKILL.md](SKILL.md) first. It is the operational entry point. Supporting contracts live in [references](references/):

- `evidence-contract.md` defines the corpus manifest, ledger and closure rules.
- `platform-routes.md` defines the supported access ladders and failure classifications for difficult platforms.
- `browser-qa.md` defines final HTML verification and responsive visual review.

## Verification commands

Validate a research case:

```bash
node scripts/verify-case.mjs --case /absolute/path/to/case.json
```

Exit code `0` means every requested gate passed. Exit code `2` means the manifest, schema or provenance is invalid. Exit code `6` means the evidence is structurally valid but requested coverage or modality work remains incomplete.

The remaining scripts cover browser receipts, responsive screenshot capture, visual replay and reviewer receipts. See `SKILL.md` and `references/browser-qa.md` for the required sequence.

## Research boundaries

This tool analyses public material. It does not convert public behaviour into a private psychological diagnosis, reveal hidden employers or relationships, recover removed or private content, or treat a private briefing as permission to make unsupported claims.

## Repository status

Version `0.3.0`. The package is marked `private` to prevent accidental publication to npm. That setting does not prevent normal GitHub use.

