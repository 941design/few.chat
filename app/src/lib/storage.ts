import type {
  LanguageCode,
  Settings,
  UserProfile,
} from '@/src/types';
import { STORAGE_KEYS } from '@/src/types';
import { DEFAULT_THEME_NAME, normalizeThemeName } from '@/src/lib/theme';
import { AVATAR_BROWSER_CONFIG, capNickname } from '@/src/config/profile';

// ============================
// localStorage availability check
// ============================

let _storageAvailable: boolean | null = null;

export function isStorageAvailable(): boolean {
  if (_storageAvailable !== null) return _storageAvailable;

  try {
    const testKey = '__lp_test__';
    localStorage.setItem(testKey, 'test');
    localStorage.removeItem(testKey);
    _storageAvailable = true;
  } catch {
    _storageAvailable = false;
  }

  return _storageAvailable;
}

// ============================
// Generic read/write helpers
// ============================

function readItem<T>(key: string, defaultValue: T): T {
  if (!isStorageAvailable()) return defaultValue;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

function writeItem<T>(key: string, value: T): void {
  if (!isStorageAvailable()) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Silent fail — storage may be full or restricted
  }
}

// ============================
// Settings
// ============================

const DEFAULT_SETTINGS: Settings = { theme: DEFAULT_THEME_NAME, language: 'en' };
const DEFAULT_USER_PROFILE: UserProfile = { nickname: '', avatar: null };

export function readSettings(): Settings {
  const stored = readItem<Partial<Settings> | null>(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  const storedTheme = normalizeThemeName(stored?.theme ?? stored?.mood);
  return {
    ...DEFAULT_SETTINGS,
    ...(stored ?? {}),
    theme: storedTheme,
  };
}

// Returns the language the user has explicitly stored, or `undefined` when no
// preference has been persisted yet. Unlike `readSettings().language`, this does
// NOT fall back to a default — callers need to tell "unset" apart from a real
// choice so browser-language detection can run on a first visit.
export function readStoredLanguage(): LanguageCode | undefined {
  const stored = readItem<Partial<Settings> | null>(STORAGE_KEYS.settings, null);
  return stored?.language;
}

export function writeSettings(settings: Settings): void {
  writeItem(STORAGE_KEYS.settings, {
    theme: normalizeThemeName(settings.theme ?? settings.mood),
    language: settings.language,
  });
}

// ============================
// User Profile
// ============================

function normalizeUserProfile(raw: Partial<UserProfile> | null | undefined): UserProfile {
  // Byte-cap (not char-slice) so a restored/legacy profile carrying a
  // multi-byte nickname over the card's 32-UTF-8-byte budget is contained at
  // the persistence boundary too, matching the save-time cap. (AC-CARD-7)
  const nickname = typeof raw?.nickname === 'string'
    ? capNickname(raw.nickname.trim()).value
    : '';

  // Canonical shape carries only imageUrl. Legacy profiles (and restored legacy
  // backups) stored an `id` instead — reconstruct the imageUrl from it.
  const rawAvatar = raw?.avatar as { imageUrl?: unknown; id?: unknown } | null | undefined;
  let avatar: UserProfile['avatar'] = null;
  if (rawAvatar && typeof rawAvatar.imageUrl === 'string') {
    avatar = { imageUrl: rawAvatar.imageUrl };
  } else if (rawAvatar && typeof rawAvatar.id === 'string') {
    avatar = { imageUrl: `${AVATAR_BROWSER_CONFIG.endpointBaseUrl}/${rawAvatar.id}.png` };
  }

  return {
    nickname,
    avatar,
  };
}

export function readUserProfile(): UserProfile {
  const stored = readItem<Partial<UserProfile> | null>(STORAGE_KEYS.userProfile, DEFAULT_USER_PROFILE);
  return normalizeUserProfile(stored);
}

export function writeUserProfile(profile: UserProfile): void {
  writeItem(STORAGE_KEYS.userProfile, normalizeUserProfile(profile));
}

// ============================
// KeyPackage slot (MIP-00 `d` tag identifier)
// ============================

// MIP-00: the KeyPackage addressable slot identifier must be exactly 64
// lowercase hex characters. A pre-migration install may have a persisted
// (or literal, never-persisted) value of 'few', which does not match.
const KEY_PACKAGE_SLOT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Reads the persisted KeyPackage slot identifier, or mints and persists one
 * via `mintSlot` when absent or non-conformant (covers both a fresh install
 * with nothing persisted yet, and a pre-migration install whose persisted
 * value is the legacy free-form `'few'` literal or any other value that does
 * not match MIP-00's `/^[0-9a-f]{64}$/` shape).
 *
 * Precondition: `mintSlot` returns a value conformant to
 * `/^[0-9a-f]{64}$/` (e.g. marmot-ts's `generateKeyPackageSlot()`). Not
 * validated here — the caller is trusted to pass a conformant minter.
 *
 * Postcondition: the returned value always matches
 * `/^[0-9a-f]{64}$/`. When a fresh value is minted, it is persisted via
 * `writeItem` (localStorage, when available) *before* this function
 * returns, so a caller that immediately constructs a stateful client with
 * the returned slot as `clientId` is guaranteed the persisted value is
 * already durable. When storage is unavailable (`isStorageAvailable()` is
 * false), the mint still happens and is returned, but nothing is persisted
 * — the next call in the same session will mint again (no crash, no
 * silent staleness across a single unavailable-storage session).
 *
 * `mintSlot` is injected rather than imported statically here so this
 * module (and everything that transitively imports it) does not pull in
 * the marmot-ts/ts-mls dependency graph. Callers dynamically import
 * `generateKeyPackageSlot` from `@internet-privacy/marmot-ts` themselves
 * (mirroring MarmotContext.tsx's existing browser-gated dynamic import).
 *
 * @param mintSlot - Mints a fresh, MIP-00-conformant hex slot. Called at
 *   most once per invocation of this function.
 * @returns The persisted (or freshly minted) hex slot, byte-identical
 *   across calls once a conformant value exists.
 */
export function readOrCreateKeyPackageSlot(mintSlot: () => string): string {
  const stored = readItem<string | null>(STORAGE_KEYS.keyPackageSlot, null);
  if (typeof stored === 'string' && KEY_PACKAGE_SLOT_PATTERN.test(stored)) {
    return stored;
  }

  const minted = mintSlot();
  writeItem(STORAGE_KEYS.keyPackageSlot, minted);
  return minted;
}

// ============================
// Reset all app data
// ============================
//
// CURRENTLY UNUSED. The "Reset All Data" / "Clear all data" action was removed
// from the frontend (the Settings page) because an accidental trigger would
// irreversibly wipe the user's identity and all local state. The logic below is
// intentionally retained — it is still correct and unit-tested — so the
// capability can be re-exposed behind stronger safeguards in the future. Do not
// wire it back into the UI without a deliberate, hard-to-misfire confirmation flow.

export function resetAllData(): void {
  if (!isStorageAvailable()) return;
  Object.values(STORAGE_KEYS).forEach((key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // Silent fail
    }
  });

  // Also clear IndexedDB account-scoped data. Fire-and-forget — the caller
  // typically reloads the page right after this returns, but each clear must
  // run regardless of whether the previous one rejects so leftover data from
  // the prior identity does not survive on disk.
  if (typeof window !== 'undefined') {
    void clearAccountScopedIdbData();
  }
}

async function clearAccountScopedIdbData(): Promise<void> {
  const tasks: Array<Promise<unknown>> = [
    import('@/src/lib/marmot/groupStorage').then(({ clearAllGroupData }) => clearAllGroupData()),
    import('@/src/lib/marmot/chatPersistence').then(({ clearAllMessages }) => clearAllMessages()),
    import('@/src/lib/marmot/inviteLinkStorage').then(({ clearAllInviteLinks }) => clearAllInviteLinks()),
    import('@/src/lib/marmot/joinRequestStorage').then(({ clearAllPendingJoinRequests }) => clearAllPendingJoinRequests()),
    import('@/src/lib/marmot/pollPersistence').then(({ clearAllPollData }) => clearAllPollData()),
    import('@/src/lib/marmot/mediaPersistence').then(({ clearAllMedia }) => clearAllMedia()),
    // Wipe both reaction namespaces (few:reactions:group:* and few:reactions:dm:*)
    // so reactions from one identity do not survive an account switch (AC-14, D11).
    import('@/src/lib/reactions/api').then(({ clearAllReactions }) => clearAllReactions()),
    // Wipe the message-edits pending-signal buffer, delete-marker set, and
    // slot-meta bookkeeping (epic-feature-request-message-edit-and-delete, S3)
    // so a delete/edit signal buffered for a previous identity cannot leak
    // into a newly-switched-to identity's session.
    import('@/src/lib/messageEdits/api').then(({ clearAllMessageEditsState }) => clearAllMessageEditsState()),
  ];
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[storage] resetAllData IDB clear failed:', result.reason);
    }
  }
}
