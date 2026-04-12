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
    periodId:   'photos-period',
    sortId:     'photos-sort',
    multId:     'photos-mult',
    searchId:   'photos-search',
  },
  videos: {
    mediaType:  'video',
    gridId:     'videos-grid',
    countId:    'videos-count',
    loadMoreId: 'videos-load-more',
    periodId:   'videos-period',
    sortId:     'videos-sort',
    multId:     'videos-mult',
    searchId:   'videos-search',
  },
  text: {
    mediaType:  'text',
    gridId:     'text-list',
    countId:    'text-count',
    loadMoreId: 'text-load-more',
    periodId:   'text-period',
    sortId:     'text-sort',
    multId:     'text-mult',
    searchId:   'text-search',
  },
};

async function loadViralTab(tab, page = 1, append = false) {
  const cfg     = tabConfig[tab];
  const grid    = $(`#${cfg.gridId}`);
  const loadBtn = $(`#${cfg.loadMoreId}`);
  const countEl = $(`#${cfg.countId}`);

  const period  = $(`#${cfg.periodId}`).value;
  const sort    = $(`#${cfg.sortId}`).value;
  const mult    = parseFloat($(`#${cfg.multId}`).value) || 0;
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

  let mediaHtml = '';
  if (hasMedia) {
    const imgUrl = post.media_url
      ? post.media_url
      : (isVideo ? `/api/thumbnails/${post.id}` : `/api/images/${post.id}`);
    mediaHtml = `
      <div class="post-card-media">
        <div class="media-placeholder">${isVideo ? '🎬' : '📸'}</div>
        <img class="img-lazy" data-src="${imgUrl}" src="" alt=""
             onerror="this.style.display='none'" />
        ${isVideo ? `<div class="video-play-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>` : ''}
        <div class="post-card-overlay">
          <div class="post-card-overlay-stats">
            <span class="overlay-stat">❤️ ${fmtNum(post.likes)}</span>
            ${post.views ? `<span class="overlay-stat">👁 ${fmtNum(post.views)}</span>` : ''}
          </div>
        </div>
        ${post.viral_mult ? `<div class="viral-badge">${multLabel(post.viral_mult)}</div>` : ''}
        <div class="media-type-badge">${mt}</div>
      </div>`;
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
      if (isVideo) {
        const thumb = post.media_url || post.thumbnail_url || `/api/thumbnails/${post.id}`;
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
  if (el.innerHTML.trim()) return; // already rendered
  el.innerHTML = `
    <div class="guide-placeholder">
      <div class="guide-icon">📖</div>
      <h3>Guide content will be added here</h3>
      <p>This section is reserved for operational documentation.<br>
         Content can be injected by setting <code>document.getElementById('guide-content').innerHTML</code>.</p>
    </div>
  `;
}

// ─── LAZY IMAGES ────────────────────────────────────────────────────
let lazyObserver = null;

function initLazyImages() {
  const imgs = $$('img.img-lazy[data-src]:not([src])');
  // Also re-check ones with src="" that haven't loaded
  const allLazy = $$('img.img-lazy[data-src]');

  if (!lazyObserver) {
    lazyObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          const src = img.dataset.src;
          if (src) {
            img.src = src;
            img.style.display = '';
            img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
            lazyObserver.unobserve(img);
          }
        }
      });
    }, { rootMargin: '200px' });
  }

  allLazy.forEach(img => lazyObserver.observe(img));
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

  $(`#${cfg.periodId}`).addEventListener('change', reloadFn);
  $(`#${cfg.sortId}`).addEventListener('change', reloadFn);
  $(`#${cfg.multId}`).addEventListener('change', reloadFn);
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
