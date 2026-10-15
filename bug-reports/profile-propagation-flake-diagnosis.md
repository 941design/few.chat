# Profile-propagation flake diagnosis (groups-leave-intent AC-MEMBERS-2, groups-contacts :93)

BACKLOG finding: `groups-e2e-suite-flaky-under-shared`. Diagnosed 2026-10-15 with instrumented e2e runs,
each on a wiped relay (`down -v && up -d --wait`), serialized via `/tmp/claude-501/e2e.lock`.

The two symptoms look alike ("peer name not shown") but have **different root causes**.

## How a member's profile reaches the other members (code trace)

- **Join → own profile rumor.** After the joiner's group subscription finishes its history sync,
  `MarmotContext` `onHistorySynced` (~:1795-1850) signs the local profile (`serialiseProfileUpdate`,
  signed kind-0 envelope) and sends it as an MLS application rumor (kind 0) via `signAndSendProfileBackground`.
  It sends once per group per session (`profilePublishedRef`). The inviter also re-sends its own profile
  after `inviteByNpub` and `createGroup`.
- **Receive.** `handlers/profileHandler.ts`: `parseProfilePayload` → `mergeMemberProfile` (IDB,
  LWW) → `setProfileVersion` → … → `writeContactEntry` (global contact cache, through a dynamic import).
- **Recovery.** Profile requests (kind 30) go out from `requestProfilesIfStale`, which runs when the group
  detail page mounts, and from the app-start `sweepStaleProfiles`. A peer answers with `sendSelfProfile` or
  relays the profile on the target's behalf. The dedupe memo blocks a retry for `UNANSWERED_RETRY_MS` = 1 h,
  so a request sent too early (for example while the invitee is still pending) does not recover within
  a test.
- **Leave announcement.** `leaveGroupImpl` puts the leaver's **own** `localProfile.nickname` into the kind-9
  `leave_intent` payload (`name`). `ChatBox` renders `structured.name ?? profileMap[pk]?.nickname ?? npub`.
  So the announcement does not depend on the receiver ever having received the leaver's profile.

## 1. groups-leave-intent AC-MEMBERS-2 (" left the group"): TEST defect, fixed

**Cause:** this is the known seed/clearAppState race (memory `e2e_profile_seed_clearstate_race`). `bootUser`
seeded `lp_userProfile_v1` only inside an `if (!…)`-guarded initScript, then ran `clearAppState` + `reload`.
If the first page's ProfileContext persisted its empty default `{nickname:'', avatar:<random>}` after the
clear, that blank profile survived the guard. Bob then **was** nameless: the leave payload had no `name`,
Alice's profileMap held Bob's own blank nickname `""`, and `"" ?? …` rendered `" left the group"`.

**Evidence (4 instrumented runs; Bob's `lp_userProfile_v1` dumped after boot and at leave time):**

| run | A nickname | B nickname | result |
|---|---|---|---|
| 1 | `""` | `""` | FAIL: announcement name (Alice's member list showed Bob as npub) |
| 2 | Alice | Bob | pass |
| 3 | `""` | `""` | FAIL: announcement name |
| 4 | `""` | Bob | FAIL on a different step (auto-remove poll, AC-MEMBERS-2 member removal, unrelated) |

The name failure happens exactly when Bob's own seeded nickname is blank. Propagation latency is not a
factor: the announcement carries the leaver's own name.

**Fix applied:** in `app/tests/e2e/groups-leave-intent.spec.ts` `bootUser`, identity and profile are
written again with `page.evaluate` after `clearAppState` and before `reload`. This is the same pattern as
`groups-poll-after-leave.spec.ts`. No other spec with the 1-setItem guarded pattern (cancel-pending,
forward-secrecy, rename) asserts a user's display name.

**Verification:** fixed runs 1-4 and 6-10 passed (9/9 tests each), so the last 5 were consecutive passes.
Run 5 failed at `openGroupDetail`'s `page.goto('/groups/')` with `net::ERR_ABORTED`, before any profile
step. That is an unrelated navigation race.

Product side: the receiver re-renders correctly (profileMap is live). The blank-name wording
(`"" ?? …` doesn't fall back) is the already-filed owner question
`leave-announcement-blank-name-when-profile-unknown`. It is not decided here.

## 2. groups-contacts :93 (contact card shows npub): PRODUCT defect, not fixed (lead decides)

**Failure rate:** 4 of 7 runs without a Playwright console listener (2/3 clean, 2/4 with a cache dump).
With a `page.on('console')` listener it failed 0 of 8 times: the listener changes the timing enough to hide
the race.

**Evidence (captured failure, run cdiag9, logs buffered in-page through sessionStorage):**

```
B 13.273 Accepted invitation and joined group
B 13.442 onHistorySynced: publishing profile … nickname="Bob"
B 13.447 profile published successfully
A 13.610 LOAD /groups/          <- test's pageA.goto('/groups/'), ~160 ms after Bob's publish
A 14.422 Historical sync 10/10 … (no Bob profile applied)
A 15.654 LOAD /contacts/  16.454 Historical sync 11/11 …
A cache[Bob] = null at contacts load, null after 30 s, still null after a further reload
```

In the passing runs, Alice's contact cache already held Bob when /contacts/ loaded.

**Mechanism:** marmot-ts `MarmotGroup.ingest()` (dist `client/group/marmot-group.js` ~:1050-1130) runs in
this order:
1. Decrypt, then adopt the ratchet-advanced state (`this.state = result.newState`).
2. Emit `applicationMessage`. `applicationRumorDispatcher` only enqueues the async profile handler on a
   promise tail (IDB merge, marker consume, dynamic-import contact-cache write).
3. Run the post-batch `await this.save()`.

If the page unloads after the save but before the handler finishes, the message key is consumed and
persisted while the side effect is lost. After reload, history re-ingest can't decrypt the consumed
generation. The `"N/N ingested"` counter counts attempts, not successes, so the log hides this. Nothing
recovers within the session:
- Bob sends his profile once per session (`profilePublishedRef`).
- Alice's earlier profile request, sent at group-detail mount while Bob was still pending, sets the 1 h
  retry memo.

This is the same class as `invite-accept-not-atomic-across-page-unload` (MLS state persisted ahead of the
app-level effect), but on the application-message path rather than the accept path. It is user-reachable:
navigating or reloading just as a peer's profile arrives can lose that name permanently.

**Product fix options (not applied):**
- (a) Make delivery of the application rumor durable before the MLS state that consumed it is saved. For
  example, persist decrypted rumors to an IDB inbox that is processed and cleared idempotently, with replay
  on subscribe. This is the general fix for every rumor kind (chat, polls, reactions, profile).
- (b) Profile-only mitigation: when a member is still missing a profile after history sync, re-request it
  regardless of the 1 h memo if the memo predates that member's join. Alternatively, the joiner re-sends
  its profile when it first sees another member's profile request or rumor after joining.

**Secondary latent gap (no failure observed):** the group profile path's `writeContactEntry` (MarmotContext
~:1696) never calls `notifyContactsChanged`/bumps `contactsRevision`. A profile ingested while /contacts/ is
open therefore doesn't re-render the card until something else bumps the revision.

**Test-side option (would mask the product defect, so it was not applied):** in groups-contacts, wait on
Alice's live group-detail member list for "Bob" before `pageA.goto('/groups/')`. Don't add reload polling.

## Instrumentation hygiene

All `DIAG-TMP` instrumentation was removed. groups-contacts.spec.ts is byte-identical to HEAD. The only
remaining change is the leave-intent boot fix.
