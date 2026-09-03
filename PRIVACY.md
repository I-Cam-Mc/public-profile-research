# Privacy

## Local open-source use

The local runner stores intake, receipts, source extracts and reports in the output directory chosen by the user. It has no project-owned analytics or telemetry. The user controls deletion of those local files.

The runner can send a declared public URL to external services when an enabled adapter requires it, including GitHub’s API or hosted Jina Reader. Agent Reach is the primary broad-social discovery route. When it uses hosted Exa through `mcporter`, the person’s public display name and handles are sent as a search query. Exa results remain unverified leads until checked against the underlying source. Disable discovery if that disclosure is inappropriate. GitHub, Jina Reader and supported `yt-dlp` routes may still be used separately for their respective source families. These external routes can impose quotas, rate limits or changed terms even when they are currently documented as free. The intake’s `free_tools_only` policy forbids knowingly invoking a paid-key route.

Signed-in OpenCLI routes can read material visible through an existing browser session for a supported platform. The runner does not copy browser cookies into the report, but the external tool and platform still process the request under their own terms. The X command-line route can use authentication values supplied through the environment; those values are never placed in subprocess arguments and credential-shaped diagnostics are redacted before persistence.

## Static website and local app

The GitHub Pages site is static. It processes intake form content in the browser and does not put a person’s name or profile URL into the page URL. It does not perform collection, store a research case or receive platform credentials. Exported intake files and prompts remain on the user’s device unless the user submits them to another service.

The local app runs on the user’s computer and may submit a declared target to enabled external adapters as described above. Agent Reach currently documents its Exa MCP route as free and requiring no API key, but external quotas and terms can change. The product does not knowingly invoke paid-key routes under `free_tools_only`. It binds locally by default. Do not expose it to a network without a separate deployment and security review.

## Reports

Reports are private by default. The software does not make a public source free of privacy, copyright or platform obligations. Do not publish a generated profile without a separate review and explicit authority.

## Future hosted service

A hosted research service would process profile URLs, public source material, prompts, receipts and generated reports. It requires a service-specific privacy notice, retention schedule, deletion process, subprocessors list, security controls and lawful basis before launch. The open-source repository does not claim those controls are already operating.
