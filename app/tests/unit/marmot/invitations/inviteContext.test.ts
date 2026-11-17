/**
 * AC-CTX-1 (unit, recording sendInboxRumor) + the untrusted-name rules of AC-CTX-2: what the sponsor sends after
 * an invite outcome, and how a name is normalised.
 */
import { describe, expect, it } from 'vitest';
import { getEventHash } from '@941design/nostr-events/event';
import { MAX_GROUP_NAME_LENGTH } from '@/src/lib/marmot/renameGroupImpl';
import {
  APP_INBOX_KINDS_FOR_TEST,
  makeSender,
  delivered,
} from './inviteContext.fixtures';
import {
  INVITE_CONTEXT_KIND,
  MAX_CONTEXT_NAME_LENGTH,
  buildInviteContextContent,
  createContextSendingInviter,
  createInviteContextSender,
  parseInviteContextContent,
  sanitizeContextName,
} from '@/src/lib/marmot/invitations';

const GROUP = 'ab'.repeat(32);
const INVITEE = 'c1'.repeat(32);

describe('AC-CTX-1: the sponsor sends one kind-21064 rumor after a delivered/retryable outcome', () => {
  it('kind is the registry value 21064', () => {
    expect(INVITE_CONTEXT_KIND).toBe(21064);
    expect(INVITE_CONTEXT_KIND).toBe(APP_INBOX_KINDS_FOR_TEST.inviteContext);
  });

  it.each(['delivered', 'retryable'] as const)('%s: exactly one sendInboxRumor with content exactly {groupId,name}', async (status) => {
    const { sender, sent } = makeSender();
    const result = await sender.sendAfterInvite(delivered(status), { to: INVITEE, groupId: GROUP, name: 'Chess club' });
    expect(result).toBe('sent');
    expect(sent).toHaveLength(1);
    const { to, rumor } = sent[0];
    expect(to).toBe(INVITEE);
    expect(rumor.kind).toBe(21064);
    expect(rumor.content).toBe(`{"groupId":"${GROUP}","name":"Chess club"}`);
    expect(Object.keys(JSON.parse(rumor.content))).toEqual(['groupId', 'name']);
    expect(rumor.tags).toEqual([]);
    expect(rumor.pubkey).toBe('aa'.repeat(32));
    expect(rumor.id).toBe(getEventHash({ pubkey: rumor.pubkey, created_at: rumor.created_at, kind: rumor.kind, tags: rumor.tags, content: rumor.content }));
  });

  it.each(['failed', 'declined'] as const)('%s outcome sends nothing', async (status) => {
    const { sender, sent } = makeSender();
    expect(await sender.sendAfterInvite(delivered(status), { to: INVITEE, groupId: GROUP, name: 'x' })).toBe('skipped');
    expect(sent).toEqual([]);
  });

  it('an invite error value (no key package / already member) sends nothing', async () => {
    const { sender, sent } = makeSender();
    expect(await sender.sendAfterInvite({ error: 'already-member' }, { to: INVITEE, groupId: GROUP, name: 'x' })).toBe('skipped');
    expect(await sender.sendAfterInvite({ error: 'no usable key package', reason: 'none-found', attempts: 0 }, { to: INVITEE, groupId: GROUP, name: 'x' })).toBe('skipped');
    expect(sent).toEqual([]);
  });

  it('a name that is empty after sanitising sends nothing (the card keeps the generic label)', async () => {
    const { sender, sent } = makeSender();
    expect(await sender.sendAfterInvite(delivered('delivered'), { to: INVITEE, groupId: GROUP, name: ' ‮\n ' })).toBe('skipped');
    expect(sent).toEqual([]);
  });

  it('a rejected or failed send is reported, never thrown into the invite', async () => {
    const errors: unknown[] = [];
    const rejecting = createInviteContextSender({
      inbox: { sendInboxRumor: async () => { throw new Error('reentrant'); } },
      ownPubkey: 'aa'.repeat(32),
      now: () => 1_000,
      onError: (e) => void errors.push(e),
    });
    expect(await rejecting.sendAfterInvite(delivered('delivered'), { to: INVITEE, groupId: GROUP, name: 'n' })).toBe('failed');
    expect(errors).toHaveLength(1);
    const failing = createInviteContextSender({ inbox: { sendInboxRumor: async () => ({ status: 'failed', reason: 'no-inbox-relays' }) }, ownPubkey: 'aa'.repeat(32), now: () => 1, onError: () => undefined });
    expect(await failing.sendAfterInvite(delivered('delivered'), { to: INVITEE, groupId: GROUP, name: 'n' })).toBe('failed');
  });

  it('the decorated inviter returns the invite result unchanged and sends the context only for a delivered outcome', async () => {
    const { sender, sent } = makeSender();
    const results = [delivered('delivered'), delivered('failed'), { error: 'already-member' as const }];
    const inviter = createContextSendingInviter({ inviter: { inviteByPubkey: async () => results.shift() as never }, sender });
    const group = { id: GROUP, name: 'Chess club' } as never;
    expect(await inviter.inviteByPubkey(group, INVITEE)).toMatchObject({ outcome: { status: 'delivered' } });
    expect(await inviter.inviteByPubkey(group, INVITEE)).toMatchObject({ outcome: { status: 'failed' } });
    expect(await inviter.inviteByPubkey(group, INVITEE)).toEqual({ error: 'already-member' });
    expect(sent.map((s) => JSON.parse(s.rumor.content))).toEqual([{ groupId: GROUP, name: 'Chess club' }]);
  });

  it('ports are validated at construction', () => {
    const ok = { inbox: { sendInboxRumor: async () => ({ status: 'delivered' as const }) }, ownPubkey: 'aa'.repeat(32), now: () => 1 };
    expect(() => createInviteContextSender({ ...ok, inbox: undefined } as never)).toThrow(/sendInboxRumor/);
    expect(() => createInviteContextSender({ ...ok, now: undefined } as never)).toThrow(/now/);
    expect(() => createInviteContextSender({ ...ok, ownPubkey: '' })).toThrow(/ownPubkey/);
    expect(() => createInviteContextSender(undefined as never)).toThrow(TypeError);
    expect(() => createContextSendingInviter({ inviter: undefined, sender: makeSender().sender } as never)).toThrow(/inviter/);
    expect(() => createContextSendingInviter({ inviter: { inviteByPubkey: async () => ({ error: 'already-member' }) }, sender: undefined } as never)).toThrow(/sender/);
  });
});

describe('untrusted name: sanitise + cap (AC-CTX-2)', () => {
  it('the cap is 64 code points and is applied by code point, not UTF-16 unit', () => {
    expect(MAX_CONTEXT_NAME_LENGTH).toBe(64);
    expect(Array.from(sanitizeContextName('a'.repeat(200)))).toHaveLength(64);
    const emoji = sanitizeContextName('\u{1F600}'.repeat(100));
    expect(Array.from(emoji)).toHaveLength(64);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/); // no split surrogate
  });
  it('markup stays literal text (nothing is stripped or interpreted)', () => {
    expect(sanitizeContextName('<b>x</b>')).toBe('<b>x</b>');
    expect(sanitizeContextName('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
  it('controls and line separators become a space; invisible bidi/zero-width characters are removed, whitespace collapsed', () => {
    const c = (...cps: number[]) => String.fromCodePoint(...cps);
    expect(sanitizeContextName(`  a${c(0)}b${c(0x202e)}c\n\n d\t e  `)).toBe('a bc d e');
    expect(sanitizeContextName(`${c(0x200b)}${c(0x2066)}x${c(0x2069)}`)).toBe('x');
  });
  it('non-strings and blanks give the empty string', () => {
    for (const v of [undefined, null, 5, {}, '', '   ', '\u0000']) expect(sanitizeContextName(v)).toBe('');
  });
});

describe('payload parsing is strict about shape and lenient about extras', () => {
  it('round-trips the exact wire content', () => {
    expect(parseInviteContextContent(buildInviteContextContent(GROUP, 'Chess club'))).toEqual({ groupId: GROUP, name: 'Chess club' });
  });
  it('extra keys (description, admins, profile data) are never carried through', () => {
    const parsed = parseInviteContextContent(JSON.stringify({ groupId: GROUP, name: 'n', description: 'secret', adminPubkeys: ['x'], picture: 'u' }));
    expect(parsed).toEqual({ groupId: GROUP, name: 'n' });
    expect(Object.keys(parsed!)).toEqual(['groupId', 'name']);
  });
  it.each([
    ['not json', '{nope'],
    ['array', '[]'],
    ['null', 'null'],
    ['no name', JSON.stringify({ groupId: GROUP })],
    ['blank name', JSON.stringify({ groupId: GROUP, name: '  ' })],
    ['numeric name', JSON.stringify({ groupId: GROUP, name: 5 })],
    ['no groupId', JSON.stringify({ name: 'n' })],
    ['non-hex groupId', JSON.stringify({ groupId: 'zz!', name: 'n' })],
    ['oversized groupId', JSON.stringify({ groupId: 'a'.repeat(129), name: 'n' })],
  ])('rejects %s', (_label, content) => {
    expect(parseInviteContextContent(content)).toBeNull();
  });
  it('rejects non-string content', () => {
    expect(parseInviteContextContent(undefined)).toBeNull();
    expect(parseInviteContextContent(42)).toBeNull();
  });
});

describe('the context send never delays or fails the invite (sev4)', () => {
  const group = { id: GROUP, name: 'Chess club' } as never;
  const ownPubkey = 'aa'.repeat(32);

  it('a never-settling sendInboxRumor does not delay inviteByPubkey (the result resolves at once)', async () => {
    const sender = createInviteContextSender({ inbox: { sendInboxRumor: () => new Promise(() => undefined) }, ownPubkey, now: () => 1 });
    const inviter = createContextSendingInviter({ inviter: { inviteByPubkey: async () => delivered('delivered') }, sender });
    const outcome = await Promise.race([inviter.inviteByPubkey(group, INVITEE), new Promise((r) => setTimeout(() => r('timeout'), 500))]);
    expect(outcome).toMatchObject({ outcome: { status: 'delivered' } });
  });

  it('a throwing rumor build (clock) does not reject the invite; the failure is reported and observable', async () => {
    const errors: unknown[] = [];
    const sends: Promise<unknown>[] = [];
    const sender = createInviteContextSender({
      inbox: { sendInboxRumor: async () => ({ status: 'delivered' }) },
      ownPubkey,
      now: () => { throw new Error('clock'); },
      onError: (e) => void errors.push(e),
    });
    const inviter = createContextSendingInviter({ inviter: { inviteByPubkey: async () => delivered('delivered') }, sender, onContextSend: (p) => void sends.push(p) });
    await expect(inviter.inviteByPubkey(group, INVITEE)).resolves.toMatchObject({ outcome: { status: 'delivered' } });
    expect(await sends[0]).toBe('failed');
    expect(errors).toHaveLength(1);
  });

  it('a sender that throws synchronously or rejects (custom sender) never rejects the invite', async () => {
    const errors: unknown[] = [];
    const throwing = createContextSendingInviter({ inviter: { inviteByPubkey: async () => delivered('delivered') }, sender: { sendAfterInvite: () => { throw new Error('sync'); } }, onError: (e) => void errors.push(e) });
    await expect(throwing.inviteByPubkey(group, INVITEE)).resolves.toMatchObject({ outcome: { status: 'delivered' } });
    const rejecting = createContextSendingInviter({ inviter: { inviteByPubkey: async () => delivered('delivered') }, sender: { sendAfterInvite: async () => { throw new Error('async'); } }, onError: (e) => void errors.push(e) });
    await expect(rejecting.inviteByPubkey(group, INVITEE)).resolves.toMatchObject({ outcome: { status: 'delivered' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors.map((e) => (e as Error).message)).toEqual(['sync', 'async']);
  });

  it('the send is exposed through onContextSend and resolves to the send result', async () => {
    const { sender, sent } = makeSender();
    const sends: Promise<unknown>[] = [];
    const inviter = createContextSendingInviter({ inviter: { inviteByPubkey: async () => delivered('delivered') }, sender, onContextSend: (p) => void sends.push(p) });
    await inviter.inviteByPubkey(group, INVITEE);
    expect(await sends[0]).toBe('sent');
    expect(sent).toHaveLength(1);
  });
});

describe('sender delivery details (sev3)', () => {
  it('the invitee pubkey is lowercased before sendInboxRumor', async () => {
    const { sender, sent } = makeSender();
    await sender.sendAfterInvite(delivered('delivered'), { to: INVITEE.toUpperCase(), groupId: GROUP, name: 'n' });
    expect(sent[0].to).toBe(INVITEE);
  });

  it('a "failed" delivery status is reported with its reason only, never the content or name', async () => {
    const errors: unknown[] = [];
    const sender = createInviteContextSender({
      inbox: { sendInboxRumor: async () => ({ status: 'failed', reason: 'no-inbox-relays' }) },
      ownPubkey: 'aa'.repeat(32),
      now: () => 1,
      onError: (e) => void errors.push(e),
    });
    expect(await sender.sendAfterInvite(delivered('delivered'), { to: INVITEE, groupId: GROUP, name: 'Secret club' })).toBe('failed');
    expect(errors).toHaveLength(1);
    const text = String((errors[0] as Error).message);
    expect(text).toContain('no-inbox-relays');
    expect(text).not.toContain('Secret club');
    expect(text).not.toContain(GROUP);
  });

  it('MAX_CONTEXT_NAME_LENGTH equals the group-name cap (code points here, UTF-16 units there)', () => {
    expect(MAX_CONTEXT_NAME_LENGTH).toBe(MAX_GROUP_NAME_LENGTH);
    // a name valid as a group name (<= 64 UTF-16 units) fits the context cap unchanged, astral characters included
    const name = '\u{1F600}'.repeat(MAX_GROUP_NAME_LENGTH / 2);
    expect(name.length).toBe(MAX_GROUP_NAME_LENGTH);
    expect(sanitizeContextName(name)).toBe(name);
  });
});
