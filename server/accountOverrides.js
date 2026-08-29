// Hmelj — per-viewer personalization for a SHARED mail account (Phase 2 of
// the shared-accounts plan). A grantee can hide additional folders from
// their own sidebar without touching the owner's account record at all —
// storage mirrors accounts.js's own explicit-userKey pattern (one small JSON
// file per Hmelj user, this time keyed by accountId inside it) rather than
// writing into the owner's accounts.json, which they have no access to and
// which must stay the single shared source of truth for sync scope.
//
// Deliberately additive-only for hiddenFolders (enforced by the caller,
// accounts.js#listSharedInAccounts, which unions this with the owner's own
// hiddenFolders) — a grantee can hide more, never un-hide something the
// owner excluded from sync in the first place (nothing would be cached to
// show anyway). label/color let a grantee rename/recolor the account in
// their own sidebar without renaming it for the owner or any other grantee.
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

function fileFor(uKey) {
  const dir = path.join(config.dataDir, 'users', uKey);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'accountOverrides.json');
}

function loadFor(uKey) {
  try { return JSON.parse(fs.readFileSync(fileFor(uKey), 'utf8')); } catch { return {}; }
}

function saveFor(uKey, data) {
  const tmp = fileFor(uKey) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, fileFor(uKey));
}

/** This viewer's personal overrides for one shared account, or null. */
export function getOverride(viewerKey, accountId) {
  return loadFor(viewerKey)[accountId] || null;
}

/** Merge-patch — only the keys present in `patch` (label/color/hiddenFolders) are touched. */
export function setOverride(viewerKey, accountId, patch) {
  const data = loadFor(viewerKey);
  data[accountId] = { ...(data[accountId] || {}), ...patch };
  saveFor(viewerKey, data);
  return data[accountId];
}

/** Called when a share ends (either side) — no point keeping a personal
 * override around for an account this viewer can no longer see. */
export function clearOverride(viewerKey, accountId) {
  const data = loadFor(viewerKey);
  if (accountId in data) {
    delete data[accountId];
    saveFor(viewerKey, data);
  }
}
