// Dev helper: runs a local IMAP server (port 1143) and SMTP server (port 1025)
// with sample data, so Hmelj can be tested without a real mail server.
//   node test/mock-mail-server.js
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';

const sample = (n, extra = '') => {
  const headers = [
    `From: Sender ${n} <sender${n}@example.com>`,
    'To: you@example.com',
    `Subject: Test message ${n}`,
    `Date: ${new Date(Date.now() - n * 3600e3).toUTCString()}`,
    `Message-ID: <test-${n}@example.com>`,
    'Content-Type: text/html; charset=utf-8',
    ...(extra ? [extra] : []),
  ];
  const body = [
    `<p>Hello! This is <b>test message ${n}</b> with an external image:</p>`,
    '<img src="https://example.com/pixel.png" alt="tracker">',
    '<p>Regards,<br>Sender</p>',
  ];
  return headers.join('\r\n') + '\r\n\r\n' + body.join('\r\n');
};

const imap = hoodiecrow({
  plugins: ['IDLE', 'STARTTLS', 'ID', 'SASL-IR', 'ENABLE', 'NAMESPACE', 'SPECIAL-USE'],
  id: { name: 'hoodiecrow', version: '1' },
  storage: {
    INBOX: {
      messages: [
        { raw: sample(1), flags: [] },
        { raw: sample(2), flags: ['\\Seen'] },
        { raw: sample(3, 'X-Priority: 1'), flags: [] },
      ],
    },
    '': {
      separator: '/',
      folders: {
        Sent: { 'special-use': '\\Sent' },
        Drafts: { 'special-use': '\\Drafts' },
        Trash: { 'special-use': '\\Trash' },
        Archive: {},
      },
    },
  },
});
imap.listen(1143, () => console.log('Mock IMAP on :1143 (user: testuser / pass: testpass)'));

const smtp = new SMTPServer({
  authOptional: false,
  onAuth(auth, session, cb) { cb(null, { user: auth.username }); },
  onData(stream, session, cb) {
    let size = 0;
    stream.on('data', (c) => (size += c.length));
    stream.on('end', () => { console.log(`SMTP accepted message (${size} bytes) to`, session.envelope.rcptTo.map((r) => r.address).join(', ')); cb(); });
  },
});
smtp.listen(1025, () => console.log('Mock SMTP on :1025'));
