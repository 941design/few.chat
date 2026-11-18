/**
 * Public surface of the `client` module (the only importer of the library
 * client's construction). Other modules reach it through this file only.
 */
export {
  bootstrapAccountClient,
  CLIENT_EVENT_NAMES,
  HISTORY_SWEEP_WAIT_MS,
  type AccountClient,
  type AccountClientHandle,
  type BootstrapInput,
  type BootstrapResult,
  type BootstrapSeams,
  type BootstrapStep,
  type InboxRelayListEnsure,
} from './createClient';
export { createJobQueue, INBOX_CALLBACK, type ClientCallbackScope, type ClientJobQueue, type JobQueue } from './fifo';
export {
  createAccountSigner,
  budgetPolicyFor,
  signerSupportsNip44,
  REMOTE_SIGNER_TIMEOUT_MS,
  type AppEventSigner,
  type SignerKind,
} from './signerAdapter';
export { createClientTransport, type ClientPool, type ClientTransport } from './transport';
export { openAccountStores, type OpenStoresResult } from './storage';
export { ensureKeyPackage, type KeyPackageEnsureOutcome } from './keyPackageEnsure';
export { createTeardown } from './lifecycle';
export { inboxRelayList, ensureInboxRelayList } from './inboxRelayList';
export { rebuildAccountForRelays } from './relaySettingsRebuild';
export { startAccountLifecycle, type AccountLifecycle, type AccountLifecycleOptions, type LeaseState } from './lease';
export { createStoreWipeGuard, type StoreWipeGuard } from './wipe';
export { reconcileOverlayGroups } from './reconcile';
