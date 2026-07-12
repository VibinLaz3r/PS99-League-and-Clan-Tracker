import asyncio, json, os, time
from datetime import datetime
from typing import Optional
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import httpx

API_BASE = 'https://ps99.biggamesapi.io'
POLL_INTERVAL = 45; MAX_TOTAL = 200000; SCAN_LIMIT = 10
CONFIG_FILE = 'config.json'; RANK_CACHE_FILE = 'rank_cache.json'; POINT_HISTORY_FILE = 'point_history.json'

@asynccontextmanager
async def lifespan(app):
    global http_client
    load_all(); http_client = httpx.AsyncClient(timeout=30.0)
    task = asyncio.create_task(poll_loop_safe())
    yield
    task.cancel(); await http_client.aclose()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])

config = {'mode': 'clan', 'tracked_names': ['POPS'], 'skipped_names': [], 'auto_switch_interval': 0, 'notify_overtake': True}
entities_data = []; active_tab = 0; rank_cache = {}; point_history = {}; last_ranks = {}
status_data = {'status': 'live', 'last_checked': '--:--', 'next_check': '0m 00s'}; poll_start = time.time(); http_client = None
leaderboard_cache = {'clan': [], 'league': [], 'time': 0}

def load_json(p, d):
    try:
        with open(p) as f: return json.load(f)
    except: return d
def save_json(p, d):
    try:
        with open(p, 'w') as f: json.dump(d, f)
    except: pass
def load_all():
    global config, rank_cache, point_history
    config = load_json(CONFIG_FILE, config); rank_cache = load_json(RANK_CACHE_FILE, {}); point_history = load_json(POINT_HISTORY_FILE, {})
def save_config(): save_json(CONFIG_FILE, config)
def save_rank_cache(): save_json(RANK_CACHE_FILE, rank_cache)
def save_point_history():
    now = time.time(); cutoff = now - 5400
    for k in list(point_history.keys()):
        point_history[k] = [e for e in point_history[k] if e['t'] >= cutoff]
        if not point_history[k]: del point_history[k]
    save_json(POINT_HISTORY_FILE, point_history)
def get_rate(ph_key):
    now = time.time(); cutoff = now - 600
    rows = [e for e in point_history.get(ph_key, []) if e['t'] >= cutoff]
    if len(rows) < 2: return 0
    first, last = rows[0], rows[-1]; elapsed = last['t'] - first['t']; gained = last['pts'] - first['pts']
    return gained / elapsed if elapsed >= 20 and gained > 0 else 0
def entry_name(e): return e.get('Name') or ''
def entry_pts(e): return e.get('ClanPoints') or e.get('Points') or 0
icon_cache = {}
async def resolve_icon(asset_id):
    if asset_id in icon_cache: return icon_cache[asset_id]
    try:
        r = await http_client.get(f'https://thumbnails.roblox.com/v1/assets?assetIds={asset_id}&size=420x420&format=Png&isCircular=false', timeout=5)
        data = r.json()
        if data.get('data') and len(data['data']) > 0 and data['data'][0].get('state') == 'Completed':
            url = data['data'][0]['imageUrl']
            icon_cache[asset_id] = url; return url
    except: pass
    icon_cache[asset_id] = ''; return ''
async def resolve_entry_icon(e):
    icon = e.get('Icon') or ''
    if not icon.startswith('rbxassetid://'): return icon
    return await resolve_icon(icon[14:])
def entry_icon(e):
    return e.get('Icon') or ''

async def fetch(url, retries=3):
    for attempt in range(retries):
        try:
            resp = await http_client.get(url); data = resp.json()
            if data and data.get('status') == 'ok': return data
            return None
        except:
            if attempt < retries - 1: await asyncio.sleep((attempt + 1) * 2)
    return None

async def fetch_clans_page(page, page_size=100):
    data = await fetch(f'{API_BASE}/api/clans?page={page}&pageSize={page_size}&sort=Points&sortOrder=desc')
    if data and isinstance(data.get('data'), list): return data['data']
    return None

async def fetch_leagues_page(page, page_size=25):
    data = await fetch(f'{API_BASE}/v1/leagues?pageSize={page_size}&pageNumber={page}')
    if data and isinstance(data.get('data'), dict) and isinstance(data['data'].get('leagues'), list):
        return data['data']['leagues']
    return None

async def binary_search(name, mode):
    lo, hi = 1, MAX_TOTAL; target = None; result_rank = None
    page_size = 100 if mode == 'clan' else 25
    for _ in range(SCAN_LIMIT):
        mid = (lo + hi) // 2
        entries = await (fetch_clans_page(mid, page_size) if mode == 'clan' else fetch_leagues_page(mid, page_size))
        if not entries: return None, None
        entries.sort(key=lambda x: -entry_pts(x))
        found = False
        for idx, entry in enumerate(entries):
            if entry_name(entry).lower() == name.lower():
                pts = entry_pts(entry); r = (mid - 1) * page_size + idx + 1
                if target is None: target = pts; result_rank = r
                if pts == target: result_rank = r; lo = min(hi, mid + 1)
                elif pts > target: hi = mid - 1
                else: lo = mid + 1
                found = True; break
        if not found:
            entry = entries[0]; pts = entry_pts(entry)
            if target is None: target = pts; result_rank = (mid - 1) * page_size + 1
            if pts > target: hi = mid - 1
            else: lo = mid + 1
    if result_rank is None: result_rank = mid
    return result_rank, target

async def get_leaderboard(mode):
    now = time.time()
    if now - leaderboard_cache['time'] < 60 and leaderboard_cache.get(mode):
        return leaderboard_cache[mode]
    entries = []
    if mode == 'clan':
        for pg in range(1, 11):
            page = await fetch_clans_page(pg, 100)
            if not page: break
            entries.extend(page)
        entries.sort(key=lambda x: -entry_pts(x))
    else:
        for pg in range(1, 21):
            page = await fetch_leagues_page(pg, 25)
            if not page: break
            entries.extend(page)
    leaderboard_cache[mode] = entries; leaderboard_cache['time'] = now
    return entries

def find_leaderboard_idx(lb, name):
    for i, e in enumerate(lb):
        if entry_name(e).lower() == name.lower(): return i
    return -1

def make_entry(n, p, r, typ, gp, **kw):
    d = {'rank': r, 'name': n, 'points': p, 'type': typ, 'gap': gp}; d.update(kw); return d

async def fetch_members(name):
    data = await fetch(f'{API_BASE}/v1/clans/{name}?pageSize=100&pageNumber=1')
    if data and isinstance(data.get('data'), dict) and 'members' in data['data']:
        return data['data']['members']
    return []

def format_time(s):
    if s < 60: return f'{int(s)}s'
    if s < 3600: return f'{int(s // 60)}m {int(s % 60)}s'
    return f'{int(s // 3600)}h {int((s % 3600) // 60)}m'

async def poll_loop_safe():
    await asyncio.sleep(2)
    while True:
        try:
            await poll_loop()
        except asyncio.CancelledError: break
        except Exception as e:
            print(f'Poll loop error: {e}'); await asyncio.sleep(30)

async def poll_loop():
    global entities_data, active_tab, status_data, poll_start
    poll_start = time.time(); status_data['status'] = 'fetching'
    try:
        with open('active_tab.txt') as f:
            c = f.read().strip()
            if c.isdigit(): active_tab = int(c)
    except: pass
    names = config['tracked_names']; mode = config['mode']
    new_data = []
    for i, name in enumerate(names):
        try:
            rank, points = await binary_search(name, mode)
            if rank is None:
                new_data.append({'name': name, 'error': f'Could not find {name}'})
                continue
            if points is None: points = 0
            cache_key = f'{mode}:{name}'.lower()
            rank_cache[cache_key] = {'rank': rank, 'points': points, 'time': time.time()}
            ph_key = f'{mode}:{name}'
            if ph_key not in point_history: point_history[ph_key] = []
            now = time.time()
            if not point_history[ph_key] or point_history[ph_key][-1]['pts'] != points:
                point_history[ph_key].append({'t': now, 'pts': points})
            point_history[ph_key] = [e for e in point_history[ph_key] if e['t'] >= now - 5400]
            rate = get_rate(ph_key)
            ic = ''
            ent = {'name': name, 'points': points, 'rank': rank, 'rate': rate, 'icon': ic,
                   'eta': f'~{format_time(1 / rate)} to next rank' if rate > 0 and rank > 1 else '',
                   'neighbors': [], 'members': [], 'entries': [], 'point_history': point_history.get(ph_key, [])}
            if i == active_tab:
                lb = await get_leaderboard(mode)
                idx = find_leaderboard_idx(lb, name)
                if idx >= 0:
                    op = entry_pts(lb[idx]); ic = await resolve_entry_icon(lb[idx]); ent['icon'] = ic; strip = []
                    if idx > 0:
                        e = lb[idx - 1]; strip.append(make_entry(entry_name(e), entry_pts(e), idx, 'above', entry_pts(e) - op))
                    strip.append(make_entry(name, op, idx + 1, 'self', 0, rate=rate, icon=ic))
                    if idx < len(lb) - 1:
                        e = lb[idx + 1]; strip.append(make_entry(entry_name(e), entry_pts(e), idx + 2, 'below', op - entry_pts(e)))
                    ent['entries'] = strip; nbrs = []
                    for j in range(max(0, idx - 5), min(len(lb), idx + 6)):
                        e = lb[j]; en = entry_name(e); ep = entry_pts(e)
                        if j == idx: t, g = 'self', 0
                        elif j < idx: t, g = 'above', ep - op
                        else: t, g = 'below', op - ep
                        nbrs.append({'rank': j + 1, 'name': en, 'points': ep, 'type': t, 'gap': g, 'icon': await resolve_entry_icon(e)})
                    ent['neighbors'] = nbrs
                    if mode == 'clan': ent['members'] = await fetch_members(name)
            new_data.append(ent)
        except Exception as e:
            new_data.append({'name': name, 'error': str(e)})
    entities_data = new_data
    status_data['status'] = 'live'; status_data['last_checked'] = datetime.now().strftime('%H:%M')
    save_rank_cache(); save_point_history()

class ConfigUpdate(BaseModel):
    mode: Optional[str] = None; tracked_names: Optional[list] = None
    skipped_names: Optional[list] = None; auto_switch_interval: Optional[int] = None; notify_overtake: Optional[bool] = None

@app.get('/api/status')
async def get_status():
    total = sum((e.get('points') or 0) for e in entities_data)
    elapsed = int(time.time() - poll_start)
    return {
        'status': status_data['status'], 'last_checked': status_data['last_checked'],
        'next_check': f'{max(0, POLL_INTERVAL - elapsed)}s', 'active_tab': active_tab,
        'total_points': total, 'entities': entities_data, 'mode': config['mode'],
        'tracked_names': config['tracked_names'], 'skipped_names': config['skipped_names'],
        'auto_switch_interval': config['auto_switch_interval'], 'notify_overtake': config['notify_overtake'],
    }

@app.get('/api/config')
async def get_config(): return config

@app.post('/api/config')
async def update_config(body: ConfigUpdate):
    global poll_start; changed = False
    if body.mode is not None and body.mode != config['mode']:
        config['mode'] = body.mode; rank_cache.clear(); save_rank_cache(); changed = True
    if body.tracked_names is not None: config['tracked_names'] = body.tracked_names; changed = True
    if body.skipped_names is not None: config['skipped_names'] = body.skipped_names
    if body.auto_switch_interval is not None: config['auto_switch_interval'] = body.auto_switch_interval
    if body.notify_overtake is not None: config['notify_overtake'] = body.notify_overtake
    if changed: save_config(); poll_start = 0
    return {'ok': True}

@app.get('/api/history/{mode}/{name}')
async def get_history(mode: str, name: str):
    return point_history.get(f'{mode}:{name}'.lower(), [])

@app.get('/api/detail/{mode}/{name}')
async def api_detail(mode: str, name: str):
    lb = await get_leaderboard(mode)
    idx = find_leaderboard_idx(lb, name)
    if idx < 0: raise HTTPException(404, 'Not found')
    op = entry_pts(lb[idx]); ic = await resolve_entry_icon(lb[idx]); neighbors = []
    for j in range(max(0, idx - 5), min(len(lb), idx + 6)):
        e = lb[j]; en = entry_name(e); ep = entry_pts(e)
        if j == idx: t, g = 'self', 0
        elif j < idx: t, g = 'above', ep - op
        else: t, g = 'below', op - ep
        neighbors.append({'rank': j + 1, 'name': en, 'points': ep, 'type': t, 'gap': g, 'icon': await resolve_entry_icon(e)})
    strip = []
    if idx > 0:
        e = lb[idx - 1]; strip.append(make_entry(entry_name(e), entry_pts(e), idx, 'above', entry_pts(e) - op, icon=await resolve_entry_icon(e)))
    strip.append(make_entry(name, op, idx + 1, 'self', 0, rate=get_rate(f'{mode}:{name}'.lower()), icon=ic))
    if idx < len(lb) - 1:
        e = lb[idx + 1]; strip.append(make_entry(entry_name(e), entry_pts(e), idx + 2, 'below', op - entry_pts(e), icon=await resolve_entry_icon(e)))
    result = {'neighbors': neighbors, 'entries': strip, 'members': []}
    if mode == 'clan': result['members'] = await fetch_members(name)
    return result

@app.get('/api/top/{mode}')
async def api_top(mode: str):
    lb = await get_leaderboard(mode)
    ics = {i: await resolve_entry_icon(e) for i, e in enumerate(lb[:100])}
    return {'entries': [{'rank': i + 1, 'name': entry_name(e), 'points': entry_pts(e), 'icon': ics[i]} for i, e in enumerate(lb[:100])]}

@app.get('/api/search/{mode}/{query}')
async def api_search(mode: str, query: str):
    q = query.lower()
    if mode == 'clan':
        page = await fetch_clans_page(1, 100)
        if page:
            page.sort(key=lambda x: -entry_pts(x))
            results = [{'rank': i + 1, 'name': entry_name(e), 'points': entry_pts(e), 'icon': await resolve_entry_icon(e)} for i, e in enumerate(page) if q in entry_name(e).lower()][:50]
            if results: return {'entries': results}
        seen = set(); results = []
        for pg in range(1, 21):
            page = await fetch_clans_page(pg, 100)
            if not page: break
            for e in page:
                en = entry_name(e)
                if en.lower() in seen: continue
                seen.add(en.lower())
                if q in en.lower():
                    results.append({'rank': 0, 'name': en, 'points': entry_pts(e), 'icon': await resolve_entry_icon(e)})
                    if len(results) >= 50: break
            if len(results) >= 50: break
        return {'entries': results}
    else:
        seen = set(); results = []
        for pg in range(1, 21):
            page = await fetch_leagues_page(pg, 25)
            if not page: break
            for i, e in enumerate(page):
                en = entry_name(e)
                if en.lower() in seen: continue
                seen.add(en.lower())
                if q in en.lower():
                    results.append({'rank': (pg - 1) * 25 + i + 1, 'name': en, 'points': entry_pts(e), 'icon': await resolve_entry_icon(e)})
                    if len(results) >= 50: break
            if len(results) >= 50: break
        return {'entries': results}
    return {'entries': []}

@app.post('/api/activetab')
async def set_active_tab(tab: int):
    global active_tab; active_tab = tab
    try:
        with open('active_tab.txt', 'w') as f: f.write(str(tab))
    except: pass
    return {'ok': True}

ssl_dir = os.path.join(os.path.dirname(__file__), 'static')
if os.path.isdir(ssl_dir):
    app.mount('/', StaticFiles(directory=ssl_dir, html=True), name='static')

if __name__ == '__main__':
    import uvicorn
    port = int(os.environ.get('PORT', 8080))
    uvicorn.run(app, host='0.0.0.0', port=port)
