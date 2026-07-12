const API_BASE = '';
const DATA_POLL_INTERVAL = 3000;
let entitiesData = [], activeTab = 0, currentMode = 'clan', autoSwitchInterval = 0;
let autoSwitchTimer = null, notificationTimer = null, pollStart = Date.now(), lastRanks = {};
let skippedNames = [], firstRun = true;

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtPts(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n); }
function fmtRate(r) { return r >= 1 ? Math.round(r) + '/s' : r > 0 ? '<1/s' : '0/s'; }
function fmtIdle(s) { return s < 60 ? Math.round(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm'; }

async function fetchApi(path, opts) {
  try {
    const resp = await fetch(API_BASE + path, opts);
    return await resp.json();
  } catch { return null; }
}

async function pollLoop() {
  const data = await fetchApi('/api/status');
  if (data) {
    currentMode = data.mode || currentMode;
    autoSwitchInterval = data.auto_switch_interval || 0;
    skippedNames = data.skipped_names || [];
    const prevRanks = {...lastRanks};
    for (const ent of (data.entities || [])) {
      if (!ent || ent.error || !ent.name) continue;
      const key = ent.name.toUpperCase();
      const prev = prevRanks[key];
      if (prev !== undefined && prev !== ent.rank && ent.rank > 0 && prev > 0) {
        if (ent.rank < prev) showNotification(ent.name + ' climbed to #' + ent.rank, 'overtake');
        else showNotification(ent.name + ' dropped to #' + ent.rank + ' (was #' + prev + ')', 'overtaken');
      }
      lastRanks[key] = ent.rank;
    }
    updateData(data);
  }
  setTimeout(pollLoop, DATA_POLL_INTERVAL);
}

function updateData(data) {
  if (data.last_checked) document.getElementById('last-checked').textContent = data.last_checked;
  const badge = document.getElementById('status-badge');
  if (data.entities) {
    badge.className = 'status-badge live';
    badge.innerHTML = '<span class="status-dot">●</span> Live';
  }
  if (data.entities) {
    entitiesData = data.entities;
    renderTabBar();
    renderActiveEntity();
    if (document.getElementById('graph-modal').className === 'modal-overlay show') {
      const canvas = document.getElementById('graph-canvas');
      const datasets = entitiesData.filter(e => e && e.name).map(e => ({ name: e.name, history: e.point_history || [], current: e.points }));
      if (datasets.length > 0) drawSparkline(canvas, datasets);
    }
  }
  pollStart = Date.now();
}

function renderTabBar() {
  const bar = document.getElementById('tab-bar');
  bar.innerHTML = '';
  entitiesData.forEach((ent, idx) => {
    if (ent.error) return;
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (idx === activeTab ? ' active' : '');
    btn.textContent = ent.name;
    btn.addEventListener('click', () => switchTab(idx));
    bar.appendChild(btn);
  });
  bar.className = entitiesData.length > 0 ? 'show' : '';
}

async function switchTab(idx) {
  activeTab = idx;
  document.querySelectorAll('.tab-btn').forEach((b, i) => { b.className = 'tab-btn' + (i === idx ? ' active' : ''); });
  fetchApi('/api/activetab?tab=' + idx, { method: 'POST' });
  const ent = entitiesData[activeTab];
  if (ent && !ent.error && ent.name) {
    const detail = await fetchApi('/api/detail/' + currentMode + '/' + encodeURIComponent(ent.name));
    if (detail) { ent.entries = detail.entries || []; ent.neighbors = detail.neighbors || []; ent.members = detail.members || []; }
  }
  renderActiveEntity();
  if (autoSwitchTimer) { clearInterval(autoSwitchTimer); autoSwitchTimer = null; }
  if (autoSwitchInterval > 0 && entitiesData.length > 1) {
    autoSwitchTimer = setInterval(() => {
      if (entitiesData.length === 0) return;
      const active = entitiesData.filter(e => e && e.name && !skippedNames.includes(e.name.toUpperCase()));
      if (active.length < 2) return;
      const curIdx = active.findIndex(e => e.name && e.name.toUpperCase() === ((entitiesData[activeTab] && entitiesData[activeTab].name) || '').toUpperCase());
      const next = active[(curIdx + 1) % active.length];
      const realIdx = entitiesData.findIndex(e => e && e.name && e.name.toUpperCase() === next.name.toUpperCase());
      if (realIdx >= 0) switchTab(realIdx);
    }, autoSwitchInterval * 1000);
  }
}

function renderActiveEntity() {
  const ent = entitiesData[activeTab];
  if (!ent) { document.getElementById('entities-container').className = ''; return; }
  document.getElementById('entities-container').className = 'show';
  if (ent.error) {
    document.getElementById('title').textContent = (ent.name || '').toUpperCase() + '  (' + (currentMode === 'clan' ? 'CLANS' : 'LEAGUES') + ')';
    document.getElementById('total-pts').textContent = '0';
    document.getElementById('eta').textContent = '';
    document.getElementById('strip-container').className = '';
    document.getElementById('card-list').innerHTML = '<div style="text-align:center;color:#f87171;padding:30px 0;">' + ent.error + '</div>';
    return;
  }
  document.getElementById('title').textContent = ent.name + '  (' + (currentMode === 'clan' ? 'Clans' : 'Leagues') + ')';
  document.getElementById('total-pts').textContent = Number(ent.points).toLocaleString();
  document.getElementById('eta').textContent = ent.eta || '';
  const iconEl = document.getElementById('icon');
  if (ent.icon) { iconEl.src = ent.icon; iconEl.className = 'show'; } else { iconEl.className = ''; iconEl.src = ''; }
  window._neighborsData = ent.neighbors || [];
  const strip = document.getElementById('strip-list');
  strip.innerHTML = '';
  const stripEntries = ent.entries || [];
  for (const e of stripEntries) {
    const card = document.createElement('div');
    card.className = 'card' + (e.type === 'self' ? ' self' : '') + (e.type === 'above' ? ' above' : '') + (e.type === 'below' ? ' below' : '');
    card.style.cursor = 'pointer';
    card.addEventListener('click', () => openCardDetail(e.name));
    let subHtml = '';
    if (e.type === 'self') {
      subHtml = e.rate > 0 ? '<div class="card-sub green">' + fmtRate(e.rate) + '</div>' : '<div class="card-sub dim">idle</div>';
    } else {
      const parts = [];
      if (e.gap) parts.push('<span>' + (e.type === 'above' ? '+' : '-') + fmtPts(e.gap) + '</span>');
      if (e.rate > 0) parts.push('<span class="card-sub green">' + fmtRate(e.rate) + '</span>');
      subHtml = parts.length ? '<div class="card-sub dim">' + parts.join(' ') + '</div>' : '';
    }
    card.innerHTML = '<div class="rank-pill">' + (e.rank >= 99999 ? '?' : e.rank) + '</div>'
      + '<div class="card-info"><div class="card-name">' + esc(typeof e.name === 'string' ? e.name : String(e.name)) + '</div></div>'
      + '<div class="card-right"><div class="card-pts">' + Number(e.points).toLocaleString() + '</div>' + subHtml + '</div>';
    strip.appendChild(card);
  }
  document.getElementById('strip-container').className = 'show';
  const list = document.getElementById('card-list');
  list.innerHTML = '';
  const members = ent.members || [];
  for (const m of members) {
    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = '<div class="member-name">' + esc(m.display_name || m.name || '') + '</div><div class="member-pts">' + Number(m.points).toLocaleString() + '</div>';
    list.appendChild(row);
  }
  const elapsed = (Date.now() - pollStart) / 1000;
  document.getElementById('countdown-bar').style.width = Math.min(100, (elapsed / 3) * 100) + '%';
}

function showNotification(msg, type) {
  const banner = document.getElementById('notification-banner');
  banner.textContent = msg;
  banner.style.background = type === 'overtaken' ? '#ef4444' : '#4ade80';
  banner.style.display = 'block';
  banner.style.opacity = 1;
  playBeep(type);
  if (notificationTimer) clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => {
    banner.style.opacity = 0;
    setTimeout(() => { banner.style.display = 'none'; }, 300);
  }, 5000);
}

function playBeep(type) {
  const audioId = type === 'overtaken' ? 'dropped-sound' : 'notification-sound';
  const audioEl = document.getElementById(audioId);
  if (audioEl) { audioEl.currentTime = 0; audioEl.play().catch(() => {}); return; }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880; osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.3);
  } catch(e) {}
}

function openNeighbors() {
  const modal = document.getElementById('neighbors-modal');
  const list = document.getElementById('neighbors-list');
  list.innerHTML = '<div style="text-align:center;color:#6a6690;padding:30px 0;">Loading...</div>';
  modal.className = 'modal-overlay show';
  const nd = window._neighborsData || [];
  list.innerHTML = '';
  if (nd.length === 0) { list.innerHTML = '<div style="text-align:center;color:#6a6690;padding:30px 0;">No data.</div>'; return; }
  for (const e of nd) {
    const row = document.createElement('div');
    row.className = 'member-row'; row.style.cursor = 'pointer';
    row.addEventListener('click', () => { closeNeighbors(); openCardDetail(e.name); });
    row.innerHTML = '<div class="member-rank' + (e.type === 'self' ? ' tracked' : '') + '">#' + e.rank + '</div>'
      + '<div class="member-info"><div class="name' + (e.type === 'self' ? ' tracked' : '') + '">' + esc(e.name) + '</div></div>'
      + '<div class="member-right">'
      + '<div class="member-rate" style="color:' + (e.rate > 0 ? '#4ade80' : '#6a6690') + '">' + (e.rate > 0 ? fmtRate(e.rate) : 'idle') + '</div>'
      + (e.gap !== undefined ? '<div class="member-gap">' + (e.type === 'self' ? '0' : (e.type === 'above' ? '+' : '-') + fmtPts(e.gap)) + '</div>' : '')
      + '<div class="member-pts">' + Number(e.points).toLocaleString() + '</div>'
      + '</div>';
    list.appendChild(row);
  }
}
function closeNeighbors() { document.getElementById('neighbors-modal').className = 'modal-overlay'; }

async function openCardDetail(name) {
  const modal = document.getElementById('detail-modal');
  const title = document.getElementById('detail-title');
  const neighborsEl = document.getElementById('detail-neighbors');
  const membersEl = document.getElementById('detail-members');
  title.textContent = name.toUpperCase();
  neighborsEl.innerHTML = '<div style="text-align:center;color:#6a6690;padding:20px 0;">Loading...</div>';
  membersEl.innerHTML = '';
  modal.className = 'modal-overlay show';
  const data = await fetchApi('/api/detail/' + currentMode + '/' + encodeURIComponent(name));
  neighborsEl.innerHTML = '';
  membersEl.innerHTML = '';
  if (data && data.neighbors && data.neighbors.length > 0) {
    for (const e of data.neighbors) {
      const row = document.createElement('div');
      row.className = 'detail-neighbor-row' + (e.type === 'self' ? ' tracked' : '');
      row.innerHTML = '<div class="detail-neighbor-rank">#' + e.rank + '</div>'
        + '<div class="detail-neighbor-name">' + esc(e.name) + '</div>'
        + '<div class="detail-neighbor-pts">' + Number(e.points).toLocaleString() + '</div>'
        + '<div class="detail-neighbor-gap">' + (e.type === 'self' ? '0' : (e.type === 'above' ? '+' : '-') + fmtPts(e.gap)) + '</div>';
      neighborsEl.appendChild(row);
    }
  } else {
    neighborsEl.innerHTML = '<div style="text-align:center;color:#6a6690;padding:10px 0;font-size:11px;">No neighbors.</div>';
  }
  if (data && data.members && data.members.length > 0) {
    for (const m of data.members) {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.innerHTML = '<div class="member-name">' + esc(m.display_name || m.name || '') + '</div><div class="member-pts">' + Number(m.points).toLocaleString() + '</div>';
      membersEl.appendChild(row);
    }
  } else {
    membersEl.innerHTML = '<div style="text-align:center;color:#6a6690;padding:10px 0;">No members.</div>';
  }
}
function closeDetail() { document.getElementById('detail-modal').className = 'modal-overlay'; }

function openSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('search-modal').className = 'modal-overlay show';
  document.getElementById('search-input').focus();
}
function closeSearch() { document.getElementById('search-modal').className = 'modal-overlay'; }

let searchTimer = null;
function doSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = document.getElementById('search-input').value.trim();
    if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
    const resultsEl = document.getElementById('search-results');
    resultsEl.innerHTML = '<div style="text-align:center;color:#6a6690;padding:20px 0;">Searching...</div>';
    try {
      const data = await fetchApi('/api/search/' + currentMode + '/' + encodeURIComponent(q));
      resultsEl.innerHTML = '';
      if (data && data.entries && data.entries.length > 0) {
        for (const e of data.entries) {
          const row = document.createElement('div');
          row.className = 'member-row'; row.style.cursor = 'pointer';
          row.addEventListener('click', () => { closeSearch(); openCardDetail(e.name); });
          row.innerHTML = '<div class="member-rank">' + (e.rank > 0 ? '#' + e.rank : '?') + '</div>'
            + '<div class="member-info"><div class="name">' + esc(e.name) + '</div></div>'
            + '<div class="member-right"><div class="member-pts">' + Number(e.points).toLocaleString() + '</div></div>';
          resultsEl.appendChild(row);
        }
      } else {
        resultsEl.innerHTML = '<div style="text-align:center;color:#6a6690;padding:20px 0;">No results.</div>';
      }
    } catch (e) { resultsEl.innerHTML = '<div style="text-align:center;color:#f87171;padding:20px 0;">Error searching.</div>'; }
  }, 300);
}

function openTop100() {
  const modal = document.getElementById('top-modal');
  const list = document.getElementById('top-list');
  list.innerHTML = '<div style="text-align:center;color:#6a6690;padding:30px 0;">Loading...</div>';
  modal.className = 'modal-overlay show';
  fetchTop100();
}
function closeTop100() { document.getElementById('top-modal').className = 'modal-overlay'; }

async function fetchTop100() {
  const list = document.getElementById('top-list');
  const data = await fetchApi('/api/top/' + currentMode);
  list.innerHTML = '';
  if (data && data.entries && data.entries.length > 0) {
    for (const e of data.entries) {
      const row = document.createElement('div');
      row.className = 'member-row'; row.style.cursor = 'pointer';
      row.addEventListener('click', () => { closeTop100(); openCardDetail(e.name); });
      row.innerHTML = '<div class="member-rank">#' + e.rank + '</div>'
        + '<div class="member-info"><div class="name">' + esc(e.name) + '</div></div>'
        + '<div class="member-right"><div class="member-pts">' + Number(e.points).toLocaleString() + '</div></div>';
      list.appendChild(row);
    }
  } else {
    list.innerHTML = '<div style="text-align:center;color:#f87171;padding:20px 0;">Could not load top 100.</div>';
  }
}

function openGraph() {
  const modal = document.getElementById('graph-modal');
  const ent = entitiesData[activeTab];
  document.getElementById('graph-title').textContent = ent && ent.name ? ent.name + ' - Points (60 min)' : 'Points';
  modal.className = 'modal-overlay show';
  setTimeout(() => {
    const canvas = document.getElementById('graph-canvas');
    const datasets = entitiesData.filter(e => e && e.name).map(e => ({ name: e.name, history: e.point_history || [], current: e.points }));
    if (datasets.length > 0) drawSparkline(canvas, datasets);
  }, 100);
}
function closeGraph() { document.getElementById('graph-modal').className = 'modal-overlay'; }

function drawSparkline(canvas, datasets) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);
  const colors = ['#4ade80', '#7c5cff', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];
  const pad = { top: 15, bottom: 20, left: 10, right: 10 };
  const gw = w - pad.left - pad.right, gh = h - pad.top - pad.bottom;
  let allMin = Infinity, allMax = -Infinity;
  for (const ds of datasets) {
    for (const pt of ds.history) { if (pt.pts < allMin) allMin = pt.pts; if (pt.pts > allMax) allMax = pt.pts; }
    if (ds.current < allMin) allMin = ds.current; if (ds.current > allMax) allMax = ds.current;
  }
  if (!isFinite(allMin) || !isFinite(allMax) || allMin === allMax) {
    ctx.fillStyle = '#6a6690'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No data', w / 2, h / 2); return;
  }
  if (allMax === allMin) allMax = allMin + 1;
  const range = allMax - allMin, yScale = gh / range;
  ctx.strokeStyle = '#1e1b3a'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + gh * (i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#6a6690'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(fmtPts(Math.round(allMax - range * (i / 4))), pad.left - 4, y + 3);
  }
  for (let di = 0; di < datasets.length; di++) {
    const ds = datasets[di], pts = ds.history;
    if (pts.length < 2) continue;
    const sorted = pts.slice().sort((a, b) => a.t - b.t);
    const tMin = sorted[0].t, tMax = sorted[sorted.length - 1].t, tRange = tMax - tMin || 1;
    ctx.strokeStyle = colors[di % colors.length]; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < sorted.length; i++) {
      const x = pad.left + ((sorted[i].t - tMin) / tRange) * gw;
      const y = pad.top + gh - (sorted[i].pts - allMin) * yScale;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  for (let di = 0; di < datasets.length; di++) {
    const ds = datasets[di];
    if (ds.current === undefined || ds.history.length === 0) continue;
    const sorted = ds.history.slice().sort((a, b) => a.t - b.t);
    const tMin = sorted[0].t, tMax = sorted[sorted.length - 1].t, tRange = tMax - tMin || 1;
    const x = Math.min(pad.left + ((Date.now() / 1000 - tMin) / tRange) * gw, w - pad.right - 5);
    const y = pad.top + gh - (ds.current - allMin) * yScale;
    ctx.fillStyle = colors[di % colors.length]; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
  }
}

function openSettings() {
  const modal = document.getElementById('settings-modal');
  const namesList = document.getElementById('settings-names-list');
  const modeSelect = document.getElementById('settings-mode');
  const autoSwitchInput = document.getElementById('settings-auto-switch');
  const notifyCheck = document.getElementById('settings-notify-overtake');
  const names = (entitiesData || []).map(e => e.name).filter(Boolean).length > 0
    ? entitiesData.map(e => e.name) : [currentMode === 'clan' ? 'POPS' : ''];
  modeSelect.value = currentMode;
  namesList.innerHTML = '';
  for (let i = 0; i < names.length; i++) {
    const row = createNameRow(names[i], i, skippedNames.includes(names[i].toUpperCase()));
    namesList.appendChild(row);
  }
  namesList.appendChild(createNameRow('', names.length, false));
  autoSwitchInput.value = autoSwitchInterval;
  notifyCheck.checked = true;
  modal.className = 'modal-overlay show';
  document.getElementById('settings-feedback').textContent = '';
}

function createNameRow(name, idx, isSkipped) {
  const row = document.createElement('div');
  row.className = 'settings-name-row'; row.draggable = true;
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'settings-toggle'; cb.checked = !isSkipped; cb.title = 'Include in auto-switch cycle';
  const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'settings-name-input';
  inp.placeholder = 'e.g. CLAN NAME'; inp.value = name; inp.style.textTransform = 'uppercase';
  const del = document.createElement('button'); del.className = 'settings-remove-btn'; del.textContent = '×';
  del.addEventListener('click', () => { if (row.parentElement && row.parentElement.children.length > 2) row.remove(); });
  row.appendChild(cb); row.appendChild(inp); row.appendChild(del);
  row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', Array.from(row.parentElement.children).indexOf(row)); row.style.opacity = '0.4'; });
  row.addEventListener('dragend', () => { row.style.opacity = '1'; });
  row.addEventListener('dragover', (e) => e.preventDefault());
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    const from = parseInt(e.dataTransfer.getData('text/plain'));
    const parent = row.parentElement;
    if (isNaN(from) || from === Array.from(parent.children).indexOf(row)) return;
    const items = Array.from(parent.children);
    const targetIdx = items.indexOf(row);
    const fromRow = items[from];
    if (from < targetIdx) parent.insertBefore(fromRow, row.nextSibling);
    else parent.insertBefore(fromRow, row);
  });
  return row;
}

function saveSettingsUI() {
  const namesList = document.getElementById('settings-names-list');
  const modeSelect = document.getElementById('settings-mode');
  const autoSwitchInput = document.getElementById('settings-auto-switch');
  const notifyCheck = document.getElementById('settings-notify-overtake');
  const feedback = document.getElementById('settings-feedback');
  const inputs = namesList.querySelectorAll('.settings-name-input');
  const toggles = namesList.querySelectorAll('.settings-toggle');
  const names = [], skip = [];
  inputs.forEach((inp, i) => {
    const v = inp.value.trim().toUpperCase();
    if (v) { names.push(v); if (toggles[i] && !toggles[i].checked) skip.push(v); }
  });
  if (names.length === 0) { feedback.textContent = 'Add at least one name.'; feedback.style.color = '#f87171'; return; }
  const newMode = modeSelect.value;
  fetchApi('/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracked_names: names, mode: newMode, auto_switch_interval: parseInt(autoSwitchInput.value) || 0, notify_overtake: notifyCheck.checked, skipped_names: skip })
  }).then(() => { feedback.textContent = 'Settings saved!'; feedback.style.color = '#4ade80'; });
}
function closeSettings() { document.getElementById('settings-modal').className = 'modal-overlay'; }

function dismissWelcome() {
  firstRun = false;
  try { localStorage.setItem('first_run', 'false'); } catch {}
  document.getElementById('welcome-modal').className = 'modal-overlay';
}

document.addEventListener('DOMContentLoaded', () => {
  try { firstRun = localStorage.getItem('first_run') !== 'false'; } catch {}
  if (firstRun) document.getElementById('welcome-modal').className = 'modal-overlay show';
  pollLoop();
  setInterval(() => {
    const elapsed = (Date.now() - pollStart) / 1000;
    document.getElementById('countdown-bar').style.width = Math.min(100, (elapsed / 3) * 100) + '%';
  }, 1000);
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-close').addEventListener('click', closeSettings);
  document.getElementById('settings-save').addEventListener('click', saveSettingsUI);
  document.getElementById('neighbors-btn').addEventListener('click', openNeighbors);
  document.getElementById('neighbors-close').addEventListener('click', closeNeighbors);
  document.getElementById('search-btn').addEventListener('click', openSearch);
  document.getElementById('search-close').addEventListener('click', closeSearch);
  document.getElementById('search-input').addEventListener('input', doSearch);
  document.getElementById('top-btn').addEventListener('click', openTop100);
  document.getElementById('top-close').addEventListener('click', closeTop100);
  document.getElementById('graph-btn').addEventListener('click', openGraph);
  document.getElementById('graph-close').addEventListener('click', closeGraph);
  document.getElementById('check-btn').addEventListener('click', () => { pollStart = Date.now(); });
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('welcome-close').addEventListener('click', dismissWelcome);
  document.getElementById('welcome-dismiss').addEventListener('click', dismissWelcome);
  window.addEventListener('resize', () => {
    const canvas = document.getElementById('graph-canvas');
    if (canvas && document.getElementById('graph-modal').className === 'modal-overlay show') {
      const datasets = entitiesData.filter(e => e && e.name).map(e => ({ name: e.name, history: e.point_history || [], current: e.points }));
      if (datasets.length > 0) drawSparkline(canvas, datasets);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      if (entitiesData.length <= 1) return;
      const dir = e.shiftKey ? -1 : 1;
      let next = (activeTab + dir + entitiesData.length) % entitiesData.length;
      let attempts = 0;
      while (entitiesData[next] && entitiesData[next].error && attempts < entitiesData.length) { next = (next + dir + entitiesData.length) % entitiesData.length; attempts++; }
      switchTab(next);
    }
    if ((e.key === 's' || e.key === 'S' || e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = e.target && e.target.tagName ? e.target.tagName : '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); openNeighbors(); }
    }
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey) {
      const tag = e.target && e.target.tagName ? e.target.tagName : '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); openSearch(); }
    }
    if ((e.key === 't' || e.key === 'T') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = e.target && e.target.tagName ? e.target.tagName : '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); openTop100(); }
    }
  });
});
