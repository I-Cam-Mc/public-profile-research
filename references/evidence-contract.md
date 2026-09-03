# Evidence contract version 2

The contract is source-agnostic. Subject data and credentials stay outside the installed skill. Every file reference inside a case uses a path relative to `case.json` and a lowercase SHA-256 hash.

## Case manifest

`case.json` requires an independently evidenced source inventory, an explicit source-class scope and at least one material family:

```json
{
  "schema_version": 2,
  "case_id": "authorised-case-id",
  "mode": "maximum_public_coverage",
  "requested_report_status": "final",
  "ledger_directory": "ledgers",
  "scope": {
    "expected_source_classes": ["video_account", "social_account", "code_profile"]
  },
  "source_inventory": {
    "path": "source-inventory.json",
    "sha256": "64-lowercase-hex"
  },
  "source_families": [
    {
      "id": "video-account",
      "platform": "video-platform",
      "material": true,
      "ledger_paths": ["ledgers/video-account.jsonl"],
      "enumeration": {
        "status": "closed",
        "target": { "kind": "lifetime", "account_url": "https://public.example/account" },
        "denominator_basis": "complete_api_listing",
        "expected_count": 1,
        "enumerated_count": 1,
        "approved_adapter_ids": ["official_listing"],
        "adapters": [
          {
            "id": "official_listing",
            "coverage_role": "denominator",
            "status": "exhausted",
            "attempted_at": "2026-09-02T00:00:00Z",
            "receipt": {
              "path": "receipts/video-account.json",
              "sha256": "64-lowercase-hex"
            }
          }
        ]
      }
    }
  ]
}
```

Valid target kinds are `lifetime`, `date_interval`, `current_public_surface` and `bounded_listing`. Maximum coverage always requires one. A date interval uses half-open dates in `target.start` and `target.end`, plus gap-free exhausted `query_intervals`.

Valid denominator bases are:

- `complete_first_party_export`
- `complete_api_listing`
- `displayed_total_reconciled`
- `terminal_pagination`
- `date_bucket_exhaustion`
- `no_denominator_marginal_yield`
- `observed_displayed_total`
- `unknown`

`observed_displayed_total` and `unknown` cannot support `closed`. A no-denominator stopping rule needs at least two dated zero-growth passes. An invented denominator label is a schema error.

## Source inventory

`source-inventory.json` prevents a case from silently omitting an already identified platform or account:

```json
{
  "schema_version": 1,
  "observed_at": "2026-09-02T00:02:00Z",
  "discovery_receipts": [
    { "path": "receipts/discovery.json", "sha256": "64-lowercase-hex" }
  ],
  "sources": [
    {
      "id": "video-account",
      "source_class": "video_account",
      "platform": "video-platform",
      "account_url": "https://public.example/account",
      "disposition": "included",
      "source_family_id": "video-account",
      "evidence": [
        { "path": "evidence/account.json", "sha256": "64-lowercase-hex" }
      ]
    }
  ]
}
```

Every `scope.expected_source_classes` value must appear in both a discovery receipt and the inventory. Every included source owns an existing source family, and every family has exactly one included account owner. Keep genuinely separate accounts in separate families so a denominator receipt cannot enumerate one account while silently closing another. A non-included source uses `out_of_scope`, `rejected_identity` or `inaccessible`, with a reason and evidence. This does not make open-web discovery metaphysically exhaustive; it makes the frozen discovery boundary explicit and auditable.

In `maximum_public_coverage`, every included source family is material. Do not suppress a weak family by setting `material: false`; use an evidenced non-included inventory disposition when a source is genuinely outside the approved scope.

## Ledger row

Every JSONL row requires full identity, dates, modalities and hash-bound evidence:

```json
{
  "item_id": "stable-id",
  "canonical_url": "https://public.example/item/stable-id",
  "item_type": "video",
  "published_at": "2026-09-01T00:00:00Z",
  "observed_at": "2026-09-02T00:00:00Z",
  "final_state": "processed",
  "required_modalities": ["creator_text", "speech", "visual"],
  "modalities": {
    "creator_text": "complete",
    "speech": "complete",
    "visual": "complete"
  },
  "media": {
    "recovered": true,
    "audio_stream": true,
    "sha256": "64-lowercase-hex"
  },
  "visual_review": {
    "method": "frame-and-scene review",
    "coverage": "full_duration",
    "evidence": [{ "path": "evidence/item-visual-review.json", "sha256": "64-lowercase-hex" }]
  },
  "speech_review": {
    "method": "transcript semantic review",
    "coverage": "full_duration",
    "evidence": [{ "path": "evidence/item-speech-review.json", "sha256": "64-lowercase-hex" }]
  },
  "evidence": [
    { "path": "evidence/item.json", "sha256": "64-lowercase-hex" }
  ]
}
```

Valid `item_type` values are `article`, `audio`, `carousel`, `image`, `link`, `live_stream`, `reply`, `text` and `video`. Reject collector-specific aliases such as `short_video` until they are normalised to their intrinsic media type; otherwise a new label could bypass the video, speech or visual gates.

`processed` requires every declared modality to be complete, not present after inspection, or audio-checked with no speech. `not_present` requires separate hash-bound `modality_absence` evidence and cannot be used to bypass a media type's intrinsic modality. Every video or live stream must determine speech/audio rather than omitting the field; a recovered audio stream whose collector omitted speech remains incomplete. Video and live-stream visual review requires `full_duration`; image review requires `full_resolution`; carousel review requires `all_assets`. Completed speech review requires `full_duration`. Recovered media with an audio stream requires `speech = complete` or `audio_checked_no_speech`, even if the collector omitted speech from `required_modalities`.

`duplicate` and `derivative` require `linked_item_id`. Reply rows require `context.reply_parent = complete`. `inaccessible` requires a classified barrier, `fallbacks_exhausted = true` and hash-bound attempt receipts. `unresolved` requires an exact reason. Inaccessible and unresolved rows remain valid evidence bookkeeping, but they block a final maximum-coverage claim.

## Adapter receipt

An `exhausted` or `inapplicable` adapter receipt requires:

```json
{
  "schema_version": 2,
  "adapter_id": "official_listing",
  "adapter_version": "1.0.0",
  "started_at": "2026-09-02T00:00:00Z",
  "ended_at": "2026-09-02T00:01:00Z",
  "scope": { "kind": "lifetime", "account_url": "https://public.example/account" },
  "returned_count": 1,
  "unique_id_count": 1,
  "terminal_reason": "listing_exhausted",
  "credential_present": false,
  "captures": [
    { "path": "captures/official-listing.json", "sha256": "64-lowercase-hex" }
  ]
}
```

The adapter entry in `case.json` also declares `coverage_role: "denominator"` or `"supplement"`. A denominator adapter's exhausted unique-ID count must reconcile to the retained family rows, while a supplement may add context without pretending to define the denominator. Receipt scope must match the family's target, and `captures` must resolve to real hash-bound files rather than opaque digest strings. `inapplicable` also requires a barrier from the skill taxonomy. Do not store cookies, tokens, authorisation headers or browser profiles.

Each capture file is machine-readable JSON with an `ids` or `item_ids` array of stable string IDs. The union must equal `unique_id_count`; for an exhausted denominator adapter it must exactly equal the retained family row IDs. The receipt's `scope.account_url` must match an included source-inventory account.

All hash-bound case references must be ordinary files whose real paths remain inside the case directory. Symbolic links and parent-directory link escapes are invalid even when their target bytes match the recorded hash.

## Ownership and supplements

Every `.jsonl` file under `ledger_directory` must belong to exactly one source family. Stable item IDs must be unique within that family across base and supplement ledgers. Duplicate and derivative rows must link to a retained item in the same family. An undeclared supplement is an incomplete result, and one ledger registered to two families is a schema error.

## HTML browser evidence

A final HTML report uses the separate browser chain in [browser-qa.md](browser-qa.md). The automated responsive-capture receipt uses schema `version: 5` and must bind the same run ID to:

- the exact HTML, builder receipt and reviewed capture script by canonical path and SHA-256;
- the Node version, executable path, platform and architecture;
- the attested `playwright-core@1.61.1` package and seven-file execution-critical runtime digest, plus the exact root `package-lock.json` identity;
- the Chromium headless-shell executable, version and digest selected from the exact revision declared in the attested Playwright `browsers.json`;
- an explicit network policy allowing only the exact report file and embedded `data:` or `blob:` resources, with service workers and WebSockets blocked;
- discovered inline raw-HTML `@media` width breakpoints in supported `px`/`rem`/`em` min/max, single-sided or chained range syntax, supported bounds, boundary delta and the deduplicated responsive viewport matrix;
- one light and one dark browser check for every matrix width, including bounded render-convergence, DOM, chart-text, table-interaction, zero-scroll full-page origin, network and browser-error observations;
- registered screenshot paths, dimensions, file hashes, decoded-pixel evidence and visual metrics.

The viewport matrix requires full overlapping tiling and a full-page image at representative widths 390 and 1440. Every discovered supported inline breakpoint also requires a probe one pixel below, exactly at and one pixel above, with a full-page image plus passed DOM, chart-text and table-interaction checks. Linked stylesheets, unresolved `calc()`/`var()` widths and `@container` width queries must fail capture and require conversion or a separate explicit test; they must never be silently omitted. Every overflowing table at every tested width requires its own right-edge screenshot. Every portable chart must retain its stable fallback identity and actual fallback table; small categorical charts must show every category without truncation, mid-word wrapping, clipping or overlap. Each check must show three identical render observations within no more than ten observations. Capture itself may retry no more than three times.

Production verification must recompute the runtime, browser, HTML and PNG evidence and replay the trusted capture in a fresh temporary directory. The capture receipt remains `visual_review_status: "pending"`. A separate version-2 visual-review receipt must bind to the exact capture and contain one image-specific manual decision for every registered representative and breakpoint image. Automated text validation can detect missing or obviously templated decisions but cannot prove that the named reviewer honestly inspected an image.

The browser chain verifies the rendered report, not the completeness of its research inputs. Passing version-5 capture and manual review cannot promote a `partial`, `lead_only` or `unavailable` source family. Likewise, a managed macOS `MachPortRendezvousServer` permission error 1100 is an outer sandbox execution boundary: approved execution of the exact pinned command outside that sandbox is required, never disabling Chromium's own sandbox.

## Status and exit behaviour

The report coverage state equals its weakest material family:

```text
closed > high_coverage > partial > lead_only > unavailable
```

The verifier returns:

- exit `0` with `ok: true` when all requested gates pass;
- exit `2` for invalid schema, provenance, hashes or ownership;
- exit `6` with `valid: true`, the computed weakest status and explicit completion reasons when the evidence is valid but incomplete.

A completed analysis of a partial ledger remains partial.
