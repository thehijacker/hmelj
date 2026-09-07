// Hmelj — CSV reading, for the contacts importer's field mapping.
//
// The server can already parse a Google Contacts export (see the
// /api/contacts/import route), by looking for a column called something like
// "Name" and one called something like "E-mail". That works for exactly the
// file it was written for and fails silently for everything else — and "our
// company address book, exported to CSV" is never that file. It has "Priimek"
// where Google has "Last Name", it is semicolon-separated because it came out
// of a European Excel, and the person's name is in two columns that have to be
// put back together.
//
// So the columns are read here, in the browser, and the user says which is
// which (see importCsvWithMapping in settings.js). That turns a silent
// no-op into a dialog you can correct.
//
// RFC 4180 with the concessions reality demands: a BOM in front of the first
// header (Excel writes one, and without stripping it the first column's name
// is "﻿First Name", which no pattern matches), CRLF or LF, doubled quotes
// inside a quoted field, and separators sniffed rather than assumed.
const Csv = (() => {
  /** Comma, semicolon or tab — whichever appears most often OUTSIDE quotes in
   *  the first line. Counting outside quotes is the whole trick: "Kralj,
   *  Simona";simona@… has more commas than semicolons and is not a
   *  comma-separated line. */
  function sniff(text) {
    let inQuotes = false;
    const counts = { ',': 0, ';': 0, '\t': 0 };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        // A doubled quote inside a quoted field is an escaped quote, not the end.
        if (inQuotes && text[i + 1] === '"') { i++; continue; }
        inQuotes = !inQuotes;
      } else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
      else if (!inQuotes && ch in counts) counts[ch]++;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : ',';
  }

  /**
   * `text` → `{ delimiter, rows }`, every row an array of strings.
   *
   * Rows are NOT padded to a common width: a short row is a short row, and the
   * mapper reads a missing column as an empty value rather than as an error.
   * Completely empty lines are dropped — a trailing newline is not a contact.
   */
  function parse(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const delimiter = sniff(src);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let hasContent = false;   // this row had something, even if it was ""

    const endField = () => { row.push(field); field = ''; };
    const endRow = () => {
      endField();
      // "a,,," is a row of empty strings and worth keeping; "\n\n" is not.
      if (hasContent || row.some((f) => f !== '')) rows.push(row);
      row = [];
      hasContent = false;
    };

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inQuotes) {
        if (ch === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
        continue;
      }
      if (ch === '"') { inQuotes = true; hasContent = true; continue; }
      if (ch === delimiter) { endField(); continue; }
      if (ch === '\r') { if (src[i + 1] === '\n') i++; endRow(); continue; }
      if (ch === '\n') { endRow(); continue; }
      field += ch;
    }
    // Whatever the file ended mid-way through is still a row.
    if (field !== '' || row.length) endRow();

    return { delimiter, rows: rows.map((r) => r.map((f) => f.trim())) };
  }

  /**
   * Does the first row name the columns, or is it already data?
   *
   * An address book export whose first row holds an address is a file with no
   * header — and guessing wrong costs the user one contact, or one column of
   * every contact, so the dialog shows this as a checkbox they can flip. The
   * test is deliberately narrow: a header does not contain an @, and does not
   * repeat the same word twice.
   */
  function looksLikeHeader(row) {
    if (!row?.length) return false;
    if (row.some((f) => f.includes('@'))) return false;
    return row.some((f) => f !== '');
  }

  return { parse, sniff, looksLikeHeader };
})();
if (typeof window !== 'undefined') window.Csv = Csv;
