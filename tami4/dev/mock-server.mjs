/**
 * Local mock of /tami4/api for development. Node built-ins only.
 * Not part of the control page. GitHub Pages publishes the repository
 * root, so this file is only a downloadable script and is not linked.
 *
 *   node tami4/dev/mock-server.mjs
 *
 * Serves this repository and the API on 127.0.0.1:$PORT (default 4173).
 * POST /__mock changes dev state. It is not part of the water-bar API.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4173;

const WRITABLE_BOOLS = new Set([
    'lightning',
    'childLock',
    'nightMode',
    'energySaveMode',
    'smartHeatingMode',
    'buttonsSound',
    'pushAndDrink',
]);

const DRINKS = [
    { id: 'tea', name: 'Tea', volume_ml: 200, temperature_c: 80, vessel: 'cup' },
    { id: 'coffee', name: 'Coffee', volume_ml: 150, temperature_c: 90, vessel: 'mug' },
    { id: 'formula', name: 'Formula', volume_ml: 120, temperature_c: 37, vessel: 'bottle' },
];

function freshConfig() {
    return {
        lightning: true,
        childLock: false,
        nightMode: false,
        energySaveMode: true,
        smartHeatingMode: true,
        buttonsSound: true,
        pushAndDrink: false,
        connectivityEnabled: true,
        boilingTemp: 95,
        languageSetting: 1,
        wifiName: 'home',
    };
}

const FORCED = {
    unauthorized: [401, { error: 'unauthorized' }],
    forbidden: [403, { error: 'forbidden' }],
    bad_origin: [403, { error: 'bad_origin' }],
    offline: [503, { error: 'offline' }],
    access_not_configured: [503, { error: 'access_not_configured' }],
    tami4_auth_failed: [502, { error: 'tami4_auth_failed' }],
    tami4_unavailable: [502, { error: 'tami4_unavailable' }],
};

const state = {
    mode: 'normal',
    force: null,
    boiling: false,
    connected: true,
    config: freshConfig(),
    lastStartedAt: null,
    lastConfigPost: null,
};

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.pem': 'application/x-pem-file',
};

function reset() {
    state.mode = 'normal';
    state.force = null;
    state.boiling = false;
    state.connected = true;
    state.config = freshConfig();
    state.lastStartedAt = null;
    state.lastConfigPost = null;
}

function publicState() {
    return {
        mode: state.mode,
        force: state.force,
        boiling: state.boiling,
        connected: state.connected,
        config: { ...state.config },
        lastStartedAt: state.lastStartedAt,
        lastConfigPost: state.lastConfigPost,
    };
}

function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > 65536) {
                reject(Object.assign(new Error('too large'), { code: 'too_large' }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function isJsonContentType(value) {
    if (!value) return false;
    return value.split(';')[0].trim().toLowerCase() === 'application/json';
}

function blocked(res) {
    if (state.force) {
        send(res, state.force.status, state.force.body);
        return true;
    }
    const forced = FORCED[state.mode];
    if (forced) {
        send(res, forced[0], forced[1]);
        return true;
    }
    return false;
}

function statusBody() {
    return {
        device: {
            name: 'Tami4 Edge+',
            connected: state.connected,
            firmware: '1.4.2',
        },
        filter: {
            upcoming_replacement: '2027-05-21T00:00:00Z',
            milli_litters_passed: 842000,
        },
        uv: {
            upcoming_replacement: '2027-11-02T00:00:00Z',
        },
        fetched_at: new Date().toISOString(),
    };
}

function validateSetting(key, value) {
    if (key === 'connectivityEnabled') {
        return { error: 'unsafe_configuration', detail: 'connectivityEnabled cannot be changed' };
    }
    if (key === 'wifiName') {
        return { error: 'read_only', detail: 'wifiName is read-only' };
    }
    if (key === 'languageSetting') {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            return { error: 'invalid_type', detail: 'languageSetting has the wrong type' };
        }
        return null;
    }
    if (!WRITABLE_BOOLS.has(key) && key !== 'boilingTemp') {
        return { error: 'unknown_key', detail: `${key} is unknown` };
    }
    if (WRITABLE_BOOLS.has(key)) {
        if (typeof value !== 'boolean') return { error: 'invalid_type', detail: `${key} has the wrong type` };
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: 'invalid_type', detail: 'boilingTemp has the wrong type' };
    }
    if (!Number.isInteger(value) || value < 70 || value > 100) {
        return { error: 'out_of_range', detail: 'boilingTemp must be an integer from 70 to 100' };
    }
    return null;
}

async function handleConfig(req, res, raw) {
    const contentType = req.headers['content-type'] || '';
    if (!isJsonContentType(contentType)) {
        state.lastConfigPost = { contentType, body: null };
        send(res, 400, {
            ok: false,
            error: 'invalid_body',
            detail: 'Content-Type must be application/json',
        });
        return;
    }
    let patch;
    try {
        patch = raw ? JSON.parse(raw) : null;
    } catch (err) {
        state.lastConfigPost = { contentType, body: null };
        send(res, 400, { ok: false, error: 'invalid_body' });
        return;
    }
    state.lastConfigPost = { contentType, body: patch };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        send(res, 400, { ok: false, error: 'invalid_body' });
        return;
    }
    const keys = Object.keys(patch);
    if (keys.length === 0) {
        send(res, 400, { ok: false, error: 'empty' });
        return;
    }
    for (const key of keys) {
        const problem = validateSetting(key, patch[key]);
        if (problem) {
            send(res, 400, { ok: false, ...problem });
            return;
        }
    }
    const next = { ...state.config };
    for (const key of keys) next[key] = patch[key];
    state.config = next;
    send(res, 200, { ok: true, config: { ...state.config } });
}

async function handleBoil(req, res) {
    if (state.boiling) {
        send(res, 409, { ok: false, error: 'already_boiling' });
        return;
    }
    const started = new Date().toISOString();
    state.boiling = true;
    state.lastStartedAt = started;
    send(res, 200, { ok: true, started_at: started });
}

async function handleMake(req, res, id) {
    const drink = DRINKS.find((item) => String(item.id) === id);
    if (!drink) {
        send(res, 404, { error: 'unknown_drink' });
        return;
    }
    const started = new Date().toISOString();
    state.lastStartedAt = started;
    send(res, 200, { ok: true, started_at: started });
}

async function handleControl(req, res) {
    let body;
    try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
    } catch (err) {
        send(res, 400, { error: 'invalid_body' });
        return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        send(res, 400, { error: 'invalid_body' });
        return;
    }
    if (body.reset === true) reset();
    if (typeof body.mode === 'string') {
        if (body.mode !== 'normal' && !Object.hasOwn(FORCED, body.mode)) {
            send(res, 400, { error: 'unknown_mode' });
            return;
        }
        state.mode = body.mode;
        state.force = null;
    }
    if (typeof body.boiling === 'boolean') state.boiling = body.boiling;
    if (typeof body.connected === 'boolean') state.connected = body.connected;
    if (body.force === null) state.force = null;
    if (body.force && typeof body.force === 'object' && !Array.isArray(body.force)) {
        state.force = {
            status: Number(body.force.status),
            body: body.force.body,
        };
    }
    send(res, 200, publicState());
}

async function handleApi(req, res, pathname) {
    const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    if (blocked(res)) return;
    if (req.method === 'GET' && pathname === '/tami4/api/status') {
        send(res, 200, statusBody());
        return;
    }
    if (req.method === 'GET' && pathname === '/tami4/api/drinks') {
        send(res, 200, { drinks: DRINKS });
        return;
    }
    if (req.method === 'GET' && pathname === '/tami4/api/config') {
        send(res, 200, { config: { ...state.config } });
        return;
    }
    if (req.method === 'POST' && pathname === '/tami4/api/boil') {
        await handleBoil(req, res);
        return;
    }
    if (req.method === 'POST' && pathname === '/tami4/api/config') {
        await handleConfig(req, res, raw);
        return;
    }
    const make = /^\/tami4\/api\/drinks\/([^/]+)\/make$/.exec(pathname);
    if (req.method === 'POST' && make) {
        await handleMake(req, res, decodeURIComponent(make[1]));
        return;
    }
    send(res, 404, { error: 'not_found' });
}

async function locate(pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.includes('\0')) return null;
    const slash = rel.endsWith('/');
    rel = rel.replace(/^\/+/, '').replace(/\/+$/, '');
    const rootReal = await fs.realpath(ROOT);
    const full = path.resolve(rootReal, rel);
    if (full !== rootReal && !full.startsWith(rootReal + path.sep)) return null;
    let stat;
    try {
        stat = await fs.stat(full);
    } catch (err) {
        return null;
    }
    if (stat.isDirectory()) {
        return { kind: 'dir', slash, path: full };
    }
    const real = await fs.realpath(full);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null;
    return { kind: 'file', path: real };
}

async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, { error: 'method_not_allowed' });
        return;
    }
    const found = await locate(pathname);
    if (!found) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
    }
    if (found.kind === 'dir') {
        if (!found.slash) {
            res.writeHead(302, { location: `${pathname}/` });
            res.end();
            return;
        }
        const index = path.join(found.path, 'index.html');
        let real;
        try {
            real = await fs.realpath(index);
        } catch (err) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Not found');
            return;
        }
        await sendFile(req, res, real);
        return;
    }
    await sendFile(req, res, found.path);
}

async function sendFile(req, res, file) {
    const data = await fs.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
        'content-type': type,
        'content-length': data.length,
        'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    console.log(`${req.method} ${pathname}`);
    try {
        if (pathname === '/__mock/state' && req.method === 'GET') {
            send(res, 200, publicState());
            return;
        }
        if (pathname === '/__mock' && req.method === 'POST') {
            await handleControl(req, res);
            return;
        }
        if (pathname.startsWith('/tami4/api/')) {
            await handleApi(req, res, pathname);
            return;
        }
        await serveStatic(req, res, pathname);
    } catch (err) {
        console.error(err);
        if (!res.headersSent) send(res, 500, { error: 'mock_error' });
        else res.end();
    }
});

server.listen(PORT, '127.0.0.1', () => {
    const address = server.address();
    console.log(`listening http://127.0.0.1:${address.port}/tami4/`);
});
