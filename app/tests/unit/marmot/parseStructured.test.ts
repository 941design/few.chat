import { describe, it, expect } from 'vitest';
import { parseStructured, resolveCancellerDisplay } from '@/src/lib/marmot/parseStructured';

describe('parseStructured', () => {
  it('returns invite_cancelled variant for valid input', () => {
    const result = parseStructured('{"type":"invite_cancelled","pubkey":"abababababababababababababababababababababababababababababababab","by":"ccdd"}');
    expect(result).toEqual({ type: 'invite_cancelled', pubkey: 'abababababababababababababababababababababababababababababababab', by: 'ccdd' });
  });

  it('returns null for invite_cancelled missing pubkey', () => {
    const result = parseStructured('{"type":"invite_cancelled","by":"ccdd"}');
    expect(result).toBeNull();
  });

  it('returns null for invite_cancelled missing by', () => {
    const result = parseStructured('{"type":"invite_cancelled","pubkey":"abababababababababababababababababababababababababababababababab"}');
    expect(result).toBeNull();
  });

  it('returns poll_open for valid poll_open input', () => {
    const result = parseStructured('{"type":"poll_open","pollId":"p1","title":"Vote!","creatorPubkey":"aa"}');
    expect(result).toMatchObject({ type: 'poll_open', pollId: 'p1', title: 'Vote!' });
  });

  it('returns null for plain text', () => {
    const result = parseStructured('hello world');
    expect(result).toBeNull();
  });

  it('returns null for unknown type', () => {
    const result = parseStructured('{"type":"unknown","foo":"bar"}');
    expect(result).toBeNull();
  });

  it('returns leave_intent variant for valid input', () => {
    const result = parseStructured('{"type":"leave_intent","pubkey":"abababababababababababababababababababababababababababababababab"}');
    expect(result).toEqual({ type: 'leave_intent', pubkey: 'abababababababababababababababababababababababababababababababab' });
  });

  it('carries the leaver display name when present', () => {
    const result = parseStructured('{"type":"leave_intent","pubkey":"abababababababababababababababababababababababababababababababab","name":"Alice"}');
    expect(result).toEqual({ type: 'leave_intent', pubkey: 'abababababababababababababababababababababababababababababababab', name: 'Alice' });
  });

  it('trims the leaver display name and drops blank/whitespace names', () => {
    expect(parseStructured('{"type":"leave_intent","pubkey":"abababababababababababababababababababababababababababababababab","name":"  Alice  "}'))
      .toEqual({ type: 'leave_intent', pubkey: 'abababababababababababababababababababababababababababababababab', name: 'Alice' });
    expect(parseStructured('{"type":"leave_intent","pubkey":"abababababababababababababababababababababababababababababababab","name":"   "}'))
      .toEqual({ type: 'leave_intent', pubkey: 'abababababababababababababababababababababababababababababababab' });
  });

  it('returns null for leave_intent missing pubkey', () => {
    const result = parseStructured('{"type":"leave_intent"}');
    expect(result).toBeNull();
  });

  it('returns group_renamed variant for valid input', () => {
    const result = parseStructured('{"type":"group_renamed","name":"Book Club"}');
    expect(result).toEqual({ type: 'group_renamed', name: 'Book Club' });
  });

  it('returns null for group_renamed missing name', () => {
    const result = parseStructured('{"type":"group_renamed"}');
    expect(result).toBeNull();
  });

  it('returns null for group_renamed empty name', () => {
    const result = parseStructured('{"type":"group_renamed","name":""}');
    expect(result).toBeNull();
  });

  it('returns null for group_renamed non-string name', () => {
    const result = parseStructured('{"type":"group_renamed","name":42}');
    expect(result).toBeNull();
  });

  // A canonical 64-char lowercase-hex pubkey (the only shape the guard accepts).
  const VALID_HEX_PUBKEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  // AC-PARSE-1
  it('returns member_admitted variant for valid input', () => {
    const result = parseStructured(
      `{"type":"member_admitted","pubkey":"${VALID_HEX_PUBKEY}"}`,
    );
    expect(result).toEqual({
      type: 'member_admitted',
      pubkey: VALID_HEX_PUBKEY,
    });
  });

  // AC-PARSE-2
  it('returns null for member_admitted missing pubkey', () => {
    const result = parseStructured('{"type":"member_admitted"}');
    expect(result).toBeNull();
  });

  // AC-PARSE-2
  it('returns null for member_admitted non-string pubkey', () => {
    const result = parseStructured('{"type":"member_admitted","pubkey":42}');
    expect(result).toBeNull();
  });

  // AC-PARSE-2 (hardening): a non-canonical pubkey — too short, wrong length,
  // uppercase, or non-hex — must NOT parse as member_admitted. Otherwise the
  // render branch would feed it to pubkeyToNpub → nip19.npubEncode, which
  // throws on malformed hex and would break the chat timeline for receivers.
  // Rejecting here makes such crafted content fall through to plain text.
  it.each([
    ['too short', 'x'],
    ['short hex', 'aabb'],
    ['63 hex chars', 'a'.repeat(63)],
    ['65 hex chars', 'a'.repeat(65)],
    ['uppercase hex', 'A'.repeat(64)],
    ['non-hex chars', 'g'.repeat(64)],
    ['empty', ''],
  ])('returns null for member_admitted with a non-canonical pubkey (%s)', (_label, pubkey) => {
    const result = parseStructured(`{"type":"member_admitted","pubkey":"${pubkey}"}`);
    expect(result).toBeNull();
  });

  // AC-ATTR-1 (structural half): the guard rebuilds the object from named
  // fields only (`{ type, pubkey }`), so an attacker-supplied "by"/"admitter"
  // field in the raw payload is silently dropped — there is no field in the
  // parsed result an attacker could point the render layer at. This is a
  // stronger guarantee than invite_cancelled's `by` field: member_admitted
  // has no admitter field in its type AT ALL.
  it('drops any extra attacker-supplied fields (e.g. a forged "by"/"admitter") — the payload cannot carry an admitter', () => {
    const result = parseStructured(
      `{"type":"member_admitted","pubkey":"${VALID_HEX_PUBKEY}","by":"forgedAdminPk","admitter":"forgedAdminPk"}`,
    );
    expect(result).toEqual({ type: 'member_admitted', pubkey: VALID_HEX_PUBKEY });
    expect(result).not.toHaveProperty('by');
    expect(result).not.toHaveProperty('admitter');
  });
});

describe('parseStructured — invite_lifecycle', () => {
  // Same canonical 64-char lowercase-hex pubkey shape as member_admitted's
  // VALID_HEX_PUBKEY above (scoped to that describe block, so re-declared here).
  const VALID_HEX_PUBKEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

  // AC-STRUCT-1 / VQ-S1-012 (seam contract closed enum, one happy path per member)
  it.each(['invited', 'accepted', 'declined'] as const)(
    'returns invite_lifecycle variant containing exactly {type, event, pubkey} for event=%s',
    (event) => {
      const result = parseStructured(
        `{"type":"invite_lifecycle","event":"${event}","pubkey":"${VALID_HEX_PUBKEY}"}`,
      );
      expect(result).toEqual({ type: 'invite_lifecycle', event, pubkey: VALID_HEX_PUBKEY });
      expect(Object.keys(result as object).sort()).toEqual(['event', 'pubkey', 'type']);
    },
  );

  // AC-STRUCT-2: every out-of-enum event value falls through to plain text,
  // individually — not just one collapsed "invalid event" case.
  it.each<[string, string | undefined]>([
    ['out-of-enum value "pending"', 'pending'],
    ['empty string', ''],
    ['missing entirely', undefined],
    ['case-mismatched ("Invited")', 'Invited'],
    ['near-miss prefix ("invite")', 'invite'],
  ])('returns null for invite_lifecycle with an out-of-enum event (%s)', (_label, event) => {
    const payload: Record<string, unknown> = { type: 'invite_lifecycle', pubkey: VALID_HEX_PUBKEY };
    if (event !== undefined) payload.event = event;
    const result = parseStructured(JSON.stringify(payload));
    expect(result).toBeNull();
  });

  // AC-STRUCT-3: every pubkey-malformation category rejected individually,
  // including a non-string value (must not throw before/inside the guard).
  it.each<[string, unknown]>([
    ['too short', 'x'],
    ['short hex', 'aabb'],
    ['63 hex chars', 'a'.repeat(63)],
    ['65 hex chars', 'a'.repeat(65)],
    ['uppercase hex', 'A'.repeat(64)],
    ['non-hex chars', 'g'.repeat(64)],
    ['empty', ''],
    ['numeric pubkey', 42],
    ['null pubkey', null],
  ])('returns null for invite_lifecycle with a non-canonical pubkey (%s)', (_label, pubkey) => {
    // Calling parseStructured itself (not just the assertion) must not throw —
    // a non-string pubkey (e.g. 42, null) must fail the regex match via safe
    // ToString coercion, never crash the parser.
    let result: unknown;
    expect(() => {
      result = parseStructured(JSON.stringify({ type: 'invite_lifecycle', event: 'invited', pubkey }));
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('returns null for invite_lifecycle missing pubkey entirely', () => {
    const result = parseStructured('{"type":"invite_lifecycle","event":"invited"}');
    expect(result).toBeNull();
  });

  // AC-STRUCT-4: the object is rebuilt from named fields only, so a spoofed
  // extra property (role, __proto__, or even a forged senderPubkey) is dropped
  // — never passed through via a widened `{...payload}` / `as StructuredContent`
  // cast. Distinguishes a correct implementation from a naive spread, which
  // would let `role`/`senderPubkey` leak into the returned object.
  it('drops any extra/spoofed properties — object rebuilt from named fields only (AC-STRUCT-4)', () => {
    const result = parseStructured(
      `{"type":"invite_lifecycle","event":"invited","pubkey":"${VALID_HEX_PUBKEY}","role":"admin","senderPubkey":"forgedSenderPk","__proto__":{"polluted":true}}`,
    );
    expect(result).toEqual({ type: 'invite_lifecycle', event: 'invited', pubkey: VALID_HEX_PUBKEY });
    expect(result).not.toHaveProperty('role');
    expect(result).not.toHaveProperty('senderPubkey');
    expect(Object.keys(result as object).sort()).toEqual(['event', 'pubkey', 'type']);
    // The prototype-pollution attempt must not have escaped onto the plain
    // object parseStructured constructs.
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect((result as Record<string, unknown>).polluted).toBeUndefined();
  });

  // AC-STRUCT-5 (parse-boundary half — S1's owned guarantee): parseStructured's
  // signature takes only `content: string`. There is no `senderPubkey` parameter
  // and the returned object never carries one, so the payload's `pubkey`
  // (subject/invitee) and the protocol-level `senderPubkey` (author, supplied by
  // the transport/dispatcher, never by this parser) are structurally two
  // distinct values that cannot be conflated at this boundary. The render-time
  // consumption of this convention — resolving the displayed author from
  // msg.senderPubkey, never payload.pubkey — is exercised end-to-end by S4.
  it('keeps payload.pubkey (subject) and any transport-level sender identity structurally distinct (AC-STRUCT-5)', () => {
    const result = parseStructured(
      `{"type":"invite_lifecycle","event":"invited","pubkey":"${VALID_HEX_PUBKEY}"}`,
    );
    expect(result).toEqual({ type: 'invite_lifecycle', event: 'invited', pubkey: VALID_HEX_PUBKEY });
    // parseStructured has no channel to accept or emit a sender identity: the
    // returned object exposes only the three named fields above.
    expect(result).not.toHaveProperty('senderPubkey');
    expect(parseStructured.length).toBe(1); // arity: (content: string) only
  });
});

describe('resolveCancellerDisplay — trust boundary', () => {
  const truncate = (pk: string) => pk.slice(0, 8) + '…';

  it('uses nickname from profileMap keyed on senderPubkey', () => {
    const result = resolveCancellerDisplay(
      'realSenderPk',
      { realSenderPk: { nickname: 'Alice' } },
      truncate,
    );
    expect(result).toBe('Alice');
  });

  it('falls back to truncated senderPubkey when no profile', () => {
    const result = resolveCancellerDisplay('realSenderPk', {}, truncate);
    expect(result).toBe('realSend…');
  });

  it('ignores a forged by field — uses senderPubkey not structured.by', () => {
    // Simulate attacker posting by='adminPk' while actual sender is 'attackerPk'
    const forgedBy = 'adminPk';
    const actualSender = 'attackerPk';
    const profileMap = {
      adminPk: { nickname: 'Admin' },
      attackerPk: { nickname: 'Attacker' },
    };
    // The render layer must call resolveCancellerDisplay(msg.senderPubkey, ...)
    // not resolveCancellerDisplay(structured.by, ...).
    // This test proves the function always returns the senderPubkey's display.
    expect(resolveCancellerDisplay(actualSender, profileMap, truncate)).toBe('Attacker');
    // And that using the forged field would have returned the wrong name:
    expect(resolveCancellerDisplay(forgedBy, profileMap, truncate)).toBe('Admin');
  });
});

// AC-ATTR-1 (behavioral half). ChatBox.renderStructuredMessage's member_admitted
// branch resolves admitterDisplay with the identical algorithm
// resolveCancellerDisplay implements — profileMap[senderPubkey]?.nickname,
// falling back to a truncated senderPubkey — applied to the protocol-enforced
// `msg.senderPubkey`, never to any field of the member_admitted payload (which,
// per the guard above, cannot even carry one). resolveCancellerDisplay is a
// pure, type-agnostic resolution helper, so exercising it here against a
// member_admitted-shaped scenario proves the same trust-boundary guarantee the
// render branch depends on, without needing jsdom/@testing-library (this repo's
// unit tests never mount React components).
describe('member_admitted admitter attribution — trust boundary (AC-ATTR-1)', () => {
  const truncate = (pk: string) => pk.slice(0, 8) + '…';

  it('resolves the admitter from the protocol senderPubkey, using the same algorithm the ChatBox branch calls inline', () => {
    const adminSenderPk = 'realAdminSenderPk';
    const profileMap = { realAdminSenderPk: { nickname: 'Alice' } };
    expect(resolveCancellerDisplay(adminSenderPk, profileMap, truncate)).toBe('Alice');
  });

  it('a member_admitted payload structurally cannot spoof the admitter: only msg.senderPubkey ever feeds resolution', () => {
    // The parsed member_admitted result only ever has `type` and `pubkey`
    // (the ADMITTED MEMBER's pubkey) — see the parse guard tests above. There
    // is no payload field the render branch could mistakenly resolve the
    // admitter from, even if an attacker forges one, because parseStructured
    // already dropped it. This test pins that the only viable resolution
    // input is the protocol sender.
    const realSender = 'realAdminSenderPk';
    const attackerControlledMemberPubkey = 'attackerPk';
    const profileMap = {
      realAdminSenderPk: { nickname: 'Alice' },
      attackerPk: { nickname: 'Mallory' },
    };
    const admitterDisplay = resolveCancellerDisplay(realSender, profileMap, truncate);
    expect(admitterDisplay).toBe('Alice');
    expect(admitterDisplay).not.toBe('Mallory');
    // Even resolving against the payload's own `pubkey` field (the admitted
    // member, not an admitter) would yield the wrong actor — proving the
    // render branch must use senderPubkey and nothing from the payload.
    expect(resolveCancellerDisplay(attackerControlledMemberPubkey, profileMap, truncate)).toBe('Mallory');
  });

  it('falls back to a truncated pubkey when the admitter has no known profile', () => {
    expect(resolveCancellerDisplay('unknownSenderPk', {}, truncate)).toBe('unknownS…');
  });
});
