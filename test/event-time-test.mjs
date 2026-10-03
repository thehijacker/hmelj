// Add to calendar's date guess (public/js/eventTime.js).
//
// A guess the user corrects before saving — but a wrong one is worse than
// none, so the cases that must NOT produce a date are pinned as firmly as the
// ones that must.
//
//   node test/event-time-test.mjs
import fs from 'node:fs';

new Function(fs.readFileSync(new URL('../public/js/eventTime.js', import.meta.url), 'utf8'))();
const { find, __test } = globalThis.EventTime;

let pass = 0, fail = 0;
const ok = (c, m, e = '') => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (e ? ' — ' + e : '')); } };
// Thursday 1 October 2026, 09:00 local.
const SENT = new Date(2026, 9, 1, 9, 0).toISOString();
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const is = (msg, want, label) => {
  const r = find({ date: SENT, ...msg });
  const got = r && `${new Date(r.start).toString().slice(0, 21)}${r.allDay ? ' all-day' : ''}`;
  const exp = want && `${new Date(want.start).toString().slice(0, 21)}${want.allDay ? ' all-day' : ''}`;
  ok(got === exp, label, `got ${got}, want ${exp}`);
};

console.log('dates and times');
is({ text: 'Dobimo se 5. 10. ob 10h.' }, { start: at(2026, 10, 5, 10) }, 'Slovenian numeric date with "ob 10h"');
is({ text: 'Sestanek 12.10.2026 ob 14.30' }, { start: at(2026, 10, 12, 14, 30) }, 'full numeric date with "ob 14.30"');
is({ text: 'Meeting on 2026-10-20 at 15:00' }, { start: at(2026, 10, 20, 15) }, 'ISO date and 24h time');
is({ text: 'Can we do October 7 at 2:30 pm?' }, { start: at(2026, 10, 7, 14, 30) }, 'English month name and pm');
is({ text: 'Predstavitev bo 9. oktobra.' }, { allDay: true, start: at(2026, 10, 9) }, 'Slovenian month name, no time → all day');
is({ text: 'Se vidimo jutri ob 9.' }, { start: at(2026, 10, 2, 9) }, '"jutri ob 9"');
is({ text: 'v sredo ob 11:00' }, { start: at(2026, 10, 7, 11) }, 'weekday in the accusative → the next Wednesday');
is({ text: 'Thursday 10am works' }, { start: at(2026, 10, 8, 10) }, 'the same weekday as the message means next week');
is({ subject: 'Kosilo 15. 10.', text: 'ob 12:00 v Hmelju' }, { start: at(2026, 10, 15, 12) }, 'date in the subject, time in the body');
is({ text: 'Rok je 5. 1.' }, { allDay: true, start: at(2027, 1, 5) }, 'a day already gone this year is next year');

console.log('\nwhat must not become a date');
is({ text: 'Vaše naročilo z dne 28. 9. je bilo odposlano.' }, null, 'a date before the message was sent is skipped');
is({ text: 'Cena je 10.30 EUR' }, null, 'a decimal is not a date (no dot after the month)');
is({ text: 'Hvala za vse.' }, null, 'nothing at all → null, the editor keeps its default');
is({ text: 'OK, potrjeno.\n\nOn Mon, 28 Sep 2026, Ana wrote:\n> Lahko 5. 10. ob 10h?' }, null, 'a date only in the quoted part does not count');
ok(__test.time('ob 10.30 EUR') !== null, 'an explicit "ob" time is still read');
ok(__test.time('Cena 10.30 EUR') === null, 'but a bare 10.30 is not a time');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
