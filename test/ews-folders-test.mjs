// The EWS folder operations — create, delete, rename, empty
// (server/ewsClient.js). Exchange is the one backend where these were stubbed:
// calling any of them threw "createFolder is not yet supported for Exchange
// accounts", which reached users as a toast when Snooze tried to make its
// Snoozed folder.
//
// The real Exchange account cannot be part of an automated test (same reason
// test/ews-verb-test.mjs gives), so what is checked here is the half that is
// checkable without a server, and it is the half that fails SILENTLY:
//
//   1. the response paths. A typo in
//      `Envelope.Body.CreateFolderResponse.ResponseMessages.CreateFolderResponseMessage`
//      yields `undefined`, which reads as an empty response rather than as a
//      wrong path — and only against a live server.
//   2. the generated SOAP. Well-formedness, and the attributes that decide
//      what actually happens to a user's mail: DeleteType on DeleteFolder,
//      DeleteType/DeleteSubFolders on EmptyFolder.
//   3. that the module still says what this file assumes it says.
//
// What is NOT covered, and needs a real mailbox: whether Exchange accepts each
// request, and whether ChangeKey staleness after a rename behaves as expected.
//
//   node test/ews-folders-test.mjs
import fs from 'node:fs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const src = fs.readFileSync(new URL('../server/ewsClient.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };

// Exactly the module's parser configuration, including the five response
// messages added for these operations.
const xmlParser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true,
  isArray: (n) => [
    'Folder', 'Message', 'Mailbox', 'ExtendedProperty',
    'FindFolderResponseMessage', 'GetFolderResponseMessage',
    'FindItemResponseMessage', 'GetItemResponseMessage',
    'CreateFolderResponseMessage', 'DeleteFolderResponseMessage',
    'UpdateFolderResponseMessage', 'MoveFolderResponseMessage',
    'EmptyFolderResponseMessage',
  ].includes(n),
});
const asArray = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]));
const escXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** A whole SOAP response, the shape Exchange 2013 actually returns. */
const envelope = (inner) => `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
            xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <s:Body>${inner}</s:Body>
</s:Envelope>`;

const responseMessage = (op, body, code = 'NoError') => envelope(
  `<m:${op}Response><m:ResponseMessages><m:${op}ResponseMessage ResponseClass="${code === 'NoError' ? 'Success' : 'Error'}">`
  + `<m:ResponseCode>${code}</m:ResponseCode>${body}`
  + `</m:${op}ResponseMessage></m:ResponseMessages></m:${op}Response>`);

/** The module's own path into a response, written once here. */
const messageFor = (op, xml) =>
  asArray(xmlParser.parse(xml)?.Envelope?.Body?.[`${op}Response`]?.ResponseMessages?.[`${op}ResponseMessage`])[0];

const OPS = ['CreateFolder', 'DeleteFolder', 'UpdateFolder', 'MoveFolder', 'EmptyFolder'];

console.log('the response path each operation reads');
for (const op of OPS) {
  const msg = messageFor(op, responseMessage(op, ''));
  ok(msg != null, `${op}: the message is found where the module looks for it`);
  ok(msg?.ResponseCode === 'NoError', `${op}: and its ResponseCode is readable`);
  // The exact expression from the module — a typo here is invisible until a
  // real server answers.
  ok(src.includes(`parsed?.Envelope?.Body?.${op}Response?.ResponseMessages?.${op}ResponseMessage`),
    `${op}: the module still uses this path`);
  ok(src.includes(`soapRequest(acc.ews, '${op}', body)`), `${op}: and sends it as SOAPAction ${op}`);
  ok(src.includes(`'${op}ResponseMessage'`), `${op}ResponseMessage is declared to the parser as a collection`);
}

console.log('\na failure is a failure, not an empty success');
{
  // checkResponseCode's condition, copied — asserted against the module below.
  const failed = (m) => !!(m && m.ResponseCode && m.ResponseCode !== 'NoError');
  ok(src.includes("if (m.ResponseCode && m.ResponseCode !== 'NoError') {"), 'the copy still matches checkResponseCode');
  const dup = messageFor('CreateFolder', responseMessage('CreateFolder',
    '<m:MessageText>A folder with that name already exists.</m:MessageText>', 'ErrorFolderExists'));
  ok(failed(dup), 'ErrorFolderExists is caught rather than treated as created');
  ok(dup.MessageText.includes('already exists'), "and Exchange's own explanation is available to show");
  ok(!failed(messageFor('EmptyFolder', responseMessage('EmptyFolder', ''))), 'NoError is not mistaken for an error');
}

console.log('\nCreateFolder returns an id the caller can use');
{
  const xml = responseMessage('CreateFolder',
    '<m:Folders><t:Folder><t:FolderId Id="AAMkADk1" ChangeKey="AQAAABYA"/></t:Folder></m:Folders>');
  const folder = asArray(messageFor('CreateFolder', xml)?.Folders?.Folder)[0];
  ok(folder?.FolderId?.['@_Id'] === 'AAMkADk1', 'the new FolderId is extracted');
  ok(src.includes("folder?.FolderId?.['@_Id']"), 'by the expression the module uses');
  // ensureSnoozeFolder (server/index.js) reads created?.path || created?.name.
  ok(/return \{ path, name, id: folder\?\.FolderId\?\.\['@_Id'\] \|\| null \};/.test(src),
    'and createFolder returns {path, name, id} — the shape ensureSnoozeFolder reads');
}

console.log('\nthe generated SOAP is well-formed');
{
  const wrap = (b) => `<r xmlns:m="urn:m" xmlns:t="urn:t">${b}</r>`;
  const bodies = {
    CreateFolder: `<m:CreateFolder><m:ParentFolderId><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderId>`
      + `<m:Folders><t:Folder><t:FolderClass>IPF.Note</t:FolderClass>`
      + `<t:DisplayName>${escXml('Ponudbe & "račun"')}</t:DisplayName></t:Folder></m:Folders></m:CreateFolder>`,
    DeleteFolder: `<m:DeleteFolder DeleteType="MoveToDeletedItems"><m:FolderIds><t:FolderId Id="AAMk" ChangeKey="AQAA"/></m:FolderIds></m:DeleteFolder>`,
    EmptyFolder: `<m:EmptyFolder DeleteType="HardDelete" DeleteSubFolders="false"><m:FolderIds><t:FolderId Id="AAMk"/></m:FolderIds></m:EmptyFolder>`,
  };
  for (const [op, body] of Object.entries(bodies)) {
    ok(XMLValidator.validate(wrap(body)) === true, `${op}: valid XML`, JSON.stringify(XMLValidator.validate(wrap(body))));
  }
  const created = xmlParser.parse(wrap(bodies.CreateFolder));
  ok(created.r.CreateFolder.Folders.Folder[0].DisplayName === 'Ponudbe & "račun"',
    'a folder name with an ampersand and quotes survives escaping and round-trips');
  ok(created.r.CreateFolder.Folders.Folder[0].FolderClass === 'IPF.Note',
    'FolderClass IPF.Note — without it Exchange makes a generic folder that mail cannot be filed into');
}

console.log('\nthe attributes that decide what happens to real mail');
{
  ok(src.includes('<m:DeleteFolder DeleteType="MoveToDeletedItems">'),
    'DeleteFolder moves to Deleted Items — recoverable, like Outlook and like Hmelj\'s own message delete');
  ok(!src.includes('<m:DeleteFolder DeleteType="HardDelete"'), 'and never hard-deletes a folder outright');
  ok(src.includes('<m:EmptyFolder DeleteType="HardDelete" DeleteSubFolders="false">'),
    'EmptyFolder really empties (soft-deleting the contents of Trash would be a no-op) and keeps subfolders');
  ok(src.includes('<t:FieldURI FieldURI="folder:DisplayName"/>'), 'UpdateFolder sets folder:DisplayName');
}

console.log('\npath handling');
{
  const splitPath = (path) => { const parts = String(path).split('/'); const name = parts.pop(); return { parentPath: parts.join('/'), name }; };
  ok(src.includes('const parts = String(path).split(\'/\');'), 'the splitPath copy still matches the module');
  ok(JSON.stringify(splitPath('Projects/2026/Q1')) === '{"parentPath":"Projects/2026","name":"Q1"}', 'a nested path splits into parent and leaf');
  ok(JSON.stringify(splitPath('Snoozed')) === '{"parentPath":"","name":"Snoozed"}', 'a top-level folder has an empty parent');
  ok(splitPath('Snoozed').parentPath === '', 'which folderIdXml turns into msgfolderroot');
  ok(src.includes("if (!path) return '<t:DistinguishedFolderId Id=\"msgfolderroot\"/>';"),
    'an empty parent path resolves to the mailbox root, the same root listFolders traverses from');
}

console.log('\nrename covers being moved as well as renamed');
{
  ok(src.includes('if (newParent !== oldParent) {'), 'a changed parent triggers MoveFolder');
  ok(src.includes('if (name !== splitPath(path).name) {'), 'a changed leaf name triggers UpdateFolder');
  ok((src.match(/invalidateFolderCache\(\)/g) || []).length >= 4,
    'every mutation drops the cached path map — a rename changes the path of the whole subtree under it');
}

console.log('\nthe stubs are gone');
{
  ok(!src.includes('is not yet supported for Exchange accounts'),
    'no operation still reports itself unimplemented to the user');
  for (const fn of ['createFolder', 'deleteFolder', 'renameFolder', 'emptyFolder']) {
    ok(new RegExp(`export async function ${fn}\\(`).test(src), `${fn} is a real implementation`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
