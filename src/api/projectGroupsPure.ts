// Mobile Projects list ordering — pure + Node-testable with zero imports
// (the feedbackPure.ts idiom). The daemon's `/cli/project-group/list`
// order is pinned-first → sort_order → name; MOBILE deliberately ignores
// sort_order for the unpinned tail and shows it alphabetically (product
// call): pinned groups keep the daemon's relative order and render first
// under a "Pinned" section label, everything else follows A–Z.

/** The slice of ProjectGroup the ordering needs. */
export interface PinnableGroup {
  name: string;
  pinned: boolean;
}

export interface PartitionedGroups<T> {
  /** Daemon-relative order preserved (the owner's arrangement). */
  pinned: T[];
  /** Case-insensitive A–Z by name. */
  rest: T[];
}

/** Split into the pinned block (stable, daemon order) and the unpinned
 *  tail (alphabetical, case-insensitive). */
export function partitionPinnedAlpha<T extends PinnableGroup>(
  groups: T[]
): PartitionedGroups<T> {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const g of groups) (g.pinned ? pinned : rest).push(g);
  rest.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { pinned, rest };
}
