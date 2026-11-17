/**
 * send — outbound group sends and the own-send lifecycle. Public surface of the module; other
 * modules import only from here.
 */
export {
  buildGroupRumor,
  createGroupRumorSender,
  isSignalRumor,
  type GroupRumorSender,
  type GroupRumorSenderOptions,
  type PreparedGroupRumor,
  type SendableGroup,
  type SendGroupRumorResult,
} from './sendGroupRumor';
export {
  createOwnRowTracker,
  OWN_SEND_CONFIRM_TIMEOUT_MS,
  type OwnRowStatus,
  type OwnRowStatusPort,
  type OwnRowTracker,
  type OwnRowTrackerOptions,
  type RegisterOptions,
} from './ownRowTracker';
export {
  createGroupOpQueue,
  GroupOpError,
  type CommitOpGroup,
  type GroupOpErrorCode,
  type GroupOpOptions,
  type GroupOpQueue,
  type GroupOpQueueOptions,
} from './groupOpQueue';
