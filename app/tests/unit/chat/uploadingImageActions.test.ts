/**
 * Bug deleting-dm-image-while-still-uploading: an own image row that is still
 * uploading carries a temporary id no peer ever sees, so a delete of it could
 * not stick. The row is flagged `uploading`, offers no message actions and no
 * reactions, the final row drops the flag, and the handlers refuse it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { canShowMessageActions, canReactToMessage } from '@/src/lib/messageEdits/messageActionUi';
import {
  registerPendingOwnSend,
  replacePendingOwnSend,
  pendingOwnSendsFor,
  _resetPendingOwnSends,
} from '@/src/lib/pendingOwnSends';
import type { ChatMessage } from '@/src/lib/marmot/chatPersistence';

const SELF = 'aabb'.repeat(16);
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../../../src', p), 'utf8');
const between = (src: string, from: string, to: string) => {
  const i = src.indexOf(from);
  return src.slice(i, src.indexOf(to, i));
};

const msg = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'temp', content: '{"type":"image","version":1,"caption":""}', senderPubkey: SELF,
  groupId: 'dm:x', createdAt: 0, attachments: { full: null, thumb: null }, ...over,
});

describe('uploading image rows', () => {
  it('an uploading own row offers no message actions, in DMs and groups', () => {
    expect(canShowMessageActions(msg({ uploading: true }), SELF)).toBe(false);
    expect(canShowMessageActions(msg({ uploading: true }), SELF, true, true, true)).toBe(false);
  });

  it('once uploaded, the own row offers them again', () => {
    expect(canShowMessageActions(msg({ uploading: undefined }), SELF)).toBe(true);
  });

  it('the DM image send flags the optimistic row and not the final one; handlers refuse it', () => {
    const src = read('components/contacts/ContactChat.tsx');
    const send = between(src, 'const sendImageMessage = useCallback(', 'const decryptMedia');
    expect(send).toMatch(/attachments: \{ full: null, thumb: null \},\s*\}\),\s*uploading: true,/);
    expect(send).toMatch(/const finalMsg: ChatMessage = \{\s*\.\.\.optimistic,\s*uploading: undefined,/);
    for (const handler of ['const handleDeleteMessage = useCallback(', 'const handleEditMessage = useCallback(']) {
      expect(between(src, handler, 'setMessages(')).toContain('if (!snapshot || snapshot.uploading) return;');
    }
  });

  it('the group image send flags the optimistic row and not the final one', () => {
    const send = between(read('context/ChatStoreContext.tsx'), 'const tempId = crypto.randomUUID();', 'appendMessage(groupId, finalMsg)');
    expect(send).toMatch(/attachments: \{ full: null, thumb: null \},\s*localMediaRefs: \[\],\s*uploading: true,/);
    expect(send).toMatch(/const finalMsg: ChatMessage = \{\s*\.\.\.optimistic,\s*uploading: undefined,/);
  });

  it('an uploading row offers no reactions; any other row does', () => {
    expect(canReactToMessage(msg({ uploading: true }))).toBe(false);
    expect(canReactToMessage(msg({ uploading: undefined }))).toBe(true);
    expect(canReactToMessage(msg({ senderPubkey: 'ccdd'.repeat(16) }))).toBe(true);
  });

  it('the chat gates the reaction picker, long-press and badges on it; both reaction handlers refuse an uploading row', () => {
    const box = read('components/chat/ChatBox.tsx');
    expect(box).toContain('const reactable = !!onReact && canReactToMessage(msg);');
    expect(box).toContain('if (!reactable) return;');
    expect(box).toMatch(/\{onReact && reactable && \(\s*<Box alignSelf="center" flexShrink=\{0\}>\s*<EmojiReactionPicker/);
    expect(box).toMatch(/\{aggregates\.length > 0 && onReact && reactable && \(\s*<ReactionBadgeRow/);
    const dm = between(read('components/contacts/ContactChat.tsx'), 'const handleReact = useCallback(', 'connectNdk(');
    expect(dm).toContain('if (message.uploading) return;');
    const group = between(read('context/ChatStoreContext.tsx'), 'const sendReaction = useCallback(', 'const thread =');
    expect(group).toContain('if (targetMessage.uploading) return;');
  });

  it('a remounted view of the upload keeps the flag; the swapped-in final row has none', () => {
    _resetPendingOwnSends();
    registerPendingOwnSend(SELF, msg({ id: 'temp-1', uploading: true }));
    const [during] = pendingOwnSendsFor(SELF, 'dm:x');
    expect(during.message?.uploading).toBe(true);
    expect(canShowMessageActions(during.message!, SELF)).toBe(false);

    replacePendingOwnSend(SELF, 'temp-1', msg({ id: 'event-1', uploading: undefined }));
    const [after] = pendingOwnSendsFor(SELF, 'dm:x');
    expect(after.id).toBe('event-1');
    expect(after.message?.uploading).toBeFalsy();
    expect(canShowMessageActions(after.message!, SELF)).toBe(true);
    _resetPendingOwnSends();
  });
});
