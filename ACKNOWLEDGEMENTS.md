# Acknowledgements

Public Profile Research is an original project. It is not a fork, and no upstream project is the substantive base of its code or text.

Checked 3 September 2026. Version numbers are observations, not automatic update promises.

## Optional external open-source tools, not bundled

The runner may invoke separately installed tools. Their licences do not become the licence for this repository, and users remain responsible for installing and operating them lawfully.

| Project | Use | Licence |
|---|---|---|
| [Agent Reach](https://github.com/Panniantong/Agent-Reach) | Essential broad-social capability preflight, discovery and routing to supported public-platform tools | MIT, version 1.5.0 checked |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Public video metadata, subtitles and authorised media retrieval | Unlicense, local version 2026.07.04 checked |
| [GitHub CLI](https://github.com/cli/cli) | Public repository and API access | MIT, local version 2.98.0 checked |
| [Jina Reader OSS](https://github.com/jina-ai/reader) | Optional self-hosted readable-page extraction | Apache-2.0 |
| [SearXNG](https://github.com/searxng/searxng) | Optional self-hosted metasearch | AGPL-3.0-or-later |
| [gallery-dl](https://github.com/mikf/gallery-dl) | Optional platform media collector | GPL-2.0-only |
| [Instaloader](https://github.com/instaloader/instaloader) | Optional Instagram collector | MIT |
| [Sherlock](https://github.com/sherlock-project/sherlock) | Optional username lead discovery | MIT |
| [Maigret](https://github.com/soxoj/maigret) | Optional username lead discovery | MIT |

GPL and AGPL tools remain separate executables or services. Their code is not vendored or linked into this MIT package.

Agent Reach selects separately installed upstream routes. This runner can call `opencli` for supported signed-in social pages, `twitter` for X, and `mcporter` for Exa and LinkedIn. These executables are not bundled. Their availability, licences and service terms must be checked in the environment where they are installed. GitHub, Jina Reader and `yt-dlp` remain separate source-family routes and can be useful without Agent Reach when the declared scope does not require broad-social discovery.

## Optional image-discovery and corpus-matching tools

| Project | Appropriate use | Licence |
|---|---|---|
| [Search by Image](https://github.com/dessant/search-by-image) | User-directed browser searches, especially self-audit | GPL-3.0 |
| [imagededup](https://github.com/idealo/imagededup) | Exact and near-duplicate matching inside a lawfully held image corpus | Apache-2.0 |
| [clip-retrieval](https://github.com/rom1504/clip-retrieval) | Search over a locally built image index | MIT |

No maintained open-source project supplies a general internet-scale face index comparable to proprietary face-search products. Local similarity output is a lead, not identity proof. Model weights and hosted indexes can have terms separate from their wrapper code.

## Hosted or proprietary services

The following are services, not open-source dependencies:

- [GitHub API](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#h-api-terms) and [GitHub Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies).
- Hosted [Jina Reader](https://jina.ai/reader/) under [Jina service terms](https://jina.ai/legal/).
- Hosted [Exa search](https://exa.ai/) under [Exa terms](https://exa.ai/assets/Exa_Labs_Terms_of_Service.pdf/) and [privacy policy](https://exa.ai/privacy-policy). Public names and handles are included in discovery queries when this route is enabled.
- [Internet Archive](https://archive.org/about/terms.php). Its currently served terms materially limit personal-data collection, so automated person research through Wayback is not a default route.
- Google Lens and [TinEye](https://services.tineye.com/TinEyeAPI), which are proprietary services.
- [PimEyes](https://pimeyes.com/en/terms-of-service), which is proprietary and frames searches around the user’s own face. It is not used for third-party checks.

Service availability and a software licence do not grant permission to scrape, republish source media or process personal information contrary to applicable terms or law.

## Method and design inspiration

The project benefited from the capability-routing idea demonstrated by Agent Reach, OpenAI’s public Agent Skills format and general interface-design guidance. The research process also evaluated [ScrapeCreators’ social-media research skills](https://github.com/ScrapeCreators/social-media-research-skills) for workflow ideas around transcripts, comments and public social evidence, and [useOSINT skills](https://github.com/useosint/skills) for source-discovery and corroboration patterns. Neither project is bundled, and no code or protected text from them was copied. ScrapeCreators requires its own API credentials and can have usage charges, so it is not a default `free_tools_only` collector.

“Wikipedia-style” describes the useful information architecture of an encyclopaedic personal page. The project uses original branding and layout and is not affiliated with Wikimedia.
