import { test, Page } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Pre-computed deterministic test keypairs.
 *
 * Derivation: seed (16 bytes hex) → SHA-256 → privateKeyHex → schnorr pubkey → npub
 * These are computed offline so tests don't depend on crypto at import time.
 *
 * ── Per-spec-file identity salting (relay-contamination fix) ────────────────
 * The whole e2e suite runs with `workers: 1` against ONE strfry relay that is
 * wiped only at the START of a full run. If every spec reused these three
 * fixed identities, each fresh user would pull the ENTIRE relay history
 * (gift-wraps, KeyPackages, Welcomes) left by every prior spec — and
 * cross-user propagation assertions (member name, poll announcement, image
 * lightbox, nickname update) would time out under that backlog. Specs pass in
 * isolation on a wiped relay but flaked in the full suite for exactly this
 * reason (BACKLOG: groups-e2e-suite-flaky-under-shared).
 *
 * Fix: `computeTestKeypairs()` re-derives each USER_* private key from a salt
 * keyed on the CURRENT spec file (via `test.info().file`). Two describe blocks
 * in the same file share identities (intra-file, tolerated); different files
 * get disjoint identities, so each file starts with an empty relay history —
 * the same clean-slate condition it gets when run alone.
 *
 * Per-test identities (`computeTestKeypairs({ perTest: true })`, called in a
 * `beforeEach`): the per-file salt still leaves every test of one file — and
 * every `--repeat-each` repeat or retry of it, and every earlier invocation on
 * a relay that was not wiped since — sharing ONE identity set, so a test that
 * counts or reveals relay-held events (e.g. held DMs between A and B) sees the
 * leftovers of every previous run (BACKLOG: e2e-pending-confirmation-relay-
 * pollution). `perTest` additionally salts with the test id, repeat index,
 * retry and a random nonce, so each test execution starts with an empty relay
 * history for all three users. Use it for specs whose tests are independent
 * (each boots its own contexts); do NOT use it in a `describe.serial` whose
 * tests share state across test boundaries.
 *
 * Exception: `dm-feedback-channel.spec.ts` must keep the BASE USER_B because
 * that identity's npub is baked into the dev server as NEXT_PUBLIC_MAINTAINER_
 * NPUBS at boot (scripts/run-e2e.mjs). It is the only spec left on the base
 * identities, so the base identities are used by exactly one file and stay
 * uncontaminated too — no change to run-e2e.mjs or any spec file is needed.
 */

/** Spec files that must keep the base (unsalted) identities. */
const UNSALTED_SPEC_FILES = new Set(['dm-feedback-channel.spec.ts']);

// Immutable base derivation (never mutated; USER_* are re-derived from these).
const BASE = {
  A: { seedHex: 'aa'.repeat(16), privateKeyHex: 'bceef655b5a034911f1c3718ce056531b45ef03b4c7b1f15629e867294011a7d' },
  B: { seedHex: 'bb'.repeat(16), privateKeyHex: 'cbecda1c7d37d4c0aa5466243bb4a0018c31bf06d74fa7338290dd3068db4fed' },
  C: { seedHex: 'cc'.repeat(16), privateKeyHex: 'd595a3162141a506924be60c2c75b1cd3c28ef4d4b7f4418705677270e54aedf' },
} as const;

export const USER_A = {
  seedHex: BASE.A.seedHex,
  privateKeyHex: BASE.A.privateKeyHex,
  pubkeyHex: '', // filled at runtime via computeTestKeypairs()
  npub: '',      // filled at runtime via computeTestKeypairs()
};

export const USER_B = {
  seedHex: BASE.B.seedHex,
  privateKeyHex: BASE.B.privateKeyHex,
  pubkeyHex: '',
  npub: '',
};

export const USER_C = {
  seedHex: BASE.C.seedHex,
  privateKeyHex: BASE.C.privateKeyHex,
  pubkeyHex: '',
  npub: '',
};

/**
 * The basename of the spec file currently executing, or null when called
 * outside a Playwright test/hook context (falls back to base identities).
 */
function currentSpecFile(): string | null {
  try {
    const file = test.info().file;
    return file ? file.split(/[/\\]/).pop() ?? null : null;
  } catch {
    return null; // test.info() throws outside a running test — use base seeds.
  }
}

/**
 * Derive a per-spec private key from the base seed and a salt. SHA-256 output
 * is a valid secp256k1 scalar (32 bytes, < curve order with overwhelming
 * probability), matching the offline base derivation's shape.
 */
function saltedPrivateKeyHex(baseSeedHex: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${baseSeedHex}`).digest('hex');
}

/**
 * Compute pubkeys at runtime using the same derivation as the app, re-deriving
 * a per-spec-file identity for each USER_* (except in UNSALTED_SPEC_FILES).
 * Call this once in each spec's beforeAll (before booting any user), or with
 * `{ perTest: true }` in a beforeEach for a fresh identity set per test execution.
 */
export async function computeTestKeypairs(options?: { perTest?: boolean }): Promise<void> {
  // Dynamic import to avoid top-level await issues
  const { getPublicKey } = await import('nostr-tools/pure');
  const { nip19 } = await import('nostr-tools');

  const specFile = currentSpecFile();
  if (options?.perTest && specFile && UNSALTED_SPEC_FILES.has(specFile)) {
    throw new Error(`[auth-helpers] ${specFile} must keep the base identities; perTest is not allowed there`);
  }
  let salt = specFile && !UNSALTED_SPEC_FILES.has(specFile) ? specFile : null;
  if (options?.perTest) {
    // test.info() throws outside a running test/hook — perTest needs one.
    const info = test.info();
    salt = `${salt}#${info.testId}#${info.repeatEachIndex}#${info.retry}#${randomUUID()}`;
    // Record the salt so an identity-dependent failure can be traced/replayed.
    info.annotations.push({ type: 'e2e-identity-salt', description: salt });
  }

  const users: Array<[typeof USER_A, { seedHex: string; privateKeyHex: string }]> = [
    [USER_A, BASE.A],
    [USER_B, BASE.B],
    [USER_C, BASE.C],
  ];

  for (const [user, base] of users) {
    // Always re-derive from the immutable base so an earlier spec's salt in
    // this shared module state cannot leak into a later (or unsalted) spec.
    user.seedHex = base.seedHex;
    user.privateKeyHex = salt ? saltedPrivateKeyHex(base.seedHex, salt) : base.privateKeyHex;
    const privBytes = hexToBytes(user.privateKeyHex);
    user.pubkeyHex = getPublicKey(privBytes);
    user.npub = nip19.npubEncode(user.pubkeyHex);
  }
}

/**
 * Inject a deterministic identity into the page's localStorage.
 * Must be called after page.goto() so we have access to the page's storage.
 */
export async function injectIdentity(
  page: Page,
  user: typeof USER_A,
): Promise<void> {
  await page.evaluate(
    ({ privateKeyHex, pubkeyHex, seedHex }) => {
      const identity = { privateKeyHex, pubkeyHex, seedHex };
      localStorage.setItem('lp_nostrIdentity_v1', JSON.stringify(identity));
    },
    { privateKeyHex: user.privateKeyHex, pubkeyHex: user.pubkeyHex, seedHex: user.seedHex },
  );
}

function hexToBytes(hex: string): Uint8Array {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return arr;
}
