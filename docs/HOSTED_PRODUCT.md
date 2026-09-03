# Hosted product outline

## Product shape

The durable model is an open-source research engine with an optional managed service. The methodology, schemas, adapters, prompts and verification rules remain public. Managed tiers charge for compute, collection budget, media processing, storage and review.

## Surfaces

### Open-source skill and runner

- Complete method under MIT.
- Working local execution through Agent Reach for broad-social discovery, plus GitHub, `yt-dlp` and web-reading adapters for their own source families.
- Private files on the user’s machine.
- Portable prompts for major AI systems.
- Configurable budgets and honest partial outputs.

### Static public site

- No-account intake and grill-style scoping.
- Generates `intake.json` and a portable AI prompt.
- Demonstrates report structure and source coverage.
- The local app can connect to its loopback research API. The published GitHub Pages copy has no collector API.
- Does not claim that exporting an intake file performed research.

### Managed hosted service

- Queued jobs running the same open-source engine.
- Real public-source collection with visible limits.
- Private report access, retention controls and export.
- Optional model synthesis and evidence review.

The current repository implements the first two surfaces and the shared engine. A public multi-tenant backend requires the controls in `SECURITY.md` and a service-specific privacy notice before launch.

## Pilot tiers

These are testable product hypotheses, not proven unit economics.

| Tier | Price | Initial execution budget | Intended result |
|---|---:|---|---|
| Open | $0 | 20 items, 6 discovery queries, 10 minutes, no bulk media | A real bounded public scan or fully self-run local job |
| Snapshot | $20 | 60 items, 15 queries, 30 minutes | Current public surface and evidence-linked summary |
| Profile | $80 | 250 items, 50 queries, 60 media minutes, 3 hours | Wider source families, timeline, project or organisation subpages and a second citation pass |
| Diligence | $200 | 1,000 items, 150 queries, 240 media minutes, 8 hours | Declared extended scope plus independent identity and evidence review |

Budgets must be visible before purchase. A fixed-price run can validly finish partial. It cannot promise unlimited coverage or every historical post.

Every tier uses the same public-information boundaries and evidence standard. Price does not unlock hidden accounts, addresses, biometric identification, private relationship mapping or stronger accusations.

## Launch sequence

1. Release the MIT skill, local runner, static intake app and fictional demo.
2. Run representative self-audit and professional-profile evaluations with consenting subjects.
3. Measure adapter success, runtime, media cost and review time.
4. Add a hosted free scan with strict rate and item limits.
5. Implement accounts, tenant isolation, private storage, expiry and deletion.
6. Add one paid pilot tier and verify payment, refund and fulfilment behaviour.
7. Add deeper tiers only after measured costs and review capacity support them.

Payment buttons should remain labelled previews until billing, refunds, privacy, fulfilment and support are operating end to end.

## Hosted architecture

```text
Browser intake
    |
    v
Authenticated API -> policy and target validation -> durable job queue
                                                |
                                                v
                                         isolated worker
                                  Agent Reach / yt-dlp / APIs
                                                |
                                                v
                                  evidence store and report builder
                                                |
                                                v
                                    signed private report access
```

The public marketing site can be static. Real hosted research cannot rely on a static GitHub Pages process because browsers cannot execute local collectors, protect service credentials or run durable media jobs.
