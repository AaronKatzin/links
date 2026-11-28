/**
 * Serves the page on the local mock and clicks every control in headless Chrome.
 *   node tami4/dev/click-through.mjs [screenshotDir]
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { daysUntil, formatJerusalemTime, formatReplacementDate, plainError } from '../app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.resolve(process.argv[2] || path.join(tmpdir(), 'tami4-shots'));
const CHROME = process.env.CHROME || 'google-chrome';
const failures = [];

function check(condition, message) {
    if (condition) console.log('ok', message);
    else {
        failures.push(message);
        console.error('FAIL', message);
    }
}

function assertUnit() {
    check(formatReplacementDate('2027-05-21T00:00:00Z') === '21 May 2027', 'filter date part');
    check(formatReplacementDate('2027-11-02T00:00:00.000Z') === '2 Nov 2027', 'uv date part');
    check(formatReplacementDate('2027-05-21T00:00:00+00:00') === '21 May 2027', 'explicit utc offset');
    const due = Math.round(Date.UTC(2027, 4, 21) / 86400000);
    const today = Math.round(Date.UTC(2026, 10, 24) / 86400000);
    const boundary = new Date('2026-11-24T04:00:00Z');
    check(daysUntil('2027-05-21T00:00:00Z', boundary) === due - today, 'days use Jerusalem date, not local');
    check(formatJerusalemTime('2026-11-24T05:02:00.000Z') === '07:02', 'winter Jerusalem time');
    check(formatJerusalemTime('2026-06-15T04:02:00.000Z') === '07:02', 'summer Jerusalem time');
    check(formatJerusalemTime('2026-11-24T22:30:00.000Z') === '00:30', 'Jerusalem midnight hour');
    check(plainError({ error: 'offline' }, 503) === 'The bar is off Wi-Fi.', 'offline text');
    check(plainError({ error: 'already_boiling' }, 409) === 'Already boiling.', '409 text');
    check(plainError({ error: 'bad_origin' }, 403) === 'The request origin was rejected.', 'bad origin text');
    check(plainError({ error: 'access_not_configured' }, 503) === 'Access is not configured.', 'access text');
    check(
        plainError({ error: 'out_of_range', detail: 'boilingTemp must be from 70 to 100' }, 400)
            === 'Value is out of range. (boilingTemp must be from 70 to 100)',
        'detail is shown as text',
    );
    check(plainError({ error: '<img>' }, 400) === '<img>', 'unknown error stays text');
    check(plainError(null, 502) === 'Request failed (502).', 'missing json');
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close((err) => (err ? reject(err) : resolve(port)));
        });
    });
}

function pngSize(buffer) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function auditSources() {
    const pageFiles = ['tami4/index.html', 'tami4/app.js', 'tami4/style.css'];
    const banned = [/password/i, /secret/i, /api[_-]?key/i, /bearer/i, /cf-access-jwt/i, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i];
    for (const file of pageFiles) {
        const source = await readFile(path.join(ROOT, file), 'utf8');
        for (const pattern of banned) {
            check(!pattern.test(source), `${file} has no ${pattern}`);
        }
    }
    const app = await readFile(path.join(ROOT, 'tami4/app.js'), 'utf8');
    const html = await readFile(path.join(ROOT, 'tami4/index.html'), 'utf8');
    const home = await readFile(path.join(ROOT, 'index.html'), 'utf8');
    check(app.includes("credentials: 'same-origin'"), 'fetch uses same-origin credentials');
    check(app.includes("headers['content-type'] = 'application/json'"), 'config post sets json content type');
    check(!app.includes('innerHTML') && !app.includes('document.write'), 'page does not inject html');
    check(!/\bhot\b/i.test(app) && !/\bhot\b/i.test(html), 'page source never says hot');
    check(html.includes('name="robots"') && html.includes('content="noindex"'), 'noindex');
    check(!home.includes('tami4'), 'home page does not link the control page');
    const entries = await readdir(ROOT, { recursive: true });
    check(!entries.some((entry) => String(entry).toLowerCase().includes('sitemap')), 'no sitemap');
}

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 0;
        this.pending = new Map();
        this.listeners = new Map();
        ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) reject(new Error(`${message.error.message || 'cdp error'}: ${JSON.stringify(message.error)}`));
                else resolve(message.result || {});
            } else if (message.method) {
                for (const listener of this.listeners.get(message.method) || []) {
                    listener(message.params || {}, message.sessionId);
                }
            }
        });
    }

    send(method, params = {}, sessionId) {
        const id = ++this.nextId;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
        });
    }

    on(method, listener) {
        const list = this.listeners.get(method) || [];
        list.push(listener);
        this.listeners.set(method, list);
    }

    waitFor(method, ms) {
        return new Promise((resolve, reject) => {
            let wrapped;
            const timer = setTimeout(() => {
                const list = this.listeners.get(method) || [];
                this.listeners.set(method, list.filter((item) => item !== wrapped));
                reject(new Error(`timeout waiting for ${method}`));
            }, ms);
            wrapped = (params) => {
                clearTimeout(timer);
                const list = this.listeners.get(method) || [];
                this.listeners.set(method, list.filter((item) => item !== wrapped));
                resolve(params);
            };
            this.on(method, wrapped);
        });
    }
}

async function main() {
    assertUnit();
    await auditSources();
    await mkdir(SHOTS, { recursive: true });
    const port = await freePort();
    const debugPort = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const userData = await mkdtemp(path.join(tmpdir(), 'tami4-chrome-'));
    const server = spawn(process.execPath, [path.join(ROOT, 'tami4/dev/mock-server.mjs')], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    server.stdout.on('data', (chunk) => {
        serverLog += chunk;
        if (serverLog.length > 8000) serverLog = serverLog.slice(-8000);
    });
    server.stderr.on('data', (chunk) => {
        serverLog += chunk;
    });
    const chrome = spawn(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-extensions',
        '--hide-scrollbars',
        '--remote-allow-origins=*',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${userData}`,
        '--window-size=1280,900',
        'about:blank',
    ], {
        env: { ...process.env, TZ: 'America/Los_Angeles' },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let chromeLog = '';
    chrome.stderr.on('data', (chunk) => {
        chromeLog += chunk;
        if (chromeLog.length > 8000) chromeLog = chromeLog.slice(-8000);
    });

    const stop = async () => {
        await Promise.all([server, chrome].map((child) => new Promise((resolve) => {
            if (child.exitCode !== null) {
                resolve();
                return;
            }
            child.once('exit', resolve);
            child.kill('SIGKILL');
            setTimeout(resolve, 1000);
        })));
        await rm(userData, { recursive: true, force: true }).catch(() => {});
    };

    try {
        await waitForListen(server);
        await testMock(base);
        const version = await waitForChrome(debugPort);
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve);
            ws.addEventListener('error', () => reject(new Error(`chrome websocket failed\n${chromeLog}`)));
        });
        const cdp = new Cdp(ws);
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        await cdp.send('Page.enable', {}, sessionId);
        await cdp.send('Runtime.enable', {}, sessionId);
        cdp.on('Runtime.exceptionThrown', (params) => {
            console.error('page exception', params.exceptionDetails?.exception?.description || params.exceptionDetails?.text);
        });
        const browser = new Browser(cdp, sessionId, base);
        await browser.run();
        ws.close();
    } catch (err) {
        console.error(err);
        console.error(serverLog);
        console.error(chromeLog);
        failures.push(err.message || String(err));
    } finally {
        await stop();
    }

    if (failures.length) {
        console.error(`\n${failures.length} failure(s)`);
        process.exit(1);
    }
    console.log('\nall checks passed');
}

function waitForListen(server) {
    return new Promise((resolve, reject) => {
        let buf = '';
        const onData = (chunk) => {
            buf += chunk;
            if (buf.includes('listening ')) {
                server.stdout.off('data', onData);
                resolve();
            }
        };
        server.stdout.on('data', onData);
        server.on('exit', (code) => reject(new Error(`mock exited ${code}`)));
    });
}

async function waitForChrome(port) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (response.ok) return await response.json();
        } catch (err) {
            // Chrome is still starting.
        }
        await delay(100);
    }
    throw new Error('chrome did not open a debugging port');
}

async function jfetch(base, pathname, options = {}) {
    const response = await fetch(`${base}${pathname}`, options);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function control(base, body) {
    return jfetch(base, '/__mock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function postJson(base, pathname, body, headers = {}) {
    return jfetch(base, pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

async function testMock(base) {
    await control(base, { reset: true });
    const status = await jfetch(base, '/tami4/api/status');
    check(status.status === 200, 'status 200');
    check(status.body.filter.upcoming_replacement === '2027-05-21T00:00:00Z', 'status date is utc midnight');
    check(status.body.device.connected === true, 'status connected');
    check(status.body.filter.milli_litters_passed === 842000, 'filter volume field');
    const drinks = await jfetch(base, '/tami4/api/drinks');
    check(drinks.status === 200 && drinks.body.drinks.length === 3, 'three drinks');

    const first = await jfetch(base, '/tami4/api/boil', { method: 'POST' });
    check(first.status === 200 && first.body.ok === true && typeof first.body.started_at === 'string', 'boil starts');
    const second = await jfetch(base, '/tami4/api/boil', { method: 'POST' });
    check(second.status === 409 && second.body.ok === false && second.body.error === 'already_boiling', 'second boil is 409');

    const made = await jfetch(base, '/tami4/api/drinks/tea/make', { method: 'POST' });
    check(made.status === 200 && made.body.ok === true, 'make tea');
    const missing = await jfetch(base, '/tami4/api/drinks/nope/make', { method: 'POST' });
    check(missing.status === 404 && missing.body.error === 'unknown_drink', 'unknown drink');

    const bare = await jfetch(base, '/tami4/api/config', {
        method: 'POST',
        body: JSON.stringify({ childLock: true }),
    });
    check(bare.status === 400 && bare.body.error === 'invalid_body', 'config requires json content type');
    const charset = await postJson(base, '/tami4/api/config', { childLock: true }, {
        'content-type': 'application/json; charset=utf-8',
    });
    check(charset.status === 200 && charset.body.ok === true && charset.body.config.childLock === true, 'charset json is accepted');

    const cases = [
        [{}, 400, 'empty'],
        [{ connectivityEnabled: false }, 400, 'unsafe_configuration'],
        [{ wifiName: 'other' }, 400, 'read_only'],
        [{ languageSetting: 2 }, 200, null],
        [{ languageSetting: 1.5 }, 200, null],
        [{ languageSetting: '2' }, 400, 'invalid_type'],
        [{ languageSetting: null }, 400, 'invalid_type'],
        [{ nope: true }, 400, 'unknown_key'],
        [{ childLock: 'yes' }, 400, 'invalid_type'],
        [{ boilingTemp: '95' }, 400, 'invalid_type'],
        [{ boilingTemp: 69 }, 400, 'out_of_range'],
        [{ boilingTemp: 101 }, 400, 'out_of_range'],
        [{ boilingTemp: 95.5 }, 400, 'out_of_range'],
        [{ boilingTemp: 70 }, 200, null],
        [{ boilingTemp: 100 }, 200, null],
    ];
    for (const [body, statusCode, error] of cases) {
        const result = await postJson(base, '/tami4/api/config', body);
        check(result.status === statusCode && (error == null || result.body.error === error), `config ${JSON.stringify(body)} -> ${statusCode} ${error || 'ok'}`);
    }
    const before = (await jfetch(base, '/tami4/api/config')).body.config.lightning;
    const mixed = await postJson(base, '/tami4/api/config', { lightning: !before, connectivityEnabled: false });
    const after = (await jfetch(base, '/tami4/api/config')).body.config.lightning;
    check(mixed.status === 400 && mixed.body.error === 'unsafe_configuration' && after === before, 'rejected config does not apply');

    const forced = [
        ['unauthorized', 401, 'unauthorized'],
        ['forbidden', 403, 'forbidden'],
        ['bad_origin', 403, 'bad_origin'],
        ['offline', 503, 'offline'],
        ['access_not_configured', 503, 'access_not_configured'],
        ['tami4_auth_failed', 502, 'tami4_auth_failed'],
        ['tami4_unavailable', 502, 'tami4_unavailable'],
    ];
    for (const [mode, statusCode, error] of forced) {
        await control(base, { mode });
        const result = await jfetch(base, '/tami4/api/status');
        check(result.status === statusCode && result.body.error === error, `mode ${mode}`);
    }
    await control(base, { reset: true });
}

class Browser {
    constructor(cdp, sessionId, base) {
        this.cdp = cdp;
        this.sessionId = sessionId;
        this.base = base;
        this.dialogMode = null;
        this.dialogs = [];
        cdp.on('Page.javascriptDialogOpening', (params, eventSession) => {
            if (eventSession && eventSession !== sessionId) return;
            this.dialogs.push(params.message || '');
            const accept = this.dialogMode === 'accept';
            if (!this.dialogMode) failures.push(`unexpected dialog: ${params.message}`);
            void cdp.send('Page.handleJavaScriptDialog', { accept }, sessionId).catch((err) => {
                failures.push(`dialog handling failed: ${err.message}`);
            });
        });
    }

    async send(method, params) {
        return this.cdp.send(method, params, this.sessionId);
    }

    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
        }
        return result.result?.value;
    }

    async text(selector) {
        return this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
    }

    async waitForText(selector, pattern, label) {
        const start = Date.now();
        let last = '';
        while (Date.now() - start < 5000) {
            last = await this.text(selector);
            if (pattern.test(last)) return last;
            await delay(40);
        }
        throw new Error(`${label}. Last text: ${JSON.stringify(last)}`);
    }

    async open(pattern) {
        const loaded = this.cdp.waitFor('Page.loadEventFired', 8000).catch(() => null);
        await this.send('Page.navigate', { url: `${this.base}/tami4/` });
        await loaded;
        return this.waitForText('#status', pattern, `open ${pattern}`);
    }

    async viewport(width, height, mobile) {
        await this.send('Emulation.setDeviceMetricsOverride', {
            width,
            height,
            deviceScaleFactor: 1,
            mobile,
        });
    }

    async shot(name) {
        await this.evaluate('window.scrollTo(0, 0)');
        const metrics = await this.send('Page.getLayoutMetrics');
        const size = metrics.cssContentSize || metrics.contentSize;
        const width = Math.ceil(size.width);
        const height = Math.ceil(size.height);
        const result = await this.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width, height, scale: 1 },
        });
        const buffer = Buffer.from(result.data, 'base64');
        const file = path.join(SHOTS, name);
        await writeFile(file, buffer);
        const png = pngSize(buffer);
        console.log('shot', name, png.width, png.height);
        return png;
    }

    async click(selector) {
        const clicked = await this.evaluate(`(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.click();
            return true;
        })()`);
        check(clicked === true, `click ${selector}`);
        return clicked;
    }

    async installSpy() {
        await this.evaluate(`(() => {
            const orig = window.fetch.bind(window);
            window.__fetches = [];
            window.fetch = async (input, init = {}) => {
                const headers = init.headers || {};
                const response = await orig(input, init);
                window.__fetches.push({
                    url: String(input),
                    method: init.method || 'GET',
                    credentials: init.credentials || '',
                    contentType: headers['content-type'] || headers['Content-Type'] || '',
                    body: typeof init.body === 'string' ? init.body : '',
                    status: response.status,
                });
                return response;
            };
        })()`);
    }

    async fetches() {
        return this.evaluate('window.__fetches || []');
    }

    async noHot(label) {
        const text = await this.text('body');
        check(!/\bhot\b/i.test(text), `${label} does not say hot`);
        return text;
    }

    async run() {
        await this.viewport(1280, 900, false);
        const desktopStatus = await this.open(/Connected/);
        check(desktopStatus.includes('21 May 2027'), 'desktop shows unshifted filter date');
        check(desktopStatus.includes('2 Nov 2027'), 'desktop shows unshifted uv date');
        check(!desktopStatus.includes('20 May') && !desktopStatus.includes('1 Nov 2027'), 'dates did not shift west');
        const desktopShot = await this.shot('tami4_desktop.png');
        check(desktopShot.width >= 1000, 'desktop screenshot is desktop width');

        await this.viewport(412, 915, true);
        const mobileStatus = await this.open(/Connected/);
        check(mobileStatus.includes('Tami4 Edge+'), 'device name');
        check(mobileStatus.includes('842,000 ml passed'), 'filter volume');
        check(/Filter due 21 May 2027 · \d+ days left/.test(mobileStatus), 'filter days left');
        check(/UV due 2 Nov 2027 · \d+ days left/.test(mobileStatus), 'uv days left');
        const expectedDays = daysUntil('2027-05-21T00:00:00Z');
        check(mobileStatus.includes(`${expectedDays} days left`), 'days left follow Jerusalem today');
        const drinksText = await this.text('#drinks');
        check(drinksText.includes('Tea') && drinksText.includes('Coffee') && drinksText.includes('Formula'), 'drink buttons');
        check((await this.evaluate(`document.querySelector('[name="connectivityEnabled"]').disabled`)) === true, 'connectivity disabled');
        check((await this.evaluate(`document.querySelector('[name="wifiName"]').disabled`)) === true, 'wifi disabled');
        const language = await this.evaluate(`(() => {
            const input = document.querySelector('[name="languageSetting"]');
            return {
                disabled: input.disabled,
                type: input.type,
                step: input.step,
                min: input.min,
                max: input.max,
                inputMode: input.inputMode,
                value: input.value,
                label: input.closest('label').innerText,
            };
        })()`);
        check(language.disabled === false, 'language is writable');
        check(language.type === 'number' && language.step === '1' && language.inputMode === 'numeric', 'language input is a raw number');
        check(language.min === '' && language.max === '', 'language has no min or max');
        check(language.value === '1', 'language shown');
        check(language.label.includes('Language (raw value)'), 'language label');
        check(/raw device code/.test(language.label), 'language hint');
        check((await this.evaluate(`document.querySelector('[name="wifiName"]').value`)) === 'home', 'wifi shown');
        await this.noHot('initial page');
        const mobileShot = await this.shot('tami4_mobile.png');
        check(mobileShot.width >= 400 && mobileShot.width <= 430, 'mobile screenshot is phone width');
        check(mobileShot.height > 900, 'mobile screenshot includes the full page');

        await this.installSpy();
        await this.click('#boil');
        const boiled = await this.waitForText('#action-result', /Boiling, started \d{2}:\d{2}\./, 'boil result');
        const state = await jfetch(this.base, '/__mock/state');
        const jerusalem = formatJerusalemTime(state.body.lastStartedAt);
        const local = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/Los_Angeles',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(new Date(state.body.lastStartedAt));
        check(boiled.includes(jerusalem), `boil time is Jerusalem ${jerusalem}`);
        if (local !== jerusalem) check(!boiled.includes(`started ${local}`), 'boil time is not the browser zone');
        const boilCalls = (await this.fetches()).filter((call) => call.url.endsWith('/tami4/api/boil'));
        check(boilCalls[0].status === 200 && boilCalls[0].credentials === 'same-origin', 'boil fetch is same-origin 200');
        check(boilCalls[0].contentType === '', 'boil does not invent a content type');
        await this.noHot('after boil');
        await this.shot('tami4_mobile_boil.png');

        await this.click('#boil');
        await this.waitForText('#action-result', /^Already boiling\.$/, 'already boiling');
        const boilAgain = (await this.fetches()).filter((call) => call.url.endsWith('/tami4/api/boil'));
        check(boilAgain.at(-1).status === 409, 'page received 409');

        await control(this.base, { boiling: false });
        const buttons = await this.evaluate(`Array.from(document.querySelectorAll('#drinks button')).map((button) => ({
            id: button.dataset.drinkId,
            name: button.querySelector('.drink-name').textContent,
        }))`);
        check(buttons.length === 3, 'three drink controls');
        for (const drink of buttons) {
            await this.click(`#drinks button[data-drink-id="${drink.id}"]`);
            const result = await this.waitForText('#action-result', new RegExp(`${drink.name}, started \\d{2}:\\d{2}\\.`), drink.name);
            const started = (await jfetch(this.base, '/__mock/state')).body.lastStartedAt;
            check(result.includes(formatJerusalemTime(started)), `${drink.name} time is Jerusalem`);
            await this.noHot(drink.name);
        }

        const toggles = ['lightning', 'childLock', 'nightMode', 'energySaveMode', 'smartHeatingMode', 'buttonsSound', 'pushAndDrink'];
        for (const name of toggles) await this.click(`[name="${name}"]`);
        await this.evaluate(`(() => {
            const input = document.querySelector('[name="boilingTemp"]');
            input.value = '98';
            return input.valueAsNumber;
        })()`);
        this.dialogs = [];
        this.dialogMode = 'accept';
        await this.click('#save');
        await this.waitForText('#settings-result', /^Saved\.$/, 'settings saved');
        this.dialogMode = null;
        check(this.dialogs.some((message) => message.includes('Change settings?') && message.includes('Child lock: on') && message.includes('Boiling temperature: 98') && message.includes('Light: off')), 'confirm lists the changes');
        check(!this.dialogs.some((message) => /unreadable language/.test(message)), 'language warning stays off when language is unchanged');
        const saved = await jfetch(this.base, '/__mock/state');
        check(saved.body.lastConfigPost.contentType.toLowerCase().startsWith('application/json'), 'save sent application/json');
        const posted = saved.body.lastConfigPost.body;
        check(posted.childLock === true && posted.lightning === false && posted.boilingTemp === 98, 'save body matches the controls');
        check(!('connectivityEnabled' in posted) && !('wifiName' in posted) && !('languageSetting' in posted), 'save omits unchanged language and read-only keys');
        check(saved.body.config.boilingTemp === 98 && saved.body.config.connectivityEnabled === true && saved.body.config.wifiName === 'home', 'server config updated');
        check((await this.evaluate(`document.querySelector('[name="childLock"]').checked`)) === true, 'child lock stayed on');
        await this.noHot('after save');
        await this.shot('tami4_mobile_saved.png');

        await this.evaluate(`document.querySelector('[name="languageSetting"]').value = '2'`);
        this.dialogs = [];
        this.dialogMode = 'accept';
        await this.click('#save');
        await this.waitForText('#settings-result', /^Saved\.$/, 'language saved');
        this.dialogMode = null;
        check(this.dialogs.some((message) => message.includes('An unknown value could put the screen in an unreadable language.')), 'language confirm warns about an unreadable screen');
        const languageSave = await jfetch(this.base, '/__mock/state');
        check(languageSave.body.lastConfigPost.body.languageSetting === 2 && Object.keys(languageSave.body.lastConfigPost.body).length === 1, 'language save sends only the changed code');
        check(languageSave.body.config.languageSetting === 2 && languageSave.body.config.wifiName === 'home' && languageSave.body.config.connectivityEnabled === true, 'server stored the language and left read-only fields');
        check((await this.evaluate(`document.querySelector('[name="languageSetting"]').value`)) === '2', 'language field shows the saved code');

        await this.evaluate(`document.querySelector('[name="languageSetting"]').value = '3'`);
        this.dialogs = [];
        this.dialogMode = 'dismiss';
        await this.click('#save');
        await this.waitForText('#settings-result', /^Settings were not changed\.$/, 'language cancel');
        this.dialogMode = null;
        check((await jfetch(this.base, '/__mock/state')).body.config.languageSetting === 2, 'dismissed language change was not saved');
        await this.evaluate(`document.querySelector('[name="languageSetting"]').value = '2'`);

        await this.click('[name="childLock"]');
        this.dialogs = [];
        this.dialogMode = 'dismiss';
        await this.click('#save');
        await this.waitForText('#settings-result', /^Settings were not changed\.$/, 'cancel save');
        this.dialogMode = null;
        check(this.dialogs.length === 1, 'cancel opened one confirm');
        check((await jfetch(this.base, '/__mock/state')).body.config.childLock === true, 'dismissed confirm did not post');
        await this.click('[name="childLock"]');

        await this.evaluate(`document.querySelector('[name="boilingTemp"]').value = '101'`);
        const postsBefore = (await jfetch(this.base, '/__mock/state')).body.lastConfigPost.body;
        this.dialogs = [];
        this.dialogMode = null;
        await this.click('#save');
        await delay(150);
        const invalid = await this.text('#settings-result');
        check(invalid.length > 0 && !invalid.includes('Saved'), 'out of range input is rejected on the page');
        check(this.dialogs.length === 0, 'invalid temperature does not confirm');
        check(JSON.stringify((await jfetch(this.base, '/__mock/state')).body.lastConfigPost.body) === JSON.stringify(postsBefore), 'invalid temperature was not posted');

        await this.evaluate(`document.querySelector('[name="boilingTemp"]').value = '98'`);
        await this.click('#save');
        await this.waitForText('#settings-result', /^No changes to save\.$/, 'no changes');

        const checked = await this.evaluate(`document.querySelector('[name="connectivityEnabled"]').checked`);
        await this.click('[name="connectivityEnabled"]');
        check((await this.evaluate(`document.querySelector('[name="connectivityEnabled"]').checked`)) === checked, 'read-only connectivity ignores clicks');

        await control(this.base, {
            force: {
                status: 400,
                body: { ok: false, error: 'out_of_range', detail: 'boilingTemp must be from 70 to 100' },
            },
        });
        await this.click('[name="nightMode"]');
        this.dialogMode = 'accept';
        await this.click('#save');
        const ranged = await this.waitForText('#settings-result', /Value is out of range/, 'server range error');
        check(ranged.includes('boilingTemp must be from 70 to 100'), 'server detail is shown');
        this.dialogMode = null;

        await control(this.base, {
            force: { status: 400, body: { ok: false, error: 'invalid_body', detail: '<img src=x onerror=alert(1)>' } },
        });
        this.dialogs = [];
        await this.click('#boil');
        const escaped = await this.waitForText('#action-result', /<img src=x onerror=alert\(1\)>/, 'error detail text');
        check(escaped.includes('Invalid request.'), 'invalid body sentence');
        check((await this.evaluate(`document.querySelector('#action-result img')`)) == null, 'error detail is not html');
        check(this.dialogs.length === 0, 'error detail did not run');

        await control(this.base, { mode: 'tami4_auth_failed' });
        await this.click('#boil');
        await this.waitForText('#action-result', /^Could not sign in to the bar\.$/, 'bar auth failure');
        await control(this.base, { mode: 'tami4_unavailable' });
        await this.click('#drinks button[data-drink-id="tea"]');
        await this.waitForText('#action-result', /^The bar is unavailable\.$/, 'bar unavailable');

        await control(this.base, { mode: 'bad_origin' });
        await this.click('#boil');
        await this.waitForText('#action-result', /^The request origin was rejected\.$/, 'bad origin');
        check((await this.evaluate(`document.querySelector('#notice').hidden`)) === true, 'bad origin is not a sign-in wall');

        await control(this.base, { mode: 'forbidden' });
        await this.open(/Sign in/);
        const forbidden = await this.text('#notice');
        check(forbidden.includes('Sign in') && forbidden.includes('Reload'), '403 shows sign in');
        check(!forbidden.toLowerCase().includes('forbidden'), '403 does not dump the error code');
        check((await this.evaluate(`document.querySelector('#notice a').getAttribute('href')`)) === '/tami4/', 'reload link');

        await control(this.base, { mode: 'unauthorized' });
        await this.open(/Sign in/);
        await this.noHot('sign in');
        await this.shot('tami4_mobile_signin.png');

        await control(this.base, { mode: 'access_not_configured' });
        await this.open(/Access is not configured/);
        check((await this.evaluate(`document.querySelector('#notice').hidden`)) === true, 'access setup is not the sign-in message');

        await control(this.base, { mode: 'offline' });
        await this.open(/off Wi-Fi/);
        await this.noHot('offline');
        await this.shot('tami4_mobile_offline.png');
        await this.click('#boil');
        await this.waitForText('#action-result', /^The bar is off Wi-Fi\.$/, 'boil while offline');

        await control(this.base, { reset: true, connected: false });
        const disconnected = await this.open(/Not connected/);
        check(!/^Connected$/m.test(disconnected), 'disconnected is not shown as connected');
        await this.noHot('disconnected');
    }
}

await main();
