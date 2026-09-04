// Hmelj — picking the join link out of an invitation.
//
// The cases here are the ones that actually go wrong: a Teams block whose
// FIRST link is a privacy policy rather than the meeting, a URL with a full
// stop after it because it ended a sentence, and an HTML body where the join
// URL exists only in an href attribute and never in the visible text.
import { findJoinUrl, providerOf, htmlToText, trimNotes, readableNotes, decodeEncodedWords } from '../server/onlineMeeting.js';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '\n      ' + extra : '')); }
};
const eq = (got, want, msg) => ok(got === want, msg, `got:  ${got}\n      want: ${want}`);

console.log('a real Teams invitation');
// Shortened, but in the order Microsoft actually emits: heading, join link,
// then the boilerplate whose links must NOT win.
const teams = `________________________________________________________________________________
Microsoft Teams Need help?
Join the meeting now
https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZjQ4Y2U@thread.v2/0?context=%7b%22Tid%22%3a%22aa%22%7d
Meeting ID: 123 456 789 012
Passcode: aBc1De
________________________________________________________________________________
For organizers: Meeting options https://teams.microsoft.com/meetingOptions/?organizerId=1
Learn more https://aka.ms/JoinTeamsMeeting
Legal https://www.microsoft.com/privacy
`;
eq(findJoinUrl('', teams),
   'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZjQ4Y2U@thread.v2/0?context=%7b%22Tid%22%3a%22aa%22%7d',
   'the meetup-join link wins, not the first link in the block');
eq(providerOf(findJoinUrl('', teams)), 'Teams', 'and it is named as Teams');

ok(!findJoinUrl('', 'Agenda: https://teams.microsoft.com/l/channel/19%3aabc/General'),
   'a link to a Teams CHANNEL is not a meeting and is not offered');
ok(!findJoinUrl('', 'Slides are at https://contoso.sharepoint.com/:p:/g/deck.pptx'),
   'a SharePoint document is not a join link');
ok(!findJoinUrl('', 'no links here at all'), 'and text with no link gives nothing');

console.log('punctuation the sentence contributed');
eq(findJoinUrl('', 'Call is on https://meet.google.com/abc-defg-hij.'),
   'https://meet.google.com/abc-defg-hij', 'a full stop ending the sentence is not part of the URL');
eq(findJoinUrl('', 'Dial in (https://zoom.us/j/9876543210?pwd=aB1)'),
   'https://zoom.us/j/9876543210?pwd=aB1', 'nor is a closing bracket that opened outside it');

console.log('which source wins');
eq(findJoinUrl('https://zoom.us/j/111', teams), 'https://zoom.us/j/111',
   'a provider field, passed first, beats anything in the description');
eq(findJoinUrl('', '', 'https://meet.jit.si/StandUp'), 'https://meet.jit.si/StandUp',
   'and a later source is still read when the earlier ones are empty');

console.log('an HTML body');
const html = '<html><head><style>a{color:red}</style></head><body>'
  + '<p>Hi&nbsp;all &mdash; the review is <b>moved</b>.</p>'
  + '<div><a href="https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0">Click here to join the meeting</a></div>'
  + '<ul><li>Bring the deck</li><li>15 min</li></ul></body></html>';
const text = htmlToText(html);
ok(text.includes('https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0'),
   'a URL that existed only in an href survives into the text');
ok(text.includes('Click here to join the meeting'), 'and so does the label that pointed at it');
ok(!/<[a-z]/i.test(text), 'no tag survives');
ok(!text.includes('color:red'), 'and neither does the stylesheet');
ok(text.includes('• Bring the deck'), 'list items are marked');
ok(text.includes('Hi all'), '&nbsp; became a space');
ok(text.includes('—'), 'and a numeric/named entity became its character');
eq(findJoinUrl('', text), 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_X%40thread.v2/0',
   'so the join link is findable in a body that never showed it as text');

console.log('plain text is left alone');
eq(htmlToText('Just a note.\nSecond line.'), 'Just a note.\nSecond line.',
   'text with no markup is returned unchanged');
eq(htmlToText(''), '', 'and nothing is nothing');

console.log('length');
eq(trimNotes('abc', 10), 'abc', 'short notes are untouched');
eq(trimNotes('abcdefghijklmno', 10), 'abcdefghij…', 'long ones are cut and marked');

console.log("Exchange's \"text\" body, which is nothing of the sort");
// Verbatim from a real T-2 meeting request. Asking EWS for BodyType="Text" on
// an item stored as HTML gives back a conversion that dropped the tags and
// KEPT the entities — so there is no markup for a tag test to find, and gating
// the entity pass on one left this on screen exactly as written.
const exchangeText = 'The following is a new meeting request:&#xD;\n&#xD;\n'
  + 'Subject: T-2 - Fora&#xD;\n'
  + 'Organizer: Gregor Fuis &lt;gregor.fuis@example.si&gt;&#xD;\n'
  + 'Invitees: Andrej Kralj &lt;andrej.kralj@example.com&gt;, Janez =?utf-8?Q?=C5=A0travs?= &lt;janez.stravs@example.com&gt;';
const readable = readableNotes(exchangeText, { isHtml: false });
ok(!readable.includes('&#xD;'), 'the carriage-return entity is gone');
ok(!readable.includes('&lt;') && !readable.includes('&gt;'), 'and so are the escaped angle brackets');
ok(readable.includes('Organizer: Gregor Fuis <gregor.fuis@example.si>'), 'the organizer reads as a person');
ok(readable.includes('Janez Štravs'), 'and an encoded-word attendee name reads as their actual name');
ok(readable.split('\n').length >= 4, 'the lines are lines, not one run-on paragraph', JSON.stringify(readable.slice(0, 60)));
ok(!readable.includes('\r'), 'with no lone carriage returns left, which render as nothing at all');

console.log('encoded-words on their own');
eq(decodeEncodedWords('=?utf-8?Q?=C5=A0travs?='), 'Štravs', 'quoted-printable, decoded as bytes then as text');
eq(decodeEncodedWords('=?UTF-8?B?xaB0cmF2cw==?='), 'Štravs', 'and base64');
eq(decodeEncodedWords('=?utf-8?Q?Janez_=C5=A0travs?='), 'Janez Štravs', 'underscore is a space in Q encoding');
eq(decodeEncodedWords('plain text'), 'plain text', 'anything else is left alone');
eq(decodeEncodedWords('=?x-unknown?B?QQ==?='), '=?x-unknown?B?QQ==?=',
   'and a charset this cannot decode is left visible rather than mangled');

console.log('an HTML body still gets its tags stripped');
ok(!/[<>]/.test(readableNotes('<p>Hi &amp; bye</p>', { isHtml: true }).replace(/[^<>]/g, '')),
   'tags out');
eq(readableNotes('<p>Hi &amp; bye</p>', { isHtml: true }), 'Hi & bye', 'entities decoded once, not twice');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
