// Hmelj — account presets (Gmail, T-2, GMX, …) shown in the "add mail
// account" wizard. Global, not per-user: any Hmelj user on this instance
// sees the same list. Admin-manageable; the built-in ones just seed the
// file the first time it doesn't exist, they're editable/removable like
// anything else afterwards.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';
import { log } from './log.js';

const plog = log.scope('presets');

const FILE = () => path.join(config.dataDir, 'presets.json');

const BUILTIN_PRESETS = [
  {
    id: 'gmail', name: 'Gmail',
    imapHost: 'imap.gmail.com', imapPort: 993, imapTls: true,
    smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpTls: true,
    helpText: 'Google no longer accepts your normal password here. Turn on 2-Step Verification, then create an App Password at myaccount.google.com/apppasswords and paste that 16-character code as the password below. Or skip all of that: pick the "Gmail (sign in with Google)" account type instead and just sign in — same servers, no app password (needs an OAuth client set up under Settings → Admin once).',
    helpUrl: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 't-2', name: 'T-2 (Slovenija)',
    imapHost: 'imap.t-2.net', imapPort: 993, imapTls: true,
    smtpHost: 'smtp.t-2.net', smtpPort: 465, smtpTls: true,
    helpText: 'Uporabniško ime je vaš celoten e-poštni naslov (npr. ime.priimek@t-2.net), geslo pa je geslo za T-2 webmail.',
    helpUrl: 'https://www.t-2.net/t-2-elektronska-posta',
  },
  {
    id: 'gmx', name: 'GMX',
    imapHost: 'imap.gmx.com', imapPort: 993, imapTls: true,
    smtpHost: 'mail.gmx.com', smtpPort: 465, smtpTls: true,
    helpText: 'POP3/IMAP access must be switched on once in GMX webmail (Settings → POP3 & IMAP) before this will connect. Username is your full GMX address.',
    helpUrl: '',
  },
  {
    id: 'generic', name: 'Generic IMAP server',
    imapHost: '', imapPort: 993, imapTls: true,
    smtpHost: '', smtpPort: 465, smtpTls: true,
    helpText: '', helpUrl: '',
  },
];

function save(list) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE());
}

// Which builtin ids have ever been written into presets.json on this instance.
// Needed because presets.json is seeded exactly once, on first run: without
// this, a builtin added in a later version would only ever appear on
// brand-new installs, and every existing one would silently never see it.
// Tracking what was seeded — rather than just topping up any missing builtin —
// is what keeps a preset the admin deliberately deleted from reappearing on
// the next restart.
const SEEDED_FILE = () => path.join(config.dataDir, 'presets.builtins.json');

// Builtins that a previous version seeded and this one no longer offers.
//
// A preset describes nothing but IMAP/SMTP hosts, and Microsoft accounts
// stopped having any the moment they moved to Graph — so the Outlook preset
// now prefills a server that cannot authenticate, under help text pointing at
// a control that no longer exists. Anyone who restarted on the version that
// shipped it has a copy sitting in their presets.json, which removing it from
// BUILTIN_PRESETS does nothing about: that file is a persisted, admin-editable
// list, not a mirror of the builtins.
//
// Removed on load, but only while it still points where we pointed it. Editing
// a builtin keeps its `builtin: true` flag (savePreset below), so that flag
// alone cannot distinguish ours from a repurposed one — matching the host does.
// Rename it, reword it, and it still goes; repoint it at a server of your own
// and it is yours to keep.
const RETIRED_BUILTINS = [{ id: 'outlook', imapHost: 'outlook.office365.com' }];

function isRetired(p) {
  return RETIRED_BUILTINS.some((r) => p.id === r.id && p.builtin && p.imapHost === r.imapHost);
}

function loadSeeded() {
  try { return JSON.parse(fs.readFileSync(SEEDED_FILE(), 'utf8')); } catch { return null; }
}

function saveSeeded(ids) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = SEEDED_FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ids, null, 2));
  fs.renameSync(tmp, SEEDED_FILE());
}

function load() {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    list = BUILTIN_PRESETS.map((p) => ({ ...p, builtin: true }));
    save(list);
    saveSeeded(BUILTIN_PRESETS.map((p) => p.id));
    return list;
  }
  const retired = list.filter(isRetired);
  if (retired.length) {
    list = list.filter((p) => !isRetired(p));
    save(list);
    plog.info(`Removed ${retired.length} preset(s) that no longer apply: ${retired.map((p) => p.id).join(', ')}`);
  }
  // An instance that predates this marker was necessarily seeded with exactly
  // the builtin set that existed then, listed here explicitly. Deriving it
  // from the file instead would re-add any of those an admin had deleted.
  const seeded = loadSeeded() ?? ['gmail', 't-2', 'gmx', 'generic'];
  const missing = BUILTIN_PRESETS.filter((p) => !seeded.includes(p.id));
  if (missing.length) {
    list = [...list, ...missing.map((p) => ({ ...p, builtin: true }))];
    save(list);
  }
  if (missing.length || loadSeeded() === null) saveSeeded(BUILTIN_PRESETS.map((p) => p.id));
  return list;
}

export function listPresets() {
  return load();
}

export function savePreset(input, existingId = null) {
  const list = load();
  const idx = existingId ? list.findIndex((p) => p.id === existingId) : -1;
  const preset = {
    id: idx >= 0 ? list[idx].id : crypto.randomUUID(),
    name: input.name || 'Preset',
    imapHost: input.imapHost || '',
    imapPort: +input.imapPort || 993,
    imapTls: input.imapTls !== false,
    smtpHost: input.smtpHost || '',
    smtpPort: +input.smtpPort || 465,
    smtpTls: input.smtpTls !== false,
    helpText: input.helpText || '',
    helpUrl: input.helpUrl || '',
    builtin: idx >= 0 ? !!list[idx].builtin : false,
  };
  if (idx >= 0) list[idx] = preset; else list.push(preset);
  save(list);
  return preset;
}

export function deletePreset(id) {
  save(load().filter((p) => p.id !== id));
}
