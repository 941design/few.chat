// app/src/themes/treatments/iconSets.ts
//
// Icon-name -> iconify-id maps per icon set. Lifted from
// app/src/components/ThemeIcon.tsx's ICON_MAP (pre-refactor), renaming its
// three sub-keys to the manifest vocabulary: `default` -> `line`,
// `toy` -> `filled`, `pixel` -> `pixel` (unchanged). ThemeIcon.tsx itself is
// NOT edited in this story (that is S4) — this module only stands up the
// data the S4 rewiring will consume.
//
// - "pixel" uses pixelarticons (MIT, 24x24 pixel art style)
// - "filled" uses ph:*-fill (Phosphor filled, playful weight) — old "toy"
// - "line" uses lucide:* (Lucide, clean thin line style) — the only set any
//   currently-registered theme (aquarelle) actually renders. Was Phosphor
//   ph:*-bold before; swapped to Lucide for a lighter outline character.
export type IconSetName = 'line' | 'filled' | 'pixel';

export const ICON_SETS: Record<string, Record<IconSetName, string>> = {
  heart: {
    line: 'lucide:heart',
    filled: 'ph:heart-fill',
    pixel: 'pixelarticons:heart',
  },
  check: {
    line: 'lucide:circle-check',
    filled: 'ph:check-circle-fill',
    pixel: 'pixelarticons:check',
  },
  close: {
    line: 'lucide:circle-x',
    filled: 'ph:x-circle-fill',
    pixel: 'pixelarticons:close',
  },
  home: {
    line: 'lucide:house',
    filled: 'ph:house-fill',
    pixel: 'pixelarticons:home',
  },
  settings: {
    line: 'lucide:settings',
    filled: 'ph:gear-fill',
    pixel: 'pixelarticons:sliders',
  },
  clock: {
    line: 'lucide:clock',
    filled: 'ph:clock-fill',
    pixel: 'pixelarticons:clock',
  },
  prev: {
    line: 'lucide:chevron-left',
    filled: 'ph:caret-left-fill',
    pixel: 'pixelarticons:chevron-left',
  },
  next: {
    line: 'lucide:chevron-right',
    filled: 'ph:caret-right-fill',
    pixel: 'pixelarticons:chevron-right',
  },
  bell: {
    line: 'lucide:bell',
    filled: 'ph:bell-ringing-fill',
    pixel: 'pixelarticons:notification',
  },
  info: {
    line: 'lucide:info',
    filled: 'ph:info-fill',
    pixel: 'pixelarticons:info-box',
  },
  person: {
    line: 'lucide:circle-user',
    filled: 'ph:user-circle-fill',
    pixel: 'pixelarticons:user',
  },
  contacts: {
    line: 'lucide:contact',
    filled: 'ph:address-book-fill',
    pixel: 'pixelarticons:contact',
  },
  groups: {
    line: 'lucide:users',
    filled: 'ph:users-three-fill',
    pixel: 'pixelarticons:group',
  },
  scan: {
    // Scanner viewfinder — idiomatic "scan a QR" affordance, deliberately
    // distinct from the `qr-code` glyph used to *show* a QR (NpubQrButton).
    line: 'lucide:scan-line',
    filled: 'ph:scan-fill',
    pixel: 'pixelarticons:scan',
  },
  phone: {
    line: 'lucide:phone',
    filled: 'ph:phone-fill',
    pixel: 'pixelarticons:phone',
  },
  video: {
    line: 'lucide:video',
    filled: 'ph:video-camera-fill',
    pixel: 'pixelarticons:camera',
  },
};

/**
 * Resolves the iconify id for a semantic icon name under the given icon set.
 * Falls back to the `line` set (the old `default` case) when `name` isn't a
 * mapped icon or the requested set is somehow missing on that entry — mirrors
 * `ThemeIcon.tsx`'s pre-refactor `iconSet[vs] ?? iconSet.default` fallback.
 * Returns `''` when `name` has no entry at all (pre-refactor behavior:
 * `ThemeIcon` renders nothing, `getThemeIconId` returns `''`).
 */
export function resolveIconId(name: string, iconSet: IconSetName): string {
  const entry = ICON_SETS[name];
  if (!entry) return '';
  return entry[iconSet] ?? entry.line;
}
