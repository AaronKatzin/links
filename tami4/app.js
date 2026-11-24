const WRITABLE_BOOLS = [
    ['lightning', 'Light'],
    ['childLock', 'Child lock'],
    ['nightMode', 'Night mode'],
    ['energySaveMode', 'Energy save'],
    ['smartHeatingMode', 'Smart heating'],
    ['buttonsSound', 'Button sounds'],
    ['pushAndDrink', 'Push and drink'],
];

const READONLY = ['connectivityEnabled', 'wifiName'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ERROR_TEXT = {
    already_boiling: 'Already boiling.',
    offline: 'The bar is off Wi-Fi.',
    access_not_configured: 'Access is not configured.',
    bad_origin: 'The request origin was rejected.',
    unknown_drink: 'Unknown drink.',
    unsafe_configuration: 'That setting cannot be changed.',
    read_only: 'That setting is read-only.',
    unknown_key: 'Unknown setting.',
    invalid_type: 'Invalid value.',
    out_of_range: 'Value is out of range.',
    empty: 'No changes to save.',
    invalid_body: 'Invalid request.',
    tami4_auth_failed: 'Could not sign in to the bar.',
    tami4_unavailable: 'The bar is unavailable.',
};

let loadedConfig = null;
let busy = false;

function $(id) {
    return document.getElementById(id);
}

function field(name) {
    return $('settings-form').elements[name];
}

// upcoming_replacement is a UTC-midnight ISO timestamp. Keep the date part
// as written so a timezone west of UTC does not show the previous day.
export function formatReplacementDate(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof iso === 'string' ? iso : '');
    if (!match) return '';
    const monthIndex = Number(match[2]) - 1;
    const day = Number(match[3]);
    if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return '';
    return `${day} ${MONTHS[monthIndex]} ${match[1]}`;
}

export function daysUntil(iso, now = new Date()) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(typeof iso === 'string' ? iso : '');
    if (!match) return null;
    const due = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const stamp = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jerusalem',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stamp);
    if (!parts) return null;
    const today = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    return Math.round((due - today) / 86400000);
}

function daysLabel(days) {
    if (days === 0) return 'due today';
    const count = Math.abs(days);
    const unit = count === 1 ? 'day' : 'days';
    return days > 0 ? `${count} ${unit} left` : `${count} ${unit} overdue`;
}

function replacementText(kind, iso) {
    const date = formatReplacementDate(iso);
    if (!date) return `${kind} date unavailable`;
    const days = daysUntil(iso);
    return days == null ? `${kind} due ${date}` : `${kind} due ${date} · ${daysLabel(days)}`;
}

export function formatJerusalemTime(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jerusalem',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const hour = parts.find((part) => part.type === 'hour');
    const minute = parts.find((part) => part.type === 'minute');
    if (!hour || !minute) return '';
    return `${hour.value.padStart(2, '0')}:${minute.value.padStart(2, '0')}`;
}

function formatJerusalemStamp(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jerusalem',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type) => parts.find((part) => part.type === type)?.value || '';
    const hour = value('hour');
    const minute = value('minute');
    if (!hour || !minute) return '';
    return `${value('day')} ${value('month')} ${value('year')}, ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

export function plainError(body, status) {
    const error = body && typeof body.error === 'string' ? body.error : '';
    const detail = body && typeof body.detail === 'string' ? body.detail.trim() : '';
    const known = ERROR_TEXT[error];
    if (known && detail) return `${known} (${detail})`;
    if (known) return known;
    if (error && detail) return `${error}: ${detail}`;
    if (error) return error;
    if (detail) return detail;
    return `Request failed (${status}).`;
}

function classify(status, body) {
    const error = body && typeof body.error === 'string' ? body.error : '';
    if (status === 401 || (status === 403 && error !== 'bad_origin')) {
        return { type: 'auth' };
    }
    if (status >= 200 && status < 300 && !(body && body.ok === false)) {
        return { type: 'success' };
    }
    return { type: 'error', text: plainError(body, status) };
}

async function api(path, options = {}) {
    const headers = { accept: 'application/json' };
    if (options.body != null) headers['content-type'] = 'application/json';
    try {
        const response = await fetch(path, {
            method: options.method || 'GET',
            body: options.body,
            credentials: 'same-origin',
            cache: 'no-store',
            headers,
        });
        let body = null;
        try {
            body = await response.json();
        } catch (err) {
            body = null;
        }
        return { status: response.status, body, outcome: classify(response.status, body) };
    } catch (err) {
        return {
            status: 0,
            body: null,
            outcome: { type: 'error', text: 'Could not reach the bar.' },
        };
    }
}

function setActionResult(text) {
    $('action-result').textContent = text;
}

function setSettingsResult(text) {
    $('settings-result').textContent = text;
}

function setStatusMessage(text) {
    const status = $('status');
    status.replaceChildren();
    const line = document.createElement('p');
    line.textContent = text;
    status.append(line);
}

function showAuth() {
    document.body.classList.add('signed-out');
    const notice = $('notice');
    notice.hidden = false;
    notice.replaceChildren();
    const line = document.createElement('p');
    const link = document.createElement('a');
    link.href = '/tami4/';
    link.textContent = 'Reload';
    line.append('Sign in to use this page. ', link);
    notice.append(line);
}

function clearAuth() {
    document.body.classList.remove('signed-out');
    const notice = $('notice');
    notice.hidden = true;
    notice.replaceChildren();
}

function handleFailure(result, setMessage) {
    if (result.outcome.type === 'auth') {
        showAuth();
        setMessage('Sign in to use this page.');
        return true;
    }
    if (result.outcome.type === 'error') {
        setMessage(result.outcome.text);
        return true;
    }
    return false;
}

function setBusy(on) {
    busy = on;
    const lock = on || document.body.classList.contains('signed-out');
    $('boil').disabled = lock;
    $('save').disabled = lock || !loadedConfig;
    document.querySelectorAll('#drinks button').forEach((button) => {
        button.disabled = lock;
    });
    for (const [name] of WRITABLE_BOOLS) {
        field(name).disabled = lock || !loadedConfig;
    }
    field('boilingTemp').disabled = lock || !loadedConfig;
    field('languageSetting').disabled = lock || !loadedConfig;
    for (const name of READONLY) {
        field(name).disabled = true;
    }
}

function addStatusLine(parent, text, className) {
    const line = document.createElement('p');
    if (className) line.className = className;
    line.textContent = text;
    parent.append(line);
}

function formatMl(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    return `${new Intl.NumberFormat('en-GB').format(value)} ml passed`;
}

function renderStatus(body) {
    const device = body.device || {};
    const status = $('status');
    status.replaceChildren();
    const name = typeof device.name === 'string' && device.name ? device.name : 'Water bar';
    addStatusLine(status, name);
    addStatusLine(status, device.connected === true ? 'Connected' : 'Not connected');
    if (typeof device.firmware === 'string' && device.firmware) {
        addStatusLine(status, `Firmware ${device.firmware}`, 'muted');
    }
    const filter = body.filter || {};
    addStatusLine(status, replacementText('Filter', filter.upcoming_replacement));
    const passed = formatMl(filter.milli_litters_passed);
    if (passed) addStatusLine(status, passed, 'muted');
    const uv = body.uv || {};
    addStatusLine(status, replacementText('UV', uv.upcoming_replacement));
    const updated = formatJerusalemStamp(body.fetched_at);
    if (updated) addStatusLine(status, `Updated ${updated}`, 'muted');
}

function clearDrinks(message) {
    const list = $('drinks');
    list.replaceChildren();
    if (!message) return;
    const line = document.createElement('p');
    line.textContent = message;
    list.append(line);
}

function renderDrinks(drinks) {
    const list = $('drinks');
    list.replaceChildren();
    for (const drink of drinks) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'drink';
        button.dataset.drinkId = String(drink.id);
        const name = document.createElement('span');
        name.className = 'drink-name';
        const label = typeof drink.name === 'string' && drink.name ? drink.name : String(drink.id);
        name.textContent = label;
        const meta = document.createElement('span');
        meta.className = 'drink-meta';
        const bits = [];
        if (typeof drink.volume_ml === 'number') bits.push(`${drink.volume_ml} ml`);
        if (typeof drink.temperature_c === 'number') bits.push(`${drink.temperature_c}°C`);
        if (typeof drink.vessel === 'string' && drink.vessel) bits.push(drink.vessel);
        meta.textContent = bits.join(' · ');
        button.append(name, meta);
        button.addEventListener('click', () => {
            void makeDrink(drink, label);
        });
        list.append(button);
    }
}

function renderConfig(config) {
    loadedConfig = { ...config };
    for (const [name] of WRITABLE_BOOLS) {
        field(name).checked = config[name] === true;
    }
    field('boilingTemp').value = typeof config.boilingTemp === 'number' ? String(config.boilingTemp) : '';
    field('connectivityEnabled').checked = config.connectivityEnabled === true;
    field('wifiName').value = typeof config.wifiName === 'string' ? config.wifiName : '';
    field('languageSetting').value = typeof config.languageSetting === 'number'
        ? String(config.languageSetting)
        : '';
    setBusy(false);
}

function describePatch(patch) {
    const labels = Object.fromEntries(WRITABLE_BOOLS);
    return Object.keys(patch).map((key) => {
        if (key === 'boilingTemp') return `Boiling temperature: ${patch[key]}`;
        if (key === 'languageSetting') return `Language: ${patch[key]}`;
        return `${labels[key]}: ${patch[key] ? 'on' : 'off'}`;
    }).join('\n');
}

async function boil() {
    if (busy || document.body.classList.contains('signed-out')) return;
    setActionResult('Sending…');
    setBusy(true);
    try {
        const result = await api('/tami4/api/boil', { method: 'POST' });
        if (handleFailure(result, setActionResult)) return;
        const started = formatJerusalemTime(result.body && result.body.started_at);
        setActionResult(started ? `Boiling, started ${started}.` : 'Boiling started.');
    } finally {
        setBusy(false);
    }
}

async function makeDrink(drink, label) {
    if (busy || document.body.classList.contains('signed-out')) return;
    setActionResult('Sending…');
    setBusy(true);
    try {
        const result = await api(`/tami4/api/drinks/${encodeURIComponent(drink.id)}/make`, {
            method: 'POST',
        });
        if (handleFailure(result, setActionResult)) return;
        const started = formatJerusalemTime(result.body && result.body.started_at);
        setActionResult(started ? `${label}, started ${started}.` : `${label} started.`);
    } finally {
        setBusy(false);
    }
}

async function onSave(event) {
    event.preventDefault();
    if (!loadedConfig || busy || document.body.classList.contains('signed-out')) return;
    const patch = {};
    for (const [name] of WRITABLE_BOOLS) {
        const checked = field(name).checked;
        if (checked !== (loadedConfig[name] === true)) patch[name] = checked;
    }
    const temp = field('boilingTemp');
    if (temp.valueAsNumber !== loadedConfig.boilingTemp) {
        if (!temp.checkValidity()) {
            setSettingsResult(temp.validationMessage || 'Value is out of range.');
            return;
        }
        patch.boilingTemp = temp.valueAsNumber;
    }
    const language = field('languageSetting');
    if (language.valueAsNumber !== loadedConfig.languageSetting) {
        if (!Number.isFinite(language.valueAsNumber) || !language.checkValidity()) {
            setSettingsResult(language.validationMessage || 'Invalid value.');
            return;
        }
        patch.languageSetting = language.valueAsNumber;
    }
    if (Object.keys(patch).length === 0) {
        setSettingsResult('No changes to save.');
        return;
    }
    let confirmText = `Change settings?\n\n${describePatch(patch)}`;
    if (Object.hasOwn(patch, 'languageSetting')) {
        confirmText += '\n\nAn unknown value could put the screen in an unreadable language.';
    }
    if (!window.confirm(confirmText)) {
        setSettingsResult('Settings were not changed.');
        return;
    }
    setSettingsResult('Sending…');
    setBusy(true);
    try {
        const result = await api('/tami4/api/config', {
            method: 'POST',
            body: JSON.stringify(patch),
        });
        if (handleFailure(result, setSettingsResult)) return;
        const config = result.body && result.body.config;
        if (config && typeof config === 'object') {
            renderConfig(config);
        } else {
            const again = await api('/tami4/api/config');
            if (handleFailure(again, setSettingsResult)) return;
            if (again.body && again.body.config) renderConfig(again.body.config);
        }
        setSettingsResult('Saved.');
    } finally {
        setBusy(false);
    }
}

async function load() {
    clearAuth();
    setStatusMessage('Loading status…');
    setActionResult('');
    const [status, drinks, config] = await Promise.all([
        api('/tami4/api/status'),
        api('/tami4/api/drinks'),
        api('/tami4/api/config'),
    ]);
    if ([status, drinks, config].some((result) => result.outcome.type === 'auth')) {
        loadedConfig = null;
        showAuth();
        setStatusMessage('Sign in to use this page.');
        clearDrinks('');
        setSettingsResult('');
        setBusy(false);
        return;
    }
    if (status.outcome.type === 'success' && status.body && status.body.device) {
        renderStatus(status.body);
    } else if (status.outcome.type === 'error') {
        setStatusMessage(status.outcome.text);
    } else {
        setStatusMessage('Status is unavailable.');
    }
    if (drinks.outcome.type === 'success' && drinks.body && Array.isArray(drinks.body.drinks)) {
        renderDrinks(drinks.body.drinks);
    } else if (drinks.outcome.type === 'error' && drinks.outcome.text !== status.outcome.text) {
        clearDrinks(drinks.outcome.text);
    } else {
        clearDrinks('');
    }
    if (config.outcome.type === 'success' && config.body && config.body.config && typeof config.body.config === 'object') {
        renderConfig(config.body.config);
        setSettingsResult('');
    } else {
        loadedConfig = null;
        if (config.outcome.type === 'error' && config.outcome.text !== status.outcome.text) {
            setSettingsResult(config.outcome.text);
        } else {
            setSettingsResult('');
        }
        setBusy(false);
    }
}

function start() {
    $('boil').addEventListener('click', () => {
        void boil();
    });
    $('settings-form').addEventListener('submit', (event) => {
        void onSave(event);
    });
    void load();
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
}
