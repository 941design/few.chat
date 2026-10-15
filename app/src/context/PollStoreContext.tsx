/**
 * PollStoreContext — manages polls and votes for the active group.
 *
 * Mirrors ChatStoreContext: loads from IDB, re-reads when MarmotContext
 * bumps pollVersion, and provides create/vote/close actions.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import type { Poll, PollVote, PollOptionDef, PollResult } from '@/src/lib/marmot/pollPersistence';
import {
  loadPolls,
  savePoll,
  loadVotes,
  saveVote,
} from '@/src/lib/marmot/pollPersistence';
import {
  POLL_OPEN_KIND,
  POLL_VOTE_KIND,
  POLL_CLOSE_KIND,
  serialisePollOpen,
  serialisePollVote,
  serialisePollClose,
} from '@/src/lib/marmot/pollSync';
import type { PollOpenPayload, PollVotePayload, PollClosePayload } from '@/src/lib/marmot/pollSync';
import { useChatStore } from './ChatStoreContext';

type MarmotGroupType = import('@internet-privacy/marmot-ts').MarmotGroup;

interface PollStoreContextValue {
  polls: Poll[];
  /** Votes keyed by pollId */
  votes: Record<string, PollVote[]>;
  createPoll: (
    title: string,
    description: string | undefined,
    options: { label: string }[],
    pollType: 'singlechoice' | 'multiplechoice',
  ) => Promise<string | null>;
  castVote: (pollId: string, responses: string[]) => Promise<void>;
  closePoll: (pollId: string) => Promise<void>;
  loading: boolean;
}

const PollStoreContext = createContext<PollStoreContextValue>({
  polls: [],
  votes: {},
  createPoll: async () => null,
  castVote: async () => {},
  closePoll: async () => {},
  loading: false,
});

interface PollStoreProviderProps {
  groupId: string | null;
  group: MarmotGroupType | null;
  pubkey: string;
  /** Bumped by MarmotContext when a poll message is persisted to IDB */
  pollVersion?: number;
  children: React.ReactNode;
}

/**
 * WORKAROUND: ts-mls forbids application messages when unappliedProposals
 * is non-empty. This catches the error, commits pending proposals, and
 * retries. Requires the sender to be an admin (commit() has an admin check).
 *
 * Root cause: admin promotion during invite can silently fail, leaving
 * members unable to commit. The real fix is to guarantee admin promotion
 * succeeds (retry / block invite until confirmed).
 *
 * See also: MarmotContext onMembersChanged auto-commit, ChatStoreContext
 * sendRumorSafe — same workaround applied there.
 */
const MAX_RETRIES = 3;
async function sendRumorSafe(
  group: MarmotGroupType,
  rumor: Parameters<MarmotGroupType['sendApplicationRumor']>[0],
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await group.sendApplicationRumor(rumor);
      return;
    } catch (err) {
      const isUnapplied = err instanceof Error && err.message.includes('unapplied proposals');
      if (!isUnapplied || attempt === MAX_RETRIES) throw err;
      console.warn(`[sendRumorSafe] unapplied proposals (attempt ${attempt + 1}/${MAX_RETRIES + 1}), committing…`);
      await group.commit();
    }
  }
}

/** Build a properly-hashed MIP-03 rumor for sendApplicationRumor. */
async function buildRumor(kind: number, content: string, pubkey: string, tags: string[][] = []) {
  const { getEventHash } = await import('applesauce-core/helpers/event');
  const rumor = {
    id: '',
    kind,
    pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

export function PollStoreProvider({
  groupId,
  group,
  pubkey,
  pollVersion,
  children,
}: PollStoreProviderProps) {
  const { sendMessage: sendChatMessage } = useChatStore();
  const [polls, setPolls] = useState<Poll[]>([]);
  const [votes, setVotes] = useState<Record<string, PollVote[]>>({});
  const [loading, setLoading] = useState(false);

  // Load polls from IDB on mount and when group changes
  useEffect(() => {
    if (!groupId) {
      setPolls([]);
      setVotes({});
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);

    loadPolls(groupId)
      .then(async (storedPolls) => {
        if (!active) return;
        setPolls(storedPolls);
        // Load votes for all polls
        const voteMap: Record<string, PollVote[]> = {};
        for (const poll of storedPolls) {
          voteMap[poll.id] = await loadVotes(groupId, poll.id);
        }
        if (active) setVotes(voteMap);
      })
      .catch(() => {
        if (active) {
          setPolls([]);
          setVotes({});
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, [groupId]);

  // Re-read from IDB when MarmotContext persists a new poll message
  useEffect(() => {
    if (!groupId || pollVersion === undefined || pollVersion === 0) return;
    loadPolls(groupId).then(async (storedPolls) => {
      setPolls(storedPolls);
      const voteMap: Record<string, PollVote[]> = {};
      for (const poll of storedPolls) {
        voteMap[poll.id] = await loadVotes(groupId, poll.id);
      }
      setVotes(voteMap);
    }).catch(() => {});
  }, [groupId, pollVersion]);

  const createPoll = useCallback(
    async (
      title: string,
      description: string | undefined,
      options: { label: string }[],
      pollType: 'singlechoice' | 'multiplechoice',
    ): Promise<string | null> => {
      if (!groupId || !group) return null;

      const pollId = crypto.randomUUID();
      const optionDefs: PollOptionDef[] = options.map((o, i) => ({
        id: String.fromCharCode(65 + i), // A, B, C, ...
        label: o.label,
      }));

      const openPayload: PollOpenPayload = {
        id: pollId,
        title,
        description,
        options: optionDefs,
        pollType,
        creatorPubkey: pubkey,
      };

      // Send poll-open MLS message (kind 10)
      const openRumor = await buildRumor(POLL_OPEN_KIND, serialisePollOpen(openPayload), pubkey);
      await sendRumorSafe(group, openRumor as any);

      // Send chat announcement via ChatStoreContext (handles optimistic UI + MLS send)
      const chatContent = JSON.stringify({
        type: 'poll_open',
        pollId,
        title,
        creatorPubkey: pubkey,
      });
      await sendChatMessage(chatContent);

      // Persist locally
      const poll: Poll = {
        id: pollId,
        groupId,
        title,
        description,
        options: optionDefs,
        pollType,
        creatorPubkey: pubkey,
        createdAt: Date.now(),
        closed: false,
      };
      await savePoll(poll);

      // Optimistically update state
      setPolls((prev) => [poll, ...prev]);

      return pollId;
    },
    [groupId, group, pubkey, sendChatMessage],
  );

  const castVote = useCallback(
    async (pollId: string, responses: string[]) => {
      if (!groupId || !group) return;

      const votePayload: PollVotePayload = { pollId, responses };

      // Send vote MLS message (kind 11)
      const rumor = await buildRumor(POLL_VOTE_KIND, serialisePollVote(votePayload), pubkey);
      await sendRumorSafe(group, rumor as any);

      // Persist locally
      const vote: PollVote = {
        id: `${pollId}:${pubkey}`,
        groupId,
        pollId,
        voterPubkey: pubkey,
        responses,
        votedAt: Date.now(),
      };
      await saveVote(vote);

      // Optimistically update state
      setVotes((prev) => {
        const existing = prev[pollId] ?? [];
        const filtered = existing.filter((v) => v.id !== vote.id);
        return { ...prev, [pollId]: [...filtered, vote] };
      });
    },
    [groupId, group, pubkey],
  );

  const closePoll = useCallback(
    async (pollId: string) => {
      if (!groupId || !group) return;

      const poll = polls.find((p) => p.id === pollId);
      if (!poll || poll.creatorPubkey !== pubkey) return;

      // Tally votes from state
      const pollVotes = votes[pollId] ?? [];
      const optionCounts = new Map<string, number>();
      for (const opt of poll.options) {
        optionCounts.set(opt.id, 0);
      }
      for (const v of pollVotes) {
        for (const r of v.responses) {
          optionCounts.set(r, (optionCounts.get(r) ?? 0) + 1);
        }
      }

      const results: PollResult[] = poll.options.map((opt) => ({
        optionId: opt.id,
        label: opt.label,
        count: optionCounts.get(opt.id) ?? 0,
      }));
      const totalVoters = pollVotes.length;

      const closePayload: PollClosePayload = { pollId, results, totalVoters };

      // Send close MLS message (kind 12)
      const closeRumor = await buildRumor(POLL_CLOSE_KIND, serialisePollClose(closePayload), pubkey);
      await sendRumorSafe(group, closeRumor as any);

      // Send chat results message via ChatStoreContext (handles optimistic UI + MLS send)
      const chatContent = JSON.stringify({
        type: 'poll_close',
        pollId,
        title: poll.title,
        results,
        totalVoters,
      });
      await sendChatMessage(chatContent);

      // Update local poll record
      const updated: Poll = { ...poll, closed: true, results, totalVoters };
      await savePoll(updated);

      // Optimistically update state
      setPolls((prev) => prev.map((p) => (p.id === pollId ? updated : p)));
    },
    [groupId, group, pubkey, polls, votes, sendChatMessage],
  );

  return (
    <PollStoreContext.Provider value={{ polls, votes, createPoll, castVote, closePoll, loading }}>
      {children}
    </PollStoreContext.Provider>
  );
}

export function usePollStore(): PollStoreContextValue {
  return useContext(PollStoreContext);
}
