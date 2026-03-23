const http = require('http');
const fs   = require('fs');
const https = require('https');

const GIST_TOKEN = process.env.GIST_TOKEN || '';
const GIST_ID    = process.env.GIST_ID    || '';

let DB = {
    players: {},
    bans: {},
    stats: { totalRegistered: 0, totalSessions: 0, dailyActive: {}, firstSeenDates: [] }
};

function fixDB() {
    if (!DB.players) DB.players = {};
    if (!DB.bans)    DB.bans    = {};
    if (!DB.stats)   DB.stats   = { totalRegistered: 0, totalSessions: 0, dailyActive: {}, firstSeenDates: [] };
}

function loadLocalDB() {
    try {
        const d = JSON.parse(fs.readFileSync('/tmp/payback3_db.json', 'utf8'));
        if (d && typeof d === 'object') { DB = { ...DB, ...d }; fixDB(); }
        console.log('✓ local DB loaded, players:' + Object.keys(DB.players).length);
    } catch(e) {}
}

function loadDB() {
    if (!GIST_TOKEN || !GIST_ID) { loadLocalDB(); return Promise.resolve(); }
    return new Promise(resolve => {
        const req = https.request({
            hostname: 'api.github.com',
            path: `/gists/${GIST_ID}`,
            method: 'GET',
            headers: { 'Authorization': 'token ' + GIST_TOKEN, 'User-Agent': 'payback3-game', 'Accept': 'application/vnd.github.v3+json' }
        }, res => {
            let s = ''; res.on('data', c => s += c);
            res.on('end', () => {
                try {
                    const gist = JSON.parse(s);
                    const content = gist.files && gist.files['payback3_db.json'] && gist.files['payback3_db.json'].content;
                    if (content) { const d = JSON.parse(content); if (d && typeof d === 'object') { DB = { ...DB, ...d }; fixDB(); } console.log('✅ Gist DB loaded'); }
                } catch(e) { loadLocalDB(); }
                resolve();
            });
        });
        req.on('error', () => { loadLocalDB(); resolve(); });
        req.end();
    });
}

let _saveTimer = null;
function saveDB() {
    try { fs.writeFileSync('/tmp/payback3_db.json', JSON.stringify(DB)); } catch(e) {}
    if (!GIST_TOKEN || !GIST_ID) return;
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
        const payload = JSON.stringify(DB);
        const gistBody = JSON.stringify({ files: { 'payback3_db.json': { content: payload } } });
        const req = https.request({
            hostname: 'api.github.com', path: `/gists/${GIST_ID}`, method: 'PATCH',
            headers: { 'Authorization': 'token ' + GIST_TOKEN, 'User-Agent': 'payback3-game', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(gistBody) }
        }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => { if (res.statusCode === 200) console.log('✅ Gist saved'); else console.error('❌ Gist error:', res.statusCode); }); });
        req.on('error', e => console.error('❌ Gist request error:', e.message));
        req.write(gistBody); req.end();
    }, 3000);
}

// In-memory state
const online    = {};   // userId -> { id, name, color, gang, ts, map, x, y, z, ry, hp, inCar, carX, carY, carZ, carRy, score }
const positions = {};   // userId -> latest position
const rooms     = {};   // roomId -> { id, mode, map, players:[], scores:{}, flags:{}, status, ts }

const H = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};
const reply = (res, code, data) => { res.writeHead(code, H); res.end(JSON.stringify(data)); };
const body  = req => new Promise(ok => { let s = ''; req.on('data', c => s += c); req.on('end', () => { try { ok(JSON.parse(s)); } catch { ok({}); } }); });

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, H); return res.end(); }
    const url   = new URL('http://x' + req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // ── PING ──
    if (req.method === 'GET' && parts[0] === 'ping')
        return reply(res, 200, { ok: true, players: Object.keys(DB.players).length, online: Object.keys(online).length, storage: (GIST_TOKEN && GIST_ID) ? 'gist' : 'local' });

    // ── REGISTER / LOGIN ──
    if (req.method === 'POST' && parts[0] === 'auth') {
        const d = await body(req);
        const { name, password, action } = d;
        if (!name || !password) return reply(res, 400, { error: 'Заполни все поля' });
        if (name.length < 3 || name.length > 16) return reply(res, 400, { error: 'Ник 3–16 символов' });

        const key = name.toLowerCase();
        if (DB.bans[key]) return reply(res, 403, { error: 'Забанен: ' + DB.bans[key].reason });

        if (action === 'register') {
            if (DB.players[key]) return reply(res, 400, { error: 'Ник занят' });
            const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            DB.players[key] = {
                id, name, password, key,
                color: d.color || '#FF4400',
                gang: d.gang  || 'none',
                kills: 0, deaths: 0, wins: 0, races: 0, cash: 500,
                level: 1, xp: 0,
                inventory: [],
                ts: Date.now()
            };
            DB.stats.totalRegistered = Object.keys(DB.players).length;
            saveDB();
            const p = { ...DB.players[key] }; delete p.password;
            return reply(res, 200, { ok: true, player: p });
        }

        if (action === 'login') {
            const p = DB.players[key];
            if (!p) return reply(res, 404, { error: 'Игрок не найден' });
            if (p.password !== password) return reply(res, 401, { error: 'Неверный пароль' });
            p.ts = Date.now();
            saveDB();
            const safe = { ...p }; delete safe.password;
            // Stats
            const today = new Date().toISOString().slice(0, 10);
            DB.stats.dailyActive[today] = (DB.stats.dailyActive[today] || 0) + 1;
            DB.stats.totalSessions = (DB.stats.totalSessions || 0) + 1;
            saveDB();
            return reply(res, 200, { ok: true, player: safe });
        }

        return reply(res, 400, { error: 'Неизвестное действие' });
    }

    // ── GET PLAYER ──
    if (req.method === 'GET' && parts[0] === 'players' && parts[1]) {
        const p = Object.values(DB.players).find(p => p.id === parts[1]);
        if (!p) return reply(res, 404, { error: 'not found' });
        const safe = { ...p }; delete safe.password;
        return reply(res, 200, safe);
    }

    // ── SAVE PLAYER STATS ──
    if (req.method === 'PATCH' && parts[0] === 'players' && parts[1]) {
        const d = await body(req);
        const p = Object.values(DB.players).find(p => p.id === parts[1]);
        if (!p) return reply(res, 404, { error: 'not found' });
        // Only safe fields can be patched
        const allowed = ['kills', 'deaths', 'wins', 'races', 'cash', 'level', 'xp', 'color', 'gang', 'inventory'];
        allowed.forEach(k => { if (d[k] !== undefined) p[k] = d[k]; });
        p.ts = Date.now();
        saveDB();
        return reply(res, 200, { ok: true });
    }

    // ── LEADERBOARD ──
    if (req.method === 'GET' && parts[0] === 'leaderboard') {
        const mode = url.searchParams.get('mode') || 'kills';
        const sortKey = ['kills','wins','cash','level'].includes(mode) ? mode : 'kills';
        const top = Object.values(DB.players)
            .filter(p => p.name)
            .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0))
            .slice(0, 50)
            .map(p => ({ id: p.id, name: p.name, color: p.color, gang: p.gang, kills: p.kills || 0, deaths: p.deaths || 0, wins: p.wins || 0, races: p.races || 0, cash: p.cash || 0, level: p.level || 1 }));
        return reply(res, 200, top);
    }

    // ── ONLINE PLAYERS ──
    if (req.method === 'POST' && parts[0] === 'online' && parts[1]) {
        const d = await body(req);
        online[parts[1]] = { ...d, id: parts[1], ts: Date.now() };
        return reply(res, 200, { ok: true });
    }
    if (req.method === 'GET' && parts[0] === 'online') {
        const now = Date.now();
        return reply(res, 200, Object.values(online).filter(p => now - (p.ts || 0) < 10000));
    }
    if (req.method === 'DELETE' && parts[0] === 'online' && parts[1]) {
        delete online[parts[1]]; delete positions[parts[1]];
        return reply(res, 200, { ok: true });
    }

    // ── POSITIONS (HTTP fallback) ──
    if (req.method === 'GET' && parts[0] === 'pos') {
        const map = url.searchParams.get('map') || 'city';
        const now = Date.now();
        return reply(res, 200, Object.values(positions).filter(p => String(p.map) === map && now - (p.ts || 0) < 8000));
    }

    // ── ROOMS (matchmaking) ──
    if (req.method === 'GET' && parts[0] === 'rooms') {
        return reply(res, 200, Object.values(rooms).filter(r => r.status === 'waiting' || r.status === 'playing'));
    }
    if (req.method === 'POST' && parts[0] === 'rooms') {
        const d = await body(req);
        const id = 'room_' + Date.now();
        rooms[id] = {
            id, mode: d.mode || 'free', map: d.map || 'city',
            name: d.name || 'Комната ' + Object.keys(rooms).length,
            maxPlayers: d.maxPlayers || 8,
            players: [], scores: {}, flags: {}, kills: {},
            status: 'waiting', host: d.hostId, ts: Date.now()
        };
        return reply(res, 200, { ok: true, room: rooms[id] });
    }
    if (req.method === 'POST' && parts[0] === 'rooms' && parts[2] === 'join') {
        const d = await body(req);
        const room = rooms[parts[1]];
        if (!room) return reply(res, 404, { error: 'Комната не найдена' });
        if (room.players.length >= room.maxPlayers) return reply(res, 400, { error: 'Комната полна' });
        if (!room.players.includes(d.playerId)) room.players.push(d.playerId);
        return reply(res, 200, { ok: true, room });
    }
    if (req.method === 'DELETE' && parts[0] === 'rooms' && parts[1]) {
        delete rooms[parts[1]];
        return reply(res, 200, { ok: true });
    }

    // ── STATS ──
    if (req.method === 'GET' && parts[0] === 'stats') {
        DB.stats.totalRegistered = Object.keys(DB.players).length;
        return reply(res, 200, { ...DB.stats, onlineNow: Object.keys(online).length });
    }

    // ── BANS ──
    if (req.method === 'GET' && parts[0] === 'bans')
        return reply(res, 200, Object.values(DB.bans));
    if (req.method === 'POST' && parts[0] === 'bans') {
        const d = await body(req);
        if (d.adminKey !== 'payback3_admin') return reply(res, 403, { error: 'forbidden' });
        const key = (d.name || '').toLowerCase();
        DB.bans[key] = { name: d.name, reason: d.reason || 'Нарушение', by: d.by || 'Admin', date: new Date().toLocaleDateString('ru') };
        saveDB(); return reply(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && parts[0] === 'bans' && parts[1]) {
        const d = await body(req);
        if (d.adminKey !== 'payback3_admin') return reply(res, 403, { error: 'forbidden' });
        delete DB.bans[parts[1].toLowerCase()]; saveDB(); return reply(res, 200, { ok: true });
    }
    if (req.method === 'GET' && parts[0] === 'checkban' && parts[1]) {
        const ban = DB.bans[decodeURIComponent(parts[1]).toLowerCase()];
        return ban ? reply(res, 200, { banned: true, ...ban }) : reply(res, 200, { banned: false });
    }

    reply(res, 404, { error: 'not found' });
});

// ══════════════════════════════════════
// WebSocket — позиции + события игры
// ══════════════════════════════════════
const wsClients = new Map();

function wsHandshake(req, socket) {
    const key = req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    const accept = require('crypto').createHash('sha1').update(key).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
}
function wsRead(data) {
    try {
        const masked = (data[1] & 0x80) !== 0;
        let len = data[1] & 0x7f, offset = 2;
        if (len === 126) { len = (data[2] << 8) | data[3]; offset = 4; }
        const mask = masked ? data.slice(offset, offset + 4) : null; offset += masked ? 4 : 0;
        const payload = Buffer.alloc(len);
        for (let i = 0; i < len; i++) payload[i] = masked ? data[offset + i] ^ mask[i % 4] : data[offset + i];
        return JSON.parse(payload.toString());
    } catch(e) { return null; }
}
function wsWrite(socket, data) {
    try {
        const payload = Buffer.from(JSON.stringify(data));
        const len = payload.length;
        const header = len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
        socket.write(Buffer.concat([header, payload]));
    } catch(e) {}
}
function broadcast(map, msg, exceptId) {
    wsClients.forEach(c => { if (String(c.map) === String(map) && String(c.userId) !== String(exceptId)) wsWrite(c.socket, msg); });
}
function broadcastRoom(roomId, msg, exceptId) {
    wsClients.forEach(c => { if (c.roomId === roomId && String(c.userId) !== String(exceptId)) wsWrite(c.socket, msg); });
}

server.on('upgrade', (req, socket) => {
    wsHandshake(req, socket);
    const cid = Math.random().toString(36).slice(2);
    const client = { socket, map: 'city', userId: null, name: '', roomId: null };
    wsClients.set(cid, client);
    let buf = Buffer.alloc(0);

    socket.on('data', chunk => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
            const opcode = buf[0] & 0x0f;
            if (opcode === 0x8) { wsClients.delete(cid); return; }
            let len = buf[1] & 0x7f, frameLen = 2 + (buf[1] & 0x80 ? 4 : 0) + len;
            if (len === 126) { len = (buf[2] << 8) | buf[3]; frameLen = 4 + (buf[1] & 0x80 ? 4 : 0) + len; }
            if (buf.length < frameLen) break;
            const frame = buf.slice(0, frameLen); buf = buf.slice(frameLen);
            const msg = wsRead(frame);
            if (!msg) continue;

            // ── JOIN ──
            if (msg.type === 'join') {
                client.userId = msg.id; client.map = msg.map || 'city'; client.name = (msg.name || '').toLowerCase();
                online[msg.id] = { id: msg.id, name: msg.name, color: msg.color, gang: msg.gang, map: msg.map, ts: Date.now(), hp: 100 };
                // Send existing players to newcomer
                Object.values(positions).forEach(p => {
                    if (String(p.id) !== String(msg.id) && String(p.map) === String(msg.map)) wsWrite(socket, p);
                });
                broadcast(msg.map, { type: 'player_join', id: msg.id, name: msg.name, color: msg.color, gang: msg.gang }, msg.id);
            }

            // ── MOVE (player on foot) ──
            if (msg.type === 'move') {
                client.map = msg.map;
                positions[msg.id] = { ...msg, ts: Date.now() };
                if (online[msg.id]) { online[msg.id].x = msg.x; online[msg.id].y = msg.y; online[msg.id].z = msg.z; online[msg.id].ts = Date.now(); }
                broadcast(msg.map, msg, msg.id);
            }

            // ── CAR MOVE ──
            if (msg.type === 'car_move') {
                positions[msg.id] = { ...msg, ts: Date.now() };
                broadcast(msg.map, msg, msg.id);
            }

            // ── SHOOT ──
            if (msg.type === 'shoot') {
                broadcast(msg.map, msg, msg.id);
            }

            // ── HIT (damage dealt) ──
            if (msg.type === 'hit') {
                // Forward hit to target
                wsClients.forEach(c => {
                    if (String(c.userId) === String(msg.targetId)) wsWrite(c.socket, msg);
                });
                broadcast(msg.map, { type: 'hit_fx', x: msg.x, y: msg.y, z: msg.z }, null);
            }

            // ── KILL ──
            if (msg.type === 'kill') {
                broadcast(msg.map, { type: 'kill_feed', killer: msg.killerName, victim: msg.victimName, weapon: msg.weapon }, null);
                // Update stats
                const kp = Object.values(DB.players).find(p => p.id === msg.killerId);
                const vp = Object.values(DB.players).find(p => p.id === msg.victimId);
                if (kp) { kp.kills = (kp.kills || 0) + 1; kp.xp = (kp.xp || 0) + 25; }
                if (vp) { vp.deaths = (vp.deaths || 0) + 1; }
                saveDB();
            }

            // ── EXPLOSION ──
            if (msg.type === 'explosion') {
                broadcast(msg.map, msg, msg.id);
            }

            // ── ROOM EVENTS ──
            if (msg.type === 'room_join') {
                client.roomId = msg.roomId;
                broadcastRoom(msg.roomId, { type: 'room_player_join', id: msg.id, name: msg.name }, msg.id);
            }
            if (msg.type === 'room_score') {
                const room = rooms[msg.roomId];
                if (room) {
                    room.scores[msg.id] = (room.scores[msg.id] || 0) + (msg.points || 1);
                    broadcastRoom(msg.roomId, { type: 'room_scores', scores: room.scores }, null);
                }
            }
            if (msg.type === 'flag_grab') {
                broadcast(msg.map, { type: 'flag_grabbed', by: msg.name, gang: msg.gang, flagId: msg.flagId }, null);
            }
            if (msg.type === 'flag_score') {
                broadcast(msg.map, { type: 'flag_scored', by: msg.name, gang: msg.gang }, null);
            }
            if (msg.type === 'race_finish') {
                broadcast(msg.map, { type: 'race_result', id: msg.id, name: msg.name, time: msg.time, place: msg.place }, null);
                const rp = Object.values(DB.players).find(p => p.id === msg.id);
                if (rp) { if (msg.place === 1) rp.wins = (rp.wins || 0) + 1; rp.races = (rp.races || 0) + 1; rp.xp = (rp.xp || 0) + Math.max(10, 50 - msg.place * 5); saveDB(); }
            }

            // ── CHAT ──
            if (msg.type === 'chat') {
                const safe = msg.text.slice(0, 120).replace(/</g, '&lt;');
                broadcast(msg.map, { type: 'chat', id: msg.id, name: msg.name, color: msg.color, gang: msg.gang, text: safe }, null);
            }

            // ── LEAVE ──
            if (msg.type === 'leave') {
                delete positions[msg.id]; delete online[msg.id];
                broadcast(msg.map, { type: 'player_leave', id: msg.id }, msg.id);
            }
        }
    });

    socket.on('close', () => {
        if (client.userId) {
            delete positions[client.userId]; delete online[client.userId];
            broadcast(client.map, { type: 'player_leave', id: client.userId }, client.userId);
        }
        wsClients.delete(cid);
    });
    socket.on('error', () => {
        if (client.userId) { delete positions[client.userId]; delete online[client.userId]; }
        wsClients.delete(cid);
    });
});

loadDB().then(() => {
    server.listen(process.env.PORT || 3000, () => {
        console.log('🚗 Payback 3 backend running');
        const SELF = process.env.RENDER_EXTERNAL_URL || '';
        if (SELF) {
            setInterval(() => {
                https.get(SELF + '/ping', () => {}).on('error', e => console.log('ping err:', e.message));
            }, 10 * 60 * 1000);
        }
    });
});
