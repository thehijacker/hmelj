// Hmelj — protocol dispatch. Every other file (sync.js, index.js, filters.js,
// smtpClient.js) imports the mail-layer functions from HERE instead of from
// imapClient.js/ewsClient.js directly, and calls them exactly as before —
// this is the only file that knows there's more than one mail protocol.
// Each function below just picks the right implementation for whichever
// account is bound to the current request/task (session.js's ALS context,
// same as imapClient.js/ewsClient.js themselves already rely on) and forwards
// the call unchanged. Both modules export the identical set of names with
// identical signatures by design — see imapClient.js and ewsClient.js.
import { currentAccount } from './accounts.js';
import * as imapClient from './imapClient.js';
import * as ewsClient from './ewsClient.js';
import * as graphClient from './graphClient.js';

// Anything that isn't a known protocol is an IMAP account — every account
// stored before EWS existed has no `type` field at all.
const CLIENTS = { ews: ewsClient, graph: graphClient };

function client() {
  return CLIENTS[currentAccount().type] || imapClient;
}

export const listFolders = (...a) => client().listFolders(...a);
export const folderStatus = (...a) => client().folderStatus(...a);
export const createFolder = (...a) => client().createFolder(...a);
export const deleteFolder = (...a) => client().deleteFolder(...a);
export const renameFolder = (...a) => client().renameFolder(...a);
export const emptyFolder = (...a) => client().emptyFolder(...a);
export const markAllRead = (...a) => client().markAllRead(...a);
export const listMessages = (...a) => client().listMessages(...a);
export const listNewMessages = (...a) => client().listNewMessages(...a);
export const refreshFlags = (...a) => client().refreshFlags(...a);
export const scanMessages = (...a) => client().scanMessages(...a);
export const getMessageSource = (...a) => client().getMessageSource(...a);
export const getMessageHeaders = (...a) => client().getMessageHeaders(...a);
export const getMessage = (...a) => client().getMessage(...a);
export const getAttachment = (...a) => client().getAttachment(...a);
export const setFlags = (...a) => client().setFlags(...a);
export const moveMessages = (...a) => client().moveMessages(...a);
// Answering a meeting invitation (server/icalendar.js reads it; this sends the
// answer). Exchange and Graph each own the whole operation server-side —
// calendar write and organizer notification together. An IMAP account has no
// such server to ask, so its client has no counterpart and the route below
// reports that rather than pretending: see the note in server/index.js.
export const respondToMeeting = (...a) => {
  const c = client();
  if (!c.respondToMeeting) throw Object.assign(new Error('This account type cannot answer meeting invitations yet'), { status: 400 });
  return c.respondToMeeting(...a);
};
export const copyMessages = (...a) => client().copyMessages(...a);
export const deleteMessages = (...a) => client().deleteMessages(...a);
export const hardDelete = (...a) => client().hardDelete(...a);
export const appendMessage = (...a) => client().appendMessage(...a);
export const imapStatus = (...a) => client().imapStatus(...a);
