# Data and security notes

## Local storage

Dexie database `card-cabinet` contains cards, photo bytes, pending operations, conflicts and settings. Card metadata points to photos by SHA-256, so two physical copies can share the same image bytes without merging their IDs. Photo data uses ArrayBuffer storage to avoid a Blob persistence failure observed in Windows WebKit. Database version 3 migrates earlier Blob rows without deleting them.

Card writes and queue updates share an IndexedDB transaction. Backup imports also write metadata and photos in one transaction after all package validation finishes. Quota or write failures abort the transaction. Drafts and newly edited photos save separately so a capture session can be resumed. Unused retakes may remain as unreferenced photo bytes; the app does not automatically remove photo data. Storage estimates include those bytes, while backups include photos referenced by saved cards.

The database lives under the browser origin. Browser profiles and devices have separate storage. GitHub project paths on the same hostname share the origin boundary. Hosting another untrusted app under that hostname can expose the same origin's storage. Backups are plaintext ZIPs and need private storage.

## Sync invariants

Each card has a stable UUID and a local version. Queue entries contain the full metadata snapshot, a mutation UUID, local version and expected remote revision. The cloud stores only `{ rev, mutationId, card }` under `users/UID/cards/ID`.

Transactions read the remote document and compare revisions. A matching mutation ID means a previously committed request is safe to acknowledge. Equivalent card content can also be acknowledged after a restore. A different base revision creates a local conflict, preserving the current local record and cloud record. Device dates never select the winner.

An acknowledgement only removes the exact queued mutation it sent. If another edit happened during the request, that newer queue entry stays and receives the acknowledged base revision. Cross-tab sync uses Web Locks where available. Transactions and mutation checks remain the safety mechanism on browsers without Web Locks. Editors refuse to save over metadata changed since the editor's baseline was captured.

Deletion is a status change, with no automatic hard delete. Tombstones remain in Firestore and backups. This costs metadata storage but lets offline devices observe deletions. Conflict resolution can intentionally restore the local version or preserve both as separate IDs. An unexpected hard deletion outside the app stops sync for that record rather than guessing.

Sync is manual. Pulls use server reads in pages of 200 records, without photos or thumbnails. There is no polling or hidden upload after reconnect. Signing out does not erase cards, photos, drafts or operations. A persistent UID binding prevents accidentally uploading the same local collection to a different signed-in account.

## Identification boundary

The frontend stores no OpenAI credential. It obtains a Firebase ID token, re-encodes the two selected images, reserves a local attempt and makes one HTTPS request. Request bodies include only the images and a random request ID. The Worker accepts only `/identify`, POST and the configured browser origin. It accepts no fetch URLs or client-selected model.

The Worker verifies RS256 JWT signatures using Google's signing keys, exact project issuer and audience, expiry and nonfuture authentication/issue times. It then compares the subject with the configured owner UID. Revocation before token expiry is not queried. The server off switch provides an immediate way to stop scans.

Image checks use encoded size, JPEG markers, SOF dimensions, scan markers, end markers and rejection of EXIF segments. They do not implement a full JPEG pixel decoder. OpenAI must still accept the encoded image. Browser re-encoding creates a clean JPEG before the request. Malformed input cannot choose a destination or invoke arbitrary tools.

A SQLite-backed Durable Object is named from the verified UID. A short serialized storage operation reserves quota and a two-minute concurrency lease. The upstream request times out after 45 seconds. The lease is longer than that timeout and survives instance loss. A normal completion releases it, and a crashed request blocks new scans until lease expiry. All attempts count before transmission; storage failure prevents transmission. The current-month request-ID list prevents accidental replay. Counters protect this endpoint, not the user's entire OpenAI account.

Structured output is parsed again before returning. It distinguishes literal visible text from inference. Uncertain values are forced to blank. Purchase and private organizational fields are excluded from the allowed suggestion fields. Printed card text is explicitly untrusted data. No tools, browsing, authentication claims, condition grades or market valuation are requested.

## Backup and transfer boundaries

Package parsing rejects unexpected ZIP paths, duplicate entries and IDs, unknown schemas, unsupported versions, excess expanded size, missing declared photo files and SHA-256 mismatches. A metadata reference to an unavailable photo is allowed and shown as missing. Reviewed imports check for local changes again inside the transaction. Repeated imports do not create a new physical copy unless the user explicitly chooses Keep both.

WebRTC signaling sits under the same configured UID and an unpredictable 128-bit room ID. Rules deny room listing, permit one answer, limit SDP sizes and deny reads after expiry. Clients attempt cleanup; no paid TTL feature is required. DataChannel messages have size bounds and backpressure. Received chunks are processed in order, then verified before opening the normal package review. Only signaling passes through Firestore.

The proof of concept has no STUN or TURN server. This reduces infrastructure and exposes an explicit limitation: connectivity is not guaranteed, including on the same Wi-Fi. A temporary pairing code is useful only to an authenticated owner account. A compromised owner account can access its metadata and pairing records, so protect that account.

## Updates and deployment

The PWA precaches its own static assets. Auth, Firestore and Worker responses are not placed in service-worker caches. Updates use the prompt workflow and do not auto-activate on a timer. The UI disables activation while a capture/editor, backup/import/transfer or write is active. Other open tabs must be saved and closed by the user before activation.

The frontend is a static Pages build with a configurable base path and no deep server routes. The Worker is deployed separately. Public Firebase values may appear in the bundle; Firestore rules and token validation provide access control. The OpenAI key belongs only in Worker secrets. Observability is off, no application code prints request bodies or credentials, and backup serialization has no access to secret configuration.
