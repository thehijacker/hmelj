// Hmelj — "when is this?" for Add to calendar.
//
// Finds the first date (and a time, if one is written) in a message, so the
// event editor opens on the day the mail is talking about instead of on the
// next half hour. Plain patterns, English and Slovenian, nothing clever: a
// guess the user sees and can correct before Save, never something acted on
// by itself. When nothing is found it returns null and the editor keeps its
// own default — a wrong date is worse than none.
//
// What counts:
//   dates   2026-10-05 · 5. 10. · 5.10.2026 · 5. oktober / 5. oktobra · October 5 · 5 October
//           today/danes · tomorrow/jutri · day after tomorrow/pojutrišnjem
//           a weekday name (next one after the message's own day): Thursday, četrtek, v četrtek
//   times   14:00 · ob 10 · ob 10.30 · ob 10h · at 10 · 10am / 2:30 pm · 10h
// A date before the day the message was sent is skipped: "your order of 2. 10."
// is not an invitation. Quoted replies are cut off first, so the date of an
// older message in the thread does not win.
(function (root) {
  const MONTHS = [
    ['january', 'januar', 'januarja', 'jan'], ['february', 'februar', 'februarja', 'feb'],
    ['march', 'marec', 'marca', 'mar'], ['april', 'aprila', 'apr'], ['may', 'maj', 'maja'],
    ['june', 'junij', 'junija', 'jun'], ['july', 'julij', 'julija', 'jul'],
    ['august', 'avgust', 'avgusta', 'aug', 'avg'], ['september', 'septembra', 'sep', 'sept'],
    ['october', 'oktober', 'oktobra', 'oct', 'okt'], ['november', 'novembra', 'nov'],
    ['december', 'decembra', 'dec'],
  ];
  // Sunday first, matching Date#getDay. Slovenian in the nominative and the
  // accusative ("v sredo", "v soboto") as well.
  const WEEKDAYS = [
    ['sunday', 'nedelja', 'nedeljo'], ['monday', 'ponedeljek'], ['tuesday', 'torek'],
    ['wednesday', 'sreda', 'sredo'], ['thursday', 'četrtek', 'cetrtek'], ['friday', 'petek'],
    ['saturday', 'sobota', 'soboto'],
  ];
  const monthOf = new Map();
  MONTHS.forEach((names, i) => names.forEach((n) => monthOf.set(n, i)));
  const weekdayOf = new Map();
  WEEKDAYS.forEach((names, i) => names.forEach((n) => weekdayOf.set(n, i)));
  const monthAlt = [...monthOf.keys()].sort((a, b) => b.length - a.length).join('|');
  const weekdayAlt = [...weekdayOf.keys()].sort((a, b) => b.length - a.length).join('|');
  // \b does not know č; a letter class does.
  const L = 'a-zA-ZčšžČŠŽ';
  const W0 = `(?<![${L}])`, W1 = `(?![${L}])`;

  /** Everything up to the first quoted part of a reply. */
  function ownPart(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    for (const line of lines) {
      if (/^\s*>/.test(line)) break;
      if (/^\s*(On .+ wrote:|Dne .+ (je )?.+ napisal|-{2,}\s*Original Message|-{2,}\s*Izvirno sporočilo|From:\s|Od:\s)/i.test(line)) break;
      out.push(line);
    }
    return out.join('\n').slice(0, 4000);
  }

  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const valid = (y, m, d) => {
    const x = new Date(y, m, d);
    return x.getFullYear() === y && x.getMonth() === m && x.getDate() === d ? x : null;
  };

  /** Every date in `s`, as {index, date}. A year left out is this year, or
   *  next year when that day has already gone by. */
  function dates(s, ref) {
    const today = dayStart(ref);
    const withYear = (y, m, d) => {
      if (y != null) return valid(y, m, d);
      const x = valid(today.getFullYear(), m, d);
      // Only a day well in the past rolls over: "5. 1." written in December
      // is January's, but "28. 9." written on 1 October is last week's (and
      // is then skipped as before the message, rather than moved a year on).
      if (x && x < today - 60 * 864e5) return valid(today.getFullYear() + 1, m, d);
      return x;
    };
    const found = [];
    const add = (index, date) => { if (date) found.push({ index, date }); };
    let m;
    const iso = /\b(20\d\d)-(\d\d)-(\d\d)\b/g;
    while ((m = iso.exec(s))) add(m.index, valid(+m[1], +m[2] - 1, +m[3]));
    // "5. 10." / "5.10.2026" — the dot after the month is required, which is
    // what keeps a time like "10.30" out.
    const dmy = /(?<![\d.])(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(20\d\d))?(?!\d)/g;
    while ((m = dmy.exec(s))) add(m.index, withYear(m[3] ? +m[3] : null, +m[2] - 1, +m[1]));
    const dMonth = new RegExp(`(?<!\\d)(\\d{1,2})\\.?\\s+(${monthAlt})${W1}\\.?(?:\\s+(20\\d\\d))?`, 'gi');
    while ((m = dMonth.exec(s))) add(m.index, withYear(m[3] ? +m[3] : null, monthOf.get(m[2].toLowerCase()), +m[1]));
    const monthD = new RegExp(`${W0}(${monthAlt})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(20\\d\\d))?`, 'gi');
    while ((m = monthD.exec(s))) add(m.index, withYear(m[3] ? +m[3] : null, monthOf.get(m[1].toLowerCase()), +m[2]));
    const rel = new RegExp(`${W0}(day after tomorrow|pojutrišnjem|pojutrisnjem|tomorrow|jutri|today|danes)${W1}`, 'gi');
    while ((m = rel.exec(s))) {
      const w = m[1].toLowerCase();
      const n = /after|poj/.test(w) ? 2 : /tomorrow|jutri/.test(w) ? 1 : 0;
      add(m.index, new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
    }
    const wd = new RegExp(`${W0}(${weekdayAlt})${W1}`, 'gi');
    while ((m = wd.exec(s))) {
      const target = weekdayOf.get(m[1].toLowerCase());
      let n = (target - today.getDay() + 7) % 7;
      if (n === 0) n = 7; // "Thursday" written on a Thursday means next week's
      add(m.index, new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
    }
    return found.sort((a, b) => a.index - b.index);
  }

  /** The first time of day in `s`, as {h, min}, or null. */
  function time(s) {
    const pats = [
      [/(?<![\d.:])([01]?\d|2[0-3]):([0-5]\d)(?!\d)\s*(am|pm)?/gi, (m) => [+m[1], +m[2], m[3]]],
      [new RegExp(`${W0}(?:ob|at|@)\\s*([01]?\\d|2[0-3])(?:[.:]([0-5]\\d))?\\s*(?:h|uri|ure)?(?!\\d)\\s*(am|pm)?`, 'gi'), (m) => [+m[1], +(m[2] || 0), m[3]]],
      [/(?<![\d.:])(1[0-2]|0?[1-9])\s*(am|pm)\b/gi, (m) => [+m[1], 0, m[2]]],
      [/(?<![\d.:])([01]?\d|2[0-3])h(?![a-z])/gi, (m) => [+m[1], 0, null]],
    ];
    let best = null;
    for (const [re, read] of pats) {
      const m = re.exec(s);
      if (!m || (best && best.index <= m.index)) continue;
      let [h, min, ap] = read(m);
      if (ap) { ap = ap.toLowerCase(); if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0; }
      best = { index: m.index, h, min };
    }
    return best;
  }

  /**
   * @param {{subject?:string, text?:string, date?:string|number}} msg
   * @param {Date} [now]
   * @returns {{start:number, end:number, allDay:boolean}|null}
   */
  function find(msg, now = new Date()) {
    const sent = msg?.date ? new Date(msg.date) : now;
    const ref = isNaN(sent) ? now : sent;
    const s = `${msg?.subject || ''}\n${ownPart(msg?.text)}`;
    const notBefore = dayStart(ref);
    const d = dates(s, ref).find((x) => x.date >= notBefore);
    if (!d) return null;
    const t = time(s);
    if (!t) {
      const start = d.date.getTime();
      return { start, end: new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate() + 1).getTime(), allDay: true };
    }
    const start = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), t.h, t.min).getTime();
    return { start, end: start + 3600e3, allDay: false };
  }

  const api = { find, __test: { dates, time, ownPart } };
  root.EventTime = api;
})(typeof window !== 'undefined' ? window : globalThis);
