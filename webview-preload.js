// Runs inside every dcinside <webview> (sandboxed, isolated world).
const { ipcRenderer } = require('electron');

const CSS = ipcRenderer.sendSync('get-skin-css');

// ---- 1. inject the skin as early as possible to avoid a flash of the original theme
function injectSkin() {
  if (document.getElementById('__ide_skin')) return true;
  const root = document.head || document.documentElement;
  if (!root) return false;
  const s = document.createElement('style');
  s.id = '__ide_skin';
  s.textContent = CSS;
  root.appendChild(s);
  return true;
}
if (!injectSkin()) {
  const mo = new MutationObserver(() => { if (injectSkin()) mo.disconnect(); });
  mo.observe(document, { childList: true, subtree: true });
}
// some pages rebuild <head>; re-check once the DOM is ready
document.addEventListener('DOMContentLoaded', injectSkin);

// ---- 2. settings from the host (dim images etc.)
// Dimming lives in its own <style> so the page resetting <html class> can't undo it.
const DIM_CSS = `
img, video, .write_div iframe, .img_box, .thumb_img {
  opacity: .1 !important; filter: grayscale(1) !important; transition: opacity .15s, filter .15s !important; }
img:hover, video:hover, .write_div iframe:hover, a:hover img, .img_box:hover, .thumb_img:hover {
  opacity: 1 !important; filter: none !important; }
.sp_img img, .icon_img img, img[width="12"], img[width="14"], img[height="12"], img.written_dccon:hover { opacity: .8 !important; }`;
let settings = null;
function applySettings() {
  if (!settings || !document.documentElement) return;
  let s = document.getElementById('__ide_dim');
  if (settings.dim && !s) {
    s = document.createElement('style');
    s.id = '__ide_dim';
    s.textContent = DIM_CSS;
    (document.head || document.documentElement).appendChild(s);
  } else if (!settings.dim && s) {
    s.remove();
  }
}
ipcRenderer.on('settings', (_e, s) => { settings = s || {}; applySettings(); });
ipcRenderer.sendToHost('need-settings');
document.addEventListener('DOMContentLoaded', applySettings);

// ---- 3. capture the site's own alarm pop-ups (comment / reply alerts on my posts)
// dcinside polls /ajax/alarm_ajax/polling every ~60s and renders results into
// .alarmPopup as .one_notice_txt items. We forward them to the IDE and hide the original.
const seen = new Set();
function harvest(root) {
  const box = root.closest ? root.closest('.alarmPopup') : null;
  const scope = box || document.querySelector('.alarmPopup');
  if (!scope) return;
  scope.querySelectorAll('.one_notice_txt').forEach((n) => {
    const text = (n.textContent || '').replace(/\s+/g, ' ').replace(/^NEW\s*/, '').trim();
    const href = n.href || '';
    const key = text + '|' + href;
    if (!text || seen.has(key)) return;
    seen.add(key);
    ipcRenderer.sendToHost('alarm', { text, href });
  });
}
function watchAlarms() {
  const box = document.querySelector('.alarmPopup');
  if (box) {
    harvest(box);
    new MutationObserver(() => harvest(box)).observe(box, { childList: true, subtree: true });
  }
  // the dcinside main page appends alarm boxes directly to <body>
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType === 1 && (n.matches('.alarmPopup, .one_noticewrap') || n.querySelector('.one_notice_txt'))) {
        n.querySelectorAll('.one_notice_txt').forEach((x) => {
          const text = (x.textContent || '').replace(/\s+/g, ' ').replace(/^NEW\s*/, '').trim();
          const key = text + '|' + (x.href || '');
          if (text && !seen.has(key) && !x.closest('.rtbAlarmPopup')) { seen.add(key); ipcRenderer.sendToHost('alarm', { text, href: x.href || '' }); }
        });
      }
    }
  }).observe(document.body, { childList: true });
}

// ---- 4. metadata for the tree (real gallery name shown only as tooltip)
function sendMeta() {
  const el = document.querySelector('.page_head .fl h2 a, .page_head h2 a, .gall_tit_wrap h2 a');
  const name = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  if (name) ipcRenderer.sendToHost('meta', { galleryName: name });
}

// ---- 4b. gallery list → Git Log: rewrite the texts CSS can't change
const LABELS = {
  '전체글': 'All commits', '개념글': 'Starred', '공지': 'Pinned', '동영상': 'Media',
  '글쓰기': 'Commit…', '추천': 'Star', '갤러리 설정': 'Settings',
};
const shortHash = (n) => {
  // stable fake commit hash from the post number
  let h = (Number(n) * 2654435761) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0;
  return h.toString(16).padStart(8, '0').slice(0, 7);
};
const pad = (n) => String(n).padStart(2, '0');
function fmtDate(td) {
  const full = td.getAttribute('title') || '';           // "2026-11-06 15:49:54"
  const m = full.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/);
  if (!m) return null;
  const now = new Date();
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((today - d) / 864e5);
  if (diff === 0) return `Today ${m[4]}:${m[5]}`;
  if (diff === 1) return `Yesterday ${m[4]}:${m[5]}`;
  return `${m[1]}.${m[2]}.${m[3]}, ${m[4]}:${m[5]}`;
}

// ---- commit graph: lanes that fork and merge, drawn as one SVG per row.
// Deterministic per page (seeded from the first post number) so it doesn't change on re-render.
const GRAPH_COLORS = ['#5fb865', '#56a8f5', '#c77dbb', '#e5c07b', '#2aacb8', '#e06c75', '#a68cf0'];
const ROW_H = 26, MID = 13, LANE_W = 12, MAX_LANES = 5, GRAPH_W = 8 + LANE_W * MAX_LANES;
const laneX = (i) => 8 + i * LANE_W;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function drawGraph(table) {
  const rows = [...table.querySelectorAll('tbody tr')]
    .filter((tr) => !tr.classList.contains('ide-pinned') && !tr.classList.contains('ide-ad'));
  if (!rows.length || rows[0].querySelector('td.ide-graph')) return;

  const rand = rng(Number(rows[0].dataset.no) || 7);
  let colorSeq = 0;
  const newLane = () => ({ color: GRAPH_COLORS[colorSeq++ % GRAPH_COLORS.length] });
  // start with a main line plus 1–2 feature branches already in flight
  let lanes = [newLane()];
  for (let i = 0, n = 1 + Math.floor(rand() * 2); i < n; i++) lanes.push(newLane());

  const NS = 'http://www.w3.org/2000/svg';
  const curve = (x1, y1, x2, y2) => `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;

  for (const tr of rows) {
    const top = lanes.slice();
    // which lane gets this commit: mostly main / recent branches
    const r = rand();
    const cIdx = r < 0.35 ? 0 : Math.min(top.length - 1, Math.floor(rand() * top.length));
    const commit = top[cIdx];

    // keep ~2-4 lanes alive: merge more when crowded, fork more when sparse
    const n = top.length;
    const pMerge = [0, 0, 0.1, 0.18, 0.3, 0.45][n] ?? 0.45;
    const pFork = [0, 0.55, 0.3, 0.16, 0.06, 0][n] ?? 0;

    // merge: another lane ends in this commit
    let merged = null;
    if (n > 1 && rand() < pMerge) {
      const others = top.filter((l) => l !== commit);
      merged = others[Math.floor(rand() * others.length)];
    }
    let bottom = top.filter((l) => l !== merged);
    // fork: a new branch starts from this commit (git log is newest-first, so it "opens" below)
    let forked = null;
    if (!merged && bottom.length < MAX_LANES && rand() < pFork) {
      forked = newLane();
      bottom = bottom.concat(forked);
    }

    const xc = laneX(cIdx);
    const paths = [];
    for (const l of top) {
      const xt = laneX(top.indexOf(l));
      if (l === merged) paths.push([curve(xt, 0, xc, MID), l.color]);
      else if (l === commit) paths.push([`M${xt} 0 L${xc} ${MID}`, l.color]);
      else paths.push([curve(xt, 0, laneX(bottom.indexOf(l)), ROW_H), l.color]);
    }
    paths.push([curve(xc, MID, laneX(bottom.indexOf(commit)), ROW_H), commit.color]);
    if (forked) paths.push([curve(xc, MID, laneX(bottom.indexOf(forked)), ROW_H), forked.color]);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', GRAPH_W);
    svg.setAttribute('height', ROW_H);
    svg.setAttribute('viewBox', `0 0 ${GRAPH_W} ${ROW_H}`);
    for (const [d, color] of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('stroke', color);
      p.setAttribute('stroke-width', '2');
      p.setAttribute('fill', 'none');
      svg.appendChild(p);
    }
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', xc); dot.setAttribute('cy', MID); dot.setAttribute('r', merged ? 4.5 : 4);
    dot.setAttribute('fill', merged ? '#1e1f22' : commit.color);
    dot.setAttribute('stroke', commit.color); dot.setAttribute('stroke-width', merged ? 2 : 0);
    svg.appendChild(dot);

    const td = document.createElement('td');
    td.className = 'ide-graph';
    td.appendChild(svg);
    tr.insertBefore(td, tr.firstChild);
    lanes = bottom;
  }
}

function disguiseList() {
  const table = document.querySelector('table.gall_list');
  if (!table) return;
  for (const tr of table.querySelectorAll('tbody tr')) {
    if (tr.dataset.ide) continue;
    tr.dataset.ide = '1';
    const num = tr.querySelector('td.gall_num');
    const raw = num ? num.textContent.trim() : '';
    if (/^\d+$/.test(raw)) {
      num.textContent = shortHash(raw);
      num.title = raw;
    } else if (raw === '공지' || tr.dataset.type === 'icon_notice') {
      tr.classList.add('ide-pinned');
    } else {
      tr.classList.add('ide-ad');                         // AD, 설문, etc.
    }
    // minor galleries mark notices with a numbered row + "공지" subject head
    const subj = tr.querySelector('td.gall_subject');
    if (subj && subj.textContent.trim() === '공지') tr.classList.add('ide-pinned');
    const date = tr.querySelector('td.gall_date');
    const f = date && fmtDate(date);
    if (f) date.textContent = f;
    const rn = tr.querySelector('.reply_num');
    if (rn) rn.textContent = rn.textContent.replace(/\[(\d+)(?:\/(\d+))?\]/, (_, a) => `(#${a})`);
  }
  // On the "공지" tab, show pinned rows (otherwise they'd all be hidden)
  const onNotice = /exception_mode=notice/.test(location.search);
  if (onNotice) table.querySelectorAll('tr.ide-pinned').forEach((tr) => tr.classList.remove('ide-pinned'));

  drawGraph(table);

  // tab / button labels
  document.querySelectorAll('.list_array_option button, .list_array_option a, .list_bottom_btnbox button, .list_bottom_btnbox a, .btn_write')
    .forEach((el) => {
      if (el.children.length && !el.classList.contains('btn_write')) return;
      const t = el.textContent.trim();
      if (LABELS[t]) { el.title = t; el.textContent = LABELS[t]; }
    });
  document.querySelectorAll('.select_area a').forEach((a) => {
    const n = a.firstChild;
    if (n && n.nodeType === 3) n.textContent = n.textContent.replace('개', ' rows');
  });

  // header: "프로그래밍 갤러리" → "Log: origin/programming"
  const h = document.querySelector('.page_head h2 a');
  if (h && !h.dataset.ide) {
    h.dataset.ide = '1';
    const id = new URLSearchParams(location.search).get('id') || 'main';
    h.title = h.textContent.trim();
    h.textContent = `Log: origin/${id}`;
  }
}

// ---- 4c. post view → commit details + code review
const VIEW_LABELS = {
  '전체 댓글': 'Review comments', '등록순': 'Oldest', '최신순': 'Newest', '답글순': 'Threads',
  '등록': 'Comment', '등록+추천': 'Comment & approve', '디시콘': 'Emoji', '글자콘': 'Snippets',
  '삭제': 'Delete', '수정': 'Amend', '답글': 'Reply', '본문 보기': 'Back to top',
  '댓글닫기': 'Collapse', '댓글 등록': 'Add comment', '새로고침': 'Refresh', '전체글': 'All commits', '개념글': 'Starred',
  '글쓰기': 'Commit…', '목록': 'Log', '이전글': 'Prev', '다음글': 'Next',
};

function relabel(root, map) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const hits = [];
  for (let n; (n = walker.nextNode());) {
    const t = n.nodeValue.trim();
    if (t && map[t]) hits.push(n);
  }
  for (const n of hits) {
    const t = n.nodeValue.trim();
    if (n.parentElement && !n.parentElement.title) n.parentElement.title = t;
    n.nodeValue = n.nodeValue.replace(t, map[t]);
  }
}


function disguiseComments() {
  const box = document.querySelector('.view_comment');
  if (!box) return;
  box.querySelectorAll('.cmt_list li.ub-content, .reply_list li.ub-content').forEach((li) => {
    if (li.dataset.ide) return;
    li.dataset.ide = '1';
    const dt = li.querySelector('.date_time');
    if (dt) dt.textContent = dt.textContent.replace(/^(\d\d)\.(\d\d) (\d\d:\d\d):\d\d$/, '$1/$2 $3');
  });
  // the "전체 댓글 12개" header: drop the trailing "개"
  const nb = box.querySelector('.comment_count .num_box');
  if (nb) for (const n of nb.childNodes) if (n.nodeType === 3 && n.nodeValue.trim() === '개') n.nodeValue = '';
  relabel(box, VIEW_LABELS);
  const ta = box.querySelector('.cmt_write textarea');
  if (ta && !ta.placeholder) ta.placeholder = 'Leave a review comment…  (Shift+Enter: new line)';
  box.querySelectorAll('input[placeholder="닉네임"]').forEach((i) => (i.placeholder = 'Author'));
  box.querySelectorAll('input[placeholder="비밀번호"]').forEach((i) => (i.placeholder = 'Password'));
}

function disguiseView() {
  const head = document.querySelector('.gallview_head');
  if (!head || head.dataset.ide) return;
  head.dataset.ide = '1';
  const p = new URLSearchParams(location.search);
  const no = p.get('no') || '0';
  const id = p.get('id') || 'main';

  // "commit 3ec6845d…  origin/programming"
  const meta = document.createElement('div');
  meta.className = 'ide-commit-meta';
  const full = shortHash(no) + shortHash(Number(no) + 7919) + shortHash(Number(no) + 104729);
  meta.innerHTML = '<span class="k">commit</span> <span class="h"></span> <span class="ref"></span>';
  meta.querySelector('.h').textContent = full.slice(0, 20);
  meta.querySelector('.h').title = 'No. ' + no;
  meta.querySelector('.ref').textContent = 'origin/' + id;
  head.insertBefore(meta, head.firstChild);

  // Author / Date lines
  const writer = head.querySelector('.gall_writer');
  if (writer) {
    const d = writer.querySelector('.gall_date');
    if (d) d.textContent = 'Date: ' + (d.getAttribute('title') || d.textContent).replace(/\./g, '-').replace(/:\d\d$/, '');
    // stats: 조회 183 / 추천 0 / 댓글 12 → +183  ★0  12 comments
    const swap = (sel, re, fmt) => {
      const el = writer.querySelector(sel);
      if (!el) return;
      const target = el.querySelector('a') || el;
      const m = target.textContent.match(re);
      if (m) { el.title = target.textContent.trim(); target.textContent = fmt(m[1]); }
    };
    swap('.gall_count', /(\d[\d,]*)/, (n) => `+${n}`);
    swap('.gall_reply_num', /(\d[\d,]*)/, (n) => `★ ${n}`);
    swap('.gall_comment', /(\d[\d,]*)/, (n) => `${n} comments`);
  }

  const bottom = document.querySelector('.view_bottom_btnbox');
  if (bottom) relabel(bottom, VIEW_LABELS);

  disguiseComments();
  const cbox = document.querySelector('.view_comment');
  if (cbox) {
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; disguiseComments(); });
    }).observe(cbox, { childList: true, subtree: true });
  }
}

// ---- 4d. login page → IDE "GitLab 계정" dialog
// Re-arranges the real form controls (same inputs, same submit) inside an IDE-style dialog.
function disguiseLogin() {
  if (!/sign\.dcinside\.com$/.test(location.hostname) || !/^\/login/.test(location.pathname)) return;
  const form = document.querySelector('form[name="login"]');
  const id = document.getElementById('id');
  const pw = document.getElementById('pw');
  const submit = form && form.querySelector('button[type="submit"]');
  if (!form || !id || !pw || !submit || form.querySelector('.ide-dialog')) return;

  const dlg = document.createElement('div');
  dlg.className = 'ide-dialog';
  dlg.innerHTML = `
    <div class="ide-dlg-title"><span class="ide-dlg-logo">IJ</span><span>GitLab 계정 로그인</span><button type="button" class="ide-dlg-x" title="닫기">✕</button></div>
    <div class="ide-dlg-body">
      <label class="ide-dlg-label">서버:</label>
      <div class="ide-dlg-field"><input class="ide-dlg-server" value="https://gitlab.workspace.dev" disabled></div>
      <label class="ide-dlg-label" for="id">사용자:</label>
      <div class="ide-dlg-field" data-slot="id"></div>
      <label class="ide-dlg-label" for="pw">토큰:</label>
      <div class="ide-dlg-field ide-dlg-row" data-slot="pw"><button type="button" class="ide-dlg-btn ide-dlg-gen">생성...</button></div>
      <div></div>
      <div class="ide-dlg-hint">액세스 토큰에 다음 범위가 허가되어야 합니다. [api, read_user]</div>
      <div></div>
      <div class="ide-dlg-field" data-slot="save"></div>
    </div>
    <div class="ide-dlg-footer" data-slot="buttons"><button type="button" class="ide-dlg-btn ide-dlg-cancel">취소</button></div>`;

  const slot = (n) => dlg.querySelector(`[data-slot="${n}"]`);
  id.placeholder = '';
  pw.placeholder = '';
  slot('id').appendChild(id);
  slot('pw').insertBefore(pw, slot('pw').firstChild);
  const save = form.querySelector('#checksaveid')?.closest('.checkbox');
  if (save) {
    const lbl = save.querySelector('label');
    if (lbl) lbl.textContent = '사용자 이름 기억';
    slot('save').appendChild(save);
  }
  submit.textContent = '로그인';
  submit.className = 'ide-dlg-btn ide-dlg-primary';
  slot('buttons').insertBefore(submit, slot('buttons').firstChild);

  const leave = () => {
    const back = new URLSearchParams(location.search).get('s_url');
    let u = 'https://gall.dcinside.com/';
    try { if (back && /^https:\/\/([a-z0-9-]+\.)*dcinside\.com\//.test(decodeURIComponent(back))) u = decodeURIComponent(back); } catch { /* keep default */ }
    // login started from the app's launch screen returns to a gallog; cancelling goes to the main page instead
    if (/^https:\/\/gallog\.dcinside\.com\//.test(u)) u = 'https://gall.dcinside.com/';
    location.href = u;
  };
  dlg.querySelector('.ide-dlg-cancel').addEventListener('click', leave);
  dlg.querySelector('.ide-dlg-x').addEventListener('click', leave);
  // "생성..." → 비밀번호 찾기 (only account-recovery link kept)
  dlg.querySelector('.ide-dlg-gen').addEventListener('click', () => { location.href = 'https://sign.dcinside.com/myinfo/reset_pwd'; });
  dlg.querySelector('.ide-dlg-gen').title = '비밀번호 찾기';

  form.insertBefore(dlg, form.querySelector('fieldset') || form.firstChild);
  document.documentElement.classList.add('ide-login');
  document.title = 'GitLab 계정 로그인';
  setTimeout(() => id.focus(), 50);
}

// ---- 4e. right-side account box (gallery pages) → "GitLab account" panel
const ACCOUNT_LABELS = {
  '로그아웃': 'Log out', '로그인': 'Sign in', '로그인해 주세요.': 'Sign in to GitLab…',
  '갤로그': 'Profile', '즐겨찾기': 'Favorites', '운영': 'Admin', '스크랩': 'Stash', '알림': 'Notifications',
  '고정닉 신청': 'Register', '글': 'Commits', '댓글': 'Comments', '방명록': 'Discussions',
};
function stripHonorific(root) {
  // "99님" → "99". The 님 may sit in its own text node or element, so find the deepest
  // element whose whole text is "<nick>님" and clean the text nodes inside it.
  // Returns { nick, el } or null.
  const cands = [...root.querySelectorAll('*')].filter((e) => /^\s*\S.{0,30}?\s*님\s*$/.test(e.textContent));
  const el = cands.find((e) => ![...e.children].some((c) => cands.includes(c)));
  if (!el) return null;
  const nick = el.textContent.trim().replace(/\s*님$/, '').trim();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n; (n = walker.nextNode());) nodes.push(n);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!n.nodeValue.trim()) continue;
    if (n.nodeValue.trim() === '님') { n.nodeValue = ''; break; }
    if (/님\s*$/.test(n.nodeValue)) { n.nodeValue = n.nodeValue.replace(/\s*님(\s*)$/, '$1'); break; }
    break;
  }
  return { nick, el };
}
function dropSeparators(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const seps = [];
  for (let n; (n = walker.nextNode());) if (/^\s*[|ㅣ]\s*$/.test(n.nodeValue)) seps.push(n);
  seps.forEach((n) => { n.nodeValue = ' '; });
}
function disguiseAccountBox() {
  const box = document.getElementById('login_box');
  if (!box || box.dataset.ide) return;
  box.dataset.ide = '1';
  const found = stripHonorific(box);
  dropSeparators(box);
  relabel(box, ACCOUNT_LABELS);
  const head = document.createElement('div');
  head.className = 'ide-account-head';
  head.innerHTML = '<span class="ide-account-title">GitLab</span><span class="ide-account-host">gitlab.workspace.dev</span>';
  box.insertBefore(head, box.firstChild);
  if (found) {
    // keep the site's own nickname element (it opens the user menu)
    found.el.classList.add('ide-nick-host');
    box.classList.add('ide-logged-in');
  }
  // remember "my gallog" so the next launch can return there right after login
  for (const el of box.querySelectorAll('a, button')) {
    const src = (el.getAttribute('href') || '') + ' ' + (el.getAttribute('onclick') || '');
    const m = src.match(/(?:https?:)?\/\/gallog\.dcinside\.com\/([A-Za-z0-9_]+)/);
    if (m) { ipcRenderer.sendToHost('meta', { myGallog: `https://gallog.dcinside.com/${m[1]}` }); break; }
  }
}

// ---- 4f. gallog (profile) → IDE account / activity view
const GALLOG_LABELS = {
  '홈': 'Overview', '게시물': 'Commits', '댓글': 'Review comments', '스크랩': 'Stash', '방명록': 'Discussions',
  '전체': 'All', '갤러리': 'Main', '마이너갤': 'Minor', '미니갤': 'Mini', '인물갤': 'Person',
  '일부공개': 'partial', '비공개': 'private', '전체공개': 'public', '공개': 'public', '전체 보기': 'All',
  '게시물이 없습니다.': 'No commits.', '댓글이 없습니다.': 'No comments.', '스크랩에 글이 없습니다.': 'Stash is empty.',
  '방명록이 없습니다.': 'No discussions.', '더보기': 'More', '삭제': 'Delete', '수정': 'Edit', '등록': 'Post',
};
// Each gallog list item → one table-like row: message | gallery (as ref label) | date.
// Original nodes are kept (links, checkboxes, delete buttons keep working); only classes/text change.
function normalizeGallogRows() {
  document.querySelectorAll('.gallog_cont .cont_listbox > li').forEach((li) => {
    if (li.dataset.ide) return;
    li.dataset.ide = '1';
    const tit = li.querySelector('.galltit');
    const meta = li.querySelector('.nameday');
    if (!tit) return;
    tit.parentElement.classList.add('ide-rowbox');
    tit.classList.add('ide-col-msg');
    if (meta) {
      meta.classList.add('ide-col-meta');
      dropSeparators(meta);
      // first text-bearing child of meta = gallery name → ref label
      const parts = [...meta.querySelectorAll('*')].filter((e) => !e.children.length && e.textContent.trim());
      const date = parts.find((e) => /^\d{4}\.\d\d\.\d\d/.test(e.textContent.trim()));
      if (date) date.classList.add('ide-col-date');
      const gal = parts.find((e) => e !== date && !e.closest('.writer_nikcon'));
      if (gal && !li.closest('.gstbook')) gal.classList.add('ide-ref');
    }
    // " - dc App" suffix on comments written from the app
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      if (/\s-\s*dc\s*App\s*$/i.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/\s-\s*dc\s*App\s*$/i, '');
    }
    // remaining blocks in the row (e.g. the parent post title on comments) → dim trailing column
    [...tit.parentElement.children].forEach((c) => {
      if (c !== tit && c !== meta) c.classList.add('ide-col-extra');
    });
  });
}

function disguiseGallog() {
  if (!/gallog\.dcinside\.com$/.test(location.hostname)) return;
  const wrap = document.querySelector('.gallog_wrap');
  if (!wrap || wrap.dataset.ide) return;
  wrap.dataset.ide = '1';
  const nickEl = document.querySelector('.galler_info .nick_name');
  const nick = nickEl ? nickEl.textContent.trim() : '';
  const info = document.querySelector('.galler_info');
  if (info) {
    for (const n of info.childNodes) if (n.nodeType === 3 && /갤로그/.test(n.nodeValue)) n.nodeValue = '';
    const sub = document.createElement('div');
    sub.className = 'ide-profile-sub';
    sub.textContent = '@' + (location.pathname.split('/')[1] || 'user') + ' · gitlab.workspace.dev';
    info.appendChild(sub);
  }
  relabel(document.querySelector('#container') || document.body, GALLOG_LABELS);
  normalizeGallogRows();
  const lists = document.querySelector('.wrap_right');
  if (lists) {
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; normalizeGallogRows(); });
    }).observe(lists, { childList: true, subtree: true });
  }
  document.querySelectorAll('input[placeholder*="검색"]').forEach((i) => (i.placeholder = 'Search commits…'));
  document.querySelectorAll('input[placeholder="닉네임"]').forEach((i) => (i.placeholder = 'Author'));
  document.querySelectorAll('input[placeholder="비밀번호"]').forEach((i) => (i.placeholder = 'Password'));
  document.title = (nick || 'Profile') + ' – GitLab';
}

// ---- 5. forward IDE shortcuts that would otherwise be swallowed by the page
let lastShift = 0;
window.addEventListener('keydown', (e) => {
  // double Shift → Search Everywhere (any other key in between cancels, so typing capitals is safe)
  if (e.key === 'Shift') {
    if (!e.repeat) {
      const now = Date.now();
      if (now - lastShift < 400) { lastShift = 0; ipcRenderer.sendToHost('key', { key: 'SearchEverywhere' }); }
      else lastShift = now;
    }
    return;
  }
  lastShift = 0;
  const k = e.key;
  const forward =
    k === 'Escape' || k === 'F5' ||
    (e.ctrlKey && /^(w|t|l|r|n|Tab)$/i.test(k)) ||
    (e.altKey && /^(1|ArrowLeft|ArrowRight)$/.test(k));
  if (!forward) return;
  ipcRenderer.sendToHost('key', { key: k, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });
  if (k !== 'Escape') { e.preventDefault(); e.stopPropagation(); }
}, true);

document.addEventListener('DOMContentLoaded', () => {
  injectSkin();
  watchAlarms();
  sendMeta();          // must read the real gallery name before disguiseList() renames it
  disguiseList();
  disguiseView();
  disguiseLogin();
  disguiseAccountBox();
  disguiseGallog();
  const tbody = document.querySelector('table.gall_list tbody');
  if (tbody) new MutationObserver(disguiseList).observe(tbody, { childList: true });
});
