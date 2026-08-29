// Hmelj — pure helpers for the multi-owner-key "All inbox" cache path
// (server/index.js's queryUnifiedGrouped / mutedPairsForGroups). Deliberately
// has no imports of its own — not even session.js's userKey — so it can be
// loaded and unit-tested without pulling in cache.js/better-sqlite3 at all.

/** Buckets `list` by keyFor(item). Insertion order preserved (Map). Generic —
 *  the "shared → owner's key, else viewer's key" rule lives at the call site
 *  in index.js, not here, matching /api/sync/status's own inline grouping. */
export function groupByKey(list, keyFor) {
  const groups = new Map();
  for (const item of list) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

/** Merges N independently-queried, already-date-DESC-sorted group results
 *  (`groupResults`: [{ total, messages }]) into the true global page/pageSize
 *  window. Each group MUST already have been queried for its own top
 *  `page*pageSize` rows — sufficient because a message truly belonging in the
 *  global merged page can have at most page*pageSize-1 messages ranked above
 *  it across ALL groups combined, and its own group is a subset of that, so
 *  at most that many can rank above it within its own group either. Same
 *  k-way-merge argument unifiedLive already relies on for the live path's
 *  per-account merge (server/index.js). */
export function mergeGroupResults(groupResults, page, pageSize) {
  const total = groupResults.reduce((s, r) => s + r.total, 0);
  const merged = groupResults
    .flatMap((r) => r.messages)
    .sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0));
  return { total, messages: merged.slice((page - 1) * pageSize, page * pageSize) };
}
