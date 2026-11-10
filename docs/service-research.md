# Service and browser findings

Checked against official documentation on 9 November 2026. These are documentation findings, not evidence that this app has been deployed or tested on an iPhone.

## GitHub Pages

GitHub Free supports Pages from public repositories. Private repository Pages requires an eligible paid plan such as Pro, Team or Enterprise. A free public repository is therefore the documented route for this project's requested hosting budget. Project Pages normally lives at `https://OWNER.github.io/REPOSITORY/`, so the build must use that subpath. The repository's `github.com` page is not the installed app URL. [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

Publishing static code does not make browser IndexedDB content public. Any credentials embedded in that code would be public, however. Only Firebase's public web configuration belongs there. The OpenAI key belongs in the Worker secret store.

## Firebase Spark

Firebase explicitly says that Spark does not need payment information. Linking a Cloud Billing account automatically upgrades a project to Blaze, so do not link one. Spark quotas are enforced; an exhausted service can stop working until its quota resets. Monthly quotas and daily quotas have different reset periods. [Firebase pricing plans](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)

Firestore's free allowance is one database per project, 1 GiB stored, 50,000 reads per day, 20,000 writes per day, 20,000 deletes per day and 10 GiB outbound transfer per month. Daily quotas reset around midnight Pacific time. TTL deletion, managed backups, restores, clones and point-in-time recovery require billing, so this app must not depend on them. Local file backups provide a separate recovery route. Pairing records should expire through access rules and be explicitly deleted by clients, rather than through billed TTL. [Firestore quotas](https://firebase.google.com/docs/firestore/quotas)

Use email/password login. Firebase documents this provider directly. Create the one personal user in the Firebase console, rather than adding a public account-registration flow. [Password-based authentication](https://firebase.google.com/docs/auth/web/password-auth)

Authentication has separate abuse and email limits. Spark currently permits 150 password-reset emails per day, 1,000 verification emails per day and only 5 email-link sign-in emails per day. Identity Platform on Spark has a separate 3,000 Tier 1 daily-active-user allowance. These are service limits, not card limits. Email/password avoids reliance on the small email-link sign-in quota. [Authentication limits](https://firebase.google.com/docs/auth/limits)

Firestore transactions retry concurrent edits and fail while offline. The app therefore needs its own persistent local edit queue, with an explicit remote base revision, and should only execute the transaction when connected. Transaction callbacks can run more than once and must not update local UI or perform unrelated side effects. Compare revisions inside the transaction. Preserve a conflicting local version for review. [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions)

Security rules can allow only known fields with `keys().hasOnly()`, enforce types and string lengths, and restrict updates through `diff().affectedKeys()`. Rules cannot generically validate every item in an arbitrary list, so use bounded lists with explicit entry checks or simple validated strings for tags. Reject all unknown fields, including photo payloads. [Field validation rules](https://firebase.google.com/docs/firestore/security/rules-fields)

## Cloudflare Workers and Durable Objects

Cloudflare advertises the Workers free offering without a credit card requirement. Account-specific onboarding still has to be completed by the user. Stay on Workers Free; do not select paid Workers, paid TURN or unrelated paid services. [Workers product page](https://www.cloudflare.com/products/workers/)

Workers Free currently includes 100,000 requests per day, 10 ms CPU time per HTTP request and 128 MB memory. Network waiting does not count as CPU time. Parsing and copying large base64 strings still consumes CPU and memory. A deployment needs a real quota smoke test before production identification; local mocks cannot prove that JPEG validation plus JWT verification fits the free CPU budget. Handle resource-limit failures without retrying a paid OpenAI call automatically. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

SQLite-backed Durable Objects are available on Workers Free. The current free allowances are 100,000 requests per day, 13,000 GB-seconds per day, 5 million SQL rows read per day, 100,000 SQL rows written per day and 5 GB total SQL storage. Exceeding a free limit makes further operations of that type fail. Daily limits reset at 00:00 UTC. Do not use the legacy KV-backed Durable Object namespace. [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

A SQLite-backed Durable Object supports both SQL and the storage key/value API. A per-UID object can serialize persisted rate accounting and a lease for one active request, avoiding eventually consistent Workers KV counters. The reservation must succeed before making an OpenAI request, and a storage failure must deny the request. Include request IDs so a network retry does not accidentally trigger another paid call. [SQLite-backed Durable Object storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Firebase documents third-party JWT validation. Require RS256, a trusted Google signing key matching `kid`, future `exp`, nonfuture `iat` and `auth_time`, exact project `aud`, exact `https://securetoken.google.com/PROJECT_ID` issuer and a nonempty `sub`. Verify the signature before using `sub`, then require the configured owner UID. Respect Google's key-cache lifetime. Signature validation alone does not check revocation; a server off switch provides an immediate way to stop scans, and expired tokens must fail closed. [Firebase token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)

## iPhone storage and direct transfer

Safari 17 and later supports `navigator.storage.estimate()`, `persisted()` and `persist()`. WebKit uses heuristics when granting persistence, including Home Screen use. Storage remains limited, a write can throw `QuotaExceededError`, and best-effort data can be evicted. Home Screen apps use the browser's origin quota, but installation is not a backup. A user can still erase site data. Test both browser and installed modes; do not promise they share all state. [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)

WebKit has supported WebRTC since iOS 11, but connectivity depends on ICE candidates and network topology. WebKit's published explanation describes restrictions on host candidates when capture-device access has not been granted. This is a historical implementation explanation, not a guarantee about each current iPhone. Same Wi-Fi cannot establish that a direct DataChannel will connect. [WebKit WebRTC explanation](https://webkit.org/blog/7763/a-closer-look-into-webrtc/)

Current WebKit bug records also show a Safari 26.4 relay-candidate regression that was fixed. This illustrates why a passing desktop test does not prove current iPhone behavior. Do not depend on a specific browser bug or tell users to disable browser protections. [WebKit bug 312332](https://bugs.webkit.org/show_bug.cgi?id=312332)

DataChannel message limits vary by browser. Send bounded chunks, wait for the channel to open, apply buffered-amount backpressure, bound total transfer size, verify hashes and stop on timeout or closure. [DataChannel send documentation](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/send)

For the proof of concept, authenticate both devices to the same Firebase UID. Put short-lived SDP and ICE signaling under that UID, require an unguessable pairing ID, and close/delete the session after use. Send photos through the DataChannel, not Firestore. Keep both apps in the foreground. Do not rely on an iPhone-hosted server or background execution. A no-TURN connection can fail even on the same Wi-Fi, so the versioned file package remains the supported transfer and backup route until real-device testing establishes more.

The Apple installation guide could not be fetched during this check because the site returned HTTP 429. Manual installation instructions should be tested on the user's iPhone, whose Safari menu labels may differ by iOS version.
