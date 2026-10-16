# Acceptance Criteria: Group Polls

## AC-1: Poll and Vote Persistence
- `pollPersistence.ts` exports `loadPolls(groupId)`, `savePoll(poll)`, `loadVotes(pollId)`, `saveVote(vote)`, `clearPollData(groupId)` functions
- Polls are stored under IDB key `quizzl:polls:{groupId}` using idb-keyval
- Votes are stored under IDB key `quizzl:poll-votes:{pollId}` using idb-keyval
- `savePoll` deduplicates by poll `id` (upsert semantics)
- `saveVote` uses compound key `{pollId}:{voterPubkey}` — latest vote replaces previous
- `clearPollData(groupId)` removes all polls and their votes for the group

## AC-2: Poll Sync Module
- `pollSync.ts` exports constants `POLL_OPEN_KIND = 10`, `POLL_VOTE_KIND = 11`, `POLL_CLOSE_KIND = 12`
- `serialisePollOpen(payload: PollOpenPayload)` returns JSON string
- `parsePollOpen(content: string)` returns `PollOpenPayload | null` with validation
- `serialisePollVote(payload: PollVotePayload)` returns JSON string
- `parsePollVote(content: string)` returns `PollVotePayload | null` with validation
- `serialisePollClose(payload: PollClosePayload)` returns JSON string
- `parsePollClose(content: string)` returns `PollClosePayload | null` with validation
- All parse functions return `null` for malformed input

## AC-3: MarmotContext Poll Integration
- MarmotContext exposes a `pollVersion` counter (number, starts at 0)
- The subscription rumor callback dispatches kind 10 to `savePoll` (converting PollOpenPayload to Poll record with `closed: false`)
- The subscription rumor callback dispatches kind 11 to `saveVote` (converting PollVotePayload to PollVote record)
- The subscription rumor callback dispatches kind 12: verifies sender matches poll's `creatorPubkey`, then updates poll with `closed: true` and final results
- After each successful IDB write, `pollVersion` increments by 1
- Kind 11 messages for closed polls are silently ignored
- Kind 12 from non-creator senders are silently ignored

## AC-4: PollStoreContext
- `PollStoreContext` provides: `polls` (Poll[]), `votes` (Record<string, PollVote[]>), `createPoll`, `castVote`, `closePoll`, `loading`
- `polls` re-reads from IDB when `pollVersion` changes (same pattern as chatVersion in ChatStoreContext)
- `createPoll(title, description, options, pollType)` sends kind 10 + kind 9 chat announcement, persists poll locally, returns poll ID
- `castVote(pollId, responses)` sends kind 11, persists vote locally
- `closePoll(pollId)` tallies votes from IDB, sends kind 12 + kind 9 chat results, updates poll record
- `closePoll` is a no-op if caller's pubkey !== poll's creatorPubkey
- Active polls are sorted by createdAt descending (newest first)

## AC-5: CreatePollModal
- Modal opens from a "Poll" button in the chat section
- Title input: required, max 200 chars
- Description textarea: optional, max 500 chars
- Options: minimum 2, maximum 10 text inputs. "Add option" button appends a row; remove icon deletes a row
- Poll type toggle: "Single choice" (default) / "Multiple choice"
- "Create" button disabled until title and >= 2 non-empty options exist
- On create: generates UUID, assigns sequential option IDs (A, B, C...), calls `createPoll`, closes modal

## AC-6: PollCard and PollResultsCard
- `PollCard` (active poll): shows title, description, options as radio/checkbox inputs, "Vote"/"Update Vote" button, participant count
- Radio buttons for singlechoice, checkboxes for multiplechoice
- After voting, pre-selects previous choices and shows check mark
- Participant count visible but per-option tallies hidden while poll is open
- Creator sees a "Close Poll" button; non-creators do not
- `PollResultsCard` (closed poll): shows title, option bars with counts and percentages, total voter count

## AC-7: PollPanel and Layout
- `PollPanel` renders as a collapsible side panel listing active polls (newest first) then closed polls
- Panel header shows count of active polls: "Polls (N)"
- `GroupDetailView` places `PollPanel` beside `GroupChat` in an HStack layout
- A toggle button shows/hides the poll panel

## AC-8: Chat Poll Messages
- `GroupChat` detects structured chat messages with `type: "poll_open"` and renders `PollChatAnnouncement` instead of plain text bubble
- `PollChatAnnouncement` shows: "{Creator} started a poll: {title}"
- `GroupChat` detects structured chat messages with `type: "poll_close"` and renders `PollChatResults` with horizontal bars, percentages, and total voter count
- Plain text messages continue to render normally

## AC-9: Edge Cases
- Vote arriving after poll close is silently dropped
- Vote referencing unknown poll ID is queued and applied when poll-open arrives
  - The queue is per group (a vote is only ever applied to the poll with that ID in the group it was received in), persisted across reloads, and bounded: at most 10 distinct queued polls per voter per group (further ones dropped), at most 200 entries per group (oldest evicted), entries expire 7 days after receipt
  - A queued vote passes the same validation as a live vote when applied (authenticated sender as voter, unknown option IDs dropped, single-choice capped to one, a vote with no valid option discarded)
- Each vote carries a per-voter sequence number; among a voter's votes for one poll the greatest (seq, created_at, rumor id) wins on every member regardless of delivery order; votes without seq rank as seq 0. *(amended 2026-10-15, bug poll-vote-ordering-and-early-close)*
- A close referencing an unknown poll ID is queued per group and poll, bound to its authenticated sender, and applied when the poll-open arrives only if the open's authenticated creator equals that sender; otherwise discarded. The queue is persisted across reloads, bounded (one entry per poll and sender, at most 10 per sender per group, at most 50 per group, oldest evicted) and expires 7 days after receipt. Applying it replays queued votes first and recomputes the tally from stored votes (AC-POLL-4). The poll_close chat announcement for an unknown poll is held the same way and re-run through the announcement gate when the poll-open arrives. *(amended 2026-10-15, bug poll-vote-ordering-and-early-close)*
- A held close's tally counts, per voter, the newest vote this member received no later than the creator's held close (local receipt order, the same cut-off a live close applies; receipt order persists across reloads and clock changes). Earlier votes of a voter that arrived before a newer one are kept (at most 20 per voter and poll, stored and queued; beyond that the earliest is dropped and a held close received before all kept votes does not count that voter — documented residual) so every arrival order of open, close and changed votes gives the open-first tally. A sender's own vote seq is allocated atomically (read-max-increment-write, serialised across tabs via Web Locks where available) and durably before the vote is sent, and never reused; if the allocation fails the vote is not sent. A live close or poll_close announcement whose storage read/write fails (or whose held state cannot be confirmed) is held in the same queue and applied at the next message of that poll, a poll_close announcement included; an announcement for an already-closed poll shows the poll's stored tally. *(amended 2026-10-16, bug poll-residual-ordering-and-close-retry)*
- Close payload's `results` and `totalVoters` are ignored; each client recomputes the final tally from the votes it has stored for that poll in that group (AC-POLL-4, epic group-message-author-auth-app-layer)
- A received poll-open exceeding the creation limits (more than 10 options, title over 200, description over 500, option label over 100 characters) is rejected
- Option text truncated at 100 chars in PollCard; full text accessible
- leaveGroup clears poll data for that group (clearPollData called)
