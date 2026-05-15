/* ═══════════════════════════════════════════════════════════════════
   SA Pulse Forge — app.js v1
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
  lastScrapeRunning: false,
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
  if (res.status === 401) {
    // Don't surprise the user with a silent kick — explain why we're logging out.
    if (state.token) {
      toast('Session expired — please sign in again', 'info', 2200);
      setTimeout(logout, 1500);
    } else {
      logout();
    }
    return null;
  }
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
  const validTabs = ['dashboard', 'creators', 'photos', 'videos', 'text', 'bios', 'strategy', 'guide', 'add'];
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
    case 'bios':      loadBios(); break;
    case 'strategy':  renderStrategy(); break;
    case 'guide':     renderGuide(); break;
    case 'add':       /* static form, no load needed */ break;
  }
}

// ─── DASHBOARD ───────────────────────────────────────────────────────
async function loadDashboard() {
  loadStats();
  loadJobs();
  if (state.role === 'admin') {
    loadAutoRefresh();
    startPolling();
  }
}

async function loadStats() {
  try {
    const data = await apiGet('/api/dashboard/stats', 'dashboard_stats');
    if (!data) return;
    const viralTotal = (data.viral_photos ?? 0) + (data.viral_videos ?? 0) + (data.viral_texts ?? 0);
    $('#stat-creators').textContent     = fmtNum(data.total_accounts ?? 0);
    $('#stat-posts').textContent        = fmtNum(data.total_posts ?? 0);
    $('#stat-viral').textContent        = fmtNum(viralTotal);
    $('#stat-viral-photos').textContent = fmtNum(data.viral_photos ?? 0);
    $('#stat-viral-videos').textContent = fmtNum(data.viral_videos ?? 0);
    $('#stat-viral-text').textContent   = fmtNum(data.viral_texts ?? 0);
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
      const dur = j.completed_at && j.started_at
        ? fmtDuration((new Date(j.completed_at) - new Date(j.started_at)) / 1000)
        : j.started_at && j.status === 'running' ? 'Running…' : '—';
      return `<tr>
        <td>${j.id}</td>
        <td><span class="job-type">${escHtml(j.job_type || '—')}</span></td>
        <td><span class="status-badge ${j.status || 'idle'}">${escHtml(j.status || '—')}</span></td>
        <td>${fmtNum(j.processed_accounts)}</td>
        <td>${fmtNum(j.total_posts_found)}</td>
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
        const j = s.current_job;
        const pct = j.total_accounts > 0
          ? Math.round((j.processed_accounts / j.total_accounts) * 100)
          : 0;
        $('#progress-fill').style.width = `${pct}%`;
        $('#progress-text').textContent =
          `${fmtNum(j.processed_accounts || 0)} / ${fmtNum(j.total_accounts || 0)} accounts · ${pct}%`;
      }
      state.lastScrapeRunning = true;
    } else {
      const job = s.current_job;
      if (job) {
        const done = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
        badge.textContent = done ? (job.status[0].toUpperCase() + job.status.slice(1)) : (job.status || 'Idle');
        badge.className   = `status-badge ${job.status || 'idle'}`;
        if (done) {
          prog.classList.add('hidden');
          $('#progress-fill').style.width = '100%';
          // Only refresh tables on the running→done transition, not on every tick
          if (state.lastScrapeRunning) {
            cacheClear('scrape_jobs');
            cacheClear('dashboard_stats');
            loadStats();
            loadJobs();
          }
        }
      } else {
        badge.textContent = 'Idle';
        badge.className   = 'status-badge idle';
        prog.classList.add('hidden');
      }
      state.lastScrapeRunning = false;
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

async function loadAutoRefresh() {
  if (state.role !== 'admin') return;
  try {
    const data = await apiGet('/api/settings/auto-refresh');
    if (!data) return;
    const toggle = $('#auto-refresh-toggle');
    const sub    = $('#auto-refresh-sub');
    if (toggle) toggle.checked = !!data.enabled;
    if (sub) {
      const next = data.next_run ? new Date(data.next_run).toLocaleString() : '—';
      sub.textContent = `${data.schedule || '1st of month, 02:00 Europe/Berlin'} · 30-day window · next: ${next}`;
    }
  } catch (_) {}
}

async function toggleAutoRefresh(e) {
  const enabled = e.target.checked;
  try {
    const data = await apiPost(`/api/settings/auto-refresh?enabled=${enabled}`);
    if (!data) { e.target.checked = !enabled; return; }
    toast(enabled ? 'Auto-refresh enabled' : 'Auto-refresh disabled', 'success');
    loadAutoRefresh();
  } catch (err) {
    e.target.checked = !enabled;
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
      ? `<span class="verified-badge" title="Verified"><svg width="16" height="16" viewBox="0 0 24 24" fill="#635bff"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81C14.67 2.88 13.43 2 12 2s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91C2.88 9.33 2 10.57 2 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81C9.33 21.12 10.57 22 12 22s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91C21.12 14.67 22 13.43 22 12zm-6.28-1.72-4 5.5a.75.75 0 0 1-1.14.09l-2-2a.75.75 0 0 1 1.06-1.06l1.4 1.4 3.49-4.8a.75.75 0 0 1 1.19.87z"/></svg></span>`
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
      <td>${fmtNum(c.followers)}</td>
      <td>${fmtNum(c.avg_likes_30d)}</td>
      <td>${fmtNum(c.tweet_count)}</td>
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
          <span class="creator-stat"><strong>${fmtNum(c.followers)}</strong> followers</span>
          <span class="creator-stat"><strong>${fmtNum(c.tweet_count)}</strong> posts</span>
          <span class="creator-stat"><strong>${fmtNum(c.avg_likes_30d)}</strong> avg likes</span>
          ${c.avg_views_30d ? `<span class="creator-stat"><strong>${fmtNum(c.avg_views_30d)}</strong> avg views</span>` : ''}
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

// ─── BIOS ────────────────────────────────────────────────────────────
let biosData = [];
let biosSort = 'followers';
let biosFilter = 'all';

async function loadBios() {
  const grid = $('#bios-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="text-muted" style="padding:20px">Loading bios…</div>';
  try {
    // Fetch big batch — 879 creators all in memory is fine
    const data = await apiGet('/api/creators?limit=2000&sort=followers', 'bios_data');
    if (!data) return;
    biosData = data;
    renderBios();
  } catch (err) {
    grid.innerHTML = `<div style="color:var(--danger);padding:20px">Error: ${escHtml(err.message)}</div>`;
  }
}

function renderBios() {
  const grid = $('#bios-grid');
  const countEl = $('#bios-count');
  if (!grid) return;

  const q = ($('#bios-search')?.value || '').trim().toLowerCase();

  let rows = biosData.filter(c => (c.bio || '').trim() || (c.location || '').trim());

  if (biosFilter === 'has_location') {
    rows = rows.filter(c => (c.location || '').trim());
  } else if (biosFilter === 'has_link') {
    rows = rows.filter(c => (c.bio_link || '').trim());
  } else if (biosFilter === 'verified') {
    rows = rows.filter(c => c.is_verified);
  }

  if (q) {
    rows = rows.filter(c =>
      (c.username || '').toLowerCase().includes(q) ||
      (c.bio || '').toLowerCase().includes(q) ||
      (c.location || '').toLowerCase().includes(q) ||
      (c.display_name || '').toLowerCase().includes(q)
    );
  }

  if (biosSort === 'username') {
    rows.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
  } else {
    rows.sort((a, b) => (b.followers || 0) - (a.followers || 0));
  }

  if (countEl) countEl.textContent = `${rows.length} bios`;

  if (!rows.length) {
    grid.innerHTML = '<div class="text-muted" style="padding:20px;grid-column:1/-1">No bios match the current filter.</div>';
    return;
  }

  grid.innerHTML = rows.map(renderBioCard).join('');
  // Wire copy buttons
  grid.querySelectorAll('.bio-chip-copy').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const text = btn.dataset.copy || '';
      navigator.clipboard.writeText(text)
        .then(() => toast('Bio copied!', 'success'))
        .catch(() => fallbackCopy(text));
    });
  });
}

function renderBioCard(c) {
  const initials = (c.display_name || c.username || '?')[0].toUpperCase();
  const bio = (c.bio || '').trim();
  const loc = (c.location || '').trim();
  const link = (c.bio_link || '').trim();
  const verified = c.is_verified
    ? `<svg class="verified-tick" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M22.5 12.5c0-1.58-.875-2.95-2.148-3.6.154-.435.238-.905.238-1.4 0-2.21-1.71-3.998-3.818-3.998-.47 0-.92.084-1.336.25C14.818 2.415 13.51 1.5 12 1.5s-2.816.917-3.437 2.25c-.415-.165-.866-.25-1.336-.25-2.11 0-3.818 1.79-3.818 4 0 .493.083.964.237 1.4-1.272.65-2.147 2.018-2.147 3.6 0 1.495.782 2.798 1.942 3.486-.02.17-.032.34-.032.514 0 2.21 1.708 4 3.818 4 .47 0 .92-.086 1.335-.25.62 1.334 1.926 2.25 3.437 2.25 1.512 0 2.818-.916 3.437-2.25.415.163.865.248 1.336.248 2.11 0 3.818-1.79 3.818-4 0-.174-.012-.344-.033-.513 1.158-.687 1.943-1.99 1.943-3.484zm-6.616-3.334l-4.334 6.5c-.145.217-.382.334-.625.334-.143 0-.288-.04-.416-.126l-.115-.094-2.415-2.415c-.293-.293-.293-.768 0-1.06s.768-.294 1.06 0l1.77 1.767 3.825-5.74c.23-.345.696-.436 1.04-.207.346.23.44.696.21 1.04z"/></svg>`
    : '';
  const followers = (c.followers ?? 0) > 0 ? fmtNum(c.followers) : '—';

  let footChips = `<span class="bio-chip followers">${followers} followers</span>`;
  if (loc) footChips += `<span class="bio-chip location">📍 ${escHtml(loc)}</span>`;
  if (link) {
    const display = link.replace(/^https?:\/\//, '').replace(/\/$/, '');
    footChips += `<span class="bio-chip link"><a href="${escHtml(link)}" target="_blank" rel="noopener">🔗 ${escHtml(display)}</a></span>`;
  }
  if (bio) footChips += `<button class="bio-chip-copy" data-copy="${escHtml(bio)}">Copy</button>`;

  return `
    <div class="bio-card">
      <div class="bio-card-head">
        <div class="bio-card-avatar">
          <img src="/api/avatars/${encodeURIComponent(c.username || '')}" alt="" onerror="this.style.display='none'" />
          <span>${initials}</span>
        </div>
        <div class="bio-card-meta">
          <div class="bio-card-name">${escHtml(c.display_name || c.username || '—')} ${verified}</div>
          <div class="bio-card-handle">@${escHtml(c.username || '')}</div>
        </div>
      </div>
      ${bio ? `<div class="bio-card-text">${escHtml(bio)}</div>` : '<div class="bio-card-text muted">No bio</div>'}
      <div class="bio-card-foot">${footChips}</div>
    </div>
  `;
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
    countEl.textContent = total > 0 ? `${fmtNum(total)} results` : `${grid.children.length} results`;

    // Infinite scroll: hide button, set up observer on sentinel
    if (posts.length < 50) {
      loadBtn.style.display = 'none';
      state[`${tab}_done`] = true;
    } else {
      loadBtn.style.display = 'none';
      state[`${tab}_done`] = false;
      setupInfiniteScroll(tab);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ─── Infinite Scroll ────────────────────────────────────────────────
const _scrollObservers = {};
function setupInfiniteScroll(tab) {
  const cfg = tabConfig[tab];
  const grid = $(`#${cfg.gridId}`);
  if (!grid) return;

  // Remove old sentinel
  const oldSentinel = grid.querySelector('.scroll-sentinel');
  if (oldSentinel) oldSentinel.remove();

  // Add sentinel div at bottom
  const sentinel = document.createElement('div');
  sentinel.className = 'scroll-sentinel';
  sentinel.style.height = '1px';
  grid.parentElement.appendChild(sentinel);

  // Disconnect old observer
  if (_scrollObservers[tab]) _scrollObservers[tab].disconnect();

  _scrollObservers[tab] = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !state[`${tab}_loading`] && !state[`${tab}_done`]) {
      state[`${tab}_loading`] = true;
      loadViralTab(tab, state.pages[tab], true).then(() => {
        state[`${tab}_loading`] = false;
      });
    }
  }, { rootMargin: '400px' });

  _scrollObservers[tab].observe(sentinel);
}

// ─── POST CARD BUILDER ───────────────────────────────────────────────
function buildPostCard(post) {
  const mt = post.media_type || 'unknown';
  const isVideo = mt === 'video';
  const hasMedia = mt === 'photo' || mt === 'video';

  // ─── Media rendering (1:1 IG Intel pattern) ───
  let mediaHtml = '';
  if (hasMedia) {
    const thumbUrl = ((post.thumbnail_local && !post.thumbnail_local.startsWith('_')) ? post.thumbnail_local : '') || post.thumbnail_url || post.media_url || '';
    const imgUrl = (post.media_local && !post.media_local.startsWith('_')) ? post.media_local : (post.media_url || `/api/images/${post.id}`);
    const multBadge = post.performance_multiplier > 1.5 ? `<div class="viral-badge">${multLabel(post.performance_multiplier)}</div>` : '';
    const overlay = `
      <div class="post-card-overlay">
        <div class="post-card-overlay-stats">
          <span class="overlay-stat">❤️ ${fmtNum(post.likes)}</span>
          ${post.views ? `<span class="overlay-stat">👁 ${fmtNum(post.views)}</span>` : ''}
        </div>
      </div>`;

    if (isVideo && post.media_local && !post.media_local.startsWith('_')) {
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
        ${post.performance_multiplier ? `<div class="viral-badge">${multLabel(post.performance_multiplier)}</div>` : ''}
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
  const mult = post.performance_multiplier;
  const multHtml = mult ? `<span class="mult-badge ${multClass(mult)}">${multLabel(mult)}</span>` : '';
  const captionFull = post.caption || '';
  return `<div class="text-post-card" data-id="${post.id}">
    <div class="text-post-header">
      <div>
        <span class="text-post-author">@${escHtml(post.username || '—')}</span>
        ${multHtml}
      </div>
      <div class="text-post-meta">${fmtDate(post.create_time)}</div>
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
      if (isVideo && post.media_local && !post.media_local.startsWith('_')) {
        // Video downloaded → play from Supabase/local
        mediaEl.innerHTML = `<div style="max-width:400px;margin:0 auto"><video controls loop playsinline autoplay src="${post.media_local}" style="width:100%;border-radius:8px;max-height:500px"></video></div>`;
        mediaEl.style.position = 'relative';
      } else if (isVideo) {
        const thumb = ((post.thumbnail_local && !post.thumbnail_local.startsWith('_')) ? post.thumbnail_local : '') || post.thumbnail_url || post.media_url || `/api/thumbnails/${post.id}`;
        mediaEl.innerHTML = `
          <img src="${thumb}" alt="Video thumbnail" style="width:100%;max-height:600px;object-fit:contain;"
               onerror="this.parentNode.innerHTML='<div class=\\'media-placeholder\\' style=\\'font-size:60px;position:static\\''>🎬</div>'" />
          <div style="position:absolute;bottom:12px;left:12px;background:rgba(0,0,0,0.7);color:#fff;font-size:11px;padding:3px 8px;border-radius:4px;">VIDEO</div>
        `;
        mediaEl.style.position = 'relative';
      } else {
        const imgUrl = (post.media_local && !post.media_local.startsWith('_')) ? post.media_local : (post.media_url || `/api/images/${post.id}`);
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

    // Caption (strip any remaining t.co links)
    const cleanCaption = (post.caption || '').replace(/https?:\/\/t\.co\/\S+/g, '').trim();
    captionEl.textContent = cleanCaption;

    // Stats
    const statsItems = [
      { label: 'Likes', value: post.likes },
      { label: 'Views', value: post.views },
      { label: 'Bookmarks', value: post.bookmarks },
      { label: 'Retweets', value: post.retweets },
      { label: 'Replies', value: post.replies },
      { label: 'Viral Mult', value: post.performance_multiplier ? `${post.performance_multiplier.toFixed(2)}x` : null },
    ].filter(s => s.value != null && s.value !== 0 && s.value !== '');

    statsEl.innerHTML = statsItems.map(s => `
      <div class="modal-stat">
        <div class="modal-stat-label">${s.label}</div>
        <div class="modal-stat-value">${typeof s.value === 'number' ? fmtNum(s.value) : s.value}</div>
      </div>
    `).join('');

    // Meta
    metaEl.innerHTML = `
      ${post.create_time ? `<div style="color:var(--text3);font-size:12px">Posted ${fmtDate(post.create_time)}</div>` : ''}
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
    { label: 'Photo posts',    value: 8.4, color: '#635bff' },
    { label: 'Video posts',    value: 12.1, color: '#22d3ee' },
    { label: 'Text only',      value: 4.2, color: '#00ba7c' },
    { label: 'Thread starter', value: 6.7, color: '#ffad1f' },
  ],
  captions: [
    { label: 'Question hook',    value: 9.8, color: '#635bff' },
    { label: 'Controversial take',value: 11.2, color: '#ff6b8a' },
    { label: 'Personal story',   value: 8.5, color: '#22d3ee' },
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
  if (el.dataset.rendered === '1') return;

  // ── Inject CSS once ────────────────────────────────────────────────
  if (!document.getElementById('guide-styles')) {
    const style = document.createElement('style');
    style.id = 'guide-styles';
    style.textContent = `
      #guide-content { padding: 0; background: #181820; min-height: 100vh; }
      .gd-layout { max-width: 1280px; margin: 0 auto; display: grid; grid-template-columns: 260px 1fr; gap: 28px; padding: 28px 32px 80px; }
      .gd-sidebar { position: sticky; top: 16px; align-self: start; max-height: calc(100vh - 32px); overflow-y: auto; background: #20202c; border: 1px solid #3a3a4c; border-radius: 12px; padding: 22px 0; }
      .gd-sidebar-brand { padding: 0 22px 18px; font-weight: 800; font-size: 16px; color: #82aaff; border-bottom: 1px solid #3a3a4c; margin-bottom: 14px; }
      .gd-nav { display: flex; flex-direction: column; }
      .gd-nav-link { display: flex; align-items: flex-start; gap: 12px; padding: 9px 22px; font-size: 13px; font-weight: 500; color: #9898a8; text-decoration: none; border-left: 3px solid transparent; transition: all .15s; line-height: 1.45; }
      .gd-nav-link:hover, .gd-nav-link.active { color: #e0e0e8; background: rgba(130,170,255,.07); border-left-color: #82aaff; text-decoration: none; }
      .gd-nav-num { color: #82aaff; font-weight: 700; font-size: 11px; min-width: 22px; margin-top: 2px; letter-spacing: .04em; }
      .gd-main { min-width: 0; }
      .gd-hero { text-align: center; padding: 36px 0 18px; }
      .gd-hero h1 { font-size: 30px; font-weight: 800; background: linear-gradient(135deg, #82aaff, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; margin-bottom: 10px; line-height: 1.2; }
      .gd-hero p { color: #9898a8; font-size: 14px; max-width: 560px; margin: 0 auto; }
      .gd-hero .gd-updated { margin-top: 10px; font-size: 12px; color: #6c6c80; }
      .gd-search-wrap { position: sticky; top: 0; z-index: 5; background: #181820; padding: 16px 0 12px; margin-bottom: 8px; }
      .gd-search-input { width: 100%; padding: 11px 16px; border-radius: 10px; background: #20202c; border: 1px solid #3a3a4c; color: #e0e0e8; font-size: 14px; outline: none; box-sizing: border-box; font-family: inherit; }
      .gd-search-input:focus { border-color: #82aaff; box-shadow: 0 0 0 3px rgba(130,170,255,.15); }
      .gd-search-input::placeholder { color: #6c6c80; }
      .gd-no-results { color: #6c6c80; text-align: center; padding: 32px 0; font-size: 14px; }
      .gd-quickwins { background: linear-gradient(135deg, rgba(130,170,255,.13), rgba(192,132,252,.10)); border: 1px solid rgba(130,170,255,.32); border-radius: 12px; padding: 26px 28px 22px; margin: 10px 0 30px; }
      .gd-quickwins h2 { color: #82aaff; font-size: 19px; font-weight: 800; margin-bottom: 14px; }
      .gd-quickwins ol { padding-left: 22px; margin: 0; }
      .gd-quickwins li { margin-bottom: 9px; font-size: 14px; color: #e0e0e8; line-height: 1.55; }
      .gd-quickwins li strong { color: #fff; }
      .gd-section { background: #20202c; border: 1px solid #3a3a4c; border-radius: 12px; margin-bottom: 18px; overflow: hidden; }
      .gd-section-header { display: flex; align-items: center; gap: 14px; padding: 18px 24px; cursor: pointer; user-select: none; transition: background .15s; }
      .gd-section-header:hover { background: rgba(130,170,255,.05); }
      .gd-section-header h2 { font-size: 17px; font-weight: 700; flex: 1; color: #e0e0e8; margin: 0; }
      .gd-chevron { width: 20px; height: 20px; transition: transform .25s; color: #9898a8; flex-shrink: 0; }
      .gd-section.open .gd-chevron { transform: rotate(180deg); }
      .gd-section-body { max-height: 0; overflow: hidden; transition: max-height .4s ease; }
      .gd-section.open .gd-section-body { max-height: 100000px; }
      .gd-section-content { padding: 4px 28px 30px; }
      .gd-section-content h3 { font-size: 16px; font-weight: 700; color: #82aaff; margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #3a3a4c; }
      .gd-section-content h3:first-child { margin-top: 0; }
      .gd-section-content h4 { font-size: 14.5px; font-weight: 700; color: #fff; margin: 18px 0 8px; }
      .gd-section-content p { font-size: 14.5px; color: #e0e0e8; margin-bottom: 10px; line-height: 1.65; }
      .gd-section-content ul, .gd-section-content ol { padding-left: 22px; margin: 0 0 14px; }
      .gd-section-content li { font-size: 14.5px; color: #e0e0e8; margin-bottom: 5px; line-height: 1.65; }
      .gd-section-content strong { color: #fff; font-weight: 600; }
      .gd-section-content em { color: #c4cdd5; font-style: normal; background: rgba(130,170,255,.08); padding: 1px 5px; border-radius: 3px; font-size: 13.5px; }
      .gd-section-content code { background: rgba(130,170,255,.12); color: #fff; padding: 2px 6px; border-radius: 4px; font-family: 'SF Mono','Monaco','Consolas',monospace; font-size: 13px; border: 1px solid rgba(130,170,255,.18); }
      .gd-alert { background: rgba(255,100,100,.10); border: 2px solid #ff6464; border-radius: 10px; padding: 16px 20px; font-size: 14.5px; font-weight: 600; color: #ff6464; margin: 14px 0; line-height: 1.55; display: flex; gap: 10px; align-items: flex-start; }
      .gd-alert .gd-alert-icon { font-size: 18px; flex-shrink: 0; }
      .gd-alert .gd-alert-body { flex: 1; color: #e0e0e8; font-weight: 500; }
      .gd-alert .gd-alert-body strong { color: #ff6464; font-weight: 700; }
      .gd-alert.warn { border-color: #ffd250; background: rgba(255,210,80,.10); }
      .gd-alert.warn .gd-alert-body strong { color: #ffd250; }
      .gd-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 14px 0; border-radius: 10px; border: 1px solid #3a3a4c; }
      .gd-table { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 380px; }
      .gd-table thead { background: rgba(130,170,255,.08); }
      .gd-table th { text-align: left; padding: 11px 14px; font-weight: 700; color: #82aaff; font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; }
      .gd-table td { padding: 10px 14px; border-top: 1px solid #3a3a4c; color: #e0e0e8; vertical-align: top; }
      .gd-table tbody tr:nth-child(even) td { background: rgba(130,170,255,.03); }
      .gd-table tr:hover td { background: rgba(130,170,255,.06); }
      .gd-table strong { color: #fff; }
      .gd-card { background: #2c2c3c; border: 1px solid #3a3a4c; border-radius: 10px; padding: 16px 18px; margin: 12px 0; }
      .gd-card .gd-card-title { font-size: 15px; font-weight: 700; margin-bottom: 8px; color: #fff; }
      .gd-card-green { background: rgba(100,220,160,.07); border-color: rgba(100,220,160,.45); }
      .gd-card-green .gd-card-title { color: #64dca0; }
      .gd-card-red { background: rgba(255,100,100,.07); border-color: rgba(255,100,100,.45); }
      .gd-card-red .gd-card-title { color: #ff6464; }
      .gd-card-yellow { background: rgba(255,210,80,.07); border-color: rgba(255,210,80,.45); }
      .gd-card-yellow .gd-card-title { color: #ffd250; }
      .gd-card-blue { background: rgba(130,170,255,.07); border-color: rgba(130,170,255,.45); }
      .gd-card-blue .gd-card-title { color: #82aaff; }
      .gd-card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 12px 0; }
      .gd-cta { background: linear-gradient(135deg, rgba(100,220,160,.14), rgba(100,220,160,.06)); border: 2px solid #64dca0; border-radius: 12px; padding: 22px 24px; margin: 16px 0; }
      .gd-cta .gd-cta-title { font-size: 17px; font-weight: 800; color: #64dca0; margin-bottom: 10px; }
      .gd-cta .gd-cta-item { padding: 4px 0; font-size: 14.5px; font-weight: 600; color: #fff; }
      .gd-cta .gd-cta-note { margin-top: 11px; font-weight: 600; color: #ffd250; font-size: 13.5px; }
      .gd-stat { background: rgba(130,170,255,.08); border: 1px solid rgba(130,170,255,.32); border-radius: 8px; padding: 14px 18px; margin: 12px 0; font-size: 14px; font-weight: 600; color: #82aaff; }
      .gd-stat strong { color: #fff; }
      .gd-scenario { display: flex; align-items: flex-start; gap: 14px; background: #2c2c3c; border-radius: 10px; padding: 14px 16px; margin: 10px 0; border-left: 3px solid #82aaff; }
      .gd-scenario-icon { font-size: 22px; flex-shrink: 0; line-height: 1; }
      .gd-scenario-body { flex: 1; }
      .gd-scenario-body strong { display: block; margin-bottom: 5px; font-size: 14px; color: #fff; }
      .gd-scenario-body p { font-size: 13.5px; color: #c4cdd5; margin: 0; line-height: 1.55; }
      .gd-scenario.green { border-left-color: #64dca0; }
      .gd-scenario.yellow { border-left-color: #ffd250; }
      .gd-scenario.red { border-left-color: #ff6464; }
      .gd-scenario.blue { border-left-color: #82aaff; }
      .gd-step { background: #2c2c3c; border: 1px solid #3a3a4c; border-radius: 10px; padding: 16px 18px; margin: 12px 0; border-left: 4px solid #82aaff; }
      .gd-step-label { font-size: 12px; font-weight: 800; color: #82aaff; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
      .gd-step h4 { margin-top: 0 !important; }
      .gd-step p { margin-bottom: 0; }
      .gd-contact { background: linear-gradient(135deg, rgba(130,170,255,.16), rgba(130,170,255,.05)); border: 1px solid rgba(130,170,255,.45); border-radius: 12px; padding: 18px 22px; margin: 16px 0; }
      .gd-contact-label { font-size: 11px; font-weight: 700; color: #82aaff; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 4px; }
      .gd-contact-handle { font-size: 18px; font-weight: 700; color: #fff; margin-bottom: 6px; word-break: break-word; }
      .gd-contact-desc { font-size: 13.5px; color: #c4cdd5; line-height: 1.55; margin: 0; }
      .gd-code { background: #181820; border: 1px solid #3a3a4c; border-radius: 10px; overflow: hidden; margin: 14px 0; }
      .gd-code-header { background: #20202c; padding: 7px 16px; font-size: 11px; color: #9898a8; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
      .gd-code-line { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px; border-top: 1px solid #2c2c3c; gap: 10px; }
      .gd-code-line:first-of-type { border-top: none; }
      .gd-code-line span { font-family: 'SF Mono','Monaco','Consolas',monospace; font-size: 13px; color: #e0e0e8; flex: 1; word-break: break-word; }
      .gd-code-copy { flex-shrink: 0; background: none; border: 1px solid #3a3a4c; color: #9898a8; padding: 4px 10px; border-radius: 5px; font-size: 11px; cursor: pointer; transition: all .15s; font-family: inherit; }
      .gd-code-copy:hover { border-color: #82aaff; color: #82aaff; }
      .gd-caption-cat { margin-bottom: 22px; }
      .gd-caption-cat h4 { margin: 0 0 10px !important; font-size: 12px !important; font-weight: 700; color: #82aaff !important; text-transform: uppercase; letter-spacing: .08em; }
      .gd-caption-item { display: flex; align-items: center; justify-content: space-between; background: #2c2c3c; border: 1px solid #3a3a4c; border-radius: 7px; padding: 9px 13px; margin-bottom: 7px; gap: 10px; transition: border-color .15s; }
      .gd-caption-item:hover { border-color: #82aaff; }
      .gd-caption-item span { font-size: 13.5px; color: #e0e0e8; flex: 1; }
      .gd-caption-copy { flex-shrink: 0; background: none; border: 1px solid #3a3a4c; color: #9898a8; padding: 4px 11px; border-radius: 5px; font-size: 11px; cursor: pointer; transition: all .15s; font-family: inherit; }
      .gd-caption-copy:hover { border-color: #82aaff; color: #82aaff; }
      .gd-checklist { list-style: none; padding-left: 0 !important; margin: 10px 0 16px; }
      .gd-checklist li { padding: 7px 0 7px 32px; position: relative; font-size: 14px; color: #e0e0e8; line-height: 1.5; display: flex; align-items: flex-start; gap: 10px; }
      .gd-checklist input[type=checkbox] { margin-top: 3px; flex-shrink: 0; accent-color: #82aaff; width: 16px; height: 16px; cursor: pointer; }
      .gd-checklist li { padding-left: 0; }
      .gd-checklist li.checked label { color: #6c6c80; text-decoration: line-through; }
      .gd-faq-item { background: #2c2c3c; border: 1px solid #3a3a4c; border-radius: 10px; margin: 8px 0; overflow: hidden; }
      .gd-faq-q { padding: 14px 18px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-weight: 700; font-size: 14.5px; color: #e0e0e8; user-select: none; transition: background .15s; }
      .gd-faq-q:hover { background: rgba(130,170,255,.05); }
      .gd-faq-q .gd-faq-icon { width: 18px; height: 18px; color: #9898a8; transition: transform .25s; flex-shrink: 0; margin-left: 12px; }
      .gd-faq-item.open .gd-faq-q .gd-faq-icon { transform: rotate(180deg); }
      .gd-faq-a { max-height: 0; overflow: hidden; transition: max-height .3s ease; }
      .gd-faq-a-inner { padding: 0 18px 16px; font-size: 14px; color: #c4cdd5; line-height: 1.65; }
      .gd-footer { text-align: center; padding: 30px 0 20px; color: #6c6c80; font-size: 12.5px; border-top: 1px solid #3a3a4c; margin-top: 36px; }
      .gd-section.search-hidden { display: none; }
      .gd-highlight { background: rgba(130,170,255,.25); border-radius: 2px; padding: 0 2px; }
      @media (max-width: 980px) {
        .gd-layout { grid-template-columns: 1fr; padding: 18px 14px 60px; gap: 18px; }
        .gd-sidebar { position: relative; top: 0; max-height: none; overflow: hidden; padding: 16px 0; }
        .gd-sidebar-brand { padding: 0 18px 14px; font-size: 14px; }
        .gd-nav { flex-direction: row; flex-wrap: wrap; gap: 4px; padding: 0 14px; }
        .gd-nav-link { padding: 7px 11px; font-size: 12.5px; border-left: none; border-radius: 6px; flex: 0 0 auto; background: #181820; border: 1px solid #3a3a4c; }
        .gd-nav-link:hover, .gd-nav-link.active { background: rgba(130,170,255,.12); border-left: 1px solid #82aaff; border-color: #82aaff; }
        .gd-nav-num { min-width: 0; font-size: 11px; }
        .gd-hero { padding: 16px 0 12px; }
        .gd-hero h1 { font-size: 22px; }
        .gd-section-header { padding: 14px 16px; gap: 10px; }
        .gd-section-header h2 { font-size: 15px; }
        .gd-section-content { padding: 4px 16px 22px; }
        .gd-section-content h3 { font-size: 14.5px; }
        .gd-section-content p, .gd-section-content li { font-size: 14px; }
        .gd-card-grid { grid-template-columns: 1fr; }
        .gd-quickwins { padding: 20px 18px 16px; }
        .gd-quickwins h2 { font-size: 17px; }
        .gd-step { padding: 14px 16px; }
        .gd-cta { padding: 18px 20px; }
        .gd-table { font-size: 12.5px; }
        .gd-table th, .gd-table td { padding: 8px 10px; }
        .gd-caption-copy, .gd-code-copy { padding: 6px 12px; font-size: 12px; }
        .gd-checklist input[type=checkbox] { width: 18px; height: 18px; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function alertBanner(html, critical) {
    const cls = critical ? 'gd-alert' : 'gd-alert warn';
    const icon = critical ? '🚨' : '⚠️';
    return `<div class="${cls}"><span class="gd-alert-icon">${icon}</span><div class="gd-alert-body">${html}</div></div>`;
  }

  function card(color, title, body) {
    const colorCls = color ? ` gd-card-${color}` : '';
    const titleHtml = title ? `<div class="gd-card-title">${title}</div>` : '';
    return `<div class="gd-card${colorCls}">${titleHtml}${body}</div>`;
  }

  function cardGrid(cards) {
    return `<div class="gd-card-grid">${cards.join('')}</div>`;
  }

  function ctaBox(title, items, note) {
    const itemsHtml = items.map(i => `<div class="gd-cta-item">→ ${i}</div>`).join('');
    const noteHtml = note ? `<div class="gd-cta-note">${note}</div>` : '';
    return `<div class="gd-cta"><div class="gd-cta-title">${title}</div>${itemsHtml}${noteHtml}</div>`;
  }

  function scenario(color, icon, title, body) {
    return `<div class="gd-scenario ${color}"><div class="gd-scenario-icon">${icon}</div><div class="gd-scenario-body"><strong>${title}</strong><p>${body}</p></div></div>`;
  }

  function fixStep(label, title, body) {
    const titleHtml = title ? `<h4>${title}</h4>` : '';
    const bodyHtml = typeof body === 'string' ? `<p>${body}</p>` : body;
    return `<div class="gd-step"><div class="gd-step-label">${label}</div>${titleHtml}${bodyHtml}</div>`;
  }

  function statHighlight(html) {
    return `<div class="gd-stat">${html}</div>`;
  }

  function contactCard(label, handle, desc) {
    return `<div class="gd-contact"><div class="gd-contact-label">${label}</div><div class="gd-contact-handle">${handle}</div><p class="gd-contact-desc">${desc}</p></div>`;
  }

  function tbl(headers, rows) {
    const th = headers.map(h => `<th>${h}</th>`).join('');
    const tr = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<div class="gd-table-wrap"><table class="gd-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }

  function codeBlock(lines, header) {
    const hdr = header ? `<div class="gd-code-header">${escHtml(header)}</div>` : '';
    const body = lines.filter(l => l.trim()).map(l =>
      `<div class="gd-code-line"><span>${escHtml(l.trim())}</span><button class="gd-code-copy" onclick="copyToClipboard(this.previousElementSibling.textContent.trim());this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>`
    ).join('');
    return `<div class="gd-code">${hdr}${body}</div>`;
  }

  function captionItems(lines) {
    return lines.filter(l => l.trim()).map(l =>
      `<div class="gd-caption-item"><span>${escHtml(l.trim())}</span><button class="gd-caption-copy" onclick="copyToClipboard(this.previousElementSibling.textContent.trim());this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>`
    ).join('');
  }

  let clIdx = 0;
  function checklist(items, pfx) {
    return `<ul class="gd-checklist">${items.map(item => {
      const id = `gcl_${pfx}_${clIdx++}`;
      const chk = localStorage.getItem(id) === '1';
      return `<li class="${chk ? 'checked' : ''}" id="li_${id}"><input type="checkbox" id="${id}" ${chk ? 'checked' : ''} onchange="localStorage.setItem('${id}',this.checked?'1':'0');document.getElementById('li_${id}').classList.toggle('checked',this.checked);"><label for="${id}">${escHtml(item)}</label></li>`;
    }).join('')}</ul>`;
  }

  function faqItem(q, a) {
    return `<div class="gd-faq-item">
      <div class="gd-faq-q" onclick="(function(item){var wasOpen=item.classList.contains('open');document.querySelectorAll('.gd-faq-item').forEach(function(i){i.classList.remove('open');i.querySelector('.gd-faq-a').style.maxHeight=null;});if(!wasOpen){item.classList.add('open');var ans=item.querySelector('.gd-faq-a');ans.style.maxHeight=ans.scrollHeight+'px';}})(this.closest('.gd-faq-item'))">
        <span>${escHtml(q)}</span>
        <svg class="gd-faq-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="gd-faq-a"><div class="gd-faq-a-inner">${a}</div></div>
    </div>`;
  }

  function sec(num, id, title, body, open) {
    return `<div class="gd-section${open ? ' open' : ''}" id="sec-${id}" data-section-title="${escHtml(num + '. ' + title)}">
      <div class="gd-section-header" onclick="this.closest('.gd-section').classList.toggle('open')">
        <h2>${num}. ${escHtml(title)}</h2>
        <svg class="gd-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="gd-section-body"><div class="gd-section-content">${body}</div></div>
    </div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION CONTENT
  // ══════════════════════════════════════════════════════════════════

  const sec01 = `
    <p>Welcome. This is the complete guide for running a Twitter / X account for one of our creators.</p>
    <p>Your job is simple at heart: <strong>build a following</strong> by posting interesting personality content and engaging with people. Over time, those followers become people who click the link in the bio — and that is where the revenue happens.</p>

    <h3>The Big Picture</h3>
    <p>Twitter is the front door. Your tweets attract attention. People click the profile, see the bio, follow the link. The whole funnel rests on tweets that look fun and personal — not salesy.</p>

    <h3>The 90 / 10 Rule</h3>
    <p>About <strong>90 % of your tweets</strong> are personality, humor, engagement bait. Only <strong>10 %</strong> are promotional. Push the link too hard and the algorithm hides you. Push personality and the algorithm grows you.</p>

    <h3>Three Things That Run Everything</h3>
    ${card('blue', 'The Core Levers', `
      <ul>
        <li><strong>Replies are king.</strong> Getting people to reply to your tweet is 150× more valuable than getting a like.</li>
        <li><strong>The first 30 minutes decide.</strong> If a tweet gets traction fast, it spreads. If not, it dies.</li>
        <li><strong>Consistency beats bursts.</strong> Steady daily activity grows accounts. Ten posts one day and zero the next gets you flagged.</li>
      </ul>
    `)}

    <h3>How to Use This Dashboard</h3>
    <p>This site is not just for the guide — it is your daily research tool. Open it at the start of every shift.</p>
    <ul>
      <li><strong>Viral Photos</strong> — see which photo tweets are winning right now</li>
      <li><strong>Viral Videos</strong> — same for video tweets</li>
      <li><strong>Viral Text</strong> — top-performing captions sorted by likes (steal ideas from here)</li>
      <li><strong>Creators</strong> — accounts to study, comment under, and find followers to steal</li>
      <li><strong>Bios</strong> — inspiration for writing your own bio</li>
      <li><strong>Strategy</strong> — live data on what is working this week</li>
    </ul>

    ${alertBanner('The single biggest mistake new accounts make: putting a link in a tweet too early, or putting a link in the main tweet at all. <strong>Read Section 11 (The Link Rule) carefully before you post anything with a link.</strong>', true)}
  `;

  const sec02 = `
    <p>The first hour after creating the account decides a lot. Skip the wrong setting now and you will fight an uphill battle for weeks.</p>

    <h3>Step 1 — Sign Up</h3>
    <p>Use the email and phone number provided by the team. <strong>Never use your personal email or phone.</strong> Confirm the email and phone immediately so the account is not flagged as suspicious.</p>

    <h3>Step 2 — Pick a Username</h3>
    ${cardGrid([
      card('green', '✓ Good usernames', `<ul><li>Persona name + something soft: <code>@bellacosplay</code></li><li>Aesthetic word: <code>@lavendergloss</code></li><li>Short and clean: <code>@iamruby</code></li><li>Lowercase only — looks authentic</li></ul>`),
      card('red', '✗ Avoid these', `<ul><li><code>sexybaby9747</code></li><li><code>hotgirl2024</code></li><li><code>onlyfangirl</code></li><li>Anything with numbers + sexual words</li></ul>`),
    ])}

    <h3>Step 3 — Settings (Do These Right After Creating the Account)</h3>
    <p>Open the X app. Go to <em>Settings &amp; Privacy</em>. Walk through every item below — these all matter.</p>

    ${fixStep('SETTING 1', 'Sensitive content — ON', `<p><em>Settings &amp; Privacy → Privacy and safety → Your posts → Mark media as sensitive</em></p>${alertBanner('<strong>Turn this ON.</strong> Without it, X silently reduces your reach. Even if your photos look soft, leave it ON.', false)}`)}

    ${fixStep('SETTING 2', 'Precise location — OFF', `<p><em>Settings &amp; Privacy → Privacy and safety → Location information → Precise location</em> → OFF</p><p>Your audience should be the entire US, not people near you. Precise location filters your reach geographically.</p>`)}

    ${fixStep('SETTING 3', 'Display sensitive content — ON', `<p><em>Settings &amp; Privacy → Privacy and safety → Content you see → Display media that may contain sensitive content</em></p><p>If this is OFF, you cannot see the kind of accounts you will be competing with — and cannot comment under them.</p>`)}

    ${fixStep('SETTING 4', 'Discoverability — ON (both options)', `<p><em>Discoverability and contacts</em> → both "find by email" and "find by phone number" → ON.</p>`)}

    ${fixStep('SETTING 5', 'Direct Messages — Allow from everyone', `<p><em>Privacy and safety → Direct messages</em> → "Allow message requests from" → <strong>Everyone</strong>. We want DMs flowing in.</p>`)}

    ${fixStep('SETTING 6', 'Professional Account / Twitter Pro — LEAVE OFF', `<p>Twitter offers a "Professional Profile" mode that tags the account as a business / public figure.</p>${alertBanner('<strong>Do NOT switch this on.</strong> It flags the account as commercial and reduces personal reach. Our accounts are personal personas — they need to look like a regular person, not a business.', true)}`)}

    ${fixStep('SETTING 7', 'Language &amp; Region', `<ul><li>Display language: <strong>English (US)</strong></li><li>Phone region (in your phone settings): <strong>United States</strong></li></ul>`)}

    ${fixStep('SETTING 8', 'Birthday — Hide both year and date', `<p>Profile → Edit Profile → set "Who can see this" to <strong>Only you</strong> for both year and date.</p>`)}

    <h3>Step 4 — Stop. Do NOT Follow Anyone Yet.</h3>
    ${card('yellow', 'Hands off the follow button', `<p>The temptation right after signup is to follow 50 creators. <strong>Do not do this.</strong> Twitter watches new accounts very closely in the first 24 hours. Mass-following = instant flag.</p><p>For the first day: just set up the profile, scroll the For You page for 10 minutes, like 5–10 tweets. That is enough.</p>`)}
  `;

  const sec03 = `
    <p>The profile is your storefront. Almost everyone who clicks your name decides to follow or not within five seconds of looking. Make those five seconds count.</p>

    <h3>Profile Picture (Avatar)</h3>
    ${cardGrid([
      card('green', '✓ Avatar that works', `<ul><li>Clear face shot — humans recognize faces fastest</li><li>Bright daylight lighting</li><li>Beach, pool, bed in daylight, cozy room with a window</li><li>Eye contact with the camera converts best</li></ul>`),
      card('red', '✗ Avatar that fails', `<ul><li>Dark or blurry photos</li><li>Bedroom mirror at night</li><li>Back-lit silhouettes</li><li>Explicit nudity (X restricts the account)</li><li>Cartoon avatars or stock images</li></ul>`),
    ])}

    <h3>Header / Banner</h3>
    <p>Use the banner for personality and vibe. Options that work:</p>
    <ul>
      <li>A second photo of the creator (different from the avatar)</li>
      <li>A cosplay or themed shot</li>
      <li>An aesthetic background (pink gradient, beach view, neon room) with the username overlaid</li>
      <li>A clean meme that fits the persona</li>
    </ul>
    ${alertBanner('<strong>Check the banner on a phone after you upload it.</strong> Almost all followers see Twitter on mobile, so this is the only view that matters. If the face is cut off on mobile — re-crop and re-upload.', false)}

    <h3>Display Name</h3>
    <ul>
      <li>Persona first name + a soft emoji: <code>bella ♡</code>, <code>ruby 🌸</code></li>
      <li>Keep it short — long display names get truncated</li>
      <li>No "18+", "NSFW", or anything explicit in the display name</li>
    </ul>

    <h3>Bio</h3>
    <p>The bio has 160 characters. Use a formula:</p>
    ${statHighlight('<strong>[Personality / niche]</strong> + <strong>[soft hint]</strong> + <strong>[arrow ↓]</strong>')}
    <p>The arrow points to the link spot — even without a link yet, it primes people to look there later.</p>

    ${codeBlock([
      '"your online addiction ♡"',
      '"most viral girl on X for a reason 👇"',
      '"full time internet gf 🤍"',
      '"bad decisions only"',
      '"hai im angelicat lol i cosplay kinda 🪽 see more me :D ↓"',
      '"Cosplayer ♡ UR Goth GF"',
    ], 'Working Bio Examples')}

    ${card('blue', 'Bio Rules', `<ul><li>Maximum 1–2 emojis</li><li>No <strong>"18+"</strong>, no <strong>"NSFW"</strong>, no <strong>"subscribe"</strong>, no <strong>"DM for"</strong> — silent reach reductions</li><li>No link until 100 followers — see Section 11</li><li>The arrow ↓ at the end is psychological — tells people to look down for the link</li></ul>`)}

    <h3>Pinned Tweet</h3>
    ${alertBanner('<strong>Don&apos;t pin anything yet.</strong> The pinned tweet only matters when a post hits 100+ likes. Pinning a weak tweet sends a worse signal than no pin at all. See Section 10.', false)}

    <h3>Location, Website, Birthday</h3>
    <ul>
      <li><strong>Location:</strong> a US city that fits the persona — Los Angeles, Miami, Austin, Tampa, Phoenix. Skip "United States" (too vague).</li>
      <li><strong>Website:</strong> leave blank until Justin gives you a link.</li>
      <li><strong>Birthday:</strong> set a date that makes the persona age 22–28. Keep year and date hidden (Section 2).</li>
    </ul>
  `;

  const sec04 = `
    <p>Twitter watches new accounts closely. The first three weeks are about <em>looking like a real person</em> before you act like a creator. Rush it and you get shadowbanned within the first month.</p>

    ${alertBanner('Posting starts on Day 1 with light volume and ramps up over three weeks. The numbers below are the safe path — do not exceed them.', false)}

    ${card('blue', 'Phase 1 — Day 1 to Day 3 (Light start)', `
      <h4>What to do</h4>
      <ul>
        <li><strong>1 post per day</strong> — one good photo + short caption</li>
        <li>Follow 5–10 creators in our niche (spread across the day)</li>
        <li>Like 10–20 tweets per day</li>
        <li>Write 5 short, friendly replies on other creators' tweets</li>
        <li>Scroll the For You page 10 minutes</li>
      </ul>
      <h4>What NOT to do</h4>
      <ul><li>No link in the bio yet</li><li>No link in any tweet</li><li>No mass follow / unfollow</li></ul>
    `)}

    ${card('yellow', 'Phase 2 — Day 4 to Day 10 (Engagement build)', `
      <h4>What to do</h4>
      <ul>
        <li><strong>2 posts per day</strong>, 4–6 hours apart</li>
        <li>Follow 10–15 more creators (total ~30–40)</li>
        <li>Like 30–50 tweets per day</li>
        <li>15 thoughtful replies per day</li>
        <li>Start using <strong>Image Comments</strong> (Section 12) — 3–5 per day</li>
      </ul>
      <h4>What NOT to do</h4>
      <ul><li>Still no link anywhere</li><li>No 3rd-party scheduling apps connected to the account</li></ul>
    `)}

    ${card('green', 'Phase 3 — Day 11 onward (Full operation)', `
      <h4>What to do</h4>
      <ul>
        <li><strong>3 posts per day</strong>, spread across active hours</li>
        <li>Like 50–100 tweets per day</li>
        <li>20–30 replies per day, half as image-replies on viral posts</li>
        <li>5–10 follower steals per day (Section 13)</li>
        <li>Once you cross <strong>100 followers</strong>: message Justin → he creates your link → add to bio</li>
      </ul>
      <h4>What NOT to do</h4>
      <ul><li>Never exceed 50 replies per hour</li><li>Never exceed 100 likes per hour</li><li>Never post more than 5 tweets in a day, even on a great day</li></ul>
    `)}

    <h3>Quick Reference</h3>
    ${tbl(['Action','Day 1–3','Day 4–10','Day 11 +'],[
      ['Posts','1 / day','2 / day','3 / day'],
      ['Follows','5–10 / day','10–15 / day','max 30 / day'],
      ['Likes','10–20 / day','30–50 / day','50–100 / day'],
      ['Replies','5 / day','15 / day','20–30 / day'],
      ['Link in bio','No','No','Only after 100 followers'],
    ])}
  `;

  const sec05 = `
    <p>You do not need to know everything about the algorithm. You need to know the seven rules below and what they look like in real life. Every rule has a real-world scenario.</p>

    <h3>1. Replies are the strongest signal — 150× more valuable than likes</h3>
    <p>Twitter measures how much your tweet starts conversations. A reply chain (someone replies, you reply, they reply back) tells the algorithm "this is interesting people, push it harder."</p>
    ${scenario('blue', '💬', 'Scenario', 'You post a tweet and it gets 50 likes but zero replies. The algorithm reads this as "popular but not interesting" and stops pushing it. <strong>What to do:</strong> always end captions with a question. Adding "(be honest)" doubles reply chances because it reads as a challenge.')}

    <h3>2. The first 30 minutes decide everything</h3>
    <p>Twitter tests every tweet on a small audience first. If engagement is strong in the first 30 minutes, it gets pushed wider. If not, it dies.</p>
    ${scenario('yellow', '⏱️', 'Scenario', 'You post and then go check the kitchen for 20 minutes. Nobody in your follower list happens to see it pop up. The tweet dies. <strong>What to do:</strong> right after posting — like 3 tweets on the For You page, reply to 2 creators, scroll for 5 minutes. This signals to the algorithm that <em>you</em> are active, which makes it show your tweet to more people.')}

    <h3>3. Bookmarks are gold — 20× more valuable than likes</h3>
    <p>Most creators ignore bookmarks. Saving a tweet tells Twitter "I want to come back to this later" — a much stronger signal than a tap of the heart.</p>
    ${scenario('green', '🔖', 'Scenario', 'A photo with caption "this is what 180lbs looks like :D" gets bookmarked because viewers want to look at it later. That bookmark counts 20× a like. <strong>What to do:</strong> "save-worthy" photos (full body, well-composed) collect bookmarks even if likes look quiet.')}

    <h3>4. Short captions outperform long ones — by 3×</h3>
    <p>The faster a viewer reads your caption, the more likely they click the photo, like, or reply.</p>
    ${scenario('blue', '✂️', 'Scenario', '"am i your type? (be honest)" → 36,116 likes. "Hey guys, hope youre having a great day, just wanted to say hi and ask if you think Im your type, please let me know honestly" → would have died at 200 likes. <strong>Rule of thumb:</strong> if your caption is longer than the tweet box width on mobile, cut it.')}

    <h3>5. Questions beat statements — by 50 %</h3>
    <p>A question is an invitation. A statement is a wall.</p>
    ${scenario('blue', '❓', 'Scenario', '"I love my new outfit" vs "do you like my new outfit?" — same photo, the question gets twice the replies. Adding "(be honest)" doubles it again. <strong>Why it works:</strong> "be honest" reads as a challenge, and people on Twitter cannot resist a challenge.')}

    <h3>6. Links in the main tweet kill reach — by 30 to 50 %</h3>
    <p>Twitter does not want users leaving the platform. Any tweet with a link gets throttled. The workaround is Section 11 — link goes only in the bio, never in a tweet.</p>
    ${scenario('red', '🔗', 'Scenario', 'You post a photo with caption "more here ↓ link.me/yourname". Reach drops by half compared to the same photo with caption "good morning ♡". <strong>What to do:</strong> never put a URL in the main tweet. Even writing the words "link in bio" hurts reach a little — let the bio arrow ↓ do the work silently.')}

    <h3>7. Grok AI reads everything you post (since Jan 2026)</h3>
    <p>Grok is X&apos;s built-in AI. It reads every tweet&apos;s meaning and decides whether to push or quiet it. Specifically: Grok pushes positive, fun, playful content and silently kills negative, aggressive, or political content. Even your <em>tone</em> matters.</p>
    ${scenario('yellow', '🤖', 'Scenario', 'A tweet like "I hate when men ghost me 🙄" might get high engagement from the audience — but Grok reads it as "negative emotion" and quietly reduces reach for the next 24 hours on the whole account. A tweet like "boys are so cute when they get nervous 😭" hits the same emotional angle but reads as positive. <strong>What to do:</strong> rewrite anything that sounds bitter, angry, or political. Keep the tone playful.')}

    <h3>Two Minor Rules That Still Matter</h3>
    ${cardGrid([
      card('yellow', 'Hashtags', '<ul><li>1–2 is fine</li><li>3 or more kills reach by 40 %</li><li>Most tweets do not need any hashtags at all</li></ul>'),
      card('red', 'ALL CAPS', '<ul><li>Flagged as shouting / spam</li><li>Lowercase is the default look</li><li>Capitalize only proper nouns and brand names</li></ul>'),
    ])}
  `;

  const sec06 = `
    <h3>How Many Posts Per Day</h3>
    ${tbl(['Account Age','Posts / day','Why'],[
      ['Day 1–3','1','Twitter watches new accounts; one post tests the waters'],
      ['Day 4–10','2','Account looks active without spamming'],
      ['Day 11 onward','3','Full operating volume — three solid posts per day is the sweet spot'],
    ])}
    <p>Space the posts <strong>3 to 5 hours apart</strong>. Posting twice within an hour gets the second one buried by the algorithm.</p>

    <h3>The 90 / 10 Rule</h3>
    ${card('blue', 'How much should be promo?', `<ul><li>If you post 3 times a day: most days zero promotional tweets. Occasional 1 promo tweet on a day when an organic post is performing especially well.</li><li>Never more than <strong>2 promotional tweets in a single day</strong>, account-wide.</li></ul>`)}

    <h3>When to Post (US Eastern Time)</h3>
    <p>Our audience is mostly in the United States.</p>
    ${tbl(['Window (EST)','What this slot is for'],[
      ['09:00 – 11:00','Morning crowd, "good morning" energy'],
      ['13:00 – 15:00','Lunch break scrollers — strongest engagement slot'],
      ['20:00 – 22:00','Evening prime time — best for teases'],
    ])}
    <p>Best days: <strong>Tuesday through Thursday</strong>. Saturday late night is the deadest window — avoid.</p>

    <h3>The Before / After Post Routine</h3>
    <p>This is the routine that wins the first 30 minutes. Do it on every post, especially while the account is under 2,000 followers.</p>

    ${ctaBox('Before / After Routine', [
      '2–3 min BEFORE: reply to comments on your previous post, scroll For You, like 3–5 tweets',
      'POST your tweet',
      '3–5 min AFTER: stay in the app, scroll For You for 2 min, image-comment on 2 viral posts, do 3–5 follower steals, like 5–10 tweets',
    ], 'Why this matters: Twitter rewards active users. Post-and-disappear = penalty. Post-and-stay = boost.')}

    ${scenario('blue', '💡', 'Why this works', 'If you post and disappear, the algorithm reads you as a low-quality account. If you post and stay engaged for 5 minutes, the algorithm reads you as a real, active person and pushes your tweet wider.')}
  `;

  const sec07 = `
    <p>This section is the most important one in the guide. Captions decide whether a tweet lives or dies. The patterns below come from analyzing <strong>4,996 tweets from 226 top creators.</strong></p>

    <h3>The Four Universal Caption Rules</h3>

    <h4>1. Short wins.</h4>
    <p>Captions under 25 characters get <strong>3× more engagement</strong> than captions over 60. The data:</p>
    ${tbl(['Caption length','Avg likes','Engagement rate'],[
      ['<strong>Short (≤ 25 chars)</strong>','<strong>2,336</strong>','<strong>4.5 %</strong>'],
      ['Medium (26–60)','1,489','3.2 %'],
      ['Long (60 +)','777','1.3 %'],
    ])}
    <p><strong>Why this works:</strong> people scroll fast. A short caption is read in half a second. A long one feels like work and gets skipped.</p>

    <h4>2. Questions beat statements by 50 %.</h4>
    <p>Question tweets average <strong>2,449 likes</strong> vs <strong>1,627</strong> for statements. Questions invite replies — and replies are 150× a like in the algorithm&apos;s eyes.</p>

    <h4>3. Adding "be honest" amplifies engagement.</h4>
    <p>Across the dataset, the top caption category is "be honest / tell me" tweets — average <strong>4,413 likes, 6.7 % engagement rate</strong>. "be honest" reads as a challenge and people on Twitter cannot resist.</p>

    <h4>4. Lowercase looks more authentic.</h4>
    <p>"am i your type" outperforms "Am I Your Type" or "AM I YOUR TYPE". Lowercase reads as casual, friend-talk. Capitalized reads as marketing. ALL CAPS reads as shouting and gets flagged.</p>

    <h3>Top All-Time Captions From the Dataset</h3>
    ${codeBlock([
      '"am i your type? (be honest)"  →  36,116 likes',
      '"taking bf applications rn"  →  35,019 likes',
      '"smash or pass (be honest) 🤭"  →  avg 13,806 likes',
      '"good morning 🫶"  →  avg 11,736 likes',
      '"eyes up here pretty boy"  →  avg 7,626 likes',
      '"Rate my arch 1-10"  →  6.5 % engagement (highest in category)',
    ], 'Top Performers')}

    <h3>Why These Worked — Real Analysis</h3>

    ${card('green', '"am i your type? (be honest)" → 36,116 likes', `
      <ul>
        <li><strong>Setup:</strong> photo of the creator looking directly into camera</li>
        <li><strong>Why it exploded:</strong> "am i your type" is already a question — invites a reply. The "(be honest)" is the unlock — it transforms a soft compliment-seek into a challenge.</li>
        <li><strong>Reply storm:</strong> "100 %", "absolutely", "you are literally my dream girl" → algorithm pushes the tweet to millions.</li>
      </ul>
    `)}

    ${card('green', '"taking bf applications rn" → 35,019 likes', `
      <ul>
        <li><strong>Setup:</strong> attractive photo + a fantasy people want to engage with</li>
        <li><strong>Why it worked:</strong> "applications" is playful framing — turns "I am single" (boring) into a game (engaging). Guys reply "putting my application in", "interview when", "where do I apply" — a thread of replies, which is the most valuable signal.</li>
      </ul>
    `)}

    ${card('green', '"good morning 🫶" → avg 11,736 likes', `
      <ul>
        <li><strong>Setup:</strong> waking-up photo (in bed, soft natural light)</li>
        <li><strong>Why it worked:</strong> universal greeting that opens conversations. Combined with the photo, it triggers a parasocial reaction — followers feel like the creator is greeting <em>them</em>. Easiest reply to write.</li>
      </ul>
    `)}

    ${card('green', '"this is what 180lbs looks like :D" → 21,818 likes', `
      <ul>
        <li><strong>Setup:</strong> full body photo</li>
        <li><strong>Why it worked:</strong> body positivity + a specific number. The specific number (180lbs) makes the tweet feel real and personal, not generic. The ":D" softens it — turns what could read as a complaint into a flex. Grok pushes it (Section 5.7).</li>
      </ul>
    `)}

    <h3>Where to Find Fresh Caption Ideas Daily</h3>
    ${card('blue', 'Use this dashboard', `<p>The <strong>Viral Text</strong> tab shows the highest-performing tweets sorted by likes — those are the patterns working <em>right now</em>. The patterns shift over time, so check this tab at least twice a week.</p><p>Don&apos;t copy captions word-for-word across accounts (Twitter detects duplicates and penalizes everyone involved). Adapt: swap a word, change an emoji, mix two ideas.</p>`)}

    ${alertBanner('Section 8 has 60+ ready-to-use captions sorted by category. Use them as a starting point, then rotate.', false)}

    <h3>Caption Don&apos;ts</h3>
    ${card('red', 'Never do these', `<ul><li>No paragraphs — keep it one line</li><li>No more than 2 emojis</li><li>No <strong>"link in bio"</strong> in the caption — it hurts reach (the bio arrow ↓ does this silently)</li><li>No prices, no "subscribe", no "DM me for"</li><li>No hashtag lists</li><li>No exact-same caption twice in the same week on the same account</li></ul>`)}
  `;

  const sec08 = `
    <p>Around 60 tested captions sorted by category. Copy with the button on the right. <strong>Rotate</strong> — never use the same caption twice in one week.</p>

    <div class="gd-caption-cat">
      <h4>"Be honest" — Strongest tier</h4>
      ${captionItems(['am i your type? (be honest)','smash or pass (be honest)','yes or no to my body type? (be honest)','rate my arch 1-10','rate my waist 1-10','do you like tattooed girls?','do you like redhead girls?','describe me in 1 word','me or your wife?','what would you do?','one word — go','too small or just right?'])}
    </div>

    <div class="gd-caption-cat">
      <h4>Short &amp; sweet</h4>
      ${captionItems(['hey cutie','hi ♡','good morning 🫶','good night 🌙','bouncy','lord have mercy…','enjoy :)','WHOA','watch again','hey x ♡','lace 🤍'])}
    </div>

    <div class="gd-caption-cat">
      <h4>Boyfriend / girlfriend energy</h4>
      ${captionItems(['taking bf applications rn','taking boyfriend applications ↓','still single btw','i need a hug','i am ur e-girlfriend now, no takebacks','first date — where are we going?','need a winter cuddle buddy'])}
    </div>

    <div class="gd-caption-cat">
      <h4>Personality / humor</h4>
      ${captionItems(['my kink is complete devotion and obsession','this is frying me','where did my car seat go?','giggle maxing','this is what 180lbs looks like :D','imagine hating tummy!?','heard u like abs','pspspsps come here loser'])}
    </div>

    <div class="gd-caption-cat">
      <h4>Tease / suggestive</h4>
      ${captionItems(['eyes up here pretty boy','i know what you are looking at 🖤','your knees hurt yet?','a little motivation ♡','sound on for this one','just studying 📚','is pink my color?','what kind of day does this remind you of?'])}
    </div>

    <div class="gd-caption-cat">
      <h4>FOMO / DM bait — max 1× per day</h4>
      ${captionItems(['deleting in 6 hours, say "me" for a special dm','say hi for a surprise in dms','reply "yes" for a surprise dm (i am serious)','if you are not a bot, say hi. i will follow back','do not open the comments','i dare you to open the comments'])}
    </div>

    <div class="gd-caption-cat">
      <h4>Cosplay / character (if persona fits)</h4>
      ${captionItems(['nico robin 🤲','mother makima','who wants this character?','2B from NieR'])}
    </div>

    ${alertBanner('<strong>DM bait rule:</strong> if you write "say me for a dm" — you actually have to follow through. Send a "hey ❤" with the bio link. Otherwise people stop engaging and the tactic stops working.', false)}
  `;

  const sec09 = `
    <p>The photos and videos you post need to be <strong>SFW (safe for work)</strong> — Twitter is fine with suggestive, but explicit content gets the account restricted within hours.</p>

    <h3>What to Post</h3>
    ${card('green', 'Photo &amp; video ideas that work', `<ul><li>Bikini / lingerie / matching sets (suggestive, not explicit)</li><li>Cosplay shoots</li><li>Lifestyle photos with good lighting (cafe, beach, bed, room)</li><li>Mirror selfies in bright rooms</li><li>Workout / fitness content</li><li>"Get ready with me" short videos (5–15 seconds)</li><li>Behind-the-scenes / candid moments</li><li>Walking / dancing short videos</li></ul>`)}

    <h3>Video Rules</h3>
    <ul>
      <li>Keep videos <strong>under 2 minutes 20 seconds</strong> — anything longer gets less reach</li>
      <li>Best length: <strong>5–15 seconds</strong> (matches the Twitter scroll pattern)</li>
      <li>Vertical (9:16) and square (1:1) both work — landscape feels old and gets ignored</li>
      <li>Always check the first frame looks good — it is the thumbnail</li>
    </ul>

    <h3>The Cropping &amp; Editing Tip (Optional but Recommended)</h3>
    <p>Twitter is getting better at detecting duplicate content. If you take a photo straight from the source and post it as-is, the system might flag it — especially if the same photo has appeared elsewhere before.</p>
    <p>This is an <strong>optional safety layer</strong>. You don&apos;t have to do it — but it protects the account.</p>

    ${fixStep('TIP 1', 'Crop the photo slightly', '<p>Even 5–10 % off the edges changes the file fingerprint. Use the phone&apos;s built-in photo editor.</p>')}
    ${fixStep('TIP 2', 'Adjust brightness or contrast a touch', '<p>Push it +5 / −5. Subtle enough that the photo still looks natural, different enough that the file is now unique.</p>')}
    ${fixStep('TIP 3', 'For videos', '<p>Trim 0.5 seconds off the start or end, or apply a subtle filter. Same effect — file fingerprint changes.</p>')}

    <h3>Reposting What Works</h3>
    ${card('yellow', 'The reposting rules', `<ul><li>Wait at least <strong>one full week</strong> between posts of the same photo / video</li><li>Use a <strong>different caption</strong> the second time</li><li>Apply the cropping / editing trick (above) so the file is technically unique</li><li>Don&apos;t repost more than twice — the third time triggers duplicate detection</li></ul>`)}

    <h3>What NOT to Post</h3>
    ${card('red', 'Hard noes', `<ul><li>Explicit nudity — the account will be restricted</li><li>Anything involving minors, weapons, drugs, gore</li><li>Politics, religion, drama, takes on current events</li><li>The same photo posted within 7 days</li><li>Photos with watermarks from other platforms still visible</li></ul>`)}
  `;

  const sec10 = `
    <p>The pinned tweet is the first thing anyone sees when they click on the profile. Most non-followers decide whether to follow based on the pinned tweet plus the bio — within five seconds.</p>

    <h3>Don't Pin Anything at First</h3>
    ${alertBanner('<strong>While the account is fresh, leave the pin empty.</strong> Pinning a tweet with 4 likes makes the account look dead. A profile with no pin actually looks more curated than one with a weak pin.', false)}

    <h3>When to Pin Your First Tweet</h3>
    <p>Wait until one of your tweets crosses <strong>100 likes</strong>. That is the threshold where the pin starts working in your favor.</p>

    ${scenario('green', '📌', 'Why 100 likes', 'A pinned tweet with 100+ likes signals to a profile visitor: "other people approve of this — it is safe to follow." Anything below 100 makes the account look quiet and the visitor scrolls away.')}

    <h3>What to Pin</h3>
    <p>Pin your <strong>single best-performing tweet</strong> by likes. Photo or video tweets work better than text-only.</p>
    <ul>
      <li>The pin should be visually striking — strong first impression matters</li>
      <li>The caption should match the persona (don&apos;t pin something off-brand)</li>
      <li>If the tweet has many replies, even better — visitors see the engagement instantly</li>
    </ul>

    <h3>When to Replace the Pin</h3>
    <p>Every time a newer tweet beats the pinned one by likes — replace it. Always be pinning your current best.</p>
    <ul>
      <li>Check pin candidates once a week</li>
      <li>To replace: tap the three dots on the new tweet → "Pin to your profile". This automatically unpins the old one.</li>
    </ul>
  `;

  const sec11 = `
    ${alertBanner('<strong>This is the single most important rule in the guide. Read it twice.</strong>', true)}

    <h3>The Rule</h3>
    <p>You may <strong>NEVER</strong> put a URL in the main text of a tweet. Twitter punishes external links inside tweets by reducing reach by 30 to 50 %. This has been the case since March 2025.</p>

    <h3>Where the Link Goes</h3>
    <p>Once you have a link (see below), it goes <strong>only in the bio</strong>. Nothing in the tweet — just an arrow ↓ in the bio that points down to where the website field shows on the profile.</p>

    <h3>How to Get Your Link</h3>
    <p>You do not get a link on day one. You earn it.</p>

    ${fixStep('STEP 1', 'Reach 100 followers', '<p>Through warm-up, posting, and the growth tactics (Sections 12 &amp; 13).</p>')}
    ${fixStep('STEP 2', 'Message Justin on X', '<p>Open his profile, send a DM saying "Hey, [account] just hit 100 followers — ready for a link". He will create it and send it back within a day.</p>')}
    ${fixStep('STEP 3', 'Add the link to the bio', '<p>In the website field. Keep the arrow ↓ at the end of the bio text.</p>')}

    ${contactCard('Contact for your link', '@SunnyAngels_Admin (Justin)', 'DM him on X once your account hits 100 followers. He sets up the link, sends it back, you add it to the bio.')}

    <h3>Why We Wait Until 100 Followers</h3>
    <ul>
      <li>An account with a link and fewer than 100 followers looks like an obvious spam / promo account → Twitter throttles it</li>
      <li>An account that grew to 100 followers through personality first looks like a <em>real person who happens to have a link</em> → Twitter treats it as a normal account</li>
      <li>The 100-follower milestone also tells us your account is healthy enough to drive real traffic</li>
    </ul>

    <h3>Once You Have the Link</h3>
    ${card('blue', 'Rules once linked', `<ul><li>Link lives in the bio website field — never in a tweet</li><li>Don&apos;t write "link in bio" in tweet captions — even those words hurt reach slightly</li><li>The arrow ↓ at the end of the bio points to the link silently — that is enough</li><li>Never share the link in DMs unless someone asks for it directly</li></ul>`)}

    ${alertBanner('<strong>If you put a link in a tweet by accident:</strong> delete the tweet immediately, do NOT edit. Editing keeps the algorithm penalty. Deleting and re-posting clean costs you nothing.', true)}
  `;

  const sec12 = `
    <p>This is the single most powerful growth tactic on Twitter. It outperforms posting, following, and almost everything else combined.</p>

    <h3>The Idea</h3>
    <p>Instead of writing a text reply on someone else&apos;s viral tweet, you reply with one of your <strong>best photos or videos</strong>. The viral tweet has thousands of eyeballs on it. Your photo gets seen by a slice of those eyeballs — and the ones who like what they see click your profile and follow.</p>

    <h3>Why It Works Better Than Anything Else</h3>
    ${card('green', 'Why image replies dominate', `<ul><li>You borrow someone else&apos;s audience without spending money</li><li>Image replies are visually loud — they stop the scroll inside the reply thread</li><li>The bigger the original tweet, the bigger the borrowed audience</li></ul>`)}

    <h3>How to Run It — Step by Step</h3>

    ${fixStep('STEP 1', 'Open Viral Photos or Viral Videos on this dashboard', '<p>Sort by Most Recent. You are looking for tweets that are fresh and gaining momentum.</p>')}
    ${fixStep('STEP 2', 'Pick a target', '<p>A tweet with <strong>1,000+ likes</strong> that is <strong>less than 20 hours old</strong>, from a creator with <strong>10K–200K followers</strong>. Bigger creators have too much competition in the replies; smaller ones do not have enough audience to borrow.</p>')}
    ${fixStep('STEP 3', 'Open the tweet on X and tap reply', '')}
    ${fixStep('STEP 4', 'Reply with one of your best photos', '<p>Plus a short relevant caption that connects to the original tweet. See examples below.</p>')}
    ${fixStep('STEP 5', 'After posting', '<p>Stay on the app. Don&apos;t follow up. Don&apos;t add a link.</p>')}

    <h3>Caption Examples for Image Replies</h3>
    ${codeBlock([
      'Original: "Do I look cute today?"  →  Your reply: [best photo] + "we could be twins 😭"',
      'Original: "rate my outfit"  →  Your reply: [fit photo] + "trade fits?"',
      'Original: "tell me i am pretty"  →  Your reply: [photo] + "you are gorgeous 🥹 (me though?)"',
      'Original: "anyone else feeling cute today?"  →  Your reply: [photo] + "🙋‍♀️"',
    ], 'Image Reply Examples')}

    <h3>Rules</h3>
    ${card('red', 'Don&apos;t', `<ul><li>Never write "follow me", "check my profile", "DM me" — that is spam, you get blocked and Twitter penalizes</li><li>Never reuse the same photo twice</li><li>Never reply on dead tweets (likes have stopped climbing)</li></ul>`)}
    ${card('green', 'Do', `<ul><li>Maximum 10 image replies per day — more triggers spam detection</li><li>Use a different photo each time</li><li>Keep captions short, relevant, never promotional</li><li>Only target tweets gaining momentum</li></ul>`)}

    ${ctaBox('Daily Target', [
      '5–10 image replies during active hours',
      'Use the Viral tabs in this dashboard to find fresh targets',
      'Different photo every time',
    ], 'Done consistently, this brings 20–80 new followers per day in the early weeks.')}
  `;

  const sec13 = `
    <p>"Follower stealing" sounds aggressive — it is actually polite. You are going to other creators&apos; viral tweets, finding fans who left a comment, and making a friendly connection with them. Most of them follow back because you noticed them.</p>

    <h3>How to Find Targets</h3>

    ${fixStep('STEP 1', 'Open Viral Photos or Viral Text on this dashboard', '<p>Pick a tweet from a creator in our niche with 500+ likes.</p>')}
    ${fixStep('STEP 2', 'Open the tweet on X and scroll the replies', '<p>Look for people who left a comment with <strong>fewer than 10 likes</strong> on their comment. More than 10 likes means too many other creators are already chasing them.</p>')}
    ${fixStep('STEP 3', 'Filter for good targets', '<p>Looks American, English comment, has a profile photo, has tweets of their own (not just replies), looks 25+. Skip obvious bots, locked accounts, and women.</p>')}

    <h3>The Interaction (~90 % Follow-Back Rate)</h3>

    ${fixStep('1', 'Follow them', '')}
    ${fixStep('2', 'Like the comment they left on the original viral tweet', '')}
    ${fixStep('3', 'Open their profile', '<p>Find one of their own tweets (not a reply to someone else).</p>')}
    ${fixStep('4', 'Leave a short, genuine reply', '<p>"love this!", "this is amazing", "great take". Nothing promotional, nothing about you.</p>')}

    <p>That is it. Most of them notice the activity (follow + like + reply) and follow back within an hour or two. They feel seen — that is all the magic is.</p>

    <h3>Limits</h3>
    ${card('yellow', 'Stay under these', `<ul><li>Maximum <strong>5 follower steals per posting session</strong>, 10–15 per day total</li><li>Never write anything promotional in the reply on their profile</li><li>Only US-based, English-speaking, real-looking accounts</li><li>Don&apos;t do them all at once — spread across the day</li></ul>`)}
  `;

  const sec14 = `
    <p>A shadowban means Twitter is silently hiding your tweets from people who don&apos;t already follow you. The account looks fine to you — but your reach drops to almost zero. It is the most common cause of an account dying.</p>

    <h3>Daily Limits — Never Exceed These</h3>
    ${tbl(['Action','During Warm-Up','After Warm-Up','Hard Limit'],[
      ['Follows','5–10 / day','20–30 / day','Never &gt; 50 / day'],
      ['Unfollows','0','10 / day','Never &gt; 30 / day'],
      ['Likes','10–50 / day','50–100 / day','Never &gt; 100 / hour'],
      ['Replies','5–15 / day','20–30 / day','Never &gt; 30 / hour'],
      ['Posts','1–2 / day','3 / day','Never &gt; 5 / day'],
      ['Image replies','0','5–10 / day','Never &gt; 15 / day'],
    ])}

    <h3>What Triggers a Shadowban</h3>
    ${card('red', 'These behaviors will get you flagged', `<ul><li>A link in the main tweet (especially on a new account)</li><li>Mass follow or unfollow in a short window</li><li>Too many likes too fast (more than 100 in an hour)</li><li>The exact same reply text used 5+ times</li><li>3+ hashtags in a tweet (especially #OnlyFans, #porn, #nsfw — even one of those is enough)</li><li>ALL CAPS in tweets</li><li>Third-party apps connected to the account</li><li>Same photo + same caption across multiple accounts (network detection)</li><li>Aggressive or political tone (Grok flags — Section 5.7)</li></ul>`)}

    <h3>How to Tell If You Are Shadowbanned</h3>

    ${fixStep('CHECK 1', 'shadowban.eu', '<p>Open in the phone browser and enter the @handle. If any flag shows red — you are banned.</p>')}
    ${fixStep('CHECK 2', 'Incognito search', '<p>In a private / incognito browser, go to x.com (don&apos;t sign in) and search for the exact text of a recent tweet. If the tweet does not appear in results — you are invisible to non-followers.</p>')}
    ${fixStep('CHECK 3', 'Engagement pattern', '<p>Watch the engagement pattern. If likes drop more than 70 % overnight on the same kind of content — that is a strong signal.</p>')}

    <h3>Recovery — What to Do If You Are Shadowbanned</h3>

    ${fixStep('STEP 1', 'Stop. For 24 to 72 hours.', '<p>No likes, no follows, no posts, no replies. Don&apos;t even open the app on that account.</p>')}
    ${fixStep('STEP 2', 'Day 4–5', '<p>Only short, genuine replies on other creators&apos; tweets. No links anywhere, no photos yet.</p>')}
    ${fixStep('STEP 3', 'Day 6–7', '<p>Resume photo tweets — but only 1 per day, no link, short captions.</p>')}
    ${fixStep('STEP 4', 'Day 8 +', '<p>Back to normal schedule.</p>')}
    ${fixStep('STEP 5', 'Still banned after 7 days?', '<p>Message Justin (Section 20) — we may need to retire the account.</p>')}

    ${alertBanner('<strong>Tell us immediately if you suspect a shadowban.</strong> We can advise quickly. Do not try to push through it — you will make it worse.', true)}
  `;

  const sec15 = `
    <p>You will get bot comments and bot followers. This is normal. Twitter is full of them.</p>

    <h3>The Counterintuitive Rule</h3>
    ${card('green', 'Bots in your comments are GOOD', `<p>Don&apos;t block them, don&apos;t delete their comments. Here is why:</p><p>When a bot comments on your tweet, it adds to the engagement count. The algorithm sees "this tweet has 30 replies" and pushes it wider — it can&apos;t tell which replies are from real people. The fact that bots showed up means your tweet hit the For You page in the first place. That is a good sign.</p>`)}

    <h3>What to Do With Bot Comments</h3>
    ${cardGrid([
      card('green', '✓ Do', '<ul><li>Give bot comments a like (boosts engagement count)</li><li>Leave them alone</li><li>Move on with your routine</li></ul>'),
      card('red', '✗ Don&apos;t', '<ul><li>Don&apos;t reply to them</li><li>Don&apos;t block them</li><li>Don&apos;t report them</li></ul>'),
    ])}

    <h3>How to Spot a Bot</h3>
    <ul>
      <li>Generic praise: "amazing!", "wow!", "❤️❤️❤️" repeated</li>
      <li>Crypto / NFT / "DM for $$$" in their own bio</li>
      <li>Profile created within the last week</li>
      <li>No profile photo or a stock photo</li>
      <li>Following thousands of accounts, almost no followers themselves</li>
    </ul>

    <h3>If a Bot DMs You</h3>
    ${alertBanner('Ignore it. Don&apos;t click any links they send. Don&apos;t reply. Their goal is to phish you or scam followers — neither serves us.', false)}
  `;

  const sec16 = `
    <p>"Viral" is relative to the account size. Use the table below to know when you have hit it.</p>

    ${tbl(['Followers','Viral threshold (likes)'],[
      ['0 – 500','500 +'],
      ['500 – 1,000','750 +'],
      ['1,000 – 5,000','1,500 +'],
      ['5,000 – 10,000','3,000 +'],
      ['10,000 +','5,000 +'],
    ])}

    <h3>What to Do When It Hits</h3>

    ${fixStep('STEP 1', 'Don&apos;t delete the tweet', '<p>Don&apos;t edit it. Don&apos;t panic. Leave it alone.</p>')}
    ${fixStep('STEP 2', 'Reply to as many comments as you can — at least the first 20', '<p>Every reply you write feeds the algorithm. Even a "🥺" or "🫶" reply counts.</p>')}
    ${fixStep('STEP 3', 'Post a follow-up tweet 1–2 hours later', '<p>Different photo, caption that references the viral one (e.g. "yall were so sweet on the last one ♡"). This captures the new visitors who just discovered the account.</p>')}
    ${fixStep('STEP 4', 'Check that the bio is clean and the pin is your best one', '<p>A flood of new visitors is going to look at both.</p>')}
    ${fixStep('STEP 5', 'Send a screenshot to Justin', '<p>So he knows the account is performing — we can adjust strategy, unlock the link, or activate Premium if it is the right time.</p>')}

    <h3>Don&apos;t Try to Force a Second Viral</h3>
    ${alertBanner('The instinct after a viral hit is "post the same thing again". <strong>Wait at least 7 days</strong> before reposting the same photo with a different caption (Section 9). Posting it again the same day or even the next day looks obvious — the second post will flop.', false)}
  `;

  const sec17 = `
    <p>Every account hits a rut at some point. The signs:</p>
    ${codeBlock([
      'Tweet 1 (Monday):    500 likes',
      'Tweet 2 (Tuesday):   400 likes',
      'Tweet 3 (Wednesday):  60 likes',
      'Tweet 4 (Thursday):   20 likes',
      'Tweet 5 (Thursday):    8 likes',
    ], 'A typical slowdown pattern')}
    <p>If you see a drop like this — something changed. Usually it is an algorithm flag, sometimes an early shadowban.</p>

    <h3>Recovery Plan</h3>

    ${fixStep('STEP 1', 'Check shadowban.eu first', '<p>If you are banned, follow Section 14 recovery instead.</p>')}
    ${fixStep('STEP 2', 'Delete the worst-performing tweet from the slowdown window', '<p>Underperforming tweets drag the whole account&apos;s "score" down.</p>')}
    ${fixStep('STEP 3', 'Cut posting down to 2 / day for 3 days', '<p>Less volume, higher quality. Use your best photos.</p>')}
    ${fixStep('STEP 4', 'Shift to interaction mode for those 3 days', '<p>Heavy on image replies (Section 12) and follower stealing (Section 13). The algorithm rewards activity from <em>you</em>, not just on you.</p>')}
    ${fixStep('STEP 5', 'Still slow after a week?', '<p>Change the avatar and refresh the bio. Sometimes the look is the problem.</p>')}
    ${fixStep('STEP 6', 'Still slow after two weeks?', '<p>Message Justin (Section 20). We will review the account together and decide on a new strategy.</p>')}
  `;

  const sec18 = `
    <h3>Daily Checklist</h3>
    ${checklist([
      'Open the dashboard, check Viral Photos / Viral Videos / Viral Text for fresh ideas',
      'Post the planned number of tweets for today (1 / 2 / 3 depending on account age)',
      'Run the before-and-after-post routine on every post (5 min before, 5 min after)',
      'At least 5 image replies on viral tweets (Section 12)',
      'At least 5 follower steals on viral comment sections (Section 13)',
      'Like and reply to comments on your own tweets',
      'Like 20–50 tweets in the For You feed',
    ], 'daily')}

    <h3>Weekly Checklist</h3>
    ${checklist([
      'Run shadowban.eu on the account — make sure no flags',
      'Review the week: which post performed best? Why?',
      'Update the pinned tweet if a new post beat the current pin (100+ likes)',
      'Refresh caption ideas from the Viral Text tab',
      'Send Justin a quick update if anything broke or hit big',
    ], 'weekly')}

    <h3>Monthly Checklist</h3>
    ${checklist([
      'Look at the follower growth chart — climbing or plateauing?',
      'Re-check the avatar and banner — still fresh, or time for a refresh?',
      'Delete any tweets older than 30 days with fewer than 5 likes',
      'Audit the bio — still in the right tone?',
    ], 'monthly')}
  `;

  const sec19 = `
    <p>Once an account crosses <strong>1,000 followers</strong>, we activate X Premium for it. Until then, it is not worth the cost.</p>

    <h3>What X Premium Gives the Account</h3>
    ${card('blue', 'The benefits', `<ul><li><strong>10× more reach</strong> per tweet (Twitter explicitly boosts Premium accounts)</li><li><strong>Comments appear at the top</strong> of any reply thread — even on huge tweets — which makes image replies (Section 12) much stronger</li><li><strong>Blue checkmark</strong> — instant credibility</li><li><strong>Edit button</strong> — fix typos without losing engagement</li><li><strong>4,000 character limit</strong> instead of 280</li><li><strong>TweepCred boost</strong> — a hidden trust score Twitter uses to rank accounts</li></ul>`)}

    <h3>Why We Wait Until 1,000 Followers</h3>
    <p>Premium costs about $8 / month per account. On a fresh account it is wasted — the audience is not big enough yet for the boost to compound. At 1,000 followers, the boost starts producing measurable extra growth, and the cost-per-new-follower drops sharply.</p>

    <h3>How to Activate It</h3>
    <p>You don&apos;t pay — we do. Just message Justin once the account hits 1,000.</p>

    ${contactCard('Contact to activate Premium', '@SunnyAngels_Admin (Justin)', 'Send him a DM: "[account] just hit 1,000 followers — ready for Premium". He will activate it on the billing side and confirm.')}
  `;

  const sec20 = `
    <h3>Who to Contact</h3>
    ${contactCard('Main contact', '@SunnyAngels_Admin (Justin)', 'Justin handles: link creation at 100 followers · Premium activation at 1,000 followers · shadowban or suspension issues · viral post moments · anything else you are unsure about.')}
    <p>If you are ever in doubt — message Justin. Better to ask before doing something risky than to fix the damage after.</p>

    <h3>FAQ</h3>

    ${faqItem('My account has 70 followers — can I get the link early?', 'No. The 100-follower line exists because Twitter throttles new accounts that have a link before they look real. Stay patient — the last 30 followers go faster than the first 30.')}

    ${faqItem('Can I post the same photo on two of our accounts?', 'Not with the same caption. Twitter detects duplicate photo + caption combinations across accounts and penalizes both. Use the same photo with different captions, or modify the photo slightly (Section 9).')}

    ${faqItem('My likes dropped overnight — what do I do?', 'Step 1: check shadowban.eu. Step 2: if shadowbanned → follow Section 14 recovery. Step 3: if not shadowbanned → follow Section 17 (Account Slowdown) recovery.')}

    ${faqItem('How many accounts can I run at once?', 'Five is the practical max. Past that, you cannot run the image-reply tactic properly for each one, and they all start to suffer.')}

    ${faqItem('A creator I look up to broke half these rules — why?', 'Large accounts (100K +) have organic momentum and can break some rules safely. Small accounts cannot. Stick to the playbook until the account crosses 5,000 followers — then we revisit.')}

    ${faqItem('Can I use any auto-scheduler or bot app?', 'No. Twitter detects third-party automation and penalizes accounts. All posts go out manually from the X app.')}

    ${faqItem('What if Twitter prompts me to verify with a phone or selfie?', 'Stop and message Justin immediately. Do not answer the prompt yourself.')}

    ${faqItem('What if a follower DMs me asking explicit questions?', 'If they are polite — reply softly and casually. If they are aggressive or weird — ignore. Never send explicit content yourself, regardless of what they offer.')}

    ${faqItem('Can I do giveaways or contests?', 'Not without checking with Justin first. Twitter has rules around giveaways that can suspend the account if you do it wrong.')}

    ${faqItem('How do I tell which posting time is best for my account?', 'Try all three windows (morning, lunch, evening) over a week. The one with the highest average engagement is your account&apos;s sweet spot. Stick to it, but check again monthly — audience habits drift.')}
  `;

  // ── Build sections list ────────────────────────────────────────────
  const sections = [
    { num: '01', id: 'welcome',      title: 'Welcome — The Big Picture',         body: sec01, open: true },
    { num: '02', id: 'create',       title: 'Creating the Account',              body: sec02 },
    { num: '03', id: 'profile',      title: 'Profile Setup',                     body: sec03 },
    { num: '04', id: 'warmup',       title: 'Account Warm-Up (Day 1–21)',        body: sec04 },
    { num: '05', id: 'algorithm',    title: "How Twitter's Algorithm Works",     body: sec05 },
    { num: '06', id: 'schedule',     title: 'Daily Posting Schedule',            body: sec06 },
    { num: '07', id: 'captions',     title: 'Captions: What Works & Why',        body: sec07 },
    { num: '08', id: 'caption-bank', title: 'Caption Bank (60+ captions)',       body: sec08 },
    { num: '09', id: 'content',      title: 'Content Rules (Photos & Videos)',   body: sec09 },
    { num: '10', id: 'pinned',       title: 'Pinned Tweet — Wait for 100 Likes', body: sec10 },
    { num: '11', id: 'link-rule',    title: 'The Link Rule (CRITICAL)',          body: sec11 },
    { num: '12', id: 'image-reply',  title: 'Growth: Image Comments',            body: sec12 },
    { num: '13', id: 'steal',        title: 'Growth: Follower Stealing',         body: sec13 },
    { num: '14', id: 'shadowban',    title: 'Avoiding Shadowbans',               body: sec14 },
    { num: '15', id: 'bots',         title: 'Bots in Your Comments',             body: sec15 },
    { num: '16', id: 'viral',        title: 'When a Post Goes Viral',            body: sec16 },
    { num: '17', id: 'slowdown',     title: 'When Your Account Slows Down',      body: sec17 },
    { num: '18', id: 'checklist',    title: 'Daily / Weekly Checklist',          body: sec18 },
    { num: '19', id: 'premium',      title: 'At 1,000 Followers: X Premium',     body: sec19 },
    { num: '20', id: 'faq',          title: 'FAQ + How to Reach Us',             body: sec20 },
  ];

  // ── Sidebar nav ────────────────────────────────────────────────────
  const sidebarHtml = sections.map(s =>
    `<a class="gd-nav-link" href="#sec-${s.id}" onclick="event.preventDefault();(function(){var el=document.getElementById('sec-${s.id}');if(!el)return;el.classList.add('open');el.scrollIntoView({behavior:'smooth',block:'start'});})()"><span class="gd-nav-num">${s.num}</span>${escHtml(s.title)}</a>`
  ).join('');

  // ── Sections HTML ──────────────────────────────────────────────────
  const sectionsHtml = sections.map(s => sec(s.num, s.id, s.title, s.body, s.open)).join('');

  // ── Quick Wins ─────────────────────────────────────────────────────
  const quickWins = `
    <div class="gd-quickwins">
      <h2>5 Quick Wins — Do These Immediately!</h2>
      <ol>
        <li><strong>Don&apos;t put a link in any tweet — ever.</strong> The link lives in the bio only. A link in a tweet drops reach by 30–50 %.</li>
        <li><strong>Keep captions short and ask questions.</strong> Under 25 characters performs 3× better. Questions get 50 % more engagement than statements.</li>
        <li><strong>Engage for 5 minutes after every post.</strong> Scroll For You, reply, like — this is what wins the first 30 minutes.</li>
        <li><strong>Wait for 100 followers before requesting a link.</strong> Then DM Justin (@SunnyAngels_Admin). At 1,000 followers — message him again for Premium.</li>
        <li><strong>Use the Viral Photos / Videos / Text tabs daily.</strong> That is where you find what is working <em>this week</em> and which posts to image-reply on.</li>
      </ol>
    </div>
  `;

  // ── Final HTML ─────────────────────────────────────────────────────
  el.innerHTML = `
    <div class="gd-layout">
      <aside class="gd-sidebar">
        <div class="gd-sidebar-brand">Twitter / X Ops Guide</div>
        <nav class="gd-nav">${sidebarHtml}</nav>
      </aside>
      <main class="gd-main">
        <div class="gd-hero">
          <h1>Twitter / X Operations Guide</h1>
          <p>US Market Targeting — Team Playbook</p>
          <p class="gd-updated">Last updated: May 2026</p>
        </div>
        <div class="gd-search-wrap">
          <input class="gd-search-input" type="text" placeholder="Search the guide..." id="guide-search-input" oninput="guideSearch(this.value)">
        </div>
        ${quickWins}
        <div id="guide-sections">${sectionsHtml}</div>
        <p id="guide-no-results" class="gd-no-results" style="display:none">No sections match your search.</p>
        <div class="gd-footer">
          <p>Internal Sunny Angels playbook — do not distribute. Based on 4,996 tweets from 226 top creators + 2026 X algorithm research.</p>
        </div>
      </main>
    </div>
  `;

  el.dataset.rendered = '1';
}

// ─── GUIDE SEARCH ────────────────────────────────────────────────────
function guideSearch(query) {
  const q = query.trim().toLowerCase();
  const sections = document.querySelectorAll('#guide-sections .gd-section');
  let anyVisible = false;
  sections.forEach(s => {
    if (!q) { s.classList.remove('search-hidden'); anyVisible = true; return; }
    const title = (s.dataset.sectionTitle || '').toLowerCase();
    const body  = (s.querySelector('.gd-section-body') || {}).textContent || '';
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
  if (!str) return 'rgba(99, 91, 255,0.3)';
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const colors = ['rgba(99, 91, 255,0.4)', 'rgba(34, 211, 238,0.4)', 'rgba(255, 107, 138,0.4)',
                  'rgba(0,186,124,0.4)', 'rgba(255,122,0,0.4)', 'rgba(0,212,255,0.4)'];
  return colors[Math.abs(hash) % colors.length];
}

function stringToColor2(str) {
  if (!str) return 'rgba(34, 211, 238,0.3)';
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (str.charCodeAt(i) * 31 + hash) | 0;
  const colors = ['rgba(34, 211, 238,0.4)', 'rgba(0,186,124,0.4)', 'rgba(99, 91, 255,0.4)',
                  'rgba(255, 107, 138,0.4)', 'rgba(0,212,255,0.4)', 'rgba(255,122,0,0.4)'];
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
    $('#btn-scrape-daily').addEventListener('click', () => startScrape('daily-refresh'));
    $('#btn-scrape-monthly').addEventListener('click', () => startScrape('monthly-refresh'));
    $('#btn-scrape-backfill').addEventListener('click', () => startScrape('media-backfill'));
    $('#btn-scrape-stop').addEventListener('click', stopScrape);
    const arToggle = $('#auto-refresh-toggle');
    if (arToggle) {
      arToggle.addEventListener('change', toggleAutoRefresh);
      loadAutoRefresh();
    }
    $('#refresh-jobs-btn').addEventListener('click', () => { cacheClear('scrape_jobs'); loadJobs(); });
  }

  // Creators search (debounced)
  const creatorsSearchFn = debounce(() => { cacheClear('creators_'); loadCreators(); }, 300);
  $('#creators-search').addEventListener('input', creatorsSearchFn);

  // Creators sort dropdown
  $('#creators-sort').addEventListener('change', () => { cacheClear('creators_'); loadCreators(); });

  // Bios tab — operate on in-memory list so search is instant
  const biosSearchEl = $('#bios-search');
  if (biosSearchEl) {
    biosSearchEl.addEventListener('input', debounce(renderBios, 150));
    $('#bios-sort').addEventListener('change', e => { biosSort = e.target.value; renderBios(); });
    $('#bios-filter-buttons').addEventListener('click', e => {
      const btn = e.target.closest('.period-btn');
      if (!btn) return;
      $$('#bios-filter-buttons .period-btn').forEach(b => b.classList.toggle('active', b === btn));
      biosFilter = btn.dataset.value;
      renderBios();
    });
  }

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
