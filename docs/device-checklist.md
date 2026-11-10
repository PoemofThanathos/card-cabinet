# Real-device acceptance checklist

Use disposable test cards and a backup before moving an important collection. Record iPhone model, iOS version, browser version, Windows browser version and the exact deployed URL.

## iPhone Safari and installed app

- [ ] Open the HTTPS Pages app URL, not its GitHub repository. Confirm icons, CSS and JavaScript load under the project subpath.
- [ ] Add to Home Screen. Open the installed app and verify its start URL and standalone display.
- [ ] Wait for offline-ready. Close the app, enable airplane mode, reopen it and browse existing cards. Add and edit a card, close and reopen again, then restore connectivity.
- [ ] Test Safari and home-screen mode separately. Export before switching contexts or reinstalling.
- [ ] Capture front and back. Test camera denial, cancellation, retake and file-picker fallback.
- [ ] Try a portrait JPEG, landscape JPEG, rotated EXIF JPEG, PNG and HEIC. Verify upright orientation, crop edges and readable Japanese print. If HEIC fails, verify the JPEG guidance appears and preserves the draft.
- [ ] Check both photos after saving, closing and reopening. Verify the photo count on grid and list views.
- [ ] Enter Japanese, emoji, full-width numbers and multiline notes. Search full-width card numbers using ordinary digits.
- [ ] Duplicate an identical physical card. Verify two records remain and can have different locations or serials.
- [ ] Archive, delete and restore. Verify metadata and photos survive each operation.
- [ ] Leave a draft open, background the app, then return. Confirm the latest saved draft is available. A camera capture in progress can still be interrupted by iOS; do not depend on background execution.
- [ ] Prepare a backup, tap Share / Save to Files and confirm the file exists in Files. Open it on Windows and compare front/back images and Japanese text.
- [ ] Restore into an empty browser profile. Reimport the same file and verify no duplicate IDs appear. Review changed-card choices and missing photos.
- [ ] Test a larger package in small steps. The 200 MB bound is not proof that a phone has enough memory for a package that size.
- [ ] Request persistence and record the result. Do not assume installation means persistence was granted.
- [ ] Publish a test update while a draft is open. Verify no automatic reload occurs. Save and close other app tabs, apply the update, and confirm local data remains.

## Connected metadata sync

- [ ] Sign in and link each device to the same UID. Manually sync. Confirm metadata arrives while missing photos remain clearly marked.
- [ ] Edit a card offline on both devices, then sync them. Verify the conflict preserves both versions for review.
- [ ] Delete on one device and edit offline on the other. Verify conflict handling rather than silent deletion or resurrection.
- [ ] Sign out or expire a token, then browse and edit locally. Sign in again and confirm the persistent queue can sync.
- [ ] Test a permission-denied configuration in a disposable project. Confirm saved local data remains usable.
- [ ] Restore a backup while cloud records already exist. Review conflicts and verify no silent overwrite.

## Optional identification, only after approving API charges

- [ ] Keep the Worker off and confirm Identify fails without an OpenAI request.
- [ ] Review OpenAI billing yourself. Do not assume ChatGPT includes API use or that app counters enforce an account spending cap.
- [ ] Enable the Worker and local switch with a device limit of one. Identify one disposable test card. Check actual billing and free Worker CPU behavior.
- [ ] Confirm a request contains exactly the two selected image copies and no notes, purchase details or location metadata. Do not save authorization headers or keys in screenshots or shared logs.
- [ ] Compare visible-text labels, inferences, uncertain blanks and warnings against the card. Verify replacing your own text asks for confirmation.
- [ ] Check BBM, EPOCH, Topps NPB, MLB, Hololive Official Card Game and Weiss Schwarz examples. Do not treat a passing example as proof the model can identify every card.
- [ ] Confirm the local off switch prevents a request. Confirm the Worker off switch stops every device.
- [ ] Confirm a small selected batch requires consent before its first request and review between cards. Close it and verify no additional request runs.

## Direct transfer proof of concept

- [ ] Sign in on both devices with the same UID. Create a temporary pairing and enter its complete code on the other device.
- [ ] Test a small package on the same Wi-Fi. Confirm received hashes and the import review.
- [ ] Test failed connectivity, screen lock, app backgrounding, sender closure and network changes. Partial packages must not import.
- [ ] Try a reused code, expired code and another account. Access must fail.
- [ ] Confirm the ZIP fallback transfers the same photos when WebRTC cannot connect.

No physical iPhone or cross-device network was available during automated verification. These boxes are intentionally unchecked.
