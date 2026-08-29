// Hmelj — folder-tree ordering, shared by every mail protocol client.
//
// Purely generic: operates on {path, name, parent, specialUse} records, with
// no IMAP (or EWS) specifics — imapClient.js#listFolders() and
// ewsClient.js#listFolders() each build their own list of those records
// (from LIST/STATUS or from a synthesized EWS FindFolder tree respectively)
// and both hand the result through sortFolderTree() so a custom subfolder
// sorts and nests identically regardless of which protocol produced it.

const FOLDER_RANK = { '\\Inbox': 0, '\\Drafts': 1, '\\Sent': 2, '\\Junk': 3, '\\Trash': 4, '\\Archive': 5 };
export function folderRank(f) { return FOLDER_RANK[f.specialUse] ?? (f.path.toUpperCase() === 'INBOX' ? 0 : 9); }

// Folders that always sit at the sidebar's top level — see sortFolderTree's
// display-parent normalization below.
const TOP_LEVEL_SPECIAL_USE = new Set(['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive']);
function isTopLevelByConvention(f) {
  return f.path.toUpperCase() === 'INBOX' || TOP_LEVEL_SPECIAL_USE.has(f.specialUse);
}

/**
 * Depth-first tree order, not a flat sort, over a DISPLAY hierarchy that's
 * deliberately independent of whatever the server's real parent/path
 * structure says.
 *
 * Different servers disagree wildly on where they physically put things:
 * some self-hosted IMAP servers nest Sent/Drafts/Trash literally under
 * INBOX (an "INBOX." namespace convention), others keep them as top-level
 * siblings; Exchange and Gmail both file custom/rule-based folders as
 * siblings of INBOX rather than real children of it, even though
 * conceptually a rule that sorts mail out of the inbox is still "part of"
 * inbox organization. Letting the sidebar's shape vary by provider read as
 * arbitrary and inconsistent, so every folder's *display* parent is
 * normalized here before the tree is walked: INBOX itself, and whichever of
 * Sent/Drafts/Trash/Junk/Archive the server tags via specialUse, always sit
 * at the top level; every other folder — regardless of how deep its real
 * path nesting actually goes — is shown nested exactly one level under
 * INBOX. This does flatten a genuinely multi-level custom hierarchy (a real
 * "Work/ProjectA/Subtask" three deep on the server shows as a single flat
 * child of INBOX, not nested three levels) — a deliberate simplification
 * for a predictable, provider-independent shape over preserving arbitrary
 * real depth.
 *
 * This overwrites each folder's `parent` field on the objects passed in
 * (not just a local computation) so indentation client-side can key off it
 * directly — `path` itself is left untouched, since that's what the rest of
 * the app (API calls, sync scope, cache keys) needs to match the server's
 * real structure; only where a folder is drawn in the sidebar changes.
 */
export function sortFolderTree(folders) {
  const inboxPath = folders.find((f) => f.path.toUpperCase() === 'INBOX')?.path ?? null;
  for (const f of folders) {
    f.parent = isTopLevelByConvention(f) ? null : inboxPath;
  }

  const paths = new Set(folders.map((f) => f.path));
  const byParent = new Map();
  for (const f of folders) {
    // A parent that got filtered out (e.g. a \Noselect container, or no
    // INBOX found at all) can't be walked into — treat as top-level rather
    // than silently dropping the folder.
    const key = f.parent && paths.has(f.parent) ? f.parent : '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(f);
  }
  const cmp = (a, b) => folderRank(a) - folderRank(b) || a.name.localeCompare(b.name);
  const out = [];
  (function walk(parentKey) {
    for (const f of (byParent.get(parentKey) || []).sort(cmp)) {
      out.push(f);
      walk(f.path);
    }
  })('');
  return out;
}
