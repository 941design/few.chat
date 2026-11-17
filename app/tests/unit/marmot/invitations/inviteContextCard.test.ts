/**
 * AC-CTX-2 / AC-CTX-5 (unit, pure view-model function): which name the card shows and what it can never show.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_TTL_MS,
  MAX_CONTEXT_NAME_LENGTH,
  buildInvitationCardViewModel,
  buildInvitationCardViewModels,
  createInviteContextStore,
  type InviteContextRecord,
} from '@/src/lib/marmot/invitations';
import { copyFor } from './inviteContext.copy';
import { hex, inv, memoryPort } from './inviteContext.fixtures';

const NOW = 5_000_000;
const ctx = (over: Partial<InviteContextRecord>): InviteContextRecord => ({ rumorId: 'r', groupId: 'g1', sender: hex(1), name: 'Chess club', receivedAt: NOW, seq: 1, matched: false, ...over });
const LABEL = 'Group invitation';
const model = (contexts: InviteContextRecord[], invitation = inv('1', 1, 'g1')) => buildInvitationCardViewModel({ invitation, contexts, genericLabel: LABEL, now: NOW });

describe('AC-CTX-2: name from the sponsor only', () => {
  it('shows the context name when the sender is the sponsorAccount', () => {
    expect(model([ctx({})])).toMatchObject({ displayName: 'Chess club', nameSource: 'context' });
  });
  it('shows it when the sender is one of sponsors[]', () => {
    expect(model([ctx({ sender: hex(5) })], { ...inv('1', 1, 'g1'), sponsors: [hex(1), hex(5)] })).toMatchObject({ displayName: 'Chess club', nameSource: 'context' });
  });
  it('any other sender yields the generic label', () => {
    expect(model([ctx({ sender: hex(9) })])).toMatchObject({ displayName: LABEL, nameSource: 'generic' });
  });
  it('a context for another group yields the generic label', () => {
    expect(model([ctx({ groupId: 'other' })])).toMatchObject({ displayName: LABEL, nameSource: 'generic' });
  });
  it('no context at all yields the generic label', () => {
    expect(model([])).toMatchObject({ displayName: LABEL, nameSource: 'generic' });
  });
  it('an expired context (older than 7 days) is ignored', () => {
    expect(model([ctx({ receivedAt: NOW - CONTEXT_TTL_MS })]).nameSource).toBe('context');
    expect(model([ctx({ receivedAt: NOW - CONTEXT_TTL_MS - 1 })]).nameSource).toBe('generic');
  });
  it('the impostor\'s context never beats or shadows the sponsor\'s, whichever is newer', () => {
    const sponsor = ctx({ seq: 1, name: 'real' });
    const impostor = ctx({ seq: 2, sender: hex(9), name: 'fake' });
    expect(model([sponsor, impostor]).displayName).toBe('real');
    expect(model([impostor, sponsor]).displayName).toBe('real');
  });
  it('the newest sponsor context of the group wins', () => {
    expect(model([ctx({ seq: 1, name: 'old' }), ctx({ seq: 2, name: 'new' })]).displayName).toBe('new');
  });
});

describe('AC-CTX-2: the name is untrusted text', () => {
  it('<b>x</b> is the literal 8-character string, not interpreted or stripped', () => {
    const m = model([ctx({ name: '<b>x</b>' })]);
    expect(m.displayName).toBe('<b>x</b>');
    expect(m.displayName).toHaveLength(8);
  });
  it('is length-capped at the asserted constant even when the stored record is oversized', () => {
    expect(MAX_CONTEXT_NAME_LENGTH).toBe(64);
    const m = model([ctx({ name: 'x'.repeat(500) })]);
    expect(Array.from(m.displayName)).toHaveLength(MAX_CONTEXT_NAME_LENGTH);
  });
  it('a stored name that sanitises to nothing falls back to the generic label', () => {
    expect(model([ctx({ name: '‮ \u0000' })])).toMatchObject({ displayName: LABEL, nameSource: 'generic' });
  });
});

describe('AC-CTX-2: live in either arrival order (real store + pending list)', () => {
  const setup = () => {
    let pending: ReturnType<typeof inv>[] = [];
    const store = createInviteContextStore({ port: memoryPort().port, now: () => NOW, getPending: () => pending });
    const shown = () => buildInvitationCardViewModels(pending, store.snapshot(), LABEL, NOW).map((m) => m.displayName);
    return { store, shown, setPending: (p: ReturnType<typeof inv>[]) => { pending = p; } };
  };

  it('invitation first: generic label, then the name appears when the context arrives (subscriber notified)', async () => {
    const t = setup();
    t.setPending([inv('1', 1, 'g1')]);
    expect(t.shown()).toEqual([LABEL]);
    let notified = 0;
    t.store.subscribe(() => void notified++);
    await t.store.add({ rumorId: 'r', sender: hex(1), groupId: 'g1', name: 'Chess club' });
    expect(notified).toBeGreaterThan(0);
    expect(t.shown()).toEqual(['Chess club']);
  });

  it('context first: held, then the name shows the moment the invitation arrives and the store reconciles', async () => {
    const t = setup();
    await t.store.add({ rumorId: 'r', sender: hex(1), groupId: 'g1', name: 'Chess club' });
    expect(t.shown()).toEqual([]); // no invitation yet
    t.setPending([inv('1', 1, 'g1')]);
    await t.store.reconcile([inv('1', 1, 'g1')]);
    expect(t.shown()).toEqual(['Chess club']);
  });

  it('context first from a non-sponsor: the invitation shows the generic label and the context is dropped', async () => {
    const t = setup();
    await t.store.add({ rumorId: 'r', sender: hex(9), groupId: 'g1', name: 'phish' });
    t.setPending([inv('1', 1, 'g1')]);
    await t.store.reconcile([inv('1', 1, 'g1')]);
    expect(t.shown()).toEqual([LABEL]);
    expect(t.store.snapshot()).toEqual([]);
  });
});

describe('AC-CTX-5: never a description or admin list pre-join', () => {
  it('the model has exactly four fields, none of them a description or admin list', () => {
    const m = model([ctx({})]);
    expect(Object.keys(m).sort()).toEqual(['displayName', 'invitationId', 'nameSource', 'sponsorAccount']);
    const dumped = JSON.stringify(m).toLowerCase();
    expect(dumped).not.toMatch(/description|admin/);
  });
  it('a context record cannot carry a description or admins either (stored fields are fixed)', async () => {
    const store = createInviteContextStore({ port: memoryPort().port, now: () => 1, getPending: () => [] });
    await store.add({ rumorId: 'r', sender: hex(1), groupId: 'g1', name: 'n', description: 'D', adminPubkeys: ['a'] } as never);
    expect(Object.keys(store.snapshot()[0]).sort()).toEqual(['groupId', 'matched', 'name', 'receivedAt', 'rumorId', 'sender', 'seq']);
  });
  it('input is validated: no invitation / empty label throw', () => {
    expect(() => buildInvitationCardViewModel({ contexts: [], genericLabel: LABEL, now: 1 } as never)).toThrow(TypeError);
    expect(() => buildInvitationCardViewModel({ invitation: inv('1', 1), contexts: [], genericLabel: '', now: 1 })).toThrow(/genericLabel/);
  });
});

describe('generic label is i18n (en + de)', () => {
  it('both languages carry a non-empty generic invitation label, and they differ', () => {
    const { en, de } = copyFor();
    expect(en).toBe('Group invitation');
    expect(de).toBe('Gruppeneinladung');
  });
});
