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

  // Workers log in with just the password — email is optional.
  if (!password) { showError(errEl, 'Please enter the password.'); return; }

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
    document.body.classList.add('is-worker');
    $('#nav-role-badge').textContent = 'Worker';
    $('#nav-role-badge').className = 'role-badge worker';
  }

  // Navigate to active tab. Workers default to the Guide tab regardless
  // of any stale localStorage entry pointing at a dashboard/creators URL.
  const hash = location.hash.replace('#', '') || state.activeTab;
  navigateTo(hash, false);
}

// ─── Tab Navigation ──────────────────────────────────────────────────
// Tabs workers may NOT access — dashboard analytics and the creators list
// are admin-only. Workers get the guide-centric experience: viral content,
// bios for inspiration, strategy, and the playbook.
const WORKER_BLOCKED_TABS = new Set(['dashboard', 'creators', 'add']);
const WORKER_DEFAULT_TAB  = 'guide';

function navigateTo(tab, pushState = true) {
  const validTabs = ['dashboard', 'creators', 'photos', 'videos', 'text', 'bios', 'strategy', 'guide', 'add'];
  if (!validTabs.includes(tab)) tab = state.role === 'admin' ? 'dashboard' : WORKER_DEFAULT_TAB;
  if (tab === 'add' && state.role !== 'admin') tab = WORKER_DEFAULT_TAB;
  if (state.role !== 'admin' && WORKER_BLOCKED_TABS.has(tab)) tab = WORKER_DEFAULT_TAB;

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
      const window = data.window_days ? `${data.window_days}-day window` : '3-day window';
      sub.textContent = `${data.schedule || 'Daily, 02:00 Europe/Berlin'} · ${window} · next: ${next}`;
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

// Convert an EST hour label ("6am", "1pm", "12pm") to its Asia/Manila
// equivalent. Manila is +13 hours from EST (year-round; we don't track
// the EDT vs EST difference here — close enough for slot reasoning).
function estToManila(estHour) {
  const m = estHour.match(/^(\d+)(am|pm)$/);
  if (!m) return estHour;
  let h = parseInt(m[1], 10) % 12;
  if (m[2] === 'pm') h += 12;
  const ph24 = (h + 13) % 24;
  const ph12 = ph24 % 12 || 12;
  const suf = ph24 < 12 ? 'a' : 'p';
  return `${ph12}${suf}`;
}

function renderTimeGrid() {
  const container = $('#time-grid');
  if (!container) return;
  const { days, hours, heat } = strategyData.bestTimes;

  // Left-most column: hour labels in BOTH US Eastern and Manila time
  let html = `<div class="time-col time-col-labels">
    <div class="time-day">·</div>
    ${hours.map(h => `
      <div class="time-hour-label">
        <span class="est">${h}</span>
        <span class="ph">${estToManila(h)}</span>
      </div>
    `).join('')}
  </div>`;

  // Day columns — slots no longer print the hour (left column owns labels)
  for (let d = 0; d < days.length; d++) {
    html += `<div class="time-col">
      <div class="time-day">${days[d]}</div>
      ${hours.map((h, hIdx) => `
        <div class="time-slot heat-${heat[hIdx][d]}" title="${days[d]} ${h} EST · ${estToManila(h)} Manila — heat ${heat[hIdx][d]}/5"></div>
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

  // ── CSS — mirrored 1:1 from sa-trendforge guide v3 ───────────────────
  if (!document.getElementById('guide-styles')) {
    const style = document.createElement('style');
    style.id = 'guide-styles';
    style.textContent = `
      #guide-content {
        --gbg: #050508;
        --gbg2: #09090f;
        --gsurface: rgba(18, 18, 32, 0.9);
        --gsurface2: rgba(28, 28, 48, 0.65);
        --gborder: rgba(255, 255, 255, 0.07);
        --gborder-hover: rgba(255, 255, 255, 0.13);
        --gtext: #eaeaf2;
        --gtext2: #7e7e9a;
        --gtext3: #4a4a66;
        --gaccent: #635bff;
        --gaccent2: #22d3ee;
        background: var(--gbg);
        background-image:
          radial-gradient(ellipse 90% 60% at 50% -30%, rgba(99, 91, 255, 0.07), transparent),
          radial-gradient(ellipse 70% 50% at 85% -10%, rgba(34, 211, 238, 0.04), transparent);
        background-attachment: fixed;
        min-height: 100vh;
        padding: 0;
      }
      .gd-wrap { max-width: 920px; margin: 0 auto; padding: 28px 24px 80px; }

      /* Hero */
      .gd-hero { text-align: center; padding: 16px 0 26px; }
      .gd-hero h1 {
        font-size: 36px; font-weight: 800; line-height: 1.15; margin: 0 0 14px; letter-spacing: -0.5px;
        background: linear-gradient(135deg, #ff6b8a 0%, #635bff 45%, #22d3ee 100%);
        -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
      }
      .gd-hero p { color: var(--gtext2); font-size: 14px; line-height: 1.65; max-width: 620px; margin: 0 auto; }

      /* Welcome / Important info blocks */
      .gd-info {
        background: linear-gradient(135deg, rgba(99,91,255,.08) 0%, rgba(34,211,238,.04) 100%);
        border: 1px solid var(--gborder);
        border-radius: 18px;
        padding: 22px 26px;
        margin: 18px 0;
      }
      .gd-info-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 2px; color: var(--gaccent2); text-transform: uppercase; margin-bottom: 8px; display: flex; align-items: center; gap: 9px; }
      .gd-info-eyebrow .gd-emoji { font-size: 16px; letter-spacing: 0; }
      .gd-info p { color: #bbb; font-size: 14px; line-height: 1.7; margin: 6px 0; }
      .gd-info p strong { color: #fff; }
      .gd-info .gd-hl { color: var(--gaccent2); font-weight: 700; }

      /* Chapter pill nav */
      .gd-chnav {
        position: -webkit-sticky; position: sticky; top: 0; z-index: 20;
        display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;
        padding: 14px 0; margin: 24px 0 8px;
        background: rgba(5,5,8,.96);
        -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      }
      .gd-chtab {
        position: relative; background: var(--gsurface); border: 1px solid var(--gborder);
        border-radius: 12px; padding: 14px 16px; text-align: left; cursor: pointer;
        transition: border-color .2s ease, transform .2s ease, box-shadow .2s ease, background .2s ease;
        display: flex; align-items: center; gap: 12px; color: var(--gtext2);
        font-family: inherit; overflow: hidden; text-decoration: none;
        -webkit-tap-highlight-color: transparent; touch-action: manipulation;
      }
      @media (hover: hover) {
        .gd-chtab:hover { border-color: rgba(99,91,255,.35); transform: translateY(-2px); box-shadow: 0 8px 20px rgba(0,0,0,.25); text-decoration: none; }
      }
      .gd-chtab.active {
        border-color: var(--gaccent);
        background: linear-gradient(135deg, rgba(99,91,255,.08), rgba(34,211,238,.04));
        color: var(--gtext);
      }
      .gd-chtab-icon { font-size: 22px; line-height: 1; flex-shrink: 0; }
      .gd-chtab-txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .gd-chtab-title { font-size: 14px; font-weight: 700; color: var(--gtext); line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .gd-chtab-sub { font-size: 11px; color: var(--gtext3); line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      /* Action bar */
      .gd-ctrl { display: flex; gap: 8px; margin: 6px 0 18px; flex-wrap: wrap; }
      .gd-btn { background: var(--gsurface); border: 1px solid var(--gborder); color: var(--gtext2); padding: 7px 13px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all .15s; }
      .gd-btn:hover { border-color: var(--gaccent); color: var(--gtext); }

      /* Search */
      .gd-search { width: 100%; padding: 12px 16px; border-radius: 10px; background: var(--gsurface); border: 1px solid var(--gborder); color: var(--gtext); font-size: 14px; outline: none; box-sizing: border-box; font-family: inherit; margin: 8px 0 14px; }
      .gd-search:focus { border-color: var(--gaccent); }
      .gd-search::placeholder { color: var(--gtext3); }

      /* Chapter container */
      .gd-chapter { margin-bottom: 40px; scroll-margin-top: 110px; }
      .gd-chapter-head {
        display: flex; align-items: center; gap: 18px;
        padding: 24px 28px; margin-bottom: 16px;
        background: linear-gradient(135deg, rgba(99,91,255,.08) 0%, rgba(34,211,238,.04) 100%);
        border: 1px solid var(--gborder); border-radius: 18px;
        position: relative; overflow: hidden;
      }
      .gd-chapter-head::before {
        content: ''; position: absolute; inset: 0;
        background: radial-gradient(ellipse 60% 80% at 100% 0%, rgba(99,91,255,.12), transparent);
        pointer-events: none;
      }
      .gd-chapter-icon { font-size: 44px; line-height: 1; flex-shrink: 0; filter: drop-shadow(0 4px 12px rgba(0,0,0,.4)); }
      .gd-chapter-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: 2px; color: var(--gaccent2); text-transform: uppercase; margin-bottom: 2px; }
      .gd-chapter-title { font-size: 26px; font-weight: 800; color: var(--gtext); margin: 0; letter-spacing: -0.5px; line-height: 1.2; }
      .gd-chapter-subtitle { font-size: 13px; color: var(--gtext3); margin-top: 4px; }

      /* Section card */
      .gd-sec { background: transparent; border: none; padding: 0; margin-bottom: 12px; scroll-margin-top: 110px; }
      .gd-sec-head {
        cursor: pointer; user-select: none;
        padding: 14px 18px; background: var(--gsurface);
        border: 1px solid var(--gborder); border-radius: 12px;
        display: flex; align-items: center; gap: 12px;
        transition: all .15s; position: relative;
      }
      .gd-sec-head:hover { border-color: rgba(99,91,255,.35); }
      .gd-sec-check {
        width: 24px; height: 24px; border-radius: 50%;
        border: 2px solid var(--gborder); background: transparent;
        color: #4caf50; font-size: 13px; font-weight: 700;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        padding: 0; flex-shrink: 0; transition: all .15s;
      }
      .gd-sec-check:hover { border-color: #4caf50; }
      .gd-sec-check.done { background: #4caf50; border-color: #4caf50; color: #fff; }
      .gd-sec-num {
        background: linear-gradient(135deg, var(--gaccent) 0%, var(--gaccent2) 100%);
        color: white; width: 48px; height: 48px; border-radius: 14px;
        display: flex; align-items: center; justify-content: center;
        font-weight: 800; font-size: 19px; flex-shrink: 0;
      }
      .gd-sec-title { font-size: 17px; font-weight: 700; margin: 0; flex: 1; color: #fff; }
      .gd-sec-chev { font-size: 18px; color: var(--gtext3); transition: transform .25s; margin-left: auto; flex-shrink: 0; }
      .gd-sec.collapsed .gd-sec-chev { transform: rotate(-90deg); }
      .gd-sec-body {
        overflow: hidden; max-height: 20000px;
        transition: max-height .35s ease, opacity .2s ease, padding .25s ease;
        opacity: 1; padding: 20px 4px 8px;
      }
      .gd-sec.collapsed .gd-sec-body { max-height: 0; opacity: 0; padding-top: 0; padding-bottom: 0; }

      /* Section body typography */
      .gd-sec-body h3 { font-size: 17px; font-weight: 700; margin: 22px 0 14px; color: var(--gaccent2); display: flex; align-items: center; gap: 10px; }
      .gd-sec-body h4 { margin: 16px 0 8px; font-size: 15px; color: #fff; }
      .gd-sec-body p { color: #bbb; line-height: 1.7; margin: 0 0 14px; font-size: 14.5px; }
      .gd-sec-body p strong, .gd-sec-body li strong { color: #fff; }
      .gd-sec-body ul, .gd-sec-body ol { margin: 14px 0; padding-left: 24px; }
      .gd-sec-body li { color: #bbb; line-height: 1.65; margin-bottom: 8px; font-size: 14.5px; }
      .gd-sec-body em { color: #eaeaf2; background: rgba(99,91,255,.10); padding: 2px 6px; border-radius: 5px; font-style: normal; font-size: 13.5px; }
      .gd-sec-body code { background: rgba(99,91,255,.12); color: #fff; padding: 2px 7px; border-radius: 5px; font-family: 'SF Mono','Monaco','Consolas',monospace; font-size: 12.5px; border: 1px solid rgba(99,91,255,.22); }

      /* Alerts */
      .gd-alert { padding: 18px 22px; border-radius: 14px; margin: 20px 0; display: flex; gap: 14px; align-items: flex-start; line-height: 1.6; }
      .gd-alert-icon { font-size: 22px; flex-shrink: 0; }
      .gd-alert-body { flex: 1; font-size: 14px; color: #c4c4d6; }
      .gd-alert-body strong { display: block; margin-bottom: 5px; font-size: 14.5px; }
      .gd-alert.red { background: rgba(99,91,255,.10); border: 1px solid rgba(99,91,255,.30); }
      .gd-alert.red .gd-alert-body strong { color: #ff6b8a; }
      .gd-alert.green { background: rgba(34,197,94,.12); border: 1px solid rgba(34,197,94,.30); }
      .gd-alert.green .gd-alert-body strong { color: #4ade80; }
      .gd-alert.blue { background: rgba(34,211,238,.10); border: 1px solid rgba(34,211,238,.25); }
      .gd-alert.blue .gd-alert-body strong { color: #22d3ee; }
      .gd-alert.yellow { background: rgba(245,158,11,.12); border: 1px solid rgba(245,158,11,.30); }
      .gd-alert.yellow .gd-alert-body strong { color: #fbbf24; }

      /* Numbered steps */
      .gd-step { display: flex; gap: 15px; margin: 12px 0; padding: 16px 18px; background: rgba(26,26,34,.8); border-radius: 12px; align-items: flex-start; }
      .gd-step-num {
        background: linear-gradient(135deg, var(--gaccent) 0%, var(--gaccent2) 100%);
        color: white; min-width: 30px; height: 30px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 13px; flex-shrink: 0;
      }
      .gd-step-body { flex: 1; color: #bbb; line-height: 1.65; font-size: 14px; }
      .gd-step-body strong { color: #fff; }

      /* DO / DON'T grid */
      .gd-dodont { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 24px 0; }
      .gd-do, .gd-dont { padding: 22px; border-radius: 14px; }
      .gd-do { background: rgba(34,197,94,.08); border: 1px solid rgba(34,197,94,.30); }
      .gd-do h4 { color: #4ade80; margin-bottom: 14px; font-size: 16px; }
      .gd-dont { background: rgba(99,91,255,.08); border: 1px solid rgba(99,91,255,.30); }
      .gd-dont h4 { color: #ff6b8a; margin-bottom: 14px; font-size: 16px; }
      .gd-do ul, .gd-dont ul { padding-left: 20px; margin: 0; }
      .gd-do li, .gd-dont li { color: #ccc; margin-bottom: 10px; line-height: 1.55; font-size: 14px; }

      /* Checklist */
      .gd-checklist { background: rgba(26,26,34,.8); border-radius: 14px; padding: 20px 24px; margin: 20px 0; }
      .gd-checklist h4 { color: var(--gaccent2); font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; font-size: 15px; }
      .gd-ci { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.06); color: #ccc; align-items: center; line-height: 1.5; font-size: 14px; }
      .gd-ci:last-child { border-bottom: none; }
      .gd-ci input { width: 18px; height: 18px; accent-color: var(--gaccent); cursor: pointer; flex-shrink: 0; }
      .gd-ci.done label { color: #6a6a85; text-decoration: line-through; }
      .gd-ci label { flex: 1; cursor: pointer; }

      /* Tables */
      .gd-tbl-wrap { overflow-x: auto; margin: 16px 0; border-radius: 12px; border: 1px solid var(--gborder); }
      .gd-tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 380px; }
      .gd-tbl thead { background: linear-gradient(90deg, rgba(99,91,255,.10), rgba(34,211,238,.06)); }
      .gd-tbl th { text-align: left; padding: 12px 14px; color: var(--gaccent2); font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      .gd-tbl td { padding: 11px 14px; color: #c4c4d6; border-top: 1px solid var(--gborder); }
      .gd-tbl td strong { color: #fff; }
      .gd-tbl tr:hover td { background: rgba(99,91,255,.04); }

      /* Code blocks */
      .gd-code { background: rgba(10,10,16,.6); border: 1px solid var(--gborder); border-radius: 12px; overflow: hidden; margin: 16px 0; }
      .gd-code-hdr { display: flex; justify-content: space-between; align-items: center; padding: 9px 14px; background: rgba(0,0,0,.3); border-bottom: 1px solid var(--gborder); }
      .gd-code-hdr-label { font-size: 11px; color: var(--gtext2); text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
      .gd-code-copy { background: transparent; border: 1px solid var(--gborder); color: var(--gtext2); padding: 4px 12px; border-radius: 6px; font-size: 11px; cursor: pointer; transition: all .15s; font-family: inherit; }
      .gd-code-copy:hover { border-color: var(--gaccent); color: var(--gtext); }
      .gd-code-line { display: flex; justify-content: space-between; align-items: center; padding: 9px 14px; border-top: 1px solid rgba(255,255,255,.04); gap: 10px; }
      .gd-code-line:first-of-type { border-top: none; }
      .gd-code-line span { font-family: 'SF Mono','Monaco','Consolas',monospace; font-size: 13px; color: #c4c4d6; flex: 1; word-break: break-word; }

      /* Caption items */
      .gd-cap-cat { margin-bottom: 22px; }
      .gd-cap-cat h4 { color: var(--gaccent2) !important; text-transform: uppercase; letter-spacing: .08em; font-size: 12.5px !important; margin-bottom: 12px !important; display: flex; align-items: center; gap: 8px; }
      .gd-cap-item { display: flex; justify-content: space-between; align-items: center; background: rgba(26,26,34,.7); border: 1px solid var(--gborder); border-radius: 10px; padding: 11px 15px; margin-bottom: 7px; gap: 10px; transition: all .15s; }
      .gd-cap-item:hover { border-color: var(--gaccent); transform: translateX(2px); }
      .gd-cap-item span { font-size: 13.5px; color: #c4c4d6; flex: 1; }

      /* Scenario chips */
      .gd-scen { display: flex; gap: 14px; align-items: flex-start; background: rgba(26,26,34,.7); border: 1px solid var(--gborder); border-radius: 12px; padding: 14px 18px; margin: 10px 0; }
      .gd-scen-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
      .gd-scen-body { flex: 1; font-size: 14px; color: #bbb; line-height: 1.6; }
      .gd-scen-body strong { display: block; color: #fff; font-size: 14.5px; margin-bottom: 3px; }
      .gd-scen.green .gd-scen-dot { background: #4ade80; box-shadow: 0 0 14px rgba(74,222,128,.5); }
      .gd-scen.yellow .gd-scen-dot { background: #fbbf24; box-shadow: 0 0 14px rgba(251,191,36,.5); }
      .gd-scen.blue .gd-scen-dot { background: #22d3ee; box-shadow: 0 0 14px rgba(34,211,238,.5); }
      .gd-scen.red .gd-scen-dot { background: #ff6b8a; box-shadow: 0 0 14px rgba(255,107,138,.5); }

      /* Contact card */
      .gd-contact {
        background: linear-gradient(135deg, rgba(99,91,255,.18) 0%, rgba(34,211,238,.10) 100%);
        border: 1px solid rgba(99,91,255,.45);
        border-radius: 14px; padding: 20px 24px; margin: 18px 0;
        position: relative; overflow: hidden;
      }
      .gd-contact::before {
        content: ''; position: absolute; inset: 0;
        background: radial-gradient(ellipse 60% 100% at 100% 0%, rgba(34,211,238,.14), transparent);
        pointer-events: none;
      }
      .gd-contact-label { font-size: 11px; font-weight: 700; letter-spacing: 1.5px; color: var(--gaccent2); text-transform: uppercase; margin-bottom: 6px; position: relative; }
      .gd-contact-handle { font-size: 22px; font-weight: 800; color: #fff; margin-bottom: 8px; word-break: break-word; position: relative; }
      .gd-contact-desc { font-size: 14px; color: #c4c4d6; line-height: 1.6; margin: 0; position: relative; }

      /* FAQ */
      .gd-faq { background: rgba(26,26,34,.7); border: 1px solid var(--gborder); border-radius: 12px; margin: 8px 0; overflow: hidden; }
      .gd-faq-q { padding: 16px 20px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 14.5px; color: var(--gtext); user-select: none; transition: background .15s; gap: 14px; }
      .gd-faq-q:hover { background: rgba(99,91,255,.05); }
      .gd-faq-q svg { width: 18px; height: 18px; color: var(--gtext3); transition: transform .25s; flex-shrink: 0; }
      .gd-faq.open .gd-faq-q svg { transform: rotate(180deg); color: var(--gaccent2); }
      .gd-faq-a { max-height: 0; overflow: hidden; transition: max-height .3s ease; }
      .gd-faq-a-inner { padding: 0 20px 18px; font-size: 14px; color: #b5b5c8; line-height: 1.7; }

      /* Footer */
      .gd-footer { text-align: center; padding: 40px 0 20px; color: var(--gtext3); font-size: 12px; margin-top: 40px; }

      /* Hidden during search */
      .gd-sec.hidden { display: none; }

      /* Mobile */
      @media (max-width: 720px) {
        .gd-wrap { padding: 18px 14px 60px; }
        .gd-hero h1 { font-size: 26px; }
        .gd-hero p { font-size: 13.5px; }
        .gd-chnav {
          position: static;
          top: auto;
          grid-template-columns: repeat(2, 1fr);
          padding: 10px 0;
          gap: 7px;
          overflow-x: visible;
          background: transparent;
          backdrop-filter: none;
          -webkit-backdrop-filter: none;
          border-bottom: none;
        }
        .gd-chtab { padding: 10px 12px; }
        .gd-chtab-icon { font-size: 18px; }
        .gd-chtab-title { font-size: 12.5px; }
        .gd-chtab-sub { font-size: 10.5px; }
        .gd-chapter-head { padding: 18px 20px; gap: 14px; border-radius: 14px; }
        .gd-chapter-icon { font-size: 32px; }
        .gd-chapter-title { font-size: 19px; }
        .gd-chapter-subtitle { font-size: 12px; }
        .gd-sec-head { padding: 12px 14px; gap: 10px; }
        .gd-sec-num { width: 40px; height: 40px; font-size: 16px; border-radius: 12px; }
        .gd-sec-title { font-size: 15px; }
        .gd-sec-body { padding: 16px 4px 4px; }
        .gd-sec-body p, .gd-sec-body li { font-size: 14px; }
        .gd-dodont { grid-template-columns: 1fr; gap: 14px; }
        .gd-do, .gd-dont { padding: 16px 18px; }
        .gd-tbl { font-size: 12.5px; }
        .gd-tbl th, .gd-tbl td { padding: 9px 11px; }
        .gd-step { padding: 13px 15px; gap: 12px; }
        .gd-info { padding: 18px 20px; }
        .gd-info p { font-size: 13.5px; }
        .gd-contact-handle { font-size: 18px; }
        .gd-ci input { width: 22px; height: 22px; }
      }

      /* iOS / touch — bigger taps, no flash, no zoom on focus */
      .gd-btn, .gd-sec-head, .gd-sec-check, .gd-chtab, .gd-faq-q, .gd-code-copy {
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }
      .gd-search { font-size: 16px; }
      .gd-search::-webkit-search-decoration,
      .gd-search::-webkit-search-cancel-button { -webkit-appearance: none; }

      @media (max-width: 720px) {
        .gd-chtab { min-height: 52px; }
        .gd-sec-head { min-height: 56px; padding: 14px 14px; }
        .gd-sec-check { width: 32px; height: 32px; }
        .gd-ci { min-height: 44px; }
        .gd-btn { min-height: 40px; padding: 9px 14px; font-size: 13px; }
        .gd-faq-q { min-height: 56px; padding: 16px 18px; }
        .gd-code-copy { padding: 8px 14px; font-size: 12px; }
      }

      /* Native iOS momentum scroll wins over JS smooth-scroll */
      @media (hover: none) and (pointer: coarse) {
        html { scroll-behavior: auto; }
      }

      /* Respect reduced motion */
      @media (prefers-reduced-motion: reduce) {
        .gd-sec-body, .gd-chtab, .gd-sec-head, .gd-faq, .gd-sec-chev, .gd-faq-q svg { transition: none; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  function alert_(color, body) {
    const icon = { red: '🚨', green: '✅', blue: '💡', yellow: '⚠️' }[color] || '💡';
    return `<div class="gd-alert ${color}"><span class="gd-alert-icon">${icon}</span><div class="gd-alert-body">${body}</div></div>`;
  }
  function step(num, body) {
    return `<div class="gd-step"><div class="gd-step-num">${num}</div><div class="gd-step-body">${body}</div></div>`;
  }
  function doDont(doTitle, doItems, dontTitle, dontItems) {
    return `<div class="gd-dodont">
      <div class="gd-do"><h4>✅ ${doTitle}</h4><ul>${doItems.map(i => `<li>${i}</li>`).join('')}</ul></div>
      <div class="gd-dont"><h4>❌ ${dontTitle}</h4><ul>${dontItems.map(i => `<li>${i}</li>`).join('')}</ul></div>
    </div>`;
  }
  function scen(color, label, body) {
    return `<div class="gd-scen ${color}"><div class="gd-scen-dot"></div><div class="gd-scen-body"><strong>${label}</strong>${body}</div></div>`;
  }
  function tbl(headers, rows) {
    const th = headers.map(h => `<th>${h}</th>`).join('');
    const tr = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<div class="gd-tbl-wrap"><table class="gd-tbl"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }
  function codeBlock(lines, header) {
    const safe = JSON.stringify(lines.join('\\n')).replace(/"/g, '&quot;');
    const hdr = `<div class="gd-code-hdr"><span class="gd-code-hdr-label">${escHtml(header || 'Snippet')}</span><button class="gd-code-copy" onclick="copyToClipboard(${safe});this.textContent='Copied!';setTimeout(()=>this.textContent='Copy all',1500)">Copy all</button></div>`;
    const body = lines.filter(l => l.trim()).map(l => `<div class="gd-code-line"><span>${escHtml(l.trim())}</span></div>`).join('');
    return `<div class="gd-code">${hdr}${body}</div>`;
  }
  function captionItems(lines) {
    return lines.filter(l => l.trim()).map(l => {
      const safe = JSON.stringify(l.trim()).replace(/"/g, '&quot;');
      return `<div class="gd-cap-item"><span>${escHtml(l.trim())}</span><button class="gd-code-copy" onclick="copyToClipboard(${safe});this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',1500)">Copy</button></div>`;
    }).join('');
  }
  let clIdx = 0;
  function checklist(title, items, pfx) {
    return `<div class="gd-checklist"><h4>${title}</h4>${items.map(item => {
      const id = `gcl_${pfx}_${clIdx++}`;
      const chk = localStorage.getItem(id) === '1';
      return `<div class="gd-ci ${chk ? 'done' : ''}" id="li_${id}"><input type="checkbox" id="${id}" ${chk ? 'checked' : ''} onchange="localStorage.setItem('${id}',this.checked?'1':'0');document.getElementById('li_${id}').classList.toggle('done',this.checked);"><label for="${id}">${escHtml(item)}</label></div>`;
    }).join('')}</div>`;
  }
  function contact(label, handle, desc) {
    return `<div class="gd-contact"><div class="gd-contact-label">${label}</div><div class="gd-contact-handle">${handle}</div><p class="gd-contact-desc">${desc}</p></div>`;
  }
  function faq(q, a) {
    return `<div class="gd-faq">
      <div class="gd-faq-q" onclick="(function(item){var w=item.classList.contains('open');document.querySelectorAll('.gd-faq').forEach(function(i){i.classList.remove('open');i.querySelector('.gd-faq-a').style.maxHeight=null;});if(!w){item.classList.add('open');var ans=item.querySelector('.gd-faq-a');ans.style.maxHeight=ans.scrollHeight+'px';}})(this.closest('.gd-faq'))">
        <span>${escHtml(q)}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="gd-faq-a"><div class="gd-faq-a-inner">${a}</div></div>
    </div>`;
  }
  function section(num, id, title, body) {
    const dk = `gsec_done_${id}`;
    const done = localStorage.getItem(dk) === '1';
    return `<div class="gd-sec collapsed" id="sec-${id}" data-title="${escHtml(num + '. ' + title)}">
      <div class="gd-sec-head" onclick="this.closest('.gd-sec').classList.toggle('collapsed')">
        <button class="gd-sec-check ${done ? 'done' : ''}" onclick="event.stopPropagation();var b=this;var s=b.closest('.gd-sec');var d=b.classList.toggle('done');b.innerHTML=d?'✓':'';localStorage.setItem('${dk}',d?'1':'0');">${done ? '✓' : ''}</button>
        <div class="gd-sec-num">${num}</div>
        <h2 class="gd-sec-title">${escHtml(title)}</h2>
        <span class="gd-sec-chev">▾</span>
      </div>
      <div class="gd-sec-body">${body}</div>
    </div>`;
  }

  // ── Section content ──────────────────────────────────────────────────

  const sec01 = `
    <p>Welcome. This is the playbook for running a Twitter / X account for one of our creators.</p>
    <p>Your job at the highest level: <strong>build a following</strong> by posting fun personality content and engaging with people. Followers become people who click the bio link — that&apos;s where the revenue happens.</p>

    <h3>🎯 The Three Levers That Run Everything</h3>
    ${step(1, '<strong>Replies are king.</strong> A reply chain is 150× more valuable than a like.')}
    ${step(2, '<strong>The first 30 minutes decide.</strong> If a tweet gets traction fast, it spreads. If not, it dies.')}
    ${step(3, '<strong>Consistency beats bursts.</strong> Steady daily activity grows accounts. 10 posts one day and 0 the next gets you flagged.')}

    <h3>📊 The 90 / 10 Rule</h3>
    <p>About <strong>90 %</strong> of your tweets are personality, humor, engagement bait. Only <strong>10 %</strong> are promotional. Push the link too hard and the algorithm hides you.</p>

    <h3>🛠️ How to Use This Dashboard Daily</h3>
    ${doDont(
      'DO',
      ['Open <strong>Viral Photos / Videos / Text</strong> at the start of every shift', 'Use the <strong>Creators</strong> tab to find accounts to comment under', 'Use the <strong>Bios</strong> tab for bio inspiration', 'Check <strong>Strategy</strong> for what is working this week'],
      "DON'T",
      ['Don&apos;t skip this — the patterns shift weekly', 'Don&apos;t copy captions word-for-word across accounts', 'Don&apos;t comment on dead tweets — only fresh ones', 'Don&apos;t rely on memory — open the dashboard']
    )}

    ${alert_('red', '<strong>THE ONE RULE TO REMEMBER</strong>Never put a link in any tweet. Ever. The link lives in the bio only. Read <strong>Section 11</strong> before you post anything with a link.')}
  `;

  const sec02 = `
    <p>The first hour after creating the account decides a lot. Skip one wrong setting and you fight an uphill battle for weeks.</p>

    <h3>📱 Creating the Account</h3>
    ${step(1, '<strong>Use the email and phone provided by the team.</strong> Never your personal contacts.')}
    ${step(2, 'Confirm email + phone <strong>immediately</strong> so the account isn&apos;t flagged as suspicious.')}
    ${step(3, '<strong>Pick a username.</strong> Memorable, persona-based, lowercase only.')}
    ${step(4, '<strong>Complete the profile</strong> right away (avatar, banner, bio). Twitter treats completeness as trust.')}
    ${step(5, 'Send account details to your <strong>supervisor</strong> so the team has them on file.')}

    ${alert_('yellow', '<strong>USERNAME RULE</strong>Avoid spam-y names like <code>sexybaby9747</code> or <code>hotgirl2024</code> — those are flagged before the account even posts. Good patterns: <code>@bellacosplay</code>, <code>@lavendergloss</code>, <code>@iamruby</code>.')}

    <h3>⚙️ Settings to Configure Right Now</h3>
    <p>Open the X app → <em>Settings &amp; Privacy</em>. Walk through every item below.</p>

    ${step(1, '<strong>Mark your own media as sensitive — ON.</strong> <em>Privacy and safety → Your posts → Mark media you Tweet as containing material that may be sensitive.</em> This is about YOUR posts. Without it, X silently reduces your reach.')}
    ${step(2, '<strong>Precise location — OFF.</strong> <em>Privacy and safety → Location information.</em> Precise location filters reach geographically; we want the whole US.')}
    ${step(3, '<strong>NSFW filter — ON (so you do NOT see explicit content).</strong> <em>Privacy and safety → Content you see → "Display media that may contain sensitive content" → leave UNCHECKED / OFF.</em> This blocks explicit content from showing up on your screen while you work. The dashboard already curates SFW posts from our tracked creators — you should never have to look at explicit content as part of this job.')}
    ${step(4, '<strong>Discoverability — both ON.</strong> Let people find you by email and phone.')}
    ${step(5, '<strong>Direct messages — Allow from everyone.</strong> We want DMs flowing in.')}
    ${step(6, '<strong>Professional / Twitter Pro — LEAVE OFF.</strong> Tags the account as a business and kills personal reach.')}
    ${step(7, '<strong>Language: English (US). Phone region: United States.</strong>')}
    ${step(8, '<strong>Birthday — hide both year and date.</strong> Edit Profile → "Who can see this" → Only you.')}

    ${alert_('green', '<strong>WHY THE NSFW FILTER IS ON</strong>Two different settings, easy to confuse:<br><br>• <strong>Mark your media as sensitive</strong> (Step 1) — about YOUR posts. ON. Helps reach.<br>• <strong>Display sensitive media</strong> (Step 3) — about what YOU SEE. OFF. Protects you from explicit content while doing your job.<br><br>Your work is done from the <strong>dashboard</strong> — Viral Photos / Videos / Text already filter out explicit material. You do not need to expose yourself to anything you would not want to see. If you ever see something explicit on X while working, mute or block the account and move on.')}

    ${alert_('red', '<strong>DAY 1 RULES</strong>For the <strong>first 24 hours after signup</strong>: just set up the profile, scroll the For You page for 10 minutes, like 5–10 tweets. Do NOT follow anyone. Do NOT post. Twitter watches new accounts very closely in the first day.')}
  `;

  const sec03 = `
    <p>The profile is your storefront. Most people decide whether to follow within 5 seconds of opening it. Make those 5 seconds count.</p>

    <h3>🪞 Profile Picture (Avatar)</h3>
    ${doDont(
      'GOOD AVATAR',
      ['Clear face shot — humans recognize faces fastest', 'Bright, daylight lighting', 'Beach, pool, bed in daylight, cozy room with a window', 'Eye contact with the camera'],
      'BAD AVATAR',
      ['Dark or blurry photos', 'Bedroom mirror at night', 'Explicit nudity (X restricts the account)', 'Cartoon avatars or stock images']
    )}

    <h3>🖼️ Header / Banner</h3>
    <ul>
      <li>A second photo of the creator (different from the avatar)</li>
      <li>A cosplay or themed shot</li>
      <li>An aesthetic background (pink gradient, beach, neon) with the username overlaid</li>
      <li>A clean meme that fits the persona</li>
    </ul>
    ${alert_('yellow', '<strong>ALWAYS CHECK ON MOBILE</strong>After uploading the banner, open the profile on a phone. Almost all followers see Twitter on mobile and the banner crops differently. If the face is cut off — re-crop and re-upload.')}

    <h3>🏷️ Display Name &amp; Username</h3>
    <ul>
      <li>Display name: persona first name + soft emoji: <code>bella ♡</code>, <code>ruby 🌸</code></li>
      <li>Keep it short — long display names get truncated</li>
      <li>No "18+", "NSFW", or anything explicit in the display name</li>
    </ul>

    <h3>✍️ Bio Formula</h3>
    <p><strong>[Personality / niche]</strong> + <strong>[soft hint]</strong> + <strong>[arrow ↓]</strong>. The arrow points to the link spot — even with no link yet, it primes people to look there.</p>
    ${codeBlock([
      '"your online addiction ♡"',
      '"most viral girl on X for a reason 👇"',
      '"full time internet gf 🤍"',
      '"bad decisions only"',
      '"hai i cosplay kinda 🪽 see more me :D ↓"',
      '"Cosplayer ♡ UR Goth GF"',
    ], 'Working bio examples')}

    ${doDont(
      'BIO DO',
      ['Maximum 1–2 emojis', 'Arrow (↓ / 👇) at the end of the bio text', 'Short and witty', 'Match the persona&apos;s vibe'],
      "BIO DON'T",
      ['No "18+" / "NSFW"', 'No "subscribe" or "DM for" wording', 'No link yet — Section 11', 'No long descriptions']
    )}

    <h3>📌 Pinned Tweet</h3>
    ${alert_('yellow', '<strong>WAIT — DO NOT PIN YET</strong>Leave the pin empty until a post hits <strong>100 likes</strong>. Pinning a weak tweet makes the account look dead. See Section 10.')}

    <h3>📍 Profile Details</h3>
    <ul>
      <li><strong>Location:</strong> a US city that fits the persona (LA, Miami, Austin, Tampa, Phoenix). Skip "United States" — too vague.</li>
      <li><strong>Website:</strong> blank until your supervisor sends you the link at 100 followers (see Section 11).</li>
      <li><strong>Birthday:</strong> persona age 22–28. Year and date hidden.</li>
    </ul>
  `;

  const sec04 = `
    <p>Twitter watches new accounts closely. The first three weeks are about looking like a real person <em>before</em> you act like a creator. Rush it and you get shadowbanned in the first month.</p>

    ${alert_('yellow', '<strong>THE WARM-UP RULE</strong>Posting starts on Day 1 but at very low volume. The schedule below is the safe path — never exceed these numbers.')}

    <h3>🌱 Phase 1 — Day 1 to Day 3 (Light start)</h3>
    ${step(1, '<strong>1 post per day</strong> — one good photo + short caption')}
    ${step(2, 'Follow 5–10 creators in our niche (spread across the day)')}
    ${step(3, 'Like 10–20 tweets per day')}
    ${step(4, 'Write 5 short, friendly replies on other creators&apos; tweets')}
    ${step(5, 'Scroll the For You page 10 minutes')}
    ${doDont(
      'PHASE 1 DO',
      ['1 post / day', 'Light interaction', 'Use the Viral tabs to study patterns'],
      "PHASE 1 DON'T",
      ['No link in bio yet', 'No link in any tweet', 'No mass follow / unfollow']
    )}

    <h3>🌿 Phase 2 — Day 4 to Day 10 (Engagement build)</h3>
    ${step(1, '<strong>2 posts per day</strong>, 4–6 hours apart')}
    ${step(2, 'Follow 10–15 more creators (total ~30–40)')}
    ${step(3, 'Like 30–50 tweets per day')}
    ${step(4, '15 thoughtful replies per day')}
    ${step(5, 'Start <strong>Image Comments</strong> (Section 12) — 3–5 per day')}

    <h3>🌳 Phase 3 — Day 11 onward (Full operation)</h3>
    ${step(1, '<strong>3 posts per day</strong>, spread across active hours')}
    ${step(2, 'Like 50–100 tweets per day')}
    ${step(3, '20–30 replies per day, half as image-replies on viral posts')}
    ${step(4, '5–10 follower steals per day (Section 13)')}
    ${step(5, 'Once you cross <strong>100 followers</strong>: DM Justin (@SunnyAngels_Admin) → he creates your link → add to bio')}

    <h3>📋 Quick Reference</h3>
    ${tbl(['Action','Day 1–3','Day 4–10','Day 11 +'],[
      ['Posts','1 / day','2 / day','3 / day'],
      ['Follows','5–10','10–15','max 30'],
      ['Likes','10–20','30–50','50–100'],
      ['Replies','5','15','20–30'],
      ['Link in bio','No','No','After 100 followers'],
    ])}
  `;

  const sec05 = `
    <p>You don&apos;t need to know everything about the algorithm. You need the seven rules below and what they look like in real life.</p>

    <h3>1️⃣ Replies are the strongest signal — 150× a like</h3>
    <p>Twitter measures how much your tweet starts conversations. A reply chain tells the algorithm "push this harder."</p>
    ${scen('blue', '💬 Scenario', 'You post and get 50 likes but 0 replies. The algorithm reads "popular but not interesting" and stops pushing. <strong>Fix:</strong> always end captions with a question. "(be honest)" doubles reply chances — it reads as a challenge.')}

    <h3>2️⃣ The first 30 minutes decide everything</h3>
    <p>Twitter tests every tweet on a small audience first. If engagement is strong in the first 30 minutes, it gets pushed wider. If not, it dies.</p>
    ${scen('yellow', '⏱️ Scenario', 'You post and go check the kitchen for 20 minutes. Nobody happens to see it. <strong>Fix:</strong> right after posting — like 3 tweets on For You, reply to 2 creators, scroll for 5 minutes. This tells the algorithm <em>you</em> are active, so it shows your tweet wider.')}

    <h3>3️⃣ Bookmarks are gold — 20× a like</h3>
    <p>Most creators ignore bookmarks. Saving a tweet tells Twitter "I want to come back to this" — much stronger than a like.</p>
    ${scen('green', '🔖 Scenario', 'A photo with caption "this is what 180lbs looks like :D" gets bookmarked because viewers want to look at it later. That bookmark counts 20× a like. <strong>Fix:</strong> save-worthy photos (full body, well-composed) collect bookmarks even if likes look quiet.')}

    <h3>4️⃣ Short captions outperform long — by 3×</h3>
    ${scen('blue', '✂️ Scenario', '"am i your type? (be honest)" → 36,116 likes. The same idea written as a paragraph would die at 200 likes. <strong>Rule of thumb:</strong> if your caption is longer than the tweet box width on mobile, cut it.')}

    <h3>5️⃣ Questions beat statements — by 50 %</h3>
    ${scen('blue', '❓ Scenario', '"I love my new outfit" vs "do you like my new outfit?" — same photo, the question gets twice the replies. Adding "(be honest)" doubles it again.')}

    <h3>6️⃣ Links in the main tweet kill reach — by 30–50 %</h3>
    ${scen('red', '🔗 Scenario', 'You post a photo with caption "more here ↓ link.me/yourname". Reach drops by half compared to the same photo with caption "good morning ♡". <strong>Fix:</strong> never put a URL in the main tweet. Even writing "link in bio" hurts reach a little — let the bio arrow ↓ do it silently.')}

    <h3>7️⃣ Grok AI reads everything (since Jan 2026)</h3>
    <p>Grok is X&apos;s built-in AI. It reads every tweet semantically and pushes positive / fun content while quietly killing negative or political content.</p>
    ${scen('yellow', '🤖 Scenario', '"I hate when men ghost me 🙄" might get high engagement — but Grok reads it as negative emotion and reduces reach for the next 24 hours on the whole account. "boys are so cute when they get nervous 😭" hits the same angle but reads as positive. <strong>Fix:</strong> rewrite anything bitter, angry, or political. Stay playful.')}

    ${alert_('red', '<strong>TWO MORE THINGS THAT MATTER</strong>Hashtags: 1–2 is fine, 3 or more kills reach by 40 %. Most tweets need none.<br><br>ALL CAPS: flagged as shouting / spam. Lowercase is the default look.')}
  `;

  const sec06 = `
    <h3>📅 How Many Posts Per Day</h3>
    ${tbl(['Account Age','Posts','Why'],[
      ['Day 1–3','1','Twitter watches new accounts — one post tests the waters'],
      ['Day 4–10','2','Active without spamming'],
      ['Day 11 +','3','Full operating volume — three is the sweet spot'],
    ])}
    ${alert_('yellow', '<strong>SPACE THEM OUT</strong>Posts should be <strong>3 to 5 hours apart</strong>. Posting twice within an hour gets the second one buried by the algorithm.')}

    <h3>📊 The 90 / 10 Rule</h3>
    <p>Of your 3 daily posts, <strong>most days zero are promotional</strong>. Only occasionally 1 promo tweet on a day when an organic post is hot. Never more than 2 promotional tweets in a single day.</p>

    <h3>🕐 When to Post (US Eastern Time)</h3>
    ${tbl(['Window (EST)','What this slot is for'],[
      ['09:00 – 11:00','Morning crowd, "good morning" energy'],
      ['13:00 – 15:00','Lunch break scrollers — strongest engagement slot'],
      ['20:00 – 22:00','Evening prime time — best for teases'],
    ])}
    <p>Best days: <strong>Tuesday through Thursday</strong>. Saturday late night is the deadest window — avoid.</p>

    <h3>🔄 The Before / After Post Routine</h3>
    <p>This routine wins the first 30 minutes. Do it on every post — especially under 2,000 followers.</p>
    ${step('A', '<strong>2–3 min BEFORE:</strong> Reply to comments on your previous post. Scroll For You, like 3–5 tweets. Warms up the algorithm.')}
    ${step('B', '<strong>POST your tweet.</strong>')}
    ${step('C', '<strong>3–5 min AFTER:</strong> Stay in the app. Scroll For You for 2 min. Image-comment on 2 viral posts. Do 3–5 follower steals. Like 5–10 tweets.')}
    ${alert_('blue', '<strong>WHY THIS WORKS</strong>If you post and disappear, the algorithm reads you as low-quality. If you post and stay engaged for 5 minutes, the algorithm reads you as a real active person and pushes your tweet wider.')}
  `;

  const sec07 = `
    <p>This section is the most important one in the guide. Captions decide whether a tweet lives or dies. The patterns below come from <strong>4,996 tweets from 226 top creators</strong>.</p>

    <h3>📏 Rule 1 — Short Wins (by 3×)</h3>
    ${tbl(['Caption length','Avg likes','Engagement rate'],[
      ['<strong>≤ 25 chars</strong>','<strong>2,336</strong>','<strong>4.5 %</strong>'],
      ['26–60','1,489','3.2 %'],
      ['60 +','777','1.3 %'],
    ])}
    <p>People scroll fast. A short caption is read in half a second. A long one feels like work.</p>

    <h3>❓ Rule 2 — Questions Beat Statements (by 50 %)</h3>
    <p>Question tweets average <strong>2,449</strong> likes vs <strong>1,627</strong> for statements. Questions invite replies — and replies are 150× a like.</p>

    <h3>🎯 Rule 3 — "be honest" Amplifies Engagement</h3>
    <p>Across the dataset, "be honest / tell me" captions average <strong>4,413 likes, 6.7 %</strong> engagement — the top category. "be honest" reads as a challenge and people on Twitter cannot resist a challenge.</p>

    <h3>🔡 Rule 4 — Lowercase Looks Authentic</h3>
    <p>"am i your type" outperforms "Am I Your Type". Lowercase reads as casual friend-talk. Capitalized reads as marketing. ALL CAPS reads as shouting.</p>

    <h3>🏆 Top All-Time Captions From the Dataset</h3>
    ${codeBlock([
      '"am i your type? (be honest)"  →  36,116 likes',
      '"taking bf applications rn"  →  35,019 likes',
      '"smash or pass (be honest) 🤭"  →  avg 13,806 likes',
      '"good morning 🫶"  →  avg 11,736 likes',
      '"eyes up here pretty boy"  →  avg 7,626 likes',
      '"Rate my arch 1-10"  →  6.5 % engagement',
    ], 'Top performers')}

    <h3>🔍 Why These Worked — Real Analysis</h3>
    ${alert_('green', '<strong>"am i your type? (be honest)" → 36,116 likes</strong><strong>Setup:</strong> photo of the creator looking directly into camera.<br><strong>Why it exploded:</strong> "am i your type" is already a question. "(be honest)" is the unlock — it turns a soft compliment-seek into a challenge. Replies flooded in: "100 %", "absolutely", "you are literally my dream girl" — reply storm pushes it to millions.')}
    ${alert_('green', '<strong>"taking bf applications rn" → 35,019 likes</strong><strong>Why it worked:</strong> "applications" is playful framing — turns "I am single" (boring) into a game (engaging). Replies: "putting my application in", "interview when", "where do I apply" — a thread of replies, the most valuable signal.')}
    ${alert_('green', '<strong>"good morning 🫶" → avg 11,736 likes</strong><strong>Why it worked:</strong> universal greeting + waking-up photo triggers a parasocial reaction — followers feel like the creator is greeting <em>them</em>. Easiest reply to write: "good morning beautiful".')}
    ${alert_('green', '<strong>"this is what 180lbs looks like :D" → 21,818 likes</strong><strong>Why it worked:</strong> body positivity + a specific number. "180lbs" makes the tweet feel real and personal, not generic. ":D" softens it — turns a complaint into a flex. Grok pushes positive tone (Section 5.7).')}

    <h3>🔄 Where to Find Fresh Ideas Daily</h3>
    <p>The <strong>Viral Text</strong> tab in this dashboard shows the highest-performing tweets sorted by likes — what is working <em>right now</em>. Patterns shift, so check it twice a week.</p>
    ${alert_('red', '<strong>NEVER COPY WORD-FOR-WORD</strong>Twitter detects duplicate captions across accounts and penalizes everyone involved. Adapt: swap a word, change an emoji, mix two ideas.')}

    <h3>📐 Caption Rules</h3>
    ${doDont(
      'CAPTION DO',
      ['Keep it short (≤ 25 chars wins)', 'End with a question', 'Use "be honest" / "1 word"', 'Lowercase only', '0–2 emojis max'],
      "CAPTION DON'T",
      ['No paragraphs', 'No "link in bio" in caption', 'No prices, no "subscribe"', 'No hashtag lists', 'No exact-same caption twice in a week']
    )}
  `;

  const sec08 = `
    <p>Around 60 tested captions sorted by category. Copy any of them with the button on the right. <strong>Rotate</strong> — never use the same caption twice in one week.</p>

    <div class="gd-cap-cat">
      <h4>🥇 "Be honest" — Strongest tier</h4>
      ${captionItems(['am i your type? (be honest)','smash or pass (be honest)','yes or no to my body type? (be honest)','rate my arch 1-10','rate my waist 1-10','do you like tattooed girls?','do you like redhead girls?','describe me in 1 word','me or your wife?','what would you do?','one word — go','too small or just right?'])}
    </div>

    <div class="gd-cap-cat">
      <h4>🌸 Short &amp; sweet</h4>
      ${captionItems(['hey cutie','hi ♡','good morning 🫶','good night 🌙','bouncy','lord have mercy…','enjoy :)','WHOA','watch again','hey x ♡','lace 🤍'])}
    </div>

    <div class="gd-cap-cat">
      <h4>💕 Boyfriend / girlfriend energy</h4>
      ${captionItems(['taking bf applications rn','taking boyfriend applications ↓','still single btw','i need a hug','i am ur e-girlfriend now, no takebacks','first date — where are we going?','need a winter cuddle buddy'])}
    </div>

    <div class="gd-cap-cat">
      <h4>😅 Personality / humor</h4>
      ${captionItems(['my kink is complete devotion and obsession','this is frying me','where did my car seat go?','giggle maxing','this is what 180lbs looks like :D','imagine hating tummy!?','heard u like abs','pspspsps come here loser'])}
    </div>

    <div class="gd-cap-cat">
      <h4>🖤 Tease / suggestive</h4>
      ${captionItems(['eyes up here pretty boy','i know what you are looking at 🖤','your knees hurt yet?','a little motivation ♡','sound on for this one','just studying 📚','is pink my color?','what kind of day does this remind you of?'])}
    </div>

    <div class="gd-cap-cat">
      <h4>💌 FOMO / DM bait — max 1× per day</h4>
      ${captionItems(['deleting in 6 hours, say "me" for a special dm','say hi for a surprise in dms','reply "yes" for a surprise dm (i am serious)','if you are not a bot, say hi. i will follow back','do not open the comments','i dare you to open the comments'])}
    </div>

    <div class="gd-cap-cat">
      <h4>🎭 Cosplay / character (if persona fits)</h4>
      ${captionItems(['nico robin 🤲','mother makima','who wants this character?','2B from NieR'])}
    </div>

    ${alert_('yellow', '<strong>DM BAIT RULE</strong>If you write "say me for a dm" — you actually have to follow through. Send a "hey ❤" with the bio link. Otherwise people stop engaging and the tactic dies.')}
  `;

  const sec09 = `
    <p>Photos and videos must be <strong>SFW (safe for work)</strong>. Twitter is fine with suggestive — explicit content gets the account restricted within hours.</p>

    <h3>📸 What to Post</h3>
    ${doDont(
      'GREAT CONTENT',
      ['Bikini / lingerie / matching sets', 'Cosplay shoots', 'Lifestyle photos with good lighting', 'Mirror selfies in bright rooms', 'Workout / fitness content', 'GRWM videos (5–15 sec)', 'Behind-the-scenes moments', 'Walking / dancing short videos'],
      'NEVER POST',
      ['Explicit nudity (account restricted)', 'Minors / weapons / drugs / gore', 'Politics / religion / drama', 'Same photo posted within 7 days', 'Photos with other-platform watermarks (TikTok, IG)']
    )}

    <h3>🎥 Video Rules</h3>
    <ul>
      <li>Under <strong>2 minutes 20 seconds</strong> — longer gets less reach</li>
      <li>Best length: <strong>5–15 seconds</strong> — matches the scroll pattern</li>
      <li>Vertical (9:16) and square (1:1) both work — landscape feels old</li>
      <li>Check the first frame looks good — it&apos;s the thumbnail</li>
    </ul>

    <h3>✂️ The Cropping &amp; Editing Tip (Optional but Recommended)</h3>
    <p>Twitter is getting better at detecting duplicate content. Modify each photo slightly before posting — optional safety layer that protects the account.</p>
    ${step(1, '<strong>Crop slightly</strong> — even 5–10 % off the edges changes the file fingerprint.')}
    ${step(2, '<strong>Adjust brightness or contrast</strong> by +5 / −5. Subtle enough to still look natural, different enough that the file is now unique.')}
    ${step(3, '<strong>For videos:</strong> trim 0.5 sec off the start or end, or apply a subtle filter. Same effect.')}

    <h3>🔁 Reposting What Works</h3>
    ${alert_('red', '<strong>THE REPOST RULES</strong>Wait at least <strong>one full week</strong> between posts of the same photo / video<br>Use a <strong>different caption</strong> the second time<br>Apply the cropping / editing trick so the file is technically unique<br>Don&apos;t repost more than twice — the third time triggers duplicate detection')}
  `;

  const sec10 = `
    <p>The pinned tweet is the first thing anyone sees when they click on the profile. Most non-followers decide whether to follow based on the pinned tweet + bio — within five seconds.</p>

    ${alert_('red', '<strong>DO NOT PIN YET</strong>While the account is fresh, leave the pin empty. Pinning a tweet with 4 likes makes the account look dead. A profile with no pin actually looks more curated than one with a weak pin.')}

    <h3>📌 When to Pin Your First Tweet</h3>
    <p>Wait until one of your tweets crosses <strong>100 likes</strong>. That is the threshold where the pin starts working in your favor.</p>
    ${scen('green', '✅ Why 100 likes', 'A pin with 100+ likes signals to a visitor: "other people approve — safe to follow." Anything below 100 makes the account look quiet and the visitor scrolls away.')}

    <h3>🏆 What to Pin</h3>
    <ul>
      <li>Your <strong>single best-performing tweet</strong> by likes</li>
      <li>Photo or video tweets work better than text-only</li>
      <li>Visually striking — strong first impression</li>
      <li>Caption matches the persona (don&apos;t pin something off-brand)</li>
      <li>Bonus: many replies on the tweet shows engagement instantly</li>
    </ul>

    <h3>🔄 When to Replace the Pin</h3>
    <p>Every time a newer tweet beats the pinned one by likes — replace it. Always be pinning your current best.</p>
    ${step(1, 'Check pin candidates once a week')}
    ${step(2, 'On the new tweet: tap the three dots → "Pin to your profile". Old pin gets removed automatically.')}
  `;

  const sec11 = `
    ${alert_('red', '<strong>THE SINGLE MOST IMPORTANT RULE</strong>Read this section twice. The link rule is what makes or breaks the account.')}

    <h3>🚫 The Rule</h3>
    <p>You may <strong>NEVER</strong> put a URL in the main text of a tweet. Twitter throttles tweets with links by 30 to 50 % reach. This has been the case since March 2025.</p>

    <h3>📍 Where the Link Goes</h3>
    <p>Once you have a link, it goes <strong>only in the bio</strong>. Nothing in any tweet — just an arrow ↓ in the bio that points to the website field on the profile.</p>

    <h3>🎯 How to Get Your Link</h3>
    <p>You don&apos;t get a link on day one. You earn it.</p>
    ${step(1, '<strong>Reach 100 followers</strong> through warm-up, posting, and the growth tactics (Sections 12 &amp; 13).')}
    ${step(2, '<strong>DM Justin on X:</strong> "Hey, [account] just hit 100 followers — ready for a link". He creates it within a day.')}
    ${step(3, '<strong>Add the link to the bio</strong> in the website field. Keep the arrow ↓ at the end of the bio text.')}

    ${contact('CONTACT FOR YOUR LINK', '@SunnyAngels_Admin (Justin)', 'DM him on X once the account hits 100 followers. He sets up the link, sends it back, you add it to the bio.')}

    <h3>🤔 Why We Wait Until 100 Followers</h3>
    ${alert_('yellow', '<strong>ACCOUNT REALISM</strong>An account with a link + fewer than 100 followers looks like obvious spam → throttled. An account that grew to 100 through personality first looks like a real person who happens to have a link → treated normally.')}

    <h3>📝 Once You Have the Link</h3>
    ${doDont(
      'LINK DO',
      ['Link in the bio website field only', 'Arrow ↓ at end of bio text points to it', 'Share only when someone explicitly asks in DMs'],
      "LINK DON'T",
      ['No URL in any tweet — ever', 'No "link in bio" in tweet captions', 'No sharing the link in random DMs']
    )}

    ${alert_('red', '<strong>IF YOU POST A LINK BY ACCIDENT</strong>Delete the tweet immediately. Do NOT edit. Editing keeps the algorithm penalty. Deleting and re-posting clean costs you nothing.')}
  `;

  const sec12 = `
    <p>This is the most powerful growth tactic on Twitter. It outperforms posting, following, and almost everything else combined.</p>

    <h3>💡 The Idea</h3>
    <p>Instead of writing a text reply on someone&apos;s viral tweet, you reply with one of your <strong>best photos or videos</strong>. The viral tweet has thousands of eyeballs. Your photo gets seen by a slice — and the ones who like what they see click your profile and follow.</p>

    ${alert_('green', '<strong>WHY IT BEATS EVERYTHING ELSE</strong>You borrow someone else&apos;s audience for free. Image replies are visually loud — they stop the scroll inside the reply thread. The bigger the original tweet, the bigger the borrowed audience.')}

    <h3>📋 How to Run It</h3>
    ${step(1, '<strong>Open Viral Photos / Viral Videos</strong> on this dashboard. Sort by Most Recent. Find fresh tweets gaining momentum.')}
    ${step(2, '<strong>Pick a target:</strong> a tweet with <strong>1,000+ likes</strong>, <strong>less than 20 hours old</strong>, from a creator with <strong>10K–200K followers</strong>. Bigger creators = too much competition. Smaller = not enough audience to borrow.')}
    ${step(3, 'Open the tweet on X and tap reply.')}
    ${step(4, 'Reply with one of your <strong>best photos</strong> + a short relevant caption that connects to the original tweet.')}
    ${step(5, 'After posting, stay in the app. Do not follow up. Do not add a link.')}

    <h3>💬 Caption Examples for Image Replies</h3>
    ${codeBlock([
      'Original: "Do I look cute today?"  →  Your reply: [best photo] + "we could be twins 😭"',
      'Original: "rate my outfit"  →  Your reply: [fit photo] + "trade fits?"',
      'Original: "tell me i am pretty"  →  Your reply: [photo] + "you are gorgeous 🥹 (me though?)"',
      'Original: "anyone else feeling cute today?"  →  Your reply: [photo] + "🙋‍♀️"',
    ], 'Image reply examples')}

    <h3>📐 Rules</h3>
    ${doDont(
      'IMAGE REPLY DO',
      ['Max 10 image replies per day', 'Use a different photo each time', 'Caption stays short, relevant, never promotional', 'Only reply on tweets gaining momentum'],
      "IMAGE REPLY DON'T",
      ['Never write "follow me", "check my profile"', 'Never reuse the same photo', 'Never reply on dead tweets', 'Never tag your own account in their thread']
    )}

    ${alert_('green', '<strong>DAILY TARGET</strong>5–10 image replies during active hours. Done consistently, this brings 20–80 new followers per day in the early weeks.')}
  `;

  const sec13 = `
    <p>"Follower stealing" sounds aggressive — it&apos;s actually polite. You find fans in other creators&apos; viral comment sections and make a friendly connection. Most of them follow back because you noticed them.</p>

    <h3>🔎 Finding Targets</h3>
    ${step(1, '<strong>Open Viral Photos / Viral Text</strong> on the dashboard. Pick a tweet from a creator in our niche with 500+ likes.')}
    ${step(2, '<strong>Scroll the replies on X.</strong> Look for people whose comment has <strong>fewer than 10 likes</strong>. More than 10 = too many creators already chasing them.')}
    ${step(3, '<strong>Filter for good targets:</strong> looks American, English comment, has a profile photo, has own tweets (not just replies), looks 25+. Skip bots, locked accounts, women.')}

    <h3>🤝 The Interaction (~90 % follow-back rate)</h3>
    ${step(1, 'Follow them.')}
    ${step(2, 'Like the comment they left on the viral tweet.')}
    ${step(3, 'Open their profile. Find one of their own tweets (not a reply).')}
    ${step(4, 'Leave a short, genuine reply — "love this!", "great take". Nothing promotional, nothing about you.')}

    <p>That&apos;s it. Most notice the activity (follow + like + reply) and follow back within an hour or two. They feel seen — that&apos;s all the magic is.</p>

    ${alert_('red', '<strong>STAY WITHIN THESE LIMITS</strong>Maximum <strong>5 follower steals per posting session</strong>, 10–15 / day total<br>Never write anything promotional on their profile<br>Only US-based, English-speaking, real-looking accounts<br>Spread across the day — never all at once')}
  `;

  const sec14 = `
    <p>You will get bot comments and bot followers. This is normal. Twitter is full of them.</p>

    <h3>🤖 The Counterintuitive Rule</h3>
    ${alert_('green', '<strong>BOTS IN YOUR COMMENTS ARE GOOD FOR THE ACCOUNT</strong>When a bot comments, it adds to the engagement count. The algorithm sees "this tweet has 30 replies" and pushes it wider — it can&apos;t tell which replies are from real people. The fact that bots showed up means your tweet hit the For You page. That is a good sign.')}

    <h3>✋ What to Do With Bot Comments</h3>
    ${doDont(
      'DO',
      ['Give bot comments a like (boosts engagement)', 'Leave them alone', 'Move on with your routine'],
      "DON'T",
      ['Don&apos;t reply to them', 'Don&apos;t block them', 'Don&apos;t report them']
    )}

    <h3>🔍 How to Spot a Bot</h3>
    <ul>
      <li>Generic praise: "amazing!", "wow!", "❤️❤️❤️" repeated</li>
      <li>Crypto / NFT / "DM for $$$" in their own bio</li>
      <li>Profile created within the last week</li>
      <li>No profile photo or stock photo</li>
      <li>Following thousands, almost no followers themselves</li>
    </ul>

    ${alert_('red', '<strong>IF A BOT DMs YOU</strong>Ignore. Don&apos;t click any links they send. Don&apos;t reply. Their goal is to phish you or scam — neither serves us.')}
  `;

  const sec15 = `
    <p>A shadowban means Twitter is silently hiding your tweets from people who don&apos;t already follow you. The account looks fine to you — but reach drops to zero. Most common cause of an account dying.</p>

    <h3>📊 Daily Limits — Never Exceed These</h3>
    ${tbl(['Action','During Warm-Up','After Warm-Up','Hard Limit'],[
      ['Follows','5–10 / day','20–30 / day','&gt; 50 / day = banned'],
      ['Unfollows','0','10 / day','&gt; 30 / day = banned'],
      ['Likes','10–50 / day','50–100 / day','&gt; 100 / hour = banned'],
      ['Replies','5–15 / day','20–30 / day','&gt; 30 / hour = banned'],
      ['Posts','1–2 / day','3 / day','&gt; 5 / day = banned'],
      ['Image replies','0','5–10 / day','&gt; 15 / day = banned'],
    ])}

    <h3>⚠️ What Triggers a Shadowban</h3>
    ${alert_('red', '<strong>TRIGGER LIST — KNOW THIS BY HEART</strong>Link in the main tweet (especially on new accounts)<br>Mass follow or unfollow in a short window<br>More than 100 likes in an hour<br>The exact same reply text used 5+ times<br>3+ hashtags in a tweet (#OnlyFans / #porn / #nsfw — even one of those is enough)<br>ALL CAPS in tweets<br>3rd-party apps connected to the account<br>Same photo + same caption across multiple accounts<br>Aggressive or political tone (Grok flags it)')}

    <h3>🔬 How to Tell If You Are Shadowbanned</h3>
    ${step(1, '<strong>shadowban.eu</strong> — enter the @handle. Any red flag = banned.')}
    ${step(2, '<strong>Incognito search:</strong> private browser → x.com (don&apos;t sign in) → search for the exact text of a recent tweet. If it doesn&apos;t appear in results, you are invisible to non-followers.')}
    ${step(3, '<strong>Engagement pattern:</strong> likes drop more than 70 % overnight on the same kind of content → strong signal.')}

    <h3>🩹 Recovery</h3>
    ${scen('red', '🛑 Day 1–3: Stop completely', 'No likes, no follows, no posts, no replies. Don&apos;t even open the app on that account.')}
    ${scen('yellow', '💬 Day 4–5: Light replies only', 'Short, genuine replies on other creators&apos; tweets. No links, no photos.')}
    ${scen('blue', '📸 Day 6–7: Resume photos', '1 photo tweet per day, no link, short captions.')}
    ${scen('green', '✅ Day 8 +', 'Back to normal schedule.')}
    ${alert_('red', '<strong>STILL BANNED AFTER 7 DAYS?</strong>Message your supervisor (or @erdo_ka). We may need to retire the account.')}
  `;

  const sec16 = `
    <p>"Viral" is relative to account size. Use the table to know when you have hit it.</p>

    ${tbl(['Followers','Viral threshold (likes)'],[
      ['0 – 500','500 +'],
      ['500 – 1,000','750 +'],
      ['1,000 – 5,000','1,500 +'],
      ['5,000 – 10,000','3,000 +'],
      ['10,000 +','5,000 +'],
    ])}

    <h3>🚀 What to Do When It Hits</h3>
    ${step(1, '<strong>Don&apos;t delete. Don&apos;t edit. Don&apos;t panic.</strong> Leave it alone.')}
    ${step(2, '<strong>Reply to as many comments as you can — at least the first 20.</strong> Every reply you write feeds the algorithm. Even a "🥺" reply counts.')}
    ${step(3, '<strong>Follow-up tweet 1–2 hours later.</strong> Different photo, caption that references the viral one. Captures the new visitors.')}
    ${step(4, '<strong>Check bio + pinned tweet.</strong> A flood of new visitors is going to look at both.')}
    ${step(5, '<strong>Screenshot to your supervisor.</strong> So the team knows the account is performing — we can unlock the link / Premium if it&apos;s time.')}

    ${alert_('yellow', '<strong>DO NOT FORCE A SECOND VIRAL</strong>The instinct after a hit is "post the same thing again". <strong>Wait at least 7 days</strong> before reposting the same photo with a different caption (Section 9). Same-day or next-day repost looks obvious — the second post flops.')}
  `;

  const sec17 = `
    <p>Every account hits a rut at some point. The signs:</p>
    ${codeBlock([
      'Tweet 1 (Monday):    500 likes',
      'Tweet 2 (Tuesday):   400 likes',
      'Tweet 3 (Wednesday):  60 likes',
      'Tweet 4 (Thursday):   20 likes',
      'Tweet 5 (Thursday):    8 likes',
    ], 'Typical slowdown pattern')}
    <p>If you see a drop like this — something changed. Usually an algorithm flag, sometimes an early shadowban.</p>

    <h3>🩹 Recovery Plan</h3>
    ${step(1, '<strong>Check shadowban.eu first.</strong> If banned, follow Section 15 recovery instead.')}
    ${step(2, '<strong>Delete the worst-performing tweet</strong> from the slowdown window. Underperformers drag the whole account&apos;s score down.')}
    ${step(3, '<strong>Cut posting to 2 / day for 3 days.</strong> Less volume, higher quality. Use your best photos.')}
    ${step(4, '<strong>Shift to interaction mode for those 3 days.</strong> Heavy on image replies (Section 12) and follower stealing (Section 13). The algorithm rewards activity from <em>you</em>.')}
    ${step(5, '<strong>Still slow after a week?</strong> Change the avatar and refresh the bio. Sometimes the look is the problem.')}
    ${step(6, '<strong>Still slow after two weeks?</strong> Message your supervisor (or @erdo_ka). We review the account together.')}
  `;

  const sec18 = `
    ${checklist('☀️ Daily Tasks', [
      'Open the dashboard — check Viral Photos / Videos / Text for fresh ideas',
      'Post the planned tweets for today (1 / 2 / 3 depending on account age)',
      'Before / after post routine on every post (5 min before, 5 min after)',
      'At least 5 image replies on viral tweets (Section 12)',
      'At least 5 follower steals on viral comment sections (Section 13)',
      'Reply to all comments on your own tweets',
      'Like 20–50 tweets in the For You feed',
    ], 'd')}

    ${checklist('📅 Weekly Tasks', [
      'Run shadowban.eu — no flags',
      'Review the week: which post performed best and why?',
      'Update the pinned tweet if a new post beat the current pin (100+ likes)',
      'Refresh caption ideas from the Viral Text tab',
      'Send your supervisor a quick update if anything broke or hit big',
    ], 'w')}

    ${checklist('📆 Monthly Tasks', [
      'Look at follower growth — climbing or plateauing?',
      'Re-check avatar and banner — still fresh, or time for a refresh?',
      'Delete tweets older than 30 days with fewer than 5 likes',
      'Audit the bio — still in the right tone?',
    ], 'm')}
  `;

  const sec19 = `
    <p>Once an account crosses <strong>1,000 followers</strong>, we activate X Premium. Until then it is not worth the cost.</p>

    <h3>💎 What Premium Gives the Account</h3>
    <ul>
      <li><strong>10× more reach</strong> per tweet — Twitter explicitly boosts Premium accounts</li>
      <li><strong>Comments appear at the top</strong> of any reply thread — makes Image Comments (Section 12) much stronger</li>
      <li><strong>Blue checkmark</strong> — instant credibility</li>
      <li><strong>Edit button</strong> — fix typos without losing engagement</li>
      <li><strong>4,000 character limit</strong> instead of 280</li>
      <li><strong>TweepCred boost</strong> — hidden trust score</li>
    </ul>

    <h3>⏳ Why We Wait Until 1,000 Followers</h3>
    <p>Premium costs ~$8 / month per account. On a fresh account it&apos;s wasted — the audience isn&apos;t big enough for the boost to compound. At 1,000 followers, the boost starts producing measurable extra growth, and cost-per-new-follower drops sharply.</p>

    <h3>📞 How to Activate</h3>
    <p>You don&apos;t pay — we do. Just message your supervisor once the account hits 1,000.</p>

    ${contact('CONTACT TO ACTIVATE PREMIUM', 'Your supervisor (or @erdo_ka)', 'When your account hits 1,000 followers, message your supervisor: "[account] just hit 1,000 followers — ready for Premium". They handle billing and confirm once it&apos;s active.')}
  `;

  const sec20 = `
    <h3>📞 Who to Contact</h3>
    ${contact('FOR YOUR LINK ONLY — once you hit 100 followers', '@SunnyAngels_Admin (Justin)', 'DM Justin <strong>only</strong> when your account reaches 100 followers and you need the link created. He does not handle anything else.')}
    ${contact('EVERYTHING ELSE', 'Your supervisor · or @erdo_ka', 'For shadowban / suspension issues, viral post moments, weird account behaviour, account banned, or anything you are unsure about — message your supervisor first. If they are unavailable, DM <strong>@erdo_ka</strong> on X.')}
    ${alert_('yellow', '<strong>GENERAL RULE</strong>If you are ever in doubt — ask your <strong>supervisor</strong> first. Only contact Justin (@SunnyAngels_Admin) for the link request at 100 followers. Premium activation, account problems, anything weird — supervisor or @erdo_ka.')}

    <h3>❓ FAQ</h3>

    ${faq('My account has 70 followers — can I get the link early?', 'No. The 100-follower line exists because Twitter throttles new accounts that have a link before they look real. Stay patient — the last 30 followers go faster than the first 30.')}
    ${faq('Can I post the same photo on two of our accounts?', 'Not with the same caption. Twitter detects duplicate photo + caption combinations across accounts and penalizes both. Use the same photo with different captions, or modify the photo slightly (Section 9).')}
    ${faq('My likes dropped overnight — what do I do?', 'Step 1: check shadowban.eu. Step 2: if shadowbanned → Section 15 recovery. Step 3: if not shadowbanned → Section 17 (Account Slowdown) recovery.')}
    ${faq('How many accounts can I run at once?', 'Five is the practical max. Past that, you cannot run image replies properly for each one and they all start to suffer.')}
    ${faq('A creator I look up to broke half these rules — why?', 'Large accounts (100K+) have organic momentum and can break some rules safely. Small accounts cannot. Stick to the playbook until 5,000 followers — then we revisit.')}
    ${faq('Can I use any auto-scheduler or bot app?', 'No. Twitter detects 3rd-party automation and penalizes accounts. All posts go out manually from the X app.')}
    ${faq('What if Twitter prompts me to verify with a phone or selfie?', 'Stop and message your supervisor immediately. Do not answer the prompt yourself.')}
    ${faq('What if a follower DMs explicit questions?', 'If polite → reply softly and casually. If aggressive or weird → ignore. Never send explicit content yourself, regardless of what they offer.')}
    ${faq('Can I do giveaways or contests?', 'Not without checking with your supervisor first. Twitter has rules around giveaways that can suspend the account if you do it wrong.')}
    ${faq('How do I tell which posting time is best for my account?', 'Try all three windows (morning, lunch, evening) over a week. The one with highest average engagement is the sweet spot. Stick to it, but check again monthly — audience habits drift.')}
  `;

  // ── Chapters ─────────────────────────────────────────────────────────
  const chapters = [
    { id: 'start', icon: '🚀', title: 'Start Here', sub: 'Rules, profile, new accounts',
      sections: [
        { num: 1, id: 'welcome', title: 'Welcome — The Big Picture', body: sec01 },
        { num: 2, id: 'create',  title: 'Creating the Account',      body: sec02 },
        { num: 3, id: 'profile', title: 'Profile Setup',             body: sec03 },
        { num: 4, id: 'warmup',  title: 'Account Warm-Up (Day 1–21)', body: sec04 },
      ]},
    { id: 'daily', icon: '📅', title: 'Daily Work', sub: 'Posting, captions, content',
      sections: [
        { num: 5, id: 'algorithm', title: "How Twitter's Algorithm Works",  body: sec05 },
        { num: 6, id: 'schedule',  title: 'Daily Posting Schedule',         body: sec06 },
        { num: 7, id: 'captions',  title: 'Captions: What Works & Why',     body: sec07 },
        { num: 8, id: 'bank',      title: 'Caption Bank (60+ captions)',    body: sec08 },
        { num: 9, id: 'content',   title: 'Content Rules (Photos & Videos)', body: sec09 },
        { num: 10, id: 'pinned',   title: 'Pinned Tweet — Wait for 100 Likes', body: sec10 },
      ]},
    { id: 'tools', icon: '🛠️', title: 'Tools & Engagement', sub: 'Link rule, growth tactics',
      sections: [
        { num: 11, id: 'link',     title: 'The Link Rule (CRITICAL)',     body: sec11 },
        { num: 12, id: 'imgrep',   title: 'Image Comments (Strongest Growth)', body: sec12 },
        { num: 13, id: 'steal',    title: 'Follower Stealing',            body: sec13 },
        { num: 14, id: 'bots',     title: 'Bots in Your Comments',        body: sec14 },
      ]},
    { id: 'safe', icon: '🛡️', title: 'Keep Account Safe', sub: 'Shadowbans, viral hits',
      sections: [
        { num: 15, id: 'shadow',   title: 'Avoiding Shadowbans',          body: sec15 },
        { num: 16, id: 'viral',    title: 'When a Post Goes Viral',       body: sec16 },
        { num: 17, id: 'slowdown', title: 'When Your Account Slows Down', body: sec17 },
      ]},
    { id: 'ref', icon: '📚', title: 'Reference', sub: 'Checklist, Premium, FAQ',
      sections: [
        { num: 18, id: 'chk',      title: 'Daily / Weekly Checklist',     body: sec18 },
        { num: 19, id: 'premium',  title: 'At 1,000 Followers: X Premium', body: sec19 },
        { num: 20, id: 'faq',      title: 'FAQ + How to Reach Us',        body: sec20 },
      ]},
  ];

  // ── Build HTML ───────────────────────────────────────────────────────
  const pillsHtml = chapters.map((c, i) => `
    <a class="gd-chtab${i === 0 ? ' active' : ''}" data-chapter="ch-${c.id}" href="#ch-${c.id}" onclick="event.preventDefault();(function(){var el=document.getElementById('ch-${c.id}');if(!el)return;el.querySelectorAll('.gd-sec').forEach(function(s){s.classList.remove('collapsed');});el.scrollIntoView({behavior:'smooth',block:'start'});document.querySelectorAll('.gd-chtab').forEach(function(t){t.classList.remove('active');});event.currentTarget.classList.add('active');})()">
      <span class="gd-chtab-icon">${c.icon}</span>
      <span class="gd-chtab-txt">
        <span class="gd-chtab-title">${escHtml(c.title)}</span>
        <span class="gd-chtab-sub">${escHtml(c.sub)}</span>
      </span>
    </a>
  `).join('');

  const chaptersHtml = chapters.map(c => {
    const secsHtml = c.sections.map(s => section(s.num, s.id, s.title, s.body)).join('');
    return `<div class="gd-chapter" id="ch-${c.id}">
      <div class="gd-chapter-head">
        <div class="gd-chapter-icon">${c.icon}</div>
        <div>
          <div class="gd-chapter-eyebrow">Chapter</div>
          <h2 class="gd-chapter-title">${escHtml(c.title)}</h2>
          <div class="gd-chapter-subtitle">${escHtml(c.sub)}</div>
        </div>
      </div>
      ${secsHtml}
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="gd-wrap">
      <div class="gd-hero">
        <h1>Sunny Angels — Twitter / X Playbook</h1>
        <p>Welcome to the Sunny Angels Twitter playbook. This guide shows you how to run a creator account on X — what to post, when to post it, what to avoid, and how to grow it from zero. Everything here comes from analyzing what actually works.</p>
      </div>

      <div class="gd-info">
        <div class="gd-info-eyebrow"><span class="gd-emoji">🚩</span>THIS GUIDE WAS BUILT FROM REAL DATA</div>
        <p>We analyzed <strong>4,996 tweets from 226 top creators</strong> in our niche, ran them through the open-source X algorithm rules, and turned every pattern into something you can follow.</p>
        <p class="gd-hl">Your consistency matters.</p>
        <p>This is a playbook, not a magic formula. The accounts that follow this guide every day grow. The ones that don&apos;t — don&apos;t. Read the whole thing before you post anything.</p>
      </div>

      <div class="gd-info" style="background: linear-gradient(135deg, rgba(245,158,11,.12), rgba(245,158,11,.04)); border-color: rgba(245,158,11,.30);">
        <div class="gd-info-eyebrow" style="color: #fbbf24;"><span class="gd-emoji">⚠️</span>IMPORTANT — Read Before You Work</div>
        <p>If you&apos;re unsure about <strong>anything</strong> — ask your <strong>supervisor</strong> before doing it (or DM <strong>@erdo_ka</strong>). Justin (<strong>@SunnyAngels_Admin</strong>) is only for the link request once you reach 100 followers — everything else goes through your supervisor. The dashboard tabs (Viral Photos / Videos / Text / Bios / Strategy) are your daily tools — open them every shift.</p>
      </div>

      <div class="gd-chnav">${pillsHtml}</div>

      <div class="gd-ctrl">
        <button class="gd-btn" onclick="document.querySelectorAll('.gd-sec').forEach(s=>s.classList.remove('collapsed'))">Expand all</button>
        <button class="gd-btn" onclick="document.querySelectorAll('.gd-sec').forEach(s=>s.classList.add('collapsed'))">Collapse all</button>
        <button class="gd-btn" onclick="if(confirm('Reset all progress?')){Object.keys(localStorage).filter(k=>k.startsWith('gsec_done_')||k.startsWith('gcl_')).forEach(k=>localStorage.removeItem(k));location.reload();}">Reset progress</button>
      </div>

      <input class="gd-search" type="text" placeholder="🔍 Search the guide..." id="guide-search-input" oninput="guideSearch(this.value)">

      <div id="guide-sections">${chaptersHtml}</div>
      <p id="guide-no-results" style="display:none;color:#7e7e9a;text-align:center;padding:32px 0;font-size:14px;">No sections match your search.</p>

      <div class="gd-footer">
        Sunny Angels — Twitter / X Playbook · Internal · Based on 4,996 tweets from 226 top creators + 2026 X algorithm research
      </div>
    </div>
  `;

  el.dataset.rendered = '1';
}

// ─── GUIDE SEARCH ────────────────────────────────────────────────────
function guideSearch(query) {
  const q = query.trim().toLowerCase();
  const sections = document.querySelectorAll('#guide-sections .gd-sec');
  let anyVisible = false;
  sections.forEach(s => {
    if (!q) { s.classList.remove('hidden'); anyVisible = true; return; }
    const title = (s.dataset.title || '').toLowerCase();
    const body  = (s.querySelector('.gd-sec-body') || {}).textContent || '';
    const match = title.includes(q) || body.toLowerCase().includes(q);
    s.classList.toggle('hidden', !match);
    if (match) { anyVisible = true; s.classList.remove('collapsed'); }
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
