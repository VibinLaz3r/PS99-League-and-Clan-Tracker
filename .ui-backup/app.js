// ===== CONFIG =====
const API_BASE = 'https://ps99.biggamesapi.io';
const LEAGUE_API_URL = `${API_BASE}/v1/leagues`;
const CLAN_API_URL = `${API_BASE}/v1/clans`;
const POLL_INTERVAL = 45;
const PAGE_SIZE = 25;
const MAX_TOTAL = 200000;
const SCAN_LIMIT = 10;

// ===== STATE =====
let entitiesData = [];
let activeTab = 0;
let currentMode = 'clan';
let autoSwitchInterval = 0;
let autoSwitchTimer = null;
let notificationTimer = null;
let pollTimer = null;
let pollStart = Date.now();
let wakeResolve = null;

// local key-value storage
let rankCache = {};
let pointHistory = {};
let lastRanks = {};
let trackedNames = { clan: ['POPS'], league: [] };

// ===== localStorage HELPERS =====
function lsGet(key, def) {
  try {
    const v = localStorage.getItem(key);
    return v !== null ? JSON.parse(v) : def;
  } catch { return def; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function saveSettings() {
  lsSet('tracked_names_clan', trackedNames.clan);
  lsSet('tracked_names_league', trackedNames.league);
  lsSet('api_mode', currentMode);
  lsSet('auto_switch', autoSwitchInterval);
  lsSet('notify_overtake', notifyOvertake);
  lsSet('auto_switch_skipped', skippedNames);
  lsSet('first_run', firstRun);
}
function loadSettings() {
  trackedNames.clan = lsGet('tracked_names_clan', ['POPS']);
  trackedNames.league = lsGet('tracked_names_league', []);
  currentMode = lsGet('api_mode', 'clan');
  autoSwitchInterval = lsGet('auto_switch', 0);
  notifyOvertake = lsGet('notify_overtake', true);
  skippedNames = lsGet('auto_switch_skipped', []);
  firstRun = lsGet('first_run', true);
}

// ===== RANK CACHE =====
function loadRankCache() { rankCache = lsGet('rankCache', {}); }
function saveRankCache() { lsSet('rankCache', rankCache); }
function getRankCache(name) { return rankCache[name.toLowerCase()]; }
function setRankCache(name, rank, points) {
  rankCache[name.toLowerCase()] = { rank, points, time: Date.now() / 1000 };
}
function clearRankCache() { rankCache = {}; }

// ===== POINT HISTORY =====
function loadPointHistory() { pointHistory = lsGet('pointHistory', {}); }
function savePointHistory() {
  const now = Date.now() / 1000;
  const cutoff = now - 5400;
  for (const k of Object.keys(pointHistory)) {
    pointHistory[k] = pointHistory[k].filter(e => e.t >= cutoff);
    if (pointHistory[k].length === 0) delete pointHistory[k];
  }
  lsSet('pointHistory', pointHistory);
}
function savePointSnapshot(key, name, pts) {
  const now = Date.now() / 1000;
  if (!pointHistory[key]) pointHistory[key] = [];
  pointHistory[key].push({ t: now, pts });
  const cutoff = now - 5400;
  pointHistory[key] = pointHistory[key].filter(e => e.t >= cutoff);
}
function getPointRate(key, minPeriod) {
  if (minPeriod === undefined) minPeriod = 20;
  const now = Date.now() / 1000;
  const cutoff = now - 600;
  const rows = (pointHistory[key] || []).filter(e => e.t >= cutoff).sort((a, b) => a.t - b.t);
  if (rows.length < 2) return 0;
  const first = rows[0], last = rows[rows.length - 1];
  const elapsed = last.t - first.t;
  if (elapsed < minPeriod) return 0;
  const gained = last.pts - first.pts;
  if (gained <= 0) return 0;
  return gained / elapsed;
}
function getIdleSeconds(key) {
  const rows = (pointHistory[key] || []).sort((a, b) => b.t - a.t);
  if (rows.length < 2) return null;
  const now = Date.now() / 1000;
  const recent = rows[0].pts;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].pts !== recent) return now - rows[i - 1].t;
  }
  return now - rows[rows.length - 1].t;
}
function getPointHistory(key, minutes) {
  if (minutes === undefined) minutes = 60;
  const cutoff = Date.now() / 1000 - minutes * 60;
  return (pointHistory[key] || []).filter(e => e.t >= cutoff).sort((a, b) => a.t - b.t);
}

// ===== ICON HELPERS =====
async function resolveIcon(el, icon) {
  if (!icon) { el.className = ''; el.src = ''; return; }
  if (!icon.startsWith('rbxassetid://')) { el.src = icon; el.className = 'show'; return; }
  try {
    const resp = await fetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${icon.substring(14)}&size=420x420&format=Png&isCircular=false`);
    const data = await resp.json();
    if (data.data && data.data[0] && data.data[0].imageUrl) {
      el.src = data.data[0].imageUrl; el.className = 'show'; return;
    }
  } catch {}
  el.className = ''; el.src = '';
}

// ===== NAME RESOLVERS =====
const _nameCache = {};
function resolveMemberName(uid, displayName) {
  if (displayName && displayName !== String(uid) && displayName !== '') return displayName;
  if (_nameCache[uid]) return _nameCache[uid];
}
async function resolveMemberNames(members) {
  const uncached = members.filter(m => !_nameCache[m.user_id] && (!m.display_name || m.display_name === String(m.user_id) || m.display_name === '')).map(m => m.user_id);
  if (uncached.length === 0) return;
  for (let i = 0; i < uncached.length; i += 100) {
    const batch = uncached.slice(i, i + 100);
    try {
      const resp = await fetch('https://users.roblox.com/v1/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }) });
      const data = await resp.json();
      if (data.data) {
        for (const entry of data.data) {
          _nameCache[entry.id] = entry.displayName || entry.name || String(entry.id);
        }
      }
    } catch {}
  }
  for (const m of members) {
    if (_nameCache[m.user_id]) m.display_name = _nameCache[m.user_id];
  }
}

// ===== API CLIENT =====
async function fetchWithRetry(url, params, retries) {
  if (retries === undefined) retries = 3;
  if (params) {
    const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    url += '?' + qs;
  }
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(url);
      const data = await resp.json();
      if (data && data.status === 'ok') return data;
      console.warn('API error for', url, data);
      return null;
    } catch (e) {
      if (attempt < retries - 1) {
        const wait = (attempt + 1) * 2;
        console.warn(`Retrying ${url} in ${wait}s (${attempt + 1}/${retries})`);
        await new Promise(r => setTimeout(r, wait * 1000));
      }
    }
  }
  return null;
}

async function fetchLegacyClansPage(page, pageSize) {
  if (pageSize === undefined) pageSize = 100;
  const data = await fetchWithRetry(`${API_BASE}/api/clans`, { page, pageSize, sort: 'Points', sortOrder: 'desc' });
  return data ? data.data || [] : [];
}

async function fetchLegacyClanDetail(name) {
  const data = await fetchWithRetry(`${API_BASE}/api/clan/${encodeURIComponent(name)}`);
  return data ? data.data : null;
}

async function fetchLeaderboardPage(page) {
  const data = await fetchWithRetry(LEAGUE_API_URL, { page, pageSize: PAGE_SIZE, sort: 'Points', sortOrder: 'desc' });
  return data ? (data.data ? data.data.leagues || [] : []) : [];
}

async function fetchLeagueDetail(name) {
  const data = await fetchWithRetry(`${API_BASE}/v1/leagues/${encodeURIComponent(name)}`);
  return data ? data.data : null;
}

async function fetchClanPlayers() {
  const data = await fetchWithRetry(`${CLAN_API_URL}/players`);
  return data ? data.data : null;
}

// ===== HELPERS =====
function fmtPts(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}
function fmtPtsFull(n) { return n.toLocaleString(); }
function fmtRate(rate) {
  const ppm = rate * 60;
  if (ppm >= 1_000_000) return (ppm / 1_000_000).toFixed(2) + 'M/min';
  if (ppm >= 1_000) return (ppm / 1_000).toFixed(1) + 'K/min';
  return ppm.toFixed(1) + '/min';
}
function fmtEta(gap, rate) {
  if (rate <= 0) return 'never';
  const secs = gap / rate;
  if (secs < 60) return Math.round(secs) + 's';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ' + Math.round(secs % 60) + 's';
  return Math.floor(secs / 3600) + 'h ' + Math.round((secs % 3600) / 60) + 'm';
}
function fmtIdle(secs) {
  if (secs === null || secs === undefined) return '';
  if (secs < 60) return Math.round(secs) + 's';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  return Math.floor(secs / 3600) + 'h ' + Math.floor((secs % 3600) / 60) + 'm';
}
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
function extractUid(owner) {
  if (owner && typeof owner === 'object') return owner.UserID || 0;
  if (typeof owner === 'number') return owner;
  return 0;
}

// ===== BINARY SEARCH =====
async function bsFind(name, pts, fetchPageFn, pageSize) {
  if (pageSize === undefined) pageSize = PAGE_SIZE;
  let lo = 1, hi = MAX_TOTAL;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const pg = Math.floor((mid - 1) / pageSize) + 1;
    const off = (mid - 1) % pageSize;
    const lgs = await fetchPageFn(pg);
    if (!lgs || off >= lgs.length) { hi = mid - 1; continue; }
    if ((lgs[off].Points || 0) > pts) { lo = mid + 1; }
    else { hi = mid - 1; }
  }
  let sp = Math.floor((lo - 1) / pageSize) + 1;
  for (let p = sp; p >= Math.max(1, sp - SCAN_LIMIT); p--) {
    const lgs = await fetchPageFn(p);
    for (let i = 0; i < lgs.length; i++) {
      if ((lgs[i].Name || '').toLowerCase() === name.toLowerCase()) {
        return { rank: (p - 1) * pageSize + i + 1, pageData: lgs };
      }
    }
  }
  for (let p = sp + 1; p <= sp + SCAN_LIMIT; p++) {
    const lgs = await fetchPageFn(p);
    for (let i = 0; i < lgs.length; i++) {
      if ((lgs[i].Name || '').toLowerCase() === name.toLowerCase()) {
        return { rank: (p - 1) * pageSize + i + 1, pageData: lgs };
      }
    }
  }
  return { rank: null, pageData: null };
}

// ===== NEIGHBORS =====
async function neighborsFromPage(rank, pageData, pageSize, fetchFn) {
  if (pageSize === undefined) pageSize = PAGE_SIZE;
  const off = (rank - 1) % pageSize;
  const pgNum = Math.floor((rank - 1) / pageSize) + 1;
  const ents = [];
  for (let i = Math.max(0, off - 5); i < Math.min(pageData.length, off + 6); i++) {
    const e = pageData[i];
    const r = rank - off + i;
    ents.push({ name: e.Name || '', points: e.Points || 0, rank: r, uid: extractUid(e.Owner) });
  }
  let aboveCount = ents.filter(e => e.rank < rank).length;
  if (aboveCount < 5 && fetchFn) {
    let needed = 5 - aboveCount;
    let prevPg = pgNum - 1;
    while (needed > 0 && prevPg >= 1) {
      const prevData = await fetchFn(prevPg);
      if (!prevData || prevData.length === 0) break;
      const take = Math.min(needed, prevData.length);
      for (let i = prevData.length - take; i < prevData.length; i++) {
        const e = prevData[i];
        const r = (prevPg - 1) * pageSize + i + 1;
        ents.unshift({ name: e.Name || '', points: e.Points || 0, rank: r, uid: extractUid(e.Owner) });
      }
      needed -= take;
      prevPg--;
    }
  }
  let belowCount = ents.filter(e => e.rank > rank).length;
  if (belowCount < 5 && fetchFn) {
    let needed = 5 - belowCount;
    let nextPg = pgNum + 1;
    while (needed > 0) {
      const nextData = await fetchFn(nextPg);
      if (!nextData || nextData.length === 0) break;
      const take = Math.min(needed, nextData.length);
      for (let i = 0; i < take; i++) {
        const e = nextData[i];
        const r = (nextPg - 1) * pageSize + i + 1;
        ents.push({ name: e.Name || '', points: e.Points || 0, rank: r, uid: extractUid(e.Owner) });
      }
      needed -= take;
      nextPg++;
    }
  }
  return ents;
}

// ===== ENTITY PAYLOAD =====
async function fetchMembersAsync(name, mode) {
  const result = [];
  if (mode === 'clan') {
    const detail = await fetchLegacyClanDetail(name);
    if (detail) {
      const battles = detail.Battles || {};
      let bestContribs = [];
      if (typeof battles === 'object') {
        for (const bkey of Object.keys(battles)) {
          const bdata = battles[bkey];
          if (bdata && typeof bdata === 'object') {
            const contribs = bdata.PointContributions || [];
            if (contribs.length > bestContribs.length) bestContribs = contribs;
          }
        }
      }
      const memberUids = new Set((detail.Members || []).map(m => Number(m.UserID)).filter(n => n > 0));
      const ptsMap = {};
      for (const c of bestContribs) {
        if (c && typeof c === 'object') {
          const uid = Number(c.UserID) || 0;
          if (uid && memberUids.has(uid)) ptsMap[uid] = (ptsMap[uid] || 0) + (c.Points || 0);
        }
      }
      for (const m of (detail.Members || [])) {
        const uid = Number(m.UserID) || 0;
        if (uid && !(uid in ptsMap)) ptsMap[uid] = 0;
      }
      if (Object.keys(ptsMap).length > 0) {
        for (const [uidStr, pts] of Object.entries(ptsMap)) {
          const uid = parseInt(uidStr);
          result.push({ display_name: String(uid), user_id: uid, points: pts });
        }
        result.sort((a, b) => b.points - a.points);
      } else {
        for (const m of (detail.Members || [])) {
          const uid = m.UserID || 0;
          result.push({ display_name: String(uid), user_id: uid, points: 0 });
        }
      }
    }
  } else {
    const data = await fetchLeagueDetail(name);
    if (data) {
      const rawMembers = data.Members || data.members || [];
      const members = Array.isArray(rawMembers) ? rawMembers : (typeof rawMembers === 'object' ? Object.values(rawMembers) : []);
      const rawContribs = data.PointContributions || data.pointContributions || [];
      const contribs = Array.isArray(rawContribs) ? rawContribs : (typeof rawContribs === 'object' ? Object.values(rawContribs) : []);
      const ptsMap = {};
      for (const c of contribs) {
        if (c && typeof c === 'object') {
          const uid = c.UserID || 0;
          if (uid) ptsMap[uid] = c.Points || 0;
        }
      }
      const seen = new Set();
      for (const m of members) {
        if (m && typeof m === 'object') {
          const uid = m.UserID || 0;
          if (uid && !seen.has(uid)) {
            seen.add(uid);
            const pts = ptsMap[uid] || 0;
            const dname = m.DisplayName || String(uid);
            result.push({ display_name: dname, user_id: uid, points: pts });
          }
        }
      }
      for (const c of contribs) {
        if (c && typeof c === 'object') {
          const uid = c.UserID || 0;
          if (uid && !seen.has(uid)) {
            seen.add(uid);
            result.push({ display_name: c.DisplayName || String(uid), user_id: uid, points: c.Points || 0 });
          }
        }
      }
    }
  }
  result.sort((a, b) => b.points - a.points);
  return result;
}

async function buildEntityPayload(name, mode, rank, points, iconUrl, allEntries, aboveRaw, belowRaw) {
  if (aboveRaw === undefined) {
    const idx = rank - 1;
    if (rank > 1500) { aboveRaw = []; belowRaw = []; }
    else {
      aboveRaw = allEntries ? allEntries.slice(Math.max(0, idx - 5), idx) : [];
      belowRaw = allEntries ? allEntries.slice(idx + 1, Math.min(idx + 6, allEntries.length)) : [];
    }
  }
  const key = `${mode}:${name}`;
  for (const c of [...aboveRaw, ...belowRaw]) {
    const cn = c.name || c.Name || '';
    const cp = c.points || c.Points || 0;
    savePointSnapshot(`${mode}:${cn}`, cn, cp);
  }
  savePointSnapshot(key, name, points);
  const ourRate = getPointRate(key);
  const ourIdle = getIdleSeconds(key);

  const entries = [];
  for (let i = 0; i < aboveRaw.length; i++) {
    const c = aboveRaw[i];
    const cn = c.name || c.Name || '';
    const cp = c.points || c.Points || 0;
    const crank = rank - aboveRaw.length + i;
    const cuid = extractUid(c.uid || c.Owner);
    const gap = cp - points;
    const rate = getPointRate(`${mode}:${cn}`);
    const idle = getIdleSeconds(`${mode}:${cn}`);
    entries.push({ rank: crank, name: cn, points: cp, type: 'above', gap, rate, idle, uid: cuid });
  }
  entries.push({ rank, name, points, type: 'self', gap: 0, rate: ourRate, idle: ourIdle, uid: 0 });
  for (let i = 0; i < belowRaw.length; i++) {
    const c = belowRaw[i];
    const cn = c.name || c.Name || '';
    const cp = c.points || c.Points || 0;
    const crank = rank + i + 1;
    const cuid = extractUid(c.uid || c.Owner);
    const gap = points - cp;
    const rate = getPointRate(`${mode}:${cn}`);
    const idle = getIdleSeconds(`${mode}:${cn}`);
    entries.push({ rank: crank, name: cn, points: cp, type: 'below', gap, rate, idle, uid: cuid });
  }

  let etaText = '';
  if (aboveRaw.length > 0) {
    const tgt = aboveRaw[aboveRaw.length - 1];
    const tgtName = tgt.name || tgt.Name || '';
    const tgtPts = tgt.points || tgt.Points || 0;
    const gap = tgtPts - points;
    if (gap > 0) {
      const theirRate = getPointRate(`${mode}:${tgtName}`);
      const net = ourRate - theirRate;
      if (net > 0) etaText = `Overtake ${tgtName.toUpperCase()} in ${fmtEta(gap, net)}`;
      else etaText = `${tgtName.toUpperCase()} pulling away`;
    }
  }

  const iconDataUrl = iconUrl || '';

  const rawMembers = await fetchMembersAsync(name, mode);
  await resolveMemberNames(rawMembers);
  const members = [];
  for (const m of rawMembers) {
    const mkey = `member:${m.user_id}`;
    savePointSnapshot(mkey, m.display_name, m.points);
    const mrate = getPointRate(mkey);
    members.push({ display_name: m.display_name, user_id: m.user_id, points: m.points, rate: mrate });
  }

  const aboveEnts = entries.filter(e => e.type === 'above');
  const belowEnts = entries.filter(e => e.type === 'below');
  const stripEntries = entries.filter(e => e.type === 'self');
  if (aboveEnts.length > 0) stripEntries.unshift(aboveEnts[aboveEnts.length - 1]);
  if (belowEnts.length > 0) stripEntries.push(belowEnts[0]);

  const history = getPointHistory(key, 60);
  return {
    name, mode, rank, points,
    icon: iconDataUrl, eta: etaText, idle: ourIdle,
    point_history: history,
    entries: stripEntries, neighbors: entries, members
  };
}

async function buildEntityBs(name, mode) {
  const now = Date.now() / 1000;
  const cached = getRankCache(name);
  const detail = mode === 'league' ? await fetchLeagueDetail(name) : await fetchLegacyClanDetail(name);
  if (!detail || !detail.Name) return { name, error: 'Not found' };
  const iconUrl = detail.Icon || '';
  const pageSize = mode === 'league' ? PAGE_SIZE : 100;
  const fetchFn = mode === 'league'
    ? fetchLeaderboardPage
    : (pg) => fetchLegacyClansPage(pg, 100);

  let pts = cached ? cached.points : 0;
  if (!cached) {
    const firstPage = await fetchFn(1);
    if (firstPage && firstPage.length > 0) pts = Math.floor((firstPage[0].Points || 0) / 2);
  }

  if (cached) {
    const rank = cached.rank;
    const pgNum = Math.floor((rank - 1) / pageSize) + 1;
    const pageData = await fetchFn(pgNum);
    if (pageData && pageData.length > 0) {
      const selfEntry = pageData.find(e => (e.Name || '').toLowerCase() === name.toLowerCase());
      if (selfEntry) {
        const actualPts = selfEntry.Points || 0;
        setRankCache(name, rank, actualPts);
        const neighbors = await neighborsFromPage(rank, pageData, pageSize, fetchFn);
        const aboveRaw = neighbors.filter(n => n.rank < rank);
        const belowRaw = neighbors.filter(n => n.rank > rank);
        return await buildEntityPayload(name, mode, rank, actualPts, iconUrl, undefined, aboveRaw, belowRaw);
      }
    }
  }

  const bf = await bsFind(name, pts, fetchFn, pageSize);
  if (bf.rank && bf.pageData) {
    const foundEntry = bf.pageData.find(e => (e.Name || '').toLowerCase() === name.toLowerCase());
    const actualPts = foundEntry ? (foundEntry.Points || 0) : 0;
    setRankCache(name, bf.rank, actualPts);
    const neighbors = await neighborsFromPage(bf.rank, bf.pageData, pageSize, fetchFn);
    const aboveRaw = neighbors.filter(n => n.rank < bf.rank);
    const belowRaw = neighbors.filter(n => n.rank > bf.rank);
    return await buildEntityPayload(name, mode, bf.rank, actualPts, iconUrl, undefined, aboveRaw, belowRaw);
  }

  for (let pg = 1; pg <= 100; pg++) {
    const pageData = await fetchFn(pg);
    if (!pageData || pageData.length === 0) break;
    const idx = pageData.findIndex(e => (e.Name || '').toLowerCase() === name.toLowerCase());
    if (idx >= 0) {
      const rank = (pg - 1) * pageSize + idx + 1;
      const actualPts = pageData[idx].Points || 0;
      setRankCache(name, rank, actualPts);
      const neighbors = await neighborsFromPage(rank, pageData, pageSize, fetchFn);
      const aboveRaw = neighbors.filter(n => n.rank < rank);
      const belowRaw = neighbors.filter(n => n.rank > rank);
      return await buildEntityPayload(name, mode, rank, actualPts, iconUrl, undefined, aboveRaw, belowRaw);
    }
  }
  return await buildEntityPayload(name, mode, 99999, 0, iconUrl);
}

// ===== POLL LOOP =====
async function pollLoop() {
  let wakePromise = null;

  async function loop() {
    while (true) {
      try {
        // Get names
        let names = [...(trackedNames[currentMode] || [])].filter(n => n);
        if (names.length === 0) {
          updateData({ error: 'No entities tracked. Open settings to add one.' });
          await sleep(POLL_INTERVAL);
          continue;
        }

        const nowStr = new Date().toLocaleTimeString();
        let entities = [];

        if (currentMode === 'clan') {
          // Fetch top 10 pages
          const tasks = [];
          for (let pg = 1; pg <= 10; pg++) {
            tasks.push(fetchLegacyClansPage(pg, 100));
          }
          const pagesData = await Promise.all(tasks);
          let allClans = [];
          for (const pd of pagesData) {
            if (!pd || pd.length === 0) break;
            allClans = allClans.concat(pd);
            if (pd.length < 100) break;
          }
          if (allClans.length === 0) {
            updateData({ error: 'No data from API' });
            await sleep(POLL_INTERVAL);
            continue;
          }
          allClans.sort((a, b) => (b.Points || 0) - (a.Points || 0));
          const topList = allClans.map((c, i) => ({
            name: c.Name || '', points: c.Points || 0,
            rank: i + 1, icon: c.Icon || '', uid: extractUid(c.Owner)
          }));

          // Build entities
          const entityPromises = names.map(async (n) => {
            const entry = topList.find(c => c.name.toLowerCase() === n.toLowerCase());
            if (entry) {
              return await buildEntityPayload(n, currentMode, entry.rank, entry.points, entry.icon, topList);
            }
            return await buildEntityBs(n, currentMode);
          });
          entities = await Promise.all(entityPromises);
        } else {
          const entityPromises = names.map(n => buildEntityBs(n, currentMode));
          entities = await Promise.all(entityPromises);
        }

        // Overtake detection
        let notification = null;
        if (notifyOvertake) {
          for (const ent of entities) {
            if (ent && ent.rank !== undefined && !ent.error) {
              const key = (ent.name || '').toLowerCase();
              const prev = lastRanks[key];
              lastRanks[key] = ent.rank;
              if (prev !== undefined) {
                if (ent.rank < prev) notification = { type: 'overtake', name: ent.name, old_rank: prev, new_rank: ent.rank };
                else if (ent.rank > prev) notification = { type: 'overtaken', name: ent.name, old_rank: prev, new_rank: ent.rank };
              }
            }
          }
        }

        const pushData = { entities, active_tab: activeTab, mode: currentMode, last_checked: nowStr };
        if (notification) pushData.notification = notification;
        if (skippedNames && skippedNames.length > 0) pushData.skipped_names = skippedNames;
        updateData(pushData);
        saveRankCache();
        savePointHistory();
      } catch (e) {
        console.error('Poll error:', e);
        // Don't crash the loop
      }

      // Sleep with wake support
      await sleep(POLL_INTERVAL);
    }
  }

  loop();
}

function sleep(seconds) {
  return new Promise(resolve => {
    if (wakeResolve) wakeResolve();
    wakeResolve = resolve;
    setTimeout(resolve, seconds * 1000);
  });
}

function wakePoll() {
  if (wakeResolve) wakeResolve();
}

// ===== SETTINGS =====
let notifyOvertake = true;
let skippedNames = [];

function getSettings() {
  return {
    names: trackedNames[currentMode] || [],
    mode: currentMode,
    active_tab: activeTab,
    auto_switch: autoSwitchInterval,
    notify_overtake: notifyOvertake,
    skipped_names: skippedNames,
    minimize_to_tray: false
  };
}

async function saveSettings(names, mode, autoSwitch, notify, skip) {
  names = names.map(n => n.trim()).filter(n => n);
  if (names.length === 0) return;
  const oldMode = currentMode;
  const wipe = oldMode !== mode;
  trackedNames[mode] = names;
  currentMode = mode;
  autoSwitchInterval = autoSwitch || 0;
  notifyOvertake = notify !== undefined ? notify : true;
  skippedNames = skip || [];
  if (wipe) clearRankCache();
  saveSettings();
  activeTab = 0;
  wakePoll();
}

function dismissFirstRun(dontShow) {
  firstRun = !dontShow;
  lsSet('first_run', firstRun);
}

// ===== RENDERING =====
let firstRun = true;

function updateData(data) {
  if (data.mode) currentMode = data.mode;

  if (data.last_checked) {
    document.getElementById('last-checked').textContent = data.last_checked;
  }

  const badge = document.getElementById('status-badge');
  if (data.error) {
    badge.className = 'status-badge error';
    badge.innerHTML = '<span class="status-dot">●</span> ' + data.error;
    document.getElementById('entities-container').className = '';
  } else if (data.entities) {
    badge.className = 'status-badge live';
    badge.innerHTML = '<span class="status-dot">●</span> Live';
  }

  if (data.entities) {
    entitiesData = data.entities;
    window._skippedNames = data.skipped_names || [];
    renderTabBar();
    renderActiveEntity();

    if (data.notification) {
      const n = data.notification;
      if (n.type === 'overtake') {
        showNotification(n.name + ' overtook to #' + n.new_rank, 'overtake');
      } else if (n.type === 'overtaken') {
        showNotification(n.name + ' dropped to #' + n.new_rank + ' (was #' + n.old_rank + ')', 'overtaken');
      }
    }
    if (document.getElementById('graph-modal').className === 'modal-overlay show') {
      const canvas = document.getElementById('graph-canvas');
      const datasets = [];
      for (const ent of entitiesData) {
        if (ent && ent.name) {
          datasets.push({ name: ent.name, history: ent.point_history || [], current: ent.points });
        }
      }
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

function switchTab(idx) {
  activeTab = idx;
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.className = 'tab-btn' + (i === idx ? ' active' : '');
  });
  renderActiveEntity();
  setActiveTab(idx);
  if (autoSwitchTimer) { clearInterval(autoSwitchTimer); autoSwitchTimer = null; }
  if (autoSwitchInterval > 0 && entitiesData.length > 1) {
    autoSwitchTimer = setInterval(() => {
      if (entitiesData.length === 0) return;
      const next = (activeTab + 1) % entitiesData.length;
      switchTab(next);
    }, 10000);
  }
}

function setActiveTab(idx) {
  activeTab = idx;
}

function renderActiveEntity() {
  const ent = entitiesData[activeTab];
  if (!ent) {
    document.getElementById('entities-container').className = '';
    return;
  }
  document.getElementById('entities-container').className = 'show';

  if (ent.error) {
    document.getElementById('title').textContent = (ent.name || '').toUpperCase() + '  (' + (currentMode === 'clan' ? 'CLANS' : 'LEAGUES') + ')';
    document.getElementById('total-pts').textContent = '0';
    document.getElementById('eta').textContent = '';
    document.getElementById('strip-container').className = '';
    document.getElementById('card-list').innerHTML = '<div style="text-align:center;color:#f87171;padding:30px 0;">' + ent.error + '</div>';
    return;
  }

  const modeLabel = currentMode === 'clan' ? 'Clans' : 'Leagues';
  document.getElementById('title').textContent = ent.name + '  (' + modeLabel + ')';
  document.getElementById('total-pts').textContent = Number(ent.points).toLocaleString();
  document.getElementById('eta').textContent = ent.eta || '';

  const iconEl = document.getElementById('icon');
  resolveIcon(iconEl, ent.icon);

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
      if (e.rate > 0) {
        subHtml = '<div class="card-sub green">' + fmtRate(e.rate) + '</div>';
      } else if (e.idle !== null && e.idle !== undefined) {
        subHtml = '<div class="card-sub dim">idle ' + fmtIdle(e.idle) + '</div>';
      } else {
        subHtml = '<div class="card-sub dim">idle</div>';
      }
    } else {
      let parts = [];
      if (e.gap) {
        parts.push('<span>' + (e.type === 'above' ? '+' : '-') + fmtPts(e.gap) + '</span>');
      }
      if (e.rate > 0) {
        parts.push('<span class="card-sub green">' + fmtRate(e.rate) + '</span>');
      }
      subHtml = parts.length ? '<div class="card-sub dim">' + parts.join(' ') + '</div>' : '';
    }
    card.innerHTML = '<div class="rank-pill">' + (e.rank >= 99999 ? '?' : e.rank) + '</div>'
      + '<div class="card-info"><div class="card-name">' + esc(typeof e.name === 'string' ? e.name : String(e.name)) + '</div></div>'
      + '<div class="card-right"><div class="card-pts">' + Number(e.points).toLocaleString() + '</div>'
      + subHtml + '</div>';
    strip.appendChild(card);
  }
  document.getElementById('strip-container').className = 'show';

  // Members
  const list = document.getElementById('card-list');
  list.innerHTML = '';
  const members = ent.members || [];
  if (members.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#6a6690;padding:30px 0;">No members found.</div>';
    return;
  }
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const card = document.createElement('div');
    card.className = 'member-card';
    card.innerHTML = `
      <div class="member-rank-num">${i + 1}</div>
      <div class="member-info">
        <div class="member-name">${esc(m.display_name || String(m.user_id))}</div>
        <div class="member-uid">${m.user_id}</div>
      </div>
      <div class="member-right">
        <div class="member-pts">${Number(m.points).toLocaleString()}</div>
        <div class="member-rate${m.rate > 0 ? ' green' : ' dim'}">${m.rate > 0 ? fmtRate(m.rate) : 'idle'}</div>
      </div>`;
    list.appendChild(card);
  }

  // Countdown bar
  const elapsed = (Date.now() - pollStart) / 1000;
  const pct = Math.min(100, (elapsed / POLL_INTERVAL) * 100);
  document.getElementById('countdown-bar').style.width = pct + '%';
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
  if (audioEl) {
    audioEl.currentTime = 0;
    audioEl.play().catch(() => {});
    return;
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch(e) {}
}

function openNeighbors() {
  const modal = document.getElementById('neighbors-modal');
  const list = document.getElementById('neighbors-list');
  list.innerHTML = '<div style="text-align:center;color:#6a6690;padding:30px 0;">Loading...</div>';
  modal.className = 'modal-overlay show';
  const nd = window._neighborsData || [];
  list.innerHTML = '';
  if (nd.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:#6a6690;padding:30px 0;">No data.</div>';
    return;
  }
  for (const e of nd) {
    const row = document.createElement('div');
    row.className = 'member-row';
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => { closeNeighbors(); openCardDetail(e.name); });
    const rEl = document.createElement('div');
    rEl.className = 'member-rank';
    if (e.type === 'self') rEl.classList.add('tracked');
    rEl.textContent = '#' + e.rank;
    row.appendChild(rEl);
    const info = document.createElement('div');
    info.className = 'member-info';
    const nEl = document.createElement('div');
    nEl.className = 'name';
    if (e.type === 'self') nEl.classList.add('tracked');
    nEl.textContent = e.name;
    info.appendChild(nEl);
    row.appendChild(info);
    const right = document.createElement('div');
    right.className = 'member-right';
    const rateEl = document.createElement('div');
    rateEl.className = 'member-rate';
    rateEl.textContent = e.rate > 0 ? fmtRate(e.rate) : 'idle';
    rateEl.style.color = e.rate > 0 ? '#4ade80' : '#6a6690';
    right.appendChild(rateEl);
    if (e.gap !== undefined) {
      const gEl = document.createElement('div');
      gEl.className = 'member-gap';
      gEl.textContent = e.type === 'self' ? '0' : (e.type === 'above' ? '+' : '-') + fmtPts(e.gap);
      right.appendChild(gEl);
    }
    const pEl = document.createElement('div');
    pEl.className = 'member-pts';
    pEl.textContent = Number(e.points).toLocaleString();
    right.appendChild(pEl);
    if (e.idle !== null && e.idle !== undefined) {
      const iEl = document.createElement('div');
      iEl.className = 'member-idle';
      iEl.textContent = fmtIdle(e.idle);
      iEl.style.color = '#6a6690';
      right.appendChild(iEl);
    }
    row.appendChild(right);
    list.appendChild(row);
  }
}
function closeNeighbors() {
  document.getElementById('neighbors-modal').className = 'modal-overlay';
}

async function openCardDetail(name) {
  const modal = document.getElementById('detail-modal');
  const title = document.getElementById('detail-title');
  const neighborsEl = document.getElementById('detail-neighbors');
  const membersEl = document.getElementById('detail-members');
  title.textContent = name.toUpperCase();
  neighborsEl.innerHTML = '<div style="text-align:center;color:#6a6690;padding:20px 0;">Loading...</div>';
  membersEl.innerHTML = '';
  modal.className = 'modal-overlay show';

  try {
    const data = await getCardData(name, currentMode);
    neighborsEl.innerHTML = '';
    membersEl.innerHTML = '';
    if (data.neighbors && data.neighbors.length > 0) {
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
    if (data.members && data.members.length > 0) {
      for (const m of data.members) {
        const row = document.createElement('div');
        row.className = 'member-row';
        const info = document.createElement('div');
        info.className = 'member-info';
        const nameEl = document.createElement('div');
        nameEl.className = 'name';
        nameEl.textContent = m.display_name || String(m.user_id);
        info.appendChild(nameEl);
        row.appendChild(info);
        const right = document.createElement('div');
        right.className = 'member-right';
        const pts = document.createElement('div');
        pts.className = 'member-pts';
        pts.textContent = Number(m.points).toLocaleString();
        right.appendChild(pts);
        row.appendChild(right);
        membersEl.appendChild(row);
      }
    } else {
      membersEl.innerHTML = '<div style="text-align:center;color:#6a6690;padding:10px 0;">No members.</div>';
    }
  } catch (e) {
    neighborsEl.innerHTML = '<div style="text-align:center;color:#f87171;padding:20px 0;">Error loading data.</div>';
  }
}
function closeDetail() {
  document.getElementById('detail-modal').className = 'modal-overlay';
}

async function getCardData(cardName, cardMode) {
  const result = { neighbors: [], members: [] };
  const entries = [];

  try {
    if (cardMode === 'clan') {
      const tasks = [];
      for (let pg = 1; pg <= 10; pg++) tasks.push(fetchLegacyClansPage(pg, 100));
      const pagesData = await Promise.all(tasks);
      let allClans = [];
      for (const pd of pagesData) {
        if (!pd || pd.length === 0) break;
        allClans = allClans.concat(pd);
        if (pd.length < 100) break;
      }
      if (allClans.length === 0) return result;
      allClans.sort((a, b) => (b.Points || 0) - (a.Points || 0));
      const top = allClans.map((c, i) => ({ name: c.Name || '', points: c.Points || 0, rank: i + 1, uid: extractUid(c.Owner) }));
      const entry = top.find(c => c.name.toLowerCase() === cardName.toLowerCase());
      if (!entry) {
        const detail = await fetchLegacyClanDetail(cardName);
        if (!detail || !detail.Name) return result;
        const bf = await bsFind(cardName, 0, (pg) => fetchLegacyClansPage(pg, 100), 100);
        if (bf.rank && bf.pageData) {
          const selfEntry = bf.pageData.find(e => (e.Name || '').toLowerCase() === cardName.toLowerCase());
          const actualPts = selfEntry ? (selfEntry.Points || 0) : 0;
          const ns = await neighborsFromPage(bf.rank, bf.pageData, 100, (pg) => fetchLegacyClansPage(pg, 100));
          for (const n of ns) {
            const typ = n.name.toLowerCase() === cardName.toLowerCase() ? 'self' : n.rank < bf.rank ? 'above' : 'below';
            const gap = typ === 'self' ? 0 : Math.abs(n.points - actualPts);
            entries.push({ rank: n.rank, name: n.name, points: n.points, type: typ, gap, uid: n.uid });
          }
          if (entries.length === 0) entries.push({ rank: 0, name: cardName, points: actualPts, type: 'self', gap: 0, uid: 0 });
        } else {
          entries.push({ rank: 0, name: cardName, points: 0, type: 'self', gap: 0, uid: 0 });
        }
        result.neighbors = entries;
        const raw = await fetchMembersAsync(cardName, cardMode);
        await resolveMemberNames(raw);
        for (const r of raw) result.members.push(r);
        return result;
      }
      const idx = entry.rank - 1;
      const above = top.slice(Math.max(0, idx - 5), idx);
      const below = top.slice(idx + 1, Math.min(idx + 6, top.length));
      for (const c of above) {
        entries.push({ rank: c.rank, name: c.name, points: c.points, type: 'above', gap: c.points - entry.points, uid: c.uid });
      }
      entries.push({ rank: entry.rank, name: cardName, points: entry.points, type: 'self', gap: 0, uid: entry.uid });
      for (const c of below) {
        entries.push({ rank: c.rank, name: c.name, points: c.points, type: 'below', gap: entry.points - c.points, uid: c.uid });
      }
    } else {
      const detail = await fetchLeagueDetail(cardName);
      if (!detail || !detail.Name) return result;
      const bf = await bsFind(cardName, 0, fetchLeaderboardPage, PAGE_SIZE);
      if (bf.rank && bf.pageData) {
        const selfEntry = bf.pageData.find(e => (e.Name || '').toLowerCase() === cardName.toLowerCase());
        const actualPts = selfEntry ? (selfEntry.Points || 0) : 0;
        const ns = await neighborsFromPage(bf.rank, bf.pageData, PAGE_SIZE, fetchLeaderboardPage);
        for (const n of ns) {
          const typ = n.name.toLowerCase() === cardName.toLowerCase() ? 'self' : n.rank < bf.rank ? 'above' : 'below';
          const gap = typ === 'self' ? 0 : (typ === 'above' ? n.points - actualPts : actualPts - n.points);
          entries.push({ rank: n.rank, name: n.name, points: n.points, type: typ, gap, uid: n.uid });
        }
        if (entries.length === 0) entries.push({ rank: 0, name: cardName, points: actualPts, type: 'self', gap: 0, uid: 0 });
      } else {
        entries.push({ rank: 0, name: cardName, points: 0, type: 'self', gap: 0, uid: 0 });
      }
    }
    result.neighbors = entries;
    const raw = await fetchMembersAsync(cardName, cardMode);
    await resolveMemberNames(raw);
    for (const r of raw) result.members.push(r);
  } catch (e) {
    console.error('getCardData error:', e);
  }
  return result;
}

function openSearch() {
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
  document.getElementById('search-modal').className = 'modal-overlay show';
  document.getElementById('search-input').focus();
}
function closeSearch() {
  document.getElementById('search-modal').className = 'modal-overlay';
}

let searchTimer = null;
function doSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = document.getElementById('search-input').value.trim();
    if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
    const resultsEl = document.getElementById('search-results');
    resultsEl.innerHTML = '<div style="text-align:center;color:#6a6690;padding:20px 0;">Searching...</div>';
    try {
      const data = await searchClan(q, currentMode);
      resultsEl.innerHTML = '';
      if (data.entries && data.entries.length > 0) {
        for (const e of data.entries) {
          const row = document.createElement('div');
          row.className = 'member-row';
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => {
            closeSearch();
            // Navigate to entity or show detail
            openCardDetail(e.name);
          });
          row.innerHTML = '<div class="member-rank">' + (e.rank > 0 ? '#' + e.rank : '?') + '</div>'
            + '<div class="member-info"><div class="name">' + esc(e.name) + '</div></div>'
            + '<div class="member-right"><div class="member-pts">' + Number(e.points).toLocaleString() + '</div></div>';
          resultsEl.appendChild(row);
        }
      } else {
        resultsEl.innerHTML = '<div style="text-align:center;color:#6a6690;padding:20px 0;">No results.</div>';
      }
    } catch (e) {
      resultsEl.innerHTML = '<div style="text-align:center;color:#f87171;padding:20px 0;">Error searching.</div>';
    }
  }, 300);
}

async function searchClan(query, mode) {
  const q = query.toLowerCase();
  const results = [];

  if (mode === 'clan') {
    for (let page = 1; page <= 20; page++) {
      const pageData = await fetchLegacyClansPage(page, 100);
      if (!pageData || pageData.length === 0) break;
      for (let i = 0; i < pageData.length; i++) {
        const c = pageData[i];
        if ((c.Name || '').toLowerCase().includes(q)) {
          results.push({ rank: (page - 1) * 100 + i + 1, name: c.Name || '', points: c.Points || 0 });
        }
      }
    }
    if (results.length > 0) { results.sort((a, b) => b.points - a.points); return { mode, entries: results.slice(0, 50) }; }
    return { mode, entries: [] };
  } else {
    const seenNames = new Set();
    for (let page = 1; page <= 60; page++) {
      const pageData = await fetchLeaderboardPage(page);
      if (!Array.isArray(pageData) || pageData.length === 0) break;
      for (let i = 0; i < pageData.length; i++) {
        const name = pageData[i].Name || '';
        if (seenNames.has(name.toLowerCase())) continue;
        seenNames.add(name.toLowerCase());
        if (name.toLowerCase().includes(q)) {
          results.push({ rank: (page - 1) * 25 + i + 1, name, points: pageData[i].Points || 0 });
        }
      }
    }
    if (results.length > 0) { results.sort((a, b) => b.points - a.points); return { mode, entries: results.slice(0, 50) }; }
    const detail = await fetchLeagueDetail(query.trim());
    if (detail && detail.Name) return { mode, entries: [{ rank: 0, name: detail.Name, points: detail.Points || 0 }] };
    return { mode, entries: [] };
  }
}

function openTop100() {
  const modal = document.getElementById('top-modal');
  const list = document.getElementById('top-list');
  list.innerHTML = '<div style="text-align:center;color:#6a6690;padding:30px 0;">Loading...</div>';
  modal.className = 'modal-overlay show';
  fetchTop100();
}
function closeTop100() {
  document.getElementById('top-modal').className = 'modal-overlay';
}

async function fetchTop100() {
  const list = document.getElementById('top-list');
  try {
    let results = [];
    if (currentMode === 'clan') {
      const allClans = await fetchLegacyClansPage(1, 100);
      if (allClans) {
        allClans.sort((a, b) => (b.Points || 0) - (a.Points || 0));
        results = allClans.slice(0, 100).map((c, i) => ({ rank: i + 1, name: c.Name || '', points: c.Points || 0 }));
      }
    } else {
      let allLeagues = [];
      for (let page = 1; page <= 4; page++) {
        const pageData = await fetchLeaderboardPage(page);
        if (Array.isArray(pageData)) {
          allLeagues = allLeagues.concat(pageData);
          if (pageData.length < 25) break;
        }
      }
      results = allLeagues.slice(0, 100).map((lg, i) => ({ rank: i + 1, name: lg.Name || '', points: lg.Points || 0 }));
    }
    list.innerHTML = '';
    for (const e of results) {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => { closeTop100(); openCardDetail(e.name); });
      row.innerHTML = '<div class="member-rank">#' + e.rank + '</div>'
        + '<div class="member-info"><div class="name">' + esc(e.name) + '</div></div>'
        + '<div class="member-right"><div class="member-pts">' + Number(e.points).toLocaleString() + '</div></div>';
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = '<div style="text-align:center;color:#f87171;padding:20px 0;">Error loading top 100.</div>';
  }
}

function openGraph() {
  const modal = document.getElementById('graph-modal');
  const title = document.getElementById('graph-title');
  const ent = entitiesData[activeTab];
  title.textContent = ent && ent.name ? ent.name + ' - Points (60 min)' : 'Points';
  modal.className = 'modal-overlay show';
  setTimeout(() => {
    const canvas = document.getElementById('graph-canvas');
    const datasets = [];
    for (const e of entitiesData) {
      if (e && e.name) {
        datasets.push({ name: e.name, history: e.point_history || [], current: e.points });
      }
    }
    if (datasets.length > 0) drawSparkline(canvas, datasets);
  }, 100);
}
function closeGraph() {
  document.getElementById('graph-modal').className = 'modal-overlay';
}

function drawSparkline(canvas, datasets) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);

  const colors = ['#4ade80', '#7c5cff', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899'];
  const pad = { top: 15, bottom: 20, left: 10, right: 10 };
  const gw = w - pad.left - pad.right;
  const gh = h - pad.top - pad.bottom;

  // Collect all points
  let allMin = Infinity, allMax = -Infinity;
  for (const ds of datasets) {
    for (const pt of ds.history) {
      if (pt.pts < allMin) allMin = pt.pts;
      if (pt.pts > allMax) allMax = pt.pts;
    }
  }
  // Include current
  for (const ds of datasets) {
    if (ds.current < allMin) allMin = ds.current;
    if (ds.current > allMax) allMax = ds.current;
  }

  if (!isFinite(allMin) || !isFinite(allMax) || allMin === allMax) {
    ctx.fillStyle = '#6a6690';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', w / 2, h / 2);
    return;
  }

  if (allMax === allMin) allMax = allMin + 1;

  const range = allMax - allMin;
  const yScale = gh / range;

  // Grid lines
  ctx.strokeStyle = '#1e1b3a';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + gh * (i / 4);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(w - pad.right, y);
    ctx.stroke();
    const val = allMax - range * (i / 4);
    ctx.fillStyle = '#6a6690';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(fmtPts(Math.round(val)), pad.left - 4, y + 3);
  }

  // Datasets
  for (let di = 0; di < datasets.length; di++) {
    const ds = datasets[di];
    const pts = ds.history;
    if (pts.length < 2) continue;
    const sorted = pts.slice().sort((a, b) => a.t - b.t);
    const tMin = sorted[0].t, tMax = sorted[sorted.length - 1].t;
    const tRange = tMax - tMin || 1;

    ctx.strokeStyle = colors[di % colors.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < sorted.length; i++) {
      const x = pad.left + ((sorted[i].t - tMin) / tRange) * gw;
      const y = pad.top + gh - (sorted[i].pts - allMin) * yScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Current points dot
  for (let di = 0; di < datasets.length; di++) {
    const ds = datasets[di];
    if (ds.current === undefined) continue;
    const pts = ds.history;
    if (pts.length === 0) continue;
    const sorted = pts.slice().sort((a, b) => a.t - b.t);
    const tMin = sorted[0].t, tMax = sorted[sorted.length - 1].t;
    const tRange = tMax - tMin || 1;
    const x = pad.left + ((Date.now() / 1000 - tMin) / tRange) * gw;
    const xClamped = Math.min(x, w - pad.right);
    const y = pad.top + gh - (ds.current - allMin) * yScale;
    ctx.fillStyle = colors[di % colors.length];
    ctx.beginPath();
    ctx.arc(Math.min(xClamped, w - pad.right - 5), y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Settings modal
function openSettings() {
  const modal = document.getElementById('settings-modal');
  const namesList = document.getElementById('settings-names-list');
  const modeSelect = document.getElementById('settings-mode');
  const autoSwitchInput = document.getElementById('settings-auto-switch');
  const notifyCheck = document.getElementById('settings-notify-overtake');

  const names = trackedNames[currentMode] || [currentMode === 'clan' ? 'POPS' : ''];
  modeSelect.value = currentMode;

  namesList.innerHTML = '';
  for (let i = 0; i < names.length; i++) {
    const row = createNameRow(names[i], i, skippedNames.includes(names[i].toUpperCase()));
    namesList.appendChild(row);
  }
  // Add an empty row
  namesList.appendChild(createNameRow('', names.length, false));

  autoSwitchInput.value = autoSwitchInterval;
  notifyCheck.checked = notifyOvertake;

  modal.className = 'modal-overlay show';
  document.getElementById('settings-feedback').textContent = '';
}

function createNameRow(name, idx, isSkipped) {
  const row = document.createElement('div');
  row.className = 'settings-name-row';
  row.draggable = true;
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'settings-toggle';
  cb.checked = !isSkipped;
  cb.title = 'Include in auto-switch cycle';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'settings-name-input';
  inp.placeholder = 'e.g. CLAN NAME';
  inp.value = name;
  inp.style.textTransform = 'uppercase';
  const del = document.createElement('button');
  del.className = 'settings-remove-btn';
  del.textContent = '×';
  del.addEventListener('click', () => {
    if (row.parentElement && row.parentElement.children.length > 2) {
      row.remove();
    }
  });
  row.appendChild(cb);
  row.appendChild(inp);
  row.appendChild(del);

  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', Array.from(row.parentElement.children).indexOf(row));
    row.style.opacity = '0.4';
  });
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
    if (from < targetIdx) {
      parent.insertBefore(fromRow, row.nextSibling);
    } else {
      parent.insertBefore(fromRow, row);
    }
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
  const names = [];
  const skip = [];
  inputs.forEach((inp, i) => {
    const v = inp.value.trim().toUpperCase();
    if (v) {
      names.push(v);
      if (toggles[i] && !toggles[i].checked) skip.push(v);
    }
  });

  if (names.length === 0) {
    feedback.textContent = 'Add at least one name.';
    feedback.style.color = '#f87171';
    return;
  }

  const newMode = modeSelect.value;
  saveSettings(names, newMode, parseInt(autoSwitchInput.value) || 0, notifyCheck.checked, skip);
  feedback.textContent = 'Settings saved!';
  feedback.style.color = '#4ade80';
}

function closeSettings() {
  document.getElementById('settings-modal').className = 'modal-overlay';
}

function dismissWelcome() {
  const cb = document.getElementById('welcome-checkbox');
  dismissFirstRun(cb ? cb.checked : false);
  document.getElementById('welcome-modal').className = 'modal-overlay';
}

// Welcome popup
function showWelcome() {
  if (firstRun) {
    document.getElementById('welcome-modal').className = 'modal-overlay show';
  }
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadRankCache();
  loadPointHistory();
  startAutoSwitch();

  // Welcome
  showWelcome();

  // Start poll loop
  pollLoop();

  // Countdown bar update
  setInterval(() => {
    const elapsed = (Date.now() - pollStart) / 1000;
    const pct = Math.min(100, (elapsed / POLL_INTERVAL) * 100);
    document.getElementById('countdown-bar').style.width = pct + '%';
  }, 1000);

  // Event listeners
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

  document.getElementById('check-btn').addEventListener('click', wakePoll);

  document.getElementById('detail-close').addEventListener('click', closeDetail);

  document.getElementById('welcome-close').addEventListener('click', dismissWelcome);
  document.getElementById('welcome-dismiss').addEventListener('click', dismissWelcome);

  const addRowBtn = document.getElementById('settings-add-row');
  if (addRowBtn) {
    addRowBtn.addEventListener('click', () => {
      const list = document.getElementById('settings-names-list');
      list.appendChild(createNameRow('', list.children.length, false));
    });
  }

  // Resize handler for graph canvas
  window.addEventListener('resize', () => {
    const canvas = document.getElementById('graph-canvas');
    if (canvas && document.getElementById('graph-modal').className === 'modal-overlay show') {
      const datasets = [];
      for (const ent of entitiesData) {
        if (ent && ent.name) {
          datasets.push({ name: ent.name, history: ent.point_history || [], current: ent.points });
        }
      }
      if (datasets.length > 0) drawSparkline(canvas, datasets);
    }
  });

  // Hotkeys
  document.addEventListener('keydown', (e) => {
    // Ctrl+Tab / Ctrl+Shift+Tab
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      if (entitiesData.length <= 1) return;
      const dir = e.shiftKey ? -1 : 1;
      let next = (activeTab + dir + entitiesData.length) % entitiesData.length;
      // Skip errored entities
      let attempts = 0;
      while (entitiesData[next] && entitiesData[next].error && attempts < entitiesData.length) {
        next = (next + dir + entitiesData.length) % entitiesData.length;
        attempts++;
      }
      switchTab(next);
    }
    // S / N for neighbors
    if (e.key === 's' || e.key === 'S' || e.key === 'n' || e.key === 'N') {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = e.target && e.target.tagName ? e.target.tagName : '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          openNeighbors();
        }
      }
    }
    // F for search
    if (e.key === 'f' || e.key === 'F') {
      if (!e.ctrlKey && !e.metaKey) {
        const tag = e.target && e.target.tagName ? e.target.tagName : '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          openSearch();
        }
      }
    }
    // T for top 100
    if (e.key === 't' || e.key === 'T') {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = e.target && e.target.tagName ? e.target.tagName : '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          openTop100();
        }
      }
    }
  });
});

function startAutoSwitch() {
  if (autoSwitchTimer) { clearInterval(autoSwitchTimer); autoSwitchTimer = null; }
  if (autoSwitchInterval > 0 && entitiesData.length > 1) {
    const skipped = window._skippedNames || [];
    const active = entitiesData.filter(e => e && e.name && !skipped.includes(e.name.toUpperCase()));
    if (active.length < 2) return;
    autoSwitchTimer = setInterval(() => {
      if (entitiesData.length === 0) return;
      const skipped2 = window._skippedNames || [];
      const active2 = entitiesData.filter(e => e && e.name && !skipped2.includes(e.name.toUpperCase()));
      if (active2.length < 2) return;
      const curIdx = active2.findIndex(e => e.name && e.name.toUpperCase() === ((entitiesData[activeTab] && entitiesData[activeTab].name) || '').toUpperCase());
      const next = active2[(curIdx + 1) % active2.length];
      const realIdx = entitiesData.findIndex(e => e && e.name && e.name.toUpperCase() === next.name.toUpperCase());
      if (realIdx >= 0) switchTab(realIdx);
    }, autoSwitchInterval * 1000);
  }
}
