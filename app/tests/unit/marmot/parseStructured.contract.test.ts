import { describe, it, expect } from 'vitest';
import { parseStructured } from '@/src/lib/marmot/parseStructured';

// Contract tests derived from a mutation audit of parseStructured (2026-07-19).
// The module turns UNTRUSTED JSON group-message content into a discriminated
// StructuredContent union (or null). The audit surfaced that every structured
// type's discriminator and required-field guards could be individually bypassed
// without any test noticing — a crafted peer message could then be mis-rendered
// as a different, higher-trust structured event (e.g. a member-admission or a
// group-rename notice) it is not. These tests assert the parser's public
// contract at the return boundary; they intentionally do not reference internal
// lines or variables, so they survive refactors of the guard structure.
//
// The repo convention is table-driven contract tests (it.each), not fast-check
// (which this project deliberately does not depend on).

// One canonical, fully-valid payload for every recognized structured type.
// A 64-char lowercase-hex pubkey — the only shape member_admitted accepts.
const HEX64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Case = { type: string; required: Record<string, unknown> };

// `required` holds ONLY the fields the guard actually enforces; the discriminator
// `type` is added by the builders below.
const RECOGNIZED: Case[] = [
  { type: 'poll_open', required: { pollId: 'p1', title: 'Vote!' } },
  { type: 'poll_close', required: { pollId: 'p1', title: 'Vote!', results: [] } },
  { type: 'image', required: { version: 1 } },
  { type: 'invite_cancelled', required: { pubkey: 'aabb', by: 'ccdd' } },
  { type: 'leave_intent', required: { pubkey: 'aabb' } },
  { type: 'group_renamed', required: { name: 'Book Club' } },
  { type: 'call_notice', required: { event: 'started', callId: 'c1', initiator: 'i1' } },
  { type: 'member_admitted', required: { pubkey: HEX64 } },
  { type: 'invite_lifecycle', required: { event: 'invited', pubkey: HEX64 } },
];

function validPayload(c: Case): Record<string, unknown> {
  return { type: c.type, ...c.required };
}

describe('parseStructured — discriminator integrity (a payload only ever parses as its own declared type)', () => {
  // A single input carrying the SUPERSET of every type's required fields but an
  // unrecognized `type` must return null. If any one type's discriminator check
  // were bypassed (its branch made unconditional), this payload would satisfy
  // that branch's remaining field guards and be wrongly returned as that type.
  // Kills the whole `type === X -> true` cluster in one property.
  const superset: Record<string, unknown> = {};
  for (const c of RECOGNIZED) Object.assign(superset, c.required);

  it.each([
    'unknown',
    'poll', // near-miss prefix
    'member', // near-miss prefix of member_admitted
    '', // empty discriminator
    'MEMBER_ADMITTED', // wrong case
  ])('returns null for a fields-complete payload with an unrecognized type (%s)', (badType) => {
    const result = parseStructured(JSON.stringify({ ...superset, type: badType }));
    expect(result).toBeNull();
  });

  // Re-stamping a fully-valid payload of one recognized type with a DIFFERENT
  // recognized type must never yield the original type. (It may legitimately
  // parse as the new type when the new type's guards happen to be satisfied —
  // the contract is only that a payload cannot impersonate the type it no longer
  // declares.)
  it('never parses a payload as a type it does not declare', () => {
    for (const origin of RECOGNIZED) {
      const base = validPayload(origin);
      for (const other of RECOGNIZED) {
        if (other.type === origin.type) continue;
        const restamped = parseStructured(JSON.stringify({ ...base, type: other.type }));
        expect(restamped?.type).not.toBe(origin.type);
      }
    }
  });
});

describe('parseStructured — required fields are each individually necessary', () => {
  // For every recognized type, dropping ANY one field the guard requires must
  // stop the payload from parsing as that type. This kills both the
  // `<conjunct> -> true` mutants (a dropped field would still pass) and the
  // `&& -> ||` mutants (one surviving field would still pass).
  const dropOneCases: Array<[string, string, Record<string, unknown>]> = [];
  for (const c of RECOGNIZED) {
    for (const field of Object.keys(c.required)) {
      const payload = validPayload(c);
      delete payload[field];
      dropOneCases.push([c.type, field, payload]);
    }
  }

  it.each(dropOneCases)(
    'a %s payload missing its required "%s" field does not parse as %s',
    (type, _field, payload) => {
      const result = parseStructured(JSON.stringify(payload));
      expect(result?.type).not.toBe(type);
    },
  );

  // Field-TYPE necessity (not just presence): a required field present but with
  // the wrong runtime type must also be rejected. These pin the `typeof … ===
  // 'string'` / `Array.isArray(…)` guards that a plain presence check leaves
  // exposed — the audit showed e.g. an ARRAY name of length>0 slipping through
  // group_renamed, and a non-array `results` slipping through poll_close.
  it.each([
    ['group_renamed rejects a non-string (array) name', { type: 'group_renamed', name: ['not', 'a', 'string'] }],
    ['group_renamed rejects a numeric name', { type: 'group_renamed', name: 42 }],
    ['poll_close rejects a non-array results', { type: 'poll_close', pollId: 'p1', title: 'T', results: 'nope' }],
    ['poll_close rejects an object results', { type: 'poll_close', pollId: 'p1', title: 'T', results: { length: 3 } }],
    ['call_notice rejects a non-string initiator', { type: 'call_notice', event: 'started', callId: 'c1', initiator: 42 }],
    ['call_notice rejects a non-string callId', { type: 'call_notice', event: 'started', callId: 99, initiator: 'i1' }],
    ['call_notice rejects an unknown event', { type: 'call_notice', event: 'paused', callId: 'c1', initiator: 'i1' }],
    ['image rejects a missing version', { type: 'image', caption: 'hi' }],
    ['invite_lifecycle rejects an out-of-enum event', { type: 'invite_lifecycle', event: 'pending', pubkey: HEX64 }],
    ['invite_lifecycle rejects an uppercase-hex pubkey', { type: 'invite_lifecycle', event: 'invited', pubkey: HEX64.toUpperCase() }],
    ['invite_lifecycle rejects a wrong-length pubkey', { type: 'invite_lifecycle', event: 'invited', pubkey: HEX64.slice(0, 63) }],
    ['invite_lifecycle rejects a non-string pubkey', { type: 'invite_lifecycle', event: 'invited', pubkey: 42 }],
  ])('%s', (_label, payload) => {
    const result = parseStructured(JSON.stringify(payload));
    // Either null, or (for cases where a foreign guard could match) not the
    // impersonated type — but for these payloads the correct outcome is null.
    expect(result).toBeNull();
  });
});

describe('parseStructured — value normalization for the image variant', () => {
  // The image branch is the one type that reshapes its payload rather than
  // returning it raw: it always emits version:1 and coerces caption to a string,
  // defaulting to '' when the caption is absent or not a string. The audit
  // showed the caption ternary and its '' default were entirely unexercised.
  it('preserves a string caption verbatim', () => {
    const result = parseStructured('{"type":"image","version":1,"caption":"a lovely sunset"}');
    expect(result).toEqual({ type: 'image', version: 1, caption: 'a lovely sunset' });
  });

  it.each([
    ['absent caption', '{"type":"image","version":1}'],
    ['numeric caption', '{"type":"image","version":1,"caption":42}'],
    ['null caption', '{"type":"image","version":1,"caption":null}'],
    ['object caption', '{"type":"image","version":1,"caption":{"x":1}}'],
  ])('defaults caption to empty string when it is not a string (%s)', (_label, content) => {
    const result = parseStructured(content);
    expect(result).toEqual({ type: 'image', version: 1, caption: '' });
  });

  it('always normalizes version to 1 regardless of the incoming version value', () => {
    const result = parseStructured('{"type":"image","version":7,"caption":"x"}');
    expect(result).toEqual({ type: 'image', version: 1, caption: 'x' });
  });
});

describe('parseStructured — happy paths for the two previously-untested variants', () => {
  // poll_close and image had no behavioral test at all before this audit; a
  // valid instance of each must round-trip to its declared type. This anchors
  // the many discriminator/field mutants on those branches to observable output.
  it('parses a valid poll_close', () => {
    const result = parseStructured(
      '{"type":"poll_close","pollId":"p1","title":"Lunch?","results":[{"option":"pizza","votes":3}],"totalVoters":3}',
    );
    expect(result).toMatchObject({ type: 'poll_close', pollId: 'p1', title: 'Lunch?' });
    expect(Array.isArray((result as { results: unknown[] }).results)).toBe(true);
  });

  it('parses a valid image', () => {
    const result = parseStructured('{"type":"image","version":1,"caption":"hi"}');
    expect(result).toEqual({ type: 'image', version: 1, caption: 'hi' });
  });
});
