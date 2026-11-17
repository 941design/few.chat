/** The generic invitation label per language, read from the real i18n tables. */
import { getCopy } from '@/src/lib/i18n';

export function copyFor() {
  return {
    en: getCopy('en').groups.pendingInvitations.unknownGroupFallback,
    de: getCopy('de').groups.pendingInvitations.unknownGroupFallback,
  };
}
