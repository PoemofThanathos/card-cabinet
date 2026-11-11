# Verification record

Updated 11 November 2026. Automated tests use generated fixtures, fake credentials, mocks and the local Firestore emulator. Authorized live API checks are recorded separately below.

## Implemented

- Offline collection with a set grid, a card list inside each set, an All cards list and a player grid. Manual entry, edit, physical-copy duplication, archive, recoverable deletion, search and filters remain available.
- Recently deleted includes Empty bin and individual Delete permanently controls, with confirmation, snapshot checks, shared-photo retention and terminal sync records. Purged cards leave exports and cannot be restored by stale edits, import plans or AI results. An old backup offers an explicit new copy instead.
- Twelve fictional test cards with generated front/back artwork, available from Settings. Adding examples preserves existing records and does not overwrite edited or deleted examples. Remove test cards moves originals and marked copies to Recently deleted while retaining their photos and sync history.
- Front/back camera inputs and file-picker fallback, rotation, crop, local JPEG encoding and explicit missing-photo status.
- A local HEIC/HEIF fallback decoder, loaded when native decoding fails, with serialized conversion and bounded preview caching. Decode errors replace the loading placeholder without hiding a readable second photo.
- Local drafts, atomic IndexedDB writes, database migrations and separate saved/synced/photo indicators.
- Versioned ZIP backups, SHA-256 verification, restore, reviewed merge, repeated-import safety and CSV export.
- Firebase email/password integration, a persistent operation queue, revision transactions and conflict/deletion review.
- Owner-only Firestore rules with field validation, revision checks and authenticated, expiring pairing records.
- A protected Worker with Firebase token verification, image/request validation, allowed model choices, a server off switch and SQLite Durable Object limits.
- Bulk entry from photo pairs, pasted manual lists and base-set number ranges. Photo pairing supports alternating front/back files or all fronts followed by all backs, with review, swap and skip controls. There is no photo-count cap. Each card and its import progress save together, so a partial import can resume without repeating completed entries.
- Optional AI photo matching analyzes independent photos in requests of up to two, then proposes unique matches across the full selection. Unknown sides, duplicate identities and conflicting details remain unmatched. Reviewed swaps and manual pairs persist. Accepted pairs accumulate in the import, and unmatched photos retain their saved analysis. Saving reviewed pairs opens the ordinary identification confirmation.
- Base-set entry records only ownership confirmed by the user, using a complete set, a list of missing numbers or a list of owned numbers. It does not infer player names, parallels, autographs or memorabilia. Repeating a base-set import skips already recorded base numbers while preserving existing physical copies and variants.
- Explicit single-card identification and confirmed batches at Normal, Fast or Ultra fast speed, with saved progress and suggestions, pause/resume, cross-tab locking and review before applying fields. Interrupted or failed requests are not retried automatically. A changed card keeps its current values and saved suggestions for review.
- Settings offer GPT-6 Luna, GPT-6.1 Terra, GPT-6.1 Sol and GPT-6 Astra, each with Low, Medium and High reasoning. Choices persist locally and appear before sending. Batches and saved reviews retain their selected options; legacy batches use Luna Low.
- An optional Unlimited attempts setting removes the device and Worker daily/monthly scan-count caps for requests from that device. Usage counting, the identification off switches, the selected concurrency limit, request replay protection and provider limits still apply. Normal also keeps 15-second spacing. The setting does not guarantee an OpenAI spending limit.
- WebRTC transfer proof of concept with bounded chunks, backpressure, integrity checks and ZIP fallback.
- Project-subpath PWA configuration, install icons, offline shell, deferred updates and a GitHub Pages workflow.
- Simplified UI copy and compact desktop/mobile empty states as requested.

## Automated checks

The 11 November speed and review-import revision passed 270 unit/integration tests and the TypeScript/Vite production build. All 41 supported browser cases passed across Chromium and WebKit after fixing the speed selector label and a test that reloaded before an import finished. The existing Windows WebKit offline-decoder case remains skipped. Tests cover 1/2/4 concurrent requests, independent lease cleanup, mixed-speed reservations, pause/failure recovery, local photo memory limits, grouped base-set saves and unapproved review imports. Mobile speed and review screenshots were inspected.

The Worker was deployed with the speed controls and stricter pair-checking prompt. The private photo exercise uses GPT-6 Luna subagents as requested. It does not measure production API latency or establish model accuracy against a labelled card dataset. Private images and results are kept outside the public repository.

The 11 November Empty bin revision passed **223 unit/integration tests, 37 browser checks across Chromium and WebKit, 7 Firestore emulator tests, and the TypeScript/Vite build**. The existing Windows WebKit offline-decoder check remains intentionally skipped. The browser run caught bulk-import transaction scope and confirmation-focus regressions, which were fixed. A test fixture also raced database initialization; after fixing its readiness check, all 14 batch/bin browser cases passed. Desktop and iPhone-size bin screenshots were reviewed.

Deletion tests cover cancellation, individual removal, filtered bins, cards restored after confirmation opens, new deletions outside the confirmed selection, shared photos, atomic rollback, queued offline deletion, stale devices, in-flight sync, incomplete cloud pulls, drafts open in another tab, backup import/export, bulk imports, AI reviews and transfers. Permanent deletion was tested only in isolated local collections, mocked cloud stores and the emulator. No live user cards were purged.

The 11 November photo-matching revision passed **191 unit/integration tests, 29 browser checks across Chromium and WebKit, and the TypeScript/Vite build**. One WebKit offline-decoder check is intentionally skipped because the Windows test runtime does not support that service-worker scenario. Chromium covers offline first-use HEIC conversion. The build and browser tests use the `/card-cabinet/` project subpath. Mobile screenshots were reviewed. Browser tests use isolated local collections and mocked identification results. All twelve model/reasoning combinations are covered by mocked Worker requests. Persistence, request snapshots, legacy batches, invalid options and interruption timing are also covered.

Photo-matching checks cover shuffled inputs, opposite sides in different requests, duplicate copies, conflicting identities, 103 files, interrupted requests, failed storage, saved manual pair edits, and atomic acceptance without losing previously accepted or unmatched photos. Browser checks exercise the review-to-save-to-identification flow and recoverable test-card removal. A small HEIC fixture from libheif's test suite covers native/fallback import, rotation, crop, JPEG output without EXIF, and recovery from a corrupt file. This does not establish support for every iPhone HEIC variant or performance with 462 full-size photos.

The earlier collection-view revision passed 50 unit/integration tests and 8 Chromium/WebKit browser tests. The earlier implementation also passed 5 Firestore emulator tests, a fresh `npm ci` and a Wrangler deployment dry run. Firestore rules and dependencies are unchanged by the credential setup. The Worker is now active, as recorded below.

The checks cover:

| Check                                | Scope                                                                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TypeScript and Vite production build | Frontend, Worker and test type checking; generated Pages subpath assets, manifest and service worker                                                                                                                                             |
| Unit and integration tests           | Unicode, physical duplicates, archive/recovery, quotas, migrations, corruption, repeated imports, stale reviews, CSV safety, network/permission errors, conflicts, in-flight edits and lost responses                                            |
| Bulk-entry tests                     | More than 100 photos, natural filename pairing, Unicode lists, base-range ownership, separate variants, partial-import recovery, missing source files and concurrent changes                                                                     |
| Batch-identification tests           | More than 100 mock scans, 1/2/4 concurrent requests, out-of-order results, count caps, spacing, pause/resume, interrupted requests, failed storage, cross-tab locking and stale-review protection                                                |
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

On 11 November 2026, the terminal-purge rules were published through the signed-in Firebase console after all seven emulator tests passed. Purged records must contain blank fields and no photo references, and cannot change back to an active, archived or recoverable deleted card. Owner access remains unchanged.

On 10 November 2026, the owner signed in to the published app and confirmed linking the local collection. Sync now completed successfully against Firestore. All 12 fictional cards showed Synced, and the pending metadata count fell from 12 to zero. After a page reload, the collection still contained 12 cards and 24 local photos, with zero pending metadata changes. Photos were not uploaded.

## Worker deployment

On 11 November 2026, a key for the Card Storage OpenAI project was created through encrypted connector delivery. The authorized local copy is in the ignored `worker/.dev.vars` file; the deployed copy is a Worker secret. The key is excluded from frontend code, GitHub, backups and screenshots. An authenticated Responses API request asking `gpt-6-luna` for a haiku succeeded. This confirms API access, not the remaining account balance.

The Worker is active on Workers Free at [card-cabinet-identify.rousilon666.workers.dev](https://card-cabinet-identify.rousilon666.workers.dev), with `AI_ENABLED=true`. The photo-matching version is `7152500d-8204-429a-b25a-86cffdbb47bd`.

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

The model-selector release also completed one live Astra/High scan of the generated card. For the photo-matching release, the production Worker request function sent two newly generated front/back fixtures directly to OpenAI using Luna/Low. It returned two valid ordered entries with the correct sides and shared name, maker, set, year and card number. That check validates the new live response schema and prompt, not a full user-photo import through the deployed Worker. No real collection photos were sent during this release's verification.

## Not verified by these checks

Live sync between two physical devices and account-specific quota behavior remain unverified.

API access and one generated-card scan are verified. Real-card identification accuracy, account-specific quota behavior and Workers Free CPU headroom for large photos remain unverified. A successful request does not establish a remaining credit balance or reliable operation at higher volume.

No physical iPhone was available. Camera permissions, HEIC decoding, EXIF orientation on actual camera files, Home Screen installation, offline reopening, updates, Files export and phone memory limits remain on the [manual checklist](device-checklist.md). Playwright WebKit is not an iPhone test.

Direct peer connectivity between an iPhone and Windows is unverified. The protocol is tested with mocks. Same Wi-Fi is not a guarantee, and this proof of concept has no STUN or TURN relay. The file package is the supported transfer method.

The app has no global card-count limit or photo-count cap for bulk entry. It does load metadata and import plans into memory, reads all cloud metadata during a manual sync and builds ZIPs in memory. Very large collections and imports need performance and quota measurement. The 200 MB package ceiling is an upper bound, not a promise that every phone can handle that package size. Saved batch scans require the app to remain open; background execution and physical-device interruption behavior are unverified.

## Dependency audit

The runtime dependency audit after adding `libheif-js` 1.23.5 reported no known vulnerabilities. The HEIC decoder retains its LGPL license as a separate replaceable asset with [notices and source links](../public/third-party/README.txt). The previous full development-tool audit retained a low-severity `deepmerge` prototype-poisoning advisory inherited by Workbox's build tools. At the time of that check, the latest `deepmerge` version was still affected; npm suggested downgrading the PWA plugin to an obsolete version. This project keeps the maintained plugin and documents the build-only advisory. It does not merge untrusted user objects through that build tool. This is not a claim that dependencies can never contain vulnerabilities.

Patched transitive versions of gRPC, OpenTelemetry core, glob, minimatch and uuid are pinned through npm overrides. They were tested with the resulting lockfile. Re-run the build and tests after future dependency changes. Do not apply `npm audit fix --force` without reviewing its proposed versions.
