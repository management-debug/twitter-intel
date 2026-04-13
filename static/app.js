/* ═══════════════════════════════════════════════════════════════════
   Twitter Intel Dashboard — app.js v1
   SPA logic: Auth, Tabs, API, Creators, Viral Posts, Strategy
═══════════════════════════════════════════════════════════════════ */

'use strict';

// ─── Constants ──────────────────────────────────────────────────────
const API = '';  // same origin
const CACHE_TTL = 60_000; // 60s
const POLL_INTERVAL = 2000;

// ─── State ──────────────────────────────────────────────────────────
const state = {
  token:      localStorage.getItem('twi_token') || null,
  role:       localStorage.getItem('twi_role')  || null,
  activeTab:  localStorage.getItem('twi_tab')   || 'dashboard',
  cache:      new Map(),       // key → {data, ts}
  pollTimer:  null,
  // pagination state per media tab
  pages: { photos: 1, videos: 1, text: 1 },
  // current creator detail
  activeCreator: null,
  activeCreatorType: 'all',
};

// ─── Utility functions ──────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  n = Number(n);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const now = new Date();
  const diff = now - d;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function fmtDuration(secs) {
  if (!secs) return '—';
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => toast('Copied!', 'success')).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.style.cssText = 'position:fixed;opacity:0;';
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
  toast('Copied!', 'success');
}

function multClass(mult) {
  if (!mult || mult < 1.5) return '';
  if (mult < 3)   return 'low';
  if (mult < 5)   return 'mid';
  if (mult < 10)  return 'high';
  return 'ultra';
}

function multLabel(mult) {
  if (!mult || mult < 1.5) return '';
  return `${mult.toFixed(1)}x`;
}

// ─── Cache helpers ──────────────────────────────────────────────────
function cacheGet(key) {
  const entry = state.cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { state.cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  state.cache.set(key, { data, ts: Date.now() });
}

function cacheClear(prefix = '') {
  if (!prefix) { state.cache.clear(); return; }
  for (const k of state.cache.keys()) {
    if (k.startsWith(prefix)) state.cache.delete(k);
  }
}

// ─── Toast ──────────────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ'}</span><span>${escHtml(msg)}</span>`;
  $('#toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove());
  }, duration);
}

// ─── API helpers ────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  const res = await fetch(API + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  if (res.status === 401) { logout(); return null; }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

async function apiGet(path, cacheKey = null) {
  if (cacheKey) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }
  const data = await apiFetch(path);
  if (cacheKey && data) cacheSet(cacheKey, data);
  return data;
}

async function apiPost(path, body = null) {
  return apiFetch(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

async function apiDelete(path) {
  return apiFetch(path, { method: 'DELETE' });
}

// ─── Auth ────────────────────────────────────────────────────────────
async function login() {
  const email    = $('#login-email').value.trim();
  const password = $('#login-password').value;
  const errEl    = $('#login-error');
  const btn      = $('#login-btn');

  if (!email || !password) { showError(errEl, 'Please fill in all fields.'); return; }

  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errEl.classList.add('hidden');

  try {
    const data = await apiPost('/api/auth/login', { email, password });
    if (!data) return;
    state.token = data.token;
    state.role  = data.role;
    localStorage.setItem('twi_token', state.token);
    localStorage.setItem('twi_role',  state.role);
    initApp();
  } catch (err) {
    showError(errEl, err.message || 'Invalid credentials');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function logout() {
  state.token = null;
  state.role  = null;
  localStorage.removeItem('twi_token');
  localStorage.removeItem('twi_role');
  stopPolling();
  $('#app').classList.add('hidden');
  $('#app').classList.remove('active');
  const lm = $('#login-modal');
  lm.classList.add('active');
  lm.classList.remove('hidden');
  $('#login-password').value = '';
}

// ─── App Init ────────────────────────────────────────────────────────
function initApp() {
  // Hide login, show app
  $('#login-modal').classList.remove('active');
  $('#login-modal').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#app').classList.add('active');

  // Apply role
  if (state.role === 'admin') {
    document.body.classList.add('is-admin');
    $('#nav-role-badge').textContent = 'Admin';
    $('#nav-role-badge').className = 'role-badge admin';
  } else {
    document.body.classList.remove('is-admin');
    $('#nav-role-badge').textContent = 'Worker';
    $('#nav-role-badge').className = 'role-badge worker';
  }

  // Navigate to active tab
  const hash = location.hash.replace('#', '') || state.activeTab;
  navigateTo(hash, false);
}

// ─── Tab Navigation ──────────────────────────────────────────────────
function navigateTo(tab, pushState = true) {
  const validTabs = ['dashboard', 'creators', 'photos', 'videos', 'text', 'strategy', 'guide', 'add'];
  if (!validTabs.includes(tab)) tab = 'dashboard';
  if (tab === 'add' && state.role !== 'admin') tab = 'dashboard';

  state.activeTab = tab;
  localStorage.setItem('twi_tab', tab);

  if (pushState) history.pushState(null, '', `#${tab}`);

  // Update tab buttons
  $$('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));

  // Show/hide content
  $$('.tab-content').forEach(el => {
    el.classList.remove('active');
    el.classList.add('hidden');
  });
  const content = $(`#tab-${tab}`);
  if (content) {
    content.classList.remove('hidden');
    content.classList.add('active');
  }

  // Load tab data
  loadTab(tab);
}

function loadTab(tab) {
  switch (tab) {
    case 'dashboard': loadDashboard(); break;
    case 'creators':  loadCreators();  break;
    case 'photos':    loadViralTab('photos', 1, false); break;
    case 'videos':    loadViralTab('videos', 1, false); break;
    case 'text':      loadViralTab('text', 1, false); break;
    case 'strategy':  renderStrategy(); break;
    case 'guide':     renderGuide(); break;
    case 'add':       /* static form, no load needed */ break;
  }
}

// ─── DASHBOARD ───────────────────────────────────────────────────────
async function loadDashboard() {
  loadStats();
  loadJobs();
  if (state.role === 'admin') startPolling();
}

async function loadStats() {
  try {
    const data = await apiGet('/api/dashboard/stats', 'dashboard_stats');
    if (!data) return;
    $('#stat-creators').textContent     = fmtNum(data.total_creators ?? 0);
    $('#stat-posts').textContent        = fmtNum(data.total_posts ?? 0);
    $('#stat-viral').textContent        = fmtNum(data.viral_posts ?? 0);
    $('#stat-viral-photos').textContent = fmtNum(data.viral_photos ?? 0);
    $('#stat-viral-videos').textContent = fmtNum(data.viral_videos ?? 0);
    $('#stat-viral-text').textContent   = fmtNum(data.viral_text ?? 0);
  } catch (err) {
    console.error('Stats error:', err);
  }
}

async function loadJobs() {
  const tbody = $('#jobs-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="empty-row">Loading…</td></tr>';
  try {
    const jobs = await apiGet('/api/scrape/jobs', 'scrape_jobs');
    if (!jobs || !jobs.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty-row">No jobs yet</td></tr>';
      return;
    }
    tbody.innerHTML = jobs.map(j => {
      const dur = j.finished_at && j.started_at
        ? fmtDuration((new Date(j.finished_at) - new Date(j.started_at)) / 1000)
        : j.started_at ? 'Running…' : '—';
      return `<tr>
        <td>${j.id}</td>
        <td><span class="job-type">${escHtml(j.job_type || '—')}</span></td>
        <td><span class="status-badge ${j.status || 'idle'}">${escHtml(j.status || '—')}</span></td>
        <td>${fmtNum(j.creators_scraped)}</td>
        <td>${fmtNum(j.posts_found)}</td>
        <td>${fmtDate(j.started_at)}</td>
        <td>${dur}</td>
        <td class="text-muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(j.error_message || '')}">${escHtml(j.error_message || '—')}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-row">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

// ─── SCRAPE POLLING ──────────────────────────────────────────────────
function startPolling() {
  if (state.pollTimer) return;
  pollScrapeStatus();
  state.pollTimer = setInterval(pollScrapeStatus, POLL_INTERVAL);
}

function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function pollScrapeStatus() {
  try {
    const s = await apiFetch('/api/dashboard/scrape-status');
    if (!s) return;
    const badge = $('#scrape-status-badge');
    const prog  = $('#scrape-progress');
    if (s.is_running) {
      badge.textContent = 'Running';
      badge.className   = 'status-badge running';
      prog.classList.remove('hidden');
      if (s.current_job) {
        const pct = s.current_job.progress_pct ?? 0;
        $('#progress-fill').style.width = `${pct}%`;
        $('#progress-text').textContent = s.current_job.progress_msg || `${pct}% complete`;
      }
    } else {
      const job = s.current_job;
      if (job) {
        badge.textContent = job.status === 'done' ? 'Done' : (job.status || 'Idle');
        badge.className   = `status-badge ${job.status || 'idle'}`;
        if (job.status === 'done') {
          prog.classList.add('hidden');
          $('#progress-fill').style.width = '100%';
          cacheClear('scrape_jobs');
          cacheClear('dashboard_stats');
          loadStats();
          loadJobs();
        }
      } else {
        badge.textContent = 'Idle';
        badge.className   = 'status-badge idle';
        prog.classList.add('hidden');
      }
    }
  } catch (_) {}
}

async function startScrape(type) {
  const pin  = $('#scrape-pin').value.trim();
  const test = parseInt($('#scrape-test-limit').value) || 0;
  if (!pin) { toast('Enter scrape PIN first', 'error'); return; }

  let path = `/api/scrape/${type}?pin=${encodeURIComponent(pin)}`;
  if (type === 'full') path += `&test=${test}`;

  try {
    const r = await apiPost(path);
    if (!r) return;
    toast(`Scrape started: ${type}`, 'success');
    cacheClear('scrape_jobs');
    cacheClear('dashboard_stats');
    startPolling();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function stopScrape() {
  try {
    await apiPost('/api/scrape/stop');
    toast('Stop signal sent', 'info');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── CREATORS ────────────────────────────────────────────────────────
let creatorsData = [];
let creatorsSort = { col: 'followers', dir: 'desc' };

async function loadCreators() {
  const tbody  = $('#creators-tbody');
  const search = $('#creators-search').value.trim();
  const sort   = $('#creators-sort').value;

  tbody.innerHTML = '<tr><td colspan="8" class="empty-row">Loading…</td></tr>';

  const cacheKey = `creators_${sort}_${search}`;
  try {
    const data = await apiGet(`/api/creators?limit=500&sort=${sort}&search=${encodeURIComponent(search)}`, cacheKey);
    if (!data) return;
    creatorsData = data;
    renderCreatorsTable(data);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-row">Error: ${escHtml(err.message)}</td></tr>`;
  }
}

function renderCreatorsTable(creators) {
  const tbody = $('#creators-tbody');
  const countEl = $('#creators-count');
  countEl.textContent = `${creators.length} creators`;

  if (!creators.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-row">No creators found</td></tr>';
    return;
  }

  tbody.innerHTML = creators.map(c => {
    const initials = (c.display_name || c.username || '?')[0].toUpperCase();
    const avatarHtml = `
      <span class="creator-avatar-placeholder" style="background:linear-gradient(135deg,${stringToColor(c.username)},${stringToColor2(c.username)})">${initials}</span>
      <img class="creator-avatar img-lazy" data-src="${c.avatar_url || `/api/avatars/${encodeURIComponent(c.username)}`}"
           src="" alt="" onerror="this.style.display='none'" style="display:none;position:absolute;inset:0;" />
    `;
    const verifiedHtml = c.is_verified
      ? `<span class="verified-badge" title="Verified"><svg width="16" height="16" viewBox="0 0 24 24" fill="#1d9bf0"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81C14.67 2.88 13.43 2 12 2s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91C2.88 9.33 2 10.57 2 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81C9.33 21.12 10.57 22 12 22s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91C21.12 14.67 22 13.43 22 12zm-6.28-1.72-4 5.5a.75.75 0 0 1-1.14.09l-2-2a.75.75 0 0 1 1.06-1.06l1.4 1.4 3.49-4.8a.75.75 0 0 1 1.19.87z"/></svg></span>`
      : '';

    return `<tr data-id="${c.id}" data-username="${escHtml(c.username)}">
      <td style="position:relative;width:44px;">
        <div style="position:relative;width:36px;height:36px;">
          ${avatarHtml}
        </div>
      </td>
      <td>
        <div class="creator-name-cell">
          <span class="creator-username">@${escHtml(c.username)}</span>
          ${verifiedHtml}
        </div>
        ${c.display_name && c.display_name !== c.username ? `<div style="font-size:11px;color:var(--text3)">${escHtml(c.display_name)}</div>` : ''}
      </td>
      <td>${fmtNum(c.followers_count)}</td>
      <td>${fmtNum(c.avg_likes)}</td>
      <td>${fmtNum(c.post_count)}</td>
      <td>${verifiedHtml || '<span style="color:var(--text3)">—</span>'}</td>
      <td>
        <button class="star-btn ${c.is_watched ? 'watched' : ''}" data-username="${escHtml(c.username)}" title="Watchlist">
          ${c.is_watched ? '★' : '☆'}
        </button>
      </td>
      <td class="admin-only">
        <button class="btn btn-danger btn-sm delete-creator-btn" data-id="${c.id}" data-username="${escHtml(c.username)}">Delete</button>
      </td>
    </tr>`;
  }).join('');

  // Lazy load avatars
  initLazyImages();

  // Attach click: row → creator modal
  $$('#creators-tbody tr').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.delete-creator-btn') || e.target.closest('.star-btn')) return;
      openCreatorModal(parseInt(row.dataset.id), row.dataset.username);
    });
  });

  // Delete buttons (admin)
  $$('.delete-creator-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteCreator(parseInt(btn.dataset.id), btn.dataset.username);
    });
  });

  // Star buttons
  $$('.star-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleWatchlist(btn.dataset.username, btn);
    });
  });
}

async function deleteCreator(id, username) {
  if (!confirm(`Delete @${username} and all their posts? This cannot be undone.`)) return;
  try {
    await apiDelete(`/api/creators/${id}`);
    toast(`Deleted @${username}`, 'success');
    cacheClear('creators_');
    loadCreators();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function toggleWatchlist(username, btn) {
  const isWatched = btn.classList.contains('watched');
  try {
    if (isWatched) {
      await apiDelete(`/api/watchlist/${encodeURIComponent(username)}`);
      btn.classList.remove('watched');
      btn.textContent = '☆';
      toast(`Removed @${username} from watchlist`, 'info');
    } else {
      await apiPost(`/api/watchlist/add?username=${encodeURIComponent(username)}`);
      btn.classList.add('watched');
      btn.textContent = '★';
      toast(`Added @${username} to watchlist`, 'success');
    }
    cacheClear('creators_');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── CREATOR DETAIL MODAL ────────────────────────────────────────────
async function openCreatorModal(id, username) {
  state.activeCreator = { id, username };
  state.activeCreatorType = 'all';
  $$('.creator-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.ctype === 'all'));

  const modal = $('#creator-modal');
  modal.classList.remove('hidden');
  modal.classList.add('active');

  // Load creator info
  const header = $('#creator-modal-header');
  header.innerHTML = `<div style="color:var(--text2);font-size:13px">Loading…</div>`;

  try {
    const c = await apiGet(`/api/creators/${id}`, `creator_${id}`);
    if (!c) return;
    const initials = (c.display_name || c.username || '?')[0].toUpperCase();
    header.innerHTML = `
      <div style="position:relative;width:60px;height:60px;flex-shrink:0;">
        <div class="creator-avatar-placeholder" style="width:60px;height:60px;font-size:20px;background:linear-gradient(135deg,${stringToColor(c.username)},${stringToColor2(c.username)})">${initials}</div>
        <img class="img-lazy" data-src="${c.avatar_url || `/api/avatars/${encodeURIComponent(c.username)}`}"
             src="" alt="" onerror="this.style.display='none'"
             style="position:absolute;inset:0;width:60px;height:60px;border-radius:50%;object-fit:cover;display:none;" />
      </div>
      <div class="creator-modal-info">
        <div class="creator-modal-name">${escHtml(c.display_name || c.username)}</div>
        <div class="creator-modal-handle">@${escHtml(c.username)}</div>
        <div class="creator-modal-stats">
          <span class="creator-stat"><strong>${fmtNum(c.followers_count)}</strong> followers</span>
          <span class="creator-stat"><strong>${fmtNum(c.post_count)}</strong> posts</span>
          <span class="creator-stat"><strong>${fmtNum(c.avg_likes)}</strong> avg likes</span>
          ${c.avg_views ? `<span class="creator-stat"><strong>${fmtNum(c.avg_views)}</strong> avg views</span>` : ''}
        </div>
      </div>
      <div>
        <button class="watchlist-btn" id="creator-watchlist-btn" data-username="${escHtml(c.username)}">
          ☆ Watchlist
        </button>
      </div>
    `;
    initLazyImages();
    checkCreatorWatchlist(c.username);
    loadCreatorPosts(id, 'all');
  } catch (err) {
    header.innerHTML = `<div style="color:var(--danger)">Error: ${escHtml(err.message)}</div>`;
  }
}

async function checkCreatorWatchlist(username) {
  try {
    const r = await apiFetch(`/api/watchlist/check/${encodeURIComponent(username)}`);
    const btn = $('#creator-watchlist-btn');
    if (!btn) return;
    if (r && r.watched) {
      btn.classList.add('active');
      btn.textContent = '★ Watching';
    } else {
      btn.classList.remove('active');
      btn.textContent = '☆ Watchlist';
    }
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) {
        apiDelete(`/api/watchlist/${encodeURIComponent(username)}`)
          .then(() => { btn.classList.remove('active'); btn.textContent = '☆ Watchlist'; toast(`Removed from watchlist`, 'info'); })
          .catch(e => toast(e.message, 'error'));
      } else {
        apiPost(`/api/watchlist/add?username=${encodeURIComponent(username)}`)
          .then(() => { btn.classList.add('active'); btn.textContent = '★ Watching'; toast(`Added to watchlist`, 'success'); })
          .catch(e => toast(e.message, 'error'));
      }
    });
  } catch (_) {}
}

async function loadCreatorPosts(id, mediaType) {
  const grid = $('#creator-posts-grid');
  grid.innerHTML = '<div style="color:var(--text2);padding:20px">Loading posts…</div>';

  const mt = mediaType && mediaType !== 'all' ? `&media_type=${mediaType}` : '';
  try {
    const posts = await apiGet(`/api/creators/${id}/posts?limit=100${mt}`, `creator_posts_${id}_${mediaType}`);
    if (!posts || !posts.length) {
      grid.innerHTML = '<div class="no-results"><div class="no-results-icon">📭</div><p>No posts found</p></div>';
      return;
    }
    grid.innerHTML = posts.map(p => buildPostCard(p)).join('');
    initLazyImages();
    $$('.post-card', grid).forEach(card => {
      card.addEventListener('click', () => openPostModal(parseInt(card.dataset.id)));
    });
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--danger);padding:20px">Error: ${escHtml(err.message)}</div>`;
  }
}

// ─── VIRAL TABS ──────────────────────────────────────────────────────
const tabConfig = {
  photos: {
    mediaType:  'photo',
    gridId:     'photos-grid',
    countId:    'photos-count',
    loadMoreId: 'photos-load-more',
    periodBtns: 'photos-period-buttons',
    sortId:     'photos-sort',
    multBtns:   'photos-mult-buttons',
    searchId:   'photos-search',
  },
  videos: {
    mediaType:  'video',
    gridId:     'videos-grid',
    countId:    'videos-count',
    loadMoreId: 'videos-load-more',
    periodBtns: 'videos-period-buttons',
    sortId:     'videos-sort',
    multBtns:   'videos-mult-buttons',
    searchId:   'videos-search',
  },
  text: {
    mediaType:  'text',
    gridId:     'text-list',
    countId:    'text-count',
    loadMoreId: 'text-load-more',
    periodBtns: 'text-period-buttons',
    sortId:     'text-sort',
    multBtns:   'text-mult-buttons',
    searchId:   'text-search',
  },
};

async function loadViralTab(tab, page = 1, append = false) {
  const cfg     = tabConfig[tab];
  const grid    = $(`#${cfg.gridId}`);
  const loadBtn = $(`#${cfg.loadMoreId}`);
  const countEl = $(`#${cfg.countId}`);

  const periodBtn = $(`#${cfg.periodBtns} .period-btn.active`);
  const period  = periodBtn ? periodBtn.dataset.value : 'all';
  const sort    = $(`#${cfg.sortId}`).value;
  const multBtn = $(`#${cfg.multBtns} .period-btn.active`);
  const mult    = multBtn ? parseFloat(multBtn.dataset.value) || 0 : 0;
  const search  = $(`#${cfg.searchId}`).value.trim();

  if (!append) {
    state.pages[tab] = 1;
    page = 1;
    grid.innerHTML = '';
  }

  loadBtn.disabled = true;
  loadBtn.textContent = 'Loading…';

  const cacheKey = `viral_${tab}_${period}_${sort}_${mult}_${search}_${page}`;
  try {
    const params = new URLSearchParams({
      page, limit: 50, sort,
      media_type: cfg.mediaType,
      period, min_mult: mult,
      search,
    });
    const data = await apiGet(`/api/posts/viral?${params}`, cacheKey);
    if (!data) return;

    const posts = Array.isArray(data) ? data : (data.posts || data.items || []);
    const total = data.total ?? posts.length;

    if (page === 1 && !posts.length) {
      grid.innerHTML = `<div class="no-results"><div class="no-results-icon">🔍</div><h3>No viral ${tab} found</h3><p>Try adjusting your filters</p></div>`;
      countEl.textContent = '0 results';
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load More';
      return;
    }

    if (tab === 'text') {
      const frag = document.createDocumentFragment();
      posts.forEach(p => {
        const el = document.createElement('div');
        el.innerHTML = buildTextPostCard(p);
        const card = el.firstElementChild;
        card.addEventListener('click', () => openPostModal(parseInt(card.dataset.id)));
        $$(`.copy-btn`, card).forEach(btn => {
          btn.addEventListener('click', e => {
            e.stopPropagation();
            copyToClipboard(p.caption || '');
          });
        });
        frag.appendChild(card);
      });
      grid.appendChild(frag);
    } else {
      const frag = document.createDocumentFragment();
      posts.forEach(p => {
        const el = document.createElement('div');
        el.innerHTML = buildPostCard(p);
        const card = el.firstElementChild;
        card.addEventListener('click', () => openPostModal(parseInt(card.dataset.id)));
        frag.appendChild(card);
      });
      grid.appendChild(frag);
    }

    initLazyImages();
    state.pages[tab] = page + 1;
    countEl.textContent = `${grid.children.length} of ${fmtNum(total)} results`;
    loadBtn.disabled = posts.length < 50;
    loadBtn.textContent = posts.length < 50 ? 'No more results' : 'Load More';
  } catch (err) {
    toast(err.message, 'error');
    loadBtn.disabled = false;
    loadBtn.textContent = 'Load More';
  }
}

// ─── POST CARD BUILDER ───────────────────────────────────────────────
function buildPostCard(post) {
  const mt = post.media_type || 'unknown';
  const isVideo = mt === 'video';
  const hasMedia = mt === 'photo' || mt === 'video';

  // ─── Media rendering (1:1 IG Intel pattern) ───
  let mediaHtml = '';
  if (hasMedia) {
    const thumbUrl = post.thumbnail_url || post.media_url || '';
    const imgUrl = post.media_url || `/api/images/${post.id}`;
    const multBadge = post.performance_multiplier > 1 ? `<div class="viral-badge">${post.performance_multiplier}x</div>` : '';
    const overlay = `
      <div class="post-card-overlay">
        <div class="post-card-overlay-stats">
          <span class="overlay-stat">❤️ ${fmtNum(post.likes)}</span>
          ${post.views ? `<span class="overlay-stat">👁 ${fmtNum(post.views)}</span>` : ''}
        </div>
      </div>`;

    if (isVideo && post.media_local) {
      // Video downloaded → autoplay with IntersectionObserver (same as IG Intel)
      mediaHtml = `
        <div class="post-card-media video-ratio">
          <video muted loop playsinline preload="none" data-src="${post.media_local}" poster="${thumbUrl}" style="width:100%;height:100%;object-fit:cover;display:block"></video>
          <button onclick="event.stopPropagation();toggleVideoSound(this)" style="position:absolute;bottom:36px;right:6px;background:rgba(0,0,0,0.55);border:none;color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;z-index:2" title="Toggle sound">&#128264;</button>
          ${overlay}${multBadge}
          <div class="media-type-badge">video</div>
        </div>`;
    } else if (isVideo) {
      // Video not yet downloaded → show thumbnail
      mediaHtml = `
        <div class="post-card-media video-ratio">
          <img src="${thumbUrl}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.background='#111'" />
          <div class="video-play-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
          ${overlay}${multBadge}
          <div class="media-type-badge">video</div>
        </div>`;
    } else {
      // Photo — native lazy loading
      mediaHtml = `
        <div class="post-card-media">
          <img src="${imgUrl}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.style.background='#111'" />
          ${overlay}${multBadge}
          <div class="media-type-badge">photo</div>
        </div>`;
    }
  } else {
    mediaHtml = `
      <div class="post-card-media" style="padding-bottom:56.25%;">
        <div class="media-placeholder">✍️</div>
        ${post.viral_mult ? `<div class="viral-badge">${multLabel(post.viral_mult)}</div>` : ''}
      </div>`;
  }

  const captionPreview = (post.caption || '').slice(0, 120);

  return `<div class="post-card" data-id="${post.id}">
    ${mediaHtml}
    <div class="post-card-body">
      <div class="post-card-author">@${escHtml(post.username || '—')}</div>
      ${captionPreview ? `<div class="post-card-caption">${escHtml(captionPreview)}</div>` : ''}
      <div class="post-card-stats">
        <span class="post-stat">${heartSvg()} ${fmtNum(post.likes)}</span>
        ${post.views  ? `<span class="post-stat">${eyeSvg()} ${fmtNum(post.views)}</span>` : ''}
        ${post.bookmarks ? `<span class="post-stat">${bookmarkSvg()} ${fmtNum(post.bookmarks)}</span>` : ''}
        ${post.retweets ? `<span class="post-stat">${retweetSvg()} ${fmtNum(post.retweets)}</span>` : ''}
      </div>
    </div>
  </div>`;
}

function buildTextPostCard(post) {
  const mult = post.viral_mult;
  const multHtml = mult ? `<span class="mult-badge ${multClass(mult)}">${multLabel(mult)}</span>` : '';
  const captionFull = post.caption || '';
  return `<div class="text-post-card" data-id="${post.id}">
    <div class="text-post-header">
      <div>
        <span class="text-post-author">@${escHtml(post.username || '—')}</span>
        ${multHtml}
      </div>
      <div class="text-post-meta">${fmtDate(post.created_at)}</div>
    </div>
    <div class="text-post-caption">${escHtml(captionFull.slice(0, 500))}${captionFull.length > 500 ? '…' : ''}</div>
    <div class="text-post-footer">
      <div class="text-post-stats">
        <span class="post-stat">${heartSvg()} ${fmtNum(post.likes)}</span>
        ${post.views    ? `<span class="post-stat">${eyeSvg()} ${fmtNum(post.views)}</span>` : ''}
        ${post.bookmarks? `<span class="post-stat">${bookmarkSvg()} ${fmtNum(post.bookmarks)}</span>` : ''}
        ${post.retweets ? `<span class="post-stat">${retweetSvg()} ${fmtNum(post.retweets)}</span>` : ''}
      </div>
      <div class="text-post-actions">
        <button class="btn btn-ghost btn-sm copy-btn" title="Copy caption">Copy</button>
      </div>
    </div>
  </div>`;
}

// ─── POST DETAIL MODAL ───────────────────────────────────────────────
async function openPostModal(postId) {
  const modal   = $('#post-modal');
  modal.classList.remove('hidden');
  modal.classList.add('active');

  const mediaEl  = $('#post-modal-media');
  const authorEl = $('#post-modal-author');
  const captionEl= $('#post-modal-caption');
  const statsEl  = $('#post-modal-stats');
  const metaEl   = $('#post-modal-meta');
  const linkEl   = $('#post-open-link');

  mediaEl.innerHTML  = '<div class="media-placeholder" style="font-size:48px;position:static;padding:40px;">⏳</div>';
  authorEl.innerHTML = '';
  captionEl.innerHTML= '';
  statsEl.innerHTML  = '';
  metaEl.innerHTML   = '';

  try {
    const post = await apiGet(`/api/posts/${postId}`, `post_${postId}`);
    if (!post) return;

    const isVideo = (post.media_type || '') === 'video';
    const hasMedia = post.media_type === 'photo' || post.media_type === 'video';

    // Media
    if (hasMedia) {
      if (isVideo && post.media_local) {
        // Video downloaded → play from Supabase/local
        mediaEl.innerHTML = `<div style="max-width:400px;margin:0 auto"><video controls loop playsinline autoplay src="${post.media_local}" style="width:100%;border-radius:8px;max-height:500px"></video></div>`;
        mediaEl.style.position = 'relative';
      } else if (isVideo) {
        const thumb = post.thumbnail_url || post.media_url || `/api/thumbnails/${post.id}`;
        mediaEl.innerHTML = `
          <img src="${thumb}" alt="Video thumbnail" style="width:100%;max-height:600px;object-fit:contain;"
               onerror="this.parentNode.innerHTML='<div class=\\'media-placeholder\\' style=\\'font-size:60px;position:static\\''>🎬</div>'" />
          <div style="position:absolute;bottom:12px;left:12px;background:rgba(0,0,0,0.7);color:#fff;font-size:11px;padding:3px 8px;border-radius:4px;">VIDEO</div>
        `;
        mediaEl.style.position = 'relative';
      } else {
        const imgUrl = post.media_url || `/api/images/${post.id}`;
        mediaEl.innerHTML = `
          <img src="${imgUrl}" alt="Post image" style="width:100%;max-height:600px;object-fit:contain;"
               onerror="this.parentNode.innerHTML='<div class=\\'media-placeholder\\' style=\\'font-size:60px;position:static\\''>📸</div>'" />
        `;
      }
    } else {
      mediaEl.innerHTML = '<div class="media-placeholder" style="font-size:60px;position:static;padding:40px">✍️</div>';
    }

    // Author
    const initials = (post.display_name || post.username || '?')[0].toUpperCase();
    authorEl.innerHTML = `
      <div style="position:relative;width:40px;height:40px;flex-shrink:0;">
        <div class="creator-avatar-placeholder" style="width:40px;height:40px;font-size:14px;background:linear-gradient(135deg,${stringToColor(post.username)},${stringToColor2(post.username)})">${initials}</div>
        <img class="img-lazy" data-src="/api/avatars/${encodeURIComponent(post.username || '')}"
             src="" alt="" onerror="this.style.display='none'"
             style="position:absolute;inset:0;width:40px;height:40px;border-radius:50%;object-fit:cover;display:none;" />
      </div>
      <div>
        <div class="post-modal-author-name">${escHtml(post.display_name || post.username || '—')}</div>
        <div class="post-modal-author-handle">@${escHtml(post.username || '—')}</div>
      </div>
    `;
    initLazyImages();

    // Caption
    captionEl.textContent = post.caption || '';

    // Stats
    const statsItems = [
      { label: 'Likes', value: post.likes },
      { label: 'Views', value: post.views },
      { label: 'Bookmarks', value: post.bookmarks },
      { label: 'Retweets', value: post.retweets },
      { label: 'Replies', value: post.replies },
      { label: 'Viral Mult', value: post.viral_mult ? `${post.viral_mult.toFixed(2)}x` : null },
    ].filter(s => s.value != null && s.value !== 0 && s.value !== '');

    statsEl.innerHTML = statsItems.map(s => `
      <div class="modal-stat">
        <div class="modal-stat-label">${s.label}</div>
        <div class="modal-stat-value">${typeof s.value === 'number' ? fmtNum(s.value) : s.value}</div>
      </div>
    `).join('');

    // Meta
    metaEl.innerHTML = `
      ${post.created_at ? `<div>Posted: ${new Date(post.created_at).toLocaleString()}</div>` : ''}
      ${post.scraped_at ? `<div>Scraped: ${fmtDate(post.scraped_at)}</div>` : ''}
      ${post.tweet_id   ? `<div>Tweet ID: ${post.tweet_id}</div>` : ''}
    `;

    // Copy + Link
    $('#post-copy-btn').onclick = () => copyToClipboard(post.caption || '');
    const tweetUrl = post.tweet_id
      ? `https://x.com/${post.username}/status/${post.tweet_id}`
      : null;
    if (tweetUrl) {
      linkEl.href = tweetUrl;
      linkEl.style.display = '';
    } else {
      linkEl.style.display = 'none';
    }

  } catch (err) {
    mediaEl.innerHTML = `<div style="color:var(--danger);padding:20px">Error: ${escHtml(err.message)}</div>`;
  }
}

// ─── ADD TAB ─────────────────────────────────────────────────────────
async function addSingle() {
  const input  = $('#add-single-input');
  const result = $('#add-single-result');
  let username = input.value.trim().replace(/^@/, '');
  if (!username) { toast('Enter a username', 'error'); return; }

  const btn = $('#add-single-btn');
  btn.disabled = true;
  btn.textContent = 'Adding…';
  result.className = 'add-result hidden';

  try {
    const data = await apiPost(`/api/creators/add?username=${encodeURIComponent(username)}`);
    if (!data) return;
    const ok = data.status === 'added';
    result.textContent = ok
      ? `✓ @${username} added successfully!`
      : `@${username} already exists.`;
    result.className = `add-result ${ok ? 'success' : 'error'}`;
    if (ok) { input.value = ''; cacheClear('creators_'); }
  } catch (err) {
    result.textContent = `Error: ${err.message}`;
    result.className = 'add-result error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
}

async function addBulk() {
  const textarea = $('#add-bulk-input');
  const result   = $('#add-bulk-result');
  const raw = textarea.value.trim();
  if (!raw) { toast('Enter at least one username', 'error'); return; }

  const usernames = raw.split('\n')
    .map(u => u.trim().replace(/^@/, ''))
    .filter(Boolean);

  if (!usernames.length) { toast('No valid usernames found', 'error'); return; }

  const btn = $('#add-bulk-btn');
  btn.disabled = true;
  btn.textContent = `Adding ${usernames.length} creators…`;
  result.className = 'add-result hidden';

  const logSection = $('#import-log-section');
  const logEl = $('#import-log');
  logSection.style.display = 'block';
  logEl.innerHTML = '';

  function appendLog(msg, cls) {
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = msg;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  appendLog(`Starting bulk add of ${usernames.length} usernames…`, '');

  try {
    const data = await apiPost('/api/creators/bulk-add', { usernames });
    if (!data) return;

    appendLog(`Done! Added: ${data.added}, Skipped: ${data.skipped}`, 'log-ok');

    result.textContent = `Added ${data.added} creators, ${data.skipped} skipped (already exist).`;
    result.className = 'add-result success';
    if (data.added > 0) { textarea.value = ''; cacheClear('creators_'); }
  } catch (err) {
    appendLog(`Error: ${err.message}`, 'log-error');
    result.textContent = `Error: ${err.message}`;
    result.className = 'add-result error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add All';
  }
}

// ─── STRATEGY TAB ────────────────────────────────────────────────────
const strategyData = {
  formats: [
    { label: 'Photo posts',    value: 8.4, color: '#1d9bf0' },
    { label: 'Video posts',    value: 12.1, color: '#7856ff' },
    { label: 'Text only',      value: 4.2, color: '#00ba7c' },
    { label: 'Thread starter', value: 6.7, color: '#ffad1f' },
  ],
  captions: [
    { label: 'Question hook',    value: 9.8, color: '#1d9bf0' },
    { label: 'Controversial take',value: 11.2, color: '#f91880' },
    { label: 'Personal story',   value: 8.5, color: '#7856ff' },
    { label: 'Tips & advice',    value: 7.3, color: '#00ba7c' },
    { label: 'Humor / meme',     value: 10.4, color: '#ffad1f' },
    { label: 'Call to action',   value: 6.1, color: '#ff7a00' },
    { label: 'Behind the scenes',value: 8.9, color: '#00d4ff' },
    { label: 'Announcement',     value: 5.4, color: '#71767b' },
  ],
  algoWeights: [
    { signal: 'Bookmarks / saves', weight: 95, notes: 'Strongest quality signal' },
    { signal: 'Replies (comments)', weight: 80, notes: 'Conversation drives reach' },
    { signal: 'Link clicks (off-X)', weight: 75, notes: 'Intent signal; penalized by reach algo' },
    { signal: 'Quote tweets',        weight: 60, notes: 'Discussion amplifier' },
    { signal: 'Retweets',            weight: 55, notes: 'Classic virality signal' },
    { signal: 'Likes',               weight: 50, notes: 'High volume, lower weight' },
    { signal: 'Profile visits',       weight: 40, notes: 'Curiosity signal' },
    { signal: 'Follows from post',    weight: 35, notes: 'Strong quality but rare' },
    { signal: 'Video completion',     weight: 85, notes: 'Key for video posts' },
    { signal: 'View time',            weight: 70, notes: 'Time spent on post' },
  ],
  // heat map: 24h x 7days (Mon-Sun). Values 0-5 for heat intensity
  // rows = hours 6am-11pm, cols = Mon-Sun
  bestTimes: {
    days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    hours: ['6am', '7am', '8am', '9am', '10am', '11am', '12pm',
            '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm',
            '8pm', '9pm', '10pm', '11pm'],
    heat: [
      // Mon  Tue  Wed  Thu  Fri  Sat  Sun
      [1,1,1,1,1,0,0],  // 6am
      [2,2,2,2,2,1,1],  // 7am
      [3,3,3,3,3,1,1],  // 8am
      [4,4,4,4,3,2,2],  // 9am
      [4,5,5,5,4,3,3],  // 10am
      [3,4,4,4,3,3,3],  // 11am
      [4,4,4,4,4,4,3],  // 12pm
      [3,4,4,4,4,4,3],  // 1pm
      [3,3,3,3,3,4,3],  // 2pm
      [3,3,3,3,3,4,3],  // 3pm
      [3,3,3,3,3,4,4],  // 4pm
      [4,4,4,4,5,5,4],  // 5pm
      [5,4,5,4,5,5,5],  // 6pm
      [5,5,5,5,5,5,5],  // 7pm
      [5,5,5,5,4,5,5],  // 8pm
      [4,4,5,5,4,5,5],  // 9pm
      [3,3,4,4,3,4,4],  // 10pm
      [2,2,2,2,2,3,3],  // 11pm
    ],
  },
};

function renderStrategy() {
  renderBarChart('format-chart', strategyData.formats, 'Avg Virality Score');
  renderBarChart('caption-chart', strategyData.captions, 'Avg Virality Score');
  renderAlgoTable();
  renderTimeGrid();
}

function renderBarChart(containerId, items, unit = '') {
  const container = $(`#${containerId}`);
  if (!container) return;
  const max = Math.max(...items.map(i => i.value));
  container.innerHTML = items.map(item => `
    <div class="bar-row">
      <div class="bar-label">${escHtml(item.label)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${(item.value / max * 100).toFixed(1)}%;background:${item.color};"></div>
      </div>
      <div class="bar-value">${item.value.toFixed(1)}</div>
    </div>
  `).join('');
}

function renderAlgoTable() {
  const tbody = $('#algo-tbody');
  if (!tbody) return;
  const max = Math.max(...strategyData.algoWeights.map(w => w.weight));
  tbody.innerHTML = strategyData.algoWeights.map(w => `
    <tr>
      <td style="font-weight:500;">${escHtml(w.signal)}</td>
      <td>
        <div class="weight-bar">
          <div class="weight-track">
            <div class="weight-fill" style="width:${(w.weight / max * 100).toFixed(1)}%"></div>
          </div>
          <span style="font-size:12px;font-weight:600;color:var(--text2)">${w.weight}</span>
        </div>
      </td>
      <td style="font-size:12px;color:var(--text2)">${escHtml(w.notes)}</td>
    </tr>
  `).join('');
}

function renderTimeGrid() {
  const container = $('#time-grid');
  if (!container) return;
  const { days, hours, heat } = strategyData.bestTimes;

  // Build column per day
  let html = '';
  for (let d = 0; d < days.length; d++) {
    html += `<div class="time-col">
      <div class="time-day">${days[d]}</div>
      ${hours.map((h, hIdx) => `
        <div class="time-slot heat-${heat[hIdx][d]}" title="${days[d]} ${h}: heat ${heat[hIdx][d]}/5">
          ${heat[hIdx][d] >= 4 ? h : ''}
        </div>
      `).join('')}
    </div>`;
  }
  container.innerHTML = html;
}

// ─── GUIDE TAB ───────────────────────────────────────────────────────
function renderGuide() {
  const el = $('#guide-content');
  if (!el) return;
  if (el.dataset.rendered === '1') return; // already rendered

  // ── Inject CSS once ────────────────────────────────────────────────
  if (!document.getElementById('guide-styles')) {
    const style = document.createElement('style');
    style.id = 'guide-styles';
    style.textContent = `
      #guide-content { padding: 0; }
      .guide-wrap { max-width: 900px; margin: 0 auto; padding: 24px 20px 60px; }
      .guide-search-wrap { position: sticky; top: 0; z-index: 10; background: #0a0a0f; padding: 12px 0 8px; margin-bottom: 16px; }
      .guide-search-input { width: 100%; padding: 10px 16px; border-radius: 8px; background: #16181c; border: 1px solid #2f3336; color: #e7e9ea; font-size: 14px; outline: none; box-sizing: border-box; }
      .guide-search-input:focus { border-color: #1d9bf0; box-shadow: 0 0 0 2px rgba(29,155,240,.15); }
      .guide-search-input::placeholder { color: #536471; }
      .guide-no-results { color: #536471; text-align: center; padding: 32px 0; font-size: 14px; }
      .guide-toc { background: #16181c; border: 1px solid #2f3336; border-radius: 12px; padding: 20px 24px; margin-bottom: 28px; }
      .guide-toc h3 { margin: 0 0 14px; font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #1d9bf0; }
      .guide-toc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 4px 16px; }
      .guide-toc-link { color: #8b98a5; font-size: 13px; text-decoration: none; padding: 3px 0; display: block; transition: color .15s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .guide-toc-link:hover { color: #1d9bf0; }
      .guide-section { margin-bottom: 10px; border-radius: 12px; border: 1px solid #2f3336; overflow: hidden; }
      .guide-section-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; cursor: pointer; user-select: none; background: #16181c; transition: background .15s; }
      .guide-section-header:hover { background: #1e2127; }
      .guide-section-header h2 { margin: 0; font-size: 15px; font-weight: 600; color: #e7e9ea; display: flex; align-items: center; gap: 10px; }
      .guide-section-letter { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 6px; background: rgba(29,155,240,.15); color: #1d9bf0; font-size: 12px; font-weight: 700; flex-shrink: 0; }
      .guide-chevron { color: #536471; transition: transform .2s; flex-shrink: 0; }
      .guide-section.open .guide-chevron { transform: rotate(180deg); }
      .guide-section-body { display: none; padding: 20px 24px; background: #0d0d12; border-top: 1px solid #2f3336; }
      .guide-section.open .guide-section-body { display: block; }
      .guide-section-body p { margin: 0 0 14px; line-height: 1.65; color: #c4cdd5; font-size: 14px; }
      .guide-section-body h3 { margin: 20px 0 10px; font-size: 14px; font-weight: 600; color: #e7e9ea; }
      .guide-section-body h4 { margin: 16px 0 8px; font-size: 13px; font-weight: 600; color: #8b98a5; text-transform: uppercase; letter-spacing: .06em; }
      .guide-section-body ul, .guide-section-body ol { padding-left: 20px; margin: 0 0 14px; }
      .guide-section-body li { color: #c4cdd5; font-size: 14px; line-height: 1.7; }
      .guide-section-body strong { color: #e7e9ea; font-weight: 600; }
      .guide-section-body code { background: #1e2127; color: #1d9bf0; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
      .guide-table-wrap { overflow-x: auto; margin: 14px 0; }
      .guide-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .guide-table th { background: #1a1d23; color: #1d9bf0; text-align: left; padding: 8px 12px; border-bottom: 2px solid #2f3336; font-weight: 600; }
      .guide-table td { padding: 8px 12px; border-bottom: 1px solid #2f3336; color: #c4cdd5; vertical-align: top; }
      .guide-table tr:last-child td { border-bottom: none; }
      .guide-table tr:hover td { background: rgba(255,255,255,.02); }
      .guide-table td strong { color: #e7e9ea; }
      .guide-warn { background: rgba(255,122,0,.08); border: 1px solid rgba(255,122,0,.35); border-radius: 8px; padding: 12px 16px; margin: 14px 0; display: flex; gap: 10px; align-items: flex-start; }
      .guide-warn-icon { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
      .guide-warn-body { font-size: 13px; color: #c4cdd5; line-height: 1.6; }
      .guide-warn-body strong { color: #ff7a00; }
      .guide-critical { background: rgba(249,24,128,.08); border: 1px solid rgba(249,24,128,.35); border-radius: 8px; padding: 12px 16px; margin: 14px 0; display: flex; gap: 10px; align-items: flex-start; }
      .guide-critical .guide-warn-body strong { color: #f91880; }
      .guide-code-block { background: #0a0a0f; border: 1px solid #2f3336; border-radius: 8px; overflow: hidden; margin: 14px 0; }
      .guide-code-header { background: #16181c; padding: 6px 14px; font-size: 11px; color: #536471; text-transform: uppercase; letter-spacing: .06em; }
      .guide-code-line { display: flex; align-items: center; justify-content: space-between; padding: 6px 14px; border-top: 1px solid #1a1d23; gap: 10px; }
      .guide-code-line:first-of-type { border-top: none; }
      .guide-code-line span { font-family: 'Menlo','Monaco','Consolas',monospace; font-size: 13px; color: #c4cdd5; flex: 1; word-break: break-word; }
      .guide-code-copy { flex-shrink: 0; background: none; border: 1px solid #2f3336; color: #536471; padding: 2px 8px; border-radius: 4px; font-size: 11px; cursor: pointer; transition: all .15s; }
      .guide-code-copy:hover { border-color: #1d9bf0; color: #1d9bf0; }
      .guide-rules-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; margin: 14px 0; }
      .guide-rule-card { background: #16181c; border: 1px solid #2f3336; border-radius: 10px; padding: 14px 16px; display: flex; gap: 12px; align-items: flex-start; transition: border-color .15s; }
      .guide-rule-card:hover { border-color: #1d9bf0; }
      .guide-rule-num { flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; background: rgba(29,155,240,.15); color: #1d9bf0; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }
      .guide-rule-text { font-size: 13px; color: #c4cdd5; line-height: 1.55; }
      .guide-rule-text strong { color: #e7e9ea; display: block; margin-bottom: 2px; }
      .guide-checklist { list-style: none; padding: 0; margin: 10px 0 16px; }
      .guide-checklist li { display: flex; align-items: flex-start; gap: 10px; padding: 5px 0; font-size: 14px; color: #c4cdd5; line-height: 1.5; }
      .guide-checklist input[type=checkbox] { margin-top: 3px; flex-shrink: 0; accent-color: #1d9bf0; width: 15px; height: 15px; cursor: pointer; }
      .guide-checklist li.checked-item { color: #536471; }
      .guide-checklist li.checked-item label { text-decoration: line-through; }
      .guide-caption-cat { margin-bottom: 22px; }
      .guide-caption-cat h4 { margin: 0 0 10px; font-size: 12px; font-weight: 700; color: #1d9bf0; text-transform: uppercase; letter-spacing: .08em; }
      .guide-caption-item { display: flex; align-items: center; justify-content: space-between; background: #16181c; border: 1px solid #2f3336; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; gap: 10px; transition: border-color .15s; }
      .guide-caption-item:hover { border-color: #1d9bf0; }
      .guide-caption-item span { font-size: 13px; color: #c4cdd5; flex: 1; font-family: 'Menlo','Monaco','Consolas',monospace; }
      .guide-caption-copy { flex-shrink: 0; background: none; border: 1px solid #2f3336; color: #536471; padding: 3px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; transition: all .15s; }
      .guide-caption-copy:hover { border-color: #1d9bf0; color: #1d9bf0; }
      .guide-phase { border-left: 3px solid #1d9bf0; padding-left: 16px; margin-bottom: 18px; }
      .guide-phase-title { font-size: 14px; font-weight: 600; color: #1d9bf0; margin-bottom: 6px; }
      .guide-highlight { background: rgba(29,155,240,.25); border-radius: 2px; padding: 0 1px; }
      .guide-section.search-hidden { display: none; }
    `;
    document.head.appendChild(style);
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function captionItems(lines) {
    return lines.filter(l => l.trim()).map(l =>
      `<div class="guide-caption-item"><span>${escHtml(l.trim())}</span><button class="guide-caption-copy" onclick="copyToClipboard(this.previousElementSibling.textContent.trim());this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>`
    ).join('');
  }

  function codeBlock(lines, header) {
    const hdr = header ? `<div class="guide-code-header">${escHtml(header)}</div>` : '';
    const body = lines.filter(l => l.trim()).map(l =>
      `<div class="guide-code-line"><span>${escHtml(l.trim())}</span><button class="guide-code-copy" onclick="copyToClipboard(this.previousElementSibling.textContent.trim());this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>`
    ).join('');
    return `<div class="guide-code-block">${hdr}${body}</div>`;
  }

  function warnBox(html, critical) {
    const cls  = critical ? 'guide-critical' : 'guide-warn';
    const icon = critical ? '🚨' : '⚠️';
    return `<div class="${cls}"><span class="guide-warn-icon">${icon}</span><div class="guide-warn-body">${html}</div></div>`;
  }

  function tbl(headers, rows) {
    const th = headers.map(h => `<th>${h}</th>`).join('');
    const tr = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<div class="guide-table-wrap"><table class="guide-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }

  let clIdx = 0;
  function checklist(items, pfx) {
    return `<ul class="guide-checklist">${items.map(item => {
      const id = `gcl_${pfx}_${clIdx++}`;
      const chk = localStorage.getItem(id) === '1';
      return `<li class="${chk ? 'checked-item' : ''}" id="li_${id}"><input type="checkbox" id="${id}" ${chk ? 'checked' : ''} onchange="localStorage.setItem('${id}',this.checked?'1':'0');document.getElementById('li_${id}').classList.toggle('checked-item',this.checked);"><label for="${id}">${escHtml(item)}</label></li>`;
    }).join('')}</ul>`;
  }

  function sec(id, ltr, title, body, open) {
    return `<div class="guide-section${open ? ' open' : ''}" id="gs-${id}" data-section-title="${escHtml(ltr + '. ' + title)}">
      <div class="guide-section-header" onclick="this.closest('.guide-section').classList.toggle('open')">
        <h2><span class="guide-section-letter">${ltr}</span>${escHtml(title)}</h2>
        <svg class="guide-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="guide-section-body">${body}</div>
    </div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION CONTENT
  // ══════════════════════════════════════════════════════════════════

  const secA = `
    <p>If you're coming from Threads, Twitter works differently in several key ways.</p>
    ${tbl(['','Threads','Twitter/X'],[
      ['Links in posts','Allowed freely','<strong>HEAVILY PUNISHED</strong> (30–50% reach loss)'],
      ['Subscription','Not needed','<strong>X Premium is MANDATORY</strong> ($8/month)'],
      ['Warm-up time','2 days','<strong>7–21 days</strong>'],
      ['Most valuable action','Likes','<strong>Replies</strong> (150x more valuable than likes!)'],
      ['Algorithm','Follow-based','AI-powered (Grok reads every post)'],
      ['Hashtags','Less important','1–2 niche tags help, 3+ hurts you'],
      ['Image comments','Strong tactic','Even stronger (Premium comments show first)'],
    ])}
    ${warnBox('The golden rule on Twitter is: <strong>Replies are everything.</strong> The algorithm values a reply chain 150x more than a simple like. Keep this in mind at all times.')}
  `;

  const secB = `
    <p>Before anything else, the account needs to be set up correctly. A bad setup will hurt you from day one.</p>
    <h3>Step 1: X Premium</h3>
    ${warnBox('Every account <strong>MUST</strong> have X Premium ($8/month). Without Premium, your account gets almost zero reach since March 2025. This is not optional.', true)}
    <p>What Premium gives you:</p>
    <ul><li>10x more reach per post</li><li>Your comments appear at the TOP (above non-Premium users)</li><li>4,000 character limit instead of 280</li><li>Edit button</li><li>Blue checkmark (builds trust)</li></ul>
    <h3>Step 2: Profile Picture</h3>
    <ul><li>Bright, well-lit photo</li><li>Clear face shot performs best</li><li>No dark bathroom mirror selfies</li><li>Beach, pool, or bed photos in daylight are ideal</li><li>Do NOT use explicit nudity as profile picture (against X rules)</li></ul>
    <h3>Step 3: Banner/Header</h3>
    <ul><li>Use it strategically: showcase the creator's vibe/niche</li><li>Options: Cosplay photo, lifestyle shot, aesthetic design</li><li>Test how it looks on both mobile AND desktop (it crops differently)</li><li>Keep it "sexually soft" — suggestive, not explicit</li></ul>
    <h3>Step 4: Username</h3>
    <ul><li>Memorable and niche-relevant</li><li>NO generic names like "sexybaby9747"</li><li>Use the creator persona's name or a creative variation</li><li>Example: @pinkchyu, @angelicatlol68, @ciarruh</li></ul>
    <h3>Step 5: Bio</h3>
    <p><strong>Formula:</strong> [Personality/Niche] + [CTA arrow to link]</p>
    <p><strong>Good bio examples:</strong></p>
    <ul>
      <li>"hai i'm angelicat lol i cosplay kinda see more me :D ↓" (774K followers)</li>
      <li>"your online addiction ♡" (471K followers)</li>
      <li>"most viral girl on X for a reason 👇" (703K followers)</li>
      <li>"full time internet gf backup @backupname" (229K followers)</li>
      <li>"number 1 nintendogs fan" (2.1M followers)</li>
      <li>"bad decisions only @backupname" (34K followers)</li>
    </ul>
    ${warnBox('<strong>Rules:</strong> Max 1–2 emojis · Use an arrow (↓ ⬇ 👇) pointing to your link · Do NOT write "18+" or "NSFW" · Do NOT write "subscribe to my OnlyFans" · Tag your backup account · Keep it under 100 characters')}
    <h3>Step 6: Link in Bio</h3>
    <p>Use a link aggregator, NOT a direct Fansly/OF link. Recommended: link.me, linktr.ee, hoo.be, onlylinks.com, or a custom domain.</p>
    <h3>Step 7: Pinned Tweet</h3>
    <p>Your pinned tweet is your permanent sales page. Everyone who visits your profile sees it first.</p>
    <ul><li>Use your absolute best photo or video</li><li>Caption should create curiosity (not "subscribe to my OF")</li><li>Good examples: Best photo + "am i your type? (be honest)" · Best video + "A little motivation ❤"</li></ul>
    <h3>Step 8: Sensitive Content Setting</h3>
    <p>Go to <em>Settings &gt; Privacy and Safety &gt; Your posts &gt; Mark media as sensitive</em></p>
    ${warnBox('<strong>TURN THIS ON.</strong> Without it, your reach gets silently reduced.')}
    <h3>Step 9: Location Setting</h3>
    <p>Go to <em>Settings &gt; Privacy and Safety &gt; Precise location</em></p>
    ${warnBox('<strong>TURN THIS OFF.</strong> This ensures your content reaches a global audience, not just people near you.')}
  `;

  const secC = `
    <p>The warm-up on Twitter is longer than on Threads. Twitter watches new accounts very closely in the first weeks.</p>
    ${warnBox('<strong>The warm-up takes 7–21 days. Do NOT rush this.</strong>')}
    <div class="guide-phase">
      <div class="guide-phase-title">Phase 1: Days 1–3 (Profile Setup &amp; Browsing)</div>
      <h4>What to do</h4>
      <ul><li>Complete your profile (photo, banner, bio — no link yet)</li><li>Follow 10–15 creators in our niche (spread across the day)</li><li>Like 10–20 posts per day</li><li>Write 5–10 genuine comments on other creators' posts</li><li>Scroll the For You page for 10–15 minutes</li><li>Follow some normal accounts too (sports, memes, news) to look natural</li></ul>
      <h4>What NOT to do</h4>
      <ul><li>Do NOT post anything yet</li><li>Do NOT add a link to your bio</li><li>Do NOT follow more than 15 accounts per day</li><li>Do NOT like more than 20 posts per day</li></ul>
    </div>
    <div class="guide-phase">
      <div class="guide-phase-title">Phase 2: Days 4–7 (Building Engagement)</div>
      <h4>What to do</h4>
      <ul><li>Follow 10–15 more creators (total ~30–50)</li><li>Like 30–50 posts per day</li><li>Write 10–15 genuine comments per day</li><li>Post your first 2–3 tweets (TEXT ONLY)</li><li>Examples: "twitter is so much better than threads ngl" · "i need a coffee and a hug" · "someone explain to me why mornings exist"</li><li>Start replying to comments on your own posts</li></ul>
      <h4>What NOT to do</h4>
      <ul><li>Do NOT post photos or videos yet</li><li>Do NOT add a link anywhere</li><li>Do NOT use hashtags</li><li>Do NOT follow more than 50 people total</li></ul>
    </div>
    <div class="guide-phase">
      <div class="guide-phase-title">Phase 3: Days 8–14 (Content Start)</div>
      <h4>What to do</h4>
      <ul><li>Post your first photo/video tweet (use your best content)</li><li>Post 1–2 media tweets per day</li><li>Continue writing 15–20 comments per day</li><li>Like 50–100 posts per day</li><li>Reply to anyone who comments on your posts</li></ul>
      <h4>What NOT to do</h4>
      <ul><li>Do NOT add a link yet (wait until day 15+)</li><li>Do NOT post more than 3 times per day</li><li>Do NOT mass-follow or mass-unfollow</li></ul>
    </div>
    <div class="guide-phase">
      <div class="guide-phase-title">Phase 4: Days 15–21 (Going Live)</div>
      <ul><li>Add your link-in-bio (link.me / linktr.ee)</li><li>Set up your pinned tweet</li><li>Increase to 3–5 posts per day</li><li>Post your first link as a REPLY to your own tweet (NEVER in the main tweet)</li><li>Start follower stealing (see Section G)</li><li>Start image commenting strategy (see Section H)</li><li>Maximum 1 link per day for the first week</li></ul>
    </div>
    <div class="guide-phase">
      <div class="guide-phase-title">Phase 5: Day 22+ (Full Operation)</div>
      <ul><li>You are now fully warmed up</li><li>Follow the daily posting schedule in Section F</li><li>Maximum 2 links per day</li><li>Full interaction strategy</li></ul>
    </div>
  `;

  const secD = `
    <p>Twitter shadowbans are more common and harder to detect than Threads restrictions. A shadowbanned account looks normal to you, but your tweets are invisible to everyone else.</p>
    <h3>Daily Limits — NEVER Exceed These</h3>
    ${tbl(['Action','During Warm-Up','After Warm-Up','Hard Limit'],[
      ['Follows','15/day','50/day','Never &gt;100/day'],
      ['Likes','50/day','200/day','Never &gt;100/hour'],
      ['Comments/Replies','15/day','50/day','Never &gt;30/hour'],
      ['Posts','2–3/day','5/day','Never &gt;15/day'],
      ['Links','0','2/day','Never &gt;2/day'],
      ['Unfollows','0','20/day','Never &gt;50/day'],
    ])}
    <h3>What Causes a Shadowban:</h3>
    <ul>
      <li>Posting links in main tweets (especially on new accounts)</li>
      <li>Mass-following or mass-unfollowing</li>
      <li>Too many likes in a short time</li>
      <li>Posting the exact same text multiple times</li>
      <li>Using more than 2 hashtags</li>
      <li>Using oversaturated hashtags (#OnlyFans, #porn, #nsfw)</li>
      <li>Using ALL CAPS in tweets</li>
      <li>Having third-party apps connected to your account</li>
      <li>Negative, aggressive, or combative tweets (Grok AI detects this!)</li>
      <li>Posting the same photo with the same caption across multiple accounts</li>
    </ul>
    <h3>How to Detect a Shadowban:</h3>
    <ol><li>Go to <strong>shadowban.eu</strong> and check your account</li><li>Open a private/incognito browser, go to x.com and search for your exact tweet text. If it doesn't appear, you are shadowbanned.</li></ol>
    <h3>What to Do if Shadowbanned:</h3>
    <ol>
      <li><strong>STOP everything</strong> for 24–72 hours (no likes, no follows, no posts)</li>
      <li>After the cooldown: Only write genuine comments and replies for 2 days (no links)</li>
      <li>Post quote retweets and photos without links to appear human</li>
      <li>Slowly return to normal activity</li>
      <li>If the shadowban persists after 72 hours, contact us</li>
    </ol>
    ${warnBox('<strong>Always let us know immediately if you suspect a shadowban</strong> so we can assess the situation and adjust.')}
  `;

  const secE = `
    ${warnBox('<strong>NEVER put a link in your main tweet. EVER.</strong> Since March 2025, Twitter penalizes any tweet with an external link by reducing its reach by 30–50%.', true)}
    <h3>The Correct Way to Post Links:</h3>
    <p><strong>Step 1:</strong> Post your tweet with the photo/video and caption. No link.</p>
    <p><strong>Step 2:</strong> Immediately reply to your own tweet with the link.</p>
    ${codeBlock(['Main tweet: "am i your type? (be honest) 🖤" + [photo]','Reply to own tweet: "more of me here ↓ [link]"'], 'Example')}
    <h3>Link Rules:</h3>
    <ul>
      <li>Maximum 2 links per day on the entire account</li>
      <li>Links only as replies to your own tweets</li>
      <li>Or let people find the link in your bio (that's what the arrow ↓ in your bio is for)</li>
      <li>NEVER write "link in bio" in your main tweet (this also hurts reach)</li>
      <li>Use soft language: "more of me ↓" or "full set here ↓" or just the link with no text</li>
    </ul>
  `;

  const secF = `
    <h3>How Many Posts Per Day:</h3>
    <ul><li><strong>5 posts per day</strong> (same as Threads)</li><li>Space them 2–3 hours apart</li><li>Do NOT post 5 times in 30 minutes</li></ul>
    <h3>The 90/10 Rule:</h3>
    <ul>
      <li><strong>90% of your tweets</strong> should be organic (personality, engagement bait, lifestyle, humor)</li>
      <li><strong>10% of your tweets</strong> should be promotional (with a link in the reply)</li>
      <li>Out of 5 daily posts, only 1 should have a link reply. The other 4 are pure engagement.</li>
    </ul>
    <h3>Content Types to Post (SFW Only):</h3>
    <p><strong>Photos:</strong> Bikini/lingerie · Cosplay · Lifestyle selfies (good lighting!) · Fitness · Beach/pool · Mirror selfies (bright)</p>
    <p><strong>Videos:</strong> Short clips (5–15s) · "Get ready with me" · Dancing/moving · Behind-the-scenes · Always under 2 min 20 sec</p>
    <p><strong>Text-only:</strong> Funny thoughts · Opinions on trending topics · Relatable moments · Personality-building</p>
    ${warnBox('<strong>NEVER post:</strong> Explicit nudity · Price lists · Spam hashtag lists · "Subscribe to my OF/Fansly" type tweets · The exact same content that\'s on your paid page')}
    <h3>Best Posting Times:</h3>
    <ul>
      <li><strong>Tuesday to Thursday, 9 AM – 3 PM</strong> (US Eastern Time)</li>
      <li><strong>Evening:</strong> 8–10 PM (US Eastern Time) for NSFW audience</li>
      <li><strong>Avoid:</strong> Saturday/Sunday late night</li>
      <li><strong>Avoid:</strong> 3–5 PM weekdays</li>
    </ul>
    <h3>The Posting Routine (Before and After Each Post):</h3>
    <p><strong>2–3 minutes BEFORE posting:</strong></p>
    <ul><li>Like and reply to comments under your previous posts</li><li>Scroll the For You page and like 3–5 posts</li></ul>
    <p><strong>POST your tweet</strong></p>
    <p><strong>3–5 minutes AFTER posting:</strong></p>
    <ul><li>Scroll the For You page for 3 minutes</li><li>Comment on 1–2 other creators' posts</li><li>Follow 1–2 new creators (max)</li><li>Do 3–5 follower steals (see Section G)</li><li>Like 5–10 posts</li></ul>
    ${warnBox('<strong>This before/after routine is CRITICAL until you reach 1,000–2,000 followers.</strong> After 5,000–10,000 followers, the interaction is less important because your account has enough organic reach.')}
  `;

  const secG = `
    <p>This works exactly the same as on Threads. You steal followers from other creators' viral posts.</p>
    <h3>Step 1: Find Good Posts</h3>
    <ul><li>Have 500+ likes</li><li>From a creator with under 100K followers</li><li>Have recent comments (within the last few hours)</li><li>Have comments with fewer than 10 likes (otherwise too competitive)</li></ul>
    <h3>Step 2: Find Good Users in the Comments</h3>
    <ul><li>Older than 25</li><li>Looks American (American name, English comments)</li><li>Has their own posts on their profile (not just replies)</li><li>Has a profile picture</li></ul>
    <h3>Step 3: Interact</h3>
    <ol><li>Follow them</li><li>Like their comment</li><li>Go to their profile</li><li>If they have their own posts, comment on one of them</li><li>Something genuine like "love this!" or "that's awesome"</li></ol>
    <p><strong>90% of the time, they will follow you back</strong> because you showed genuine interest in them.</p>
    <h3>Limits:</h3>
    <ul><li>Maximum 5 follower steals per posting round</li><li>Only target US-based users</li><li>Only interact with English-language comments</li><li>Do NOT write "follow me" or anything promotional</li></ul>
  `;

  const secH = `
    <p>This is the most powerful growth tactic on Twitter. It works even better than on Threads because Premium comments get priority placement.</p>
    <h3>How It Works:</h3>
    <p>Instead of writing a text comment on a viral post, you reply with a photo or video of your creator. This gets WAY more attention than a text comment.</p>
    <h3>Step 1: Find Viral Posts</h3>
    <ul><li>Posts with 1,000+ likes that are less than 20 hours old</li><li>From creators with 10K–200K followers</li><li>The post should still be gaining likes (growing, not dying)</li></ul>
    <h3>Step 2: Post Your Image Comment</h3>
    <p>Reply to the viral post with one of your best photos + a short, relevant caption that relates to the original post.</p>
    ${codeBlock(["Original post: \"Do I look cute today?\"","Your image reply: [creator's best photo] + \"we could be twins 😭\""], 'Example')}
    <h3>Step 3: Boost Your Comment</h3>
    <ul><li>Like your own comment with your other accounts</li><li>This gives it a small initial boost</li><li>If it rises to become a top comment, it gets massive visibility</li></ul>
    <h3>Rules:</h3>
    <ul><li>Only comment on posts gaining momentum (1K+ likes in under 20 hours)</li><li>Don't write anything promotional ("follow me", "check my link")</li><li>Be genuine and on-topic</li><li>Maximum 10 image comments per day</li><li>Use different photos each time</li></ul>
  `;

  const secI = `
    <p>We analyzed 4,996 tweets from 226 successful creators. Here are the exact captions and patterns that perform best.</p>
    <h3>Rule #1: Keep It Short</h3>
    <ul><li>Captions under 25 characters get <strong>3x more engagement</strong> than captions over 60 characters</li><li>The sweet spot is 10–25 characters</li><li>If you can say it in 3 words, don't use 10</li></ul>
    <h3>Rule #2: Ask Questions</h3>
    <ul><li>Questions get <strong>50% more engagement</strong> than statements</li><li>Adding "(be honest)" to any question boosts it significantly</li><li>Questions invite replies, and replies are the most valuable signal</li></ul>
    <h3>Tier 1 — Best Performing Templates:</h3>
    ${codeBlock([
      '"am i your type? (be honest)"  → 36,116 likes',
      '"taking bf applications rn"  → 35,019 likes',
      '"smash or pass (be honest)"  → 13,806 likes',
      '"Rate my [body part] 1-10"  → 9,113 likes',
      '"eyes up here pretty boy"  → 15,539 likes',
      '"good morning [emoji]"  → 11,736 likes',
      '"Describe me in 1 word"  → 6,967 likes',
      '"Yes or no to my body type? Be honest"  → 12,968 likes',
      '"Do you like [trait] girls?"  → 13,062 likes',
      '"Caught u staring again"  → 7,490 likes',
      '"me or your wife?"  → 15,645 likes',
    ], 'Tier 1 — Best Performing Templates')}
    <h3>Tier 2 — Strong Templates:</h3>
    ${codeBlock([
      '"would you [action]?"','"this is what [X] looks like :D"','"still single btw"',
      '"who wants to get [action]"','"1 or 2?" / "1 2 3 or 4?"','"hey cutie"',
      '"too small or just right?"','"A little motivation [emoji]"',
      '"What kind of day does this remind you of?"','"Taste or pass?"','"hi [emoji]"',
      '"[cosplay character name] [emoji]"',
    ], 'Tier 2 — Strong Templates')}
    <h3>Tier 3 — Personality/Humor (1–2x per day):</h3>
    ${codeBlock([
      '"my kink is complete devotion and obsession"','"lord have mercy..."',
      '"bouncy boobas"','"giggle maxing"','"This is frying me"',
      '"Where did my car seat go?" (funny/unexpected)',
    ], 'Tier 3 — Personality / Humor')}
    <h3>Tier 4 — FOMO/DM Bait (max 1x per day):</h3>
    ${codeBlock([
      '"deleting in [X] hours, say \'me\' for a special dm"',
      '"say hi for a surprise in dms"',
      '"reply \'yes\' for a surprise dm (i\'m serious)"',
      '"if you\'re not a bot, say hi. i\'ll follow back"',
    ], 'Tier 4 — FOMO / DM Bait')}
    ${warnBox('<strong>IMPORTANT about DM bait:</strong> If you use these, you MUST actually follow through. If someone says "me" or "hi", send them something (even just "hey ❤" with a link). Otherwise people will stop engaging.')}
    <h3>Caption Don\'ts:</h3>
    <ul><li>Do NOT write long paragraphs</li><li>Do NOT use more than 2 emojis</li><li>Do NOT include links in the caption</li><li>Do NOT use hashtag lists</li><li>Do NOT write prices</li><li>Do NOT write "link in bio"</li><li>Do NOT copy-paste the exact same caption every day (vary it!)</li></ul>
  `;

  const secJ = `
    <p>Depending on your follower count, different numbers count as viral:</p>
    ${tbl(['Followers','Viral ='],[
      ['0–500','500+ likes'],['500–1,000','750+ likes'],['1,000–5,000','1,500+ likes'],
      ['5,000–10,000','3,000+ likes'],['10,000+','5,000+ likes'],
    ])}
    <h3>When a Post Goes Viral:</h3>
    <ol>
      <li>Send a screenshot to the "Viral Posts" group immediately</li>
      <li>Do NOT delete the post</li>
      <li>Reply to as many comments as possible (this feeds the algorithm)</li>
      <li>Post a follow-up tweet 1–2 hours later to capture the new visitors</li>
      <li>Make sure your pinned tweet and bio/link are perfect</li>
    </ol>
  `;

  const secK = `
    <h3>Rules:</h3>
    <ul><li><strong>Maximum 1–2 hashtags per tweet</strong></li><li>More than 2 hashtags = 40% reach PENALTY</li><li>Only use niche-specific hashtags, NEVER generic ones</li></ul>
    <h3>Good Hashtags (use sparingly, rotate):</h3>
    ${codeBlock(['#cosplay (if doing cosplay content)','#lingerie','#model','#fitness (if fitness niche)','#gamergirllife','#egirl'], 'Good Hashtags')}
    <h3>BAD Hashtags — Never Use These:</h3>
    ${warnBox('<strong>NEVER USE:</strong> #OnlyFans · #OF · #porn · #nsfw · #fansly · #sexwork · #sw — Oversaturated with bots and spam. They attract the wrong audience and may trigger a shadowban.', true)}
    <h3>When to Use Hashtags:</h3>
    <ul><li>When something is trending and you can post something relevant</li><li>Only if the hashtag adds context, not as spam</li><li>Most of your tweets should have ZERO hashtags</li></ul>
  `;

  const secL = `
    <p>Same as Threads: bots in your comments are GOOD for us.</p>
    <h3>Why Bots Are Good:</h3>
    <ul><li>Bot comments mean your post is being shown on the For You page</li><li>More comments = more engagement = more reach</li><li>Bots bring interaction that can make posts go viral</li></ul>
    ${warnBox('<strong>NEVER block bots · NEVER delete bot comments</strong> · Give bot comments a like (boosts interaction count) · Ignore the content of bot comments (they\'re usually scams)')}
  `;

  const secM = `
    <h3>Reduced Interaction Time:</h3>
    <ul><li>Before/after post routine goes from 5 minutes to 2–3 minutes</li><li>Reduce daily comments from 30+ to 15–20</li><li>Focus more on quality posts and less on manual interaction</li></ul>
    <h3>New Tactics:</h3>
    <ul><li>Start looking for SFS (Shoutout for Shoutout) partners</li><li>Join 2–3 retweet groups (Telegram/Discord)</li><li>Start posting threads (multiple connected tweets — 3x more engagement)</li><li>Consider starting a second backup account</li></ul>
    <h3>SFS (Shoutout for Shoutout):</h3>
    <p>Find SFS partners by searching: "sw sfs" · "onlyfans sfs" · "s4s" · "swrt" (sex worker retweet). Click "Latest" tab to find active creators.</p>
    <p><strong>Rules for SFS:</strong></p>
    <ul><li>Partner with creators in a similar niche and similar follower count</li><li>Maximum 3–5 SFS groups at a time</li><li>All members must retweet within 15 minutes</li><li>Don't ONLY do SFS content — mix it with organic posts</li></ul>
  `;

  const secN = `
    <p>At 5,000+ followers:</p>
    <ul>
      <li>Interaction is less critical (account has organic reach)</li>
      <li>Increase posting if you want (up to 8–10 posts per day)</li>
      <li>Start automating scheduling with Buffer or similar tools</li>
      <li>Consider paid SFS with larger creators</li>
      <li>Cross-promote between multiple accounts</li>
    </ul>
  `;

  const secO = `
    <div class="guide-phase">
      <div class="guide-phase-title">Step 1: Clean Up</div>
      <ul><li>Delete all poorly performing posts (keep viral ones with 1K+ likes)</li><li>Update bio and profile picture</li></ul>
    </div>
    <div class="guide-phase">
      <div class="guide-phase-title">Step 2: Rest and Steal</div>
      <ul><li>Let the account rest for 24 hours (no posts)</li><li>Focus entirely on follower stealing</li><li>Try to gain at least 200 new followers through interaction</li></ul>
    </div>
    <div class="guide-phase">
      <div class="guide-phase-title">Step 3: Soft Restart</div>
      <ul><li>After 24 hours, post only 1 post per day for 3 days</li><li>Make sure it's your best content</li><li>After 3 days, return to normal schedule</li></ul>
    </div>
    <div class="guide-phase">
      <div class="guide-phase-title">Step 4: If It's Still Dead</div>
      <ul><li>Reduce posting from 5 to 3 posts per day</li><li>Change the bio and profile picture</li><li>Focus heavily on commenting strategy for 1 week</li><li>Contact us if nothing works after 1 week</li></ul>
    </div>
  `;

  const secP = `
    <p>If you see a pattern like this:</p>
    ${codeBlock(['Post 1: 500 likes','Post 2: 300 likes','Post 3: 20 likes','Post 4: 10 likes'], 'Example Drop Pattern')}
    <p>Something happened between Post 2 and Post 3. Your account may have been restricted.</p>
    <h3>Steps:</h3>
    <ol>
      <li><strong>Check shadowban.eu</strong> to see if you're shadowbanned</li>
      <li><strong>Delete the posts</strong> that were published on the day the drop started</li>
      <li><strong>Reduce</strong> posting from 5 to 3 per day</li>
      <li><strong>Wait 72 hours</strong> and monitor performance</li>
      <li><strong>During the 72 hours:</strong> Focus on follower stealing and genuine comments</li>
      <li><strong>After 72 hours:</strong> Return to normal posting</li>
      <li><strong>If it doesn't improve:</strong> Contact us for help</li>
    </ol>
  `;

  const secQ = `
    <p>Tweet threads are a series of connected tweets that tell a story or build up to something. They get <strong>3x more engagement</strong> than single tweets.</p>
    <h3>When to Use Threads:</h3>
    <ul><li>When you have multiple photos from one set</li><li>For "transformation" or "before/after" content</li><li>For storytelling</li><li>For building anticipation</li></ul>
    <h3>Thread Structure:</h3>
    ${codeBlock([
      'Tweet 1 (Hook): Bold statement + best photo — "you\'re not ready for this..."',
      'Tweet 2: Another photo + building anticipation — "getting closer..."',
      'Tweet 3: The payoff photo — "told you 😏"',
      'Tweet 4 (optional): Link as reply — "more like this ↓ [link]"',
    ], 'Thread Structure')}
    <h3>Thread Rules:</h3>
    <ul><li>Maximum 3–5 tweets per thread</li><li>Each tweet should have a photo/video</li><li>The first tweet MUST have a strong hook</li><li>The link goes in the LAST tweet or as a reply</li><li>Don't make threads longer than 5 tweets (people lose interest)</li></ul>
  `;

  const secR = `
    <h3>Why:</h3>
    <ul><li>If your main gets banned, you don't lose everything</li><li>You can cross-promote between accounts</li><li>"5 accounts with 10K each is better than 1 account with 50K" (less risk)</li></ul>
    <h3>Setup:</h3>
    <ul><li>Different username but mention each other in bios</li><li>Example: Main bio says "backup @creatorbackup" | Backup bio says "main @creatormain"</li><li>Use different content on each (don't duplicate everything)</li><li>Each account needs its own email and phone number</li></ul>
  `;

  const secS = `
    <h3>Daily Tasks</h3>
    ${checklist([
      '5 posts (90% organic, 10% promo with link in reply)',
      '2–3 min interaction before and after each post',
      "15–30 comments on other creators' posts",
      '5–10 follower steals per posting round',
      '50–100 likes distributed throughout the day',
      'Reply to all comments on your posts',
    ], 'daily')}
    <h3>Weekly Tasks</h3>
    ${checklist([
      'Check shadowban.eu for all accounts',
      'Review which posts performed best this week',
      'Check follower growth (track in spreadsheet)',
      'Update pinned tweet if a better post exists',
      'Check if any SFS opportunities are available',
      'Report any account issues to the team',
    ], 'weekly')}
    <h3>Monthly Tasks</h3>
    ${checklist([
      'Review overall growth trend',
      'Refresh bio if needed',
      'Update profile picture if needed',
      'Clean up underperforming posts',
      'Evaluate and adjust posting strategy based on what worked',
    ], 'monthly')}
  `;

  const rules = [
    { title: 'X Premium is mandatory', desc: 'No Premium = no reach. $8/month is non-negotiable.' },
    { title: 'NEVER put a link in your main tweet', desc: 'Always post the link as a reply to your own tweet.' },
    { title: 'Replies are 150x more valuable than likes', desc: 'Focus on getting replies — they drive the algorithm.' },
    { title: 'Keep captions SHORT', desc: 'Under 25 characters is best. Less is always more.' },
    { title: 'Ask questions', desc: 'Questions get 50% more engagement than statements.' },
    { title: 'First 30 minutes decide everything', desc: 'Engage immediately after posting — this is critical.' },
    { title: 'Maximum 2 links per day', desc: 'On the entire account, not per post.' },
    { title: 'Maximum 1–2 hashtags', desc: 'More than 2 = 40% reach penalty.' },
    { title: "Tease, don't show", desc: 'Keep the fantasy gap for your paid content.' },
    { title: 'Warm up for 7–21 days', desc: "Don't rush new accounts or you'll get shadowbanned." },
    { title: 'Maximum 50 replies per day', desc: 'More = shadowban risk. Stay within limits.' },
    { title: 'Image comments on viral posts', desc: 'Strongest growth tactic on the platform.' },
    { title: 'Always have a backup account', desc: 'Bans happen. Be prepared.' },
    { title: 'Stay positive in tone', desc: 'Grok AI penalizes negative, aggressive content.' },
    { title: 'Watermark all your images', desc: "Add the creator's handle or domain to every image." },
  ];
  const secT = `
    <p>Print this out and keep it next to your screen.</p>
    <div class="guide-rules-grid">
      ${rules.map((r, i) => `<div class="guide-rule-card"><div class="guide-rule-num">${i + 1}</div><div class="guide-rule-text"><strong>${escHtml(r.title)}</strong>${escHtml(r.desc)}</div></div>`).join('')}
    </div>
  `;

  const secU = `
    ${warnBox('<strong>Shadowban detected:</strong> Notify team immediately in the group. Pause all activity.', true)}
    ${warnBox('<strong>Account suspended:</strong> Notify team with a screenshot. Do NOT create a new account without permission.', true)}
    ${warnBox('<strong>Restriction received:</strong> Notify team. Follow the cooldown procedure in Section D.')}
    ${warnBox('<strong>Post goes viral:</strong> Send screenshot to "Viral Posts" group. Keep engaging with comments.')}
    ${warnBox('<strong>Unsure about something:</strong> Ask in the team group before acting. When in doubt, do less rather than more.')}
  `;

  const secV = `
    <p>80+ tested captions sorted by category. Rotate through these and never use the same caption twice in one week.</p>
    <div class="guide-caption-cat">
      <h4>Engagement Questions</h4>
      ${captionItems(['am i your type? (be honest)','smash or pass (be honest)','Yes or no to my body type? Be honest','Rate my [arch/waist/figure] 1-10','Do you like [tattooed/redhead/short/tall] girls?','Describe me in 1 word','what would you do?','would you [kiss me/take me out/hold my hand]?','me or your wife?','me or $5 mil?','Taste or pass?','1 or 2?','too small or just right?','Caught u staring again','Stop scrolling and rate me','Who wants to get [crushed/hugged]?','Can you handle this?','girlfriend or wife?'])}
    </div>
    <div class="guide-caption-cat">
      <h4>Short &amp; Sweet</h4>
      ${captionItems(['hey cutie','hi ♡','good morning ☀️','good night 🌙','bouncy','lord have mercy...','enjoy :)','lace','WHOA','OH NO','watch again','hey x ♡'])}
    </div>
    <div class="guide-caption-cat">
      <h4>Boyfriend / Girlfriend Energy</h4>
      ${captionItems(['taking bf applications rn','taking boyfriend applications ↓','still single btw',"who needs a gf for christmas? say 'me'",'first date where are we going?','hey (with intentions to talk every day and cuddle)',"i'm ur e-girlfriend now, no takebacks"])}
    </div>
    <div class="guide-caption-cat">
      <h4>Personality / Humor</h4>
      ${captionItems(['my kink is complete devotion and obsession','This is frying me','Where did my car seat go?','giggle maxing','this is what [X]lbs looks like :D','imagine hating tummy!?','Heard u like abs','right side enjoyers come here','pspspsps come here loser'])}
    </div>
    <div class="guide-caption-cat">
      <h4>Tease / Suggestive</h4>
      ${captionItems(['eyes up here pretty boy','I know what you\'re looking at 🖤','Your knees hurt yet?','A little motivation ♡','you\'ll want sound on for this video','just studying 📚','is pink my color?','What kind of day does this picture remind you of?','let me know if you have any questions'])}
    </div>
    <div class="guide-caption-cat">
      <h4>FOMO / DM Bait (max 1x per day)</h4>
      ${captionItems(["deleting in [X] hours, say 'me' for a special dm","say hi for a surprise in dms","reply 'yes' for a surprise dm (i'm serious)","if you're not a bot, say hi. i'll follow back immediately","don't open the comments","I dare you to open the comments"])}
    </div>
    <div class="guide-caption-cat">
      <h4>Cosplay / Character</h4>
      ${captionItems(['[Character Name] [emoji]','Mother Makima','Nico Robin 🤲','who wants [character name]?'])}
    </div>
    <div class="guide-caption-cat">
      <h4>Body Count / Viral Format</h4>
      ${captionItems(['my body count history: 2011: 0 2012: 0 2013: 0 ...show more','body count: 2020: 0 2021:0 2022: 0 2023: 0 2024: 1 ...show more'])}
    </div>
  `;

  // ── Build sections list ────────────────────────────────────────────
  const sections = [
    { id: 'a', l: 'A', t: 'Threads vs Twitter/X',          b: secA, open: true  },
    { id: 'b', l: 'B', t: 'Account Setup',                 b: secB              },
    { id: 'c', l: 'C', t: 'Account Warm-Up',               b: secC              },
    { id: 'd', l: 'D', t: 'Avoiding Restrictions',         b: secD              },
    { id: 'e', l: 'E', t: 'The Link Rule (CRITICAL)',      b: secE              },
    { id: 'f', l: 'F', t: 'Daily Posting Schedule',        b: secF              },
    { id: 'g', l: 'G', t: 'Follower Stealing',             b: secG              },
    { id: 'h', l: 'H', t: 'Image Commenting Strategy',     b: secH              },
    { id: 'i', l: 'I', t: 'Caption Strategy',              b: secI              },
    { id: 'j', l: 'J', t: 'What Counts as Viral',          b: secJ              },
    { id: 'k', l: 'K', t: 'Hashtag Strategy',              b: secK              },
    { id: 'l', l: 'L', t: 'Dealing with Bots',             b: secL              },
    { id: 'm', l: 'M', t: 'Growing Beyond 1,000 Followers',b: secM              },
    { id: 'n', l: 'N', t: 'Growing Beyond 5,000 Followers',b: secN              },
    { id: 'o', l: 'O', t: 'If an Account Dies',            b: secO              },
    { id: 'p', l: 'P', t: 'If Likes Drop Suddenly',        b: secP              },
    { id: 'q', l: 'Q', t: 'Tweet Threads Strategy',        b: secQ              },
    { id: 'r', l: 'R', t: 'Backup Accounts',               b: secR              },
    { id: 's', l: 'S', t: 'Weekly/Monthly Checklist',      b: secS              },
    { id: 't', l: 'T', t: '15 Golden Rules',               b: secT              },
    { id: 'u', l: 'U', t: 'Emergency Contacts',            b: secU              },
    { id: 'v', l: 'V', t: 'Caption Bank (80+ captions)',   b: secV              },
  ];

  // ── TOC ────────────────────────────────────────────────────────────
  const tocLinks = sections.map(s =>
    `<a class="guide-toc-link" href="#gs-${s.id}" onclick="event.preventDefault();(function(){var el=document.getElementById('gs-${s.id}');el.classList.add('open');el.scrollIntoView({behavior:'smooth',block:'start'})})()"><strong>${s.l}.</strong> ${escHtml(s.t)}</a>`
  ).join('');

  // ── Sections HTML ──────────────────────────────────────────────────
  const sectionsHtml = sections.map(s => sec(s.id, s.l, s.t, s.b, s.open)).join('');

  el.innerHTML = `
    <div class="guide-wrap">
      <div class="guide-search-wrap">
        <input class="guide-search-input" type="text" placeholder="Search the guide..." id="guide-search-input" oninput="guideSearch(this.value)">
      </div>
      <div class="guide-toc">
        <h3>Table of Contents</h3>
        <div class="guide-toc-grid">${tocLinks}</div>
      </div>
      <div id="guide-sections">${sectionsHtml}</div>
      <p id="guide-no-results" class="guide-no-results" style="display:none">No sections match your search.</p>
    </div>
  `;

  el.dataset.rendered = '1';
}

// ─── GUIDE SEARCH ────────────────────────────────────────────────────
function guideSearch(query) {
  const q = query.trim().toLowerCase();
  const sections = document.querySelectorAll('#guide-sections .guide-section');
  let anyVisible = false;
  sections.forEach(s => {
    if (!q) { s.classList.remove('search-hidden'); anyVisible = true; return; }
    const title = (s.dataset.sectionTitle || '').toLowerCase();
    const body  = (s.querySelector('.guide-section-body') || {}).textContent || '';
    const match = title.includes(q) || body.toLowerCase().includes(q);
    s.classList.toggle('search-hidden', !match);
    if (match) { anyVisible = true; s.classList.add('open'); }
  });
  const nr = document.getElementById('guide-no-results');
  if (nr) nr.style.display = (q && !anyVisible) ? 'block' : 'none';
}

// ─── LAZY IMAGES ────────────────────────────────────────────────────
let lazyObserver = null;

// ─── Video Autoplay on Visible (IntersectionObserver) — same as IG Intel ───
const videoObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const video = entry.target;
    if (entry.isIntersecting) {
      if (!video.src && video.dataset.src) {
        video.src = video.dataset.src;
      }
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  });
}, { rootMargin: '100px', threshold: 0.25 });

function observeVideos() {
  document.querySelectorAll('.post-card video[data-src]').forEach(v => {
    if (!v._observed) {
      v._observed = true;
      videoObserver.observe(v);
    }
  });
}

function toggleVideoSound(btn) {
  const video = btn.closest('.post-card-media').querySelector('video');
  if (!video) return;
  video.muted = !video.muted;
  btn.innerHTML = video.muted ? '&#128264;' : '&#128266;';
}

// Legacy compat — called in several places
function initLazyImages() {
  observeVideos();
}

// ─── AVATAR COLOR HELPERS ────────────────────────────────────────────
function stringToColor(str) {
  if (!str) return 'rgba(29,155,240,0.3)';
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const colors = ['rgba(29,155,240,0.4)', 'rgba(120,86,255,0.4)', 'rgba(249,24,128,0.4)',
                  'rgba(0,186,124,0.4)', 'rgba(255,122,0,0.4)', 'rgba(0,212,255,0.4)'];
  return colors[Math.abs(hash) % colors.length];
}

function stringToColor2(str) {
  if (!str) return 'rgba(120,86,255,0.3)';
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (str.charCodeAt(i) * 31 + hash) | 0;
  const colors = ['rgba(120,86,255,0.4)', 'rgba(0,186,124,0.4)', 'rgba(29,155,240,0.4)',
                  'rgba(249,24,128,0.4)', 'rgba(0,212,255,0.4)', 'rgba(255,122,0,0.4)'];
  return colors[Math.abs(hash) % colors.length];
}

// ─── SVG ICONS ───────────────────────────────────────────────────────
function heartSvg() {
  return `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.638h-.014C9.403 21.59 1.95 14.856 1.95 8.478c0-3.064 2.523-5.772 5.476-5.772 2.084 0 3.827 1.11 4.573 2.777.75-1.667 2.493-2.777 4.577-2.777 2.952 0 5.475 2.708 5.475 5.772 0 6.376-7.454 13.11-10.036 13.16H12z"/></svg>`;
}

function eyeSvg() {
  return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function bookmarkSvg() {
  return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
}

function retweetSvg() {
  return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
}

// ─── EVENT LISTENERS SETUP ──────────────────────────────────────────
function bindEvents() {
  // Login form
  $('#login-form').addEventListener('submit', e => { e.preventDefault(); login(); });

  // Logout
  $('#logout-btn').addEventListener('click', logout);

  // Tab nav
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.tab));
  });

  // Browser back/forward
  window.addEventListener('popstate', () => {
    const tab = location.hash.replace('#', '') || 'dashboard';
    navigateTo(tab, false);
  });

  // Scrape controls
  if ($('#btn-scrape-full')) {
    $('#btn-scrape-full').addEventListener('click', () => startScrape('full'));
    $('#btn-scrape-new').addEventListener('click', () => startScrape('new-only'));
    $('#btn-scrape-refresh').addEventListener('click', () => startScrape('refresh'));
    $('#btn-scrape-stop').addEventListener('click', stopScrape);
    $('#refresh-jobs-btn').addEventListener('click', () => { cacheClear('scrape_jobs'); loadJobs(); });
  }

  // Creators search (debounced)
  const creatorsSearchFn = debounce(() => { cacheClear('creators_'); loadCreators(); }, 300);
  $('#creators-search').addEventListener('input', creatorsSearchFn);

  // Creators sort dropdown
  $('#creators-sort').addEventListener('change', () => { cacheClear('creators_'); loadCreators(); });

  // Photos tab filters
  bindViralFilters('photos');
  bindViralFilters('videos');
  bindViralFilters('text');

  // Load more buttons
  $('#photos-load-more').addEventListener('click', () => {
    loadViralTab('photos', state.pages.photos, true);
  });
  $('#videos-load-more').addEventListener('click', () => {
    loadViralTab('videos', state.pages.videos, true);
  });
  $('#text-load-more').addEventListener('click', () => {
    loadViralTab('text', state.pages.text, true);
  });

  // Post modal close
  $('#post-modal-close').addEventListener('click', closePostModal);
  $('#post-modal').addEventListener('click', e => { if (e.target === $('#post-modal')) closePostModal(); });

  // Creator modal close
  $('#creator-modal-close').addEventListener('click', closeCreatorModal);
  $('#creator-modal').addEventListener('click', e => { if (e.target === $('#creator-modal')) closeCreatorModal(); });

  // Creator modal tabs
  $$('.creator-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.creator-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      state.activeCreatorType = btn.dataset.ctype;
      if (state.activeCreator) {
        loadCreatorPosts(state.activeCreator.id, state.activeCreatorType);
      }
    });
  });

  // Add tab
  $('#add-single-btn').addEventListener('click', addSingle);
  $('#add-bulk-btn').addEventListener('click', addBulk);
  $('#add-single-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addSingle();
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#post-modal').classList.contains('hidden'))    closePostModal();
      if (!$('#creator-modal').classList.contains('hidden')) closeCreatorModal();
    }
  });
}

function bindViralFilters(tab) {
  const cfg = tabConfig[tab];
  const reloadFn = () => { cacheClear(`viral_${tab}_`); loadViralTab(tab, 1, false); };
  const debouncedReload = debounce(reloadFn, 300);

  // Period pill buttons
  $$(`#${cfg.periodBtns} .period-btn`).forEach(btn => {
    btn.addEventListener('click', () => {
      $$(`#${cfg.periodBtns} .period-btn`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      reloadFn();
    });
  });
  // Multiplier pill buttons
  $$(`#${cfg.multBtns} .period-btn`).forEach(btn => {
    btn.addEventListener('click', () => {
      $$(`#${cfg.multBtns} .period-btn`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      reloadFn();
    });
  });
  $(`#${cfg.sortId}`).addEventListener('change', reloadFn);
  $(`#${cfg.searchId}`).addEventListener('input', debouncedReload);
}

function closePostModal() {
  $('#post-modal').classList.add('hidden');
  $('#post-modal').classList.remove('active');
}

function closeCreatorModal() {
  $('#creator-modal').classList.add('hidden');
  $('#creator-modal').classList.remove('active');
  state.activeCreator = null;
}

// ─── BOOTSTRAP ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  bindEvents();

  if (state.token && state.role) {
    initApp();
  }
  // else login modal is already visible (default in HTML)
});
