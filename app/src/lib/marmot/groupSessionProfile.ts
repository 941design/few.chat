import type { EventSigner } from 'applesauce-core';
import type { MarmotGroup } from '@941design/marmot';
import type { UserProfile } from '@/src/types';
import { loadMemberProfiles } from './groupStorage';
import { loadProfileRequestMemo, recordRequestEmitted } from './profileRequestStorage';
import { PROFILE_RUMOR_KIND, serialiseProfileUpdate } from './profileSync';
import { PROFILE_REQUEST_KIND } from './profileRequestSync';
import { sweepStaleProfiles } from './profileRequestRunner';
import type { GroupRumorSender } from './send';

interface ProfileActionsOptions {
  pubkey: string;
  signer: EventSigner;
  sender: GroupRumorSender;
  groupOf(id: string): Promise<MarmotGroup | undefined>;
  profile(): UserProfile;
  writable(): boolean;
}

export function createGroupProfileActions(options: ProfileActionsOptions) {
  let disposed = false;
  const writes = new Set<Promise<unknown>>();
  const recordMemo: typeof recordRequestEmitted = (...args) => {
    if (disposed || !options.writable()) return Promise.reject(new Error('Group session is not writable'));
    const write = recordRequestEmitted(...args);
    writes.add(write);
    void write.then(() => writes.delete(write), () => writes.delete(write));
    return write;
  };
  async function dispose() {
    disposed = true;
    await Promise.allSettled([...writes]);
  }

  async function sendOwnProfile(groupId: string): Promise<void> {
    const group = await options.groupOf(groupId);
    if (!group || disposed || !options.writable()) return;
    try {
      const payload = await serialiseProfileUpdate(options.profile(), options.signer);
      if (disposed || !options.writable()) return;
      await options.sender.sendGroupRumor(group, PROFILE_RUMOR_KIND, payload, []);
    } catch (error) {
      console.warn('[group profile] background send failed', error);
    }
  }

  async function recoverMissingOwnProfiles(groupIds: readonly string[]): Promise<void> {
    await Promise.all(groupIds.map(async (groupId) => {
      const profiles = await loadMemberProfiles(groupId);
      const ownProfile = profiles.some((profile) => profile.pubkeyHex === options.pubkey &&
        !profile.provisional && profile.signedEvent?.pubkey === options.pubkey);
      if (!ownProfile) await sendOwnProfile(groupId);
    }));
  }

  async function requestProfiles(groupIds: string[]): Promise<void> {
    await sweepStaleProfiles({
      groupIds,
      selfPubkeyHex: options.pubkey,
      now: Date.now(),
      getGroupMembers: async (groupId) => [...(await options.groupOf(groupId))?.members() ?? []],
      loadProfile: async (groupId, targetPubkey) => {
        const profiles = await loadMemberProfiles(groupId);
        return profiles.find(({ pubkeyHex }) => pubkeyHex === targetPubkey);
      },
      loadMemo: loadProfileRequestMemo,
      recordEmitted: recordMemo,
      sendRumor: async (groupId, content) => {
        const group = await options.groupOf(groupId);
        if (!group) return;
        await options.sender.sendGroupRumor(group, PROFILE_REQUEST_KIND, content, []);
        if (process.env.NODE_ENV !== 'production') {
          (window as Window & { __fewTest?: { onRumorSent?: (kind: number) => void } })
            .__fewTest?.onRumorSent?.(PROFILE_REQUEST_KIND);
        }
      },
    });
  }

  async function publishProfile(profile: UserProfile, groupIds: string[], signFailed: () => void): Promise<boolean> {
    if (!groupIds.length) return true;
    let payload: string;
    try {
      if (process.env.NODE_ENV !== 'production' &&
          (window as Window & { __fewTest?: { forceProfileSignerFailure?: boolean } }).__fewTest?.forceProfileSignerFailure) {
        throw new Error('Profile signer unavailable');
      }
      payload = await serialiseProfileUpdate(profile, options.signer);
    } catch {
      signFailed();
      return false;
    }

    const sent = await Promise.allSettled(groupIds.map(async (groupId) => {
      const group = await options.groupOf(groupId);
      if (!group) return false;
      await options.sender.sendGroupRumor(group, PROFILE_RUMOR_KIND, payload, []);
      if (process.env.NODE_ENV !== 'production') {
        (window as Window & { __fewTest?: { onRumorSent?: (kind: number) => void } })
          .__fewTest?.onRumorSent?.(PROFILE_RUMOR_KIND);
      }
      return true;
    }));
    return sent.some((result) => result.status === 'fulfilled' && result.value);
  }

  return { sendOwnProfile, recoverMissingOwnProfiles, requestProfiles, publishProfile, dispose };
}
