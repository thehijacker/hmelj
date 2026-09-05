// Hmelj — contact groups: a named set of addresses the composer can address as
// one thing.
//
// ── Why a TOKEN and not an expansion ─────────────────────────────────────────
// Picking "Team" in compose's recipient autocomplete writes `👥 Team` into the
// field, not the eight addresses behind it. The field stays readable, and the
// group is resolved on the SERVER, once, at the moment the message is actually
// handed over (POST /api/send and POST /api/drafts). Nothing downstream — the
// scheduled-send queue, smtpClient, the EWS and Graph send paths,
// contacts.js#learnRecipients — ever sees a group at all, which is the point:
// one expansion site rather than six places that each have to remember.
//
// ── Why the token is safe to leave in a text field ───────────────────────────
// To/Cc/Bcc are plain <input>s, and every send path parses them with
// nodemailer's addressparser (see contacts.js#parseRecipients for why that
// parser and no other). That parser hands back a group token as an entry with an
// EMPTY address:
//
//   "👥 Team, ana@firma.si"  ->  [{address:'', name:'👥 Team'}, {address:'ana@firma.si', name:''}]
//
// and — this is the part a hand-rolled split on ','/';' gets wrong — it still
// keeps `"Novak, Bo" <bo@x.si>` in one piece. So "has no @" IS the detection
// rule, and there is no string surgery anywhere in this file.
//
// A group is stored as ADDRESSES, not as contact ids: a synced contact's id is
// composite and derived from its card (contactSources.js#allRowsFor), so it
// changes when the card is re-synced, and a group keyed on ids would quietly
// lose members. The lowercased address is the same identity contacts.js already
// de-dupes on.
import crypto from 'node:crypto';
import addressparser from 'nodemailer/lib/addressparser/index.js';

/** The marker the composer puts in front of a group's name. Cosmetic in the
 *  field, load-bearing in expandGroupsInField: a token wearing it MUST resolve
 *  to a group, so a typo can never be mailed to somebody as a broken address. */
export const GROUP_MARK = '👥';

/** How many groups one person may keep, and how many people one may hold. Both
 *  are UI ceilings rather than storage ones — the file is tiny either way — but
 *  a group of ten thousand is a mailing list, and a mailing list belongs on a
 *  mail server, not in an address book. */
const MAX_GROUPS = 200;
const MAX_MEMBERS = 1000;

/** Characters a group's name may not contain, because the name IS the token:
 *  ',' and ';' are what addressparser splits recipients on, '<' '>' would make
 *  it look like an address, '@' would make it parse as one, '"' would open a
 *  quoted string that never closes. Stripped rather than rejected, for the same
 *  reason normalizeSavedSearches repairs instead of refusing (store.js). */
const NAME_BANNED = /[,;<>@"]/g;

/** The name as it is compared and looked up: marker off, collapsed whitespace,
 *  lowercased. Used both when normalising (to spot duplicates) and when
 *  resolving a token, so the two can never disagree about what "the same name"
 *  means. */
export function groupKey(name) {
  return String(name || '').replace(GROUP_MARK, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Shapes a group list into what the composer and the send path can use.
 *
 * Same whole-list, repair-don't-reject contract as store.js's
 * normalizeSavedSearches: refusing a bad entry would take the person's other
 * groups down with it.
 *
 * Two rules that are specific to this shape:
 *
 *   - A group with NO MEMBERS is kept. A saved search with no query is dropped
 *     because it is indistinguishable from a bug, but a group is built by
 *     adding to it and therefore exists before it has anybody in it. Sending to
 *     an empty one is what fails, loudly, in expandPayloadGroups.
 *   - Duplicate names are disambiguated ("Team", "Team 2"), never merged and
 *     never dropped. A token resolves BY NAME, so two groups called "Team"
 *     would make `👥 Team` ambiguous — and silently picking the first is the
 *     kind of guess that mails a message to the wrong eight people.
 */
export function normalizeContactGroups(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((g) => g && typeof g === 'object')
    .slice(0, MAX_GROUPS)
    .map((g) => {
      // Trimmed BEFORE the fallback, like normalizeSavedSearches' name: a name
      // of "   " is truthy, so testing it first accepts the whitespace and then
      // trims it away, leaving a group with no label to type.
      let name = String(g.name || '').replace(NAME_BANNED, '').replace(/\s+/g, ' ').trim().slice(0, 80)
        || 'Group';
      // Suffix until the key is free. The loop is bounded by MAX_GROUPS above,
      // so it cannot run away even if every group is called the same thing.
      if (seen.has(groupKey(name))) {
        let n = 2;
        while (seen.has(groupKey(`${name} ${n}`))) n++;
        name = `${name} ${n}`;
      }
      seen.add(groupKey(name));
      const members = [];
      const inGroup = new Set();
      for (const m of Array.isArray(g.members) ? g.members : []) {
        // Accepts a bare address or a {email} row, so the Settings UI can hand
        // over whichever it happens to be holding.
        const addr = String((m && typeof m === 'object' ? m.email : m) || '').trim().toLowerCase();
        if (!addr.includes('@') || inGroup.has(addr)) continue;
        inGroup.add(addr);
        members.push(addr);
        if (members.length >= MAX_MEMBERS) break;
      }
      return { id: String(g.id || crypto.randomUUID()), name, members };
    });
}

/** One recipient back into text: `Name <addr>`, or the bare address when there
 *  is no name. Only ever applied to a field that actually contained a group —
 *  see expandGroupsInField. */
function serialize({ name, address }) {
  const n = String(name || '').trim();
  if (!n) return address;
  // A display name with a comma or a quote in it has to go back inside quotes,
  // or re-parsing the field would split the person in half.
  return /[,;<>"]/.test(n) ? `"${n.replace(/"/g, '')}" <${address}>` : `${n} <${address}>`;
}

/**
 * Expands every group token in one recipient field.
 *
 * Returns `{ text, unknown, empty }` — `unknown` and `empty` name the groups
 * that could not be honoured, so the caller can refuse the whole send with a
 * sentence that says which one (expandPayloadGroups does exactly that).
 *
 * The field is returned BYTE-IDENTICAL when it holds no group at all. That is
 * what makes this safe to apply on every send: the overwhelmingly common case
 * is a field of ordinary addresses, and re-serialising those would mean this
 * function silently rewriting what the user typed for no reason.
 *
 * Which tokens count as a group, per parsed entry:
 *   - an address containing '@'          → a real recipient, kept untouched
 *   - no '@', text starts with the marker → MUST resolve, else reported
 *   - no '@', text matches a group name   → resolves too (the marker is easy to
 *                                           delete by accident mid-field)
 *   - no '@', no match                    → left exactly as typed; that is what
 *                                           happens today, and turning it into
 *                                           an error here would refuse sends
 *                                           that have nothing to do with groups
 */
export function expandGroupsInField(text, groups) {
  const raw = String(text || '');
  if (!raw.trim()) return { text: raw, unknown: [], empty: [] };
  const byKey = new Map((groups || []).map((g) => [groupKey(g.name), g]));
  const parsed = addressparser(raw, { flatten: true });
  const unknown = [];
  const empty = [];
  const out = [];
  const seen = new Set(); // an address the group shares with one already typed is listed once
  let expanded = false;

  const push = (address, name = '') => {
    const key = String(address).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, address });
  };

  for (const entry of parsed) {
    const address = String(entry.address || '').trim();
    if (address.includes('@')) { push(address, entry.name); continue; }
    // Everything the parser could not read as an address arrives here as text:
    // the token itself lands in `name` when there is no <…> part at all.
    const token = String(entry.name || address || '').trim();
    if (!token) continue;
    const group = byKey.get(groupKey(token));
    // A token that cannot be honoured is REPORTED and then passed through
    // exactly as typed, never dropped. The strict caller (a send) refuses the
    // whole message on the report; the lenient one (saving a draft) keeps the
    // text so the person still has what they wrote. Dropping it would be the
    // one unrecoverable option.
    if (!group) {
      if (token.startsWith(GROUP_MARK)) unknown.push(token.replace(GROUP_MARK, '').trim());
      out.push({ name: '', address: token });
      continue;
    }
    if (!group.members.length) {
      empty.push(group.name);
      out.push({ name: '', address: token });
      continue;
    }
    expanded = true;
    for (const m of group.members) push(m);
  }

  if (!expanded) return { text: raw, unknown, empty };
  return { text: out.map(serialize).join(', '), unknown, empty };
}

/**
 * Expands the groups in a send/draft payload's To/Cc/Bcc, in place.
 *
 * `strict` (the default, and what SENDING uses) throws on a group that cannot
 * be honoured. Silently dropping it would mean a message addressed to eight
 * people going to none of them with nothing said, which is the worst outcome
 * available here — and the composer is still open to show the error in.
 *
 * SAVING A DRAFT passes `strict: false`. A draft save happens on its own,
 * whenever a composer closes, and refusing one would cost the person everything
 * they had written to punish a group name that no longer resolves. The token
 * stays in the field instead, and is expanded (or refused) if and when they
 * press Send.
 *
 * Idempotent — a field of real addresses expands to itself — which is what lets
 * both /api/send and /api/drafts call it without either having to know whether
 * the other already did.
 */
export function expandPayloadGroups(payload, groups, { strict = true } = {}) {
  if (!payload) return payload;
  const unknown = [];
  const empty = [];
  for (const field of ['to', 'cc', 'bcc']) {
    if (!payload[field]) continue;
    const r = expandGroupsInField(payload[field], groups);
    payload[field] = r.text;
    unknown.push(...r.unknown);
    empty.push(...r.empty);
  }
  if (!strict) return payload;
  if (unknown.length) throw new Error(`There is no contact group called "${unknown[0]}"`);
  if (empty.length) throw new Error(`The contact group "${empty[0]}" has nobody in it`);
  return payload;
}
