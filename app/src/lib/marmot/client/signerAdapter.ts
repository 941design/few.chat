/**
 * Signer adapter for the library client (D2).
 *
 * Wraps the app's `EventSigner` (applesauce-shaped: `getPublicKey`,
 * `signEvent`, optional `nip44`) with `fromForeignSigner(..., APPLESAUCE_SHAPE)`
 * and chooses the budget policy per signer mode:
 *
 *  - local nsec     -> `{policy:'none'}` (no rate limiting, no timeout);
 *  - NIP-07 / NIP-46 -> a timeout budget (human approval prompts and bunker
 *    round trips can hang; the budget turns a hang into a `timeout` error).
 *
 * A signer without NIP-44 is reported `unsupported` (reason `nip44`); the
 * caller must not construct a client and no fallback encryption path exists.
 *
 * This is NOT the old `../signerAdapter.ts` (NDK-signer adapters for
 * marmot-ts); that file stays until the old flow is deleted. This module takes
 * the structural `AppEventSigner` shape so it never imports `applesauce-core`
 * (a transitive dependency of the fork that goes away) or NDK.
 */
import { fromForeignSigner, APPLESAUCE_SHAPE } from '@941design/nostr-events/signer/adapters';
import type { Signer } from '@941design/nostr-events/signer';
import type { BudgetPolicy } from '@941design/nostr-events/signer/budget';

/** Structural shape of the app's `EventSigner` (what `signerAdapter.ts` produces). */
export interface AppEventSigner {
  getPublicKey(): string | Promise<string>;
  signEvent(draft: any): any;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): string | Promise<string>;
    decrypt(pubkey: string, ciphertext: string): string | Promise<string>;
  };
}

/** `local` is a locally held nsec; mirrors the identity context's signer modes. */
export type SignerKind = 'local' | 'nip07' | 'nip46';

/**
 * Budget for remote signers. The timeout has to outlast a human approval in a
 * browser extension or a bunker prompt, so it is deliberately generous; the
 * lease outlasts the timeout so a slot is never freed while a call can still
 * legitimately complete.
 */
export const REMOTE_SIGNER_TIMEOUT_MS = 120_000;

export const REMOTE_SIGNER_BUDGET: BudgetPolicy = Object.freeze({
  concurrency: 2,
  minSpacingMs: 200,
  timeoutMs: REMOTE_SIGNER_TIMEOUT_MS,
  leaseMs: 150_000,
});

export const LOCAL_SIGNER_BUDGET: BudgetPolicy = Object.freeze({ policy: 'none' as const });

export function budgetPolicyFor(kind: SignerKind): BudgetPolicy {
  return kind === 'local' ? LOCAL_SIGNER_BUDGET : REMOTE_SIGNER_BUDGET;
}

export type AccountSignerResult =
  | { status: 'ready'; signer: Signer; budget: BudgetPolicy }
  | { status: 'unsupported'; reason: 'nip44' };

/** True when the signer exposes both NIP-44 methods (the only structural check `fromForeignSigner` makes). */
export function signerSupportsNip44(signer: Pick<Signer, 'nip44'> | AppEventSigner): boolean {
  const nip44 = (signer as { nip44?: { encrypt?: unknown; decrypt?: unknown } }).nip44;
  return !!nip44 && typeof nip44.encrypt === 'function' && typeof nip44.decrypt === 'function';
}

export function createAccountSigner(input: {
  eventSigner: AppEventSigner;
  kind: SignerKind;
}): AccountSignerResult {
  if (!signerSupportsNip44(input.eventSigner)) {
    return { status: 'unsupported', reason: 'nip44' };
  }
  const signer = fromForeignSigner({ target: input.eventSigner, methods: APPLESAUCE_SHAPE });
  // Belt and braces: the adapter only exposes `nip44` when the target has it.
  if (!signerSupportsNip44(signer)) {
    return { status: 'unsupported', reason: 'nip44' };
  }
  return { status: 'ready', signer, budget: budgetPolicyFor(input.kind) };
}
