import { applyChatRumor, type ChatHandlerDeps } from '@/src/lib/marmot/handlers/chatHandler';
import type { ApplicationRumor, AuthenticatedSender, DispatcherContext } from '@/src/lib/marmot/handlers/types';
import { applyPollClose, applyPollOpen, applyPollVote, type PollHandlerDeps } from '@/src/lib/marmot/pollCore';
import { POLL_CLOSE_KIND, POLL_OPEN_KIND, POLL_VOTE_KIND } from '@/src/lib/marmot/pollSync';
import { CHAT_MESSAGE_KIND } from '@/src/lib/marmot/chatPersistence';

/** Direct reducer adapters for focused domain and storage assertions. */
export function createChatHandler(deps: ChatHandlerDeps) {
  return {
    kind: CHAT_MESSAGE_KIND,
    async handle(rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) {
      await applyChatRumor(rumor, ctx, sender, deps);
    },
  };
}

function pollReducer(kind: number, apply: typeof applyPollOpen) {
  return (deps: PollHandlerDeps) => ({
    kind,
    handle: (rumor: ApplicationRumor, ctx: DispatcherContext, sender: AuthenticatedSender) =>
      apply(rumor, ctx, sender, deps),
  });
}

export const createPollOpenHandler = pollReducer(POLL_OPEN_KIND, applyPollOpen);
export const createPollVoteHandler = pollReducer(POLL_VOTE_KIND, applyPollVote);
export const createPollCloseHandler = pollReducer(POLL_CLOSE_KIND, applyPollClose);
