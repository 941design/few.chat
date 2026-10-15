# Profiles & identity

*Who you are in the app (an auto-generated identity) and how you present yourself (a
name and avatar) — how a profile is set, where it is allowed to travel, and how you come
to see other people's profiles — governed by one hard rule: your profile is never made
public.*

---

## 1. The privacy invariant

**Your profile — your display name and avatar — is never posted publicly for anyone to
read.** It is disclosed only to an audience already entitled to it, and only in forms that
cannot be turned into a public posting of your profile. Concretely, it travels:

- **inside a group**, as a message encrypted to that group's members;
- **to a single contact**, as a sealed, single-recipient private message (a join request
  likewise carries your name privately to the one admin who receives it);
- **on a contact card you deliberately hand out**, which carries your name; and
- **inside your own backup**, encrypted so that only you can read it (see the backup
  document).

It is **never** written to a public relay for an unaddressed audience to read. This is a
product constraint the app enforces through its own send discipline — not a guarantee the
network makes. Encryption keeps relays from seeing your name or avatar on the wire; the
"nothing public" half additionally relies on the people who legitimately hold your in-group
profile not re-posting it (§5.1).

---

## 2. Your identity

The first time you use the app, it **generates an identity for you automatically** — a
cryptographic key pair — with no sign-up, email, or password. That identity is what makes
messages provably yours. Its public half has a shareable form (an **npub**) you can hand to others so
they can add you. Its private half normally **stays on your device** (and is what a backup
protects — see the backup document); alternatively the app can delegate signing to an
external signer — a browser extension or a remote signing service — in which case the private
key lives there instead of on the device.

Being invitable to groups requires publishing small **cryptographic key packages** to
relays. These are the one identity-related thing that *is* public — but they carry **no
personal data**: they are pure cryptographic material that lets someone add you to a
group, and reveal nothing about your name or avatar. They are consumed as people invite
you, so the app keeps a supply published.

---

## 3. Your profile

Your profile is two things you control: a **display name** and an **avatar**.

- The display name is capped at a modest length (32 bytes); beyond your choice of text
  there are no other constraints.
- An avatar is **always present** — if you never choose one, the app fills in a default. A
  name, by contrast, is optional: until you set one, you appear under a shortened form of
  your identity key rather than a chosen name.

Your profile lives **on your device**. Editing it updates immediately everywhere it is
shown to you, and marks your backup as needing to be re-saved. Editing does **not** post
anything publicly (§1); instead it *propagates* over the two private channels (§5).

---

## 4. Identity settings vs. profile

The app separates **personal presentation** from **technical identity**:

- Presentation — your name, avatar, and app preferences (theme, language) — is what you
  routinely edit.
- Technical identity — your shareable npub, your backup and restore controls, and relay
  configuration — is kept apart, so day-to-day profile editing never sits next to the
  levers that could disrupt your account.

The most destructive of those levers, **wiping the account**, requires an explicit typed
confirmation before it will proceed — it cannot be triggered by a single stray action.

---

## 5. How your profile reaches other people

A profile is only useful if others can see it, so the app propagates it — but only over
the two private channels of §1, and by two different mechanisms.

### 5.1 Inside a group

Within a group, your profile is a **signed** profile message sent as an encrypted group
message — visible only to members. You share it **proactively**: your app publishes your
signed profile to a group when you join, and re-sends it to every group you are in whenever
you edit your profile, so members normally have it without asking. A member who is still
missing someone's profile — or who holds one that has gone **stale** (more than about a week
old) — **requests** a fresh copy from the group, and the owner (or a relayer, below)
answers.

The signature enables **relaying on someone's behalf**: if the person whose profile is
needed is offline, any *other* member who already holds their signed profile can relay it to
whoever is missing it. Because it is signed by its owner, a relaying member cannot tamper
with or forge it, and the relayed copy is always attributed to its true author, never to the
relayer — staying inside the group's encrypted channel throughout. When two sources could
answer, the **most recent** profile wins.

### 5.2 With a single contact

With a 1:1 contact, your profile travels as a sealed private message addressed to that one
person. This channel **heals itself**: when a contact is missing your name or avatar, their
app asks for it and yours answers. It retries on a slowing schedule, but **not forever** — it
gives up after about a month of unanswered attempts, and treats an answer that brings a name
but no avatar as complete enough to stop; a later sign that the contact is active can restart
it. Your app also **pushes** your profile proactively — to a new contact the moment a pairing
completes, and to all your active contacts whenever you edit — so contacts usually have your
latest details without asking. (A given asker is answered at most about once an hour, a limit
that resets when the app restarts.)

Two properties of this channel are deliberate:

- **The 1:1 profile message is unsigned** — unlike the in-group one. A *signed* profile
  handed to a single recipient would be a self-contained, publishable artifact they could
  re-post to a public relay as *your* public profile. Sending it unsigned removes that risk;
  its authenticity instead comes from the sealed envelope, which proves who sent it. The
  in-group profile (§5.1) *is* signed despite this — a deliberate, narrower trade: a
  signature there is the price of letting one member relay another's profile without being
  able to forge it, and the audience is the already-trusted group rather than a lone
  recipient. (This is **ADR-007**.)
- **Blocking a contact stops this exchange in both directions.** A blocked contact is sent
  no profile and their updates are not taken in — even though the underlying "ever-known"
  trust never forgets them (see the Contacts document). Profile disclosure is gated on the
  contact being *currently active*, not merely ever-known.

---

## 6. Seeing other people's profiles

- **In a group**, a newly added member first appears without a profile — recognisably
  present but not yet named — until their profile arrives by §5.1; then their name and
  avatar replace the placeholder. A member approved through a join request can carry the
  name they gave, so they are named immediately rather than waiting.
- **A contact's** name and avatar arrive over §5.2 and are cached locally, so you see them
  without re-fetching.
- **A stranger's** profile is never solicited or accepted: a profile request from someone
  you have no connection to is ignored, and an unsolicited profile message from a stranger
  is discarded — it creates no contact and caches nothing. Profile exchange rides on the
  same reachability gate as messaging (the walled garden).
- Where two versions of the same person's profile exist, the **more recently updated** one
  wins, so profiles converge rather than flip-flop.

---

## 7. Edge cases and how they resolve

**A member is offline when their profile is needed.** Another member who holds their signed
profile relays it on their behalf (§5.1); no one has to wait for the absent member to come
back.

**A profile message forged to look like someone else's.** Rejected before it is accepted —
in a group by the owner's signature, in a 1:1 by the sealed sender identity. A forged
profile never overwrites a real one.

**A profile arrives out of order or from a stale source.** The most-recently-updated
version wins, so a late-arriving old copy cannot clobber a newer one.

**A contact never answers a profile request.** The 1:1 heal loop backs off and, after about
a month of silence, gives up; a later sign the contact is active restarts it (§5.2).

**A contact you have blocked.** No profile flows to or from them, in either direction,
despite their permanence in the ever-known set (§5.2).

**You have not set a name yet.** Your app will not answer a *contact's* profile request
until you have a name to share. (Inside a group it still publishes whatever profile you
currently have.)

**A malformed or unsafe avatar reference.** Both channels apply the same rule: an avatar
reference is accepted only if it is a secure (`https://`) or scheme-relative (`//`) web
address of bounded length with no whitespace; anything else — an insecure address, an
embedded or script reference, an oversized value — is rejected on receipt. (An avatar
reference stored before this check existed stays until that member sends a newer profile.)
On the 1:1 channel the whole profile message
carrying it is rejected; *inside a group* only the avatar is dropped and the rest of the
profile (the name) is still accepted, so the member shows by name without a picture.

**Someone you share several groups with edits their profile.** The update lands in **every**
group you share with them, not just one.

**Wiping the account.** Only proceeds after an explicit typed confirmation; it clears the
identity and profile from the device.

---

## 8. Deliberately out of scope

- **Any public profile.** There is no mode in which your name or avatar is posted to a
  public relay — the app has no public-profile surface at all.
- **Fetching a stranger's profile.** The app does not look up the profile of an arbitrary
  key you have no connection to.
- **Multi-device profile sync as a live service** — a profile is local to a device;
  carrying it to another device is the job of backup/restore (see the backup document), not
  a continuous sync.

---

## Sources

Reconciled across product specifications, acceptance criteria, architecture decisions, the
shipped implementation, and the automated test suite:

- `CLAUDE.md` — the profile privacy invariant (never broadcast profile metadata).
- `specs/epic-profile-settings-separation/` — separating presentation from technical
  identity.
- `specs/epic-member-profile-discovery-and-relay-on-behalf/` and
  `specs/profile-discovery-and-relay.md` — in-group profile discovery, signed profiles, and
  relaying on behalf.
- `specs/epic-direct-contact-profile-exchange/` and
  `specs/direct-contact-profile-exchange-spec-request.md` — the 1:1 self-healing profile
  channel.
- `docs/adr/ADR-007` (gift-wrapped 1:1 profile exchange; the unsigned-announce and
  active-contact-disclosure reasoning), building on `ADR-002`/`ADR-005` (the reachability
  gate profile exchange rides on).
- Implementation under `app/src/lib/nostrKeys.ts`, `app/src/context/` (identity and
  profile), `app/src/lib/marmot/profileSync.ts` and `profileRequestSync.ts` (group
  profiles and relay-on-behalf), `app/src/lib/dmProfile/` (1:1 exchange), `app/src/lib/
  avatar.ts`, and the profile/settings pages.
- The profile, avatar, member-profile, and `dm-profile-*` end-to-end specs — including the
  test asserting **zero** public kind-0 events are published — and the unit tests for
  profile serialization and LWW merge.
