// Hmelj — admin-uploaded custom fonts (TTF/OTF/WOFF/WOFF2), grouped by
// family with up to 4 style slots (regular/bold/italic/boldItalic). Global,
// not per-user (same "admin manages, every user sees the same list" shape as
// server/presets.js) — available to every user via GET /api/fonts + the
// /fonts/custom static mount (see server/index.js), for both the App font
// (whole app chrome) and Message font (sandboxed reading-pane iframe) pickers.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from './config.js';

const FILE = () => path.join(config.dataDir, 'fonts.json');
const FONTS_DIR = () => path.join(config.dataDir, 'fonts');
export const STYLES = ['regular', 'bold', 'italic', 'boldItalic'];

const EXT_BY_MIME = {
  'font/ttf': '.ttf', 'application/x-font-ttf': '.ttf',
  'font/otf': '.otf', 'application/vnd.ms-opentype': '.otf',
  'font/woff': '.woff', 'application/font-woff': '.woff',
  'font/woff2': '.woff2', 'application/font-woff2': '.woff2',
};
const ALLOWED_EXT = new Set(['.ttf', '.otf', '.woff', '.woff2']);
// So an uploaded family can't shadow a built-in preset's label in the font
// dropdowns — see app.js's GENERIC_FONTS/FONT_MIGRATE for the full list this
// mirrors (generic keywords + the specific names those replaced).
const RESERVED_NAMES = new Set([
  'system-ui', 'serif', 'sans-serif', 'monospace', 'cursive',
  'arial', 'verdana', 'tahoma', 'roboto', 'georgia', 'times new roman', 'courier new',
]);

function save(list) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE());
}
function load() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); }
  catch { return []; }
}

/** Alnum/space/hyphen only, 1-64 chars — never used in a filesystem path
 * itself (the on-disk directory is always the family's generated id, see
 * uploadFontStyle below, closing off path traversal regardless of what a
 * family name contains), this is purely to keep it a sane, unambiguous CSS
 * font-family value and dropdown label. */
function sanitizeFamily(name) {
  const trimmed = String(name || '').trim().replace(/[^\w \-]/g, '').slice(0, 64);
  if (!trimmed) throw new Error('Font family name required');
  if (RESERVED_NAMES.has(trimmed.toLowerCase())) throw new Error(`"${trimmed}" is a reserved font name`);
  return trimmed;
}

/** Extension by declared filename first, falling back to MIME type — neither
 * is deep binary validation, but a mismatched-but-harmless file just fails
 * silently in the browser as an unusable @font-face rule (never executed,
 * only parsed by the font engine), not a security concern worth heavier
 * validation for an admin-only upload endpoint. */
function extFor(file) {
  const byName = path.extname(file.originalname || '').toLowerCase();
  if (ALLOWED_EXT.has(byName)) return byName;
  const byMime = EXT_BY_MIME[file.mimetype];
  if (byMime) return byMime;
  throw new Error('Unsupported font file type — use .ttf, .otf, .woff, or .woff2');
}

/** {id, family, styles: {regular, bold, italic, boldItalic}} per family, each
 * present style resolved to its actual /fonts/custom/... URL (or null) so
 * the client doesn't need to guess filenames/extensions. */
export function listFonts() {
  return load().map((f) => ({
    id: f.id,
    family: f.family,
    styles: Object.fromEntries(STYLES.map((s) => [s, f.styles[s] ? `/fonts/custom/${f.id}/${f.styles[s]}` : null])),
  }));
}

/** Upserts one style file into a family — omit familyId to create a new
 * family from this first upload (its family name), pass an existing family's
 * id to add/replace one more style on it. `file` is a multer file object
 * ({ originalname, mimetype, buffer }). */
export function uploadFontStyle({ familyId, family, style }, file) {
  if (!STYLES.includes(style)) throw new Error('Invalid font style');
  const list = load();
  let entry = familyId ? list.find((f) => f.id === familyId) : null;
  if (familyId && !entry) throw new Error('Font family not found');
  const ext = extFor(file);
  if (entry) {
    // Family name is fixed once created via its first upload — a mismatched
    // `family` alongside an existing familyId is rejected rather than
    // silently renaming it out from under whatever's already showing in
    // every user's font dropdown.
    if (family && sanitizeFamily(family) !== entry.family) {
      throw new Error('Family name does not match the existing font family');
    }
  } else {
    entry = { id: crypto.randomUUID(), family: sanitizeFamily(family), styles: {} };
    list.push(entry);
  }
  const dir = path.join(FONTS_DIR(), entry.id);
  fs.mkdirSync(dir, { recursive: true });
  // A re-upload might change extension (e.g. swapping a .ttf for a .woff2)
  // — remove whatever file was there before writing the new one.
  if (entry.styles[style]) {
    const old = path.join(dir, entry.styles[style]);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  const filename = style + ext;
  fs.writeFileSync(path.join(dir, filename), file.buffer);
  entry.styles[style] = filename;
  save(list);
  return entry;
}

export function deleteFontFamily(id) {
  fs.rmSync(path.join(FONTS_DIR(), id), { recursive: true, force: true });
  save(load().filter((f) => f.id !== id));
}

export function deleteFontStyle(id, style) {
  if (!STYLES.includes(style)) throw new Error('Invalid font style');
  const list = load();
  const entry = list.find((f) => f.id === id);
  if (!entry || !entry.styles[style]) return;
  const file = path.join(FONTS_DIR(), id, entry.styles[style]);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  entry.styles[style] = null;
  save(list);
}
