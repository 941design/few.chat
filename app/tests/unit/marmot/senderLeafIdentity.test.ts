/**
 * senderLeafIdentityAtMessageEpoch (bug: journal-replayed-leave-evicts-rejoined-member).
 *
 * The rumor journal records, at first receipt, WHICH membership sent a
 * message: the sender pubkey's leaf identity in the ratchet tree of the epoch
 * the message was encrypted in. ts-mls exposes the message epoch but no
 * per-leaf join epoch, so the leaf keys are the dating evidence. Exercised with
 * the REAL marmot-ts getPubkeyLeafNodes over hand-built ts-mls trees (basic
 * credentials, leaf nodes), shaped like a processed ingest result.
 */

import { describe, it, expect } from 'vitest';
import { getPubkeyLeafNodes } from '@internet-privacy/marmot-ts';
import { senderLeafIdentityAtMessageEpoch } from '@/src/lib/marmot/epochResolver';
import { leafIdentityOf } from '@/src/lib/marmot/pendingRemovalStorage';

const SENDER = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

function leafNode(pubkey: string, sig: number, hpke: number) {
  return {
    nodeType: 1, // ts-mls nodeTypes.leaf
    leaf: {
      credential: { credentialType: 1, identity: hexBytes(pubkey) }, // basic credential
      signaturePublicKey: new Uint8Array([sig]),
      hpkePublicKey: new Uint8Array([hpke]),
    },
  };
}

const ORIGINAL_TREE = [leafNode(SENDER, 1, 2), undefined, leafNode(OTHER, 3, 4)];
const REJOINED_TREE = [leafNode(SENDER, 7, 8), undefined, leafNode(OTHER, 3, 4)];
const ORIGINAL_ID = leafIdentityOf([ORIGINAL_TREE[0]!.leaf]);
const REJOINED_ID = leafIdentityOf([REJOINED_TREE[0]!.leaf]);

function processed(opts: { messageEpoch?: bigint | null; currentEpoch: bigint; current: unknown[]; history?: Array<[bigint, unknown[]]>; sender?: string }) {
  return {
    message: opts.messageEpoch === null ? { publicMessage: {} } : { privateMessage: { epoch: opts.messageEpoch } },
    result: {
      newState: {
        groupContext: { epoch: opts.currentEpoch },
        ratchetTree: opts.current,
        historicalReceiverData: new Map((opts.history ?? []).map(([e, tree]) => [e, { ratchetTree: tree }])),
      },
    },
    senderPubkey: opts.sender ?? SENDER,
  } as never;
}

describe('senderLeafIdentityAtMessageEpoch', () => {
  it('a current-epoch message: the sender\'s leaf identity in the current tree', () => {
    expect(ORIGINAL_ID).not.toBe(REJOINED_ID);
    expect(senderLeafIdentityAtMessageEpoch(processed({ messageEpoch: 5n, currentEpoch: 5n, current: ORIGINAL_TREE }), getPubkeyLeafNodes as never))
      .toBe(ORIGINAL_ID);
  });

  it('a past-epoch message: the retained tree of ITS epoch, not the current one (the member re-joined since)', () => {
    const p = processed({ messageEpoch: 4n, currentEpoch: 6n, current: REJOINED_TREE, history: [[4n, ORIGINAL_TREE], [5n, REJOINED_TREE]] });
    expect(senderLeafIdentityAtMessageEpoch(p, getPubkeyLeafNodes as never)).toBe(ORIGINAL_ID);
  });

  it('undefined when the past epoch\'s tree is not retained, when the message carries no private epoch, or when the sender has no leaf', () => {
    expect(senderLeafIdentityAtMessageEpoch(processed({ messageEpoch: 3n, currentEpoch: 6n, current: REJOINED_TREE, history: [[4n, ORIGINAL_TREE]] }), getPubkeyLeafNodes as never))
      .toBeUndefined();
    expect(senderLeafIdentityAtMessageEpoch(processed({ messageEpoch: null, currentEpoch: 6n, current: ORIGINAL_TREE }), getPubkeyLeafNodes as never))
      .toBeUndefined();
    expect(senderLeafIdentityAtMessageEpoch(processed({ messageEpoch: 6n, currentEpoch: 6n, current: ORIGINAL_TREE, sender: 'ef'.repeat(32) }), getPubkeyLeafNodes as never))
      .toBeUndefined();
  });

  it('an epoch that is not a bigint (malformed message) yields undefined', () => {
    const p = processed({ messageEpoch: 6n, currentEpoch: 6n, current: ORIGINAL_TREE }) as unknown as { message: { privateMessage: { epoch: unknown } } };
    p.message.privateMessage.epoch = 6;
    expect(senderLeafIdentityAtMessageEpoch(p as never, getPubkeyLeafNodes as never)).toBeUndefined();
    expect(senderLeafIdentityAtMessageEpoch({ ...(p as object), message: null } as never, getPubkeyLeafNodes as never)).toBeUndefined();
  });
});
