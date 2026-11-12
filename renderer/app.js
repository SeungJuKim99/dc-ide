'use strict';
const $ = (s) => document.querySelector(s);
const HOME = 'https://gall.dcinside.com/';
// First screen on launch = the login page, returning to "my gallog" after a successful login.
// The exact gallog URL is learned from the logged-in account box (see 'meta' → myGallog);
// until then the gallog root is used, which the site resolves to your own gallog once logged in.
const startUrl = () => 'https://sign.dcinside.com/login?s_url=' +
  encodeURIComponent(store.get('myGallog', '') || 'https://gallog.dcinside.com/');
const PARTITION = 'persist:dc';

// ---------------------------------------------------------------- storage
const store = {
  get(k, d) { try { const v = localStorage.getItem('ide.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ide.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const settings = Object.assign({ dim: true, blurBoss: false, native: true, mute: true }, store.get('settings', {}));
let galleries = store.get('galleries', []);   // [{id, kind, name}]
let recent = store.get('recent', []);         // [{id, kind, name}]
let bookmarks = store.get('bookmarks', []);   // [{url, label, title}]
let events = store.get('events', []);         // [{t, text, href, read}]

// ---------------------------------------------------------------- url helpers
const KIND_PREFIX = { board: '', mgallery: 'mgallery/', mini: 'mini/' };
function parseGall(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/gall\.dcinside\.com$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(mgallery\/|mini\/)?board\/(lists|view|write|modify)/);
  const id = u.searchParams.get('id');
  if (!m || !id) return null;
  return {
    id,
    kind: m[1] === 'mgallery/' ? 'mgallery' : m[1] === 'mini/' ? 'mini' : 'board',
    page: m[2],
    no: u.searchParams.get('no'),
    best: u.searchParams.get('exception_mode') === 'recommend',
  };
}
const gallUrl = (g, page = 'lists', extra = '') =>
  `https://gall.dcinside.com/${KIND_PREFIX[g.kind] || ''}board/${page}/?id=${encodeURIComponent(g.id)}${extra}`;
const pascal = (s) => s.replace(/(^|[_\-\s.]+)(\w)/g, (_, __, c) => c.toUpperCase()).replace(/[^\w]/g, '');

function fileNameFor(url) {
  const g = parseGall(url);
  if (g) {
    const base = pascal(g.id);
    if (g.page === 'view') return `${base}Entity${g.no || ''}.java`;
    if (g.page === 'write') return `${base}Command.java`;
    if (g.page === 'modify') return `${base}Patch.java`;
    return g.best ? `${base}QueryDsl.java` : `${base}Repository.java`;
  }
  let u; try { u = new URL(url); } catch { return 'Untitled.java'; }
  if (/gallog/.test(u.hostname)) return 'ProfileConfig.java';
  if (/search/.test(u.hostname)) return 'SearchSpec.java';
  if (/msign|sign/.test(u.hostname)) return 'AuthFilter.java';
  if (/m\.dcinside/.test(u.hostname)) return 'MobileAdapter.java';
  return 'Application.java';
}

// ---------------------------------------------------------------- tabs
const tabs = [];
let active = null;
let seq = 0;

function newTab(url = HOME, activate = true) {
  const id = ++seq;
  const wv = document.createElement('webview');
  wv.setAttribute('partition', PARTITION);
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', '');
  wv.className = 'bg';
  $('#views').appendChild(wv);

  const el = document.createElement('div');
  el.className = 'tab';
  el.innerHTML = '<span class="ico">C</span><span class="name"></span><span class="close" title="Close (Ctrl+W)">✕</span>';
  $('#tabs').appendChild(el);

  const tab = { id, wv, el, url, realTitle: '' };
  tabs.push(tab);
  renameTab(tab);

  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) { closeTab(tab); e.preventDefault(); }
  });
  el.addEventListener('click', (e) => {
    if (e.target.classList.contains('close')) closeTab(tab); else activateTab(tab);
  });

  wv.addEventListener('dom-ready', () => {
    wv.setAudioMuted(settings.mute || boss);
    wv.send('settings', settings);
  });
  wv.addEventListener('did-start-loading', () => { el.classList.add('loading'); if (tab === active) $('#sb-loading').hidden = false; });
  wv.addEventListener('did-stop-loading', () => { el.classList.remove('loading'); if (tab === active) $('#sb-loading').hidden = true; });
  const onNav = (e) => { tab.url = e.url; renameTab(tab); trackRecent(e.url); saveTabs(); if (tab === active) syncChrome(); };
  wv.addEventListener('did-navigate', onNav);
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNav(e); });
  wv.addEventListener('page-title-updated', (e) => { tab.realTitle = e.title; el.title = ''; });
  wv.addEventListener('ipc-message', (e) => onGuestMessage(tab, e.channel, e.args[0]));

  if (activate) activateTab(tab);
  return tab;
}

function renameTab(tab) {
  tab.name = fileNameFor(tab.url);
  tab.el.querySelector('.name').textContent = tab.name;
  const g = parseGall(tab.url);
  tab.el.querySelector('.ico').textContent = g && g.page === 'view' ? 'E' : g && g.page === 'write' ? 'R' : 'C';
}

function activateTab(tab) {
  active = tab;
  for (const t of tabs) {
    const on = t === tab;
    t.el.classList.toggle('active', on);
    t.wv.classList.toggle('bg', !on);
  }
  tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncChrome();
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  tab.wv.remove();
  tab.el.remove();
  saveTabs();
  if (!tabs.length) { newTab(HOME); return; }
  if (active === tab) activateTab(tabs[Math.min(i, tabs.length - 1)]);
}

function syncChrome() {
  if (!active) return;
  const name = boss ? 'OrderService.java' : active.name;
  window.ide.setTitle(`workspace – ${name}`);
  $('#addr').value = boss ? '' : active.url;
  const g = parseGall(active.url);
  const pkg = g ? `modules › ${pascal(g.id).toLowerCase()}` : 'app';
  $('#breadcrumbs').innerHTML = `workspace › src › main › java › com › workspace › ${pkg} › <b>${escapeHtml(name)}</b>`;
  $('#sb-path').textContent = `workspace › ${pkg.replace(/ › /g, '/')}/${name}`;
  $('#sb-loading').hidden = !active.el.classList.contains('loading');
  renderTree();
}

function navigate(input) {
  const v = input.trim();
  if (!v) return;
  let url;
  if (/^https?:\/\//i.test(v)) url = v;
  else if (/^[a-z0-9_]+$/i.test(v) && v.length <= 40 && !/^\d+$/.test(v)) url = gallUrl({ id: v, kind: 'board' });
  else url = `https://search.dcinside.com/combine/q/${dcEncode(v)}`;
  if (active) active.wv.loadURL(url); else newTab(url);
}

// ---------------------------------------------------------------- project tree
const expanded = new Set(store.get('expanded', ['root', 'src', 'modules', 'recent']));
function toggleExpand(key) { expanded.has(key) ? expanded.delete(key) : expanded.add(key); store.set('expanded', [...expanded]); renderTree(); }

function trackRecent(url) {
  const g = parseGall(url);
  if (!g) return;
  const name = (active && active.galleryName) || g.id;
  recent = [{ id: g.id, kind: g.kind, name }, ...recent.filter((r) => r.id !== g.id)].slice(0, 12);
  store.set('recent', recent);
}

// recent-gallery cache (com.workspace.cache): remove one / clear all.
// Galleries registered as modules are separate and never touched here.
function removeRecent(id) {
  recent = recent.filter((r) => r.id !== id);
  store.set('recent', recent);
  renderTree();
}
function clearRecent() {
  const moduleIds = new Set(galleries.map((g) => g.id));
  recent = recent.filter((r) => moduleIds.has(r.id));   // keep only entries hidden behind modules
  store.set('recent', recent);
  renderTree();
  balloon('Caches invalidated', 'com.workspace.cache was cleared.');
}

function addCurrentGallery() {
  const g = active && parseGall(active.url);
  if (!g) { balloon('Cannot add module', 'Open a gallery page first.'); return; }
  if (!galleries.some((x) => x.id === g.id)) {
    galleries.push({ id: g.id, kind: g.kind, name: active.galleryName || g.id });
    store.set('galleries', galleries);
  }
  expanded.add('g:' + g.id);
  renderTree();
}

function node(depth, opts) {
  const d = document.createElement('div');
  d.className = 'node' + (opts.selected ? ' selected' : '');
  d.style.paddingLeft = 6 + depth * 16 + 'px';
  d.innerHTML =
    `<span class="tw">${opts.expandable ? (opts.open ? '▾' : '▸') : ''}</span>` +
    `<span class="ico ${opts.icoClass || ''}">${opts.ico || ''}</span>` +
    `<span class="label"></span>` +
    (opts.meta ? `<span class="meta"></span>` : '') +
    (opts.onRemove ? `<span class="x" title="${opts.removeTitle || 'Remove'}">${opts.removeIcon || '✕'}</span>` : '');
  d.querySelector('.label').textContent = opts.label;
  if (opts.meta) d.querySelector('.meta').textContent = opts.meta;
  if (opts.tooltip && !boss) d.title = opts.tooltip;
  d.addEventListener('click', (e) => {
    if (e.target.classList.contains('x')) { opts.onRemove(); return; }
    if (opts.expandable && (e.target.classList.contains('tw') || !opts.onOpen)) opts.onToggle();
    else if (opts.onOpen) opts.onOpen(e.ctrlKey || e.button === 1);
  });
  d.addEventListener('auxclick', (e) => { if (e.button === 1 && opts.onOpen) opts.onOpen(true); });
  d.addEventListener('dblclick', () => { if (opts.expandable) opts.onToggle(); });
  return d;
}

function open(url, inNewTab) { if (inNewTab || !active) newTab(url); else active.wv.loadURL(url); }

function renderTree() {
  const tree = $('#tree');
  tree.innerHTML = '';
  const cur = active && parseGall(active.url);
  const add = (depth, o) => tree.appendChild(node(depth, o));
  const dir = (key, depth, label, children, extra = {}) => {
    const open = expanded.has(key);
    add(depth, { label, ico: '▰', icoClass: 'dir', expandable: true, open, onToggle: () => toggleExpand(key), ...extra });
    if (open) children(depth + 1);
  };
  const gallNode = (g, depth, onRemove) => {
    const key = 'g:' + g.id;
    const sel = cur && cur.id === g.id;
    add(depth, {
      label: pascal(g.id) + 'Repository.java', ico: 'C', icoClass: 'java', expandable: true,
      open: expanded.has(key), selected: sel && cur.page === 'lists' && !cur.best, tooltip: g.name,
      onToggle: () => toggleExpand(key), onOpen: (nt) => open(gallUrl(g), nt),
      onRemove,
    });
    if (expanded.has(key)) {
      add(depth + 1, { label: 'findAll()', ico: 'm', icoClass: 'cls', onOpen: (nt) => open(gallUrl(g), nt) });
      add(depth + 1, { label: 'findRecommended()', ico: 'm', icoClass: 'cls', selected: sel && cur.best, onOpen: (nt) => open(gallUrl(g, 'lists', '&exception_mode=recommend'), nt) });
      add(depth + 1, { label: 'save()', ico: 'm', icoClass: 'cls', selected: sel && cur.page === 'write', onOpen: (nt) => open(gallUrl(g, 'write'), nt) });
    }
  };

  dir('root', 0, 'workspace', (d1) => {
    dir('idea', d1, '.idea', () => {});
    dir('src', d1, 'src/main/java', (d2) => {
      dir('modules', d2, 'com.workspace.modules', (d3) => {
        if (!galleries.length) add(d3, { label: '(Ctrl+N or Shift×2 to find a gallery)', ico: '' });
        galleries.forEach((g) => gallNode(g, d3, () => {
          galleries = galleries.filter((x) => x.id !== g.id);
          store.set('galleries', galleries);
          renderTree();
        }));
      });
      const cached = recent.filter((r) => !galleries.some((g) => g.id === r.id));
      dir('recent', d2, 'com.workspace.cache', (d3) => {
        if (!cached.length) add(d3, { label: '(empty)', ico: '' });
        cached.forEach((g) => gallNode(g, d3, () => removeRecent(g.id)));
      }, cached.length ? { onRemove: clearRecent, removeIcon: '🗑', removeTitle: 'Invalidate cache (clear all)' } : {});
      add(d2, { label: 'Application.java', ico: 'C', icoClass: 'java', onOpen: (nt) => open(HOME, nt) });
    });
    add(d1, { label: 'build.gradle.kts', ico: '⚙' });
    add(d1, { label: 'README.md', ico: '¶' });
  });
  dir('ext', 0, 'External Libraries', (d1) => {
    add(d1, { label: '< JDK 21 >', ico: '▣', icoClass: 'dir' });
    add(d1, { label: 'Gallog: profile-config', ico: '▣', icoClass: 'dir', tooltip: '갤로그', onOpen: (nt) => open('https://gallog.dcinside.com/', nt) });
    add(d1, {
      label: 'Auth: session-config', ico: '▣', icoClass: 'dir', tooltip: '로그인',
      onOpen: (nt) => {
        const back = active && /^https:\/\/gall\.dcinside\.com\//.test(active.url) ? active.url : HOME;
        open('https://sign.dcinside.com/login?s_url=' + encodeURIComponent(back), nt);
      },
    });
  });
  renderBookmarks();
}

function renderBookmarks() {
  const box = $('#bookmarks');
  box.innerHTML = '';
  const add = (o) => box.appendChild(node(0, o));
  add({ label: '☆ Bookmark current tab', ico: '', onOpen: () => {
    if (!active || bookmarks.some((b) => b.url === active.url)) return;
    bookmarks.unshift({ url: active.url, label: active.name, title: active.realTitle });
    store.set('bookmarks', bookmarks); renderBookmarks();
  } });
  bookmarks.forEach((b, i) => add({
    label: b.label, ico: '★', icoClass: 'cls', tooltip: b.title,
    onOpen: (nt) => open(b.url, nt),
    onRemove: () => { bookmarks.splice(i, 1); store.set('bookmarks', bookmarks); renderBookmarks(); },
  }));
}

// ---------------------------------------------------------------- notifications
function onGuestMessage(tab, channel, data) {
  if (channel === 'alarm') return pushEvent(data.text, data.href);
  if (channel === 'meta') {
    if (data.myGallog && /^https:\/\/gallog\.dcinside\.com\/[A-Za-z0-9_]+\/?$/.test(data.myGallog)) {
      store.set('myGallog', data.myGallog);
    }
    if (data.galleryName) {
      tab.galleryName = data.galleryName;
      const g = parseGall(tab.url);
      if (g) for (const list of [galleries, recent]) for (const x of list) if (x.id === g.id) x.name = data.galleryName;
      store.set('galleries', galleries); store.set('recent', recent);
    }
    return;
  }
  if (channel === 'key') return handleKey(data);
  if (channel === 'need-settings') { try { tab.wv.send('settings', settings); } catch { /* dom-ready will send */ } }
}

function pushEvent(text, href) {
  const now = Date.now();
  // de-dupe: the site may re-render the same alarm on every page load
  if (events.some((e) => e.text === text && e.href === href && now - e.t < 6 * 3600e3)) return;
  events.unshift({ t: now, text, href, read: false });
  events = events.slice(0, 200);
  store.set('events', events);
  renderEvents();
  if (!boss) balloon('Code review: new comment', text, () => { markRead(href); open(href, true); });
  window.ide.flash();
  if (settings.native) window.ide.nativeNotify('Build completed', '1 new review comment in workspace');
}

function markRead(href) { for (const e of events) if (e.href === href) e.read = true; store.set('events', events); renderEvents(); }

function renderEvents() {
  const log = $('#eventlog');
  log.innerHTML = '';
  for (const e of events) {
    const r = document.createElement('div');
    r.className = 'log-row' + (e.read ? ' read' : '');
    const d = new Date(e.t);
    r.innerHTML = `<time>${d.toLocaleDateString()} ${d.toLocaleTimeString()}</time><span class="lv">${e.read ? 'INFO' : 'WARN'}</span><span class="msg"></span>`;
    r.querySelector('.msg').textContent = boss ? 'Inspection results updated' : e.text;
    r.addEventListener('click', () => { if (e.href) { markRead(e.href); open(e.href, true); } });
    log.appendChild(r);
  }
  const unread = events.filter((e) => !e.read).length;
  $('#notif-badge').hidden = !unread;
  $('#notif-badge').textContent = unread;
}

function balloon(title, body, onClick) {
  const b = document.createElement('div');
  b.className = 'balloon';
  b.innerHTML = '<div class="bt"></div><div class="bb"></div>';
  b.querySelector('.bt').textContent = title;
  b.querySelector('.bb').textContent = body;
  b.addEventListener('click', () => { b.remove(); if (onClick) onClick(); });
  $('#balloons').appendChild(b);
  setTimeout(() => b.remove(), 8000);
}

// ---------------------------------------------------------------- boss mode
let boss = false;
$('#boss-code').innerHTML = window.highlightJava(window.FAKE_CODE);
$('#boss-gutter').textContent = window.FAKE_CODE.split('\n').map((_, i) => i + 1).join('\n');

function setBoss(on) {
  boss = on;
  $('#boss').hidden = !on;
  document.body.classList.toggle('boss', on);
  for (const t of tabs) mute(t);
  if (on) $('#balloons').innerHTML = '';
  $('#tabs').style.visibility = on ? 'hidden' : '';
  syncChrome();
  renderEvents();
}
window.ide.onBossToggle(() => setBoss(!boss));
$('#sb-boss').addEventListener('click', () => setBoss(!boss));
window.addEventListener('blur', () => { if (settings.blurBoss && !boss) setBoss(true); });

// ---------------------------------------------------------------- keys
let lastEsc = 0;
function handleKey(k) {
  if (k.key === 'SearchEverywhere' || (k.ctrl && !k.shift && k.key.toLowerCase() === 'n')) { seOpen(); return true; }
  if (se.open) return false;
  if (k.key === 'Escape') {
    const now = Date.now();
    if (now - lastEsc < 400) { setBoss(!boss); lastEsc = 0; } else lastEsc = now;
    return true;
  }
  if (k.ctrl && k.key.toLowerCase() === 'w') { if (active) closeTab(active); return true; }
  if (k.ctrl && k.key.toLowerCase() === 't') { newTab(HOME); return true; }
  if (k.ctrl && k.key.toLowerCase() === 'l') { $('#addr').focus(); $('#addr').select(); return true; }
  if (k.ctrl && k.key === 'Tab') { const i = tabs.indexOf(active); activateTab(tabs[(i + (k.shift ? -1 : 1) + tabs.length) % tabs.length]); return true; }
  if (k.alt && k.key === '1') { $('#toolwindow').classList.toggle('collapsed'); $('#split-left').hidden = $('#toolwindow').classList.contains('collapsed'); return true; }
  if (k.alt && k.key === 'ArrowLeft') { if (active && active.wv.canGoBack()) active.wv.goBack(); return true; }
  if (k.alt && k.key === 'ArrowRight') { if (active && active.wv.canGoForward()) active.wv.goForward(); return true; }
  if (k.key === 'F5' || (k.ctrl && k.key.toLowerCase() === 'r')) { if (active) active.wv.reload(); return true; }
  return false;
}
window.addEventListener('keydown', (e) => {
  if (e.target === $('#addr') && e.key !== 'Escape') return;
  if (handleKey({ key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })) e.preventDefault();
});

// ---------------------------------------------------------------- chrome wiring
$('#addr').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { navigate(e.target.value); e.target.blur(); }
  if (e.key === 'Escape') { e.target.value = active ? active.url : ''; e.target.blur(); }
});
$('#btn-back').onclick = () => active && active.wv.canGoBack() && active.wv.goBack();
$('#btn-fwd').onclick = () => active && active.wv.canGoForward() && active.wv.goForward();
$('#btn-reload').onclick = () => active && active.wv.reload();
$('#btn-home').onclick = () => open(HOME, false);
$('#btn-add-gall').onclick = addCurrentGallery;
$('#btn-collapse').onclick = () => handleKey({ key: '1', alt: true });
$('#btn-eventlog').onclick = () => { $('#bottom').hidden = !$('#bottom').hidden; };
$('#btn-hide-log').onclick = () => { $('#bottom').hidden = true; };
$('#btn-clear-log').onclick = () => { events = []; store.set('events', events); renderEvents(); };

document.querySelectorAll('.stripe.left [data-tw]').forEach((b) => b.addEventListener('click', () => {
  const which = b.dataset.tw;
  const tw = $('#toolwindow');
  if (b.classList.contains('active') && !tw.classList.contains('collapsed')) { tw.classList.add('collapsed'); $('#split-left').hidden = true; return; }
  tw.classList.remove('collapsed'); $('#split-left').hidden = false;
  document.querySelectorAll('.stripe.left [data-tw]').forEach((x) => x.classList.toggle('active', x === b));
  $('#tree').hidden = which !== 'project';
  $('#bookmarks').hidden = which !== 'bookmarks';
  $('#tw-title').textContent = which === 'project' ? 'Project' : 'Bookmarks';
}));

// splitter
(() => {
  const sp = $('#split-left'), tw = $('#toolwindow');
  tw.style.width = store.get('twWidth', 260) + 'px';
  sp.addEventListener('mousedown', (e) => {
    const startX = e.clientX, startW = tw.offsetWidth;
    document.querySelectorAll('webview').forEach((w) => (w.style.pointerEvents = 'none'));
    const move = (ev) => { tw.style.width = Math.max(140, Math.min(600, startW + ev.clientX - startX)) + 'px'; };
    const up = () => {
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      document.querySelectorAll('webview').forEach((w) => (w.style.pointerEvents = ''));
      store.set('twWidth', tw.offsetWidth);
    };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  });
})();

// settings dialog
const optMap = { 'opt-dim': 'dim', 'opt-blur-boss': 'blurBoss', 'opt-native': 'native', 'opt-mute': 'mute' };
$('#btn-settings').onclick = () => {
  for (const [id, k] of Object.entries(optMap)) $('#' + id).checked = !!settings[k];
  $('#settings').showModal();
};
$('#settings').addEventListener('close', () => {
  for (const [id, k] of Object.entries(optMap)) settings[k] = $('#' + id).checked;
  store.set('settings', settings);
  for (const t of tabs) { try { t.wv.send('settings', settings); } catch { /* not ready */ } mute(t); }
});

// webview methods throw until the guest has emitted dom-ready
function mute(t) { try { t.wv.setAudioMuted(boss || settings.mute); } catch { /* not ready yet; dom-ready handler applies it */ } }

window.ide.onOpenTab((url) => newTab(url));

// ---------------------------------------------------------------- Search Everywhere (gallery search)
const dcEncode = (s) => encodeURIComponent(s)
  .replace(/\./g, '%2E').replace(/~/g, '%7E').replace(/!/g, '%21').replace(/\*/g, '%2A')
  .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/'/g, '%27').replace(/%/g, '.');
const KIND_OF_TYPE = { M: 'mgallery', MI: 'mini' };
const TYPE_LABEL = { '': 'main', M: 'minor', MI: 'mini', PR: 'person' };
const se = { open: false, items: [], sel: 0, seq: 0, timer: 0 };

function seOpen() {
  if (se.open) { $('#se-q').select(); return; }
  se.open = true;
  $('#se-backdrop').hidden = false;
  const q = $('#se-q');
  q.value = '';
  seRender(seLocalItems(''), '');
  setTimeout(() => q.focus(), 0);
}
function seClose() {
  se.open = false;
  $('#se-backdrop').hidden = true;
  clearTimeout(se.timer);
  if (active) active.wv.focus();
}
function seLocalItems(q) {
  const seen = new Set();
  const out = [];
  for (const g of [...galleries, ...recent]) {
    if (seen.has(g.id)) continue;
    seen.add(g.id);
    if (q && !(g.id.toLowerCase().includes(q.toLowerCase()) || (g.name || '').includes(q))) continue;
    out.push({ id: g.id, name: g.name || g.id, type: g.kind === 'mgallery' ? 'M' : g.kind === 'mini' ? 'MI' : '', link: gallUrl(g), local: true });
  }
  return out;
}
function seSchedule() {
  clearTimeout(se.timer);
  const q = $('#se-q').value.trim();
  if (!q) { $('#se-spin').hidden = true; seRender(seLocalItems(''), ''); return; }
  seRender(seLocalItems(q), q, true);
  se.timer = setTimeout(async () => {
    const my = ++se.seq;
    $('#se-spin').hidden = false;
    let remote = [];
    try { remote = await window.ide.searchGalleries(q); } catch { remote = []; }
    if (my !== se.seq || !se.open) return;
    $('#se-spin').hidden = true;
    const local = seLocalItems(q);
    const ids = new Set(local.map((x) => x.id));
    const all = $('#se-all').checked ? [...local, ...remote.filter((r) => !ids.has(r.id))] : local;
    seRender(all, q);
  }, 200);
}
function highlight(text, q) {
  const t = escapeHtml(text);
  if (!q) return t;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t;
  return escapeHtml(text.slice(0, i)) + '<b>' + escapeHtml(text.slice(i, i + q.length)) + '</b>' + escapeHtml(text.slice(i + q.length));
}
function seRender(items, q, pending = false) {
  se.items = items.slice(0, 40);
  if (q) se.items.push({ find: true, q });
  se.sel = 0;
  const list = $('#se-list');
  list.innerHTML = '';
  const group = document.createElement('div');
  group.className = 'se-group';
  group.textContent = q ? 'Classes' : 'Recent modules';
  list.appendChild(group);
  if (!items.length) {
    const e = document.createElement('div');
    e.className = 'se-empty';
    e.textContent = pending ? 'Searching…' : q ? 'Nothing found in project. Showing index results…' : 'No recent modules. Type a name to search.';
    if (q && !pending) e.textContent = 'Nothing found.';
    list.appendChild(e);
  }
  se.items.forEach((it, i) => {
    const r = document.createElement('div');
    r.className = 'se-row';
    if (it.find) {
      r.innerHTML = `<span class="ico find">⌕</span><span class="cls">Find in Files: “${escapeHtml(it.q)}”</span><span class="pkg">full-text search</span>`;
    } else {
      const cls = pascal(it.id) + 'Repository';
      const t = it.type || '';
      r.innerHTML =
        `<span class="ico">C</span><span class="cls">${highlight(cls, q)}</span>` +
        `<span class="pkg">${highlight(it.name || '', q)}</span>` +
        `<span class="mod">${it.newPost ? `<span>+${it.newPost}</span>` : ''}${it.rank ? `<span>#${it.rank}</span>` : ''}` +
        `<span class="tag ${t}">${TYPE_LABEL[t] || t.toLowerCase()}</span>${it.local ? '<span>★</span>' : ''}</span>`;
    }
    r.addEventListener('mousemove', () => seSelect(i));
    r.addEventListener('click', (e) => seActivate(i, e.ctrlKey ? 'tab' : e.altKey ? 'add' : 'open'));
    list.appendChild(r);
  });
  $('#se-count').textContent = items.length ? `${items.length} ${items.length === 1 ? 'class' : 'classes'}` : '';
  seSelect(0);
}
function seSelect(i) {
  se.sel = Math.max(0, Math.min(i, se.items.length - 1));
  document.querySelectorAll('#se-list .se-row').forEach((r, j) => r.classList.toggle('sel', j === se.sel));
  const row = document.querySelectorAll('#se-list .se-row')[se.sel];
  if (row) row.scrollIntoView({ block: 'nearest' });
}
function seActivate(i, how) {
  const it = se.items[i];
  if (!it) return;
  if (it.find) {
    seClose();
    open(`https://search.dcinside.com/combine/q/${dcEncode(it.q)}`, how === 'tab');
    return;
  }
  if (how === 'add') {
    const g = parseGall(it.link);
    if (g && !galleries.some((x) => x.id === g.id)) {
      galleries.push({ id: g.id, kind: g.kind, name: it.name || g.id });
      store.set('galleries', galleries);
      renderTree();
    }
    balloon('Module added', `${pascal(it.id)}Repository`);
    seRender(seLocalItems($('#se-q').value.trim()), $('#se-q').value.trim());
    return;
  }
  seClose();
  open(it.link, how === 'tab');
}
$('#se-q').addEventListener('input', seSchedule);
$('#se-all').addEventListener('change', seSchedule);
$('#se-q').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { seSelect(se.sel + 1); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { seSelect(se.sel - 1); e.preventDefault(); }
  else if (e.key === 'Enter') { seActivate(se.sel, e.altKey ? 'add' : (e.ctrlKey || e.shiftKey) ? 'tab' : 'open'); e.preventDefault(); }
  else if (e.key === 'Escape') { seClose(); e.preventDefault(); }
  e.stopPropagation();
});
$('#se-backdrop').addEventListener('mousedown', (e) => { if (e.target.id === 'se-backdrop') seClose(); });
$('#btn-search').addEventListener('click', seOpen);

// double Shift (IntelliJ "Search Everywhere") in the IDE chrome itself
let lastShift = 0;
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Shift') { lastShift = 0; return; }
  if (e.repeat || se.open) return;
  const now = Date.now();
  if (now - lastShift < 400) { lastShift = 0; seOpen(); } else lastShift = now;
}, true);

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------------------------------------------------------------- boot
// Always start on login → my gallog; tabs from the last session are reopened behind it.
newTab(startUrl(), true);
const openTabs = (store.get('openTabs', null) || [])
  .filter((u) => !/^https:\/\/(gallog|sign|sso)\.dcinside\.com\//.test(u));
openTabs.forEach((u) => newTab(u, false));
function saveTabs() { store.set('openTabs', tabs.map((t) => t.url)); }
window.addEventListener('beforeunload', saveTabs);
renderEvents();
