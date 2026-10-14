# Backup & recovery

*Getting your account back on a new device: the seed phrase that recovers your identity,
the encrypted relay backup that restores your app state, and how direct-message history is
re-fetched — with an honest account of what comes back and what does not.*

---

## 1. Three separate things

Recovering an account is really three separate mechanisms, and it helps to keep them apart:

- **Your identity** is recovered from a **seed phrase** (§2) — words only you hold.
- **Your app state** (settings, profile, groups, recent group messages, invite links) is
  recovered from an **encrypted backup you publish to relays** (§3–§4).
- **Your direct-message history** is neither of those — the half of each conversation that
  was sent *to you* is **re-fetched from relays** (§6); the half you *sent* is not
  recoverable.

Because they are separate, recovery is only ever as complete as the weakest of the three:
without the seed phrase there is no account at all; without a backup you keep your identity
but lose your saved state; and DM history returns only partially, and only as far as relays
still hold it.

---

## 2. Your identity and the seed phrase

When the app first generates your identity, it also gives you a **seed phrase** that stands in
for it — twelve words for a new identity (an older identity may have a longer, 24-word phrase;
either is accepted on restore). The phrase is **not** stored in the backup or sent anywhere;
it lives only on your device, where you can view it again whenever you need to write it down.

- Entering the seed phrase on a new device re-derives your **exact same identity** — the same
  public identity others know you by. Restoring the identity also fetches your existing display
  name so your profile is not blank, and does so **read-only** — it never re-broadcasts your
  profile. (Only the name is recovered this way, not the avatar.)
- **The seed phrase is the only way to recover your identity.** There is no email, no password
  reset, no support recovery. As long as one device survives you can read the phrase off it; but
  if you lose the phrase *and* every device, the account is **gone** — no one, including the
  app's makers, can restore it.

Recovering the identity brings back *who you are*, not your *state* — for that, the backup below
is restored on top.

---

## 3. The relay backup

The app keeps an **encrypted backup of your app state on relays**, so a new device can be brought
back close to where you left off.

**What the backup contains:** your settings and profile, your groups and their cryptographic
state, your **most recent** group messages (a small, capped window per group — not the full
history), the member profiles you have learned, and your invite links. It does **not** contain
your contacts, your direct messages, your "ever-known" reachability, your relay configuration,
your choice of external signer, cached media, or unread/reaction state.

**How it is protected:** the state itself is a **single blob encrypted to yourself** — only your
own key can decrypt it, and relays see only ciphertext with none of its *contents* labelled.
What relays (and anyone looking) *can* see is unavoidable: that this identity uses the app, that
a backup exists, how large it is, and when it was last updated. The privacy is of the contents,
not of the backup's existence.

**When it is saved:** automatically, when your profile or your groups change, and when you
background the app — but **debounced**, so it publishes at most once every few minutes. Two
honest consequences follow: a change made and then immediately followed by closing the app,
inside that window, may **not** be captured; and a change to settings alone does not by itself
trigger a save — it rides along with the next one that does.

**When saving fails:** if no relay accepts the backup (or the app is not yet connected), it is
retried in the background — after about half a minute, then two minutes, then every ten minutes,
up to five times; changes made meanwhile are included in the next retry, and a change after the
last retry starts a fresh round. There is no on-screen backup
status; a backup that keeps failing is not signalled to you.

**Only with the app's own key:** automatic backups are made only when the app holds your key
itself. If you sign in with an **external signer** (a browser extension or a remote signer), no
relay backup is saved.

---

## 4. Restoring app state

After recovering your identity, the app looks for your **latest** backup and offers to restore
it; you can also **decline** and keep an identity-only recovery. Restoring decrypts the backup
with your recovered key and **adds it on top of** the device's current state:

- **It is non-destructive.** Restore only writes the categories the backup carries — it
  overwrites your settings and profile, adds or updates the groups it contains, and **merges**
  group messages (a message already present locally is kept). It never deletes data the backup
  does not carry: anything else already on the device — other groups, direct messages, contacts,
  relay settings — is left untouched. (This matters mainly on a device that already has state; on
  a truly fresh device there is nothing to preserve.)
- If several backups exist, the **most recent** is used. A backup written by a **newer,
  incompatible** version of the app — or one that cannot be read — is refused as a whole before
  anything is written, rather than applied wrongly or in part.

**When there is nothing to restore, you are told why.** Alongside the identity-recovered
confirmation, the app says which of these happened:

- **No backup was found** — only your identity came back.
- **The relays could not be reached** — the app offers to **check again**, which repeats only the
  backup lookup (your identity stays recovered).
- **A backup was found but this app version can't use it** — updating the app and recovering
  again is the way forward.

If applying a found backup fails partway, you are told that the backup could not be applied;
your settings and profile are only overwritten once everything else in the backup was written.

**Your old backup is protected until you decide.** From the moment you recover your identity until
you restore or skip the backup found on relays, the app does not save a new backup over it. If you
leave before deciding — or the relays could not be reached — the question comes back the next time
you open Settings, and automatic backups stay paused until then. Closing the dialog without choosing
counts as leaving, not as skipping. A backup written by a newer app version is never overwritten by
an older one. **Known limit:** the open question is raised only in Settings — someone who never
opens Settings again keeps automatic backups paused without being told.

The "relays could not be reached" message is inferred from the relays not answering in time. When
only some of your relays are down, the app may report that no backup was found even though a relay
that did not answer holds one.

---

## 5. What comes back, and what does not

| Recovered by | What returns |
|---|---|
| **The seed phrase** | Your identity (keys / npub) |
| **The relay backup** | Settings, profile, groups and their cryptographic state, your *recent* group messages, learned member profiles, invite links |
| **Re-fetching from relays** | The **inbound** half of your direct messages (§6); contacts and reachability rebuilt from your current groups *and* from any DM partners whose messages re-appear |

**What does *not* come back:**

- **Your own sent direct messages.** Only messages that were addressed *to you* can be
  re-fetched (§6). The messages *you* sent were sealed to the other person and kept only on this
  device, so on a new device your side of every conversation is missing — you see the other
  person's messages but not your own replies.
- **Group message history older than your backup allows.** Only your recent group messages are
  in the backup, and older group messages are protected by *forward secrecy* — they can be
  recovered from relays only as far back as the restored cryptographic state can still decrypt.
  History older than that is **permanently gone** on a new device.
- **Contacts and reachability exactly as they were.** These are **rebuilt** — from your current
  group membership and from DM partners whose messages re-appear — rather than carried in the
  backup. Someone you knew only through a 1:1 contact, with no messages the relays still hold,
  is not automatically restored.
- **Device-local state:** relay configuration, which external signer you used, unread counts,
  reactions, and cached media. These are re-derived or simply start fresh.

---

## 6. Direct-message history

Direct messages are **not** in the relay backup, but the **incoming** half is recoverable, because
a message sent to you is sealed and stays on relays addressed to you. On a new device with
your recovered identity, the app **re-fetches** those messages and decrypts them, rebuilding the
other person's side of each conversation.

Two limits are important and honest:

- **Your own sent messages do not come back.** A message you send is sealed to the *recipient*,
  not to yourself, and no self-addressed copy is kept on relays — your outgoing side lives only
  in this device's local storage, which the backup does not include. A restored conversation
  therefore shows the other person's messages but not your replies.
- **Recovery is bounded by what relays kept.** Relays are not obliged to store events forever, so
  even the inbound half returns only as far back as relay retention allows; anything relays have
  discarded is unrecoverable.

The app reads these re-fetched messages leniently (older and malformed formats included) and
repairs damaged entries as it loads them.

---

## 7. Encryption and privacy

- **The backup's contents are readable only by you.** They are encrypted to your own key; relays
  and any other party see only ciphertext, and the individual categories inside are not labelled.
  (That a backup exists for your identity, and its size and update times, are visible — see §3.)
- **Restoring never makes your profile public.** Fetching your name during recovery is read-only;
  the app never re-broadcasts it (consistent with the never-public rule in the Profiles document).
- **An honest tradeoff.** Because the backup carries your recent group messages and group
  cryptographic state encrypted *only to your own key*, anyone who obtains your key can read the
  backed-up content. The backup deliberately trades a measure of forward secrecy for
  recoverability, so that losing a device does not lose your recent state.

---

## 8. Edge cases and how they resolve

**You lose the seed phrase and every device.** The account is unrecoverable — there is no other
path back (§2). While any device survives, the phrase can be read from it.

**You restore onto a device that already has state.** Restore **merges**: it updates settings,
profile, and the groups it carries, keeps any group messages already present, and leaves
everything the backup does not contain — other groups, direct messages, contacts, relay settings —
in place (§4).

**Several backups exist.** The most recent one is used.

**The backup was written by a newer app version, or is damaged.** It is refused as a whole and you
are told the backup can't be used by this app version (§4).

**Relays are unreachable during restore.** Your identity is still recovered; you are told the
relays could not be reached and can check again (§4).

**Relays are unreachable when a backup is due.** The backup is retried in the background a few
times; the next change to your groups or profile, or putting the app in the background, tries
again (§3).

**A new device restores, but relays have aged out old messages.** Group history beyond what the
restored cryptographic state can decrypt is gone regardless (§5); the inbound half of DM history
returns only as far as relays still hold it (§6).

**Your sent messages after a device loss.** Not recoverable — only messages sent *to* you are on
relays for you to re-fetch (§6).

**The group's cryptographic state can't be restored cleanly.** The affected group cannot be
resumed from the backup and would have to be rejoined.

---

## 9. Deliberately out of scope

- **Recovering an account without its seed phrase** — there is no reset or support-side recovery.
- **Backing up direct messages** — the inbound half is recovered by re-fetching from relays
  (bounded by retention); the sent half is not backed up and is not recoverable.
- **Backing up cached media files** — media is not part of the backup.
- **Live multi-device sync** — the backup restores or tops up a device; it is not a mechanism for
  keeping two active devices continuously in step (contacts, reachability, unread, and reactions
  are per-device).
- **Restoring group history older than the restored cryptographic state can decrypt** — forward
  secrecy makes it unrecoverable on a new device.

---

## Sources

Reconciled across product specifications, acceptance criteria, the shipped implementation, and the
automated test suite:

- `specs/relay-backup.md` and `specs/epic-relay-backup/` — the encrypted relay backup (contents,
  encrypt-to-self, save triggers); its restore section now describes the shipped
  **non-destructive merge**. `specs/epic-backup-restore-reliability/` — distinct restore outcomes,
  validate-before-apply, and background retry of failed backups.
- `specs/dm-message-recovery.md` and `specs/epic-dm-message-recovery/` — recovering the inbound
  half of direct-message history by re-fetching from relays, with lenient parsing and self-heal.
- `specs/spec.md` / `specs/user-stories.md` — seed-phrase identity recovery.
  (`specs/peer-backup.md` describes a complementary peer-stored layer that is **not shipped**; the
  mechanism documented here is the relay backup.)
- Implementation under `app/src/lib/backup/relayBackup.ts` (assembly, self-encryption, publish, and
  the documented non-destructive restore/merge), `app/src/lib/nostrKeys.ts` with the seed/mnemonic
  handling (identity recovery), and the direct-message historical re-fetch and self-heal in the
  chat-persistence and DM-subscription code.
- The `groups-seed-phrase`, `groups-seed-recovery`, `dm-historical-recovery`, and
  `groups-migration-backfill` end-to-end specs, and the unit tests for backup assembly, lookup
  outcomes, validation, restore, scheduling/retry, and the seed mnemonic — including the assertion that the profile is never broadcast on restore.
