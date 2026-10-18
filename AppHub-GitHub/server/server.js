'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const SERVER_DIR = __dirname;
const APP_DIR = path.resolve(SERVER_DIR, '..');
const DATA_DIR = path.join(APP_DIR, 'data');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const CUSTOM_ICON_DIR = path.join(DATA_DIR, 'custom-icons');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const WEB_DIR = path.join(SERVER_DIR, 'web');
const PS_DIR = path.join(SERVER_DIR, 'ps');

function currentUserKey() {
  try {
    const output = execFileSync('whoami.exe', ['/user'], { windowsHide: true, encoding: 'utf8' });
    const match = /S-1-[\d-]+/.exec(output);
    if (match) return match[0];
  } catch (_) {}
  try {
    return os.userInfo().username;
  } catch (_) {
    return process.env.USERNAME || 'user';
  }
}

function defaultPortBase() {
  let hash = 0;
  for (const char of currentUserKey().toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 200;
  }
  return 8700 + hash;
}

const BASE_PORT = Number(process.env.APPHUB_PORT || defaultPortBase());
const HOST = '127.0.0.1';
const OPEN_ON_START = process.argv.includes('--open');

const THEMES = new Set(['aurora', 'ocean', 'sunset', 'graphite']);

const DEFAULT_STATE = {
  version: 1,
  folders: [],
  hidden: [],
  custom: [],
  order: [],
  theme: 'aurora',
  iconSize: 96,
  autostart: true,
  updatedAt: 0
};

let apps = [];
let appMap = new Map();
let state = { ...DEFAULT_STATE };
let scanning = false;
let scannedAt = 0;
let lastError = null;
let iconStatus = { total: 0, done: 0, running: false };
let iconQueueRunning = false;
let iconQueueAgain = false;

function md5(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function sanitizeState(raw) {
  const next = { ...DEFAULT_STATE };
  if (!raw || typeof raw !== 'object') return next;

  if (Array.isArray(raw.folders)) {
    next.folders = raw.folders.slice(0, 200).map((folder, index) => ({
      id: cleanText(folder && folder.id, 40) || 'f-' + index,
      name: cleanText(folder && folder.name, 24) || '文件夹',
      color: cleanText(folder && folder.color, 20) || 'blue',
      apps: Array.isArray(folder && folder.apps)
        ? folder.apps.filter((id) => typeof id === 'string').slice(0, 300)
        : []
    }));
  }

  if (Array.isArray(raw.hidden)) {
    next.hidden = Array.from(new Set(raw.hidden.filter((id) => typeof id === 'string'))).slice(0, 5000);
  }

  if (Array.isArray(raw.custom)) {
    next.custom = raw.custom
      .filter((item) => item && typeof item.path === 'string' && item.path.length < 2048)
      .slice(0, 500)
      .map((item) => ({
        id: cleanText(item.id, 40),
        name: cleanText(item.name, 60),
        path: item.path,
        args: cleanText(item.args, 500),
        cwd: cleanText(item.cwd, 1024),
        addedAt: Number(item.addedAt) || Date.now()
      }))
      .filter((item) => item.id && item.name && item.path);
  }

  if (Array.isArray(raw.order)) {
    next.order = raw.order.filter((key) => typeof key === 'string').slice(0, 8000);
  }

  if (typeof raw.theme === 'string' && THEMES.has(raw.theme)) next.theme = raw.theme;
  if (Number.isFinite(Number(raw.iconSize))) {
    next.iconSize = Math.min(128, Math.max(64, Math.round(Number(raw.iconSize) / 2) * 2));
  }
  next.autostart = raw.autostart !== false;
  next.updatedAt = Number(raw.updatedAt) || 0;
  return next;
}

function loadState() {
  ensureDir(DATA_DIR);
  try {
    state = sanitizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch (_) {
    state = { ...DEFAULT_STATE };
  }
}

let saveTimer = null;
function saveStateSoon() {
  state.updatedAt = Date.now();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = STATE_FILE + '.tmp';
    fsp
      .writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
      .then(() => fsp.rename(tmp, STATE_FILE))
      .catch((error) => {
        lastError = '保存设置失败：' + error.message;
      });
  }, 120);
}

function mergeCustomApps() {
  appMap = new Map(apps.map((app) => [app.id, app]));
  for (const item of state.custom) {
    appMap.set(item.id, {
      id: item.id,
      name: item.name,
      kind: 'custom',
      target: item.path,
      args: item.args || '',
      cwd: item.cwd || '',
      lnk: item.path.toLowerCase().endsWith('.lnk') ? item.path : '',
      appid: '',
      source: 'custom',
      iconSource: item.path,
      custom: true
    });
  }
}

function allApps() {
  return Array.from(appMap.values());
}

function iconPath(id) {
  return path.join(ICON_DIR, id + '.png');
}

function customIconPath(id) {
  return path.join(CUSTOM_ICON_DIR, id + '.png');
}

function refreshIconStatus() {
  const list = allApps();
  let done = 0;
  for (const app of list) {
    if (fs.existsSync(iconPath(app.id))) done += 1;
  }
  iconStatus.total = list.length;
  iconStatus.done = done;
}

function runPowerShell(scriptName, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(PS_DIR, scriptName);
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
      { windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch (_) {}
      reject(new Error('PowerShell 执行超时'));
    }, timeoutMs || 120000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || 'PowerShell 退出码 ' + code));
    });
  });
}

async function scanApps(options) {
  const silent = options && options.silent;
  if (scanning) return;
  scanning = true;
  if (!silent) lastError = null;
  try {
    const outFile = path.join(DATA_DIR, 'scan.tmp.json');
    await runPowerShell('scan-apps.ps1', ['-OutFile', outFile], 180000);
    const raw = JSON.parse(await fsp.readFile(outFile, 'utf8'));
    const seen = new Set();
    const list = [];

    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item || !item.name) continue;
      const id = 'a' + md5([item.name, item.target, item.lnk, item.appid].join('|')).slice(0, 11);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({
        id,
        name: item.name,
        kind: item.kind || 'lnk',
        target: item.target || '',
        args: item.args || '',
        cwd: item.cwd || '',
        lnk: item.lnk || '',
        appid: item.appid || '',
        source: item.source || '',
        iconSource:
          item.kind === 'uwp' && item.appid ? 'shell:AppsFolder\\' + item.appid : item.iconFrom || item.lnk || item.target || '',
        custom: false
      });
    }

    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    // Keep the previous order stable for apps that already existed.
    const previous = new Map(apps.map((app) => [app.id, app]));
    for (let i = 0; i < list.length; i += 1) {
      if (previous.has(list[i].id)) list[i] = { ...previous.get(list[i].id), ...list[i] };
    }

    apps = list;
    mergeCustomApps();
    scannedAt = Date.now();
    await fsp.writeFile(APPS_FILE, JSON.stringify({ scannedAt, apps }), 'utf8');
    refreshIconStatus();
    startIconQueue();
  } catch (error) {
    lastError = '扫描应用失败：' + (error && error.message ? error.message : String(error));
  } finally {
    scanning = false;
  }
}

function loadAppsCache() {
  try {
    const cached = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
    if (cached && Array.isArray(cached.apps)) {
      apps = cached.apps;
      scannedAt = Number(cached.scannedAt) || 0;
      mergeCustomApps();
      refreshIconStatus();
      return true;
    }
  } catch (_) {}
  return false;
}

function startIconQueue() {
  if (iconQueueRunning) {
    iconQueueAgain = true;
    return;
  }
  iconQueueRunning = true;
  iconStatus.running = true;

  (async () => {
    try {
      const pending = allApps().filter((app) => app.iconSource && !fs.existsSync(iconPath(app.id)));
      if (!pending.length) return;

      const manifestFile = path.join(DATA_DIR, 'icons.tmp.json');
      const manifest = pending.map((app) => ({
        id: app.id,
        source: app.iconSource,
        fallback: app.target || ''
      }));
      await fsp.writeFile(manifestFile, JSON.stringify(manifest), 'utf8');

      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          path.join(PS_DIR, 'extract-icons.ps1'),
          '-Manifest',
          manifestFile,
          '-OutDir',
          ICON_DIR
        ],
        { windowsHide: true }
      );

      let buffer = '';
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('I:')) iconStatus.done += 1;
        }
      });
      await new Promise((resolve) => {
        child.on('close', resolve);
        child.on('error', resolve);
      });
      refreshIconStatus();
    } catch (error) {
      lastError = '提取图标失败：' + error.message;
    } finally {
      iconQueueRunning = false;
      iconStatus.running = false;
      if (iconQueueAgain) {
        iconQueueAgain = false;
        startIconQueue();
      }
    }
  })();
}

function launchApp(app) {
  if (!app) throw new Error('应用不存在');

  if (app.kind === 'uwp' && app.appid) {
    spawn('explorer.exe', ['shell:AppsFolder\\' + app.appid], {
      stdio: 'ignore',
      windowsHide: true
    });
    return;
  }

  const target = app.lnk || app.target;
  if (!target) throw new Error('找不到该应用的启动路径');

  const env = { ...process.env, APPHUB_LAUNCH_TARGET: target };
  let command = 'Start-Process -FilePath $env:APPHUB_LAUNCH_TARGET';
  if (app.args && app.kind === 'custom') {
    env.APPHUB_LAUNCH_ARGS = app.args;
    command = 'Start-Process -FilePath $env:APPHUB_LAUNCH_TARGET -ArgumentList $env:APPHUB_LAUNCH_ARGS';
  }

  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
    stdio: 'ignore',
    windowsHide: true,
    env
  });
}

async function syncAutostart() {
  try {
    const args = [
      '-AppDir',
      APP_DIR,
      '-Enable',
      state.autostart ? 'true' : 'false'
    ];
    if (process.env.APPHUB_STARTUP_DIR) {
      args.push('-StartupDir', process.env.APPHUB_STARTUP_DIR);
    }
    await runPowerShell('set-autostart.ps1', args, 30000);
    return true;
  } catch (error) {
    lastError = '设置开机自启动失败：' + error.message;
    return false;
  }
}

function openWindow(port) {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  const browser = candidates.find((file) => fs.existsSync(file));
  const url = 'http://' + HOST + ':' + (port || server.address().port) + '/';
  if (browser) {
    const child = spawn(browser, ['--app=' + url, '--start-maximized', '--window-size=1300,820', '--no-first-run', '--no-default-browser-check'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', () => {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    });
    child.unref();
  } else {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > (limit || 2 * 1024 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function bootstrapPayload() {
  let customIcons = new Set();
  try {
    customIcons = new Set(
      fs
        .readdirSync(CUSTOM_ICON_DIR)
        .filter((file) => file.toLowerCase().endsWith('.png'))
        .map((file) => file.slice(0, -4))
    );
  } catch (_) {}
  return {
    apps: allApps().map((app) => ({ ...app, customIcon: customIcons.has(app.id) })),
    state,
    meta: {
      scanning,
      scannedAt,
      iconStatus,
      error: lastError,
      version: 1
    }
  };
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(res, urlPath) {
  let relative;
  try {
    relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
    return;
  }
  const filePath = path.join(WEB_DIR, relative);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  if (req.method === 'GET' && pathname === '/api/bootstrap') {
    sendJson(res, 200, bootstrapPayload());
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, {
      app: 'apphub',
      scanning,
      iconStatus,
      error: lastError,
      appCount: appMap.size,
      scannedAt
    });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/icon/')) {
    const id = pathname.slice('/api/icon/'.length).replace(/\.png$/, '');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
      res.writeHead(400);
      res.end();
      return;
    }
    const customFile = customIconPath(id);
    fs.readFile(customFile, (customError, customData) => {
      if (!customError) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
        res.end(customData);
        return;
      }
      fs.readFile(iconPath(id), (error, data) => {
        if (error) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('no icon');
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache'
        });
        res.end(data);
      });
    });
    return;
  }

  if (req.method === 'POST') {
    let body = {};
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      sendJson(res, 400, { ok: false, error: '请求格式不正确' });
      return;
    }

    if (pathname === '/api/state') {
      const previousAutostart = state.autostart;
      const incoming = body.state || body;
      const merged = sanitizeState(incoming);
      if (!Array.isArray(incoming.custom)) merged.custom = state.custom;
      state = merged;
      mergeCustomApps();
      saveStateSoon();
      if (state.autostart !== previousAutostart) {
        syncAutostart();
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/autostart/sync') {
      const ok = await syncAutostart();
      sendJson(res, ok ? 200 : 500, { ok, autostart: state.autostart, error: ok ? null : lastError });
      return;
    }

    if (pathname === '/api/launch') {
      const app = appMap.get(String(body.id || ''));
      if (!app) {
        sendJson(res, 404, { ok: false, error: '没有找到这个应用' });
        return;
      }
      try {
        launchApp(app);
        sendJson(res, 200, { ok: true, name: app.name });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }

    if (pathname === '/api/rescan') {
      if (!scanning) scanApps({ silent: true });
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/refresh-icons') {
      startIconQueue();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/pick-file') {
      try {
        const stdout = await runPowerShell('pick-file.ps1', [], 180000);
        const picked = stdout.trim().split(/\r?\n/).pop() || '';
        sendJson(res, 200, { ok: true, path: picked });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: '无法打开文件选择窗口：' + error.message });
      }
      return;
    }

    if (pathname === '/api/add') {
      const appPath = cleanText(body.path, 2048);
      if (!appPath || !fs.existsSync(appPath)) {
        sendJson(res, 400, { ok: false, error: '文件不存在，请重新选择' });
        return;
      }
      const args = cleanText(body.args, 500);
      let name = cleanText(body.name, 60);
      if (!name) name = path.basename(appPath).replace(/\.(exe|lnk|bat|cmd|url|appref-ms)$/i, '');
      const id = 'c' + md5(appPath.toLowerCase() + '|' + args).slice(0, 11);

      const existing = state.custom.find((item) => item.id === id);
      if (existing) existing.name = name;
      else {
        state.custom.push({
          id,
          name,
          path: appPath,
          args,
          cwd: path.dirname(appPath),
          addedAt: Date.now()
        });
      }
      mergeCustomApps();
      saveStateSoon();

      const app = appMap.get(id);
      refreshIconStatus();
      startIconQueue();

      sendJson(res, 200, { ok: true, app });
      return;
    }

    if (pathname === '/api/pick-icon') {
      const app = appMap.get(String(body.id || ''));
      if (!app) {
        sendJson(res, 404, { ok: false, error: '没有找到这个应用' });
        return;
      }
      try {
        const stdout = await runPowerShell('pick-image.ps1', [], 180000);
        const picked = stdout.trim().split(/\r?\n/).pop() || '';
        if (!picked) {
          sendJson(res, 200, { ok: true, canceled: true });
          return;
        }
        await runPowerShell(
          'import-icon.ps1',
          ['-Source', picked, '-Dest', customIconPath(app.id)],
          60000
        );
        sendJson(res, 200, { ok: true, customIcon: true });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: '导入图标失败：' + error.message });
      }
      return;
    }

    if (pathname === '/api/set-icon') {
      const app = appMap.get(String(body.id || ''));
      if (!app) {
        sendJson(res, 404, { ok: false, error: '没有找到这个应用' });
        return;
      }
      const match = /^data:image\/(png|jpeg|jpg|bmp|gif);base64,(.+)$/i.exec(String(body.dataUrl || ''));
      if (!match) {
        sendJson(res, 400, { ok: false, error: '不支持这种图片格式，请用 PNG / JPG / BMP / GIF' });
        return;
      }
      try {
        const buffer = Buffer.from(match[2], 'base64');
        if (buffer.length > 8 * 1024 * 1024) {
          sendJson(res, 400, { ok: false, error: '图片太大，请用 8MB 以内的图片' });
          return;
        }
        const tempFile = path.join(DATA_DIR, 'icon-upload.' + match[1].toLowerCase());
        await fsp.writeFile(tempFile, buffer);
        try {
          await runPowerShell(
            'import-icon.ps1',
            ['-Source', tempFile, '-Dest', customIconPath(app.id)],
            60000
          );
        } finally {
          await fsp.unlink(tempFile).catch(() => {});
        }
        sendJson(res, 200, { ok: true, customIcon: true });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: '导入图标失败：' + error.message });
      }
      return;
    }

    if (pathname === '/api/reset-icon') {
      const app = appMap.get(String(body.id || ''));
      if (!app) {
        sendJson(res, 404, { ok: false, error: '没有找到这个应用' });
        return;
      }
      await fsp.unlink(customIconPath(app.id)).catch(() => {});
      sendJson(res, 200, { ok: true, customIcon: false });
      return;
    }

    if (pathname === '/api/reveal') {
      const app = appMap.get(String(body.id || ''));
      const target = app && (app.lnk || app.target);
      if (!target) {
        sendJson(res, 404, { ok: false, error: '找不到文件位置' });
        return;
      }
      if (fs.existsSync(target)) {
        spawn('explorer.exe', ['/select,' + target], { stdio: 'ignore' });
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 404, { ok: false, error: '文件不在原来的位置' });
      }
      return;
    }

    if (pathname === '/api/remove-custom') {
      const id = String(body.id || '');
      state.custom = state.custom.filter((item) => item.id !== id);
      state.hidden = state.hidden.filter((appId) => appId !== id);
      state.order = state.order.filter((key) => key !== 'a:' + id);
      for (const folder of state.folders) {
        folder.apps = folder.apps.filter((appId) => appId !== id);
      }
      mergeCustomApps();
      saveStateSoon();
      refreshIconStatus();
      await fsp.unlink(customIconPath(id)).catch(() => {});
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/api/shortcut') {
      try {
        const vbs = path.join(APP_DIR, '启动应用集合.vbs');
        const stdout = await runPowerShell('make-shortcut.ps1', ['-Vbs', vbs], 60000);
        sendJson(res, 200, { ok: true, path: stdout.trim().split(/\r?\n/).pop() });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message });
      }
      return;
    }
  }

  sendJson(res, 404, { ok: false, error: '未知接口' });
}

const server = http.createServer((req, res) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch (_) {}

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((error) => {
      sendJson(res, 500, { ok: false, error: error.message });
    });
    return;
  }
  serveStatic(res, pathname);
});

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

async function start() {
  ensureDir(DATA_DIR);
  ensureDir(ICON_DIR);
  ensureDir(CUSTOM_ICON_DIR);
  loadState();

  const hasCache = loadAppsCache();
  if (!hasCache) {
    await scanApps({ silent: false });
  } else {
    // Always rescan quietly: picks up newly installed apps and Store apps.
    scanApps({ silent: true });
    startIconQueue();
  }

  let port = BASE_PORT;
  let started = false;
  for (let i = 0; i < 12 && !started; i += 1) {
    const candidate = BASE_PORT + i;
    try {
      await listenOn(candidate);
      port = candidate;
      started = true;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (await isRunningInstance(candidate)) {
        if (OPEN_ON_START) openWindow(candidate);
        console.log('AppHub already running at http://' + HOST + ':' + candidate + '/');
        setTimeout(() => process.exit(0), 300);
        return;
      }
    }
  }

  if (!started) {
    console.error('没有可用端口');
    process.exit(1);
  }

  console.log('AppHub running at http://' + HOST + ':' + port + '/');
  if (OPEN_ON_START) openWindow(port);
  setTimeout(() => {
    syncAutostart();
  }, 1200);
}

function isRunningInstance(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port, path: '/api/status', timeout: 800 }, (response) => {
      let data = '';
      response.on('data', (chunk) => (data += chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(data).app === 'apphub');
        } catch (_) {
          resolve(false);
        }
      });
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
