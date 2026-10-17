# Product-decision triage by Fable — 2026-10-17

Owner instruction (2026-10-17): work autonomously; ask Fable before consulting the owner; decide
implementation details; defer product decisions that cannot be decided autonomously to the end.
Fable classified each blocked finding as AGENT-DECIDES (implemented autonomously) or OWNER.

## AGENT-DECIDES (implemented in this loop)
1. leave-announcement-blank-name-when-profile-unknown — blank/whitespace nickname treated as absent
   (`||` + trim) so the fallback is the truncated npub, as in the sibling announcements and MemberList.
   No new copy. E2E waits for profile propagation before asserting the name.
2. backup-dirty-mark-lost-on-early-reload — persist an unsent dirty mark in localStorage
   (`few-backup-dirty`), cleared on successful publish, replayed on scheduler activation.
3. you-cannot-re-add-reaction-emoji — add wins when strictly newer than the tombstone
   (`removedAt`); an add older than / equal to its removal stays removed (out-of-order protection).
4. cross-tab-account-switch-notice — post an account-changed event on the crossTab channel from the
   wipe path; receivers reload. Needed under any multi-tab design.
5. share-contact-card-permanently-fails-when — distinct, actionable error copy on signer/identity
   mismatch (en/de below). Connect-time rejection stays an owner question.
   en: "Your signer holds a different identity than this profile. Reconnect a signer for this identity or switch back to the local key."
   de: "Dein Signierer gehört zu einer anderen Identität als dieses Profil. Verbinde einen Signierer für diese Identität oder wechsle zurück zum lokalen Schlüssel."
6. two-co-admins-leaving-at-nearly — execution-time sole-admin re-check in leaveGroupImpl
   (fail closed, `lastAdminLeaveBlocked`), residual window documented in groups.md §8.
7. invite-modal-picker-cannot-re-invite (label half) — `invite_pending` disabled reason,
   en "invitation pending" / de "Einladung ausstehend". Resend stays an owner question.
8. reinvite-after-eviction-fails-already-exists (engineering half) — a valid Welcome for a locally
   held group whose own leaf is gone / epoch is stale replaces local state (teardown, destroy,
   re-join); history starts fresh. The evicted-member view stays an owner question.
9. ADR-012 status → verify and close "authenticate all display-only announcements";
   icon-set three-column guard test; external-signer settings notice
   (en "Automatic backup is off while an external signer is connected." /
    de "Automatische Sicherung ist aus, solange ein externer Signierer verbunden ist.").

## OWNER questions (deferred to loop end)
1. Kind-13 send failure: abort leave + retryable error (rec.) / proceed + warn / accept and document?
2. Evicted member: group vanishes locally (rec.) / read-only "removed" view / status quo?
3. Pending-invite resend: cancel + re-invite in one tap (rec. if DD-4 stands) / label only / drop DD-4?
4. Multi-tab: single active tab with takeover (rec.) / all tabs active with invalidation?
   (blocks multi-tab-mls-cache-coherence, poll-receipt-clock-and-seq-cross-tab)
5. External-signer backup: manual "Back up now" (rec.) / silent via signer / notice only?
6. Icon sets: commission a filled/pixel theme / collapse to `line` (rec. absent a plan) / guard test only?
7. Reject a mismatched NIP-46/07 signer at connect time (rec. yes, later)?
8. ADR-012 forwardable signed meta-events — still wanted, if unimplemented?
