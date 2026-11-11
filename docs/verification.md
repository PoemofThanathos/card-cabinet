# Verification record

Updated 11 November 2026. Automated tests use generated fixtures, fake credentials, mocks and the local Firestore emulator. Authorized live API checks are recorded separately below.

## Implemented

- Offline collection with a set grid, a card list inside each set, an All cards list and a player grid. Manual entry, edit, physical-copy duplication, archive, recoverable deletion, search and filters remain available.
- Twelve fictional test cards with generated front/back artwork, available from Settings. Adding examples preserves existing records and does not overwrite edited or deleted examples.
- Front/back camera inputs and file-picker fallback, rotation, crop, local JPEG encoding and explicit missing-photo status.
- Local drafts, atomic IndexedDB writes, database migrations and separate saved/synced/photo indicators.
- Versioned ZIP backups, SHA-256 verification, restore, reviewed merge, repeated-import safety and CSV export.
- Firebase email/password integration, a persistent operation queue, revision transactions and conflict/deletion review.
- Owner-only Firestore rules with field validation, revision checks and authenticated, expiring pairing records.
- A protected Worker with Firebase token verification, image/request validation, a server model, a server off switch and SQLite Durable Object limits.
- Bulk entry from photo pairs, pasted manual lists and base-set number ranges. Photo pairing supports alternating front/back files or all fronts followed by all backs, with review, swap and skip controls. There is no photo-count cap. Each card and its import progress save together, so a partial import can resume without repeating completed entries.
- Base-set entry records only ownership confirmed by the user, using a complete set, a list of missing numbers or a list of owned numbers. It does not infer player names, parallels, autographs or memorabilia. Repeating a base-set import skips already recorded base numbers while preserving existing physical copies and variants.
- Explicit single-card identification and confirmed sequential batches, with saved progress and suggestions, pause/resume, cross-tab locking and review before applying fields. Interrupted or failed requests are not retried automatically. A changed card keeps its current values and saved suggestions for review.
- An optional Unlimited attempts setting removes the device and Worker daily/monthly scan-count caps for requests from that device. Usage counting, the identification off switches, one-request concurrency, request replay protection, the 15-second spacing and provider limits still apply. The setting does not guarantee an OpenAI spending limit.
- WebRTC transfer proof of concept with bounded chunks, backpressure, integrity checks and ZIP fallback.
- Project-subpath PWA configuration, install icons, offline shell, deferred updates and a GitHub Pages workflow.
- Simplified UI copy and compact desktop/mobile empty states as requested.

## Automated checks

The 10 November source revision passed **89 unit/integration tests, all 16 browser checks across Chromium and WebKit, and the TypeScript/Vite build**. These formal test counts are unchanged by the 11 November credential setup and live checks. The build and browser tests use the `/card-cabinet/` project subpath. Mobile screenshots were reviewed. Browser tests use isolated local collections and mocked identification results.

The earlier collection-view revision passed 50 unit/integration tests and 8 Chromium/WebKit browser tests. The earlier implementation also passed 5 Firestore emulator tests, a fresh `npm ci` and a Wrangler deployment dry run. Firestore rules and dependencies are unchanged by the credential setup. The Worker is now active, as recorded below.

The checks cover:

| Check                                | Scope                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript and Vite production build | Frontend, Worker and test type checking; generated Pages subpath assets, manifest and service worker                                                                                                                                             |
| Unit and integration tests           | Unicode, physical duplicates, archive/recovery, quotas, migrations, corruption, repeated imports, stale reviews, CSV safety, network/permission errors, conflicts, in-flight edits and lost responses                                            |
| Bulk-entry tests                     | More than 100 photos, natural filename pairing, Unicode lists, base-range ownership, separate variants, partial-import recovery, missing source files and concurrent changes                                                                     |
| Batch-identification tests           | More than 100 sequential mock scans, count caps and Unlimited attempts, spacing, pause/resume, interrupted requests, failed result storage, cross-tab locking and stale-review protection                                                        |
| Worker tests                         | Signed JWTs and invalid claims/signatures, request schemas, image boundaries, EXIF rejection, origin/auth/off-switch behavior, capped/unlimited counters, persisted replay protection, concurrency, storage failure and mocked structured output |
| Transfer tests                       | Owner-scoped expiring pairing, 16 KiB chunks, hash verification, corruption/truncation rejection and timeout cleanup, with mocked signaling and peer objects                                                                                     |
| Firestore emulator                   | Owner isolation, malformed records, forbidden image payloads, revision rules, tombstones, Unicode, one-answer pairing and expiry                                                                                                                 |
| Chromium browser tests               | Manual card lifecycle, photo editing, draft restore, ZIP download/import, persistent settings, project manifest, responsive layout, offline reopen/edit, bulk entry, photo pairing and saved batch review                                        |
| WebKit browser tests                 | The same UI, bulk-entry and review flows at an iPhone viewport, excluding the Chromium service-worker offline-reopen check                                                                                                                       |
| Wrangler dry run                     | Worker bundles with the configured SQLite Durable Object binding; no deployment occurs                                                                                                                                                           |

Browser tests exposed a Windows WebKit Blob-to-IndexedDB failure. Photo storage now uses image bytes, with a migration for existing Blob rows. They also exposed a draft-close race; the editor now waits for the draft write before closing. A local preview base-path mismatch was corrected in the test runner. The production workflow already supplies the Pages base path.

## Published app

GitHub Pages is enabled with GitHub Actions as its source. Pushes to `main` install dependencies, run the unit tests, build the app and deploy it. The [deployment history](https://github.com/PoemofThanathos/card-cabinet/actions/workflows/pages.yml) records each release. The live app is at [poemofthanathos.github.io/card-cabinet](https://poemofthanathos.github.io/card-cabinet/).

The repository's [CC BY-NC-ND 4.0 license](../LICENSE) has been published. Third-party dependencies retain their own licenses.

The live app was opened in Brave. Adding test cards created 12 cards with 24 images in six sets. The set detail list, All cards list and Players grid worked, and the cards remained after reload. The app displayed its offline-ready message. This live check did not disable the browser's network; offline reopening was covered by the earlier Chromium production-build tests.

## Firebase setup

Firebase is configured on the no-cost Spark plan for project `card-cabinet-a1d92`. The web app, personal email/password account, authorized GitHub Pages domain, Firestore Standard database in São Paulo and card-field index exemption were created. Owner-only rules were published after all five Firestore emulator tests passed against the configured rules. The tests now read the configured UID and exercise the actual rules without replacing their access condition. An unauthenticated read of the live database returned HTTP 403.

The GitHub Actions variables include the public Firebase configuration and owner UID.

On 10 November 2026, the owner signed in to the published app and confirmed linking the local collection. Sync now completed successfully against Firestore. All 12 fictional cards showed Synced, and the pending metadata count fell from 12 to zero. After a page reload, the collection still contained 12 cards and 24 local photos, with zero pending metadata changes. Photos were not uploaded.

## Worker deployment

On 11 November 2026, a key for the Card Storage OpenAI project was created through encrypted connector delivery. The authorized local copy is in the ignored `worker/.dev.vars` file; the deployed copy is a Worker secret. The key is excluded from frontend code, GitHub, backups and screenshots. An authenticated Responses API request asking `gpt-6-luna` for a haiku succeeded. This confirms API access, not the remaining account balance.

The Worker is active on Workers Free at [card-cabinet-identify.rousilon666.workers.dev](https://card-cabinet-identify.rousilon666.workers.dev), with `AI_ENABLED=true`. The deployed version is `96c69f33-44c0-4b55-beb2-36fad3c5db8e`.

Live HTTP checks returned:

| Request                                               | Observed response                              |
| ----------------------------------------------------- | ---------------------------------------------- |
| Allowed-origin `OPTIONS /identify`                    | HTTP 204 with the configured CORS origin       |
| Allowed-origin `POST /identify` without authorization | HTTP 401, authentication required              |
| Wrong-origin request                                  | HTTP 403 without an allowed-origin CORS header |
| `GET /identify`                                       | HTTP 405                                       |
| Unknown path                                          | HTTP 404                                       |

These checks verify routing, CORS and rejection of unauthenticated requests on the active Worker.

The signed-in owner then scanned one generated Shohei Ohtani test card through the published app in Brave, sending its front and back together. The queue finished with 1 of 1 processed and zero failures. The device attempt count increased from zero to one. The saved review remained available after closing and reopening it.

Suggestions included the English and Japanese names, `大谷翔平`, BBM, 2024 and `TEST-001`, with evidence from both sides. The model recognized the back's printed warning that this was a fictional test card and left the unknown team blank. Every suggestion checkbox remained unselected, and no suggested fields were applied. A separate test copy and its saved review were retained. Existing records were unchanged, and this check did not run metadata sync.

This one generated fixture exercised Firebase authentication, Worker image validation, Durable Object accounting, the live OpenAI response and saved review. It does not establish accuracy on real cards, performance on large camera photos or sustained batch reliability.

## Not verified by these checks

Live sync between two physical devices and account-specific quota behavior remain unverified.

API access and one generated-card scan are verified. Real-card identification accuracy, account-specific quota behavior and Workers Free CPU headroom for large photos remain unverified. A successful request does not establish a remaining credit balance or reliable operation at higher volume.

No physical iPhone was available. Camera permissions, HEIC decoding, EXIF orientation on actual camera files, Home Screen installation, offline reopening, updates, Files export and phone memory limits remain on the [manual checklist](device-checklist.md). Playwright WebKit is not an iPhone test.

Direct peer connectivity between an iPhone and Windows is unverified. The protocol is tested with mocks. Same Wi-Fi is not a guarantee, and this proof of concept has no STUN or TURN relay. The file package is the supported transfer method.

The app has no global card-count limit or photo-count cap for bulk entry. It does load metadata and import plans into memory, reads all cloud metadata during a manual sync and builds ZIPs in memory. Very large collections and imports need performance and quota measurement. The 200 MB package ceiling is an upper bound, not a promise that every phone can handle that package size. Saved batch scans require the app to remain open; background execution and physical-device interruption behavior are unverified.

## Dependency audit

The last runtime dependency audit reported no known vulnerabilities. Dependencies have not changed in this revision. The full development-tool audit retained a low-severity `deepmerge` prototype-poisoning advisory inherited by Workbox's build tools. At the time of the check, the latest `deepmerge` version was still affected; npm suggested downgrading the PWA plugin to an obsolete version. This project keeps the maintained plugin and documents the build-only advisory. It does not merge untrusted user objects through that build tool. This is not a claim that dependencies can never contain vulnerabilities.

Patched transitive versions of gRPC, OpenTelemetry core, glob, minimatch and uuid are pinned through npm overrides. They were tested with the resulting lockfile. Re-run the build and tests after future dependency changes. Do not apply `npm audit fix --force` without reviewing its proposed versions.
