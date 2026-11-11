# Card Cabinet

[Open Card Cabinet](https://poemofthanathos.github.io/card-cabinet/). Choose **Settings > Add test cards** to try the app with 12 fictional cards. Each browser keeps its own collection.

A personal card collection app for iPhone Safari and Windows Edge or Chrome. Manual entry, photos, editing, search and backups work without an account. Firebase metadata sync and OpenAI identification are optional.

The app has no card-count limit or subscription. Device storage and service quotas still apply. Firebase and the identification Worker are configured for the owner's account. A live scan of one generated front/back test card reached the review screen on 11 November 2026. Automated tests use mocks; live identification uses the owner's API balance.

## License

Copyright 2026 PoemofThanathos. The original Card Cabinet code, documentation and generated artwork are licensed under [Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International](LICENSE), or CC BY-NC-ND 4.0. It allows noncommercial sharing with attribution and private adaptations, but does not permit sharing adapted material. The [full legal code](https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.en) controls these permissions and includes the warranty disclaimer.

Third-party libraries retain their own licenses. This project's license does not restrict rights granted by those libraries' licenses.

Public GitHub repositories remain subject to [GitHub's platform permissions to view and fork them](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository). CC BY-NC-ND 4.0 does not disable the Fork button or override those platform permissions.

## Start locally on Windows

1. Install Node.js 24 LTS from [nodejs.org](https://nodejs.org/).
2. Extract the project ZIP to a folder you can find again.
3. Open that folder in a terminal. In File Explorer, right-click inside the folder and choose Open in Terminal.
4. Run the commands below, one at a time.

```powershell
npm ci
npm run dev
```

Open the local URL printed in the terminal. Keep the terminal open while using the app. Press Ctrl+C to stop it. If PowerShell blocks `npm.ps1`, use `npm.cmd` instead of `npm`; you do not need to weaken your script-execution policy.

This starts development mode. To test installation and offline use, use a production build:

```powershell
npm run build
npm run preview
```

Open the printed address once while online and wait for the offline-ready message. Then try reopening with the browser's network disabled. Do not double-click `dist/index.html`; service workers need HTTP on localhost or HTTPS on a published site.

No Firebase configuration is needed for local use. `npm ci` downloads dependencies, so the first setup requires internet access.

## Using the collection

- Collection shows a grid of sets. Open a set to see its cards in a list. Sets with different years, makers or products stay separate. Cards without a set appear under No set.
- All cards lists every active card across sets. Players groups cards by player or character name; open a player to see their cards across sets. Archive and Recently deleted remain separate views.
- Settings > Add test cards creates 12 fictional cards in six sets, with front/back artwork and six players or characters. The cards are marked Test card and tagged `test-card`. They are saved locally and use the normal backup and metadata-sync flow. Adding them again never replaces edits or restores deleted examples. You can edit, archive or delete them like any card.
- Add a card, import or capture each side, adjust rotation and crop, then choose Use photo. Save card commits the record to your collection. A local draft keeps unfinished edits across reloads.
- Every physical copy has its own ID. Duplicate physical copy creates another ID and initially shares the same local photos. Retake them if the second copy differs. Nothing automatically merges matching cards.
- Search includes Japanese text, notes and full-width numbers. Category, maker, year and missing-photo filters work in grid and list views.
- Category and product accept your own text. Suggested products distinguish baseball cards, Hololive Official Card Game, Weiss Schwarz and other products.
- All catalogue fields are optional. Purchase details come only from you. The app does not import or modify any existing spreadsheet.
- Archive removes a card from the main view. Delete moves it to Recently deleted. Restore to collection recovers it. Deleted records and their photos remain in backups; there is no automatic purge.
- Saved here means the metadata is in this browser. Synced means the current metadata revision reached Firestore. The separate photo count shows how many sides are actually available here. A missing photo is never shown as synced merely because its hash arrived.

The original camera file is not retained by this app. Use photo stores the edited JPEG, with a maximum edge of 2560 pixels and quality 0.92. Keep originals in Photos or Files if you want an archival source beyond the app's edited image. Canvas conversion removes EXIF, including GPS. Check small Japanese print before saving or identifying.

HEIC support depends on the browser's decoder. If it fails, export a JPEG or use iPhone Camera > Formats > Most Compatible. A file-picker fallback is always available. Real camera, HEIC and orientation behavior still need the [iPhone checklist](docs/device-checklist.md).

## Bulk entry and base sets

Choose **Bulk add** to import photos, paste a manual card list, or add owned base cards by checklist number. There is no fixed photo-count limit. Browser memory, available storage and individual image limits still apply.

Photo imports sort filenames naturally, then pair alternating front/back images or all fronts followed by all backs. Review the pairing and swap sides before saving. The app processes one pair at a time. Saved cards survive an interrupted import; reopen Bulk add and reselect the original files to continue.

Manual lists accept one physical card per line, with name, card number, team and rarity separated by tabs or `|`. Shared set details apply to every row. No photos or AI are required.

Base-set imports require the category, maker, year and set. Enter a checklist range, then choose a complete set, all except listed missing numbers, or only numbers you have confirmed owning. Unknown cards are not marked owned. Base cards are recorded with rarity `Base`; parallels, autographs, relics and serial-numbered cards do not count as matching base copies. Existing active or archived base copies are skipped on repeat import.

Saved cards enter the normal backup and metadata-sync flow. Unfinished import plans stay on the current device and are not included in backups.

## Backups and moving photos

Metadata sync does not transfer photos. Use Backups & transfer > Prepare full backup, then Save file or Share / Save to Files. The separate preparation step lets the share action run directly from your tap, which matters on iPhone. Verify that Files or the browser actually saved the ZIP.

The version 1 `.cardcabinet.zip` contains `manifest.json` and JPEG files named by SHA-256 hash. It includes card metadata, purchase details, archive/deletion status and available photos. It excludes passwords, Firebase tokens, device settings and Worker secrets. The package is not encrypted; store it somewhere private.

Choose backup package on the receiving device. The app checks the manifest and photo hashes before showing a merge review. New IDs become new physical copies. Reimporting the same IDs and metadata does not add duplicates. For changed cards, choose the device's version, the backup's version, or both as separate copies. Photos can be restored even when you keep the current metadata. If a card changes during review, the import stops and asks for another review.

A package can contain at most 200 MB of expanded data. This is a memory limit per operation, not a collection limit. Large exports can use several times their file size in memory. Use collection filters and Export these cards to make smaller packages. For a large restored collection, import those packages one after another. Unavailable photos are listed as missing; a backup cannot recreate a photo absent from this device.

CSV export includes metadata and photo hashes, with a UTF-8 BOM for Japanese text in Excel. It does not contain photos and is not the restore format. Formula-like values are prefixed with an apostrophe for safer spreadsheet opening.

Keep at least one verified package outside the browser after adding photos. Browser storage can be erased or evicted. Settings shows the browser's estimate and can request persistent storage where supported. Persistence and installation do not replace backups. See [WebKit's storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).

## GitHub Pages

The app is published at [poemofthanathos.github.io/card-cabinet](https://poemofthanathos.github.io/card-cabinet/). The repository is [PoemofThanathos/card-cabinet](https://github.com/PoemofThanathos/card-cabinet), with GitHub Actions selected as the Pages source. Pushes to `main` run the tests, build the app and deploy it. Firebase metadata sync and OpenAI identification are configured for the owner's account.

The setup instructions below are for another owner-controlled copy. They do not grant downstream users rights beyond the license.

GitHub Free supports Pages from public repositories. Private repository Pages requires an eligible paid plan. Do not assume a free private repository can host this app. [GitHub's current Pages requirements](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

1. Create a GitHub repository, for example `card-cabinet`. Use a public repository for the documented free route. A public repository exposes the code and public Firebase configuration, not the IndexedDB collection on your devices.
2. Put the files from this project at the repository root, including `.github`, `.gitignore` and `package-lock.json`. Do not upload `node_modules`, `dist`, `.env`, `.dev.vars`, backups or test output. Git ignores those paths.
3. If using Git, the following commands initialize and upload the local folder. Replace the remote URL with your own. Run them only when you are ready to create and push the repository.

```powershell
git init
git add .
git status
git commit -m "Add Card Cabinet"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/card-cabinet.git
git push -u origin main
```

4. In the repository, open Settings > Pages. Set the build source to GitHub Actions.
5. In Actions, run Deploy to GitHub Pages. Future pushes to `main` also deploy.
6. Open the HTTPS URL shown by the deployment, usually `https://YOUR_USERNAME.github.io/card-cabinet/`. Install from this URL, **not** the `github.com` repository page.

The workflow obtains the Pages subpath from `actions/configure-pages` and supplies `VITE_BASE_PATH`. Vite uses it for asset URLs, manifest ID, start URL, scope and service-worker navigation fallback. The app uses in-page navigation, so no server-side route rewrite is needed. Do not move or rename a published deployment without first exporting local backups.

To test a project subpath locally in PowerShell:

```powershell
$env:VITE_BASE_PATH='/card-cabinet/'
npm run build
npm run preview -- --base /card-cabinet/
```

Keep the build and preview base paths equal. Otherwise Vite's preview can return HTML for an asset request and display a blank page. For a root deployment, use `/`. On Bash, use `VITE_BASE_PATH=/card-cabinet/ npm run build`.

Static hosting cannot protect secrets embedded in its JavaScript. Only the public variables listed in `.env.example` belong in the frontend. Never add an OpenAI key to a `VITE_` variable, GitHub variable, repository, screenshot or backup.

## Optional Firebase metadata sync

The published app uses the Spark project `card-cabinet-a1d92`, with email/password sign-in and a Firestore Standard database in `southamerica-east1`, São Paulo. The rules permit only the configured owner UID. The GitHub Pages hostname is authorized, and the five public Firebase/owner settings are stored as GitHub Actions variables. Photos remain local. Analytics, Cloud Storage and paid backups are not enabled.

On each device, open Settings, sign in with the personal account created in Firebase Authentication, choose Link this collection, then Sync now. Linking confirms that card metadata, including notes and purchase details, may upload. Use a full backup package to transfer photos. The setup below applies when the owner creates a different Firebase project.

Firebase Spark needs no payment information. Do not link a Cloud Billing account, because linking billing upgrades the project to Blaze. This app does not use Firebase Functions or Cloud Storage. [Firebase plan documentation](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)

1. In the Firebase console, create a project on Spark. Analytics is unnecessary for this app.
2. Add a Web app. Copy its public `apiKey`, `authDomain`, `projectId` and `appId` into a local `.env` file based on `.env.example`. These values identify the Firebase app; they are not the OpenAI secret.
3. Open Authentication, enable Email/Password, then add your one personal user in the console. Copy its UID. Put it in `VITE_OWNER_UID` and replace the configured UID in the `owner` function in `firestore.rules`. The app deliberately has no public sign-up screen. The rules enforce which account can access the collection.
4. Create one Cloud Firestore Standard database, using Native mode. Choose a region you are comfortable using. Keep Spark and choose production rules, not an open test-mode database.
5. Publish this project's `firestore.rules` through the console's Rules tab. Alternatively, after installing dependencies, run `npx firebase login`, then `npx firebase deploy --only firestore:rules,firestore:indexes --project YOUR_PROJECT_ID`. This publishes rules and indexes only. Do not run a broad deploy or enable billing.
6. Add the Pages hostname to Authentication > Settings > Authorized domains where required. A hostname has no `/card-cabinet/` path. Add `localhost` separately if you want local login.
7. For GitHub builds, add each nonempty `VITE_FIREBASE_*`, `VITE_OWNER_UID` and later `VITE_WORKER_URL` under repository Settings > Secrets and variables > Actions > Variables. These are public app configuration. Redeploy after changing them. Never create a frontend OpenAI variable.
8. Open Settings in the app, sign in, verify your UID, then Link this collection. The link confirmation tells you that all metadata, including notes and purchase details, will upload. Choose Sync now.
9. On the other device, sign in to the same user, link its local collection, and choose Sync now. Import a backup package to bring its photos across.

Rules isolate the configured UID, validate exact keys, types and field lengths, reject image payloads and require increasing revisions. They deny hard deletion of card documents. Do not manually delete those documents in the console; old offline devices need the deletion markers.

Sync runs on demand, with no polling loop or background upload. A full pull reads the collection in pages of 200 documents; it is simple and predictable but each manual sync reads all metadata. A free Firestore project currently includes 1 GiB stored, 50,000 reads per day, 20,000 writes per day, 20,000 deletes per day and 10 GiB outbound per month. Daily resets occur around midnight Pacific time. Large collections or frequent syncs can reach those quotas. The app has no automatic paid upgrade. [Firestore quotas](https://firebase.google.com/docs/firestore/quotas)

Each local edit queues a stable mutation ID and the remote revision it was based on. A Firestore transaction compares that revision before writing. A lost response can be retried safely. Concurrent edits, including deletion versus editing, remain available for review. Keep local, use cloud, or keep both copies. Device timestamps are for display and sorting, never conflict arbitration. Expired tokens, network errors and permission failures leave the local collection and queue intact.

## Optional OpenAI identification Worker

Identification is off by default on a new device. Scans use your OpenAI API balance, including eligible subscription credits claimed by the linked API organization. The app cannot read that balance or guarantee a spending cap. [API credits guide](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)

The owner's [Worker](https://card-cabinet-identify.rousilon666.workers.dev) is active on Workers Free, restricted to this app's Firebase owner and GitHub Pages origin. A key for the Card Storage OpenAI project was created through encrypted connector delivery and installed as a Worker secret. Its authorized local copy is in the ignored `worker/.dev.vars` file. It is not part of the frontend or repository.

On 11 November 2026, a Responses API request with `gpt-6-luna` and a signed-in app scan of one generated front/back test card succeeded. The scan produced saved suggestions for review; no suggested fields were applied. This does not establish accuracy on real cards or CPU headroom for large photos. The remaining API balance was not verified. See the [verification record](docs/verification.md) for details.

Cloudflare documents a free Workers offering without a credit card requirement. SQLite Durable Objects are available on Workers Free. If onboarding asks you to upgrade or add a paid service, stop and keep manual entry enabled. Do not choose paid Workers, paid TURN, automatic top-ups or Firebase Blaze. [Workers](https://www.cloudflare.com/products/workers/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

1. Create or use your Cloudflare account on Workers Free when you choose to provision it.
2. Edit the public values in `worker/wrangler.toml`. Set `FIREBASE_PROJECT_ID`, `OWNER_UID` and `ALLOWED_ORIGIN`. For project Pages, the origin is `https://YOUR_USERNAME.github.io`, without the project path. Keep `AI_ENABLED = "false"` initially.
3. Run `npx wrangler login` yourself, then `npm run worker:deploy`. This provisions the Worker and its SQLite Durable Object. It is a deployment action, not part of local setup.
4. Enter your OpenAI key through the secret prompt below. Type or paste it into that local prompt yourself. Do not put the key in chat, a command argument, a tracked file or a frontend variable. Keep any local development copy only in the ignored `worker/.dev.vars` file, outside backups and screenshots.

```powershell
npx wrangler secret put OPENAI_API_KEY --config worker/wrangler.toml
```

5. Put the returned HTTPS Worker URL in `VITE_WORKER_URL`, without `/identify`, in `.env` or the GitHub Actions public variables. Rebuild and redeploy the frontend.
6. When ready to allow paid scans, change `AI_ENABLED` to `"true"` in the Worker configuration and redeploy. In the app, enable Identify and choose a conservative daily attempt limit. Start with one attempt.
7. Capture or import both sides. Choose Identify, read the transmission confirmation, and review suggestions. Nothing is applied until you select fields. Replacing an existing value asks for confirmation.

The configured model is `gpt-6-luna`, verified on 9 November 2026 to accept images and support structured outputs. You can change the server's `OPENAI_MODEL` to a compatible Responses model. The request uses two inline images, `detail: high`, `store: false`, a strict JSON schema, low reasoning effort and 2500 maximum output tokens. Model availability and prices depend on your account. [Model capabilities](https://developers.openai.com/api/docs/models/gpt-6-luna), [vision inputs](https://developers.openai.com/api/docs/guides/images-vision), [structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

Image copies are re-encoded as JPEG before transmission, with at most 2560 pixels per side and 2.5 MB per image. The Worker rejects URLs, unexpected fields, bad JPEG markers, out-of-range dimensions and EXIF segments. It verifies the Firebase token signature, issuer, audience, expiry, issue time and authentication time, then requires your configured UID. CORS is an additional restriction, not the authorization mechanism.

A single Durable Object per UID reserves each attempt before the OpenAI request. Capped mode allows 5 attempts per UTC day and 50 per UTC month across devices. **Settings > Unlimited attempts** removes the device's daily cap and asks the Worker to bypass its daily/monthly caps for that owner's scans. Attempts still count, so switching limits back on does not reset usage. Both modes keep one in-flight request, at least 15 seconds between starts, owner authentication and persistent replay protection. Storage or quota failures fail closed. The app never retries a paid request automatically.

Select collection cards or finish a photo import, then start batch identification after reviewing its card count and photo-transmission notice. The batch sends cards sequentially without a fixed count cap. Capped mode checks the remaining device allowance first. Keep the app open while it runs. Pause stops after the current card; reopening the saved batch lets you continue the remainder. Failed or interrupted requests are not retried automatically. Suggestions remain local until you review and apply them, and are excluded from backups until applied.

To stop scanning, disable Identify locally. To stop every device, set `AI_ENABLED` to `"false"` on the Worker and redeploy, or remove its OpenAI secret. Rotating or revoking a compromised key must happen in your OpenAI account. Token signature verification does not check Firebase revocation before token expiry; the server switch is the immediate stop mechanism.

Workers Free allows 100,000 requests per day and only 10 ms of CPU per HTTP request. JWT verification, schema checks and image parsing need a deployment smoke test against that limit. The local dry run does not prove production CPU headroom. If the free runtime cannot handle your images, keep identification off and use manual entry; do not silently upgrade. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

The Worker does not log photos or credentials, and Wrangler observability is disabled in its configuration. `store: false` disables Responses application storage; it is not a promise of zero provider retention. Review [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) before sending sensitive material.

## Direct device transfer proof of concept

Both devices must be open, online for pairing and signed in to the same Firebase UID. Prepare a backup on the sender, then open Direct device transfer. Create a pairing and enter its 32-character code on the receiver. Send the package after the connection opens. Review the verified package on the receiver before import.

Pairing uses a random 128-bit ID and owner-only Firestore rules. The offer expires after nine minutes and accepts one answer. Rules deny reads after expiry; each client tries to delete the record on close. Closed or crashed tabs can leave expired SDP records in Firestore. Delete those manually if desired. Do not enable billed TTL deletion.

The DataChannel uses WebRTC's encrypted transport. It sends 16 KiB chunks with backpressure, a 200 MB package bound and SHA-256 verification. This implementation uses host candidates only, with no STUN or paid TURN dependency. It may fail across networks or even on the same Wi-Fi. Safari can restrict network candidates, suspend background tabs or stop work when the screen locks. Keep both apps visible and use the file package if pairing stalls. No server runs on the iPhone. Real-device connection reliability is unverified. [WebKit WebRTC notes](https://webkit.org/blog/7763/a-closer-look-into-webrtc/)

## Install on iPhone and Windows

On iPhone, open the published HTTPS Pages URL in Safari. Use Share > Add to Home Screen; menu wording can vary by iOS version. Open the installed app once online, wait for the offline-ready message, then test it in airplane mode. No Mac, Xcode, App Store app or Apple Developer subscription is needed.

On Windows, open the same HTTPS app URL in Edge or Chrome and use its install control. The repository URL is not the app URL. Installed and browser contexts should be checked separately before you assume they contain the same saved data.

`localhost` on the iPhone means the iPhone, not your Windows PC. Plain `http://YOUR_PC_IP:5173` is not a valid substitute for HTTPS PWA testing. The simplest supported test method is a Pages test deployment using the workflow above. Use test cards and a separate browser profile before collecting important photos. A trusted local HTTPS certificate is another option, but requires installing trust on the phone; this project does not modify device trust settings.

Updates download in the background and show an Update now button. The button stays disabled during editing, backup review, transfer and app writes. Save drafts and close other Card Cabinet tabs before activating an update. No timer automatically applies a waiting update. Changing the hosting origin creates separate browser storage. Different project paths share their origin's storage boundary; do not host untrusted code under that same origin.

## Tests and project files

```powershell
npm test
npm run worker:check
```

`npm test` uses fake IndexedDB, mocked cloud synchronization, mocked signaling and mocked OpenAI responses. `worker:check` bundles the Worker locally with a deployment dry run. Neither calls OpenAI or provisions a service.

Firestore rules tests use a local emulator and a demo project. Install Java 21 or newer first. The emulator may download its JAR on the first run.

```powershell
npm run test:rules
```

Browser tests use a production build at a project subpath. They create disposable test records and photos in isolated browser contexts.

```powershell
npx playwright install chromium webkit
$env:VITE_BASE_PATH='/card-cabinet/'
npm run build
npm run test:e2e
```

Playwright WebKit on Windows is not an iPhone. The automated offline service-worker reopening check runs in Chromium; real iPhone reopening remains on the manual checklist. See [verification](docs/verification.md) for results and limits.

| Path                                  | Purpose                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `src/model.ts`                        | Card and suggestion schemas                                 |
| `src/db.ts`                           | IndexedDB, atomic writes, photo bytes and migrations        |
| `src/sync.ts`, `src/firebase.ts`      | Persistent queue and Firestore transactions                 |
| `src/backup.ts`                       | Versioned ZIP, merge review and CSV                         |
| `src/photos.ts`, `src/components.tsx` | Image editing and metadata removal                          |
| `src/ai.ts`, `src/BatchIdentify.tsx`  | Explicit identification and review                          |
| `src/transfer.ts`                     | Temporary pairing and DataChannel protocol                  |
| `worker/`                             | Protected identification endpoint and persisted scan limits |
| `firestore.rules`                     | Owner isolation, revisions and pairing expiry               |
| `.github/workflows/pages.yml`         | Static GitHub Pages deployment                              |

## Troubleshooting

| Problem                   | What to check                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blank page locally        | Build and preview with the same base path. Use the printed HTTP URL, not a file URL.                                                                           |
| Blank page on Pages       | Actions deployment succeeded, Pages source is GitHub Actions, and the app URL includes the repository subpath.                                                 |
| Cannot reopen offline     | Open the production build online once and wait for offline-ready. Check storage availability. Development mode does not install the production service worker. |
| Photos missing after sync | Expected on a new device. Import a ZIP containing those photos.                                                                                                |
| Storage full              | Keep the existing data. Export smaller backups, verify them, and free unrelated device space. Failed transactions preserve earlier saved cards.                |
| HEIC fails                | Use a JPEG or PNG export, or Most Compatible camera format.                                                                                                    |
| Sync permission denied    | UID in rules, frontend configuration and signed-in user must agree. Publish rules to the correct project.                                                      |
| Sync quota reached        | Continue locally. Wait for the free quota reset; avoid repeated full syncs.                                                                                    |
| Wrong user signed in      | Sign out. Local records remain. A linked collection cannot be rebound silently to another UID.                                                                 |
| Conflict after restore    | Review the local and cloud versions. Backups intentionally do not restore cloud revision bookkeeping.                                                          |
| Identify disabled         | Check the local switch, Worker switch, HTTPS Worker URL, sign-in and both local photos.                                                                        |
| Scan failed               | The attempt may have been billed. Check usage before choosing another request. There is no automatic retry.                                                    |
| Backup did not appear     | Check Downloads or Files. Use Prepare, then tap Share / Save to Files. A share dismissal does not save anything.                                               |
| Pairing stalls            | Keep both apps foregrounded. Use the backup file if a direct channel cannot connect.                                                                           |

Never clear site data or uninstall as the first troubleshooting step. Verify an external backup before doing either.
