# Security

## Supported versions

Security fixes apply to the latest tagged release and the current `main` branch.

## Reporting a vulnerability

Do not publish a security issue containing a real person’s report, private source material, credentials or exploit details. Use GitHub’s private vulnerability reporting feature when it is enabled for the repository. Include a minimal synthetic reproduction.

## Threat model

Public-profile research combines untrusted URLs, untrusted page text, local tools and potentially sensitive output. Implementations must defend against:

- server-side request forgery through localhost, private-network, credential-bearing and redirecting URLs;
- command injection by passing subprocess arguments through a shell;
- prompt injection embedded in pages, posts, transcripts, repository files and metadata;
- secrets written into prompts, receipts, URLs, logs or Git history;
- stored cross-site scripting in generated reports;
- path traversal or symlink escape from a case directory;
- identity collisions that merge two people;
- claims that lose their source lineage;
- unrestricted public endpoints being used for bulk person profiling.

The local runner validates declared public targets, uses argument arrays with `shell: false`, stores outputs below the selected run directory and HTML-escapes report content. Source material remains data and is never executed as instructions.

## Hosted deployment requirements

The repository’s static site and local runner do not by themselves provide a production multi-tenant service. Before exposing a hosted collection API, add and verify:

- per-user authentication and tenant isolation;
- strict target, redirect, DNS and response-size controls;
- job, query, media and wall-time budgets;
- rate limits and anti-bulk-person controls;
- encrypted storage, signed report access, deletion and expiry;
- payment-webhook idempotency if billing is enabled;
- abuse reporting and suspension;
- current privacy, platform-terms and defamation review;
- secrets management and environment-specific logs;
- tests proving that one tenant cannot read another tenant’s case.

Do not expose a development research server directly to the public internet.

