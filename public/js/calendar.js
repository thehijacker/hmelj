// Hmelj — the calendar views.
//
// Four of them, and the reason there are four rather than three is the phone.
// A seven-column time grid at 380px gives each day about 45 pixels, which is
// not enough for a title, so a week view built only for a desktop is a week
// view nobody uses on a phone. Agenda is the honest answer there, and is what
// opens by default on a narrow screen.
//
// ── Where the times come from ────────────────────────────────────────────────
// Nowhere in this file. The server has already resolved every occurrence to an
// instant and told us which DAY it belongs to (see server/calendarEvents.js):
// an all-day event is grouped in UTC and a timed one in the viewer's zone, and
// a browser that applied one rule to both would put every late-evening event on
// the wrong day for half the world. So `ev.day` is used as given and never
// recomputed here, and `ev.allDay` decides whether a time is shown at all.
//
// ── Why this is not a modal ──────────────────────────────────────────────────
// It replaces the message list and reading pane rather than covering them. A
// month grid wants the whole content area, and none of the list's chrome — sort
// columns, pager, select toolbar — means anything over it. The sidebar stays,
// so switching accounts and toggling calendars work as they do everywhere else.
const Calendar = (() => {
  const VIEWS = ['month', 'week', 'day', 'agenda'];
  const VIEW_KEY = 'hmelj-calendar-view';

  /** Below this, a seven-column time grid stops being usable — see the header. */
  const NARROW = 600;
  const isNarrow = () => window.innerWidth < NARROW;

  let view = 'month';
  let anchor = new Date();        // any instant inside the period being shown
  let events = [];                 // the last fetched window
  let calendars = [];              // every calendar, for the sidebar and colours
  let timezone = 'UTC';
  let windowInfo = null;           // the rolling window Graph/EWS are known over
  let loadSeq = 0;
  let opened = false;

  const el = (id) => document.getElementById(id);
  const body = () => el('cal-body');

  /* ---------- periods ---------- */

  const startOfDay = (d) => { const t = new Date(d); t.setHours(0, 0, 0, 0); return t; };
  const addDays = (d, n) => { const t = new Date(d); t.setDate(t.getDate() + n); return t; };
  const addMonths = (d, n) => { const t = new Date(d); t.setDate(1); t.setMonth(t.getMonth() + n); return t; };

  /** How many day columns the week view draws — see the note in range(). */
  const weekDays = () => (isNarrow() ? 3 : 7);

  /** The first day of the week containing `d`. Monday-first: Hmelj has no
   *  week-start setting, and every locale it ships in starts on Monday. */
  function startOfWeek(d) {
    const t = startOfDay(d);
    return addDays(t, -((t.getDay() + 6) % 7));
  }

  /** The half-open range a view covers, plus the range to FETCH.
   *
   *  The fetch is deliberately wider than the view: paging to the next month
   *  should not wait on a request, and a month grid already shows the tail of
   *  the previous month and the head of the next. */
  function range() {
    switch (view) {
      case 'day': {
        const from = startOfDay(anchor);
        return { from, to: addDays(from, 1), fetchFrom: addDays(from, -7), fetchTo: addDays(from, 8) };
      }
      case 'week': {
        const n = weekDays();
        // On a phone the "week" is three days starting from the anchor, not
        // seven starting from Monday. Seven columns at 380px is 45px each,
        // which fits neither a title nor a legible time — and the obvious CSS
        // fix (scroll the grid sideways) desynchronises the day header from the
        // columns beneath it the moment either one is scrolled on its own.
        // Rendering fewer columns has neither problem.
        const from = n === 7 ? startOfWeek(anchor) : startOfDay(anchor);
        return { from, to: addDays(from, n), fetchFrom: addDays(from, -7), fetchTo: addDays(from, n + 7) };
      }
      case 'agenda': {
        const from = startOfDay(anchor);
        return { from, to: addDays(from, 30), fetchFrom: from, fetchTo: addDays(from, 60) };
      }
      default: {
        const first = addMonths(anchor, 0);
        const gridFrom = startOfWeek(first);
        // Six rows always. A month grid that is five rows tall in one month and
        // six in the next jumps every time you page through it.
        const gridTo = addDays(gridFrom, 42);
        return { from: gridFrom, to: gridTo, fetchFrom: addDays(gridFrom, -7), fetchTo: addDays(gridTo, 7) };
      }
    }
  }

  function periodLabel() {
    const m = I18n.months ? I18n.months() : null;
    const monthName = (d) => (m ? m[d.getMonth()] : d.toLocaleString(undefined, { month: 'long' }));
    switch (view) {
      case 'day': return `${anchor.getDate()}. ${monthName(anchor)} ${anchor.getFullYear()}`;
      case 'week': {
        const r = range();
        const a = r.from; const b = addDays(r.to, -1);
        return a.getMonth() === b.getMonth()
          ? `${a.getDate()}.–${b.getDate()}. ${monthName(a)} ${a.getFullYear()}`
          : `${a.getDate()}. ${monthName(a)} – ${b.getDate()}. ${monthName(b)} ${b.getFullYear()}`;
      }
      case 'agenda': return `${I18n.t('Next 30 days')}`;
      default: return `${monthName(anchor)} ${anchor.getFullYear()}`;
    }
  }

  /* ---------- data ---------- */

  const dayKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  /** The same, in UTC — which is the clock an all-day event is stored in, and
   *  so the one it has to be grouped by. The server uses exactly this rule (see
   *  calendarEvents.js#occurrence), and the two must agree or an event lands in
   *  a grid cell its own `day` says it is not in. */
  const dayKeyUtc = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

  async function load({ quiet = false } = {}) {
    const seq = ++loadSeq;
    const r = range();
    if (!quiet && !events.length) body().innerHTML = `<div class="cal-loading">${esc(I18n.t('Loading…'))}</div>`;
    try {
      const [evRes, calRes] = await Promise.all([
        API.calendarEvents(r.fetchFrom.getTime(), r.fetchTo.getTime()),
        API.calendars(),
      ]);
      if (seq !== loadSeq) return; // a newer navigation owns the view
      events = evRes.events || [];
      timezone = evRes.timezone || timezone;
      calendars = calRes.calendars || [];
      windowInfo = calRes.window || null;
      // So the message menu's "Add to calendar" appears as soon as there IS one
      // to add to, rather than at the next full reload.
      window.__hmeljSetWritableCalendars?.(writableCalendars().length);
    } catch (e) {
      if (seq !== loadSeq) return;
      body().innerHTML = `<div class="cal-loading" style="color:var(--danger)">${esc(e.message)}</div>`;
      return;
    }
    render();
    renderSidebar();
  }

  /** Events grouped by the day they belong to. `ev.day` comes from the server
   *  already resolved — see this file's header for why it is not recomputed. */
  function byDay(from, to) {
    const map = new Map();
    for (let d = new Date(from); d < to; d = addDays(d, 1)) map.set(dayKeyOf(d), []);
    for (const ev of events) {
      // A multi-day event belongs to every day it covers, not only the one it
      // starts on — otherwise a week-long holiday shows on Monday and vanishes.
      //
      // Walked in the event's OWN clock. An all-day event is stored as UTC
      // midnight to UTC midnight (see server/calendarEvents.js), so stepping it
      // through local days is off by the viewer's offset: in Ljubljana a
      // one-day event ending at 00:00Z ends at 02:00 local the NEXT day, and
      // the walk put it on both. A timed event is the opposite — it belongs to
      // the days the viewer's own clock says.
      const utc = !!ev.allDay;
      const keyOf = utc ? dayKeyUtc : dayKeyOf;
      const nextDay = utc
        ? (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1))
        : (d) => addDays(startOfDay(d), 1);
      let d = new Date(ev.start);
      // Half-open: an event ending at midnight is not on the next day.
      const end = new Date(Math.max(ev.end - 1, ev.start));
      for (let i = 0; i < 400 && d <= end; i++, d = nextDay(d)) {
        const key = i === 0 ? ev.day : keyOf(d);
        if (map.has(key)) map.get(key).push({ ...ev, continued: i > 0 });
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || a.start - b.start);
    }
    return map;
  }

  /**
   * What colour to draw an occurrence in: its OWN colour if it has one
   * (iCalendar's COLOR — see server/icalendar.js), otherwise its calendar's.
   *
   * The event wins on purpose. A calendar's colour says where something lives;
   * an event's says what it IS, which is the finer distinction and the one
   * somebody went to the trouble of setting — "paper", "plastic" and "the rest"
   * all sitting in one Bins calendar is exactly the case this exists for.
   */
  const colorOf = (ev) => ev.color || calendars.find((c) => c.id === ev.calendarId)?.color || 'var(--accent)';

  /* The colours the event form offers. Deliberately a small fixed set rather
   * than a free colour input: these are picked at a glance against a list of
   * other events, and a palette that is legible in both themes is worth more
   * than being able to choose any of sixteen million. "" is the first swatch —
   * follow the calendar, which is what most events should do. */
  const EVENT_COLORS = ['', '#0b57d0', '#0f9d58', '#e37400', '#a142f4', '#d93025', '#00897b', '#f6bf26',
    '#795548', '#9e9e9e', '#5f6368'];

  function timeLabel(ms) {
    const d = new Date(ms);
    const h = d.getHours(), mi = d.getMinutes();
    if (state.settings?.timeFormat === '12') {
      const ampm = h < 12 ? 'am' : 'pm';
      return `${((h + 11) % 12) + 1}${mi ? ':' + String(mi).padStart(2, '0') : ''}${ampm}`;
    }
    return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
  }

  /* ---------- views ---------- */

  function render() {
    el('cal-period').textContent = periodLabel();
    for (const b of el('cal-views').querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.view === view);
    }
    const r = range();
    if (view === 'month') renderMonth(r);
    else if (view === 'week') renderWeek(r);
    else if (view === 'day') renderWeek(r);
    else renderAgenda(r);
    if (!calendars.some((c) => c.enabled)) renderEmptyState();
  }

  function renderEmptyState() {
    body().innerHTML = `<div class="cal-empty">
      <div class="cal-empty-glyph">📅</div>
      <h2>${esc(I18n.t('No calendars yet'))}</h2>
      <p>${esc(I18n.t('Add a CalDAV server, or turn calendar sync on for a mail account you already have.'))}</p>
      <p><button class="send-btn" id="cal-add">${esc(I18n.t('Set up a calendar'))}</button></p>
    </div>`;
    el('cal-add')?.addEventListener('click', () => Settings.open('calendars'));
  }

  function renderMonth(r) {
    const groups = byDay(r.from, r.to);
    const today = dayKeyOf(new Date());
    const month = anchor.getMonth();
    const dow = I18n.t('Mon Tue Wed Thu Fri Sat Sun').split(' ');
    // On a phone the grid shows dots rather than titles: six rows of seven
    // cells leaves about 45px of width, and a truncated title in that space is
    // noise. Tapping a day opens it.
    const compact = isNarrow();
    let html = `<div class="cal-month${compact ? ' compact' : ''}">
      <div class="cal-dow">${dow.map((d) => `<span>${esc(d)}</span>`).join('')}</div>
      <div class="cal-grid">`;
    for (let d = new Date(r.from); d < r.to; d = addDays(d, 1)) {
      const key = dayKeyOf(d);
      const list = groups.get(key) || [];
      const classes = ['cal-cell'];
      if (d.getMonth() !== month) classes.push('other-month');
      if (key === today) classes.push('today');
      html += `<div class="${classes.join(' ')}" data-day="${key}">
        <div class="cal-cell-num">${d.getDate()}</div>`;
      if (compact) {
        html += `<div class="cal-dots">${list.slice(0, 4).map((ev) =>
          `<span class="cal-dot" style="--c:${escAttr(colorOf(ev))}"></span>`).join('')}</div>`;
      } else {
        html += list.slice(0, 4).map((ev) => chip(ev)).join('');
        if (list.length > 4) html += `<button type="button" class="cal-more" data-day="${key}">+${list.length - 4} ${esc(I18n.t('more'))}</button>`;
      }
      html += '</div>';
    }
    body().innerHTML = html + '</div></div>';
    bindCells();
  }

  function chip(ev) {
    const time = ev.allDay || ev.continued ? '' : `<span class="cal-chip-time">${esc(timeLabel(ev.start))}</span> `;
    return `<button type="button" class="cal-chip${ev.allDay ? ' all-day' : ''}" data-event="${escAttr(ev.id)}"
      style="--c:${escAttr(colorOf(ev))}" title="${escAttr(ev.summary || I18n.t('(no title)'))}">
      ${time}<span class="cal-chip-title">${esc(ev.summary || I18n.t('(no title)'))}</span></button>`;
  }

  /** Week and Day share one time grid — Day is a week of one column, which is
   *  also what makes the week view usable on a phone: it shows three days and
   *  scrolls, rather than seven columns of nothing. */
  function renderWeek(r) {
    const days = [];
    for (let d = new Date(r.from); d < r.to; d = addDays(d, 1)) days.push(new Date(d));
    const groups = byDay(r.from, r.to);
    const today = dayKeyOf(new Date());
    const m = I18n.months ? I18n.months() : null;
    const dowNames = I18n.t('Mon Tue Wed Thu Fri Sat Sun').split(' ');

    const head = days.map((d) => {
      const key = dayKeyOf(d);
      return `<button type="button" class="cal-daycol-head${key === today ? ' today' : ''}" data-day="${key}">
        <span class="cal-daycol-dow">${esc(dowNames[(d.getDay() + 6) % 7])}</span>
        <span class="cal-daycol-num">${d.getDate()}</span>
      </button>`;
    }).join('');

    // All-day events get their own band above the grid: they have no position
    // on a 24-hour axis, and stretching them across it makes every timed event
    // beneath them unreadable.
    const allDayBand = days.map((d) => {
      const list = (groups.get(dayKeyOf(d)) || []).filter((ev) => ev.allDay);
      return `<div class="cal-allday-cell">${list.map((ev) => chip(ev)).join('')}</div>`;
    }).join('');
    const hasAllDay = days.some((d) => (groups.get(dayKeyOf(d)) || []).some((ev) => ev.allDay));

    const hours = Array.from({ length: 24 }, (_, h) =>
      `<div class="cal-hour"><span>${state.settings?.timeFormat === '12'
        ? `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}` : String(h).padStart(2, '0')}</span></div>`).join('');

    const cols = days.map((d) => {
      const dayStart = startOfDay(d).getTime();
      const list = (groups.get(dayKeyOf(d)) || []).filter((ev) => !ev.allDay);
      const blocks = layout(list).map(({ ev, col, cols: n }) => {
        const top = Math.max(0, (ev.start - dayStart) / 3600000);
        const bottom = Math.min(24, (ev.end - dayStart) / 3600000);
        // A zero-length event still has to be clickable, and one that runs past
        // midnight is clipped to this day rather than overflowing the column.
        const height = Math.max(0.45, bottom - top);
        return `<button type="button" class="cal-block" data-event="${escAttr(ev.id)}"
          style="--c:${escAttr(colorOf(ev))};top:${(top / 24) * 100}%;height:${(height / 24) * 100}%;
                 left:${(col / n) * 100}%;width:${(1 / n) * 100}%">
          <span class="cal-block-time">${esc(timeLabel(ev.start))}</span>
          <span class="cal-block-title">${esc(ev.summary || I18n.t('(no title)'))}</span>
        </button>`;
      }).join('');
      return `<div class="cal-daycol" data-day="${dayKeyOf(d)}">${blocks}</div>`;
    }).join('');

    body().innerHTML = `<div class="cal-time${view === 'day' ? ' one-day' : ''}" style="--days:${days.length}">
      <div class="cal-time-head"><div class="cal-gutter-head"></div><div class="cal-heads">${head}</div></div>
      ${hasAllDay ? `<div class="cal-allday"><div class="cal-gutter-head">${esc(I18n.t('All day'))}</div>
        <div class="cal-allday-cells">${allDayBand}</div></div>` : ''}
      <div class="cal-time-scroll">
        <div class="cal-gutter">${hours}</div>
        <div class="cal-cols">${cols}${nowLine(days)}</div>
      </div>
    </div>`;
    bindCells();
    // Open on the working day, not on midnight — three hours of empty night at
    // the top is what every calendar scrolls past on load.
    const scroll = body().querySelector('.cal-time-scroll');
    if (scroll) scroll.scrollTop = (7 / 24) * scroll.scrollHeight;
  }

  /** A red line at the current time, when today is on screen. */
  function nowLine(days) {
    const now = new Date();
    const key = dayKeyOf(now);
    if (!days.some((d) => dayKeyOf(d) === key)) return '';
    const frac = (now.getHours() * 60 + now.getMinutes()) / 1440;
    return `<div class="cal-now" style="top:${frac * 100}%"></div>`;
  }

  /**
   * Side-by-side placement for events that overlap in time.
   *
   * Greedy by design: events are taken in start order and each one goes in the
   * leftmost column whose last event has already ended. Two meetings at the
   * same time end up half-width each rather than stacked on top of one another,
   * which is the only thing that makes a busy day readable at all.
   */
  function layout(list) {
    const cols = [];   // per column, the end of its last event
    const placed = [];
    for (const ev of [...list].sort((a, b) => a.start - b.start || b.end - a.end)) {
      let col = cols.findIndex((end) => end <= ev.start);
      if (col === -1) { col = cols.length; cols.push(0); }
      cols[col] = Math.max(ev.end, ev.start + 900000); // a zero-length event still occupies its slot
      placed.push({ ev, col });
    }
    // Everything shares the widest column count in its own overlap group, so
    // two events that overlap are the same width as each other.
    const n = Math.max(1, cols.length);
    return placed.map((p) => ({ ...p, cols: n }));
  }

  function renderAgenda(r) {
    const groups = byDay(r.from, r.to);
    const today = dayKeyOf(new Date());
    const m = I18n.months ? I18n.months() : null;
    const rows = [];
    for (const [key, list] of groups) {
      if (!list.length) continue;
      const d = new Date(key + 'T12:00:00');
      const label = `${d.getDate()}. ${m ? m[d.getMonth()] : d.toLocaleString(undefined, { month: 'short' })}`;
      rows.push(`<div class="cal-agenda-day${key === today ? ' today' : ''}">
        <div class="cal-agenda-date"><span class="cal-agenda-dow">${esc(I18n.t('Mon Tue Wed Thu Fri Sat Sun').split(' ')[(d.getDay() + 6) % 7])}</span>
          <span class="cal-agenda-num">${esc(label)}</span></div>
        <div class="cal-agenda-events">${list.map((ev) => `
          <button type="button" class="cal-agenda-row" data-event="${escAttr(ev.id)}" style="--c:${escAttr(colorOf(ev))}">
            <span class="cal-agenda-time">${ev.allDay ? esc(I18n.t('All day')) : esc(timeLabel(ev.start))}</span>
            <span class="cal-agenda-title">${esc(ev.summary || I18n.t('(no title)'))}</span>
            ${ev.location ? `<span class="cal-agenda-loc">${esc(ev.location)}</span>` : ''}
          </button>`).join('')}</div>
      </div>`);
    }
    body().innerHTML = rows.length
      ? `<div class="cal-agenda">${rows.join('')}</div>`
      : `<div class="cal-loading">${esc(I18n.t('Nothing in the next 30 days.'))}</div>`;
    bindCells();
  }

  function bindCells() {
    for (const b of body().querySelectorAll('[data-event]')) {
      b.addEventListener('click', (e) => { e.stopPropagation(); openEvent(b.dataset.event); });
    }
    for (const b of body().querySelectorAll('.cal-more, .cal-daycol-head')) {
      b.addEventListener('click', () => { anchor = new Date(b.dataset.day + 'T12:00:00'); setView('day'); });
    }
    // On a phone the month grid shows dots, so the cell itself is the way in.
    if (isNarrow() && view === 'month') {
      for (const c of body().querySelectorAll('.cal-cell')) {
        c.addEventListener('click', () => { anchor = new Date(c.dataset.day + 'T12:00:00'); setView('day'); });
      }
    }
  }

  /* ---------- one event ---------- */

  /**
   * Linkifies plain text without letting any of it become markup.
   *
   * Escape FIRST, then match — matching first and escaping the pieces is how a
   * summary containing `<img onerror=…>` ends up in the DOM. `&amp;` is put
   * back inside the href because the escaping above rewrote the query string's
   * separators, and a Teams URL is mostly query string.
   */
  function linkify(text) {
    return esc(String(text || ''))
      // Web links first. esc() turned every & into &amp; and every < into
      // &lt;, so the match carries entity text: decode the ampersands to
      // rebuild the real URL — a Teams link is mostly query string — and strip
      // what the sentence around it contributed, a full stop, a closing
      // bracket, or the > of a <https://…> pair the escaping pulled in.
      .replace(/(https?:\/\/[^\s<>"']+)/g, (m) => {
        const raw = m.replace(/&amp;/g, '&').replace(/&gt;$/, '');
        const url = raw.replace(/[.,;:!?)\]>]+$/, '');
        return `<a href="${escAttr(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${esc(raw.slice(url.length))}`;
      })
      // Then addresses. A meeting request's body is mostly an attendee list,
      // and an address you cannot click or copy out of it is the reason
      // somebody goes and opens Outlook instead.
      .replace(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
        (m, addr) => `<a href="mailto:${escAttr(addr)}">${esc(addr)}</a>`)
      .replace(/\n/g, '<br>');
  }

  async function openEvent(id) {
    const ev = events.find((e) => e.id === id);
    if (!ev) return;
    const cal = calendars.find((c) => c.id === ev.calendarId);

    // Microsoft and Exchange list events without their bodies, so the notes and
    // the join link are asked for here, once, for the event being opened. The
    // dialog is not held up by a failure — it opens with what the last sync
    // knew, which is what it would have shown anyway.
    if (ev.partialDescription && !ev.__full) {
      try {
        const full = await API.calendarEvent(ev.calendarId, ev.uid, ev.start);
        Object.assign(ev, full, { __full: true });
      } catch { ev.__full = true; }
    }
    const when = ev.allDay
      ? `${I18n.t('All day')} · ${ev.day}`
      : `${fmtDate(ev.start, { long: true })} – ${timeLabel(ev.end)}`;
    const row = (label, value) => (value
      ? `<div class="cal-detail-row"><span>${esc(label)}</span><div>${value}</div></div>` : '');
    const who = (p) => esc(p.name ? `${p.name} <${p.address}>` : p.address);

    const bodyHtml = `
      <div class="cal-detail">
        ${row(I18n.t('When'), esc(when))}
        ${ev.recurring ? row(I18n.t('Repeats'), esc(I18n.t('Part of a series'))) : ''}
        ${row(I18n.t('Calendar'), `<span class="cal-swatch" style="--c:${escAttr(cal?.color || '')}"></span>${esc(cal?.displayName || '')}`)}
        ${row(I18n.t('Where'), esc(ev.location))}
        ${row(I18n.t('Organizer'), ev.organizer ? who(ev.organizer) : '')}
        ${ev.attendees?.length ? row(I18n.t('Attendees'), ev.attendees.map(who).join('<br>')) : ''}
        ${ev.joinUrl ? row(I18n.t('Join'),
          `<a class="cal-join" href="${escAttr(ev.joinUrl)}" target="_blank" rel="noopener noreferrer">${esc(I18n.t('Join the call'))}</a>`) : ''}
        ${ev.url && ev.url !== ev.joinUrl && /^https?:/i.test(ev.url)
          ? row(I18n.t('Link'), `<a href="${escAttr(ev.url)}" target="_blank" rel="noopener noreferrer">${esc(ev.url)}</a>`) : ''}
        ${ev.description ? row(I18n.t('Notes'), `<div class="cal-notes">${linkify(ev.description)}</div>`) : ''}
        ${// A zone is named only when it is NOT the viewer's own. Saying "in
          // Europe/Ljubljana" to somebody in Ljubljana is noise; saying it to
          // somebody in London is the whole point.
          ev.zone && ev.zone !== timezone && ev.zone !== 'UTC'
            ? row(I18n.t('Time zone'), esc(ev.zone)) : ''}
        ${ev.floating ? `<p class="set-hint">${esc(I18n.t('This event was written without a time zone, so it is shown in yours.'))}</p>` : ''}
      </div>`;

    // Edit and Delete are offered only where they would actually work. A
    // read-only calendar — a colleague's shared one, or a provider Hmelj cannot
    // write to — gets the details and nothing that would be refused.
    const editable = cal && !cal.readOnly && cal.writable !== false;
    Dialog.choose('', {
      title: ev.summary || I18n.t('(no title)'),
      bodyHtml,
      // A meeting request's notes have no natural length — dial-in numbers, a
      // conference ID, a legal footer — and reading that through a 440px
      // column is most of a screen of scrolling. The choice is remembered.
      expandable: true,
      buttons: editable
        ? [{ label: I18n.t('Delete'), value: 'delete', danger: true }, { label: I18n.t('Edit'), value: 'edit', primary: true }]
        : [],
    }).then((answer) => {
      if (answer === 'edit') editEvent(ev);
      else if (answer === 'delete') removeEvent(ev);
    });
  }

  /* ---------- creating and editing ---------- */

  // Settings has its own `field`/`sel` helpers, but they are private to that
  // module's IIFE. These are the same two shapes, kept here rather than by
  // exporting Settings' internals — the alternative is widening a module's
  // surface so a second one can borrow four lines of markup.
  const field = (label, inputHtml, hint = '') =>
    `<label class="set-field"><span class="set-label">${esc(label)}</span>${inputHtml}` +
    `${hint ? `<span class="set-hint">${esc(hint)}</span>` : ''}</label>`;
  const sel = (id, options, value) =>
    `<select id="${escAttr(id)}">${options.map(([v, label]) =>
      `<option value="${escAttr(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;


  /** The calendars an event can actually be put in. A read-only one, or one
   *  from a provider Hmelj cannot write to, is left out of the picker rather
   *  than offered and then refused. */
  const writableCalendars = () => calendars.filter((c) => c.sourceEnabled && c.enabled && !c.readOnly && c.writable !== false);

  /** `<input type="datetime-local">` wants the LOCAL wall clock with no zone,
   *  which is exactly what the browser will hand back — so both directions go
   *  through the same pair rather than through toISOString(), which answers in
   *  UTC and is off by the offset. */
  function toLocalInput(ms, dateOnly = false) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    // An all-day instant IS UTC midnight (see fromLocalInput), so it has to be
    // read back in UTC. Reading it with the local getters showed the previous
    // day to everyone west of Greenwich — the same off-by-one, in the other
    // direction, that the UTC anchoring exists to prevent.
    if (dateOnly) return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const fromLocalInput = (v, dateOnly = false) => {
    if (!v) return NaN;
    // An all-day date is anchored to UTC midnight, because that is how the
    // server stores and groups one — see server/calendarEvents.js. Reading it
    // as local midnight would move it a day for anyone east of Greenwich.
    //
    // Only the date PART is read, whatever shape arrives. The input's type is
    // switched when the all-day box is ticked, but a value written before the
    // switch can still be a date-time, and splitting one of those on '-' used
    // to yield NaN and the unhelpful "That is not a valid date".
    if (dateOnly) {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
      return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
    }
    return new Date(v).getTime();
  };

  /* The named repeats. Anything not on this list is reached through CUSTOM
   * below, which builds the rule from a number and a unit — so "every fourth
   * day" needs no entry of its own, and neither does every other interval
   * somebody might want. */
  const CUSTOM = '__custom__';
  const REPEATS = [
    ['', 'Does not repeat'],
    ['FREQ=DAILY', 'Every day'],
    ['FREQ=WEEKLY', 'Every week'],
    ['FREQ=WEEKLY;INTERVAL=2', 'Every two weeks'],
    ['FREQ=MONTHLY', 'Every month'],
    // The one rule worth a name of its own, because it is the one people
    // reliably get wrong by hand: BYMONTHDAY=-1 lands on the 28th, 30th or
    // 31st as the month requires, where "every month on the 30th" silently
    // skips February. Microsoft has no absolute pattern for it either — see
    // server/recurrenceMap.js, which translates it to the relative one Outlook
    // itself uses.
    ['FREQ=MONTHLY;BYMONTHDAY=-1', 'The last day of the month'],
    ['FREQ=YEARLY', 'Every year'],
    [CUSTOM, 'Custom…'],
  ];

  /** The units a custom repeat can count in — FREQ plus what to call it. */
  const CUSTOM_UNITS = [['DAILY', 'days'], ['WEEKLY', 'weeks'], ['MONTHLY', 'months'], ['YEARLY', 'years']];

  /* iCalendar's two-letter days, Monday first — which is the week Slovenia (and
   * most of Europe) starts on, and the order the month grid already draws.
   * The label is one letter, because seven of them have to fit on a phone. */
  const WEEKDAYS = [['MO', 'Mon'], ['TU', 'Tue'], ['WE', 'Wed'], ['TH', 'Thu'], ['FR', 'Fri'], ['SA', 'Sat'], ['SU', 'Sun']];
  /** The BYDAY code for the weekday an instant falls on. */
  const dayCodeOf = (ms) => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(ms).getDay()];

  /**
   * A custom rule split back into the two controls that make it, or null if it
   * is not one of those — which is what decides whether opening an existing
   * event shows "Custom…" filled in or falls back to "keep what is there".
   *
   * Deliberately strict: ONLY `FREQ=<unit>` with an optional INTERVAL. A rule
   * that also carries BYDAY, BYMONTHDAY, COUNT or UNTIL says more than these
   * two controls can, and showing it as "every N weeks" would quietly offer to
   * throw the rest away on the next save.
   */
  function customParts(rrule) {
    const m = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;INTERVAL=(\d+))?(?:;BYDAY=((?:[A-Z]{2})(?:,[A-Z]{2})*))?$/
      .exec(String(rrule || '').trim().toUpperCase());
    if (!m) return null;
    const interval = Math.max(1, parseInt(m[2] || '1', 10));
    const byday = m[3] ? m[3].split(',').filter((d) => WEEKDAYS.some(([v]) => v === d)) : [];
    // BYDAY only means anything on a weekly rule here — the controls do not
    // offer it for the others, so a rule that carries one anyway says more than
    // this form can and belongs under "keep the existing rule".
    if (byday.length && m[1] !== 'WEEKLY') return null;
    if (byday.length) return { freq: m[1], interval, byday };
    // Anything the list already has a NAME for belongs under that name, not
    // under Custom — otherwise "Every week" opens as "Custom: every 1 weeks"
    // and "Every two weeks" stops being reachable by its own label. Checked
    // against REPEATS rather than against `interval === 1`, so adding a named
    // interval to that list needs nothing here.
    if (REPEATS.some(([v]) => v === `FREQ=${m[1]}${interval > 1 ? `;INTERVAL=${interval}` : ''}`)) return null;
    return { freq: m[1], interval, byday: [] };
  }
  const REMINDERS = [['', 'No reminder'], ['0', 'At the time of the event'], ['5', '5 minutes before'],
    ['10', '10 minutes before'], ['15', '15 minutes before'], ['30', '30 minutes before'],
    ['60', '1 hour before'], ['1440', '1 day before']];

  const opt = (list, value) => list.map(([v, label]) =>
    `<option value="${escAttr(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(I18n.t(label))}</option>`).join('');

  /**
   * The colour row of the event form — a strip of swatches backed by a hidden
   * input, rather than a <select> of colour names or a native colour well.
   *
   * Offered for every calendar. It was once hidden for the backends that could
   * not store the colour, which was most of them — the colour lived in the
   * iCalendar document and Microsoft, Exchange and (by measurement) Google all
   * dropped it. Hmelj keeps it itself now, so there is no such calendar left.
   */
  function colorPickerHtml(existing) {
    const current = existing?.color || '';
    const swatches = EVENT_COLORS.map((c) => `<button type="button" class="ce-swatch${c === current ? ' on' : ''}"
      data-color="${escAttr(c)}" style="--c:${escAttr(c || 'transparent')}"
      title="${escAttr(c ? c : I18n.t('Same as the calendar'))}"
      aria-label="${escAttr(c ? c : I18n.t('Same as the calendar'))}">${c ? '' : '✕'}</button>`).join('');
    // Wrapped, because the whole row is hidden and shown as the CALENDAR
    // dropdown moves (bindRepeatPicker) — Microsoft and Exchange calendars
    // cannot store a per-event colour, and offering the strip for one is how a
    // colour gets picked and silently dropped.
    return `<div id="ce-color-row">${field(I18n.t('Colour'),
      `<input type="hidden" id="ce-color" value="${escAttr(current)}"><div class="ce-colors">${swatches}</div>`,
      I18n.t('Kept by Hmelj and shown here only. Google, Outlook and Exchange colour events their own way, and do not store this one.'))}</div>`;
  }

  /**
   * The repeat rule the form is currently describing, or null for a one-off.
   *
   * `Custom…` is not itself a rule — it is the marker that says "read the two
   * controls next to me instead", which is why this cannot just be the select's
   * value the way it used to be.
   */
  function rruleFromForm() {
    const picked = document.getElementById('ce-rrule').value;
    if (picked !== CUSTOM) return picked || null;
    const n = Math.max(2, Math.min(999, parseInt(document.getElementById('ce-interval').value, 10) || 2));
    const freq = document.getElementById('ce-unit').value;
    let rule = `FREQ=${freq};INTERVAL=${n}`;
    if (freq === 'WEEKLY') {
      const days = [...document.querySelectorAll('.ce-day.on')].map((b) => b.dataset.day);
      // Only when it says something the start does not already: a weekly rule
      // lands on its own start's weekday anyway, so BYDAY=MO on an event that
      // starts on a Monday is noise — and noise Microsoft has to translate.
      // Several days, or a day other than the start's, is a real instruction.
      if (days.length && !(days.length === 1 && days[0] === dayCodeOf(currentFormStart()))) {
        rule += `;BYDAY=${days.join(',')}`;
      }
    }
    return rule;
  }

  /** The start the form currently holds, for deciding whether a BYDAY adds
   *  anything — read live, because moving the event moves its weekday. */
  function currentFormStart() {
    const v = document.getElementById('ce-start')?.value || '';
    const t = fromLocalInput(v, document.getElementById('ce-allday')?.checked);
    return Number.isFinite(t) ? t : Date.now();
  }

  /** Shows the interval controls only while Custom… is chosen, the weekday
   *  strip only while the unit is weeks, and the colour strip only while the
   *  chosen CALENDAR can actually store a colour. */
  function bindRepeatPicker() {
    const sel = document.getElementById('ce-rrule');
    const row = document.getElementById('ce-custom');
    const unit = document.getElementById('ce-unit');
    const days = document.getElementById('ce-days');
    if (sel && row) sel.addEventListener('change', () => { row.hidden = sel.value !== CUSTOM; });
    if (unit && days) unit.addEventListener('change', () => { days.hidden = unit.value !== 'WEEKLY'; });
    for (const b of document.querySelectorAll('.ce-day')) {
      b.addEventListener('click', () => b.classList.toggle('on'));
    }
  }

  /** Click-to-pick for the swatch strip above. Bound after the dialog is drawn,
   *  since Dialog.form owns the markup until then. */
  function bindColorPicker() {
    const hidden = document.getElementById('ce-color');
    if (!hidden) return;
    for (const b of document.querySelectorAll('.ce-swatch')) {
      b.addEventListener('click', () => {
        hidden.value = b.dataset.color;
        for (const other of document.querySelectorAll('.ce-swatch')) other.classList.toggle('on', other === b);
      });
    }
  }

  /**
   * The event form. One dialog for creating and for editing — the fields are
   * the same and the difference is entirely in what happens on Save.
   */
  async function editEvent(existing = null, prefill = {}) {
    const writable = writableCalendars();
    if (!writable.length) {
      toast(I18n.t('No calendar you can add to. Add a Hmelj calendar in Settings › Calendars.'), 6000);
      return;
    }
    const allDay = existing?.allDay ?? !!prefill.allDay;
    const start = existing?.start ?? prefill.start ?? Math.ceil(Date.now() / 1800000) * 1800000;
    const end = existing?.end ?? prefill.end ?? start + 3600000;
    // A recurring event's rule lives on the master; the occurrence carries it
    // along so the picker can show what it actually is.
    const rrule = existing?.rrule || '';
    const custom = customParts(rrule);
    const known = REPEATS.some(([v]) => v === rrule);
    const reminder = existing?.alarms?.[0]?.minutesBefore;

    const bodyHtml = `
      ${field(I18n.t('Title'), `<input id="ce-summary" value="${escAttr(existing?.summary ?? prefill.summary ?? '')}" placeholder="${escAttr(I18n.t('Title'))}">`)}
      <label class="mini-toggle" style="gap:6px;margin:2px 0 8px">
        <input type="checkbox" id="ce-allday" ${allDay ? 'checked' : ''}> <span>${esc(I18n.t('All day'))}</span>
      </label>
      ${field(I18n.t('Starts'), `<input id="ce-start" type="${allDay ? 'date' : 'datetime-local'}" value="${escAttr(toLocalInput(start, allDay))}">`)}
      ${field(I18n.t('Ends'), `<input id="ce-end" type="${allDay ? 'date' : 'datetime-local'}" value="${escAttr(toLocalInput(allDay ? end - 1 : end, allDay))}">`)}
      ${field(I18n.t('Calendar'), sel('ce-cal', writable.map((c) => [c.id, `${c.displayName} (${c.sourceLabel})`]),
        existing?.calendarId || writable[0].id))}
      ${field(I18n.t('Repeats'), `<select id="ce-rrule">${opt(REPEATS, custom ? CUSTOM : (known ? rrule : ''))}${
        !known && !custom && rrule ? `<option value="${escAttr(rrule)}" selected>${esc(I18n.t('Keep the existing repeat rule'))}</option>` : ''}</select>`)}
      <div id="ce-custom" class="ce-custom"${custom ? '' : ' hidden'}>
        <div class="ce-custom-row">
          <span>${esc(I18n.t('Every'))}</span>
          <input id="ce-interval" type="number" min="2" max="999" step="1" value="${custom?.interval ?? 4}">
          <select id="ce-unit">${opt(CUSTOM_UNITS, custom?.freq || 'DAILY')}</select>
        </div>
        <div id="ce-days" class="ce-days"${custom?.freq === 'WEEKLY' ? '' : ' hidden'}>
          ${WEEKDAYS.map(([code, label]) => `<button type="button" class="ce-day${
            (custom?.byday?.length ? custom.byday.includes(code) : code === dayCodeOf(start)) ? ' on' : ''
          }" data-day="${escAttr(code)}">${esc(I18n.t(label))}</button>`).join('')}
        </div>
      </div>
      ${colorPickerHtml(existing)}
      ${field(I18n.t('Remind me'), `<select id="ce-remind">${opt(REMINDERS, reminder ?? '')}</select>`)}
      ${field(I18n.t('Where'), `<input id="ce-location" value="${escAttr(existing?.location ?? prefill.location ?? '')}">`)}
      ${field(I18n.t('Attendees'), `<input id="ce-attendees" value="${escAttr((existing?.attendees || prefill.attendees || []).map((a) => a.address).join(', '))}" placeholder="a@example.com, b@example.com">`,
        I18n.t('Everyone listed here is emailed an invitation when you save.'))}
      ${field(I18n.t('Notes'), `<textarea id="ce-description" rows="3">${esc(existing?.description ?? prefill.description ?? '')}</textarea>`)}`;

    const vals = await Dialog.form(existing ? I18n.t('Edit event') : I18n.t('New event'), bodyHtml, {
      okLabel: I18n.t('Save'),
      wide: true,
      // The two date inputs are `date` or `datetime-local` depending on the
      // all-day box, and the box can be ticked AFTER the form is drawn. Without
      // this the inputs kept whichever type they were rendered with while
      // getValue read them as the other, and saving an all-day event failed
      // with "That is not a valid date" — a message about the input rather than
      // about the real problem, which was that nothing had told it to change.
      onOpen: (root) => {
        bindColorPicker();
        bindRepeatPicker();
        // The same contact autocomplete the composer's To/Cc/Bcc use — typing
        // every attendee's address in full while the composer completes them
        // two clicks away was an oversight, not a decision. Without groups:
        // a group token is expanded server-side on the mail paths only, so one
        // left here would reach the calendar server as an address that is not
        // one (see attachRecipients in compose.js).
        Compose.attachRecipients?.(root.querySelector('#ce-attendees'), { groups: false });
        const box = root.querySelector('#ce-allday');
        const startEl = root.querySelector('#ce-start');
        const endEl = root.querySelector('#ce-end');

        // Converted as STRINGS, not through an instant. Both input types hold
        // a local wall-clock value, so the date part of one is the date part of
        // the other — while routing it through epoch milliseconds would apply
        // the all-day UTC anchoring to a value that is not anchored yet, and
        // move the date a day for anyone whose local time is past midnight but
        // whose UTC time is not.
        const dayPart = (v) => (/^\d{4}-\d{2}-\d{2}/.exec(v || '') || [''])[0];
        const DEFAULT_START = '09:00';
        const DEFAULT_END = '10:00';

        box.addEventListener('change', () => {
          const on = box.checked;
          const sDay = dayPart(startEl.value) || toLocalInput(Date.now(), true);
          const eDay = dayPart(endEl.value) || sDay;
          for (const el of [startEl, endEl]) el.type = on ? 'date' : 'datetime-local';
          if (on) {
            startEl.value = sDay;
            endEl.value = eDay;
          } else {
            // An all-day event carries no clock, so there is nothing to put
            // back — midnight to midnight is not what anybody means by an
            // untimed event made timed, and a working morning is the honest
            // guess.
            startEl.value = `${sDay}T${DEFAULT_START}`;
            endEl.value = `${eDay}T${DEFAULT_END}`;
          }
        });
      },
      getValue: () => {
        const isAllDay = document.getElementById('ce-allday').checked;
        const s = fromLocalInput(document.getElementById('ce-start').value, isAllDay);
        let e = fromLocalInput(document.getElementById('ce-end').value, isAllDay);
        // An all-day event's stored end is EXCLUSIVE — the day after the last
        // one — while the form shows the last day itself, which is what a person
        // means by "ends on".
        if (isAllDay && Number.isFinite(e)) e += 86400000;
        const rem = document.getElementById('ce-remind').value;
        return {
          summary: document.getElementById('ce-summary').value.trim(),
          location: document.getElementById('ce-location').value.trim(),
          description: document.getElementById('ce-description').value,
          start: s, end: e, allDay: isAllDay,
          calendarId: document.getElementById('ce-cal').value,
          rrule: rruleFromForm(),
          // '' is meaningful: it CLEARS the event's own colour back to
          // "follow the calendar" (server/calendarWrite.js#normalizeInput
          // distinguishes an empty string from not-mentioned). Absent entirely
          // when the calendar cannot store one, so the property is left alone
          // rather than being cleared on every save.
          ...(document.getElementById('ce-color')
            ? { color: document.getElementById('ce-color').value } : {}),
          reminders: rem === '' ? [] : [Number(rem)],
          attendees: document.getElementById('ce-attendees').value
            .split(',').map((x) => x.trim()).filter((x) => x.includes('@')),
          // The browser's own zone: the form collects a wall-clock time, and
          // this is what says which clock it was.
          zone: isAllDay ? null : Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      },
    });
    if (!vals || vals === 'cancel') return;
    if (!Number.isFinite(vals.start)) { toast(I18n.t('That is not a valid date')); return; }
    if (!vals.summary) { toast(I18n.t('An event needs a title')); return; }

    // A recurring event being edited has to say WHICH occurrences are meant.
    let scope = 'all';
    if (existing?.recurring) {
      scope = await askScope(I18n.t('This event repeats. Which occurrences should change?'));
      if (!scope) return;
    }

    const { calendarId, ...event } = vals;
    const movingTo = existing && calendarId !== existing.calendarId ? calendarId : null;
    // Moving ONE occurrence, or the tail of a series, out of its calendar is a
    // different operation from moving the event: it would have to split the
    // series first and leave two halves in two places. Refused rather than
    // half-done.
    if (movingTo && scope !== 'all') {
      toast(I18n.t('A repeating event can only be moved to another calendar as a whole. Choose "All events", or move it after the change.'), 8000);
      return;
    }

    try {
      if (movingTo) await moveEvent(existing, movingTo, event);
      else if (existing) {
        await API.updateCalendarEvent(existing.calendarId, existing.uid, event,
          { scope, occurrenceStart: existing.start });
      } else {
        await API.createCalendarEvent(calendarId, event);
      }
      toast(existing ? I18n.t('Event saved') : I18n.t('Event created'));
      await load({ quiet: true });
    } catch (e) {
      toast(e.message, 8000);
    }
  }

  /**
   * Moves an event to another calendar, which is create-then-delete rather than
   * a move: the two calendars are routinely on different servers (an Exchange
   * one and a Google one have nothing in common but this app), and no provider
   * has an operation that spans them.
   *
   * ORDER MATTERS, and this is the whole reason this is a function rather than
   * two lines inline. Create first: if the second half fails, the event exists
   * TWICE and the user deletes one. Delete first and a failure loses it
   * outright, with nothing left to recover from. A duplicate is an annoyance; a
   * deletion is not undoable.
   *
   * The failure between the two halves is reported for what it is, rather than
   * as "could not save" — the copy did land, and somebody who is not told that
   * will make a second one.
   */
  async function moveEvent(existing, toCalendarId, event) {
    await API.createCalendarEvent(toCalendarId, event);
    try {
      await API.deleteCalendarEvent(existing.calendarId, existing.uid,
        { scope: 'all', occurrenceStart: existing.start });
    } catch (e) {
      throw new Error(`${I18n.t('The event was copied to the new calendar, but the original could not be removed')}: ${e.message}`);
    }
  }

  /**
   * "This one, this and future, or all of them?"
   *
   * Asked rather than defaulted, and with no pre-selected answer, because the
   * three are not more and less of the same thing — one of them changes a
   * meeting you have not thought about yet.
   */
  function askScope(message) {
    return Dialog.choose(message, {
      title: I18n.t('Repeating event'),
      buttons: [
        { label: I18n.t('This event'), value: 'one' },
        { label: I18n.t('This and following'), value: 'future' },
        { label: I18n.t('All events'), value: 'all' },
      ],
    }).then((v) => (v && v !== 'cancel' ? v : null));
  }

  async function removeEvent(ev) {
    let scope = 'all';
    if (ev.recurring) {
      scope = await askScope(I18n.t('This event repeats. Which occurrences should be deleted?'));
      if (!scope) return;
    } else if (!await Dialog.confirm(
      `${I18n.t('Delete')} “${ev.summary || I18n.t('(no title)')}”?`,
      { title: I18n.t('Delete'), okLabel: I18n.t('Delete'), danger: true })) return;

    try {
      await API.deleteCalendarEvent(ev.calendarId, ev.uid, { scope, occurrenceStart: ev.start });
      toast(I18n.t('Event deleted'));
      await load({ quiet: true });
    } catch (e) {
      toast(e.message, 8000);
    }
  }

  /* ---------- the sidebar's calendar list ---------- */

  function renderSidebar() {
    const host = document.getElementById('calendar-list');
    if (!host) return;
    const shown = calendars.filter((c) => c.sourceEnabled && c.enabled);
    host.hidden = !isOpen();
    if (!shown.length) { host.innerHTML = ''; return; }
    // Grouped by source, not one flat list. Every provider names its default
    // calendar the same localized thing — three accounts give three entries
    // reading "Koledar" — and which account one belongs to was only in the
    // title attribute, which a phone has no way to show. The heading is
    // dropped when there is nothing to tell apart.
    const bySource = [];
    for (const c of shown) {
      const g = bySource.find((x) => x.id === c.sourceId);
      if (g) g.items.push(c);
      else bySource.push({ id: c.sourceId, label: c.sourceLabel, items: [c] });
    }
    const heading = (text) => `<li class="folder-section">${esc(text)}</li>`;

    host.innerHTML = (bySource.length > 1 ? '' : heading(I18n.t('Calendars')))
      + bySource.map((g) => (bySource.length > 1 ? heading(g.label) : '')
        + g.items.map((c) => `<li class="cal-toggle${c.visible ? '' : ' off'}" data-cal="${escAttr(c.id)}"
          title="${escAttr(c.lastError || `${c.sourceLabel} · ${c.displayName}`)}">
          <span class="cal-swatch" style="--c:${escAttr(c.color)}"></span>
          <span class="cal-name">${esc(c.displayName)}</span>
          ${c.lastError ? '<span class="cal-warn" title="' + escAttr(c.lastError) + '">⚠</span>' : ''}
        </li>`).join('')).join('');
    for (const li of host.querySelectorAll('.cal-toggle')) {
      li.addEventListener('click', () => toggleCalendar(li.dataset.cal));
    }
  }

  async function toggleCalendar(id) {
    const cal = calendars.find((c) => c.id === id);
    if (!cal) return;
    cal.visible = !cal.visible;
    renderSidebar();
    // Repaint from what we already hold rather than refetching: hiding a
    // calendar is a filter over events already on screen, and a round trip for
    // it would make the toggle feel broken.
    const hidden = new Set(calendars.filter((c) => !c.visible).map((c) => c.id));
    render();
    body().querySelectorAll('[data-event]').forEach((b) => {
      const ev = events.find((e) => e.id === b.dataset.event);
      if (ev && hidden.has(ev.calendarId)) b.remove();
    });
    try { await API.setCalendarVisible(id, cal.visible); } catch { /* the next load corrects it */ }
  }

  /* ---------- navigation ---------- */

  function step(n) {
    if (view === 'month') anchor = addMonths(anchor, n);
    // A page moves by exactly what is on screen, which on a phone is three days
    // rather than seven — paging by a week there would skip four days.
    else if (view === 'week') anchor = addDays(anchor, weekDays() * n);
    else anchor = addDays(anchor, view === 'agenda' ? 30 * n : n);
    load({ quiet: true });
  }

  function setView(next) {
    if (!VIEWS.includes(next)) return;
    view = next;
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* private mode */ }
    load({ quiet: true });
  }

  function today() { anchor = new Date(); load({ quiet: true }); }

  /**
   * A new event, starting at a sensible moment for whatever is on screen.
   *
   * Today's next half hour when today is in view, and 09:00 on the anchor day
   * otherwise — because pressing "+" while looking at next March means an event
   * next March, not one this afternoon.
   */
  function newEventHere() {
    const now = new Date();
    const r = range();
    const inView = now >= r.from && now < r.to;
    const start = inView
      ? Math.ceil(now.getTime() / 1800000) * 1800000
      : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9, 0).getTime();
    editEvent(null, { start, end: start + 3600000 });
  }

  /** Entry point for the composer's "turn this message into an event" — see
   *  app.js. Opens the editor prefilled and lets the ordinary save path do the
   *  rest, so there is one place an event is created. */
  function createFrom(prefill) {
    if (!opened) openFolder(CALENDAR_FOLDER);
    // After the view has opened and loaded its calendars, or the picker would
    // have nothing to choose from.
    const run = () => (calendars.length ? editEvent(null, prefill) : setTimeout(run, 120));
    setTimeout(run, opened ? 0 : 300);
  }

  const isOpen = () => opened;

  function open() {
    opened = true;
    document.body.classList.add('calendar-mode');
    el('calendar-view').hidden = false;
    let saved = null;
    try { saved = localStorage.getItem(VIEW_KEY); } catch { /* ignore */ }
    // Agenda on a phone: see the header. A view the user explicitly chose is
    // respected, so this is only the default they start from.
    view = VIEWS.includes(saved) ? saved : (isNarrow() ? 'agenda' : 'month');
    anchor = new Date();
    load();
  }

  function close() {
    opened = false;
    document.body.classList.remove('calendar-mode');
    el('calendar-view').hidden = true;
    const host = document.getElementById('calendar-list');
    if (host) { host.hidden = true; host.innerHTML = ''; }
  }

  /** Called by app.js's SSE handler and its refresh loop. Silent: a background
   *  sync must not blank the grid somebody is reading. */
  function refresh() { if (opened) load({ quiet: true }); }

  function init() {
    el('cal-today').addEventListener('click', today);
    el('cal-prev').addEventListener('click', () => step(-1));
    el('cal-next').addEventListener('click', () => step(1));
    el('cal-refresh').addEventListener('click', () => load({ quiet: true }));
    el('cal-new').addEventListener('click', () => newEventHere());
    el('cal-period').addEventListener('click', () => setView(view === 'month' ? 'agenda' : 'month'));
    el('btn-cal-menu').addEventListener('click', () => document.getElementById('btn-menu')?.click());
    for (const b of el('cal-views').querySelectorAll('button')) {
      b.addEventListener('click', () => setView(b.dataset.view));
    }

    document.addEventListener('keydown', (e) => {
      if (!opened) return;
      // Never while typing, and never over a dialog — the same guard every
      // other keyboard shortcut in the app uses.
      if (e.target.closest('input, textarea, [contenteditable], .modal-backdrop')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 't' || e.key === 'T') { e.preventDefault(); today(); }
      else if (e.key === 'm') setView('month');
      else if (e.key === 'w') setView('week');
      else if (e.key === 'd') setView('day');
      else if (e.key === 'a') setView('agenda');
    });

    // Swipe to page, on the grid only. Vertical movement is left alone so the
    // week view's own scrolling still works.
    let sx = 0, sy = 0, tracking = false;
    const surface = el('calendar-view');
    surface.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { tracking = false; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
    }, { passive: true });
    surface.addEventListener('touchend', (e) => {
      if (!tracking) return;
      tracking = false;
      const dx = (e.changedTouches[0]?.clientX ?? sx) - sx;
      const dy = (e.changedTouches[0]?.clientY ?? sy) - sy;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 2) step(dx < 0 ? 1 : -1);
    }, { passive: true });

    // A phone rotated into landscape crosses the narrow threshold, and the
    // month grid has to switch between dots and titles when it does.
    let wasNarrow = isNarrow();
    window.addEventListener('resize', () => {
      if (!opened || isNarrow() === wasNarrow) return;
      wasNarrow = isNarrow();
      // Re-fetch as well as repaint: crossing the threshold changes how many
      // days the week view covers, and therefore the window itself.
      if (view === 'week') load({ quiet: true }); else render();
    });
  }

  return { init, open, close, refresh, isOpen, renderSidebar, setView, createFrom, newEvent: newEventHere };
})();
