# Robustness cluster: journal cap, unpersisted member removals, unsanitized stored avatars

Source: BACKLOG.json findings promoted 2026-10-15 (texts below verbatim).

## rumor-journal-cap-evicts-unapplied
The rumor journal's per-group cap (1000) can evict never-applied entries after an interrupted catch-up of more than 1000 rumors

- motivation: Decider-waived Codex HIGH (low) on bug mls-message-lost-on-unload-after-ingest, 2026-10-15: strictly better than before the fix (all were lost), but a large interrupted history catch-up still loses the overflow.
- behavior: partition()/sweep keep the newest 1000 entries per group and drop the rest regardless of whether they were applied.
- approach: Cap by age only, or raise the cap / evict only entries older than N days; replay in chunks.
- success signal: Unit: 1500 pending entries survive a sweep and all replay

## pending-member-removals-not-persisted
The 5 s debounced pending-removal queue for leave intents (pendingRemovalsRef) is in memory only; an unload inside the debounce drops the member removal

- motivation: Decider-waived Codex HIGH (medium, pre-existing) on bug mls-message-lost-on-unload-after-ingest: the leave-intent rumor is now journaled and acked when handled, but the removal it schedules is not durable, so a reload within 5 s leaves a departed member on the roster.
- behavior: leave_intent handler → enqueueLeave → in-memory pendingRemovalsRef, flushed after a 5 s debounce; nothing persists or flushes it on pagehide.
- approach: Persist the pending-removal set (IDB) and resume it at startup, or flush on pagehide; keep idempotency.
- success signal: e2e/unit: a reload within the debounce still removes the departed member

## stored-group-avatars-not-resanitized
Group member avatars stored before the 2026-10-15 avatar-URL check stay in IDB and the contact cache (and render) until that member sends a newer profile

- motivation: The untrusted-group-input hardening validates avatar URLs on receipt only; an unsafe URL (http tracker, javascript:/data:) persisted earlier is still used as an image source. Reviewer note, bug run untrusted-group-input-hardening.
- behavior: payloadToMemberProfile now drops invalid avatars on ingest; stored MemberProfile rows (few-member-profiles) and contact-cache entries are read without re-validation.
- approach: Apply isAllowedAvatarImageUrl (dmProfile/kinds.ts) on read in the member-profile / contact-cache loaders (drop the avatar, keep the profile), or a one-time sanitise pass at startup.
- success signal: A pre-seeded stored member profile with an http:// avatar renders without the avatar after reload

## Constraints
No user-visible behaviour choices beyond restoring intended behaviour (no lost removals, no lost journal entries, unsafe avatars never rendered). Privacy invariant unaffected. If an item needs a product choice, skip it and report.
