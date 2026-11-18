/**
 * send — outbound group sends and the own-send lifecycle. Public surface of the module; other
 * modules import only from here.
 */
export {
  buildGroupRumor,
  createGroupRumorSender,
  isSignalRumor,
  type GroupRumorSender,
  type SendableGroup,
} from './sendGroupRumor';
export {
  createOwnRowTracker,
  OWN_SEND_CONFIRM_TIMEOUT_MS,
  type OwnRowStatus,
  type OwnRowStatusPort,
  type OwnRowTracker,
} from './ownRowTracker';
export {
  createGroupOpQueue,
  GroupOpError,
  type CommitOpGroup,
  type GroupOpOptions,
  type GroupOpQueue,
} from './groupOpQueue';
