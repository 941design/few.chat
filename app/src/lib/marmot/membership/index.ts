/**
 * membership — leave eligibility, leave, local purge (abandon) and library-driven membership changes (removal, disband).
 * Public surface of the module; other modules import only from here.
 */
export {
  decideLeave,
  readLiveMembers,
  readRosterFacts,
  selectLeaveModalState,
  type LeaveDecision,
  type LeaveModalState,
  type RosterFacts,
  type RosterReadableGroup,
} from './leaveEligibility';
export {
  createGroupLeaver,
  buildLeftAnnouncementContent,
  DEFAULT_ANNOUNCE_TIMEOUT_MS,
  DEFAULT_LEAVE_DEADLINE_MS,
  LEFT_ANNOUNCEMENT_KIND,
  LeaveTimeoutError,
  type GroupLeaver,
  type GroupLeaverDeps,
  type LeavableGroup,
  type LeaveMode,
  type LeaveResult,
  type LeaveSettled,
} from './leaveGroup';
export {
  createLocalGroupPurger,
  PurgeError,
  type LocalGroupPurger,
  type PurgeOptions,
  type AbandonableGroup,
  type GroupDataPurger,
  type PurgeLocalGroupDeps,
  type PurgeStepFailure,
  type PurgeStepName,
} from './purgeLocalGroup';
export {
  createDisbandMarker,
  createGroupRemovalHandlers,
  DEFAULT_REMOVAL_SETTLE_MS,
  type DisbandableGroup,
  type DisbandedMark,
  type DisbandMarker,
  type DisbandMarkerDeps,
  type EnqueueJob,
  type GroupRemovalDeps,
  type GroupRemovalHandlers,
  type ListedGroup,
  type OverlayRecord,
} from './groupNotifications';
