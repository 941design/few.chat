# Deleting an image while it is still uploading does not stick

Source: BACKLOG.json finding `deleting-dm-image-while-still-uploading` (2026-10-18; AGENT-DECIDES loop item 13).

## Actual
While an own image uploads, its row carries a random temporary id (ContactChat `sendImageMessage`,
and the same pattern in ChatStoreContext's group image send). The message actions (delete) are offered on that row.
Deleting it publishes a delete for the temporary id — an id no peer ever sees — and hides the row; when
the upload finishes, the final row is added under the real event id and stored untombstoned. The image
comes back, and the peer keeps it. docs/behavior/message-editing-and-deletion.md §8 states the limitation.

## Expected
An image that is still uploading offers no message actions; once uploaded (final id), it can be deleted
and the delete sticks.

## Fix
Optimistic image rows carry `uploading: true`; `canShowMessageActions` returns false for them; the final
row drops the flag; the DM and group delete/edit handlers refuse an uploading row (seam backstop).

## Test
Unit: canShowMessageActions for an uploading row; source scan that both image sends set the flag on the
optimistic row and not on the final row, and that the handlers refuse it. E2E: the full gate.
