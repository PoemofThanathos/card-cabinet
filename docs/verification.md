# Verification record

Updated 10 November 2026. Tests use generated fixtures, fake credentials, mocks and the local Firestore emulator. No real card photos or paid OpenAI calls were used.

## Implemented

- Offline collection with a set grid, a card list inside each set, an All cards list and a player grid. Manual entry, edit, physical-copy duplication, archive, recoverable deletion, search and filters remain available.
- Twelve fictional test cards with generated front/back artwork. Adding examples preserves existing records and does not overwrite edited or deleted examples.
- Front/back camera inputs and file-picker fallback, rotation, crop, local JPEG encoding and explicit missing-photo status.
- Local drafts, atomic IndexedDB writes, database migrations and separate saved/synced/photo indicators.
- Versioned ZIP backups, SHA-256 verification, restore, reviewed merge, repeated-import safety and CSV export.
- Firebase email/password integration, a persistent operation queue, revision transactions and conflict/deletion review.
- Owner-only Firestore rules with field validation, revision checks and authenticated, expiring pairing records.
- A protected Worker with Firebase token verification, image/request validation, a server model, a server off switch and SQLite Durable Object limits.
- Explicit single-card identification and confirmed batches of up to three cards, with review before applying fields and confirmation before replacing existing text.
- WebRTC transfer proof of concept with bounded chunks, backpressure, integrity checks and ZIP fallback.
- Project-subpath PWA configuration, install icons, offline shell, deferred updates and a GitHub Pages workflow.
- Simplified UI copy and compact desktop/mobile empty states as requested.

## Automated checks

The collection-view revision passed **50 unit/integration tests and 8 browser tests** across Chromium and WebKit, plus the TypeScript/Vite production build. These cover grouping, sample-data persistence, repeated sample insertion, all three views, photo/backup flows and responsive layouts. The build and browser tests used the `/card-cabinet/` project subpath.

The earlier implementation also passed 5 Firestore emulator tests, a fresh `npm ci` and a Wrangler deployment dry run. Cloud rules, Worker code and dependencies were unchanged by the collection-view revision.

The checks cover:

| Check                                | Scope                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript and Vite production build | Frontend, Worker and test type checking; generated Pages subpath assets, manifest and service worker                                                                                                         |
| Unit and integration tests           | Unicode, physical duplicates, archive/recovery, quotas, migrations, corruption, repeated imports, stale reviews, CSV safety, network/permission errors, conflicts, in-flight edits and lost responses        |
| Worker tests                         | Signed JWTs and invalid claims/signatures, request schemas, image boundaries, EXIF rejection, origin/auth/off-switch behavior, persisted counters, concurrency, storage failure and mocked structured output |
| Transfer tests                       | Owner-scoped expiring pairing, 16 KiB chunks, hash verification, corruption/truncation rejection and timeout cleanup, with mocked signaling and peer objects                                                 |
| Firestore emulator                   | Owner isolation, malformed records, forbidden image payloads, revision rules, tombstones, Unicode, one-answer pairing and expiry                                                                             |
| Chromium browser tests               | Manual card lifecycle, photo editing, draft restore, ZIP download/import, persistent settings, project manifest, responsive layout and offline reopen/edit                                                   |
| WebKit browser tests                 | The same UI and photo/backup flow at an iPhone viewport, excluding the Chromium service-worker offline-reopen check                                                                                          |
| Wrangler dry run                     | Worker bundles with the configured SQLite Durable Object binding; no deployment occurs                                                                                                                       |

Browser tests exposed a Windows WebKit Blob-to-IndexedDB failure. Photo storage now uses image bytes, with a migration for existing Blob rows. They also exposed a draft-close race; the editor now waits for the draft write before closing. A local preview base-path mismatch was corrected in the test runner. The production workflow already supplies the Pages base path.

## Published app

GitHub Pages is enabled with GitHub Actions as its source. The [deployment](https://github.com/PoemofThanathos/card-cabinet/actions/runs/42802588916) passed dependency installation, all 50 unit/integration tests, the production build and deployment. The live app is at [poemofthanathos.github.io/card-cabinet](https://poemofthanathos.github.io/card-cabinet/).

The live app was opened in Brave. Adding test cards created 12 cards with 24 images in six sets. The set detail list, All cards list and Players grid worked, and the cards remained after reload. The app displayed its offline-ready message. This live check did not disable the browser's network; offline reopening was covered by the earlier Chromium production-build tests.

## Not verified by these checks

No live Firebase account was configured, no Worker was deployed, and no real OpenAI identification was requested. Account-specific service access, billing setup, quota behavior and Worker CPU headroom still need the owner's setup and approval. The Worker dry run and mocked calls cannot establish production behavior.

No physical iPhone was available. Camera permissions, HEIC decoding, EXIF orientation on actual camera files, Home Screen installation, offline reopening, updates, Files export and phone memory limits remain on the [manual checklist](device-checklist.md). Playwright WebKit is not an iPhone test.

Direct peer connectivity between an iPhone and Windows is unverified. The protocol is tested with mocks. Same Wi-Fi is not a guarantee, and this proof of concept has no STUN or TURN relay. The file package is the supported transfer method.

The app has no global card-count limit. It does load metadata into memory for local filtering, reads all cloud metadata during a manual sync and builds ZIPs in memory. Very large collections need performance and quota measurement. The 200 MB package ceiling is an upper bound, not a promise that every phone can handle that package size.

## Dependency audit

The runtime dependency audit reports no known vulnerabilities at delivery. The full development-tool audit retains a low-severity `deepmerge` prototype-poisoning advisory inherited by Workbox's build tools. At the time of the check, the latest `deepmerge` version was still affected; npm suggested downgrading the PWA plugin to an obsolete version. This project keeps the maintained plugin and documents the build-only advisory. It does not merge untrusted user objects through that build tool. This is not a claim that dependencies can never contain vulnerabilities.

Patched transitive versions of gRPC, OpenTelemetry core, glob, minimatch and uuid are pinned through npm overrides. They were tested with the resulting lockfile. Re-run the build and tests after future dependency changes. Do not apply `npm audit fix --force` without reviewing its proposed versions.
