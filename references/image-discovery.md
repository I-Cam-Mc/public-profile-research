# Image discovery and matching

Image work is optional and lead-only. It must not be the sole basis for identity confirmation.

## Self-audit web discovery

For a person checking their own public footprint, the open-source [Search by Image](https://github.com/dessant/search-by-image) browser extension can dispatch a selected image to supported search engines. The extension is GPL-3.0 and remains a separate user-installed tool. Each search engine has its own terms.

Google Lens and TinEye can be useful manual services. They are proprietary. PimEyes is not a default route because its terms frame searches around the user’s own face and it is unsuitable for third-party dating or marketplace checks.

## Local-corpus matching

For images the user lawfully holds:

- [imagededup](https://github.com/idealo/imagededup) can cluster exact and near-duplicate files.
- [clip-retrieval](https://github.com/rom1504/clip-retrieval) can search a locally built image index by text or image similarity.

Record the tool and version, input hashes, model or algorithm, threshold, candidate results and manual review. A similarity match is a lead. Confirm identity using independent non-biometric evidence.

The scarce capability in an internet-wide reverse-face search is the image index, not only the matching code. This project does not claim to supply a free open-source equivalent to a commercial web-scale face index.
