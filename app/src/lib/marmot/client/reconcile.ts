interface ReconcileOverlayGroupsOptions {
  /** Rechecked before every purge, including after asynchronous work. */
  hasLease: () => boolean;
  overlayGroups: readonly { id: string }[];
  listedGroups: readonly { id: string }[];
  purger: { purgeLocalGroup(id: string): Promise<void> };
}

/** Purge stale overlay rows before enabling history delivery. */
export async function reconcileOverlayGroups(options: ReconcileOverlayGroupsOptions): Promise<void> {
  if (!options.hasLease()) return;
  const listed = new Set(options.listedGroups.map((group) => group.id));
  const stale = [...new Set(options.overlayGroups.map((group) => group.id))].filter((id) => !listed.has(id));
  for (const id of stale) {
    if (!options.hasLease()) return;
    await options.purger.purgeLocalGroup(id);
  }
}
