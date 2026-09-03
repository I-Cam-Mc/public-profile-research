# Intake contract

The form, grill-style interview and command line interface must compile to the same `research_intake` contract. This is not the evidence case manifest. Collection turns it into a run plan and evidence case.

## Minimum start

A run can begin with:

- one HTTPS public profile URL;
- a purpose;
- a selected depth;
- optional requested modules and custom direction.

The display name may be inferred from the first profile path. Inference never confirms identity.

## Canonical fields

| Field | Meaning |
|---|---|
| `schema_version` | Intake schema version, currently `1` |
| `contract_type` | `research_intake` |
| `research_state` | `not_run` until a collector actually executes |
| `research_mode` | `insight`, `bounded_census` or `maximum_public_coverage` |
| `relationship_to_subject` | `self`, `authorised_representative` or `third_party` |
| `corpus_scope` | `public_only` or `public_plus_subject_provided` |
| `delivery_visibility` | Private by default |
| `retention_policy` | Local until deleted by default |
| `subject` | Display name, HTTPS identity anchors and identity status |
| `purpose` | The report lens selected by the user |
| `depth` | Execution budget preset, independent from research mode |
| `cost_policy` | Whether the run may use paid tools, currently free-only in the public compiler |
| `modules` | Requested profile and analysis sections |
| `custom_instructions` | Additional bounded research questions |
| `analysis_policy` | Stable evidence and inference constraints |

## Research mode versus execution depth

Research mode defines the evidentiary claim:

- `insight`: enough independent evidence to answer named questions, with sampling allowed and labelled.
- `bounded_census`: every item inside a declared measurable boundary.
- `maximum_public_coverage`: every approved adapter and declared date bucket is exhausted, with unresolved gaps preserved.

Execution depth defines a resource budget. Paying for or selecting a deeper run does not automatically change an insight request into maximum public coverage.

The ordinary browser intake enables only `insight`. The current local runner does not produce denominator-enumeration receipts, so a CLI intake may name an advanced mode for an integration workflow but cannot close it by itself. `bounded_census` and `maximum_public_coverage` remain partial until a compatible integration attaches the explicit boundary, stable-item reconciliation and hash-referenced exhausted denominator receipt required by the evidence contract.

## Adaptive interview

Ask only questions that change identity, scope, risk, cost or result. The recommended sequence is:

1. Infer the candidate handle and platform from the first link.
2. Ask purpose and the most important questions if missing.
3. Ask relationship to the subject only when subject-provided material or a sensitive use case is requested.
4. Detect available tools and show expected access gaps.
5. Present the proposed contract for confirmation.
6. Resolve conflicting identity anchors before collection.

Unsafe custom instructions fail before collection. The interface should explain the unsupported request and preserve the rest of the valid scope where possible.
