# Public Profile Research

Turn one public profile link into a bounded evidence archive and readable private profile. This is a working local research product: it runs real collectors on your computer, records what each route returned, normalises collected material into source items, and generates an evidence-linked HTML report. It does not claim that one link proves identity or that any platform is exhaustively covered.

[Try the intake website](https://i-cam-mc.github.io/public-profile-research/) · [Read the skill](SKILL.md) · [Understand the method](docs/METHOD.md) · [See licences and credits](ACKNOWLEDGEMENTS.md)

## What is working now

- An open-source AI skill that guides adaptive intake, source discovery, collection, media review, synthesis and verification.
- A local Node.js runner that calls real collectors and writes hash-bound evidence, receipts and an HTML report.
- Agent Reach capability routing and broad-social discovery for runner-supported public platforms, with detection-only routes labelled separately.
- GitHub public profile and repository collection.
- `yt-dlp` collection for supported public video metadata, with deeper media review directed by the skill.
- A bounded readable-page fallback.
- A responsive browser interface with a form and grill-style intake.
- Portable instructions for ChatGPT, Codex, Claude, Gemini and other capable AI systems.
- Deterministic corpus and browser-quality verifiers inherited from the research process that produced this project.

The GitHub Pages website is a static intake and explanation site. It cannot run collectors, retain a job, authenticate to a platform or protect service credentials. Clone the repository and run the local app to perform research on your own computer. A production multi-tenant hosted collector is not claimed as live.

There are three deliberately separate execution surfaces:

| Surface | What it actually does |
|---|---|
| Local runner and app | Executes the available collectors, records receipts and source items, and builds an extractive evidence-linked report |
| AI skill | Orchestrates broader tool use and performs the cited interpretive pass for career, persona, credibility, controversies and other requested analysis |
| GitHub Pages website | Runs the intake interview and exports a portable research pack; it does not claim that collection or analysis ran |

## Quick start

Requirements:

- Node.js 22 or newer.
- Internet access for enabled public collectors.
- Agent Reach for broad-social discovery and supported social-platform routes. It is the essential route when the request needs more than direct GitHub, web-page or video collection. A route shown by Agent Reach is not necessarily implemented by this runner, and `doctor` labels detection-only routes.
- GitHub CLI for richer GitHub collection, and `yt-dlp` for supported public video routes. Those routes can work separately when the request only concerns GitHub, readable pages or supported video.

Install Agent Reach through its maintained safe-first route. On macOS or Linux, the upstream guide recommends `pipx`:

```bash
pipx install https://github.com/Panniantong/agent-reach/archive/main.zip
agent-reach install --env=auto
agent-reach doctor
```

On Windows PowerShell, where `pipx` is unavailable, the upstream virtual-environment route is:

```powershell
py -3 -m venv "$env:USERPROFILE\.agent-reach-venv"
& "$env:USERPROFILE\.agent-reach-venv\Scripts\Activate.ps1"
python -m pip install https://github.com/Panniantong/agent-reach/archive/main.zip
agent-reach install --env=auto
agent-reach doctor
```

The first `agent-reach install` invocation is a read-only dependency check. If it reports missing core tools, preview the proposed system changes with `agent-reach install --env=auto --dry-run`. Run the corresponding `--system` command only after reviewing and approving those changes. Social routes such as Instagram, Facebook and X can additionally require OpenCLI plus an existing browser login. Follow [Agent Reach's current installation guide](https://github.com/Panniantong/Agent-Reach/blob/main/docs/install.md) because platform routes and installation details change.

From Terminal:

```bash
git clone https://github.com/I-Cam-Mc/public-profile-research.git
cd public-profile-research
npm ci
node bin/ppr.mjs doctor
npm run app
```

Open `http://127.0.0.1:4173`. The server binds only to your computer. Start with one public profile link, choose the question and confirm only supplied profiles you already know belong to the subject. Newly discovered profiles remain leads. Review them, then add confirmed links to a new intake before treating their material as the same person. Generated runs are stored under `public-profile-runs/` unless configured otherwise.

To prove the collector and report path without entering a person:

```bash
node bin/ppr.mjs run \
  --intake examples/octocat/intake.json
```

This demonstration fixture explicitly pre-confirms the supplied Octocat account. Real intakes remain unconfirmed unless the user checks the identity confirmation control or corroborating evidence resolves the match.

The command prints its new output directory and report path. You may provide `--output /a/new/directory`, but a fixed output path cannot be reused: the runner fails instead of mixing a new case with old evidence.

Exit codes:

- `0`: collection, identity, the requested research goal, every requested module and any custom instructions reached their declared closure conditions.
- `2`: useful subject evidence was saved, but coverage, identity, access or modality work remains partial.
- `1`: no useful subject evidence was saved, or collection failed before a useful run.
- `64`: the command or intake contract is invalid.

## What the runner creates

```text
public-profile-run/
├── research-run.json
├── evidence-ledger.json
├── evidence/
├── receipts/
└── report/
    ├── report.json
    └── index.html
```

The deterministic report builder performs source-item normalisation, deduplication, evidence-linked timeline and repeated-pattern extraction. It does not pretend to understand a person. An active AI can add interpretive synthesis, such as public persona, credibility or career context, only from cited source items and with uncertainty shown. Any such section is labelled `not_synthesised` until that active AI pass happens.

Exit `0` is deliberately strict. Identity uses the separate identity gate. Timeline needs dated supplied-source material; current activity needs an explicit publication, update or push signal inside the reported 365-day observation window; projects need a supplied project or repository item; and media needs usable transcript or speech-review evidence for every collected video. Career, companies, code, professional network, commercial activity, public impression, public persona, credibility and controversies remain open until an active cited pass records completion. Non-empty custom instructions also remain open until a completion record covers the exact text.

## Why Agent Reach matters

Agent Reach is the essential broad-social discovery and capability route used by the original Ali research process. It identifies which backend can currently reach each supported platform, including login-dependent routes. The runner implements collectors for a subset of those routes. Run `node bin/ppr.mjs doctor` before a broad-social job to see which routes are ready and collectable by this runner, and which are detection-only.

It is one layer of the product, not the whole method. GitHub collection, readable-page extraction, and supported `yt-dlp` video routes can still be useful without Agent Reach for their own source families. Identity resolution, evidence lineage, duplicate handling, audiovisual review, inference control and report verification remain this project’s responsibility.

Use Agent Reach’s [maintained installation guide](https://github.com/Panniantong/Agent-Reach/blob/main/docs/install.md). The project never asks you to paste login tokens into a command or report. When a public page needs authentication, sign in through the platform’s normal browser interface and enable only the relevant route.

[Agent Reach currently documents its Exa MCP discovery route](https://github.com/Panniantong/Agent-Reach/blob/main/agent_reach/guides/setup-exa.md) as free and requiring no API key. Hosted Jina Reader is also used without a project-owned paid account. Those services can still impose quotas, rate limits or changed terms. The local product never creates a checkout or knowingly invokes a paid-key route under `free_tools_only`; re-check external terms before a large run.

Discovery is depth-aware and bounded. Quick runs use one compact Exa query; standard, deep and maximum budgets fan out across 5, 9 and 14 separately receipted queries. Each non-quick query is capped at six results, candidate URLs are canonicalised and deduplicated, and only 5, 10 or 20 candidate pages are followed at the corresponding depth. Unfollowed leads remain visible rather than being silently discarded. This improves recall without claiming exhaustive internet coverage.

## Source routes

| Source | Primary executable route | Honest limit |
|---|---|---|
| Open web | Agent Reach discovery and readable-page extraction | Search results are leads until the underlying source is checked |
| GitHub | Public API, with GitHub CLI available to the AI workflow | Repository pages do not prove authorship of every contribution |
| YouTube | `yt-dlp` metadata and subtitle or media routes | Channel pages and available subtitles can be incomplete |
| Instagram and Facebook | Agent Reach plus an authorised signed-in OpenCLI route | Public content can remain login-gated or virtualised |
| X | Agent Reach plus OpenCLI or `twitter-cli` where configured | Pagination and historical access vary by session and platform changes |
| LinkedIn | Agent Reach route or readable-page fallback | Public views are commonly limited and must be labelled partial |
| TikTok | `yt-dlp` metadata and subtitle attempts for supported public profiles, then readable-page or host-browser fallback | Public profile extraction varies and no route is described as exhaustive |
| Other public pages | Readable-page and host-browser fallbacks | Access walls and dynamic pages remain explicit gaps |

Read [platform-routes.md](references/platform-routes.md) for adapter ladders and failure classifications.

## Use it as an AI skill

The canonical method is [SKILL.md](SKILL.md). Do not maintain separate methodology forks for different AI systems.

### Codex

Ask the Codex skill installer to install this GitHub repository, or clone it into your user skills directory as `public-profile-research`. Then invoke:

```text
$public-profile-research
```

Give it one public profile URL and the reason for the research. The skill will run the adaptive intake and use the research tools available in that task.

### ChatGPT

Create a Project, add [PORTABLE_PROMPT.md](PORTABLE_PROMPT.md) and relevant references as files, then paste [PROJECT_INSTRUCTIONS.md](PROJECT_INSTRUCTIONS.md) into Project instructions. Start by giving it one public profile URL.

### Claude

Upload a release ZIP as a custom skill where supported, copy this repository into `.claude/skills/public-profile-research` for Claude Code, or add the portable prompt and references to a Claude Project.

### Gemini

Install the repository as a Gemini CLI Agent Skill, or create a Gem with the project instructions and portable prompt as knowledge.

### Other AI systems

Upload [PORTABLE_PROMPT.md](PORTABLE_PROMPT.md), the intake contract and any collected evidence archive. A system without live web, browser or executable tools can plan or analyse supplied evidence, but it cannot honestly claim to have performed collection.

Current official installation links and capability guidance are in [model-guide.md](references/model-guide.md).

## Research modes

- `insight`: enough independent evidence to answer a bounded question. Sampling is visible.
- `bounded_census`: every item inside explicitly named accounts, source types and dates. This is an advanced contract mode that requires a measurable boundary and hash-referenced denominator-enumeration receipts.
- `maximum_public_coverage`: every declared, legitimately accessible public route is attempted or ends in an evidenced barrier. This is an advanced contract mode with the same denominator-evidence requirement. It is not a claim about the entire internet.

Execution depth is a separate budget. A larger budget does not turn a partial corpus into complete coverage. The current local runner does not create denominator-enumeration receipts, so the ordinary browser enables only `insight`. A CLI intake using either advanced mode will remain partial rather than inventing closure. A future or external integration must produce and attach the required enumeration evidence before either advanced mode can close.

## Report shape

The AI workflow produces an independently branded, Wikipedia-style personal page with evidence-linked subpages where useful:

- research thoroughness and source coverage;
- identity, context and current public activity;
- timeline, career, organisations and projects;
- demonstrated skills and public interests;
- public persona and plausible audience impressions;
- claim-specific credibility;
- material controversies with allegation, finding, response and current status kept separate;
- successes, challenges, failures and changes over time;
- professional collaborators;
- contradictions, gaps and a complete source register.

Public persona means repeated observable public patterns with citations and alternative interpretations. It is not a medical diagnosis or claim about private personality. The project does not produce a global trust, fraud or safety score.

## Image discovery

There is no credible free open-source equivalent to a commercial internet-wide face index. The project supports user-directed self-audit searches through a separate open-source browser extension and local similarity matching inside a lawfully held corpus. Matches remain leads. See [image-discovery.md](references/image-discovery.md).

## Open source and managed service

The complete method remains MIT-licensed. A future managed service can charge for execution budget, media processing, private storage and review, while letting every customer export the same case contract and reproduce the method themselves.

The proposed $0, $20, $80 and $200 tiers are pilot hypotheses, not active checkout products. Their public-source boundaries and evidence standard are identical. See [HOSTED_PRODUCT.md](docs/HOSTED_PRODUCT.md).

## Verification

Run the full automated suite:

```bash
npm test
```

Verify a schema-version-1 directory produced by the local runner:

```bash
node bin/ppr.mjs verify --run /absolute/path/to/public-profile-run
```

This verifies the contained, symlink-free artifact graph, including receipt digests and linkage, evidence and source-item archives, the evidence ledger, report files and run IDs.

The separate legacy case verifier validates a schema-version-2 evidence case contract. It does not verify the schema-version-1 runner directory above:

```bash
node scripts/verify-case.mjs --case /absolute/path/to/case.json
```

The report QA workflow additionally checks a pinned Playwright runtime, self-contained rendering, responsive breakpoint coverage, light and dark themes, charts, overflowing tables, screenshot hashes and a separate manual visual-review receipt. Read [browser-qa.md](references/browser-qa.md).

## Privacy, security and boundaries

Local runs are private and have no project-owned analytics or telemetry. Collected public URLs can be sent to the external service named by an enabled adapter. Reports remain private unless the user separately chooses to publish them.

The workflow excludes precise home locations, non-public contact details, credentials, hidden accounts, biometric identification, diagnoses, minors, private relationship mapping, contacting associates and attempts to recover private content. Read [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md) and [safety-and-inference-policy.md](references/safety-and-inference-policy.md).

## Licence and attribution

Original code and text are MIT-licensed. `playwright-core` is an Apache-2.0 install-time dependency. Agent Reach, `yt-dlp`, GitHub CLI and other collectors remain separately installed tools under their own licences. No third-party `node_modules` or browser binaries are committed.

See [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).
