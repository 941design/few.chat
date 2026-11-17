/**
 * Public surface of the `client` module (the only importer of the library
 * client's construction). Other modules reach it through this file only.
 */
export {
  bootstrapAccountClient,
  CLIENT_EVENT_NAMES,
  CLIENT_TIMING_OPTIONS,
  INBOX_HANDLER_KINDS,
  type AccountClient,
  type AccountClientHandle,
  type BootstrapInput,
  type BootstrapResult,
  type BootstrapSeams,
  type BootstrapStep,
  type ClientEventHandlers,
  type ClientEventName,
  type InboxRelayListEnsure,
} from './createClient';
export { createJobQueue, type ClientJobQueue, type JobQueue, type JobQueueOptions } from './fifo';
export {
  createAccountSigner,
  budgetPolicyFor,
  signerSupportsNip44,
  LOCAL_SIGNER_BUDGET,
  REMOTE_SIGNER_BUDGET,
  REMOTE_SIGNER_TIMEOUT_MS,
  type AccountSignerResult,
  type AppEventSigner,
  type SignerKind,
} from './signerAdapter';
export { createClientTransport, type ClientPool, type ClientTransport } from './transport';
export { openAccountStores, type OpenStoresResult } from './storage';
export { ensureKeyPackage, type KeyPackageEnsureOutcome } from './keyPackageEnsure';
export { createTeardown, type TeardownParts } from './lifecycle';
