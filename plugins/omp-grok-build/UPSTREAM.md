# Provenance

This plugin is third-party, vendored into this repo so deploy can install it on
every host without a standalone checkout.

|             |                                                                                  |
| ----------- | -------------------------------------------------------------------------------- |
| Upstream    | https://github.com/ART1KZ/omp-grok-build                                         |
| Vendored at | commit `32e2ab5` ("@ grok-build: label multi-accounts with email and accountId") |
| License     | MIT (see `LICENSE`)                                                              |

## Local changes on top of upstream

- `src/models.ts` — curated overlay models updated with `grok-4.7` and
  `grok-4.7-build-fast` alongside `grok-4.6` and `grok-4.5`.

## Updating from upstream

Diff this directory against a fresh upstream clone at the commit you want, keep
the local changes listed above, then update the commit reference in this file.
