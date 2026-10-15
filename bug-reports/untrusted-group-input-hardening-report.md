# Untrusted group input: malformed announcement pubkeys can break the timeline; group avatar URLs unvalidated

Source: BACKLOG.json findings `display-only-chat-announcements-spoofable-share` and
`group-profile-sync-marmot-profilesync-ts`, promoted 2026-10-15 (triage-verified against current code).

## Description

1. Structured timeline notices (leave_intent, invite_cancelled, group_renamed, poll_*, member_admitted)
   are parsed in app/src/lib/marmot/parseStructured.ts (~:28-41). leave_intent/invite_cancelled accept ANY
   string pubkey; ChatBox.tsx (~:527, :559) renders via npubEncode/pubkeyToNpub, which throws on non-hex →
   one crafted member message breaks the timeline render for every receiver. member_admitted was already
   hardened to canonical 64-hex (epic group-admission-chat-announcement); siblings were left for a uniform pass.
2. Group profile sync (app/src/lib/marmot/profileSync.ts payloadToMemberProfile ~:188-194) stores any
   avatar.imageUrl (javascript:, data:, http: tracker URLs, unbounded length). The 1:1 dmProfile codec
   (app/src/lib/dmProfile/kinds.ts ~:193-217) already enforces a scheme allow-list (https:// or //) and a
   512-char cap, and its comment notes the group path does not.

## Expected vs actual

Expected: a malformed announcement is dropped (or rendered without the subject) and never breaks rendering;
group avatars obey the same URL rules as 1:1 avatars. Actual: render throw; arbitrary URLs persisted and
used as image sources (privacy: http(s) tracker URLs leak viewer IPs; javascript:/data: schemes).

## Out of scope / constraints

- Announcement SPOOFABILITY (a member posting a cosmetic fake notice) was accepted by the product owner
  for member_admitted on 2026-07-19 — do NOT add new authentication schemes. Exception: binding a
  leave_intent subject to the authenticated sender is in scope ONLY if every producer of leave_intent
  announces its OWN leave (verify all producers); otherwise leave it and report.
- Reuse the dmProfile avatar validator (extract/share it, don't duplicate).
- Privacy invariant (CLAUDE.md) unaffected; no new broadcasts.
