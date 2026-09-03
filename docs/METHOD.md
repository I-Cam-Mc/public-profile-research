# Method and process briefing

## The product goal

Public Profile Research should answer two different questions without confusing them:

1. What public material about this person can be found and verified?
2. What bounded impressions or conclusions can reasonably be drawn from that material?

The first is collection and provenance. The second is analysis. A useful product needs both, but analysis cannot repair incomplete or misidentified evidence.

## What the Ali research taught us

The earlier Ali work was not performed by one magic scraper. It combined:

- Agent Reach for capability discovery and platform routing;
- `yt-dlp` for YouTube metadata and subtitles or media where accessible;
- signed-in browser access for public pages hidden behind login screens;
- transcription and visual review for audiovisual content;
- GitHub and web search for professional, code and appearance discovery;
- custom source inventories, ledgers, receipts and verification scripts;
- independent collection, synthesis and review workstreams.

Agent Reach is essential for broad-social discovery because it turns a vague “search social media” instruction into explicit backend choices and health checks. It is not sufficient by itself. It does not resolve identity, prove source completeness, review every media modality, reconcile duplicates or turn source extracts into a defensible profile. GitHub, Jina Reader and supported `yt-dlp` routes remain useful independently for their source families.

The executable runner makes search breadth measurable. Its quick, standard, deep and maximum budgets plan 1, 5, 9 and 14 separately receipted Exa queries. Non-quick queries are capped at six returned results each, then candidate URLs are canonicalised and deduplicated before the separate page-follow-up budget is applied. These are bounded recall budgets, not completeness guarantees.

The product therefore treats Agent Reach as the routing layer inside a larger evidence system.

## First-principles workflow

### 1. Intake

Start from one public profile link, a purpose and the user’s questions. Infer harmless details such as a candidate handle. Ask only about choices that change identity, scope, cost, access or outcome.

Output: `intake.json`, labelled `research_state: not_run`.

### 2. Identity resolution

Use first-party cross-links and corroborating biography details to separate the intended person from same-name candidates. Preserve rejected candidates so they cannot be rediscovered and accidentally merged later.

Output: candidate decision and confirmed identity anchors.

### 3. Capability preflight

Probe the exact tools needed for the declared platforms. A local run starts with `node bin/ppr.mjs doctor`, then inspects Agent Reach health, GitHub access and `yt-dlp` availability as relevant. A chat-only AI should state which web, browser, media and code capabilities it can actually use.

Output: available routes, login decisions and classified barriers.

### 4. Discovery

Search names, handle variants, organisations, domains, projects, event appearances, interviews and platform-constrained results. Discovery maximises recall. Its output is a lead set, not confirmed identity or evidence.

Output: discovery ledger with accepted, rejected, unresolved and out-of-scope leads.

### 5. Enumeration and collection

Collect each confirmed source family through an explicit adapter ladder. Preserve stable identifiers, timestamps, pagination cursors, denominators, date buckets and captures. Use retries only where they are meaningfully different routes.

Output: evidence files, collection receipts and source-family coverage states.

### 6. Modality processing

Review creator text, reply context, images, carousels, video and speech according to what each item contains. A caption cannot stand in for an image and a frame cannot stand in for audio.

Output: terminal processing state for every retained item.

### 7. Synthesis

Build facts, events, relationships and analyses as separate structured records. Link every material statement to evidence IDs. Keep public persona, claim-specific credibility and controversy analysis within their evidence and context.

Output: structured report model and private purpose-specific appendix. The local deterministic builder normalises source items, deduplicates, builds evidence-linked timelines and surfaces repeated observable patterns. This is extractive synthesis. An active AI may add interpretive synthesis, including public persona, claim-specific credibility or career context, only from cited source items with uncertainty and alternative interpretations.

### 8. Verification

Reconcile source inventory, ledgers, receipts, captures and report claims. Test the HTML in a real browser at desktop, mobile, breakpoint, light and dark states. Review representative screenshots rather than trusting structure alone.

Output: valid complete or valid partial result, never a silent downgrade.

## Efficient parallelisation

Parallel work is valuable when ownership is non-overlapping:

- one worker per source family or fixed item range;
- separate identity-resolution and collection ownership;
- separate synthesis and evidence-review ownership;
- separate report-building and visual-quality ownership.

Do not point several workers at the same account with no stable partition. That creates duplicate retrieval, inconsistent identity decisions and summaries that cannot be reconciled.

Use external ledgers rather than trying to hold a large corpus in one model context. Workers should produce structured outputs and receipts. A primary integrator owns the final identity decisions, inference wording and report voice.

## Completeness model

Three distinct claims prevent false confidence:

- `insight`: evidence answers a bounded question, but sampling may remain.
- `bounded_census`: every item in an explicit platform, account, source-type and date boundary was processed.
- `maximum_public_coverage`: every declared, legitimately accessible source family and adapter ladder was attempted or ended with an evidenced barrier. It does not mean the entire internet was searched.

The current local runner does not generate the hash-referenced denominator-enumeration receipts required to close `bounded_census` or `maximum_public_coverage`. The ordinary browser therefore enables only `insight`. The advanced modes remain part of the contract and closure model for integrations that can supply that evidence, but a current local run must remain partial rather than infer a denominator from a page or adapter success flag.

An inaccessible item can be terminal while its source family remains incomplete. A completed program run can still produce partial coverage. The local runner exits `0` only when collection, identity, the requested research goal, every requested module and any custom instructions reach their declared closure conditions. It exits `2` for useful partial evidence, `1` for no useful subject evidence or fatal collection failure, and `64` for invalid input.

## Why one canonical skill

Codex, Claude Code and Gemini CLI can consume Agent Skills built around `SKILL.md`. Chat products can use a flattened portable prompt and project instructions. One source of truth prevents evidence rules from drifting by platform.

Platform adapters should translate installation and capability detection only. They should not fork the method.

## Improvement loop

For each real run, retain anonymised operational metrics rather than personal source content:

- adapters attempted and success classes;
- queries and returned-item counts;
- duplicate rate;
- media minutes processed;
- wall time and compute cost;
- unsupported-claim and identity-review failures;
- source families that remained partial;
- browser and report verification failures.

Use those measurements to adjust budgets and adapter order. Do not claim a pricing tier, model or tool is better without a representative evaluation.
