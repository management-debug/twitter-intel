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

  // Stop any guide video that was playing — workers were closing the tab
  // and music kept going in the background.
  if (state.activeTab === 'guide' && tab !== 'guide') {
    try { pauseAllGuideVideos(); } catch (_) {}
  }

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
  if (!confirm(`Delete @${username}?\n\nAll their posts will be removed and the username gets added to the blocklist — bulk-add will skip it from now on.`)) return;
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
    // Filter change: invalidate any in-flight fetch + stop the old
    // IntersectionObserver. Without this, a fast period-switch caused the
    // observer from the previous filter to fire on the new sentinel and
    // append duplicate posts on top of the freshly cleared grid (3x rows
    // of the same 4 yesterday-photos was this bug).
    state[`${tab}_done`] = true;
    if (_scrollObservers[tab]) { _scrollObservers[tab].disconnect(); _scrollObservers[tab] = null; }
    state.pages[tab] = 1;
    page = 1;
    grid.innerHTML = '';
  }
  // Bump a per-tab request id; only the latest issuer is allowed to render.
  state._viralReqId = state._viralReqId || {};
  state._viralReqId[tab] = (state._viralReqId[tab] || 0) + 1;
  const reqId = state._viralReqId[tab];

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

    // Stale-fetch guard: if a newer filter change happened while we were
    // awaiting, ignore this result so we don't paint over the new state.
    if (state._viralReqId && state._viralReqId[tab] !== reqId) return;

    const posts = Array.isArray(data) ? data : (data.posts || data.items || []);
    const total = data.total ?? posts.length;

    if (page === 1 && !posts.length) {
      grid.innerHTML = `<div class="no-results"><div class="no-results-icon">🔍</div><h3>No viral ${tab} found</h3><p>Try adjusting your filters</p></div>`;
      countEl.textContent = '0 results';
      loadBtn.disabled = false;
      loadBtn.textContent = 'Load More';
      return;
    }

    // De-dupe against cards already rendered. OFFSET pagination can return the
    // same post on two consecutive pages when the underlying data shifts
    // between fetches (e.g. the nightly scrape updates like counts), which
    // would otherwise append a duplicate card during infinite scroll.
    const seen = new Set(Array.from(grid.querySelectorAll('[data-id]'), el => el.dataset.id));
    const newPosts = posts.filter(p => !seen.has(String(p.id)));

    if (tab === 'text') {
      const frag = document.createDocumentFragment();
      newPosts.forEach(p => {
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
      newPosts.forEach(p => {
        const el = document.createElement('div');
        el.innerHTML = buildPostCard(p);
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

  const hasCaption = !!(post.caption || '').trim();
  return `<div class="post-card" data-id="${post.id}">
    ${mediaHtml}
    <div class="post-card-body">
      <div class="post-card-top">
        <span class="post-card-author"><span>@${escHtml(post.username || '—')}</span></span>
        <div class="post-card-stats">
          <span class="post-stat">${heartSvg()} ${fmtNum(post.likes)}</span>
          ${post.views  ? `<span class="post-stat">${eyeSvg()} ${fmtNum(post.views)}</span>` : ''}
          ${post.bookmarks ? `<span class="post-stat">${bookmarkSvg()} ${fmtNum(post.bookmarks)}</span>` : ''}
          ${post.retweets ? `<span class="post-stat">${retweetSvg()} ${fmtNum(post.retweets)}</span>` : ''}
        </div>
      </div>
      ${hasCaption ? `<div class="post-card-caption-box">
        <div class="post-card-caption">${escHtml(captionPreview)}</div>
        <button class="card-copy-btn copy-btn" title="Copy full caption">${copyIconSvg()}<span>Copy caption</span></button>
      </div>` : ''}
    </div>
  </div>`;
}

function copyIconSvg() {
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
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
// Format + caption-length numbers are pulled live from the DB via
// /api/strategy and stored back into strategyData when the tab loads.
// Algorithm weights are the real values from Twitter's open-source
// algorithm repo — these don't change so they're constants. The best-
// times heat map is generic US-prime-time guidance.
let strategyData = {
  formats: [],          // populated from /api/strategy
  captionLengths: [],   // populated from /api/strategy
  engagement: null,     // populated from /api/strategy
  totalViral: 0,        // populated from /api/strategy
  algoWeights: [
    { signal: 'Reply + author replies back', weight: 150, notes: 'The single strongest signal — start conversations' },
    { signal: 'Reply',                        weight: 27,  notes: 'Comments drive reach far more than likes' },
    { signal: 'Profile click + engagement',   weight: 24,  notes: 'Visitor stuck around — quality signal' },
    { signal: 'Dwell time (2+ min)',          weight: 20,  notes: 'How long viewers stayed on the tweet' },
    { signal: 'Bookmark',                     weight: 20,  notes: 'Save-for-later — most creators ignore this' },
    { signal: 'Retweet',                      weight: 2,   notes: 'Classic virality signal' },
    { signal: 'Like',                         weight: 1,   notes: 'Baseline — every other signal compared to this' },
  ],
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

async function renderStrategy() {
  // Pull live aggregates from the DB. Algorithm weights + heat map are
  // baked into strategyData; format/caption-length come from /api/strategy.
  try {
    const data = await apiGet('/api/strategy', 'strategy_stats');
    if (data) {
      strategyData.formats        = data.formats || [];
      strategyData.captionLengths = data.caption_lengths || [];
      strategyData.engagement     = data.engagement || null;
      strategyData.totalViral     = data.total_viral || 0;
    }
  } catch (_) { /* render whatever we have */ }

  renderBarChart('format-chart',  strategyData.formats,        'Avg engagement');
  renderBarChart('caption-chart', strategyData.captionLengths, 'Avg likes');
  renderAlgoTable();
  renderTimeGrid();
}

function renderBarChart(containerId, items, unit = '') {
  const container = $(`#${containerId}`);
  if (!container) return;
  if (!items || !items.length) {
    container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:16px 0;">Loading…</div>';
    return;
  }
  const max = Math.max(...items.map(i => i.value || 0)) || 1;
  container.innerHTML = items.map(item => `
    <div class="bar-row">
      <div class="bar-label">${escHtml(item.label)}</div>
      <div class="bar-track">
        <div class="bar-fill" style="width:${((item.value || 0) / max * 100).toFixed(1)}%;background:${item.color};"></div>
      </div>
      <div class="bar-value">${(item.value || 0).toLocaleString()}${item.count ? ` <span style="color:var(--text3);font-weight:400;font-size:11px;">(${item.count.toLocaleString()})</span>` : ''}</div>
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
  const suf = ph24 < 12 ? 'am' : 'pm';
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

  // ── CSS ─────────────────────────────────────────────────────────────
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

      .gd-hero { text-align: center; padding: 16px 0 26px; }
      .gd-hero h1 {
        font-size: 36px; font-weight: 800; line-height: 1.15; margin: 0 0 14px; letter-spacing: -0.5px;
        background: linear-gradient(135deg, #ff6b8a 0%, #635bff 45%, #22d3ee 100%);
        -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
      }
      .gd-hero p { color: var(--gtext2); font-size: 14px; line-height: 1.65; max-width: 620px; margin: 0 auto; }

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

      .gd-chnav {
        display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px;
        padding: 14px 0; margin: 24px 0 8px;
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

      .gd-ctrl { display: flex; gap: 8px; margin: 6px 0 18px; flex-wrap: wrap; }
      .gd-btn { background: var(--gsurface); border: 1px solid var(--gborder); color: var(--gtext2); padding: 7px 13px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all .15s; }
      .gd-btn:hover { border-color: var(--gaccent); color: var(--gtext); }

      .gd-search { width: 100%; padding: 12px 16px; border-radius: 10px; background: var(--gsurface); border: 1px solid var(--gborder); color: var(--gtext); font-size: 16px; outline: none; box-sizing: border-box; font-family: inherit; margin: 8px 0 14px; }
      .gd-search:focus { border-color: var(--gaccent); }
      .gd-search::placeholder { color: var(--gtext3); }

      .gd-chapter { margin-bottom: 40px; scroll-margin-top: 20px; }
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

      .gd-sec { background: transparent; border: none; padding: 0; margin-bottom: 12px; scroll-margin-top: 20px; }
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

      .gd-sec-body h3 { font-size: 17px; font-weight: 700; margin: 22px 0 14px; color: var(--gaccent2); display: flex; align-items: center; gap: 10px; }
      .gd-sec-body h4 { margin: 16px 0 8px; font-size: 15px; color: #fff; }
      .gd-sec-body p { color: #bbb; line-height: 1.7; margin: 0 0 14px; font-size: 14.5px; }
      .gd-sec-body p strong, .gd-sec-body li strong { color: #fff; }
      .gd-sec-body ul, .gd-sec-body ol { margin: 14px 0; padding-left: 24px; }
      .gd-sec-body li { color: #bbb; line-height: 1.65; margin-bottom: 8px; font-size: 14.5px; }
      .gd-sec-body em { color: #eaeaf2; background: rgba(99,91,255,.10); padding: 2px 6px; border-radius: 5px; font-style: normal; font-size: 13.5px; }
      .gd-sec-body code { background: rgba(99,91,255,.12); color: #fff; padding: 2px 7px; border-radius: 5px; font-family: 'SF Mono','Monaco','Consolas',monospace; font-size: 12.5px; border: 1px solid rgba(99,91,255,.22); }
      .gd-sec-body a { color: var(--gaccent2); }

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

      .gd-step { display: flex; gap: 15px; margin: 12px 0; padding: 16px 18px; background: rgba(26,26,34,.8); border-radius: 12px; align-items: flex-start; }
      .gd-step-num {
        background: linear-gradient(135deg, var(--gaccent) 0%, var(--gaccent2) 100%);
        color: white; min-width: 30px; height: 30px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-weight: 700; font-size: 13px; flex-shrink: 0;
      }
      .gd-step-body { flex: 1; color: #bbb; line-height: 1.65; font-size: 14px; }
      .gd-step-body strong { color: #fff; }
      .gd-step-body .gd-fallback { display: block; margin-top: 6px; font-size: 12.5px; color: var(--gtext3); }
      .gd-step-body .gd-fallback strong { color: #c4c4d6; }

      .gd-dodont { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 24px 0; }
      .gd-do, .gd-dont { padding: 22px; border-radius: 14px; }
      .gd-do { background: rgba(34,197,94,.08); border: 1px solid rgba(34,197,94,.30); }
      .gd-do h4 { color: #4ade80; margin-bottom: 14px; font-size: 16px; }
      .gd-dont { background: rgba(99,91,255,.08); border: 1px solid rgba(99,91,255,.30); }
      .gd-dont h4 { color: #ff6b8a; margin-bottom: 14px; font-size: 16px; }
      .gd-do ul, .gd-dont ul { padding-left: 20px; margin: 0; }
      .gd-do li, .gd-dont li { color: #ccc; margin-bottom: 10px; line-height: 1.55; font-size: 14px; }

      .gd-checklist { background: rgba(26,26,34,.8); border-radius: 14px; padding: 20px 24px; margin: 20px 0; }
      .gd-checklist h4 { color: var(--gaccent2); font-weight: 700; margin-bottom: 12px; display: flex; align-items: center; gap: 10px; font-size: 15px; }
      .gd-ci { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.06); color: #ccc; align-items: center; line-height: 1.5; font-size: 14px; }
      .gd-ci:last-child { border-bottom: none; }
      .gd-ci input { width: 18px; height: 18px; accent-color: var(--gaccent); cursor: pointer; flex-shrink: 0; }
      .gd-ci.done label { color: #6a6a85; text-decoration: line-through; }
      .gd-ci label { flex: 1; cursor: pointer; }

      .gd-tbl-wrap { overflow-x: auto; margin: 16px 0; border-radius: 12px; border: 1px solid var(--gborder); }
      .gd-tbl { width: 100%; border-collapse: collapse; font-size: 13.5px; min-width: 380px; }
      .gd-tbl thead { background: linear-gradient(90deg, rgba(99,91,255,.10), rgba(34,211,238,.06)); }
      .gd-tbl th { text-align: left; padding: 12px 14px; color: var(--gaccent2); font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      .gd-tbl td { padding: 11px 14px; color: #c4c4d6; border-top: 1px solid var(--gborder); }
      .gd-tbl td strong { color: #fff; }
      .gd-tbl tr:hover td { background: rgba(99,91,255,.04); }

      .gd-code { background: rgba(10,10,16,.6); border: 1px solid var(--gborder); border-radius: 12px; overflow: hidden; margin: 16px 0; }
      .gd-code-hdr { display: flex; justify-content: space-between; align-items: center; padding: 9px 14px; background: rgba(0,0,0,.3); border-bottom: 1px solid var(--gborder); }
      .gd-code-hdr-label { font-size: 11px; color: var(--gtext2); text-transform: uppercase; letter-spacing: .08em; font-weight: 700; }
      .gd-code-copy { background: transparent; border: 1px solid var(--gborder); color: var(--gtext2); padding: 4px 12px; border-radius: 6px; font-size: 11px; cursor: pointer; transition: all .15s; font-family: inherit; }
      .gd-code-copy:hover { border-color: var(--gaccent); color: var(--gtext); }
      .gd-code-line { display: flex; justify-content: space-between; align-items: center; padding: 9px 14px; border-top: 1px solid rgba(255,255,255,.04); gap: 10px; }
      .gd-code-line:first-of-type { border-top: none; }
      .gd-code-line span { font-family: 'SF Mono','Monaco','Consolas',monospace; font-size: 13px; color: #c4c4d6; flex: 1; word-break: break-word; }

      .gd-scen { display: flex; gap: 14px; align-items: flex-start; background: rgba(26,26,34,.7); border: 1px solid var(--gborder); border-radius: 12px; padding: 14px 18px; margin: 10px 0; }
      .gd-scen-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; margin-top: 5px; }
      .gd-scen-body { flex: 1; font-size: 14px; color: #bbb; line-height: 1.6; }
      .gd-scen-body strong { display: block; color: #fff; font-size: 14.5px; margin-bottom: 3px; }
      .gd-scen.green .gd-scen-dot { background: #4ade80; box-shadow: 0 0 14px rgba(74,222,128,.5); }
      .gd-scen.yellow .gd-scen-dot { background: #fbbf24; box-shadow: 0 0 14px rgba(251,191,36,.5); }
      .gd-scen.blue .gd-scen-dot { background: #22d3ee; box-shadow: 0 0 14px rgba(34,211,238,.5); }
      .gd-scen.red .gd-scen-dot { background: #ff6b8a; box-shadow: 0 0 14px rgba(255,107,138,.5); }

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

      /* Video walkthroughs */
      .gd-video { margin: 14px 0; border-radius: 14px; overflow: hidden; background: #000; border: 1px solid var(--gborder); box-shadow: 0 8px 28px rgba(0,0,0,.4); }
      .gd-video video { width: 100%; display: block; max-height: 70vh; background: #000; }
      .gd-imggrid { display: flex; flex-direction: column; gap: 14px; margin: 14px 0; }
      .gd-imggrid a { display: block; border-radius: 14px; overflow: hidden; border: 1px solid var(--gborder); background: #0a0a0f; transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
      .gd-imggrid a:hover { transform: translateY(-2px); border-color: var(--gaccent); box-shadow: 0 10px 24px rgba(0,0,0,.4); }
      .gd-imggrid img { width: 100%; height: auto; display: block; object-fit: contain; background: #fff; }

      .gd-faq { background: rgba(26,26,34,.7); border: 1px solid var(--gborder); border-radius: 12px; margin: 8px 0; overflow: hidden; }
      .gd-faq-q { padding: 16px 20px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 14.5px; color: var(--gtext); user-select: none; transition: background .15s; gap: 14px; }
      .gd-faq-q:hover { background: rgba(99,91,255,.05); }
      .gd-faq-q svg { width: 18px; height: 18px; color: var(--gtext3); transition: transform .25s; flex-shrink: 0; }
      .gd-faq.open .gd-faq-q svg { transform: rotate(180deg); color: var(--gaccent2); }
      .gd-faq-a { max-height: 0; overflow: hidden; transition: max-height .3s ease; }
      .gd-faq-a-inner { padding: 0 20px 18px; font-size: 14px; color: #b5b5c8; line-height: 1.7; }

      .gd-footer { text-align: center; padding: 40px 0 20px; color: var(--gtext3); font-size: 12px; margin-top: 40px; }

      .gd-sec.hidden { display: none; }

      .gd-btn, .gd-sec-head, .gd-sec-check, .gd-chtab, .gd-faq-q, .gd-code-copy {
        -webkit-tap-highlight-color: transparent;
        touch-action: manipulation;
      }

      @media (max-width: 720px) {
        .gd-wrap { padding: 18px 14px 60px; }
        .gd-hero h1 { font-size: 26px; }
        .gd-hero p { font-size: 13.5px; }
        .gd-chnav { grid-template-columns: repeat(2, 1fr); padding: 10px 0; gap: 7px; }
        .gd-chtab { padding: 11px 12px; min-height: 52px; }
        .gd-chtab-icon { font-size: 18px; }
        .gd-chtab-title { font-size: 12.5px; }
        .gd-chtab-sub { font-size: 10.5px; }
        .gd-chapter-head { padding: 18px 20px; gap: 14px; border-radius: 14px; }
        .gd-chapter-icon { font-size: 32px; }
        .gd-chapter-title { font-size: 19px; }
        .gd-chapter-subtitle { font-size: 12px; }
        .gd-sec-head { padding: 14px 14px; gap: 10px; min-height: 56px; }
        .gd-sec-num { width: 40px; height: 40px; font-size: 16px; border-radius: 12px; }
        .gd-sec-title { font-size: 15px; }
        .gd-sec-check { width: 32px; height: 32px; }
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
        .gd-ci { min-height: 44px; }
        .gd-btn { min-height: 40px; padding: 9px 14px; font-size: 13px; }
        .gd-faq-q { min-height: 56px; padding: 16px 18px; }
        .gd-code-copy { padding: 8px 14px; font-size: 12px; }
      }

      @media (hover: none) and (pointer: coarse) {
        html { scroll-behavior: auto; }
      }

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
  function step(num, body, fallback) {
    const fb = fallback ? `<span class="gd-fallback"><strong>Can&apos;t find it?</strong> ${fallback}</span>` : '';
    return `<div class="gd-step"><div class="gd-step-num">${num}</div><div class="gd-step-body">${body}${fb}</div></div>`;
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

  // Video player — uses native <video controls>, lazy-loaded via preload=metadata
  const VID_BASE = 'https://ttdsvkpqobfutsahblos.supabase.co/storage/v1/object/public/guide-assets/videos/';
  const POSTER_BASE = 'https://ttdsvkpqobfutsahblos.supabase.co/storage/v1/object/public/guide-assets/posters/';
  const IMG_BASE = 'https://ttdsvkpqobfutsahblos.supabase.co/storage/v1/object/public/guide-assets/images/';
  function video(filename) {
    const poster = POSTER_BASE + filename.replace(/\.mp4$/, '.jpg');
    return `<div class="gd-video">
      <video controls preload="none" playsinline src="${VID_BASE}${filename}" poster="${poster}"></video>
    </div>`;
  }
  function imgGrid(filenames) {
    return `<div class="gd-imggrid">${filenames.map(f =>
      `<a href="${IMG_BASE}${f}" target="_blank" rel="noopener"><img loading="lazy" src="${IMG_BASE}${f}" alt="example"></a>`
    ).join('')}</div>`;
  }

  // ══════════════════════════════════════════════════════════════════
  // SECTION CONTENT
  // ══════════════════════════════════════════════════════════════════

  const sec01 = `
    <p>You already know Threads — Twitter / X works on the same principles with a few important twists. This guide is the short list of what to do, what not to do, and how to handle the situations you will run into.</p>

    <h3>🎯 The Three Levers</h3>
    ${step('1', '<strong>Replies are king.</strong> A reply chain is 150× more valuable than a like. Always end captions with a question. "(be honest)" doubles reply chances.')}
    ${step('2', '<strong>The first 30 minutes decide everything.</strong> A tweet that gets traction fast gets pushed wider. One that does not — dies. Stay engaged for 5 minutes after posting.')}
    ${step('3', '<strong>Consistency beats bursts.</strong> Steady daily activity grows the account. Ten posts one day then nothing for three days gets you flagged.')}

    <h3>💰 How Promo Works (Important — Read This)</h3>
    <p><strong>You never post promotional tweets.</strong> No "subscribe to my bio", no "check the link", no "DM me for ___". The promo lives in the bio link only. Anyone who likes your tweets clicks your profile, sees the link, and decides on their own.</p>
    <p>That means every tweet you write is 100% personality content. The bio does the selling silently. This is the difference between an account that grows and one Twitter throttles.</p>

    <h3>🛠️ How to Use This Dashboard Daily</h3>
    <ul>
      <li><strong>Viral Photos / Videos / Text</strong> tabs — what is winning right now. Open them at the start of every shift.</li>
      <li><strong>Bios</strong> tab — bio inspiration. Do not copy. Study patterns, then write your own.</li>
      <li><strong>Strategy</strong> tab — posting times shown in both US Eastern and your Manila local time.</li>
    </ul>

    ${alert_('red', '<strong>THE ONE RULE TO REMEMBER</strong>Never put a link in any tweet. Ever. The link lives only in the bio. The chapter on the link rule explains why and what to do.')}
  `;

  const secHygiene = `
    ${alert_('red', '<strong>Do this BEFORE you touch the X app.</strong> Skipping any of these steps lets the X app pick up your phone&apos;s cached location (Philippines, Nigeria, etc.) at signup — that kills reach and gets the account suspended within days. Non-optional, applies to <em>every</em> fresh social-media account you create.')}

    <h3>📱 1. App Reset (every app, every time)</h3>
    <p>Run these steps for the X app — and for any other social app you&apos;re creating a fresh account on. This clears all cached metadata so the app reads your proxy location fresh on signup.</p>
    ${step('1', 'iPhone <strong>Settings</strong> → <strong>General</strong>.')}
    ${step('2', 'Tap <strong>iPhone Storage</strong>.')}
    ${step('3', 'Tap the app you&apos;re about to reset (X, TikTok, Threads, Instagram — whichever you&apos;re creating fresh).')}
    ${step('4', 'Tap <strong>Offload App</strong>.')}
    ${step('5', 'Then tap <strong>Delete App</strong>.')}
    ${step('6', 'Open the <strong>App Store</strong> → tap your profile icon (top right).')}
    ${step('7', 'Scroll down to <strong>Personalized Recommendations</strong> → tap <strong>Clear App Usage Data</strong> and confirm.')}
    ${step('8', '<strong>Restart the phone.</strong> Critical — do not skip.')}
    ${step('9', 'After restart, open <strong>Shadowrocket</strong> and connect to your US proxy.')}
    ${step('10', 'Open Safari → go to <strong>whatismyipaddress.com</strong> and verify the country shows <strong>United States</strong>. If it doesn&apos;t, fix the proxy first — do not continue.')}
    ${step('11', 'Redownload the app from the App Store. Now you&apos;re safe to create the account.')}

    ${alert_('yellow', '<strong>Shadowrocket settings unclear?</strong> Full step-by-step guide with screenshots: <a href="https://shadowrocket-guide.netlify.app/" target="_blank" rel="noopener">shadowrocket-guide.netlify.app</a>. For new proxy credentials, message your supervisor.')}

    <h3>🌐 2. Verify US IP — Every Time You Open the App</h3>
    <p>Even after the reset, check the IP at the start of every working session. <strong>whatismyipaddress.com</strong> must show <strong>United States</strong> before you open X, TikTok, Threads or Instagram. One open with the wrong IP can flag the account permanently.</p>

    <h3>⬆️ 3. Keep iOS + Every App on the Latest Version</h3>
    <p>Old app versions are the fastest invisible killer of an account. Platforms use version mismatches to flag traffic as bot / automation. The account&apos;s reach drops to zero, comments get hidden, and you only notice when it&apos;s already dead.</p>
    ${step('1', '<strong>Every Monday morning:</strong> iPhone <strong>Settings</strong> → <strong>General</strong> → <strong>Software Update</strong> → install any iOS update available.')}
    ${step('2', 'Open the <strong>App Store</strong> → tap your profile icon → scroll down → update every app on the list.')}
    ${step('3', 'Pay extra attention to: <strong>X, TikTok, Threads, Instagram, Shadowrocket</strong>. These must always be on the newest version before you log in or post.')}
    ${step('4', 'Recommended: enable auto-updates. iPhone <strong>Settings</strong> → <strong>App Store</strong> → turn ON <strong>App Updates</strong> under Automatic Downloads.')}

    ${alert_('red', '<strong>No excuses on this one.</strong> An outdated app is the fastest way to lose an account without seeing it coming.')}
  `;

  const sec02 = `
    <p>The first hour after creating the account decides a lot. Skip a setting and you fight an uphill battle for weeks.</p>

    <h3>📱 Creating the Account</h3>
    ${step('1', '<strong>Use the email and phone provided by the team.</strong> Never your personal contacts.')}
    ${step('2', 'Confirm email + phone <strong>immediately</strong> so the account is not flagged as suspicious.')}
    ${step('3', '<strong>Pick a username.</strong> Memorable, persona-based, lowercase. Avoid spam-style names like <code>sexybaby9747</code> — those are flagged before the account even posts. Good patterns: <code>@bellacosplay</code>, <code>@lavendergloss</code>, <code>@iamruby</code>.')}
    ${step('4', '<strong>Complete the profile</strong> right away (avatar, banner, bio). X treats completeness as trust.')}
    ${step('5', 'Send account details to your <strong>supervisor</strong> so the team has them on file.')}

    <h3>⚙️ Settings to Configure Right Now</h3>
    <p>X menus change names over time. For every setting below, the <em>toggle name</em> is the stable part — search for that exact phrase inside Settings if a menu has moved.</p>

    ${step('1', '<strong>Precise location — OFF.</strong> <em>Settings → Privacy and safety → Location information → Precise location.</em> Geographic filter on reach — we want the whole US, not just nearby users.', 'Search Settings for "location" — the toggle is named <em>Precise location</em>. Turn it OFF.')}

    ${step('2', '<strong>NSFW filter — turn ON (you do NOT see explicit content).</strong> <em>Settings → Privacy and safety → Content you see</em> — uncheck <strong>"Display media that may contain sensitive content"</strong>. Two reasons: (1) protects you from explicit content while working, (2) keeps your For You page clean. Creators who post explicit content do a completely different style of marketing (direct DMs, hard-sell, "click my link" tweets) — we don&apos;t want their patterns leaking into our FYP feed.', 'Search Settings for "sensitive" — the toggle is <em>Display media that may contain sensitive content</em>. Leave it UNCHECKED.')}

    ${step('3', '<strong>Direct messages — Allow from everyone.</strong> <em>Settings → Privacy and safety → Direct messages</em> → set "Allow message requests from" to <strong>Everyone</strong>. We want DMs flowing in.', 'Search Settings for "messages" — the option is <em>Allow message requests from</em>.')}

    ${step('4', '<strong>Professional / Twitter Pro — LEAVE OFF.</strong> X has a "Professional Profile" mode that tags the account as a business / public figure. Do NOT enable it — it kills personal reach. Our accounts are personal personas.', 'Found in Settings under "Account" or "Switch to professional". If you see a prompt to enable it during signup, decline.')}

    ${step('5', '<strong>Language: English (US). Phone region: United States.</strong> Language in the X app, region in your phone Settings.', 'X app → Settings → Accessibility, display, and languages → Languages → Display language → English. Phone region is in your iPhone/Android Settings → General → Language & Region.')}

    ${alert_('red', '<strong>DAY 1 RULES</strong>For the <strong>first 24 hours after signup</strong>: just set up the profile, scroll the For You page for 10 minutes, like 5–10 tweets. Do NOT follow anyone. Do NOT post. X watches new accounts very closely in the first day.')}
  `;

  const sec03 = `
    <p>The profile is your storefront. Most people decide whether to follow within 5 seconds. Make those 5 seconds count.</p>

    <h3>🪞 Profile Picture (Avatar)</h3>
    ${doDont(
      'GOOD AVATAR',
      ['Clear face shot — humans recognize faces fastest', 'Bright, daylight lighting', 'Beach, pool, bed in daylight, cozy room with a window', 'Eye contact with the camera'],
      'BAD AVATAR',
      ['Dark or blurry photos', 'Bedroom mirror at night', 'Explicit nudity (X restricts the account)', 'Cartoon avatars or stock images']
    )}

    <h3>🖼️ Header / Banner</h3>
    <p><strong>Most top creators do NOT use a personal photo as banner.</strong> Before designing one, open the <strong>Bios tab</strong> and Viral tabs on this dashboard — study what top accounts in our niche actually use. Common patterns:</p>
    <ul>
      <li>Clean meme that fits the persona</li>
      <li>Aesthetic image (pink gradient, beach sunset, neon room, anime backdrop)</li>
      <li>Text-based design — vibe words like "your favourite" / "cute" with stars</li>
      <li>Cosplay or themed shot if the persona is cosplay-focused</li>
    </ul>
    <p>A "second selfie" as banner is the lazy default and rarely the strongest choice. Look at what works for accounts you admire and adapt.</p>
    ${alert_('yellow', '<strong>CHECK ON MOBILE</strong>After uploading, open the profile on a phone. Almost all followers see X on mobile and the banner crops differently. If anything important is cut off — re-crop and re-upload.')}

    <h3>🏷️ Display Name &amp; Username</h3>
    <ul>
      <li>Display name: persona first name + a soft emoji: <code>bella ♡</code>, <code>ruby 🌸</code></li>
      <li>Keep it short — long names get truncated</li>
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
      ['1–2 emojis max', 'Arrow (↓ / 👇) at the end of the bio text', 'Short and witty', 'Match the persona vibe'],
      'BIO DON&apos;T',
      ['No "18+" / "NSFW"', 'No "subscribe" or "DM for"', 'No link until 100 followers (see the Link Rule chapter)', 'No long descriptions', 'No age or birthday in the bio']
    )}

    <h3>📍 Location Field</h3>
    <p>The location field is <strong>optional</strong>. If a US city fits the persona (LA, Miami, Austin), use it. Otherwise leave it blank — or use the field for short decorative text the way many creators do.</p>
    ${codeBlock([
      '⋆˚🪐˖°',
      '🍓 cute ♡',
      'in ur dreams',
      'lost in space ✰',
      'your phone screen',
    ], 'Decorative location examples')}

    <h3>📅 Birthday &amp; Website</h3>
    <ul>
      <li><strong>Birthday:</strong> do not set one. Skip the field. Do not mention age in the bio either.</li>
      <li><strong>Website:</strong> blank until your supervisor sends you the link at 100 followers.</li>
    </ul>

    <h3>📌 Pinned Tweet</h3>
    ${alert_('yellow', '<strong>DO NOT PIN YET</strong>Leave the pin empty until a post hits <strong>100 likes</strong>. Pinning a weak tweet makes the account look dead — worse than no pin at all. The Pinned Tweet chapter has the full rules.')}
  `;

  const sec04 = `
    <p>X watches new accounts closely. The first three weeks are about looking like a real person <em>before</em> you act like a creator. Rush it and you get shadowbanned in the first month.</p>

    ${alert_('yellow', '<strong>THE WARM-UP RULE</strong>Posting starts on Day 1 but at very low volume. The schedule below is the safe path — do not exceed these numbers.')}

    <h3>🌱 Phase 1 — Day 1 to Day 3 (Light start)</h3>
    ${step('1', '<strong>1 post per day</strong> — one good photo + short caption')}
    ${step('2', 'Follow 5–10 creators in our niche (spread across the day)')}
    ${step('3', 'Like 10–20 tweets per day')}
    ${step('4', 'Write 5 short, friendly replies on other creators&apos; tweets')}
    ${step('5', 'Scroll the For You page 10 minutes')}

    <h3>🌿 Phase 2 — Day 4 to Day 10 (Engagement build)</h3>
    ${step('1', '<strong>2 posts per day</strong>, 4–6 hours apart')}
    ${step('2', 'Follow 10–15 more creators (total ~30–40)')}
    ${step('3', 'Like 30–50 tweets per day')}
    ${step('4', '15 thoughtful replies per day')}
    ${step('5', 'Start <strong>image comments</strong> on viral posts — 3–5 per day (Growth chapter has the playbook)')}

    <h3>🌳 Phase 3 — Day 11 onward (Full operation)</h3>
    ${step('1', '<strong>3 posts per day</strong>, spread across active hours')}
    ${step('2', 'Like 50–100 tweets per day')}
    ${step('3', '20–30 replies per day, half as image-replies on viral posts')}
    ${step('4', 'Follow 5 niche creators per day from the Viral tabs (FYP Building chapter)')}
    ${step('5', 'Once you cross <strong>100 followers</strong>: DM Justin (@SunnyAngels_Admin) for the link')}

    <h3>📋 Quick Reference</h3>
    ${tbl(['Action','Day 1–3','Day 4–10','Day 11 +'],[
      ['Posts','1 / day','2 / day','3 / day'],
      ['Follows','5–10','10–15','max 30'],
      ['Likes','10–20','30–50','50–100'],
      ['Replies','5','15','20–30'],
      ['Link in bio','No','No','Only after 100 followers'],
    ])}
  `;

  const sec05 = `
    <h3>📅 How Many Posts Per Day</h3>
    ${tbl(['Account Age','Posts','Why'],[
      ['Day 1–3','1','New-account watch period'],
      ['Day 4–10','2','Active without spamming'],
      ['Day 11 +','3','Full operating volume — three is the sweet spot'],
    ])}
    ${alert_('yellow', '<strong>SPACE THEM OUT</strong>Posts should be <strong>3 to 5 hours apart</strong>. Two posts within an hour gets the second one buried by the algorithm.')}

    <h3>🕐 When to Post</h3>
    <p>Our audience is mostly in the United States. The Strategy tab on this dashboard has the full heat map with both US Eastern and your local Manila time.</p>
    ${tbl(['US Eastern','Manila (PH)','Why this slot'],[
      ['09:00 – 11:00','22:00 – midnight','US morning'],
      ['13:00 – 15:00','02:00 – 04:00','Lunch break scrollers — strongest slot'],
      ['20:00 – 22:00','09:00 – 11:00','US evening prime — your morning'],
    ])}
    <p>Best days: <strong>Tuesday through Thursday</strong>. Saturday late night is the deadest window — avoid.</p>

    <h3>🔄 The Before / After Routine</h3>
    <p>This is what wins the first 30 minutes. Do it on every post, especially under 2,000 followers.</p>
    ${step('A', '<strong>2–3 min BEFORE:</strong> Reply to comments on your previous post. Scroll For You, like 3–5 tweets. Warms up the algorithm.')}
    ${step('B', '<strong>POST your tweet.</strong>')}
    ${step('C', '<strong>3–5 min AFTER:</strong> Stay in the app. Scroll For You for 2 minutes. Image-comment on 2 viral posts. Do 3–5 follower steals. Like 5–10 tweets.')}
    ${alert_('blue', '<strong>WHY THIS WORKS</strong>X rewards active users. Post-and-disappear reads as low-quality. Post-and-stay-engaged-for-5-minutes reads as a real active person — and your tweet gets pushed wider.')}

    <h3>📏 Hashtags</h3>
    <p>Hashtags are <strong>optional</strong>. Most tweets work fine without any. If you do use them:</p>
    <ul>
      <li>1–2 niche hashtags maximum — never 3 or more (drops reach by 40%)</li>
      <li>No oversaturated tags (<code>#OnlyFans</code>, <code>#porn</code>, <code>#nsfw</code>) — even one of those triggers a shadowban</li>
    </ul>
  `;

  const sec06 = `
    ${alert_('red', '<strong>THE SINGLE MOST IMPORTANT RULE</strong>Read this section twice. The link rule is what makes or breaks the account.')}

    <h3>🚫 The Rule</h3>
    <p>You may <strong>NEVER</strong> put a URL in the main text of a tweet. X throttles tweets with links by 30 to 50% reach. This has been the case since March 2025.</p>

    <h3>📍 Where the Link Goes</h3>
    <p>Once you have a link, it lives <strong>only in the bio website field</strong>. Nothing in any tweet — just the arrow ↓ at the end of your bio text pointing down to where the website shows on the profile.</p>

    <h3>🎯 How to Get Your Link</h3>
    <p>You don&apos;t get a link on day one. You earn it.</p>
    ${step('1', '<strong>Reach 100 followers</strong> through warm-up, posting, image comments, and follower stealing.')}
    ${step('2', '<strong>DM Justin on X:</strong> "Hey, [account] just hit 100 followers — ready for a link". He creates it within a day.')}
    ${step('3', '<strong>Add the link to the bio</strong> in the website field. Keep the arrow ↓ at the end of the bio text.')}

    ${contact('CONTACT FOR YOUR LINK', '@SunnyAngels_Admin (Justin)', 'DM him on X once the account hits 100 followers. He sets up the link, sends it back, you add it to the bio. Justin handles ONLY the link request — for anything else, message your supervisor.')}

    <h3>🤔 Why We Wait Until 100 Followers</h3>
    <p>An account with a link and fewer than 100 followers looks like obvious spam → X throttles it. An account that grew to 100 through personality first looks like a real person who happens to have a link → treated normally. The 100-follower milestone also confirms the account is healthy enough to drive real traffic.</p>

    <h3>📝 Once You Have the Link</h3>
    ${doDont(
      'LINK DO',
      ['Link in the bio website field only', 'Arrow ↓ at end of bio text points to it', 'Share only when someone explicitly asks in DMs'],
      'LINK DON&apos;T',
      ['No URL in any tweet — ever', 'No "link in bio" written in tweets (even the words hurt reach)', 'No sharing the link in random DMs']
    )}

    ${alert_('red', '<strong>IF YOU POST A LINK BY ACCIDENT</strong>Delete the tweet immediately. Do NOT edit. Editing keeps the algorithm penalty. Deleting and re-posting clean costs you nothing.')}
  `;

  const sec07 = `
    <p>You already know the rhythm from Threads — the same instincts apply on X. The patterns below come from analyzing <strong>4,996 tweets from 226 top creators</strong>, so you have data to back the technique.</p>

    <h3>📏 The Four Universal Rules</h3>
    ${step('1', '<strong>Short wins by 3×.</strong> Captions ≤25 chars average 2,336 likes. Captions over 60 chars average 777. If your caption is longer than the tweet box width on mobile, cut it.')}
    ${step('2', '<strong>Questions beat statements by 50%.</strong> Question tweets average 2,449 likes vs 1,627 for statements. End every caption with a question when you can.')}
    ${step('3', '<strong>"be honest" amplifies engagement.</strong> The top caption category in the dataset — averages 4,413 likes, 6.7% engagement. People on X cannot resist a challenge.')}
    ${step('4', '<strong>Lowercase reads as authentic.</strong> "am i your type" beats "Am I Your Type". Lowercase = casual friend-talk. Capitalized = marketing.')}

    <h3>🏆 Top All-Time Captions From the Dataset</h3>
    ${codeBlock([
      '"am i your type? (be honest)"  →  36,116 likes',
      '"taking bf applications rn"  →  35,019 likes',
      '"smash or pass (be honest) 🤭"  →  avg 13,806 likes',
      '"good morning 🫶"  →  avg 11,736 likes',
      '"eyes up here pretty boy"  →  avg 7,626 likes',
      '"Rate my arch 1-10"  →  6.5% engagement',
    ], 'Top performers')}

    <h3>🔍 Why These Worked</h3>
    ${alert_('green', '<strong>"am i your type? (be honest)" → 36,116 likes</strong>"am i your type" is already a question. "(be honest)" is the unlock — it turns a soft compliment-seek into a challenge. Replies flooded in: "100%", "absolutely", "you are literally my dream girl". Reply storm pushes the tweet to millions.')}
    ${alert_('green', '<strong>"taking bf applications rn" → 35,019 likes</strong>"Applications" is playful framing — turns "I am single" (boring) into a game (engaging). Replies: "putting my application in", "interview when", "where do I apply" — a thread of replies, the most valuable signal.')}
    ${alert_('green', '<strong>"good morning 🫶" → avg 11,736 likes</strong>Universal greeting + waking-up photo triggers a parasocial reaction — followers feel like the creator is greeting them. Easiest reply to write: "good morning beautiful".')}

    <h3>🔄 Build Your Own Library — Do Daily Research</h3>
    <p>Open the <strong>Viral Text</strong> tab on this dashboard at the start of every shift. The top tweets are what is working <em>right now</em>. Patterns shift weekly. Study three or four winning captions, then adapt the angles for your account. Never copy word-for-word — X detects duplicate captions across accounts and penalizes everyone involved.</p>

    <h3>📐 Caption Rules</h3>
    ${doDont(
      'DO',
      ['Short (≤25 chars wins)', 'End with a question', 'Use "be honest", "1 word", "rate me"', 'Lowercase', '0–2 emojis max'],
      'DON&apos;T',
      ['No paragraphs', 'No "link in bio" written in captions', 'No prices, no "subscribe"', 'No hashtag lists', 'No same caption twice in a week']
    )}
  `;

  const sec08 = `
    <p>Photos and videos must be <strong>SFW</strong>. X is fine with suggestive — explicit content gets the account restricted within hours.</p>

    <h3>📸 What to Post</h3>
    ${doDont(
      'GREAT CONTENT',
      ['Bikini / lingerie / matching sets (suggestive, not explicit)', 'Cosplay shoots', 'Lifestyle photos in good lighting', 'Mirror selfies in bright rooms', 'Workout / fitness content', 'GRWM short videos (5–15 sec)', 'Behind-the-scenes moments'],
      'NEVER POST',
      ['Explicit nudity', 'Minors / weapons / drugs / gore', 'Politics / religion / drama', 'Same photo within 7 days', 'Photos with other-platform watermarks (TikTok / IG)']
    )}

    <h3>🎥 Video Rules</h3>
    <ul>
      <li>Under <strong>2 minutes 20 seconds</strong> — longer gets less reach</li>
      <li>Best length: <strong>5–15 seconds</strong></li>
      <li>Vertical (9:16) and square (1:1) both work — landscape feels old</li>
      <li>First frame matters — it&apos;s the thumbnail</li>
    </ul>

    <h3>✂️ Cropping &amp; Editing Tip (Optional Safety)</h3>
    <p>X is getting better at detecting duplicate content. Modify each photo slightly before posting — extra layer of protection. You probably already do this from Threads:</p>
    ${step('1', '<strong>Crop slightly</strong> — even 5–10% off the edges changes the file fingerprint')}
    ${step('2', '<strong>Adjust brightness or contrast</strong> by +5 / −5 — subtle but the file is now unique')}
    ${step('3', '<strong>For videos:</strong> trim 0.5 sec off the start or end, or apply a subtle filter')}

    <h3>🔁 Reposting What Works</h3>
    ${alert_('yellow', '<strong>THE REPOST RULES</strong>Wait at least <strong>one full week</strong> between posts of the same photo / video<br>Use a <strong>different caption</strong> the second time<br>Apply the cropping / editing trick so the file is technically unique<br>Don&apos;t repost more than twice — the third time triggers duplicate detection')}
  `;

  const sec09 = `
    <p>You need a curated For You feed that shows you what works in our niche every day. The faster you train your FYP, the better your raw material for image comments, follower stealing, and caption ideas.</p>

    <h3>🎯 The Daily Habit — Follow 5 Niche Creators per Day</h3>
    ${step('1', 'Open the <strong>Viral Photos / Videos / Text</strong> tabs on this dashboard at the start of your shift.')}
    ${step('2', 'Pick <strong>5 creators per day</strong> whose work fits our strategy (similar persona, suggestive-not-explicit, US audience, English).')}
    ${step('3', 'Follow them on X.')}
    ${step('4', 'Quick light engagement on 1–2 of their recent posts — a like, maybe one short reply. Don&apos;t spam.')}

    <h3>📡 You Can Also Add Creators From Your FYP</h3>
    <p>If your For You feed surfaces a creator you don&apos;t see in the dashboard but who fits our strategy — go ahead and follow. Rule of thumb:</p>
    ${doDont(
      'FOLLOW IF',
      ['Similar niche / persona to ours', 'Suggestive content but NOT explicit', 'US audience / English captions', 'Active recently (posting in the last week)', 'Engagement looks real (not just bots)'],
      'SKIP IF',
      ['Explicit content (different marketing entirely)', 'Hard-sell / "click my link" style', 'Dead account (no recent posts)', 'Non-English, non-US audience', 'Bot-flooded reply sections only']
    )}

    <h3>💡 Why This Matters</h3>
    <p>Your FYP is the strongest signal X has about what kind of account you are. If your feed is full of explicit + hard-sell accounts, the algorithm starts thinking you&apos;re that kind of account too — and shows your tweets to that audience instead of the audience you actually want. A clean, curated FYP in our niche is a multiplier on every other thing you do.</p>

    ${alert_('blue', '<strong>DAILY TARGET</strong>5 new niche follows / day. Over a month that&apos;s 150 carefully chosen accounts — enough to fully transform your For You feed.')}
  `;

  const sec10 = `
    <p>The single most powerful growth tactic on X. Outperforms posting, following, and almost everything else combined.</p>

    <h3>💡 The Idea</h3>
    <p>Instead of writing a text reply on someone&apos;s viral tweet, you reply with one of your <strong>best photos or videos</strong>. The viral tweet has thousands of eyeballs. Your photo gets seen by a slice — the ones who like what they see click your profile and follow.</p>

    ${alert_('green', '<strong>WHY IT BEATS EVERYTHING ELSE</strong>You borrow someone else&apos;s audience for free. Image replies stop the scroll inside the reply thread. The bigger the original tweet, the bigger the borrowed audience.')}

    <h3>📋 How to Run It</h3>
    ${step('1', '<strong>Open Viral Photos / Viral Videos</strong> on this dashboard. Sort by Most Recent. Find fresh tweets gaining momentum.')}
    ${step('2', '<strong>Pick a target:</strong> <strong>1,000+ likes</strong>, <strong>less than 20 hours old</strong>, from a creator with <strong>10K–200K followers</strong>. Bigger creators = too much competition. Smaller = not enough audience to borrow.')}
    ${step('3', 'Open the tweet on X and tap reply.')}
    ${step('4', 'Reply with one of your <strong>best photos</strong> + a short relevant caption that connects to the original tweet.')}
    ${step('5', 'Stay in the app after posting. Do not follow up. Do not add a link.')}

    <h3>💬 Caption Examples for Image Replies</h3>
    ${codeBlock([
      'Original: "Do I look cute today?"  →  Your reply: [best photo] + "we could be twins 😭"',
      'Original: "rate my outfit"  →  Your reply: [fit photo] + "trade fits?"',
      'Original: "tell me i am pretty"  →  Your reply: [photo] + "you are gorgeous 🥹 (me though?)"',
      'Original: "anyone else feeling cute today?"  →  Your reply: [photo] + "🙋‍♀️"',
    ], 'Image reply examples')}

    <h3>📐 Rules</h3>
    ${doDont(
      'DO',
      ['Max 10 image replies per day', 'Different photo each time', 'Short, relevant, never promotional caption', 'Only reply on tweets gaining momentum'],
      'DON&apos;T',
      ['No "follow me", "check my profile", "DM me"', 'No reusing the same photo', 'No replies on dead tweets', 'No tagging your account in their thread']
    )}

    ${alert_('green', '<strong>DAILY TARGET</strong>5–10 image replies during active hours. Done consistently, this brings 20–80 new followers per day in the early weeks.')}
  `;

  const sec11 = `
    <p>"Follower stealing" sounds aggressive — it&apos;s actually polite. You find fans in other creators&apos; viral comment sections and make a friendly connection. Most of them follow back because you noticed them. Same principle as Threads.</p>

    <h3>🔎 Finding Targets</h3>
    ${step('1', '<strong>Open Viral Photos / Viral Text</strong>. Pick a tweet from a creator in our niche with 500+ likes.')}
    ${step('2', '<strong>Scroll the replies on X.</strong> Look for comments with <strong>fewer than 10 likes</strong> — more than 10 means too many other creators are chasing the same user.')}
    ${step('3', '<strong>Filter for good targets:</strong> looks American, English comment, has a profile photo, has own tweets (not just replies), looks 25+. Skip bots, locked accounts, and women.')}

    <h3>🤝 The Interaction (~90% follow-back rate)</h3>
    ${step('1', 'Follow them.')}
    ${step('2', 'Like the comment they left on the viral tweet.')}
    ${step('3', 'Open their profile. Find one of their own tweets (not a reply).')}
    ${step('4', 'Leave a short genuine reply — "love this!", "great take". Nothing promotional, nothing about you.')}
    <p>Most notice the activity (follow + like + reply) and follow back within an hour or two. They feel seen — that is all the magic is.</p>

    ${alert_('red', '<strong>STAY WITHIN THESE LIMITS</strong>Max <strong>5 steals per posting session</strong>, 10–15 / day total<br>Never write anything promotional on their profile<br>Only US-based, English-speaking, real-looking accounts<br>Spread across the day — never all at once')}
  `;

  const sec12 = `
    <p>The pinned tweet is the first thing anyone sees when they click on the profile. Most non-followers decide whether to follow based on the pinned tweet + bio — within 5 seconds.</p>

    ${alert_('red', '<strong>DO NOT PIN YET</strong>While the account is fresh, leave the pin empty. A pinned tweet with 4 likes makes the account look dead — worse than no pin at all.')}

    <h3>📌 When to Pin Your First Tweet</h3>
    <p>Wait until one of your tweets crosses <strong>100 likes</strong>. That is the threshold where the pin starts working in your favor.</p>
    ${scen('green', '✅ Why 100 likes', 'A pin with 100+ likes signals to a visitor: "other people approve — safe to follow." Anything below 100 makes the account look quiet and the visitor scrolls away.')}

    <h3>🏆 What to Pin</h3>
    <ul>
      <li>Your <strong>single best-performing tweet</strong> by likes</li>
      <li>Photo or video tweets work better than text-only</li>
      <li>Visually striking — strong first impression</li>
      <li>Caption matches the persona</li>
    </ul>

    <h3>🔄 When to Replace the Pin</h3>
    <p>Every time a newer tweet beats the pinned one by likes — replace it. Always be pinning your current best. Check pin candidates once a week. To replace: tap the three dots on the new tweet → "Pin to your profile". Old pin gets removed automatically.</p>
  `;

  const sec13 = `
    <p>You don&apos;t need to memorize the algorithm. You need to know the seven rules below and what they look like in real life. Scan it once, internalize the patterns, move on.</p>

    <h3>1️⃣ Replies are the strongest signal — 150× a like</h3>
    ${scen('blue', '💬 What happens', '50 likes but 0 replies = "popular but not interesting" → algorithm stops pushing. Fix: end captions with a question. "(be honest)" doubles reply chances.')}

    <h3>2️⃣ First 30 minutes decide</h3>
    ${scen('yellow', '⏱️ What happens', 'You post and walk away for 20 minutes — tweet dies before anyone sees it. Fix: stay in the app, like 3 tweets on For You, reply to 2 creators, scroll for 5 minutes. Signals you&apos;re active.')}

    <h3>3️⃣ Bookmarks are gold — 20× a like</h3>
    ${scen('green', '🔖 What happens', 'A "save-worthy" photo (full body, well-composed) collects bookmarks even when likes look quiet. Bookmarks are a stronger ranking signal than likes — most creators ignore them.')}

    <h3>4️⃣ Short captions win — 3× more reach</h3>
    ${scen('blue', '✂️ What happens', '"am i your type? (be honest)" → 36K likes. Same idea as a paragraph → dies at 200. Rule: shorter than the tweet box width on mobile.')}

    <h3>5️⃣ Links in main tweet kill reach — by 30–50%</h3>
    ${scen('red', '🔗 What happens', 'Tweet with URL → reach halved compared to the same tweet without URL. Even writing "link in bio" hurts. Let the bio arrow ↓ do it silently.')}

    <h3>6️⃣ Grok AI reads everything (since Jan 2026)</h3>
    ${scen('yellow', '🤖 What happens', '"I hate when men ghost me 🙄" gets engagement BUT Grok reads negative emotion and quiets the whole account for 24h. "boys are so cute when they get nervous 😭" hits the same angle as positive — pushes wider. Fix: stay playful, never bitter or political.')}

    <h3>7️⃣ Consistency beats bursts</h3>
    ${scen('blue', '📅 What happens', '10 posts one day then nothing for three days = flagged as bot-like behavior. Steady 1–3 posts a day every day = normal account, normal growth.')}
  `;

  const sec_communities = `
    <p>X <strong>Communities</strong> (also called rooms) are closed groups around a niche. Posts inside only show to members — which means you are posting to a pre-qualified audience instead of fighting the public algorithm. This is one of the strongest growth levers we have on X.</p>

    ${video('communities.mp4')}

    <h3>🚪 How to use them</h3>
    ${step('1', 'When you find a creator in our niche (Viral Photos / Videos tab), check their profile for the <strong>Communities</strong> section.')}
    ${step('2', 'Tap any community they&apos;re in. If you like the vibe (active posts in the last 24h, mostly our niche) → request to join.')}
    ${step('3', 'Once accepted, the community pinned at the top of your feed — easy to come back to.')}
    ${step('4', 'Post directly inside the community using the FAB button. The post appears only to members.')}

    ${alert_('blue', '<strong>Why this works:</strong> 100 community impressions are worth more than 1,000 public ones because every viewer is already in the target audience. Higher reply rate, higher follow-back rate, higher click-through.')}

    <h3>📋 The Hard Rules</h3>
    ${doDont(
      'DO',
      [
        '<strong>Max 3 community posts per day</strong>, total across all communities',
        '<strong>At least 1 hour</strong> between two community posts',
        'Spread them across <strong>different</strong> communities',
        'Pick <strong>active</strong> communities (recent posts, real engagement)',
        'Same caption-and-image quality as a public post — communities are not a dump'
      ],
      'DON\'T',
      [
        '<strong>Never post the same content twice in the same community</strong> — instant mod-flag',
        'Don&apos;t post 3× in a row in the same community even if different content — looks spammy',
        'Don&apos;t join dead communities (no posts in 7 days) — wastes a feed slot',
        'No links, no promo — same public rules apply, mods enforce them harder',
        'Don&apos;t flood — start with 1 post / day in 1 community, ramp up over a week'
      ]
    )}

    <h3>🎯 What to post in a community</h3>
    <p>Same content rules as public, but lean into anything <strong>niche-specific</strong> the community is built around — if it&apos;s a "morning posters" community, post a morning shot. Use the Copy button on viral cards to grab proven captions, then adapt them to fit.</p>

    ${alert_('yellow', '<strong>Counts toward your daily 3-post limit:</strong> Public + community posts together max 3 per day. A community post still counts as a post on your timeline as far as the algorithm is concerned.')}

    ${alert_('green', '<strong>Bonus walkthrough — alternate demo:</strong>')}
    ${video('communities-extra.mp4')}
  `;

  const sec14 = `
    <p>A shadowban means X is silently hiding your tweets from people who don&apos;t already follow you. The account looks fine to you — but reach drops to zero. Most common cause of an account dying.</p>

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
    ${alert_('red', '<strong>TRIGGER LIST — KNOW THIS BY HEART</strong>Link in the main tweet (especially on new accounts)<br>Mass follow or unfollow in a short window<br>More than 100 likes in an hour<br>The exact same reply text used 5+ times<br>3+ hashtags in a tweet (#OnlyFans / #porn / #nsfw — even one of those is enough)<br>3rd-party apps connected to the account<br>Same photo + same caption across multiple accounts<br>Aggressive or political tone (Grok flags it)')}

    <h3>🔬 How to Tell If You Are Shadowbanned</h3>
    ${step('1', '<strong>Open <a href="https://circleboom.com/twitter-management-tool/twitter-search-tool/twitter-shadowban-test" target="_blank" rel="noopener">Circleboom Shadowban Test</a></strong> in your phone browser, paste the @handle, run the check. Any red flag = banned.')}
    ${step('2', '<strong>Incognito search:</strong> private browser → x.com (don&apos;t sign in) → search for the exact text of a recent tweet. If it doesn&apos;t appear in results, you are invisible to non-followers.')}
    ${step('3', '<strong>Engagement pattern:</strong> likes drop more than 70% overnight on the same kind of content → strong signal.')}

    <h3>🩹 Recovery</h3>
    ${scen('red', '🛑 Day 1–3: Stop completely', 'No likes, no follows, no posts, no replies. Don&apos;t even open the app on that account.')}
    ${scen('yellow', '💬 Day 4–5: Light replies only', 'Short, genuine replies on other creators&apos; tweets. No links, no photos.')}
    ${scen('blue', '📸 Day 6–7: Resume photos', '1 photo tweet per day, no link, short captions.')}
    ${scen('green', '✅ Day 8 +', 'Back to normal schedule.')}
    ${alert_('red', '<strong>STILL BANNED AFTER 7 DAYS?</strong>Message your supervisor. We may need to retire the account.')}
  `;

  const sec15 = `
    <p>You&apos;ll get bot comments and bot followers. This is normal. X is full of them.</p>

    <h3>🤖 The Counterintuitive Rule</h3>
    ${alert_('green', '<strong>BOTS IN YOUR COMMENTS ARE GOOD FOR THE ACCOUNT</strong>When a bot comments, it adds to the engagement count. The algorithm sees "this tweet has 30 replies" and pushes it wider — it can&apos;t tell which replies are real. The fact that bots showed up means your tweet hit the For You page. Good sign.')}

    <h3>✋ What to Do With Bot Comments</h3>
    ${doDont(
      'DO',
      ['Give bot comments a like (boosts engagement)', 'Leave them alone', 'Move on with your routine'],
      'DON&apos;T',
      ['Don&apos;t reply to them', 'Don&apos;t block them', 'Don&apos;t report them']
    )}

    <h3>🔍 How to Spot a Bot</h3>
    <ul>
      <li>Generic praise: "amazing!", "wow!", "❤️❤️❤️" repeated</li>
      <li>Crypto / NFT / "DM for $$$" in their own bio</li>
      <li>Profile created in the last week</li>
      <li>No profile photo or stock photo</li>
      <li>Following thousands, almost no followers themselves</li>
    </ul>

    ${alert_('red', '<strong>IF A BOT DMs YOU</strong>Ignore. Don&apos;t click any links. Don&apos;t reply. Their goal is to phish you or scam — neither serves us.')}
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
    ${step('1', '<strong>Don&apos;t delete. Don&apos;t edit. Don&apos;t panic.</strong> Leave the tweet alone.')}
    ${step('2', '<strong>Reply to as many comments as you can — at least the first 20.</strong> Every reply feeds the algorithm. Even a "🥺" reply counts.')}
    ${step('3', '<strong>Follow-up tweet 1–2 hours later.</strong> Different photo, caption that references the viral one (e.g. "yall were so sweet on the last one ♡"). Captures the new visitors.')}
    ${step('4', '<strong>Check bio + pinned tweet.</strong> A flood of new visitors is going to look at both.')}
    ${step('5', '<strong>Screenshot to your supervisor.</strong> So the team knows the account is performing — we can unlock the link / Premium if it&apos;s time.')}

    ${alert_('yellow', '<strong>DO NOT FORCE A SECOND VIRAL</strong>The instinct after a hit is "post the same thing again". Wait at least <strong>7 days</strong> before reposting with a different caption. Same-day or next-day repost looks obvious — second post flops.')}
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
    ${step('1', '<strong>Check the shadowban tester first</strong> (link in the Avoiding Shadowbans chapter). If banned, follow that recovery instead.')}
    ${step('2', '<strong>Delete the worst-performing tweet</strong> from the slowdown window. Underperformers drag the whole account&apos;s score down.')}
    ${step('3', '<strong>Cut posting to 2 / day for 3 days.</strong> Less volume, higher quality. Use your best photos.')}
    ${step('4', '<strong>Shift to interaction mode for those 3 days.</strong> Heavy on image replies and follower stealing. The algorithm rewards activity from <em>you</em>.')}
    ${step('5', '<strong>Still slow after a week?</strong> Change the avatar and refresh the bio. Sometimes the look is the problem.')}
    ${step('6', '<strong>Still slow after two weeks?</strong> Message your supervisor. We review the account together.')}
  `;

  const sec18 = `
    ${checklist('☀️ Daily Tasks', [
      'Open the dashboard — Viral Photos / Videos / Text for fresh ideas',
      'Post the planned tweets (1 / 2 / 3 depending on account age)',
      'Before / after routine on every post (5 min before, 5 min after)',
      'At least 5 image replies on viral tweets',
      'At least 5 follower steals on viral comment sections',
      'Reply to all comments on your own tweets',
      'Like 20–50 tweets in the For You feed',
      'Follow 5 niche creators from the Viral tabs',
    ], 'd')}

    ${checklist('📅 Weekly Tasks', [
      'Run the Circleboom shadowban test — no flags',
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
      <li><strong>10× more reach</strong> per tweet — X explicitly boosts Premium accounts</li>
      <li><strong>Comments appear at the top</strong> of any reply thread — makes image comments much stronger</li>
      <li><strong>Blue checkmark</strong> — instant credibility</li>
      <li><strong>Edit button</strong> — fix typos without losing engagement</li>
      <li><strong>4,000 character limit</strong> instead of 280</li>
      <li><strong>TweepCred boost</strong> — hidden trust score X uses to rank accounts</li>
    </ul>

    <h3>⏳ Why We Wait Until 1,000 Followers</h3>
    <p>Premium costs ~$8 / month per account. On a fresh account it&apos;s wasted — the audience isn&apos;t big enough for the boost to compound. At 1,000 followers, the boost starts producing measurable extra growth, and cost-per-new-follower drops sharply.</p>

    <h3>📞 How to Activate</h3>
    <p>You don&apos;t pay — we do. Just message your supervisor once the account hits 1,000.</p>

    ${contact('CONTACT TO ACTIVATE PREMIUM', 'Your supervisor', 'When your account hits 1,000 followers, message your supervisor: "[account] just hit 1,000 followers — ready for Premium". They handle billing and confirm once it&apos;s active.')}
  `;

  const sec20 = `
    <h3>📞 Who to Contact</h3>
    ${contact('FOR YOUR LINK ONLY — at 100 followers', '@SunnyAngels_Admin (Justin)', 'DM Justin <strong>only</strong> when your account reaches 100 followers and you need the link created. He does not handle anything else.')}
    ${contact('EVERYTHING ELSE', 'Your supervisor', 'For shadowban / suspension issues, viral post moments, weird account behaviour, Premium activation, or anything you are unsure about — message your supervisor first.')}
    ${alert_('yellow', '<strong>GENERAL RULE</strong>If you are in doubt — ask your <strong>supervisor</strong>. Only DM Justin for the link request at 100 followers. Premium, account problems, anything weird — supervisor.')}

    <h3>❓ FAQ</h3>

    ${faq('My account has 70 followers — can I get the link early?', 'No. The 100-follower line exists because X throttles new accounts that have a link before they look real. Stay patient — the last 30 followers go faster than the first 30.')}
    ${faq('Can I post the same photo on two of our accounts?', 'Not with the same caption. X detects duplicate photo + caption combinations across accounts and penalizes both. Use the same photo with different captions, or modify the photo slightly (Content Rules chapter).')}
    ${faq('My likes dropped overnight — what do I do?', 'Step 1: run the Circleboom shadowban test (link in the Avoiding Shadowbans chapter). Step 2: if shadowbanned → follow that recovery. Step 3: if not → follow the Slowdown Recovery chapter.')}
    ${faq('How many accounts can I run at once?', 'Five is the practical max. Past that, you cannot run image replies properly for each one and they all start to suffer.')}
    ${faq('A creator I look up to broke half these rules — why?', 'Large accounts (100K+) have organic momentum and can break some rules safely. Small accounts cannot. Stick to the playbook until 5,000 followers — then we revisit.')}
    ${faq('Can I use any auto-scheduler or bot app?', 'No. X detects 3rd-party automation and penalizes accounts. All posts go out manually from the X app.')}
    ${faq('What if X prompts me to verify with a phone or selfie?', 'Stop and message your supervisor immediately. Do not answer the prompt yourself.')}
    ${faq('What if a follower DMs explicit questions?', 'If polite → reply softly and casually. If aggressive or weird → ignore. Never send explicit content yourself, regardless of what they offer.')}
    ${faq('Can I do giveaways or contests?', 'Not without checking with your supervisor first. X has rules around giveaways that can suspend the account if you do it wrong.')}
    ${faq('How do I tell which posting time is best for my account?', 'Try all three windows (morning, lunch, evening) over a week. The one with highest average engagement is the sweet spot. Stick to it, but check again monthly — audience habits drift.')}
  `;

  // ══════════════════════════════════════════════════════════════════
  // VIDEO WALKTHROUGHS — screen recordings with explanations
  // ══════════════════════════════════════════════════════════════════

  const secV01 = `
    ${alert_('blue', '<strong>Pro tip:</strong> Use the same simple style as in the video — a white background plus one emoji. We do <strong>not</strong> use real photos of the creator on banners. Look at how the top creators below do it for inspiration.')}
    ${video('banner.mp4')}
    <h3>📸 Examples — copy the vibe, not the exact image</h3>
    ${imgGrid(['banner-example-1.png','banner-example-2.png','banner-example-3.png','banner-example-4.png','banner-example-5.png'])}
    <p>Notice: clean background, single emoji or graphic, no creator face. Keep it minimal and on-brand.</p>
  `;

  const secV02 = `
    ${video('bio.mp4')}
    <h3>How to do it</h3>
    ${step('1', 'Open the dashboard and go to the <strong>Bios</strong> tab in the top nav.')}
    ${step('2', 'Browse the bios of other top creators in our niche to get a feel for what works.')}
    ${step('3', 'Pick one that fits your creator&apos;s vibe — or even better, write your own short bio in that style.')}
    ${alert_('yellow', '<strong>Do not copy a bio 1:1</strong>. In the video I copied one directly just to demonstrate the flow — but in practice you should always rewrite it so it fits your specific creator.')}
  `;

  const secV03 = `
    ${video('location.mp4')}
    <p>Location is part of how you look natural on X. Use the <strong>Bios</strong> tab in the dashboard — you&apos;ll see real locations other creators use, plenty of inspiration there.</p>
    ${doDont(
      'Good location values',
      ['<strong>United States</strong> (written out)', 'United States 🇺🇸 (with flag)', 'Pretty special characters / decorative text', 'Anything that reads as "US" but isn&apos;t a single city'],
      'Avoid',
      ['<strong>Single city names</strong> (NYC, LA, Miami) — too specific, easier to fact-check', 'Random/joke locations', 'Empty / leaving it blank']
    )}
  `;

  const secV04 = `
    ${alert_('red', '<strong>Everyone must do this.</strong> Without a Professional / Creator account you are not eligible for the features we rely on.')}
    ${video('professional.mp4')}
    <h3>Steps</h3>
    ${step('1', 'Profile → Settings → Account → Switch to professional account.')}
    ${step('2', 'Choose <strong>Creator</strong> (not Business).')}
    ${step('3', 'Pick a category. I used <em>Fashion Model</em> in the video, but anything that fits works — <strong>Influencer</strong>, <strong>Content Creator</strong>, etc.')}
  `;

  const secV05 = `
    ${alert_('red', '<strong>Critical — do this immediately after account setup.</strong> Otherwise the email inbox gets flooded with X marketing mails and your supervisor gets spammed.')}
    ${video('notifications.mp4')}
    <p>Turn off everything you don&apos;t need — especially anything that emails you. Push notifications inside the app are fine to keep on minimally, but the email channel should be silent.</p>
  `;

  const secV06 = `
    ${video('language.mp4')}
    <p>Settings → <strong>Accessibility, display, and languages</strong> → <strong>Languages</strong> → make sure <strong>English</strong> is the only active content language. This keeps the FYP US-only and keeps the content you see relevant.</p>
  `;

  const secV07 = `
    ${alert_('blue', '<strong>This is the single most important step for a fresh account.</strong> Take your time here — the FYP you build now decides the quality of every recommendation X serves you for months.')}
    ${video('viral-interaction.mp4')}
    <h3>What I do in the video</h3>
    ${step('1', 'Open the <strong>Viral Photos / Videos / Text</strong> tabs in this dashboard to find real creators in our niche.')}
    ${step('2', 'Click through to their X profiles and <strong>follow them</strong>. Like a few of their posts while you&apos;re there.')}
    ${step('3', 'Repeat until your account follows <strong>50–100 creators in week 1</strong>. This is the base of your FYP.')}
    ${step('4', 'While following, do small interactions — likes, an occasional comment. Don&apos;t go crazy on day one; spread it over the week.')}
    <p>The point: by the end of week 1, when you open X, your FYP is <em>only</em> niche creators that use Twitter as a traffic source. That&apos;s the foundation everything else builds on.</p>
  `;

  const secV08 = `
    ${alert_('yellow', '<strong>Must be done inside the in-app browser</strong> — this option is hidden from the normal X app settings. You can only find it after logging in via the in-app browser on x.com.')}
    ${video('sensitive-content.mp4')}
    <h3>Where</h3>
    <p>x.com (in-app browser) → Settings → <strong>Privacy and Safety</strong> → <strong>Content you see</strong> → enable <strong>"Display media that may contain sensitive content"</strong>.</p>
    ${alert_('blue', '<strong>Don&apos;t worry — NSFW is still blurred by default.</strong> This setting only affects whether posts from restricted accounts show up at all. We need it on, otherwise you can&apos;t see half the creators in our niche. We never engage with NSFW — only SFW creators.')}
  `;

  const secV09 = `
    ${alert_('yellow', '<strong>Open Safari (not the X app).</strong> The pro-account category can only be removed via the web — the app won&apos;t let you. We want the category removed once the account is set up.')}
    ${video('safari-category.mp4')}
    ${step('1', 'Open Safari → go to <strong>x.com</strong> and log in.')}
    ${step('2', 'Click <strong>Edit profile</strong>.')}
    ${step('3', 'Scroll to <strong>Edit professional profile</strong> → turn the <strong>category off</strong>.')}
  `;

  const secV10 = `
    ${alert_('yellow', 'Still inside Safari (not the app). These two location/explore settings only show correctly in the web UI.')}
    ${video('privacy-safety.mp4')}
    ${step('1', 'Settings → <strong>Privacy and Safety</strong> → <strong>Location information</strong> → turn off <em>Personalize based on places you&apos;ve been</em>.')}
    ${step('2', 'Settings → <strong>Privacy and Safety</strong> → <strong>Explore settings</strong> → turn off <strong>both</strong> options shown there.')}
  `;

  const secV11 = `
    ${alert_('red', '<strong>Never post cold.</strong> Always interact for at least <strong>10–15 minutes</strong> before publishing. Posting without warming up gets accounts restricted. The video shows a sped-up demo — in reality you should take your time.')}
    ${video('interact-before-post.mp4')}
    <h3>The flow shown in the video</h3>
    ${step('1', 'Open the <strong>Viral Photos</strong> tab here in the dashboard.')}
    ${step('2', 'Find a strong post — good image + good caption.')}
    ${step('3', 'Use the new <strong>Copy</strong> button on the card to grab the caption.')}
    ${step('4', 'Save the image, switch to X, interact for 10–15 minutes (likes, replies, joining rooms).')}
    ${step('5', 'Now post your image with the caption you copied (or rewrite it slightly so it fits your creator). This is almost identical to the Threads workflow.')}
    ${alert_('blue', 'Always adapt the caption to your specific creator&apos;s voice. The Viral Tab is for inspiration — not blind copy-paste.')}
  `;

  const secV12 = `
    ${alert_('blue', '<strong>Communities (Rooms) are gold.</strong> If a creator you follow has a room, join it. You can post directly in the room and only the targeted niche audience sees it. They&apos;ll also show up at the top of your feed.')}
    ${video('communities.mp4')}
    <h3>Why it matters</h3>
    <ul>
      <li>Anyone in the room is already in our target audience — no wasted reach.</li>
      <li>Posts in a room don&apos;t fight against the public algorithm.</li>
      <li>Once joined, the room sits at the top of your feed permanently — easy to revisit.</li>
    </ul>
    <h3>Bonus walkthrough</h3>
    <p>Same idea, alternate demo with a different account:</p>
    ${video('communities-extra.mp4')}
  `;

  // ── Chapters ─────────────────────────────────────────────────────────
  const chapters = [
    { id: 'setup', icon: '🚀', title: 'Setup', sub: 'Phone hygiene, account creation, profile, warm-up',
      sections: [
        { num: 1,   id: 'welcome',  title: 'Welcome — The Big Picture',       body: sec01 },
        { num: 'P', id: 'hygiene',  title: 'Phone Hygiene Before You Start',  body: secHygiene },
        { num: 2,   id: 'create',   title: 'Creating the Account',            body: sec02 },
        { num: 3,   id: 'profile',  title: 'Profile Setup',                   body: sec03 },
        { num: 4,   id: 'warmup',   title: 'Account Warm-Up (Day 1–21)',      body: sec04 },
      ]},
    { id: 'video', icon: '🎥', title: 'After Setup — Configure', sub: 'Video walkthroughs for every setting',
      sections: [
        { num: 'V1',  id: 'v-banner',     title: 'Banner — Set a Clean Banner',                 body: secV01 },
        { num: 'V2',  id: 'v-bio',        title: 'Bio — Use the Bios Tab for Inspiration',      body: secV02 },
        { num: 'V3',  id: 'v-location',   title: 'Location — What to Pick',                      body: secV03 },
        { num: 'V4',  id: 'v-pro',        title: 'Switch to a Professional / Creator Account',   body: secV04 },
        { num: 'V5',  id: 'v-notif',      title: 'Turn Off Email Notifications',                 body: secV05 },
        { num: 'V6',  id: 'v-lang',       title: 'Set Content Language to English',              body: secV06 },
        { num: 'V7',  id: 'v-fyp',        title: 'Build Your FYP From the Viral Tab',            body: secV07 },
        { num: 'V8',  id: 'v-sensitive',  title: 'Enable Sensitive-Content (In-App Browser)',    body: secV08 },
        { num: 'V9',  id: 'v-safari',     title: 'Safari: Turn Off Category on Profile',         body: secV09 },
        { num: 'V10', id: 'v-privacy',    title: 'Safari: Privacy & Safety Settings',            body: secV10 },
        { num: 'V11', id: 'v-interact',   title: 'Interact 10–15min BEFORE Posting',             body: secV11 },
        { num: 'V12', id: 'v-rooms',      title: 'Use Communities / Rooms',                      body: secV12 },
      ]},
    { id: 'daily', icon: '📅', title: 'Daily Posting', sub: 'Schedule, link rule, captions, content',
      sections: [
        { num: 5, id: 'schedule', title: 'Daily Posting Schedule',         body: sec05 },
        { num: 6, id: 'link',     title: 'The Link Rule (CRITICAL)',       body: sec06 },
        { num: 7, id: 'captions', title: 'Captions: What Works & Why',     body: sec07 },
        { num: 8, id: 'content',  title: 'Content Rules (Photos & Videos)', body: sec08 },
      ]},
    { id: 'growth', icon: '🛠️', title: 'Growth Tactics', sub: 'FYP, image comments, communities, follower stealing',
      sections: [
        { num: 9,  id: 'fyp',         title: 'Building Your FYP — Follow 5/Day',         body: sec09 },
        { num: 10, id: 'imgrep',      title: 'Image Comments (Strongest Growth)',        body: sec10 },
        { num: 11, id: 'steal',       title: 'Follower Stealing',                        body: sec11 },
        { num: 12, id: 'communities', title: 'Communities / Rooms (Targeted Reach)',     body: sec_communities },
        { num: 13, id: 'pinned',      title: 'Pinned Tweet — Wait for 100 Likes',        body: sec12 },
        { num: 14, id: 'algorithm',   title: "How X's Algorithm Decides (Reference)",    body: sec13 },
      ]},
    { id: 'safe', icon: '🛡️', title: 'Keep Account Safe', sub: 'Shadowbans, bots, viral, slowdowns',
      sections: [
        { num: 14, id: 'shadow',   title: 'Avoiding Shadowbans',          body: sec14 },
        { num: 15, id: 'bots',     title: 'Bots in Your Comments',        body: sec15 },
        { num: 16, id: 'viral',    title: 'When a Post Goes Viral',       body: sec16 },
        { num: 17, id: 'slowdown', title: 'When Your Account Slows Down', body: sec17 },
      ]},
    { id: 'ref', icon: '📚', title: 'Reference', sub: 'Checklist, Premium, FAQ',
      sections: [
        { num: 18, id: 'chk',     title: 'Daily / Weekly Checklist',     body: sec18 },
        { num: 19, id: 'premium', title: 'At 1,000 Followers: X Premium', body: sec19 },
        { num: 20, id: 'faq',     title: 'FAQ + How to Reach Us',        body: sec20 },
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
        <p>The short version: what to post, what to avoid, and how to handle every situation you&apos;ll run into. Based on data from 4,996 tweets and 226 top creators in our niche.</p>
      </div>

      <div class="gd-info">
        <div class="gd-info-eyebrow"><span class="gd-emoji">⚡</span>THE 5 RULES YOU CANNOT BREAK</div>
        <p><strong>1.</strong> Never put a link in any tweet. The link lives only in the bio — and only once you hit 100 followers.</p>
        <p><strong>2.</strong> No promotional tweets ever. All promo is passive through the bio link. Pure personality content only.</p>
        <p><strong>3.</strong> Stay engaged for 5 minutes after every post — the first 30 minutes decide whether the tweet spreads or dies.</p>
        <p><strong>4.</strong> Max 3 posts / day. Space them 3–5 hours apart.</p>
        <p><strong>5.</strong> When unsure — message your supervisor. The Link Request at 100 followers is the only thing Justin (@SunnyAngels_Admin) handles.</p>
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
  // Stop any playing media so audio doesn't keep going after the modal hides.
  $$('#post-modal video, #post-modal audio').forEach(v => {
    try { v.pause(); v.currentTime = 0; } catch (_) {}
  });
  $('#post-modal').classList.add('hidden');
  $('#post-modal').classList.remove('active');
}

function pauseAllGuideVideos() {
  $$('#tab-guide video, #tab-guide audio').forEach(v => {
    try { v.pause(); } catch (_) {}
  });
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
