/**
 * NIP-46 requested permissions and stored-session discard (AC-SIGN-3, AC-SIGN-4).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { STORAGE_KEYS } from '@/src/types';
import { permissions } from '@941design/marmot';
import { BLOSSOM_AUTH_KIND } from '@/src/lib/media/blossomClient';
import {
  CALL_ANSWER_KIND,
  CALL_HANGUP_KIND,
  CALL_ICE_KIND,
  CALL_OFFER_KIND,
  CALL_REJECT_KIND,
  CALL_RENEGOTIATE_KIND,
} from '@/src/lib/calls/callSignaling';
import {
  APP_SIGN_EVENT_KINDS,
  buildNip46Permissions,
  buildNip46PermsParam,
  shouldDiscardStoredNip46Session,
  loadNip46Session,
  loadVerifiedNip46Account,
  requestVerifiedNip46Account,
  saveNip46Session,
} from '@/src/lib/nip46Perms';

const libPerms = permissions.toNip46Perms().split(',');
const APP_KINDS = [0, 20602, 30078, 10050, 24242, 25050, 25051, 25052, 25053, 25054, 25055];
const APP = APP_KINDS.map((k) => `sign_event:${k}`);

const OLD_SET = [
  'sign_event:0', 'sign_event:5', 'sign_event:443', 'sign_event:444', 'sign_event:445',
  'sign_event:1059', 'sign_event:10051', 'sign_event:20602', 'sign_event:30051',
  'sign_event:30078', 'sign_event:30443', 'nip44_encrypt', 'nip44_decrypt',
];

describe('AC-SIGN-3 requested permissions', () => {
  it('equals exactly the union of the library set and the app-signed kinds (incl. 24242 and 25050-25055)', () => {
    const got = buildNip46Permissions();
    expect([...got].sort()).toEqual([...new Set([...libPerms, ...APP])].sort());
    expect(new Set(got).size).toBe(got.length);
  });

  it('never requests the retired/ephemeral-signed kinds', () => {
    const got = buildNip46Permissions();
    for (const k of [443, 444, 445, 1059, 10051, 30051]) {
      expect(got).not.toContain(`sign_event:${k}`);
    }
  });

  it('guard: the app-signed kinds are derived from the code\'s kind constants (Blossom auth, call signaling)', () => {
    const fromConstants = [
      0, 20602, 30078, 10050,
      BLOSSOM_AUTH_KIND,
      CALL_OFFER_KIND, CALL_ANSWER_KIND, CALL_ICE_KIND, CALL_HANGUP_KIND, CALL_REJECT_KIND, CALL_RENEGOTIATE_KIND,
    ];
    expect([...APP_SIGN_EVENT_KINDS].sort((a, b) => a - b)).toEqual([...fromConstants].sort((a, b) => a - b));
    expect([...fromConstants].sort((a, b) => a - b)).toEqual([...APP_KINDS].sort((a, b) => a - b));
    for (const k of fromConstants) expect(buildNip46Permissions()).toContain(`sign_event:${k}`);
  });

  it('guard (structural scan): every account-signer signEvent() call site over app/src signs a requested kind', () => {
    // Scans app/src for `signEvent(<draft>)` call sites and resolves the draft's `kind:` (an inline object
    // literal, or the function that builds it) to a number, through literals and `const NAME = <number>`
    // constants. Each resolved kind must be requested from the bunker (library set or APP_SIGN_EVENT_KINDS), so a
    // new account-signed kind cannot ship unrequested. Sites whose draft is a parameter cannot be resolved
    // statically: they must be listed in UNRESOLVED_SITES (a new unresolved site fails here).
    const SRC = join(__dirname, '..', '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    walk(SRC);
    const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

    const constantValue = (name: string, own: string): number | undefined => {
      const re = new RegExp(`(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*(\\d+)\\b`);
      const m = re.exec(own) ?? [...text.values()].map((t) => re.exec(t)).find(Boolean);
      return m ? Number(m[1]) : undefined;
    };
    const kindIn = (body: string, own: string): number | undefined => {
      const m = /\bkind:\s*(\d+|[A-Z][A-Z0-9_]*)/.exec(body);
      if (!m) return undefined;
      return /^\d+$/.test(m[1]) ? Number(m[1]) : constantValue(m[1], own);
    };

    // Drafts that arrive as a parameter: kind constants are guarded by the constants test above.
    const UNRESOLVED_SITES = new Set(['lib/calls/callSignaling.ts:innerDraft']);
    // Kind 30051 is still signed by MarmotContext today; it is not requested and is removed by S16 (AC-REL-3).
    const ALLOW_UNREQUESTED = new Set([30051]);

    const requested = new Set<number>([
      ...APP_SIGN_EVENT_KINDS,
      ...libPerms.filter((p) => p.startsWith('sign_event:')).map((p) => Number(p.slice('sign_event:'.length))),
    ]);
    const callRe = /(?<!async )\bsignEvent\(\s*(\w+)(?:\s+as\s+\w+)?\s*\)/g;
    const found: Array<{ site: string; kind?: number }> = [];
    for (const [file, src] of text) {
      let m: RegExpExecArray | null;
      while ((m = callRe.exec(src))) {
        const id = m[1];
        const site = `${file.slice(SRC.length + 1)}:${id}`;
        const before = src.slice(0, m.index);
        const decl = new RegExp(`(?:const|let)\\s+${id}\\b[^=]*=\\s*(?:await\\s+)?(\\{|\\w+\\()`, 'g');
        let last: RegExpExecArray | null = null;
        for (let d = decl.exec(before); d; d = decl.exec(before)) last = d;
        let kind: number | undefined;
        if (last) {
          if (last[1] === '{') kind = kindIn(src.slice(last.index + last[0].length), src);
          else {
            const fn = new RegExp(`function\\s+${last[1].slice(0, -1)}\\b`).exec(src);
            if (fn) kind = kindIn(src.slice(fn.index), src);
          }
        }
        found.push({ site, kind });
      }
    }

    expect(found.length).toBeGreaterThanOrEqual(6); // D9 moves signing to the client
    const unresolved = found.filter((f) => f.kind === undefined).map((f) => f.site);
    expect(new Set(unresolved)).toEqual(UNRESOLVED_SITES);
    for (const { site, kind } of found) {
      if (kind === undefined || ALLOW_UNREQUESTED.has(kind)) continue;
      expect(requested.has(kind), `${site} signs kind ${kind}, which is not requested`).toBe(true);
    }
  });

  it('param form is the comma join of the same list', () => {
    expect(buildNip46PermsParam().split(',')).toEqual(buildNip46Permissions());
  });
});

describe('NDK DM plane coverage (guard)', () => {
  // The app's NIP-17 DM seals (kind 13) and deletions (kind 5) are signed via NDK and are
  // covered only because the library's toNip46Perms() lists them; a library bump that drops
  // either must fail here instead of silently breaking DMs under permission-enforcing bunkers.
  it('requested set includes sign_event:13 and sign_event:5', () => {
    const perms = buildNip46Permissions();
    expect(perms).toContain('sign_event:13');
    expect(perms).toContain('sign_event:5');
  });
});

describe('AC-SIGN-4 stored-session discard', () => {
  it('discards corrupt persisted records instead of throwing', () => {
    expect(shouldDiscardStoredNip46Session({})).toBe(true);
    expect(shouldDiscardStoredNip46Session(42)).toBe(true);
    expect(shouldDiscardStoredNip46Session([42, null])).toBe(true);
    expect(shouldDiscardStoredNip46Session([...buildNip46Permissions(), 42])).toBe(true);
  });

  it('trims array entries like the string form', () => {
    expect(shouldDiscardStoredNip46Session(buildNip46Permissions().map((p) => ` ${p} `))).toBe(false);
  });

  it('discards a session whose grants equal the old set', () => {
    expect(shouldDiscardStoredNip46Session(OLD_SET)).toBe(true);
  });

  it('keeps a session whose grants cover the new set (extras allowed)', () => {
    expect(shouldDiscardStoredNip46Session(buildNip46Permissions())).toBe(false);
    expect(shouldDiscardStoredNip46Session([...buildNip46Permissions(), 'sign_event:443'])).toBe(false);
    expect(shouldDiscardStoredNip46Session(buildNip46PermsParam())).toBe(false);
  });

  it('discards when any single required permission is missing', () => {
    for (const missing of buildNip46Permissions()) {
      expect(shouldDiscardStoredNip46Session(buildNip46Permissions().filter((p) => p !== missing))).toBe(true);
    }
  });

  it('discards a session with no recorded grants (stored before this set)', () => {
    expect(shouldDiscardStoredNip46Session(null)).toBe(true);
    expect(shouldDiscardStoredNip46Session(undefined)).toBe(true);
    expect(shouldDiscardStoredNip46Session([])).toBe(true);
  });
});

describe('NIP-46 settings connect and reload', () => {
  const userPubkey = 'ab'.repeat(32);
  const bunkerPubkey = 'cd'.repeat(32);
  const payload = JSON.stringify({ type: 'nip46', payload: { userPubkey: 'ef'.repeat(32), bunkerPubkey } });
  const verified = { source: 'get_public_key', pubkey: userPubkey } as const;

  function storage() {
    const state = new Map<string, string>();
    return {
      getItem: (key: string) => state.get(key) ?? null,
      setItem: (key: string, value: string) => void state.set(key, value),
      removeItem: (key: string) => void state.delete(key),
    };
  }

  it('reopens a payload saved by the identity provider using the current permission list', () => {
    const persisted = storage();
    saveNip46Session(persisted, payload, verified);
    expect(persisted.getItem(STORAGE_KEYS.nip46Permissions)).toBe(buildNip46PermsParam());
    expect(loadVerifiedNip46Account(persisted)).toBe(userPubkey);
    expect(loadNip46Session(persisted)).toBe(payload);
  });

  it.each([STORAGE_KEYS.nip46Session, STORAGE_KEYS.nip46Permissions, STORAGE_KEYS.nip46Account])(
    'clears the previous verified binding before a replacement interrupted at %s',
    (failedKey) => {
      const persisted = storage();
      saveNip46Session(persisted, payload, verified);
      const interrupted = {
        ...persisted,
        setItem(key: string, value: string) {
          expect(loadVerifiedNip46Account(persisted)).toBeNull();
          if (key === failedKey) throw new Error('storage write failed');
          persisted.setItem(key, value);
        },
      };

      expect(() => saveNip46Session(interrupted, 'replacement session', { ...verified, pubkey: '12'.repeat(32) }))
        .toThrow('storage write failed');
      expect(loadVerifiedNip46Account(persisted)).toBeNull();
    },
  );

  it.each([undefined, OLD_SET.join(',')])('keeps a verified account when permission record %s invalidates the session', (recorded) => {
    const persisted = storage();
    saveNip46Session(persisted, payload, verified);
    if (recorded !== undefined) persisted.setItem(STORAGE_KEYS.nip46Permissions, recorded);
    else persisted.removeItem(STORAGE_KEYS.nip46Permissions);
    expect(loadNip46Session(persisted)).toBeNull();
    expect(persisted.getItem(STORAGE_KEYS.nip46Session)).toBeNull();
    expect(persisted.getItem(STORAGE_KEYS.nip46Permissions)).toBeNull();
    expect(loadVerifiedNip46Account(persisted)).toBe(userPubkey);
    expect(loadNip46Session(persisted)).toBeNull();
    expect(loadVerifiedNip46Account(persisted)).toBe(userPubkey);
  });

  it('ignores both a payload hint and an unversioned account during permission invalidation', () => {
    const persisted = storage();
    persisted.setItem(STORAGE_KEYS.nip46Session, payload);
    persisted.setItem(STORAGE_KEYS.nip46Account, userPubkey);
    expect(loadNip46Session(persisted)).toBeNull();
    expect(loadVerifiedNip46Account(persisted)).toBeNull();
  });

  it.each(['expected bunker', 'wrong bunker', 'invalid signature', 'invalid result'])('validates the RPC account reply from %s', async (scenario) => {
    const bunkerKey = new Uint8Array(32).fill(1);
    const otherKey = new Uint8Array(32).fill(2);
    const endpoint = getPublicKey(bunkerKey);
    const event = finalizeEvent(
      { kind: 24133, created_at: 1, tags: [], content: 'encrypted account reply' },
      scenario === 'wrong bunker' ? otherKey : bunkerKey,
    );
    const sendRequest = vi.fn(async (_recipient, _method, _params, _kind, cb) => {
      cb({
        result: scenario === 'invalid result' ? 'bad' : userPubkey,
        event: { rawEvent: () => ({ ...event, sig: scenario === 'invalid signature' ? '0'.repeat(128) : event.sig }) },
      });
    });
    const account = requestVerifiedNip46Account({
      bunkerPubkey: endpoint,
      rpc: { sendRequest } as unknown as Parameters<typeof requestVerifiedNip46Account>[0]['rpc'],
    });
    if (scenario === 'expected bunker') await expect(account).resolves.toEqual(verified);
    else await expect(account).rejects.toThrow('could not be verified');
    expect(sendRequest).toHaveBeenCalledExactlyOnceWith(endpoint, 'get_public_key', [], 24133, expect.any(Function));
  });
});
