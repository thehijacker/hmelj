/* ─── Theme ──────────────────────────────────────────────────────────────── */

const THEMES      = ['system', 'light', 'dark'];
const THEME_ICONS  = { system: '⊙', light: '☀', dark: '☾' };
const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };

let currentTheme = localStorage.getItem('hmelj-docs-theme') || 'system';

function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.remove('theme-light', 'theme-dark');
  if (theme === 'light') html.classList.add('theme-light');
  if (theme === 'dark')  html.classList.add('theme-dark');
  const btn = document.getElementById('theme-btn');
  if (btn) {
    btn.textContent = THEME_ICONS[theme];
    btn.title = `Theme: ${THEME_LABELS[theme]} — click to change`;
    btn.setAttribute('aria-label', `Theme: ${THEME_LABELS[theme]}, click to change`);
  }
}

function cycleTheme() {
  currentTheme = THEMES[(THEMES.indexOf(currentTheme) + 1) % THEMES.length];
  localStorage.setItem('hmelj-docs-theme', currentTheme);
  applyTheme(currentTheme);
}

/* ─── Collapsible nav groups ─────────────────────────────────────────────── */

const NAV_STATE_KEY = 'hmelj-docs-nav';
let openSections = new Set();

function loadNavState() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_STATE_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveNavState() {
  localStorage.setItem(NAV_STATE_KEY, JSON.stringify([...openSections]));
}

function setGroupOpen(sectionId, open) {
  const li = document.querySelector(`#nav-groups li[data-group-id="${sectionId}"]`);
  if (!li) return;
  li.classList.toggle('open', open);
  if (open) openSections.add(sectionId);
  else       openSections.delete(sectionId);
  saveNavState();
}

function toggleGroup(sectionId) {
  const li = document.querySelector(`#nav-groups li[data-group-id="${sectionId}"]`);
  if (!li) return;
  setGroupOpen(sectionId, !li.classList.contains('open'));
}

function initCollapsible() {
  openSections = loadNavState();

  // Suppress transitions while applying saved state so sections appear
  // immediately open — no slide-down animation on every page load.
  const navLinks = document.getElementById('nav-links');
  navLinks.classList.add('no-transition');

  document.querySelectorAll('#nav-groups > .nav-group > ul > li').forEach(li => {
    const sub  = li.querySelector(':scope > .nav-sub');
    const link = li.querySelector(':scope > a[data-section]');
    if (!sub || !link) return;

    const id = link.dataset.section;
    li.dataset.groupId = id;

    // Wrap the section link in a flex row so the toggle sits on the right
    const row = document.createElement('div');
    row.className = 'nav-row';
    li.insertBefore(row, link);
    row.appendChild(link);

    const btn = document.createElement('button');
    btn.className   = 'nav-toggle';
    btn.title       = 'Expand / collapse';
    btn.innerHTML   = '&#9658;'; // ▶
    row.appendChild(btn);

    // Apply saved state (default: collapsed)
    if (openSections.has(id)) li.classList.add('open');

    // Toggle button: expand/collapse without navigating
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleGroup(id);
    });
  });

  // Re-enable transitions after the initial paint so user interactions animate normally
  requestAnimationFrame(() => requestAnimationFrame(() => {
    navLinks.classList.remove('no-transition');
  }));
}

/* ─── Navigation ─────────────────────────────────────────────────────────── */

let currentSection = null;
let activeNavLink  = null;

function setActiveLink(link) {
  if (activeNavLink) activeNavLink.classList.remove('active');
  activeNavLink = link || null;
  if (activeNavLink) {
    activeNavLink.classList.add('active');
    activeNavLink.scrollIntoView({ block: 'nearest' });
  }
}

function showSection(id, pushState = true, scrollTarget = null) {
  if (document.body.classList.contains('searching')) clearSearch();

  document.querySelectorAll('section').forEach(s => s.classList.remove('active'));

  const target = document.getElementById(id);
  if (target) {
    target.classList.add('active');
    currentSection = id;
    if (pushState) history.pushState({ section: id }, '', '#' + id);
    loadSectionImages(target);
    buildBreadcrumb(id);
    buildTOC(target);
    buildPagerNav(target, id);
  }

  document.getElementById('nav').classList.remove('open');
  document.getElementById('nav-overlay').classList.remove('open');

  if (scrollTarget) {
    requestAnimationFrame(() => {
      document.getElementById(scrollTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } else {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
}

/* ─── Performance: only fetch screenshots for the section being viewed ───── */

function loadSectionImages(section) {
  section.querySelectorAll('img[data-src]').forEach(img => {
    img.src = img.dataset.src;
    img.removeAttribute('data-src');
  });
}

/* ─── Breadcrumb ─────────────────────────────────────────────────────────── */

function buildBreadcrumb(id) {
  const bar = document.getElementById('breadcrumb');
  if (!bar) return;
  const link = document.querySelector(`#nav-groups a[data-section="${id}"]:not([data-scroll])`);
  const group = link?.closest('.nav-group')?.querySelector('.nav-group-title')?.textContent;
  const title = link?.textContent?.trim() || document.getElementById(id)?.querySelector('h1')?.textContent || '';
  bar.innerHTML = '';
  const home = document.createElement('a');
  home.href = '#about';
  home.dataset.section = 'about';
  home.textContent = 'Docs';
  bar.appendChild(home);
  if (group) {
    bar.appendChild(document.createTextNode(' / '));
    const g = document.createElement('span');
    g.className = 'crumb-group';
    g.textContent = group;
    bar.appendChild(g);
  }
  if (title) {
    bar.appendChild(document.createTextNode(' / '));
    const t = document.createElement('span');
    t.className = 'crumb-current';
    t.textContent = title;
    bar.appendChild(t);
  }
  home.addEventListener('click', e => {
    e.preventDefault();
    setActiveLink(document.querySelector('a[data-section="about"]:not([data-scroll])'));
    showSection('about', true);
  });
}

/* ─── "On this page" TOC ─────────────────────────────────────────────────── */

function buildTOC(section) {
  const inner = document.getElementById('toc-inner');
  if (!inner) return;
  const headings = section.querySelectorAll('h2[id], h3[id]');
  inner.innerHTML = '';
  if (!headings.length) {
    document.getElementById('toc')?.classList.add('empty');
    return;
  }
  document.getElementById('toc')?.classList.remove('empty');

  const label = document.createElement('div');
  label.className = 'toc-label';
  label.textContent = 'On this page';
  inner.appendChild(label);

  const list = document.createElement('ul');
  headings.forEach(h => {
    const li = document.createElement('li');
    li.className = h.tagName === 'H3' ? 'toc-sub' : '';
    const a = document.createElement('a');
    a.href = '#' + h.id;
    a.textContent = h.textContent.replace(/^\s+/, '');
    a.addEventListener('click', e => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.appendChild(a);
    list.appendChild(li);
  });
  inner.appendChild(list);
  initTocScrollSpy(headings, inner);
}

let tocObserver = null;

function initTocScrollSpy(headings, inner) {
  if (tocObserver) tocObserver.disconnect();
  if (!headings.length) return;

  tocObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const link = inner.querySelector(`a[href="#${entry.target.id}"]`);
      if (!link) return;
      if (entry.isIntersecting) {
        inner.querySelectorAll('a.active').forEach(a => a.classList.remove('active'));
        link.classList.add('active');
      }
    });
  }, { rootMargin: '-80px 0px -70% 0px', threshold: 0 });

  headings.forEach(h => tocObserver.observe(h));
}

/* ─── Prev / Next footer navigation ──────────────────────────────────────── */

function getSectionOrder() {
  return Array.from(document.querySelectorAll('#nav-groups a[data-section]:not([data-scroll])'))
    .map(a => a.dataset.section);
}

function buildPagerNav(section, id) {
  section.querySelector('.pager-nav')?.remove();

  const order = getSectionOrder();
  const idx = order.indexOf(id);
  if (idx === -1) return;

  const prevId = order[idx - 1];
  const nextId = order[idx + 1];
  if (!prevId && !nextId) return;

  const nav = document.createElement('div');
  nav.className = 'pager-nav';

  const makeLink = (targetId, dir) => {
    const link = document.querySelector(`#nav-groups a[data-section="${targetId}"]:not([data-scroll])`);
    const title = link?.textContent?.trim() || '';
    const a = document.createElement('a');
    a.href = '#' + targetId;
    a.dataset.section = targetId;
    a.className = 'pager-link pager-' + dir;
    a.innerHTML = dir === 'prev'
      ? `<span class="pager-dir">&larr; Previous</span><span class="pager-title">${title}</span>`
      : `<span class="pager-dir">Next &rarr;</span><span class="pager-title">${title}</span>`;
    a.addEventListener('click', e => {
      e.preventDefault();
      setActiveLink(document.querySelector(`a[data-section="${targetId}"]:not([data-scroll])`));
      setGroupOpen(targetId, true);
      showSection(targetId, true);
    });
    return a;
  };

  if (prevId) nav.appendChild(makeLink(prevId, 'prev'));
  else nav.appendChild(document.createElement('span'));
  if (nextId) nav.appendChild(makeLink(nextId, 'next'));

  const backTop = section.querySelector('.back-top');
  if (backTop) backTop.after(nav);
  else section.appendChild(nav);
}

function initNav() {
  document.querySelectorAll('a[data-section]').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const id       = link.dataset.section;
      const scrollTo = link.dataset.scroll || null;
      setActiveLink(link);
      if (scrollTo) setGroupOpen(id, true); // subsection: always expand parent
      else          toggleGroup(id);         // section link: toggle
      showSection(id, true, scrollTo);
    });
  });

  window.addEventListener('popstate', e => {
    const id = (e.state && e.state.section) || sectionFromHash();
    if (id) {
      const link = document.querySelector(`a[data-section="${id}"]:not([data-scroll])`);
      setActiveLink(link);
      setGroupOpen(id, true);
      showSection(id, false);
    }
  });

  const id   = sectionFromHash() || 'about';
  const link = document.querySelector(`a[data-section="${id}"]:not([data-scroll])`);
  setActiveLink(link);
  setGroupOpen(id, true);
  showSection(id, false);
}

function sectionFromHash() {
  const hash = location.hash.replace('#', '').trim();
  return hash && document.getElementById(hash) ? hash : null;
}

/* ─── Hamburger ──────────────────────────────────────────────────────────── */

function initHamburger() {
  const hamburger = document.getElementById('hamburger');
  const nav       = document.getElementById('nav');
  const overlay   = document.getElementById('nav-overlay');
  hamburger.addEventListener('click', () => {
    nav.classList.toggle('open');
    overlay.classList.toggle('open');
  });
  overlay.addEventListener('click', () => {
    nav.classList.remove('open');
    overlay.classList.remove('open');
  });
}

/* ─── Search ─────────────────────────────────────────────────────────────── */

let matchNodes  = [];
let matchIndex  = -1;
let searchTimer = null;

function initSearch() {
  const input    = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(input.value), 200);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); advanceMatch(); }
    if (e.key === 'Escape') { clearSearch(); input.blur(); }
  });
  clearBtn.addEventListener('click', () => { input.value = ''; clearSearch(); input.focus(); });
}

function runSearch(query) {
  const clearBtn = document.getElementById('search-clear');
  const count    = document.getElementById('search-count');
  clearMarks();
  const q = query.trim();
  if (!q) { clearSearch(); return; }

  clearBtn.classList.add('visible');
  document.body.classList.add('searching');

  const regex = new RegExp(escapeRegex(q), 'gi');
  let total = 0;
  document.querySelectorAll('section').forEach(section => {
    const hits = markTextNodes(section, regex);
    section.classList.toggle('has-match', hits > 0);
    if (hits > 0) loadSectionImages(section);
    total += hits;
  });

  matchNodes = Array.from(document.querySelectorAll('mark'));
  matchIndex = matchNodes.length > 0 ? 0 : -1;
  highlightCurrent();
  count.textContent = total > 0 ? `${total}` : '0';
}

function markTextNodes(root, regex) {
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => {
      const tag = node.parentElement?.tagName;
      if (['SCRIPT', 'STYLE', 'MARK'].includes(tag)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  nodes.forEach(node => {
    const text = node.textContent;
    if (!regex.test(text)) return;
    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = regex.lastIndex;
      count++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });
  return count;
}

function advanceMatch() {
  if (!matchNodes.length) return;
  matchNodes[matchIndex]?.classList.remove('current-match');
  matchIndex = (matchIndex + 1) % matchNodes.length;
  highlightCurrent();
}

function highlightCurrent() {
  if (matchIndex < 0 || !matchNodes.length) return;
  const m = matchNodes[matchIndex];
  m.classList.add('current-match');
  m.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function clearMarks() {
  document.querySelectorAll('mark').forEach(m => {
    const p = m.parentNode;
    p.replaceChild(document.createTextNode(m.textContent), m);
    p.normalize();
  });
  matchNodes = [];
  matchIndex = -1;
}

function clearSearch() {
  clearMarks();
  document.body.classList.remove('searching');
  document.querySelectorAll('section').forEach(s => s.classList.remove('has-match'));
  document.getElementById('search-clear').classList.remove('visible');
  document.getElementById('search-count').textContent = '';
  if (currentSection) document.getElementById(currentSection)?.classList.add('active');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ─── Lightbox ───────────────────────────────────────────────────────────── */

function initLightbox() {
  const lb  = document.createElement('div');
  lb.id     = 'lightbox';
  const img = document.createElement('img');
  img.id    = 'lightbox-img';
  lb.appendChild(img);
  document.body.appendChild(lb);

  function open(src, alt) {
    img.src = src;
    img.alt = alt || '';
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    lb.classList.remove('open');
    document.body.style.overflow = '';
  }

  document.querySelectorAll('#content figure img').forEach(image => {
    image.addEventListener('click', () => open(image.src, image.alt));
  });

  lb.addEventListener('click', close);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
  });
}

/* ─── Repository links ───────────────────────────────────────────────────── */

// The handful of repository-specific strings (repo link, clone URL, releases
// link, image name, CI label) are marked with ids in the HTML and filled in
// here, so changing where this lives is one edit rather than twenty.
const REPO = {
  label:       'GitHub',
  repoUrl:     'https://github.com/thehijacker/hmelj',
  cloneUrl:    'https://github.com/thehijacker/hmelj.git',
  releasesUrl: 'https://github.com/thehijacker/hmelj/releases',
  dockerImage: 'ghcr.io/thehijacker/hmelj:latest',
  ciLabel:     'GitHub Actions artifacts',
};

function initRepoLinks() {
  const repoLink = document.getElementById('dyn-repo-link');
  if (repoLink) { repoLink.href = REPO.repoUrl; repoLink.textContent = REPO.label; }

  const releasesLink = document.getElementById('dyn-releases-link');
  if (releasesLink) { releasesLink.href = REPO.releasesUrl; releasesLink.textContent = `${REPO.label} Releases`; }

  document.querySelectorAll('#dyn-docker-image, .dyn-docker-image')
    .forEach((el) => { el.textContent = REPO.dockerImage; });

  const cloneUrl = document.getElementById('dyn-clone-url');
  if (cloneUrl) cloneUrl.textContent = REPO.cloneUrl;

  const ciLabel = document.getElementById('dyn-ci-label');
  if (ciLabel) ciLabel.textContent = REPO.ciLabel;
}

/* ─── Copy buttons ───────────────────────────────────────────────────────── */

function initCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const pre = btn.closest('.code-block').querySelector('pre');
      navigator.clipboard.writeText(pre.textContent.trim()).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1800);
      });
    });
  });
}

/* ─── Boot ───────────────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  applyTheme(currentTheme);
  initRepoLinks();
  document.getElementById('theme-btn')?.addEventListener('click', cycleTheme);
  initCollapsible(); // must run before initNav so nav-row wrappers exist
  initNav();
  initHamburger();
  initSearch();
  initCopyButtons();
  initLightbox();
});
