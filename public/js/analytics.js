// Hmelj — mailbox analytics UI. Opens from the user menu; one account at a
// time, picked in the header. Everything it shows comes from the analytics
// index (server/analytics.js), which only exists once the user has run a scan,
// so the empty state explains that rather than showing a page of zeros.
//
// The selection model is the important bit here, because the end of every path
// through this page is a mass delete:
//  - "selection" mode: explicit rows the user ticked. What you see is what goes.
//  - "filter" mode ("select all N matching"): the SERVER re-resolves the match
//    set at delete time from the same filter, so a stale page can't delete
//    something the user never reviewed. The confirmation always shows the
//    server's own dry-run count and size, never a number this page computed.
const Analytics = (() => {
  let accountId = null;
  let tab = 'overview';
  let summaryData = null;
  let scanTimer = null;
  // Cleanup tab state
  let queryText = '';
  let lastQuery = null;                  // { rows, messages, bytes }
  // One sort per table, remembered while the dialog is open. Senders/Largest/
  // Cleanup sort in SQL (so the LIMIT applies to the chosen order — see
  // analytics.js#topSenders); the overview tables sort in place here, since
  // their rows are already fully loaded and there is no LIMIT to interact with.
  const sorts = {
    folders: { key: 'bytes', dir: 'desc' },
    years: { key: 'year', dir: 'desc' },
    senders: { key: 'bytes', dir: 'desc' },
    largest: { key: 'size', dir: 'desc' },
    cleanup: { key: 'size', dir: 'desc' },
    // Sorted HERE, like the overview tables: every bulk sender comes back in one
    // answer (a few hundred at most), so a click re-orders what is loaded
    // rather than asking the server again.
    subs: { key: 'messages', dir: 'desc' },
  };
  // The Subscriptions tab's rows, for the account they were fetched for. Kept
  // so a re-sort or an unsubscribe repaints without a round trip; dropped when
  // the account changes or the index is rescanned or cleared.
  let subsData = null;
  // Which way a column should sort the FIRST time it's clicked: biggest/newest
  // first for quantities, A-Z for names. Clicking the active column flips it.
  const ASC_FIRST = new Set(['sender', 'subject', 'folder', 'name']);
  // Rows per page. The tables are paged rather than capped at a few hundred
  // because a 120,000-message account has far more than that worth looking
  // through, and because "the first 300" silently hides the rest.
  const PAGE_SIZE = 100;
  const pages = { senders: 1, largest: 1, cleanup: 1 };
  // Column key -> label, per table. Keys must match the server's whitelists
  // (analytics.js#SENDER_SORTS / MESSAGE_SORTS) for the three SQL-sorted tables.
  const COLS = {
    folders: (sizes) => [['name', I18n.t('Folder')], ['messages', I18n.t('Messages')], ['unread', I18n.t('Unread')],
      ['indexed', I18n.t('Indexed')], ...(sizes ? [['bytes', I18n.t('Size')]] : [])],
    years: (sizes) => [['year', I18n.t('Year')], ['messages', I18n.t('Messages')], ...(sizes ? [['bytes', I18n.t('Size')]] : [])],
    senders: (sizes) => [['sender', I18n.t('Sender')], ['messages', I18n.t('Messages')],
      ...(sizes ? [['bytes', I18n.t('Size')]] : []), ['bulk', I18n.t('Bulk')], ['latest', I18n.t('Latest')]],
    messages: (sizes) => [...(sizes ? [['size', I18n.t('Size')]] : []), ['subject', I18n.t('Subject')],
      ['sender', I18n.t('Sender')], ['date', I18n.t('Date')], ['folder', I18n.t('Folder')]],
  };
  // Individually ticked rows: the key is opaque (never parsed back), and the
  // pair itself is stored, because folder names contain spaces, slashes and
  // brackets ("[Gmail]/All Mail" is the very folder this targets on Gmail) —
  // splitting a composite key apart would eventually pick the wrong folder to
  // delete from.
  const picked = new Map(); // key -> { folder, uid }
  // "Select all across every page". Not a boolean any more, because each table
  // means something different by "all": Cleanup means the current search, and
  // Largest means everything it lists (size > 0). Holds the FILTER the server
  // will re-resolve at delete time plus the count to display — never a list of
  // rows, which is the whole point: the browser has only seen one page of them.
  let allMatching = null;                // null | { filter, total }

  const $a = (sel) => document.querySelector(sel);
  const body = () => document.getElementById('an-body');
  const modal = () => document.getElementById('analytics-modal');
  const key = (folder, uid) => `${encodeURIComponent(folder)}|${encodeURIComponent(uid)}`;

  function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }
  function fmtNum(n) { return (n || 0).toLocaleString(); }
  function fmtWhen(ms) { return ms ? new Date(ms).toLocaleDateString() : ''; }
  function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }
  /** For values going into a quoted HTML attribute — esc() alone leaves double
   * quotes intact, which would end the attribute early (folder names and row
   * keys both reach attributes here). Mirrors app.js#escAttr. */
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  /** A sortable <th>. `table` picks which sort state it drives, `k` is the
   * column key (validated server-side against a whitelist, see
   * analytics.js#orderBy). The arrow shows direction on the active column
   * only — a table full of arrows reads as noise. */
  function th(table, k, label, { num = false } = {}) {
    const st = sorts[table];
    const active = st.key === k;
    return `<th class="an-sort${active ? ' active' : ''}${num ? ' num' : ''}" data-table="${table}" data-sort="${escAttr(k)}"
      title="${escAttr(I18n.t('Sort by') + ' ' + label)}">${esc(label)}${active ? `<span class="an-arrow">${st.dir === 'asc' ? '▲' : '▼'}</span>` : ''}</th>`;
  }
  /** Prev/Next pager plus an "X–Y of N" readout. Rendered above and below a
   * long table so paging doesn't require a scroll back up. Server-side paging
   * (LIMIT/OFFSET), so page 50 costs the same as page 1. */
  function pager(table, total, shown) {
    const page = pages[table];
    const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (total <= PAGE_SIZE) return '';
    const from = (page - 1) * PAGE_SIZE + 1;
    return `<div class="an-pager" data-table="${table}">
      <button class="btn-sm an-page-prev" ${page <= 1 ? 'disabled' : ''}>‹ ${I18n.t('Previous')}</button>
      <span>${fmtNum(from)}–${fmtNum(from + shown - 1)} ${I18n.t('of')} ${fmtNum(total)}</span>
      <button class="btn-sm an-page-next" ${page >= last ? 'disabled' : ''}>${I18n.t('Next')} ›</button>
    </div>`;
  }
  /** Wires every pager on screen. Changing page keeps the selection: ticking
   * rows on page 1, paging on and ticking more, then deleting is a reasonable
   * thing to do and the selection is stored by folder+uid, not by row index. */
  function wirePager(rerender) {
    body().querySelectorAll('.an-pager').forEach((el) => {
      const table = el.dataset.table;
      el.querySelector('.an-page-prev')?.addEventListener('click', () => {
        pages[table] = Math.max(1, pages[table] - 1);
        rerender();
      });
      el.querySelector('.an-page-next')?.addEventListener('click', () => {
        pages[table] += 1;
        rerender();
      });
    });
  }

  /** Mobile-only sort control. The stacked row layout hides the header row (see
   * the #analytics-modal .an-table rules in app.css), so on a phone there is no
   * header to click — this drives the very same sort state instead. Hidden on
   * desktop, where the headers do the job. */
  function sortBar(table, cols) {
    const st = sorts[table];
    return `<div class="an-sortbar">
      <span>${I18n.t('Sort by')}</span>
      <select class="an-sort-col" data-table="${table}">
        ${cols.map(([k, label]) => `<option value="${escAttr(k)}" ${st.key === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
      <button class="btn-sm an-sort-dir" data-table="${table}"
        title="${escAttr(I18n.t(st.dir === 'asc' ? 'Ascending' : 'Descending'))}">${st.dir === 'asc' ? '▲' : '▼'}</button>
    </div>`;
  }

  /** Click-to-sort for whichever table was just rendered. Same column flips
   * direction; a new column starts in its natural direction (see ASC_FIRST). */
  function wireSort(rerender) {
    body().querySelectorAll('th[data-sort]').forEach((h) => h.addEventListener('click', () => {
      const st = sorts[h.dataset.table];
      const k = h.dataset.sort;
      if (st.key === k) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      else { st.key = k; st.dir = ASC_FIRST.has(k) ? 'asc' : 'desc'; }
      if (pages[h.dataset.table]) pages[h.dataset.table] = 1;
      rerender();
    }));
    // The mobile equivalents (see sortBar).
    body().querySelectorAll('.an-sort-col').forEach((sel) => sel.addEventListener('change', () => {
      const st = sorts[sel.dataset.table];
      st.key = sel.value;
      st.dir = ASC_FIRST.has(sel.value) ? 'asc' : 'desc';
      if (pages[sel.dataset.table]) pages[sel.dataset.table] = 1;
      rerender();
    }));
    body().querySelectorAll('.an-sort-dir').forEach((b) => b.addEventListener('click', () => {
      const st = sorts[b.dataset.table];
      st.dir = st.dir === 'asc' ? 'desc' : 'asc';
      if (pages[b.dataset.table]) pages[b.dataset.table] = 1;
      rerender();
    }));
  }
  /** In-place sort for the overview tables (already-loaded arrays). */
  function sortRows(rows, table, pick) {
    const { key, dir } = sorts[table];
    const sign = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = pick(a, key), y = pick(b, key);
      if (typeof x === 'string' || typeof y === 'string') {
        return sign * String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' });
      }
      return sign * ((x ?? 0) - (y ?? 0));
    });
  }

  function senderLabel(row) {
    return row.from_name ? `${row.from_name} <${row.from_addr}>` : (row.from_addr || '(unknown)');
  }

  /* ---------- open / close ---------- */

  async function open() {
    modal().hidden = false;
    const sel = document.getElementById('an-account');
    const accounts = (state.accounts || []).filter((a) => !a.disabled);
    sel.innerHTML = accounts.map((a) => `<option value="${escAttr(a.id)}">${esc(a.label)}</option>`).join('');
    // Defaults to whichever account is on screen, so opening this from a
    // specific mailbox analyses that one rather than always the first.
    if (!accountId || !accounts.some((a) => a.id === accountId)) {
      accountId = (state.currentAccount !== 'all' && state.currentAccount) || accounts[0]?.id || null;
    }
    sel.value = accountId;
    resetSelection();
    await reload();
    pollScan();
  }

  function close() {
    modal().hidden = true;
    clearTimeout(scanTimer);
    scanTimer = null;
  }

  function isOpen() { return !modal().hidden; }

  function resetSelection() {
    picked.clear();
    allMatching = null;
  }

  function resetPaging() {
    pages.senders = 1; pages.largest = 1; pages.cleanup = 1;
  }

  /* ---------- data ---------- */

  async function reload() {
    if (!accountId) return;
    // A reload follows a finished scan, a cleared index or an account switch —
    // each of which changes who the bulk senders are.
    subsData = null;
    try {
      summaryData = await API.anSummary(accountId);
    } catch (e) {
      body().innerHTML = `<div class="an-empty">${esc(I18n.t('Could not load analytics') + ': ' + e.message)}</div>`;
      return;
    }
    render();
  }

  /** Live scan progress. Only polls while a scan is actually running, and
   * reloads the current tab once it finishes so the numbers appear by
   * themselves. */
  async function pollScan() {
    clearTimeout(scanTimer);
    if (!isOpen() || !accountId) return;
    let s;
    try { s = await API.anScanStatus(accountId); } catch { return; }
    const bar = document.getElementById('an-scanbar');
    if (s.running) {
      bar.hidden = false;
      const folder = s.folder || '';
      const pct = s.folderTotal ? Math.min(100, Math.round((s.folderScanned / s.folderTotal) * 100)) : 0;
      document.getElementById('an-scan-text').textContent =
        `${I18n.t('Scanning')} ${folder} — ${fmtNum(s.folderScanned)}/${fmtNum(s.folderTotal)} (${pct}%) · ` +
        `${I18n.t('folder')} ${s.foldersDone + 1}/${s.foldersTotal} · ${fmtNum(s.scanned)} ${I18n.t('indexed')}`
        + (s.cancelling ? ` · ${I18n.t('stopping…')}` : '');
      scanTimer = setTimeout(pollScan, 1000);
    } else if (!bar.hidden) {
      bar.hidden = true;
      await reload();
    }
  }

  /* ---------- render ---------- */

  function render() {
    document.querySelectorAll('#an-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (!summaryData) return;
    if (tab === 'overview') return renderOverview();
    if (tab === 'senders') return renderSenders();
    if (tab === 'largest') return renderLargest();
    if (tab === 'cleanup') return renderCleanup();
    if (tab === 'subs') return renderSubscriptions();
  }

  /* ---------- Subscriptions ----------
   * Every sender that mails you in bulk (a List-Unsubscribe header), with the
   * three things worth doing about one: leave, keep but out of the Inbox, or
   * clear out what has piled up. Each reuses something that already exists —
   * the message's own unsubscribe route, Settings' filter editor, and the
   * Search & clean up tab — so none of them is a second implementation.
   */
  const SUB_SORTS = {
    sender: (r) => (r.name || r.address).toLowerCase(),
    messages: (r) => r.messages,
    perMonth: (r) => r.perMonth,
    read: (r) => r.readShare,
    latest: (r) => r.lastDate || 0,
  };

  async function renderSubscriptions() {
    if (!summaryData.messages) { body().innerHTML = needsScan(); return; }
    if (!subsData || subsData.accountId !== accountId) {
      body().innerHTML = `<div class="an-empty">${esc(I18n.t('Loading…'))}</div>`;
      try {
        subsData = { accountId, ...(await API.anSubscriptions(accountId)) };
      } catch (e) { body().innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; return; }
    }
    if (!subsData.detectable) {
      body().innerHTML = `<div class="an-empty">${esc(I18n.t('Newsletters are recognised by their List-Unsubscribe header, which an Exchange or Microsoft 365 scan cannot read without opening every message one by one. Subscriptions are found on IMAP accounts — Gmail, and any other.'))}</div>`;
      return;
    }
    if (!subsData.rows.length) {
      body().innerHTML = `<div class="an-empty">${esc(I18n.t('No newsletters in the last scan of this account.'))}</div>`;
      return;
    }
    const st = sorts.subs;
    const key = SUB_SORTS[st.key] || SUB_SORTS.messages;
    const rows = subsData.rows.slice().sort((a, b) => {
      const x = key(a), y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (st.dir === 'asc' ? 1 : -1);
    });
    const canArchive = !!subsData.archiveFolder;

    body().innerHTML = `
      <p class="set-hint">${esc(I18n.t('Everyone who mails you in bulk. "Per month" is the last 90 days, so a sender who has gone quiet shows 0 — and counts are only as fresh as the last scan.'))}</p>
      ${sortBar('subs', [['messages', I18n.t('Messages')], ['perMonth', I18n.t('Per month')], ['read', I18n.t('Read')], ['latest', I18n.t('Latest')], ['sender', I18n.t('Sender')]])}
      <div class="an-table-wrap"><table class="an-table">
        <thead><tr>${th('subs', 'sender', I18n.t('Sender'))}${th('subs', 'messages', I18n.t('Messages'), { num: true })}${th('subs', 'perMonth', I18n.t('Per month'), { num: true })}${th('subs', 'read', I18n.t('Read'), { num: true })}${th('subs', 'latest', I18n.t('Latest'), { num: true })}<th></th></tr></thead>
        <tbody>${rows.map((r, i) => `<tr data-i="${subsData.rows.indexOf(r)}">
          <td class="an-c-sender" title="${escAttr(r.address)}">${esc(r.name || r.address)}${r.name ? `<div class="set-hint" style="margin:0">${esc(r.address)}</div>` : ''}</td>
          <td class="num" data-label="${I18n.t('Messages')}">${fmtNum(r.messages)}</td>
          <td class="num" data-label="${I18n.t('Per month')}">${r.perMonth ? r.perMonth.toLocaleString() : '0'}</td>
          <td class="num" data-label="${I18n.t('Read')}">${r.readShare}%</td>
          <td class="num" data-label="${I18n.t('Latest')}">${fmtWhen(r.lastDate)}</td>
          <td class="an-c-act an-sub-acts">
            ${r.unsubscribedAt
              ? `<span class="set-hint" style="margin:0">✓ ${esc(I18n.t('Unsubscribed'))} ${fmtWhen(r.unsubscribedAt)}</span>`
              : (r.folder && r.uid != null ? `<button class="btn-sm an-unsub">${esc(I18n.t('Unsubscribe'))}</button>` : '')}
            ${canArchive ? `<button class="btn-sm an-autoarch" title="${escAttr(I18n.t('Create a filter that moves this sender\'s mail to the Archive'))}">${esc(I18n.t('Auto-archive'))}</button>` : ''}
            <button class="link-btn an-sub-clean">${esc(I18n.t('Clean up →'))}</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`;

    wireSort(renderSubscriptions);
    const rowOf = (el) => subsData.rows[Number(el.closest('tr').dataset.i)];

    body().querySelectorAll('.an-unsub').forEach((b) => b.addEventListener('click', async () => {
      const r = rowOf(b);
      b.disabled = true;
      try {
        const res = await API.unsubscribe(r.folder, r.uid, accountId);
        if (res.method === 'open' && res.url) {
          // The sender only offers a web page. A popup cannot be opened now —
          // a browser allows that only inside the click itself, and this is
          // after a round trip — so it becomes a real link to click.
          const a = document.createElement('a');
          a.href = res.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.className = 'btn-sm';
          a.textContent = I18n.t('Open unsubscribe page');
          b.replaceWith(a);
          return;
        }
        r.unsubscribedAt = res.at || Date.now();
        toast(I18n.t('Unsubscribed'));
        renderSubscriptions();
      } catch (e) {
        b.disabled = false;
        toast('Unsubscribe failed: ' + e.message, 6000);
      }
    }));

    body().querySelectorAll('.an-autoarch').forEach((b) => b.addEventListener('click', () => {
      const r = rowOf(b);
      // Closed first: Settings is a modal of its own, and the filter editor is
      // where the user's attention goes next.
      close();
      Settings.newFilterFrom({ accountId, from: r.address, name: r.name || r.address, moveTo: subsData.archiveFolder });
    }));

    body().querySelectorAll('.an-sub-clean').forEach((b) => b.addEventListener('click', () => {
      // Exactly what the Senders tab's "Clean up →" does: the sender goes into
      // Search & clean up, with its own count and confirmation before anything
      // is deleted.
      queryText = rowOf(b).address;
      tab = 'cleanup';
      resetSelection();
      render();
      runQuery();
    }));
  }

  /** Shown on every tab that needs the index, when there isn't one yet. The
   * scan's cost is stated up front — on a big Gmail mailbox it's minutes of
   * server traffic, and starting that by surprise would be rude. */
  function needsScan() {
    if (summaryData.messages > 0) return '';
    return `<div class="an-empty">
      <p><strong>${I18n.t('Nothing indexed for this account yet.')}</strong></p>
      <p>${I18n.t('Press Scan to build the index. It reads every message\'s sender, subject, date and size — never message bodies — and can take a few minutes for a large mailbox. Later scans only read what arrived since.')}</p>
      <p class="set-hint">${I18n.t('Folders to scan')}: ${esc((summaryData.scanScope || []).join(', ') || '—')}</p>
    </div>`;
  }

  function renderOverview() {
    const d = summaryData;
    const sizes = d.sizesAvailable;
    const tiles = [
      ['Messages indexed', fmtNum(d.messages)],
      ...(sizes ? [['Total size', fmtBytes(d.bytes)]] : []),
      ['Unread', fmtNum(d.unread)],
      ['Bulk / list mail', `${fmtNum(d.bulk?.messages)}${sizes ? ' · ' + fmtBytes(d.bulk?.bytes) : ''}`],
    ];
    const liveTotal = (d.liveFolders || []).reduce((n, f) => n + (f.total || 0), 0);
    // Scale for the by-year bars — computed once, not per row.
    const yearMax = Math.max(1, ...(d.byYear || []).map((y) => (sizes ? y.bytes : y.messages)));
    // Sorting needs the indexed numbers alongside the live ones, so join first
    // and sort the joined shape — otherwise "sort by Size" would have nothing
    // to sort on (size lives in perFolder, not in liveFolders).
    const idxFor = (path) => (d.perFolder || []).find((x) => x.folder === path);
    const folderRows = sortRows((d.liveFolders || []).map((f) => {
      const idx = idxFor(f.path);
      return { path: f.path, total: f.total, unseen: f.unseen, indexed: idx?.messages ?? null, bytes: idx?.bytes ?? null };
    }), 'folders', (r, k) => (k === 'name' ? r.path : k === 'messages' ? r.total : k === 'unread' ? r.unseen : k === 'indexed' ? r.indexed : r.bytes));
    const yearRows = sortRows(d.byYear || [], 'years', (r, k) => (k === 'year' ? r.year : k === 'messages' ? r.messages : r.bytes));
    body().innerHTML = `
      ${!sizes ? `<div class="an-note">${I18n.t('This account is connected over Microsoft Graph, which does not expose message sizes at all — counts, senders and dates are exact, but everything size-based is unavailable here.')}</div>` : ''}
      ${(d.scanScope || []).length && d.scanScope[0] !== 'INBOX' ? `<div class="an-note">${I18n.t('Scanned scope')}: <code>${esc(d.scanScope.join(', '))}</code>. ${I18n.t('On Gmail this is All Mail, where every message exists exactly once — per-label folders below would otherwise count the same message several times.')}</div>` : ''}
      <div class="an-tiles">
        ${tiles.map(([k, v]) => `<div class="an-tile"><span class="an-tile-v">${esc(v)}</span><span class="an-tile-k">${I18n.t(k)}</span></div>`).join('')}
      </div>
      ${needsScan()}
      <h3 class="an-h">${I18n.t('Folders on the server')} <span class="set-hint">(${I18n.t('live counts, no scan needed')} — ${fmtNum(liveTotal)} ${I18n.t('total')})</span></h3>
      ${sortBar('folders', COLS.folders(sizes))}
      <div class="an-table-wrap"><table class="an-table">
        <thead><tr>${th('folders', 'name', I18n.t('Folder'))}${th('folders', 'messages', I18n.t('Messages'), { num: true })}${th('folders', 'unread', I18n.t('Unread'), { num: true })}${th('folders', 'indexed', I18n.t('Indexed'), { num: true })}${sizes ? th('folders', 'bytes', I18n.t('Size'), { num: true }) : ''}</tr></thead>
        <tbody>${folderRows.map((f) => {
          return `<tr><td class="an-c-name" title="${escAttr(f.path)}">${esc(f.path)}</td>
            <td class="num" data-label="${I18n.t('Messages')}">${fmtNum(f.total)}</td>
            <td class="num" data-label="${I18n.t('Unread')}">${fmtNum(f.unseen)}</td>
            <td class="num" data-label="${I18n.t('Indexed')}">${f.indexed == null ? '—' : fmtNum(f.indexed)}</td>
            ${sizes ? `<td class="num" data-label="${I18n.t('Size')}">${f.bytes == null ? '—' : fmtBytes(f.bytes)}</td>` : ''}</tr>`;
        }).join('')}</tbody>
      </table></div>
      ${d.byYear?.length ? `
      <h3 class="an-h">${I18n.t('By year')}</h3>
      ${sortBar('years', COLS.years(sizes))}
      <div class="an-table-wrap"><table class="an-table">
        <thead><tr>${th('years', 'year', I18n.t('Year'))}${th('years', 'messages', I18n.t('Messages'), { num: true })}${sizes ? th('years', 'bytes', I18n.t('Size'), { num: true }) : ''}<th></th></tr></thead>
        <tbody>${yearRows.map((y) => {
          const val = sizes ? y.bytes : y.messages;
          return `<tr><td class="an-c-name">${y.year}</td>
            <td class="num" data-label="${I18n.t('Messages')}">${fmtNum(y.messages)}</td>
            ${sizes ? `<td class="num" data-label="${I18n.t('Size')}">${fmtBytes(y.bytes)}</td>` : ''}
            <td class="an-bar-cell"><span class="an-bar" style="width:${Math.round((val / yearMax) * 100)}%"></span></td></tr>`;
        }).join('')}</tbody>
      </table></div>` : ''}`;
    wireSort(renderOverview);
  }

  async function renderSenders() {
    if (!summaryData.messages) { body().innerHTML = needsScan(); return; }
    // No sizes (Graph) means the default sort column doesn't exist — fall back
    // to message count rather than sorting by a column of zeros.
    if (!summaryData.sizesAvailable && sorts.senders.key === 'bytes') sorts.senders.key = 'messages';
    let rows, total;
    try {
      ({ rows, total } = await API.anSenders(accountId, sorts.senders.key, sorts.senders.dir, PAGE_SIZE, (pages.senders - 1) * PAGE_SIZE));
    } catch (e) { body().innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; return; }
    const sizes = summaryData.sizesAvailable;
    body().innerHTML = `
      <p class="set-hint">${I18n.t('Ranked by how much space each sender costs you. “Bulk” counts messages carrying a List-Unsubscribe header — the reliable marker of newsletters, notifications and adverts. Click a sender to load it in Search & clean up.')}</p>
      ${sortBar('senders', COLS.senders(sizes))}
      ${pager('senders', total, rows.length)}
      <div class="an-table-wrap"><table class="an-table">
        <thead><tr>${th('senders', 'sender', I18n.t('Sender'))}${th('senders', 'messages', I18n.t('Messages'), { num: true })}${sizes ? th('senders', 'bytes', I18n.t('Size'), { num: true }) : ''}${th('senders', 'bulk', I18n.t('Bulk'), { num: true })}${th('senders', 'latest', I18n.t('Latest'), { num: true })}<th></th></tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="an-c-sender" title="${escAttr(senderLabel(r))}">${esc(senderLabel(r))}</td>
          <td class="num" data-label="${I18n.t('Messages')}">${fmtNum(r.messages)}</td>
          ${sizes ? `<td class="num" data-label="${I18n.t('Size')}">${fmtBytes(r.bytes)}</td>` : ''}
          <td class="num" data-label="${I18n.t('Bulk')}">${r.bulk ? fmtNum(r.bulk) : ''}</td>
          <td class="num" data-label="${I18n.t('Latest')}">${fmtWhen(r.lastDate)}</td>
          <td class="an-c-act"><button class="link-btn an-pick-sender" data-addr="${escAttr(r.from_addr)}">${I18n.t('Clean up →')}</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      ${pager('senders', total, rows.length)}`;
    wireSort(renderSenders);
    wirePager(renderSenders);
    body().querySelectorAll('.an-pick-sender').forEach((b) => b.addEventListener('click', () => {
      queryText = b.dataset.addr;
      tab = 'cleanup';
      resetSelection();
      render();
      runQuery();
    }));
  }

  /** The Largest tab's "select all": every indexed message that has a size,
   * which is exactly what this tab lists (minSize 1 rather than an empty
   * filter, which would also sweep in the size-0 rows it never shows). */
  function largestSel(pageCount, total) {
    return { pageCount, total, filter: { minSize: 1 }, rerender: renderLargest };
  }

  async function renderLargest() {
    if (!summaryData.messages) { body().innerHTML = needsScan(); return; }
    if (!summaryData.sizesAvailable) {
      body().innerHTML = `<div class="an-empty">${I18n.t('This account is connected over Microsoft Graph, which does not expose message sizes at all — counts, senders and dates are exact, but everything size-based is unavailable here.')}</div>`;
      return;
    }
    let rows, total;
    try {
      ({ rows, total } = await API.anLargest(accountId, sorts.largest.key, sorts.largest.dir, PAGE_SIZE, (pages.largest - 1) * PAGE_SIZE));
    } catch (e) { body().innerHTML = `<div class="an-empty">${esc(e.message)}</div>`; return; }
    body().innerHTML = `
      <p class="set-hint">${I18n.t('The heaviest single messages — usually big attachments. Deleting a handful of these often frees more space than thousands of small ones.')}</p>
      ${sortBar('largest', COLS.messages(true))}
      ${deleteBarHtml('top', largestSel(rows.length, total))}
      ${pager('largest', total, rows.length)}
      <div class="an-table-wrap"><table class="an-table an-table-msgs">
        <thead><tr><th></th>${th('largest', 'size', I18n.t('Size'), { num: true })}${th('largest', 'subject', I18n.t('Subject'))}${th('largest', 'sender', I18n.t('Sender'))}${th('largest', 'date', I18n.t('Date'), { num: true })}${th('largest', 'folder', I18n.t('Folder'))}</tr></thead>
        <tbody>${rows.map((r) => {
          const k = key(r.folder, r.uid);
          // `folder`/`uid` name the copy this row's size belongs to, and
          // `copies` says whether the message exists elsewhere too (Gmail
          // labels) — see analytics.js#largest.
          const where = r.folder + (r.copies > 1 ? ` +${r.copies - 1}` : '');
          return `<tr><td class="an-c-check"><input type="checkbox" class="an-row-check" data-key="${escAttr(k)}" data-folder="${escAttr(r.folder)}" data-uid="${escAttr(r.uid)}"
              ${allMatching || picked.has(k) ? 'checked' : ''} ${allMatching ? 'disabled' : ''}></td>
            <td class="num an-c-size" data-label="${I18n.t('Size')}">${fmtBytes(r.size)}</td>
            <td class="an-c-subj" title="${escAttr(r.subject || '')}">${esc(r.subject || '(no subject)')}</td>
            <td class="an-c-sender" title="${escAttr(senderLabel(r))}">${esc(senderLabel(r))}</td>
            <td class="num an-c-date">${fmtWhen(r.date)}</td>
            <td class="an-c-where" title="${escAttr(where)}">${esc(where)}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      ${pager('largest', total, rows.length)}
      ${deleteBarHtml()}`;
    wireRows(largestSel(rows.length, total));
    wireSort(renderLargest);
    wirePager(renderLargest);
  }

  function renderCleanup() {
    if (!summaryData.messages) { body().innerHTML = needsScan(); return; }
    const sizes = summaryData.sizesAvailable;
    body().innerHTML = `
      <div class="an-search">
        <input id="an-q" placeholder="${escAttr(I18n.t('e.g. +aliexpress -invoice -"order successful"'))}" value="${escAttr(queryText)}">
        <button class="btn-sm" id="btn-an-search">${I18n.t('Search')}</button>
      </div>
      <p class="set-hint">${I18n.t('A bare word or +word must appear; -word must not. Use quotes for phrases. Terms are matched against subject and sender. Nothing is deleted until you confirm, and the confirmation shows the server\'s own count.')}</p>
      <div id="an-results"></div>`;
    document.getElementById('btn-an-search').addEventListener('click', () => {
      queryText = document.getElementById('an-q').value;
      pages.cleanup = 1;
      resetSelection();
      runQuery();
    });
    document.getElementById('an-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-an-search').click();
    });
    if (lastQuery) renderResults();
    else if (queryText) runQuery();
  }

  async function runQuery() {
    const target = document.getElementById('an-results');
    if (!target) return;
    target.innerHTML = `<div class="an-empty">${I18n.t('Searching…')}</div>`;
    try {
      lastQuery = await API.anQuery(accountId, {
        filter: { q: queryText }, sort: sorts.cleanup.key, dir: sorts.cleanup.dir,
        limit: PAGE_SIZE, offset: (pages.cleanup - 1) * PAGE_SIZE,
      });
    } catch (e) {
      target.innerHTML = `<div class="an-empty">${esc(e.message)}</div>`;
      return;
    }
    renderResults();
  }

  /** The Cleanup tab's "select all": everything the current search matches. */
  function cleanupSel(pageCount, total) {
    return { pageCount, total, filter: { q: queryText }, rerender: renderResults };
  }

  function renderResults() {
    const target = document.getElementById('an-results');
    if (!target || !lastQuery) return;
    const sizes = summaryData.sizesAvailable;
    const { rows, messages, bytes } = lastQuery;
    target.innerHTML = `
      <div class="an-resultbar">
        <strong>${fmtNum(messages)}</strong> ${I18n.t('messages match')}${sizes ? ` · <strong>${fmtBytes(bytes)}</strong>` : ''}
        ${pager('cleanup', messages, rows.length)}
      </div>
      ${sortBar('cleanup', COLS.messages(sizes))}
      ${deleteBarHtml('top', cleanupSel(rows.length, messages))}
      <div class="an-table-wrap"><table class="an-table an-table-msgs">
        <thead><tr><th></th>${sizes ? th('cleanup', 'size', I18n.t('Size'), { num: true }) : ''}${th('cleanup', 'subject', I18n.t('Subject'))}${th('cleanup', 'sender', I18n.t('Sender'))}${th('cleanup', 'date', I18n.t('Date'), { num: true })}${th('cleanup', 'folder', I18n.t('Folder'))}</tr></thead>
        <tbody>${rows.map((r) => {
          const k = key(r.folder, r.uid);
          return `<tr><td class="an-c-check"><input type="checkbox" class="an-row-check" data-key="${escAttr(k)}" data-folder="${escAttr(r.folder)}" data-uid="${escAttr(r.uid)}"
              ${allMatching || picked.has(k) ? 'checked' : ''} ${allMatching ? 'disabled' : ''}></td>
            ${sizes ? `<td class="num an-c-size" data-label="${I18n.t('Size')}">${fmtBytes(r.size)}</td>` : ''}
            <td class="an-c-subj" title="${escAttr(r.subject || '')}">${esc(r.subject || '(no subject)')}${r.bulk ? ` <span class="an-badge">${I18n.t('bulk')}</span>` : ''}</td>
            <td class="an-c-sender" title="${escAttr(senderLabel(r))}">${esc(senderLabel(r))}</td>
            <td class="num an-c-date">${fmtWhen(r.date)}</td>
            <td class="an-c-where" title="${escAttr(r.folder)}">${esc(r.folder)}</td></tr>`;
        }).join('')}</tbody>
      </table></div>
      ${deleteBarHtml()}`;
    wireSort(runQuery);
    wirePager(runQuery);
    wireRows(cleanupSel(rows.length, messages));
  }

  /** The delete control, rendered BOTH above and below every selectable table.
   * Above matters more than it sounds: with a few hundred rows listed, having
   * to scroll to the bottom to act on a selection you already trust is pure
   * friction. Classes rather than ids, since there are now two of each. */
  function deleteBarHtml(pos = 'bottom', sel = null) {
    // `sel` ({ pageCount, total, filter }) adds the two selection toggles. They
    // live here rather than as a checkbox in the table header because the mobile
    // layout hides the header row entirely (see the stacked-row rules in
    // app.css) — one control that works everywhere beats a desktop-only one
    // plus a phone-only duplicate.
    return `<div class="an-deletebar an-deletebar-${pos}">
      <button class="send-btn danger an-del-btn${pos === 'top' ? ' an-del-compact' : ''}" disabled>${I18n.t('Delete selected…')}</button>
      <span class="an-sel-text"></span>
      ${sel ? `
      <label class="mini-toggle" title="${escAttr(I18n.t('Select every row on this page'))}">
        <input type="checkbox" class="an-sel-page"> ${I18n.t('Select page')} (${fmtNum(sel.pageCount)})</label>
      <label class="mini-toggle" title="${escAttr(I18n.t('Select everything that matches, across all pages'))}">
        <input type="checkbox" class="an-sel-all" ${allMatching ? 'checked' : ''}> ${I18n.t('Select all')} (${fmtNum(sel.total)})</label>` : ''}
      ${pos === 'bottom' ? '<span class="spacer"></span>' : ''}
    </div>`;
  }

  function wireRows(sel = null) {
    body().querySelectorAll('.an-row-check').forEach((c) => c.addEventListener('change', () => {
      const k = c.dataset.key;
      if (c.checked) picked.set(k, { folder: c.dataset.folder, uid: c.dataset.uid });
      else picked.delete(k);
      updateSelText();
    }));
    body().querySelectorAll('.an-del-btn').forEach((b) => b.addEventListener('click', confirmDelete));
    // Select/deselect every row on the page. Only touches this page's rows, so
    // ticks made on other pages survive — the selection is keyed by folder+uid,
    // not by position.
    body().querySelectorAll('.an-sel-page').forEach((box) => box.addEventListener('change', () => {
      body().querySelectorAll('.an-row-check').forEach((c) => {
        if (c.disabled) return;
        c.checked = box.checked;
        const k = c.dataset.key;
        if (box.checked) picked.set(k, { folder: c.dataset.folder, uid: c.dataset.uid });
        else picked.delete(k);
      });
      updateSelText();
    }));
    // Select everything the current view matches, across every page. Switches
    // the delete over to the filter path, where the server re-resolves the set.
    body().querySelectorAll('.an-sel-all').forEach((box) => box.addEventListener('change', () => {
      allMatching = box.checked && sel ? { filter: sel.filter, total: sel.total } : null;
      picked.clear();
      if (sel?.rerender) sel.rerender();
    }));
    updateSelText();
  }

  /** Keeps every copy of the delete control in step — both bars show the same
   * count and are enabled/disabled together. */
  function updateSelText() {
    const n = allMatching ? allMatching.total : picked.size;
    body().querySelectorAll('.an-sel-text').forEach((t) => {
      t.textContent = n ? `${fmtNum(n)} ${I18n.t('selected')}` : I18n.t('Nothing selected');
    });
    body().querySelectorAll('.an-del-btn').forEach((b) => { b.disabled = !n; });
    // Tri-state, so the page toggle reflects reality rather than fighting it:
    // all rows ticked = checked, some = indeterminate, none = clear.
    const rows = [...body().querySelectorAll('.an-row-check')];
    const ticked = rows.filter((c) => picked.has(c.dataset.key)).length;
    body().querySelectorAll('.an-sel-page').forEach((box) => {
      box.disabled = !!allMatching;
      box.checked = !allMatching && rows.length > 0 && ticked === rows.length;
      box.indeterminate = !allMatching && ticked > 0 && ticked < rows.length;
    });
  }

  /**
   * Two round trips on purpose: a dry run first, whose numbers come from the
   * server re-resolving the exact same selection, then the real delete only if
   * the user confirms those numbers. Nothing here trusts this page's own idea
   * of how much is about to disappear.
   */
  async function confirmDelete() {
    const req = allMatching
      ? { filter: allMatching.filter }
      : { selection: [...picked.values()] };
    let plan;
    try {
      plan = await API.anDelete(accountId, { ...req, dryRun: true });
    } catch (e) { toast('Could not check the selection: ' + e.message); return; }
    if (!plan.messages) { toast(I18n.t('Nothing selected')); return; }

    const perFolder = plan.folders.map((f) => `${f.folder}: ${fmtNum(f.messages)}`).join('\n');
    const mode = state.settings.deleteBehavior;
    const fate = mode === 'expunge'
      ? I18n.t('They will be deleted permanently and cannot be recovered.')
      : mode === 'flag'
        ? I18n.t('They will be marked deleted but stay in place — they keep using space until you expunge them.')
        : I18n.t('They will be moved to Trash, so a mistake is recoverable. Space is only reclaimed once Trash is emptied.');
    const ok = await Dialog.confirm(
      `${I18n.t('Delete')} ${fmtNum(plan.messages)} ${I18n.t('messages')}`
      + (summaryData.sizesAvailable ? ` (${fmtBytes(plan.bytes)})` : '') + `?\n\n${perFolder}\n\n${fate}`,
      { title: I18n.t('Confirm mass delete'), okLabel: I18n.t('Delete'), danger: true });
    if (!ok) return;

    const btns = [...body().querySelectorAll('.an-del-btn')];
    btns.forEach((b) => { b.disabled = true; b.textContent = I18n.t('Deleting…'); });
    try {
      const result = await API.anDelete(accountId, req);
      toast(`${I18n.t('Deleted')} ${fmtNum(result.deleted)} ${I18n.t('messages')}`
        + (summaryData.sizesAvailable ? ` (${fmtBytes(result.bytes)})` : ''));
      resetSelection();
      // The mail list behind this dialog is now stale too.
      loadMessages(); loadFolders();
      await reload();
      if (tab === 'cleanup' && queryText) runQuery();
    } catch (e) {
      toast('Delete failed: ' + e.message, 6000);
    } finally {
      btns.forEach((b) => { b.disabled = false; b.textContent = I18n.t('Delete selected…'); });
    }
  }

  /** Called from app.js when the server announces a finished scan (SSE
   * 'analytics-scan'). The toast is app.js's job — it must appear whether or
   * not this dialog is open — so all this does is refresh what's on screen if
   * the dialog happens to be showing that same account. */
  function onScanFinished(id) {
    if (!isOpen() || id !== accountId) return;
    const bar = document.getElementById('an-scanbar');
    if (bar) bar.hidden = true;
    clearTimeout(scanTimer);
    scanTimer = null;
    reload();
  }

  /* ---------- init ---------- */

  function init() {
    document.getElementById('btn-an-close').addEventListener('click', close);
    document.getElementById('an-account').addEventListener('change', async (e) => {
      accountId = e.target.value;
      lastQuery = null;
      subsData = null;
      resetSelection();
      resetPaging();
      await reload();
      pollScan();
    });
    document.querySelectorAll('#an-tabs button').forEach((b) => b.addEventListener('click', () => {
      tab = b.dataset.tab;
      render();
    }));
    document.getElementById('btn-an-scan').addEventListener('click', async () => {
      const already = summaryData?.messages > 0;
      if (already) {
        const full = await Dialog.choose(
          I18n.t('This account already has an index. Scan only what arrived since the last scan, or rebuild it from scratch?'),
          { title: I18n.t('Scan'), buttons: [
            { label: I18n.t('Rebuild fully'), value: 'full' },
            { label: I18n.t('Only new mail'), value: 'incremental', primary: true },
          ] });
        if (!full) return;
        try { await API.anScan(accountId, full === 'full'); } catch (e) { toast('Could not start: ' + e.message); return; }
      } else {
        try { await API.anScan(accountId, true); } catch (e) { toast('Could not start: ' + e.message); return; }
      }
      document.getElementById('an-scanbar').hidden = false;
      document.getElementById('an-scan-text').textContent = I18n.t('Starting the scan…');
      // Says out loud what isn't obvious: this runs on the server, so closing
      // the dialog (or even reloading the page) doesn't stop or lose it, and
      // the finish notice arrives as a toast wherever you are.
      toast(I18n.t('Scanning in the background — you can close this and carry on; you\'ll get a notice when it finishes.'), 6000);
      pollScan();
    });
    document.getElementById('btn-an-cancel').addEventListener('click', () => API.anScanCancel(accountId).catch(() => {}));
  }

  return { init, open, close, isOpen, onScanFinished };
})();
