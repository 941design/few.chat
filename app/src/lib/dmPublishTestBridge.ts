/**
 * DM publish test bridge (dev only).
 *
 * Exposes `window.__fewPublishDm(peerPubkeyHex, content)` so e2e tests can make
 * a peer send a DM THROUGH THE APP (publishDirectMessage with the page's own
 * identity and NDK) instead of hand-signing events and writing them to the relay
 * (project CLAUDE.md "E2E tests"), without dynamic-importing webpack-aliased
 * modules from page.evaluate. The private key is read from localStorage at call
 * time.
 *
 * Never installed in production builds. Side-effect module: imported once from
 * pages/_app.tsx. (Moved out of unreadStore.ts, which it had nothing to do with.)
 */
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as any).__fewPublishDm = async (peerPubkeyHex: string, content: string): Promise<void> => {
    try {
      const identityRaw = localStorage.getItem('lp_nostrIdentity_v1');
      if (!identityRaw) throw new Error('No identity in localStorage');
      const identity = JSON.parse(identityRaw) as { privateKeyHex: string };
      const { connectNdk } = await import('@/src/lib/ndkClient');
      const { publishDirectMessage } = await import('@/src/lib/directMessages');
      const ndk = await connectNdk(identity.privateKeyHex);
      await publishDirectMessage({ ndk, privateKeyHex: identity.privateKeyHex, peerPubkeyHex, content });
    } catch (err) {
      console.error('[__fewPublishDm] failed:', err);
      throw err;
    }
  };
}

export {};
