// Pasting and dropping files into the composer (public/js/compose.js).
//
// Neither existed: pasting a screenshot did nothing at all, and dropping a
// file onto the composer let the BROWSER handle it — which navigates the page
// away to display that file and loses whatever was being written.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. compose.js is an IIFE, so unlike
// app.js (see test/select-range-test.mjs) its internals cannot be reached from
// a vm, and the paste/drop path needs a real DataTransfer, FileReader,
// contenteditable and Selection. So this follows the same approach as
// test/ews-verb-test.mjs: the one piece of pure decision logic is copied and
// exercised, and the decisions that are load-bearing but only observable in a
// browser are pinned against the module source, with the copies asserted to
// still match. Actually pasting a screenshot is a manual check.
//
//   node test/compose-paste-test.mjs
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../public/js/compose.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
const smtp = fs.readFileSync(new URL('../server/smtpClient.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

console.log('deciding whether a paste is a FILE paste at all');
{
  // Copied from the paste handler — asserted against the module below. This is
  // the piece with the most everyday regression risk: get it wrong and pasting
  // ordinary text into an email stops working.
  const takesFiles = (dt) => {
    const files = [...(dt.files || [])];
    const hasText = [...(dt.types || [])].some((t) => t === 'text/plain' || t === 'text/html');
    return files.length > 0 && !hasText;
  };
  ok(src.includes("const hasText = [...(dt.types || [])].some((t) => t === 'text/plain' || t === 'text/html');"),
    'the copy still matches the module');

  const file = { name: 'x.png', type: 'image/png' };
  ok(takesFiles({ files: [file], types: ['Files'] }) === true,
    'a screenshot on the clipboard is taken — nothing else is there');
  ok(takesFiles({ files: [], types: ['text/plain'] }) === false, 'plain text is left to the browser');
  ok(takesFiles({ files: [], types: ['text/plain', 'text/html'] }) === false, 'and so is rich text');
  ok(takesFiles({ files: [file], types: ['Files', 'text/html', 'text/plain'] }) === false,
    'a spreadsheet cell — which puts BOTH an image and the real content on the clipboard — pastes as content, '
    + 'not as a picture of a table');
  ok(takesFiles({ files: [file], types: ['Files', 'text/html'] }) === false,
    'the same for an image copied from a web page, where the HTML is the better paste');
  ok(takesFiles({}) === false, 'an empty clipboard is not a file paste');
  ok(takesFiles({ files: [file, { name: 'y.pdf', type: 'application/pdf' }], types: ['Files'] }) === true,
    'several files at once still count');
}

console.log('\nnaming what the clipboard hands over without a name');
{
  // Copied from nameForBlob — a screenshot arrives as image/png and no filename.
  const nameForBlob = (blob, i) => {
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' })[blob.type]
      || (blob.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      + `-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    return `image-${stamp}${i ? '-' + (i + 1) : ''}.${ext}`;
  };
  ok(src.includes("'image/png': 'png', 'image/jpeg': 'jpg'"), 'the copy still matches the module');
  ok(/^image-\d{8}-\d{6}\.png$/.test(nameForBlob({ type: 'image/png' }, 0)), 'a PNG gets a dated .png name',
    nameForBlob({ type: 'image/png' }, 0));
  ok(nameForBlob({ type: 'image/jpeg' }, 0).endsWith('.jpg'), 'JPEG is .jpg, not .jpeg');
  ok(nameForBlob({ type: 'image/png' }, 1).includes('-2.'), 'a second file in one paste is distinguishable');
  ok(!nameForBlob({ type: 'image/png' }, 0).includes('-1.'), 'while the first is not needlessly suffixed');
  ok(nameForBlob({ type: '' }, 0).endsWith('.bin'), 'an unknown type still produces a usable filename');
  ok(!/[^\w.-]/.test(nameForBlob({ type: 'application/x-weird;charset=utf-8' }, 0)),
    'and a hostile content type cannot smuggle anything into the filename',
    nameForBlob({ type: 'application/x-weird;charset=utf-8' }, 0));
}

console.log('\nan inline image is sent as cid:, never as a data: URL');
{
  // The bug this prevents is invisible to the sender and total for the
  // recipient: Gmail, Outlook and most webmail strip data: URLs, so a pasted
  // screenshot would arrive as a broken image while looking perfect here.
  ok(src.includes("img.setAttribute('src', 'cid:' + img.getAttribute('data-hmelj-cid'));"),
    'getBody rewrites every marked <img> to its Content-ID');
  ok(src.includes("img.removeAttribute('data-hmelj-cid');"), 'and drops the marker, which is ours and not the recipient\'s business');
  ok(src.includes('const out = ed.cloneNode(true);'),
    'on a CLONE — rewriting the live editor would move the caret and swap the images out from under the writer, '
    + 'and getBody runs on every autosave');
  ok(src.includes('MessageFrame.linkifyBareUrlsInHtml(out.innerHTML'), 'and what is sent is the clone, not the editor');
  ok(src.includes('cid, inline: true }'), 'the attachment carries the same cid');
  ok(/cid = `\$\{crypto\.randomUUID\(\)\}@hmelj`/.test(src), 'which is unique per image');
  // The server half has always been able to do this.
  ok(smtp.includes('cid: a.cid || undefined,'), 'server/smtpClient.js passes cid through to the MIME part');
}

console.log('\nan image deleted from the body is not sent anyway');
{
  ok(src.includes("const stillUsed = new Set([...ed.querySelectorAll('img[data-hmelj-cid]')].map((i) => i.getAttribute('data-hmelj-cid')));"),
    'getBody reads which inline images the body still references');
  ok(src.includes('attachments = attachments.filter((a) => !a.inline || stillUsed.has(a.cid));'),
    'and drops the ones it does not — otherwise a deleted screenshot rides along invisibly, '
    + 'counted against the message size and shown as an attachment by the receiving client');
}

console.log('\ncoming back into the editor');
{
  ok(src.includes('function restoreInlineImages()'), 'a message reopened from the queue restores its inline images');
  ok(src.includes("querySelectorAll('img[src^=\"cid:\"]')"), 'by finding the cid: references');
  ok(src.includes('img.src = `data:${a.contentType'), 'and turning them back into data: URLs the editor can render');
  ok(src.includes('if (!a || !a.contentBase64) continue;'),
    'an image whose bytes are not ours to restore is left exactly as it is rather than blanked');
  ok(src.includes('restoreInlineImages();\n    renderAttachments();'), 'called from reopen(), after the attachments are back');
}

console.log('\ndrag and drop');
{
  ok(/win\.addEventListener\('dragover'[\s\S]{0,220}e\.preventDefault\(\)/.test(src),
    'dragover is cancelled — without that the drop event never fires at all, which is exactly why dropping a file did nothing');
  ok(src.includes("e.dataTransfer.dropEffect = 'copy'"), 'and the cursor says what will happen');
  ok(src.includes("if (!files.length) return; // dragged text or a link — let the browser do its normal thing"),
    'dragging text or a link is left alone rather than swallowed');
  ok(src.includes("acceptFiles(files, { inline: editor.contains(e.target) });"),
    'dropping INTO the body inlines the image; onto the header or the attachment strip attaches it');
  ok(src.includes('let dragDepth = 0;'),
    'enter/leave are counted, not toggled — moving over a child fires leave on the parent, so a toggle flickers');
  ok(css.includes('.compose-window.drag-over'), 'and there is a visible drop target');
  ok(!/\.drag-over[^{]*\{[^}]*position:\s*(absolute|fixed)/.test(css),
    'drawn as an outline rather than a covering overlay, which would sit between the pointer and the caret it has to aim for');
}

console.log('\nplain text mode has no such thing as an inline image');
{
  ok(src.includes('if (inline && isImage && !isPlain()) insertInlineImage(f, name);'),
    'so a pasted image is attached instead');
  ok(src.includes('else addBlob(f, name, f.type);'), 'and never silently dropped');
}

console.log('\nan inline image is not also an attachment chip');
{
  ok(src.includes('attachments.map((a, i) => (a.inline ? \'\''),
    'it is already visible in the message; a second chip for it would be noise');
  ok(src.includes('data-i="${i}"'),
    'and the button still carries the index into `attachments`, not into the rendered list — '
    + 'so removing a file never removes a different one');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
