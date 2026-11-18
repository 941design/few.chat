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
  loadVotes,
  loadPendingVotes,
  allocateVoteSeq,
} from '@/src/lib/marmot/pollPersistence';
import { createVoteCaster } from '@/src/lib/marmot/pollCast';
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

import type { MarmotGroup as MarmotGroupType } from '@941design/marmot';
import { useMarmot } from './MarmotContext';

/**
 * Module-wide so casts on the same (group, poll) are serialised even across
 * provider remounts. A durable sequence reservation precedes each send.
 */
const castPollVote = createVoteCaster({
  loadVotes,
  loadPendingVotes,
  allocateVoteSeq,
});

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

export function PollStoreProvider({
  groupId,
  group,
  pubkey,
  pollVersion,
  children,
}: PollStoreProviderProps) {
  const { sendMessage: sendChatMessage } = useChatStore();
  const { groupSender } = useMarmot();
  const [polls, setPolls] = useState<Poll[]>([]);
  const [votes, setVotes] = useState<Record<string, PollVote[]>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!groupId) {
      setPolls([]);
      setVotes({});
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void loadPolls(groupId)
      .then(async (storedPolls) => {
        const entries = await Promise.all(storedPolls.map(async ({ id }) => [id, await loadVotes(groupId, id)] as const));
        if (!active) return;
        setPolls(storedPolls);
        setVotes(Object.fromEntries(entries));
      })
      .catch((error) => {
        if (active) console.warn('[polls] could not load the current snapshot', error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [groupId, pollVersion]);

  const createPoll = useCallback(
    async (
      title: string,
      description: string | undefined,
      options: { label: string }[],
      pollType: 'singlechoice' | 'multiplechoice',
    ): Promise<string | null> => {
      if (!groupId || !group || !groupSender) return null;

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
      await groupSender.sendGroupRumor(group, POLL_OPEN_KIND, serialisePollOpen(openPayload), []);

      // Send chat announcement via ChatStoreContext (handles optimistic UI + MLS send)
      const chatContent = JSON.stringify({
        type: 'poll_open',
        pollId,
        title,
        creatorPubkey: pubkey,
      });
      await sendChatMessage(chatContent);

      return pollId;
    },
    [groupId, group, groupSender, pubkey, sendChatMessage],
  );

  const castVote = useCallback(
    async (pollId: string, responses: string[]) => {
      if (!groupId || !group || !groupSender) return;

      // Derive the vote's seq, send the vote MLS message (kind 11) and
      // let the own history echo apply it through the same path as peers.
      await castPollVote({
        groupId,
        pollId,
        voterPubkey: pubkey,
        responses,
        send: async (votePayload: PollVotePayload) => {
          const prepared = groupSender.prepare(group, POLL_VOTE_KIND, serialisePollVote(votePayload), []);
          await prepared.send();
          return prepared.rumor;
        },
      });
    },
    [groupId, group, groupSender, pubkey],
  );

  const closePoll = useCallback(
    async (pollId: string) => {
      if (!groupId || !group || !groupSender) return;

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
      await groupSender.sendGroupRumor(group, POLL_CLOSE_KIND, serialisePollClose(closePayload), []);

      // Send chat results message via ChatStoreContext (handles optimistic UI + MLS send)
      const chatContent = JSON.stringify({
        type: 'poll_close',
        pollId,
        title: poll.title,
        results,
        totalVoters,
      });
      await sendChatMessage(chatContent);
    },
    [groupId, group, groupSender, pubkey, polls, votes, sendChatMessage],
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
