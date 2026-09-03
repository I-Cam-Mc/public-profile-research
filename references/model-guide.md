# AI platform and model guide

Checked 3 September 2026. Platform interfaces and model names change, so verify current documentation when installing.

## Choose by capability

| Result | Recommended capability | Context and tools |
|---|---|---|
| Quick insight | Current balanced model with live web access at default or medium reasoning | Fresh task, one intake file, direct web search and URL reading |
| Standard profile | Current strong reasoning model at medium or high reasoning | Dedicated project, external evidence ledger, file and image handling, code execution where available |
| Deep corpus | Current top research or agentic model at high reasoning, only when measured value justifies it | Separate collection, synthesis and independent review passes, browser and media tools, deterministic verification |

A large context window does not prove coverage. Store evidence in ledgers and manifests, then load the active source family.

## OpenAI

- Codex: install the repository as a skill, then invoke `$public-profile-research`.
- ChatGPT: create a Project, upload `PORTABLE_PROMPT.md` and the relevant references, then paste `PROJECT_INSTRUCTIONS.md` into Project instructions.
- ChatGPT Deep Research is useful for multi-step discovery and cited synthesis when available. Review its proposed plan and chosen sources before collection.

Official references: [Codex skills](https://developers.openai.com/codex/skills/), [ChatGPT Projects](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt/), [Deep Research](https://help.openai.com/en/articles/10500283-deep-research).

## Claude

- Claude.ai: upload a release ZIP as a custom skill where code execution is enabled, or add `PORTABLE_PROMPT.md` and references to a Claude Project.
- Claude Code: copy the canonical skill into `.claude/skills/public-profile-research`, or use a thin generated plugin wrapper. Keep the method in one canonical `SKILL.md`.
- Claude Research can perform extended web collection where the account supports it.

Official references: [Claude skills](https://support.claude.com/en/articles/12512180-use-skills-in-claude), [Claude Projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects), [Claude Code skills](https://code.claude.com/docs/en/slash-commands), [Claude Research](https://support.claude.com/en/articles/11088861-use-research-on-claude).

## Gemini

- Gemini Apps: create a Gem, paste `PROJECT_INSTRUCTIONS.md`, and attach the portable prompt and references as knowledge files.
- Gemini CLI: install the GitHub repository as an Agent Skill. Gemini CLI recognises `.gemini/skills` and the shared `.agents/skills` convention.
- Gemini Deep Research can be used for the collection and synthesis pass where available.

Official references: [Gemini Gems](https://support.google.com/gemini/answer/15235603), [Gemini CLI skills](https://geminicli.com/docs/cli/using-agent-skills/), [creating Gemini CLI skills](https://geminicli.com/docs/cli/creating-skills/), [Gemini Deep Research](https://support.google.com/gemini/answer/15719111).

## Other AI systems

Upload `PORTABLE_PROMPT.md`, the intake contract and the collected evidence archive. If the system cannot fetch URLs or run collectors, it can plan or synthesise supplied evidence only. Mark `verification_mode` as `manual` or `unavailable`, not executable.

