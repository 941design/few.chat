/**
 * membership — leave eligibility, leave, local purge (abandon) and library-driven membership changes (removal, disband).
 * Public surface of the module; other modules import only from here.
 */
export {
  decideLeave,
  readLiveMembers,
  readRosterFacts,
  selectLeaveModalState,
  type RosterReadableGroup,
} from './leaveEligibility';
export {
  createGroupLeaver,
  buildLeftAnnouncementContent,
  LeaveTimeoutError,
  type GroupLeaver,
  type GroupLeaverDeps,
  type LeavableGroup,
} from './leaveGroup';
export {
  createLocalGroupPurger,
  PurgeError,
  type LocalGroupPurger,
  type AbandonableGroup,
  type GroupDataPurger,
  type PurgeLocalGroupDeps,
} from './purgeLocalGroup';
export {
  createDisbandMarker,
  createGroupRemovalHandlers,
  type ListedGroup,
  type OverlayRecord,
} from './groupNotifications';
export { removeMember } from './removeMember';
export { cancelInvitation } from './cancelInvitation';
export { grantAdmin } from './setAdmins';
export { renameGroup } from './renameGroup';
