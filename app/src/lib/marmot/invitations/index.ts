/**
 * invitations — invite side of the invitation flow (S8); S11 adds decline durability, S12 the auto-accept correlation. Public surface of the module; other modules
 * import only from here. S9 adds the pending view, deny layer, caps and accept/decline; S10 adds the invite context (send, hold, handler, card view model).
 */
export {
  createKeyPackageLookup,
  normaliseAdvertisedRelayUrl,
  normaliseRelayUrl,
  MAX_KEY_PACKAGE_CANDIDATES,
  orderKeyPackageCandidates,
  INBOX_RELAY_LIST_KIND,
  KEY_PACKAGE_KIND,
  KEY_PACKAGE_LOOKUP_TIMEOUT_MS,
  MAX_ADVERTISED_RELAYS,
  NIP65_RELAY_LIST_KIND,
  type KeyPackageLookup,
  type KeyPackageLookupDeps,
  type KeyPackageLookupResult,
} from './keyPackageLookup';
export {
  createKeyPackageInviter,
  type AlreadyMember,
  type InviteGroup,
  type InviteOptions,
  type InviteOutcome,
  type KeyPackageInviter,
  type KeyPackageInviterDeps,
  type NoUsableKeyPackage,
} from './invite';
export { isPublicDnsHost } from './relayUrlPolicy';
export { createDenyLayer, type DenyLayer, type DenyLayerDeps } from './denyLayer';
export {
  applyPendingCaps,
  createTrustedSponsorPredicate,
  STRANGER_INVITATION_TTL_MS,
  DEFAULT_CAP_LIMITS,
  PENDING_PER_INVITER_CAP,
  PENDING_TOTAL_CAP,
  type CapContext,
  type CapLimits,
  type CappedInvitation,
  type CapSplit,
} from './caps';
export {
  createPendingInvitationView,
  type PendingInvitationsApi,
  type PendingInvitationView,
  type PendingInvitationViewDeps,
} from './pendingView';
export { createInvitationActions, InvitationActionError, type InvitationActions, type InvitationActionsDeps } from './acceptDecline';
export {
  INVITE_CONTEXT_KIND,
  MAX_COMBINING_MARKS_PER_BASE,
  MAX_CONTEXT_NAME_LENGTH,
  buildInviteContextContent,
  createContextSendingInviter,
  createInviteContextSender,
  parseInviteContextContent,
  sanitizeContextName,
  type ContextInviteGroup,
  type ContextSendingInviterDeps,
  type InboxRumorSender,
  type InviteContextPayload,
  type InviteContextSendResult,
  type InviteContextSender,
  type InviteContextSenderDeps,
} from './inviteContext';
export {
  CONTEXT_TTL_MS,
  HELD_PER_SENDER_CAP,
  HELD_TOTAL_CAP,
  TOMBSTONE_CAP,
  bindInviteContextToPendingView,
  createInviteContextStore,
  withInviteContextCleanup,
  type PendingListSource,
  type AddResult,
  type InvitationRef,
  type InviteContextRecord,
  type InviteContextStore,
  type InviteContextStoreDeps,
  type InviteContextStorePort,
} from './inviteContextStore';
export { createInviteContextHandler, type InviteContextHandlerDeps } from './inviteContextHandler';
export {
  buildInvitationCardViewModel,
  buildInvitationCardViewModels,
  type CardInvitation,
  type CardViewModelInput,
  type InvitationCardViewModel,
} from './invitationCardViewModel';
export { createAutoAccept, type AutoAccept, type AutoAcceptDeps, type OutboundRequestRef } from './autoAccept';
export {
  buildDeclinedAnnouncementContent,
  createDeclineDurability,
  DECLINED_MARKER_MAX_AGE_MS,
  DEFAULT_RETRY_DELAYS_MS,
  declinedDedupId,
  isTerminalRemovalError,
  createMarkerRecordingInviter,
  type DeclineDurability,
  type DeclineDurabilityDeps,
  type DeclineGroup,
  type DeclineOutcome,
  type MarkerRecordingInviterDeps,
} from './declineDurability';
