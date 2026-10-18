# Sending a DM while an external signer is connected signs with the stored local key

Source: BACKLOG.json finding `connectndk-rebinds-external-signer` (filed 2026-10-18 while gating
backups on signer mode; AGENT-DECIDES loop item 7).

## Actual
`applyNdkSigner` puts a NIP-07/NIP-46 signer on the NDK singleton and clears the tracked local key.
Every later `connectNdk(privateKeyHex)` / `getNdk(privateKeyHex)` (DM send, edit, delete, reactions,
history fetch, notification watcher, call watcher, profile heal, pairing) sees "no tracked key" and
puts a `NDKPrivateKeySigner` for the stored local key back on the singleton. From then on, NDK
publishes are signed by the local key, not the external signer, until the next page load.
In NIP-46 mode the stored local key can even be a fresh random key (the identity is removed from
storage when the bunker is activated and regenerated on the next mount), so DMs go out under an
unrelated identity.

## Expected
While an external signer is active, the NDK singleton keeps it. Passing a local key to
`connectNdk`/`getNdk` does not rebind. Only an explicit disconnect of the external signer returns
NDK to the local key. An external signer applied before NDK exists is used when NDK is created.

## Test
Unit (real NDK singleton): after applyNdkSigner(ext), connectNdk/getNdk(localKey) keeps `ndk.signer === ext`,
and a signed event carries the external pubkey. Releasing the signer with a key binds that key.
Applying the signer before the singleton exists is honoured on creation. Local mode is unchanged:
the key rebinds when it changes.
