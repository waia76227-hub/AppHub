'use strict';

const $ = (id) => document.getElementById(id);

const gridEl = $('grid');
const screenEl = $('screen');
const searchEl = $('search');
const menuEl = $('menu');
const toastEl = $('toast');
const folderOverlay = $('folderOverlay');
const folderPanel = $('folderPanel');
const folderTitleEl = $('folderTitle');
const folderGridEl = $('folderGrid');
const modalLayer = $('modalLayer');
const modalEl = $('modal');

const S = {
  apps: [],
  byId: new Map(),
  data: null,
  meta: { scanning: false, iconStatus: { done: 0, total: 0, running: false } },
  query: '',
  failedIcons: new Set(),
  iconVersion: 0,
  openFolderId: null,
  modalOpen: false,
  pollTimer: null,
  lastIconDone: -1,
  lastErrorShown: '',
  drag: { id: null, source: 'home' }
};

const dragScroll = { raf: null, y: 0 };

const THEMES = ['aurora', 'ocean', 'sunset', 'graphite'];

function api(url, options) {
  return fetch(url, options).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '操作失败');
    return data;
  });
}

function post(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function normalizeState(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const folders = Array.isArray(data.folders)
    ? data.folders
        .filter((folder) => folder && typeof folder === 'object')
        .map((folder, index) => ({
          id: String(folder.id || 'f-' + index),
          name: String(folder.name || '文件夹').slice(0, 24),
          color: 'blue',
          apps: Array.isArray(folder.apps) ? folder.apps.filter((id) => typeof id === 'string') : []
        }))
    : [];
  return {
    version: 1,
    folders,
    hidden: Array.isArray(data.hidden) ? data.hidden.filter((id) => typeof id === 'string') : [],
    custom: Array.isArray(data.custom) ? data.custom : [],
    order: Array.isArray(data.order) ? data.order.filter((key) => typeof key === 'string') : [],
    theme: THEMES.includes(data.theme) ? data.theme : 'aurora',
    iconSize: Number.isFinite(Number(data.iconSize))
      ? Math.min(128, Math.max(64, Math.round(Number(data.iconSize) / 2) * 2))
      : 96,
    autostart: data.autostart !== false
  };
}

function applyBootstrap(payload) {
  S.apps = Array.isArray(payload.apps) ? payload.apps : [];
  S.byId = new Map(S.apps.map((app) => [app.id, app]));
  S.data = normalizeState(payload.state);
  S.meta = payload.meta || S.meta;
  S.lastIconDone = S.meta.iconStatus ? S.meta.iconStatus.done : -1;
  S.failedIcons.clear();
  S.iconVersion += 1;
  applyAppearance();
  ensureOrder(false);
  render();
  if (S.openFolderId) renderFolderContent();
}

function applyAppearance() {
  const theme = S.data && THEMES.includes(S.data.theme) ? S.data.theme : 'aurora';
  document.body.classList.remove(...THEMES.map((name) => 'theme-' + name));
  document.body.classList.add('theme-' + theme);
  const size = S.data && S.data.iconSize ? S.data.iconSize : 96;
  document.documentElement.style.setProperty('--icon-size', size + 'px');
}

function splitKey(key) {
  const index = key.indexOf(':');
  return [key.slice(0, index), key.slice(index + 1)];
}

function foldersWithApp(appId) {
  return (S.data ? S.data.folders : []).filter((folder) => folder.apps.includes(appId));
}

function appKey(id) {
  return 'a:' + id;
}

function folderKey(id) {
  return 'f:' + id;
}

function ensureOrder(shouldPersist) {
  if (!S.data) return false;
  const beforeHidden = S.data.hidden.join('|');
  S.data.hidden = S.data.hidden.filter((id) => S.byId.has(id));
  for (const folder of S.data.folders) {
    folder.apps = folder.apps.filter((id) => S.byId.has(id));
  }
  const hiddenChanged = beforeHidden !== S.data.hidden.join('|');
  const hidden = new Set(S.data.hidden);
  const inFolder = new Set();
  for (const folder of S.data.folders) {
    for (const id of folder.apps) inFolder.add(id);
  }
  const valid = new Set();
  for (const folder of S.data.folders) valid.add(folderKey(folder.id));
  for (const app of S.apps) {
    if (!hidden.has(app.id) && !inFolder.has(app.id)) valid.add(appKey(app.id));
  }

  const keys = [];
  const seen = new Set();
  for (const key of S.data.order) {
    if (valid.has(key) && !seen.has(key)) {
      keys.push(key);
      seen.add(key);
    }
  }
  for (const folder of S.data.folders) {
    const key = folderKey(folder.id);
    if (!seen.has(key)) {
      keys.push(key);
      seen.add(key);
    }
  }
  const rest = S.apps
    .filter((app) => !hidden.has(app.id) && !inFolder.has(app.id) && !seen.has(appKey(app.id)))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  for (const app of rest) keys.push(appKey(app.id));

  const changed = keys.join('|') !== S.data.order.join('|');
  S.data.order = keys;
  if (shouldPersist === true || ((changed || hiddenChanged) && shouldPersist !== false)) persist();
  return changed;
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (!S.data) return;
    const payload = { ...S.data, custom: undefined, updatedAt: Date.now() };
    post('/api/state', { state: payload }).catch((error) => toast(error.message));
  }, 320);
}

function letterColors(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  const hue = hash;
  return [`hsl(${hue} 62% 56%)`, `hsl(${(hue + 38) % 360} 66% 46%)`];
}

function letterIcon(app) {
  const node = el('div', 'letter-icon');
  const [a, b] = letterColors(app.name);
  node.style.setProperty('--letter-a', a);
  node.style.setProperty('--letter-b', b);
  node.textContent = (app.name || '?').trim().slice(0, 1).toUpperCase();
  return node;
}

function iconNode(app, boxClass) {
  const box = el('div', boxClass || 'tile-icon');
  if (S.failedIcons.has(app.id)) {
    box.appendChild(letterIcon(app));
    return box;
  }
  const img = new Image();
  img.draggable = false;
  img.alt = '';
  img.src = '/api/icon/' + app.id + '.png?v=' + S.iconVersion;
  img.onerror = () => {
    S.failedIcons.add(app.id);
    box.replaceChildren(letterIcon(app));
  };
  box.appendChild(img);
  return box;
}

function miniIcon(app) {
  const box = el('div', 'mini-icon');
  if (!app) {
    box.classList.add('empty');
    return box;
  }
  if (S.failedIcons.has(app.id)) {
    const letter = el('div', 'mini-letter', (app.name || '?').slice(0, 1));
    const [a, b] = letterColors(app.name);
    letter.style.background = `linear-gradient(145deg, ${a}, ${b})`;
    box.appendChild(letter);
    return box;
  }
  const img = new Image();
  img.draggable = false;
  img.alt = '';
  img.src = '/api/icon/' + app.id + '.png?v=' + S.iconVersion;
  img.onerror = () => {
    S.failedIcons.add(app.id);
    const letter = el('div', 'mini-letter', (app.name || '?').slice(0, 1));
    const [a, b] = letterColors(app.name);
    letter.style.background = `linear-gradient(145deg, ${a}, ${b})`;
    box.replaceChildren(letter);
  };
  box.appendChild(img);
  return box;
}

function findFolderOf(appId) {
  return (S.data && S.data.folders.find((folder) => folder.apps.includes(appId))) || null;
}

function updateMeta() {
  const hiddenCount = S.data ? S.data.hidden.length : 0;
  const visible = S.apps.filter((app) => !S.data.hidden.includes(app.id)).length;
  const title = $('sectionTitle');
  const meta = $('sectionMeta');
  if (S.query.trim()) {
    title.textContent = '搜索结果';
  } else {
    title.textContent = '全部应用';
  }
  if (S.meta.scanning) {
    meta.textContent = '正在扫描应用…';
  } else {
    meta.textContent = `共 ${visible} 个应用${hiddenCount ? ` · 已隐藏 ${hiddenCount} 个` : ''}`;
  }
}

function render() {
  if (!S.data) return;
  $('clearSearch').hidden = !S.query;
  const query = S.query.trim();
  if (query) renderSearch(query);
  else renderHome();
  updateMeta();
}

function renderHome() {
  gridEl.replaceChildren();
  const hidden = new Set(S.data.hidden);
  let index = 0;
  for (const key of S.data.order) {
    const [type, id] = splitKey(key);
    if (type === 'f') {
      const folder = S.data.folders.find((item) => item.id === id);
      if (folder) gridEl.appendChild(folderTile(folder, index++));
    } else {
      const app = S.byId.get(id);
      if (app && !hidden.has(id)) gridEl.appendChild(appTile(app, index++));
    }
  }
  gridEl.appendChild(ghostTile(index));

  if (!S.apps.length && !S.meta.scanning) {
    showEmpty('还没有应用', '点击右上角“添加应用”，把程序加进来。');
  } else if (S.meta.scanning && !S.apps.length) {
    showEmpty('正在整理你的应用…', '第一次启动需要扫描开始菜单和桌面，请稍候。');
  } else {
    hideEmpty();
  }
}

function renderSearch(query) {
  gridEl.replaceChildren();
  const lower = query.toLowerCase();
  const hidden = new Set(S.data.hidden);
  const matchedFolders = S.data.folders.filter((folder) => folder.name.toLowerCase().includes(lower));
  const matchedApps = S.apps.filter((app) => !hidden.has(app.id) && app.name.toLowerCase().includes(lower));

  let index = 0;
  for (const folder of matchedFolders) gridEl.appendChild(folderTile(folder, index++));
  for (const app of matchedApps) {
    const parent = findFolderOf(app.id);
    gridEl.appendChild(appTile(app, index++, parent ? parent.name : ''));
  }

  if (!matchedApps.length && !matchedFolders.length) {
    showEmpty('没有找到匹配的应用', '换个关键词试试，或点击右上角“添加应用”。');
  } else {
    hideEmpty();
  }
}

function showEmpty(title, text) {
  const empty = $('empty');
  empty.hidden = false;
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
}

function hideEmpty() {
  $('empty').hidden = true;
}

function appTile(app, index, subLabel) {
  const tile = el('div', 'tile');
  tile.dataset.app = app.id;
  tile.setAttribute('role', 'listitem');
  tile.tabIndex = 0;
  tile.style.setProperty('--delay', Math.min(index * 16, 260) + 'ms');
  tile.draggable = true;
  tile.title = app.name;

  tile.appendChild(iconNode(app));
  tile.appendChild(el('div', 'tile-label', app.name));
  if (subLabel) tile.appendChild(el('div', 'tile-sub', subLabel));

  tile.addEventListener('click', () => launch(app, tile));
  tile.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      launch(app, tile);
    }
  });
  tile.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openAppMenu(event.clientX, event.clientY, app);
  });
  tile.addEventListener('dragstart', (event) => {
    S.drag.id = app.id;
    S.drag.source = tile.closest('.folder-grid') ? 'folder' : 'home';
    dragScroll.y = event.clientY;
    startDragScroll();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', app.id);
    requestAnimationFrame(() => tile.classList.add('dragging'));
  });
  tile.addEventListener('dragend', () => {
    tile.classList.remove('dragging');
    tile.classList.remove('folder-target', 'reorder-left', 'reorder-right');
    S.drag.id = null;
    S.drag.source = 'home';
    stopDragScroll();
  });
  tile.addEventListener('dragover', (event) => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      tile.classList.add('drop-hover');
      return;
    }
    if (!S.drag.id || S.drag.id === app.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    tile.classList.remove('reorder-left', 'reorder-right', 'folder-target');
    if (!tile.closest('.folder-grid')) {
      const rect = tile.getBoundingClientRect();
      const ratio = (event.clientX - rect.left) / rect.width;
      if (ratio < 0.22) tile.classList.add('reorder-left');
      else if (ratio > 0.78) tile.classList.add('reorder-right');
      else tile.classList.add('folder-target');
    }
  });
  tile.addEventListener('dragleave', () => {
    tile.classList.remove('drop-hover', 'folder-target', 'reorder-left', 'reorder-right');
  });
  tile.addEventListener('drop', async (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) {
      const file = Array.from(files).find((item) => /^image\/(png|jpeg|bmp|gif)$/i.test(item.type));
      if (file) {
        event.preventDefault();
        event.stopPropagation();
        tile.classList.remove('drop-hover');
        await setIconFromFile(app, file);
        return;
      }
    }
    event.preventDefault();
    event.stopPropagation();
    const draggedId = S.drag.id;
    const rect = tile.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const inFolder = Boolean(tile.closest('.folder-grid'));
    tile.classList.remove('drop-hover', 'folder-target', 'reorder-left', 'reorder-right');
    if (!draggedId || draggedId === app.id) return;
    if (inFolder) reorderInFolder(draggedId, app.id);
    else if (ratio >= 0.22 && ratio <= 0.78) createFolderFromApps(draggedId, app.id);
    else reorderHome(draggedId, app.id, event.clientX, tile);
  });
  return tile;
}

function folderTile(folder, index) {
  const tile = el('div', 'tile folder-tile');
  tile.dataset.folder = folder.id;
  tile.setAttribute('role', 'listitem');
  tile.tabIndex = 0;
  tile.style.setProperty('--delay', Math.min(index * 16, 260) + 'ms');
  tile.title = folder.name;

  const box = el('div', 'tile-icon');
  box.appendChild(el('div', 'folder-count', String(folder.apps.length)));
  const preview = el('div', 'folder-preview');
  const apps = folder.apps.map((id) => S.byId.get(id)).filter(Boolean).slice(0, 9);
  if (apps.length > 4) preview.classList.add('dense');
  if (!apps.length) {
    const glyph = el('div', 'folder-glyph');
    glyph.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3.6 7.4h6.1l1.9 2h9.2v8.4a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 17.8V7.4z"/><path d="M3.6 7.4V5.9c0-.5.4-.9.9-.9h4.2l1.9 2"/></svg>';
    preview.appendChild(glyph);
  } else {
    for (const app of apps) preview.appendChild(miniIcon(app));
  }
  box.appendChild(preview);
  tile.appendChild(box);
  tile.appendChild(el('div', 'tile-label', folder.name));

  tile.addEventListener('click', () => openFolder(folder.id));
  tile.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openFolder(folder.id);
    }
  });
  tile.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openFolderMenu(event.clientX, event.clientY, folder);
  });
  tile.addEventListener('dragover', (event) => {
    if (!S.drag.id) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    tile.classList.add('drop-hover');
  });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop-hover'));
  tile.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    tile.classList.remove('drop-hover');
    if (S.drag.id) addAppToFolder(S.drag.id, folder.id);
  });
  return tile;
}

function ghostTile(index) {
  const tile = el('div', 'tile ghost-tile');
  tile.style.setProperty('--delay', Math.min(index * 16, 260) + 'ms');
  const box = el('div', 'tile-icon');
  box.appendChild(el('div', 'ghost-plus', '＋'));
  tile.appendChild(box);
  tile.appendChild(el('div', 'tile-label', '新建文件夹'));
  tile.addEventListener('click', () => createFolder());
  tile.addEventListener('dragover', (event) => {
    if (!S.drag.id) return;
    event.preventDefault();
    event.stopPropagation();
    tile.classList.add('drop-hover');
  });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop-hover'));
  tile.addEventListener('drop', (event) => {
    event.preventDefault();
    event.stopPropagation();
    tile.classList.remove('drop-hover');
    if (S.drag.id) createFolder(S.drag.id);
  });
  return tile;
}

async function launch(app, tile) {
  if (tile) {
    tile.classList.remove('launching');
    void tile.offsetWidth;
    tile.classList.add('launching');
  }
  try {
    await post('/api/launch', { id: app.id });
    toast('正在打开 ' + app.name);
  } catch (error) {
    toast(error.message);
  }
}

function dragScrollStep() {
  dragScroll.raf = null;
  if (!S.drag.id || dragScroll.y <= 0 || dragScroll.y >= window.innerHeight) return;

  let container = screenEl;
  if (S.openFolderId) {
    const panelRect = folderPanel.getBoundingClientRect();
    if (dragScroll.y >= panelRect.top && dragScroll.y <= panelRect.bottom) container = folderPanel;
  }

  const rect = container.getBoundingClientRect();
  const edge = Math.min(120, rect.height * 0.24);
  let delta = 0;

  if (dragScroll.y < rect.top + edge) {
    const strength = Math.min(1, (rect.top + edge - dragScroll.y) / edge);
    delta = -Math.round(2 + strength * 24);
  } else if (dragScroll.y > rect.bottom - edge) {
    const strength = Math.min(1, (dragScroll.y - (rect.bottom - edge)) / edge);
    delta = Math.round(2 + strength * 24);
  }

  if (delta) {
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(maxTop, container.scrollTop + delta));
  }

  dragScroll.raf = requestAnimationFrame(dragScrollStep);
}

function startDragScroll() {
  if (dragScroll.raf) return;
  dragScroll.raf = requestAnimationFrame(dragScrollStep);
}

function stopDragScroll() {
  if (dragScroll.raf) cancelAnimationFrame(dragScroll.raf);
  dragScroll.raf = null;
}

function reorderHome(draggedId, targetId, clientX, targetEl) {
  const order = S.data.order;
  const fromKey = appKey(draggedId);
  const toKey = appKey(targetId);
  const fromIndex = order.indexOf(fromKey);
  const toIndex = order.indexOf(toKey);
  if (fromIndex < 0 || toIndex < 0) return;
  const rect = targetEl.getBoundingClientRect();
  const after = clientX > rect.left + rect.width / 2;
  order.splice(fromIndex, 1);
  let insertIndex = order.indexOf(toKey);
  if (after) insertIndex += 1;
  order.splice(insertIndex, 0, fromKey);
  persist();
  render();
}

function reorderInFolder(draggedId, targetId) {
  const folder = S.data.folders.find((item) => item.apps.includes(draggedId) && item.apps.includes(targetId));
  if (!folder) return;
  const fromIndex = folder.apps.indexOf(draggedId);
  const toIndex = folder.apps.indexOf(targetId);
  if (fromIndex < 0 || toIndex < 0) return;
  folder.apps.splice(fromIndex, 1);
  folder.apps.splice(folder.apps.indexOf(targetId), 0, draggedId);
  persist();
  renderFolderContent();
}

function removeFromAllFolders(appId) {
  for (const folder of S.data.folders) {
    folder.apps = folder.apps.filter((id) => id !== appId);
  }
}

function addAppToFolder(appId, folderId) {
  const folder = S.data.folders.find((item) => item.id === folderId);
  if (!folder) return;
  removeFromAllFolders(appId);
  folder.apps.push(appId);
  S.data.order = S.data.order.filter((key) => key !== appKey(appId));
  persist();
  render();
  if (S.openFolderId) renderFolderContent();
  toast('已加入「' + folder.name + '」');
}

function removeAppFromFolder(appId) {
  const folder = findFolderOf(appId);
  if (!folder) return;
  folder.apps = folder.apps.filter((id) => id !== appId);
  S.data.order.push(appKey(appId));
  persist();
  render();
  if (S.openFolderId) renderFolderContent();
  toast('已移出「' + folder.name + '」');
}

function hideApp(appId) {
  const app = S.byId.get(appId);
  if (!app) return;
  removeFromAllFolders(appId);
  S.data.order = S.data.order.filter((key) => key !== appKey(appId));
  if (!S.data.hidden.includes(appId)) S.data.hidden.push(appId);
  persist();
  render();
  if (S.openFolderId) renderFolderContent();
  toast('已隐藏「' + app.name + '」');
}

function restoreApp(appId) {
  S.data.hidden = S.data.hidden.filter((id) => id !== appId);
  if (!S.data.order.includes(appKey(appId))) S.data.order.push(appKey(appId));
  persist();
  render();
  const app = S.byId.get(appId);
  toast('已恢复「' + (app ? app.name : '应用') + '」');
}

function openFolder(folderId) {
  S.openFolderId = folderId;
  folderOverlay.hidden = false;
  renderFolderContent();
}

function closeFolder() {
  folderOverlay.hidden = true;
  S.openFolderId = null;
}

function renderFolderContent() {
  const folder = S.data.folders.find((item) => item.id === S.openFolderId);
  if (!folder) {
    closeFolder();
    return;
  }
  folderTitleEl.value = folder.name;
  const apps = folder.apps.map((id) => S.byId.get(id)).filter(Boolean);
  $('folderSubtitle').textContent = `${apps.length} 个应用`;
  folderGridEl.replaceChildren();
  if (!apps.length) {
    folderGridEl.appendChild(el('div', 'folder-empty', '文件夹还是空的，点下面的「添加应用」就能放进来'));
  } else {
    apps.forEach((app, index) => {
      const tile = appTile(app, index);
      folderGridEl.appendChild(tile);
    });
  }
  folderGridEl.appendChild(folderGhostTile(folder));
}

function folderGhostTile(folder) {
  const tile = el('div', 'tile ghost-tile');
  const box = el('div', 'tile-icon');
  box.appendChild(el('div', 'ghost-plus', '＋'));
  tile.appendChild(box);
  tile.appendChild(el('div', 'tile-label', '添加应用'));
  tile.addEventListener('click', () => openFolderAppPicker(folder));
  return tile;
}

function pickerIcon(app) {
  const box = el('div', 'row-icon');
  if (!S.failedIcons.has(app.id)) {
    const img = new Image();
    img.src = '/api/icon/' + app.id + '.png?v=' + S.iconVersion;
    img.onerror = () => box.replaceChildren(letterIcon(app));
    box.appendChild(img);
  } else {
    box.appendChild(letterIcon(app));
  }
  return box;
}

function openFolderAppPicker(folder) {
  const hidden = new Set(S.data.hidden);
  const available = S.apps
    .filter((app) => !hidden.has(app.id) && !folder.apps.includes(app.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  openModal({
    title: '添加到「' + folder.name + '」',
    text: '点一下应用就会放进文件夹，可以连续添加。',
    body: (container) => {
      const searchField = el('div', 'field');
      const input = document.createElement('input');
      input.placeholder = '搜索应用';
      searchField.appendChild(input);
      container.appendChild(searchField);

      const list = el('div', 'pick-list');
      container.appendChild(list);

      const renderList = (query) => {
        list.replaceChildren();
        const keyword = (query || '').trim().toLowerCase();
        const filtered = available.filter(
          (app) => !folder.apps.includes(app.id) && (!keyword || app.name.toLowerCase().includes(keyword))
        );
        if (!filtered.length) {
          list.appendChild(el('div', 'pick-empty', keyword ? '没有找到应用' : '所有应用都已经在这个文件夹里了'));
          return;
        }
        for (const app of filtered) {
          const row = el('div', 'pick-row');
          row.appendChild(pickerIcon(app));
          row.appendChild(el('span', '', app.name));
          row.addEventListener('click', () => {
            addAppToFolder(app.id, folder.id);
            row.remove();
            if (!list.querySelector('.pick-row')) {
              list.appendChild(el('div', 'pick-empty', '所有应用都已经在这个文件夹里了'));
            }
          });
          list.appendChild(row);
        }
      };

      input.addEventListener('input', () => renderList(input.value));
      renderList('');
      setTimeout(() => input.focus(), 60);
    },
    actions: [{ label: '完成', subtle: true, onClick: closeModal }]
  });
}

async function deleteFolder() {
  const folder = S.data.folders.find((item) => item.id === S.openFolderId);
  if (!folder) return;
  const ok = await confirmDialog('解散这个文件夹？', `「${folder.name}」里的 ${folder.apps.length} 个应用会回到桌面。`, '解散');
  if (!ok) return;
  S.data.folders = S.data.folders.filter((item) => item.id !== folder.id);
  S.data.order = S.data.order.filter((key) => key !== folderKey(folder.id));
  folder.apps.forEach((id) => {
    if (!S.data.hidden.includes(id) && !S.data.order.includes(appKey(id))) S.data.order.push(appKey(id));
  });
  persist();
  closeFolder();
  render();
  toast('文件夹已解散');
}

async function createFolder(appIdToAdd) {
  const name = await promptDialog('新建文件夹', '给文件夹起个名字，比如「游戏」「办公」「影音」。', '新文件夹');
  if (!name) return;
  const folder = {
    id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    color: 'blue',
    apps: []
  };
  if (appIdToAdd) {
    removeFromAllFolders(appIdToAdd);
    folder.apps.push(appIdToAdd);
    S.data.order = S.data.order.filter((key) => key !== appKey(appIdToAdd));
  }
  S.data.folders.push(folder);
  S.data.order.push(folderKey(folder.id));
  persist();
  render();
  toast('已创建「' + name + '」');
}

async function createFolderFromApps(dragId, targetId) {
  if (!dragId || !targetId || dragId === targetId) return;
  if (findFolderOf(dragId) || findFolderOf(targetId)) return;

  const name = await promptDialog(
    '合成文件夹',
    '把这两个应用放进同一个文件夹，起个名字吧。',
    '新建文件夹'
  );
  if (!name) return;

  const folder = {
    id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name,
    color: 'blue',
    apps: [targetId, dragId]
  };
  const targetKey = appKey(targetId);
  const dragKey = appKey(dragId);
  const index = S.data.order.indexOf(targetKey);
  S.data.order = S.data.order.filter((key) => key !== dragKey && key !== targetKey);
  S.data.folders.push(folder);
  if (index >= 0) S.data.order.splice(Math.min(index, S.data.order.length), 0, folderKey(folder.id));
  else S.data.order.push(folderKey(folder.id));

  persist();
  render();
  toast('已创建「' + name + '」');
}

function showMenu(x, y, items) {
  menuEl.replaceChildren();
  for (const item of items) {
    if (item.sep) {
      menuEl.appendChild(el('div', 'menu-sep'));
      continue;
    }
    const row = el('div', 'menu-item' + (item.danger ? ' danger' : ''));
    row.appendChild(el('span', 'mi-icon', item.icon || ''));
    row.appendChild(el('span', '', item.label));
    row.addEventListener('click', () => {
      hideMenu();
      item.action();
    });
    menuEl.appendChild(row);
  }
  menuEl.hidden = false;
  menuEl.style.left = '0px';
  menuEl.style.top = '0px';
  const rect = menuEl.getBoundingClientRect();
  menuEl.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + 'px';
  menuEl.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + 'px';
}

function hideMenu() {
  menuEl.hidden = true;
}

function openAppMenu(x, y, app) {
  const parent = findFolderOf(app.id);
  const items = [
    { icon: '↗', label: '打开', action: () => launch(app) },
    { icon: '▣', label: '添加到文件夹…', action: () => pickFolderForApp(app) },
    parent ? { icon: '↩', label: '移出「' + parent.name + '」', action: () => removeAppFromFolder(app.id) } : null,
    { icon: '▧', label: '更换图标…', action: () => changeIcon(app) },
    app.customIcon ? { icon: '↺', label: '恢复默认图标', action: () => resetIcon(app) } : null,
    { icon: '◌', label: '隐藏这个应用', action: () => hideApp(app.id) },
    { icon: '⌖', label: '打开文件所在位置', action: () => revealApp(app) },
    app.custom ? { sep: true } : null,
    app.custom
      ? { icon: '✕', label: '从列表移除', danger: true, action: () => removeCustomApp(app) }
      : null
  ].filter(Boolean);
  showMenu(x, y, items);
}

function openFolderMenu(x, y, folder) {
  showMenu(x, y, [
    { icon: '↗', label: '打开文件夹', action: () => openFolder(folder.id) },
    { icon: '✎', label: '重命名…', action: () => renameFolder(folder) },
    { sep: true },
    { icon: '⌫', label: '解散文件夹', danger: true, action: async () => {
      const ok = await confirmDialog('解散这个文件夹？', `「${folder.name}」里的应用会回到桌面。`, '解散');
      if (!ok) return;
      S.data.folders = S.data.folders.filter((item) => item.id !== folder.id);
      S.data.order = S.data.order.filter((key) => key !== folderKey(folder.id));
      folder.apps.forEach((id) => {
        if (!S.data.hidden.includes(id) && !S.data.order.includes(appKey(id))) S.data.order.push(appKey(id));
      });
      persist();
      render();
      toast('文件夹已解散');
    } }
  ]);
}

function openDesktopMenu(x, y) {
  showMenu(x, y, [
    { icon: '＋', label: '新建文件夹', action: () => createFolder() },
    { icon: '⊞', label: '添加应用…', action: () => openAddApp() },
    { sep: true },
    { icon: '◌', label: `已隐藏的应用${S.data.hidden.length ? '（' + S.data.hidden.length + '）' : ''}`, action: () => openHiddenManager() },
    { icon: '↻', label: '重新扫描应用', action: rescan },
    { sep: true },
    { icon: '⛶', label: '全屏显示（F11）', action: () => toggleFullscreen() },
    { icon: '◨', label: '外观与图标大小…', action: () => openAppearance() },
    {
      icon: S.data.autostart ? '✓' : '○',
      label: S.data.autostart ? '开机自启动：已开启' : '开机自启动：已关闭',
      action: () => toggleAutostart()
    },
    { icon: '⇅', label: '按名称重新排列', action: sortByName },
    { icon: '⌗', label: '创建桌面快捷方式', action: createDesktopShortcut }
  ]);
}

async function renameFolder(folder) {
  const name = await promptDialog('重命名文件夹', '', folder.name);
  if (!name) return;
  folder.name = name;
  persist();
  render();
  if (S.openFolderId === folder.id) folderTitleEl.value = name;
}

async function pickFolderForApp(app) {
  const folders = S.data.folders;
  openModal({
    title: '把「' + app.name + '」放进文件夹',
    text: folders.length ? '选择一个文件夹，或者新建一个。' : '还没有文件夹，先新建一个吧。',
    body: (container) => {
      if (folders.length) {
        const list = el('div', 'pick-list');
        for (const folder of folders) {
          const row = el('div', 'pick-row');
          const icon = el('div', 'row-icon');
          icon.textContent = '▣';
          row.appendChild(icon);
          row.appendChild(el('span', '', folder.name));
          row.appendChild(el('span', 'tile-sub', folder.apps.length + ' 个'));
          row.addEventListener('click', () => {
            closeModal();
            addAppToFolder(app.id, folder.id);
          });
          list.appendChild(row);
        }
        container.appendChild(list);
      }
    },
    actions: [
      { label: '取消', subtle: true, onClick: closeModal },
      { label: '新建文件夹并加入', primary: true, onClick: () => { closeModal(); createFolder(app.id); } }
    ]
  });
}

async function revealApp(app) {
  try {
    await post('/api/reveal', { id: app.id });
  } catch (error) {
    toast(error.message);
  }
}

async function changeIcon(app) {
  try {
    const result = await post('/api/pick-icon', { id: app.id });
    if (!result || result.canceled) return;
    app.customIcon = true;
    S.failedIcons.delete(app.id);
    S.iconVersion += 1;
    render();
    if (S.openFolderId) renderFolderContent();
    toast('已更换「' + app.name + '」的图标');
  } catch (error) {
    toast(error.message);
  }
}

async function resetIcon(app) {
  try {
    await post('/api/reset-icon', { id: app.id });
    app.customIcon = false;
    S.failedIcons.delete(app.id);
    S.iconVersion += 1;
    render();
    if (S.openFolderId) renderFolderContent();
    toast('已恢复「' + app.name + '」的默认图标');
  } catch (error) {
    toast(error.message);
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

async function setIconFromFile(app, file) {
  if (file.size > 8 * 1024 * 1024) {
    toast('图片太大了，请用 8MB 以内的图片');
    return;
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    await post('/api/set-icon', { id: app.id, dataUrl });
    app.customIcon = true;
    S.failedIcons.delete(app.id);
    S.iconVersion += 1;
    render();
    if (S.openFolderId) renderFolderContent();
    toast('已用这张图片替换「' + app.name + '」的图标');
  } catch (error) {
    toast(error.message);
  }
}

async function removeCustomApp(app) {
  const ok = await confirmDialog('从列表中移除？', `「${app.name}」只是从应用集合里移除，不会卸载或删除文件。`, '移除');
  if (!ok) return;
  try {
    await post('/api/remove-custom', { id: app.id });
    S.apps = S.apps.filter((item) => item.id !== app.id);
    S.byId.delete(app.id);
    S.data.order = S.data.order.filter((key) => key !== appKey(app.id));
    removeFromAllFolders(app.id);
    persist();
    render();
    toast('已移除');
  } catch (error) {
    toast(error.message);
  }
}

function openHiddenManager() {
  const hiddenApps = S.data.hidden.map((id) => S.byId.get(id)).filter(Boolean);
  openModal({
    title: '已隐藏的应用',
    text: hiddenApps.length ? '恢复后会回到桌面。' : '这里还没有隐藏的应用。右键任意应用即可隐藏。',
    body: (container) => {
      if (!hiddenApps.length) return;
      const list = el('div', 'hidden-list');
      for (const app of hiddenApps) {
        const row = el('div', 'hidden-row');
        const icon = el('div', 'row-icon');
        if (!S.failedIcons.has(app.id)) {
          const img = new Image();
          img.src = '/api/icon/' + app.id + '.png?v=' + S.iconVersion;
          img.onerror = () => icon.replaceChildren(letterIcon(app));
          icon.appendChild(img);
        } else {
          icon.appendChild(letterIcon(app));
        }
        row.appendChild(icon);
        row.appendChild(el('div', 'row-name', app.name));
        const btn = el('button', 'btn subtle small', '恢复');
        btn.addEventListener('click', () => {
          restoreApp(app.id);
          closeModal();
          openHiddenManager();
        });
        row.appendChild(btn);
        list.appendChild(row);
      }
      container.appendChild(list);
    },
    actions: [
      { label: '关闭', subtle: true, onClick: closeModal },
      hiddenApps.length
        ? { label: '全部恢复', primary: true, onClick: () => {
            S.data.hidden.slice().forEach((id) => restoreApp(id));
            closeModal();
          } }
        : null
    ].filter(Boolean)
  });
}

function openAddApp() {
  openModal({
    title: '添加应用',
    text: '选择任意程序（.exe / .lnk）加入桌面，也可以直接粘贴完整路径。',
    body: (container) => {
      const nameField = el('div', 'field');
      nameField.appendChild(el('label', '', '显示名称（可选）'));
      const nameInput = document.createElement('input');
      nameInput.placeholder = '留空则自动使用程序名';
      nameInput.maxLength = 60;
      nameField.appendChild(nameInput);
      container.appendChild(nameField);

      const pathField = el('div', 'field');
      pathField.appendChild(el('label', '', '程序路径'));
      const row = el('div', 'field-row');
      const pathInput = document.createElement('input');
      pathInput.placeholder = 'C:\\Program Files\\…\\应用.exe';
      const browse = el('button', 'btn subtle', '浏览…');
      browse.type = 'button';
      browse.addEventListener('click', async () => {
        browse.disabled = true;
        browse.textContent = '请稍候…';
        try {
          const result = await post('/api/pick-file', {});
          if (result.path) {
            pathInput.value = result.path;
            if (!nameInput.value) {
              nameInput.value = result.path.split(/[\\/]/).pop().replace(/\.(exe|lnk|bat|cmd|url)$/i, '');
            }
          }
        } catch (error) {
          toast(error.message);
        } finally {
          browse.disabled = false;
          browse.textContent = '浏览…';
        }
      });
      row.appendChild(pathInput);
      row.appendChild(browse);
      pathField.appendChild(row);
      container.appendChild(pathField);

      const argsField = el('div', 'field');
      argsField.appendChild(el('label', '', '启动参数（一般不用填）'));
      const argsInput = document.createElement('input');
      argsInput.placeholder = '可选';
      argsField.appendChild(argsInput);
      container.appendChild(argsField);

      container.dataset.readName = '1';
      container._read = () => ({
        name: nameInput.value.trim(),
        path: pathInput.value.trim(),
        args: argsInput.value.trim()
      });
      setTimeout(() => (pathInput.value ? nameInput : pathInput).focus(), 60);
    },
    actions: [
      { label: '取消', subtle: true, onClick: closeModal },
      { label: '加入桌面', primary: true, onClick: async () => {
          const form = modalEl.querySelector('.modal-body');
          const value = form._read();
          if (!value.path) {
            toast('请先选择程序文件');
            return;
          }
          const buttons = modalEl.querySelectorAll('.modal-actions .btn');
          buttons.forEach((btn) => (btn.disabled = true));
          try {
            const result = await post('/api/add', value);
            const app = result.app;
            if (!S.byId.has(app.id)) S.apps.push(app);
            S.byId.set(app.id, app);
            S.data.order.unshift(appKey(app.id));
            persist();
            closeModal();
            render();
            toast('已加入「' + app.name + '」');
            startPolling();
          } catch (error) {
            toast(error.message);
            buttons.forEach((btn) => (btn.disabled = false));
          }
        } }
    ]
  });
}

function openAppearance() {
  const names = { aurora: '极光', ocean: '深海', sunset: '落日', graphite: '石墨' };
  openModal({
    title: '外观设置',
    text: '挑一个喜欢的桌面氛围，拖动滑杆调整图标大小，改动会立刻生效。',
    body: (container) => {
      const themeSection = el('div', 'settings-section');
      themeSection.appendChild(el('div', 'settings-label', '壁纸'));
      const grid = el('div', 'theme-grid');
      const cards = [];
      for (const theme of THEMES) {
        const card = el('div', 'theme-card' + (S.data.theme === theme ? ' active' : ''));
        card.appendChild(el('div', 'theme-swatch swatch-' + theme));
        card.appendChild(el('div', 'theme-name', names[theme]));
        card.addEventListener('click', () => {
          S.data.theme = theme;
          applyAppearance();
          cards.forEach((item) => item.classList.toggle('active', item === card));
          persist();
        });
        cards.push(card);
        grid.appendChild(card);
      }
      themeSection.appendChild(grid);
      container.appendChild(themeSection);

      const sizeSection = el('div', 'settings-section');
      const sizeRow = el('div', 'settings-row');
      sizeRow.appendChild(el('span', 'settings-label', '图标大小'));
      const sizeValue = el('span', 'settings-value', S.data.iconSize + ' px');
      sizeRow.appendChild(sizeValue);
      sizeSection.appendChild(sizeRow);

      const range = document.createElement('input');
      range.type = 'range';
      range.min = '64';
      range.max = '128';
      range.step = '4';
      range.value = String(S.data.iconSize);
      range.className = 'size-range';
      range.addEventListener('input', () => {
        S.data.iconSize = Number(range.value);
        sizeValue.textContent = S.data.iconSize + ' px';
        applyAppearance();
      });
      range.addEventListener('change', persist);
      sizeSection.appendChild(range);

      const rangeLabels = el('div', 'range-labels');
      rangeLabels.appendChild(el('span', '', '小'));
      rangeLabels.appendChild(el('span', '', '大'));
      sizeSection.appendChild(rangeLabels);
      container.appendChild(sizeSection);
    },
    actions: [{ label: '完成', primary: true, onClick: closeModal }]
  });
}

function sortByName() {
  const folders = S.data.order.filter((key) => key.startsWith('f:'));
  const apps = S.apps
    .filter((app) => !S.data.hidden.includes(app.id) && !findFolderOf(app.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .map((app) => appKey(app.id));
  S.data.order = [...folders, ...apps];
  persist();
  render();
  toast('已按名称排列');
}

function toggleFullscreen() {
  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.postMessage('toggle-fullscreen');
    toast('F11 或 Esc 可以切换全屏');
    return;
  }
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}

async function toggleAutostart() {
  S.data.autostart = !S.data.autostart;
  persist();
  try {
    await post('/api/autostart/sync', {});
    toast(S.data.autostart ? '已开启开机自启动' : '已关闭开机自启动');
  } catch (error) {
    toast(error.message);
  }
}

async function rescan() {
  try {
    await post('/api/rescan', {});
    toast('正在重新扫描应用…');
    S.meta.scanning = true;
    render();
    startPolling();
  } catch (error) {
    toast(error.message);
  }
}

async function createDesktopShortcut() {
  try {
    const result = await post('/api/shortcut', {});
    toast('桌面快捷方式已创建');
    if (result.path) console.log('shortcut:', result.path);
  } catch (error) {
    toast(error.message);
  }
}

function openModal(options) {
  pendingModal = null;
  S.modalOpen = true;
  modalEl.replaceChildren();
  modalEl.appendChild(el('div', 'modal-title', options.title));
  if (options.text) modalEl.appendChild(el('div', 'modal-text', options.text));

  const body = el('div', 'modal-body');
  if (options.body) options.body(body);
  modalEl.appendChild(body);

  const actions = el('div', 'modal-actions');
  for (const action of options.actions || []) {
    const btn = el('button', 'btn' + (action.primary ? ' primary' : action.subtle ? ' subtle' : ''), action.label);
    btn.type = 'button';
    btn.addEventListener('click', action.onClick);
    actions.appendChild(btn);
  }
  modalEl.appendChild(actions);
  modalLayer.hidden = false;
}

function closeModal() {
  modalLayer.hidden = true;
  modalEl.replaceChildren();
  S.modalOpen = false;
}

let pendingModal = null;

function dismissModal() {
  if (pendingModal) {
    const resolve = pendingModal;
    pendingModal = null;
    resolve();
  }
  closeModal();
}

function promptDialog(title, text, defaultValue) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      pendingModal = null;
      resolve(value);
    };
    pendingModal = () => done(null);
    openModal({
      title,
      text,
      body: (container) => {
        const field = el('div', 'field');
        const input = document.createElement('input');
        input.value = defaultValue || '';
        input.maxLength = 24;
        input.placeholder = '文件夹名称';
        field.appendChild(input);
        container.appendChild(field);
        setTimeout(() => {
          input.focus();
          input.select();
        }, 50);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            const value = input.value.trim();
            if (value) {
              closeModal();
              done(value);
            }
          }
        });
        container._input = input;
      },
      actions: [
        { label: '取消', subtle: true, onClick: () => { closeModal(); done(null); } },
        { label: '确定', primary: true, onClick: () => {
            const input = modalEl.querySelector('.modal-body input');
            const value = input.value.trim();
            if (!value) {
              input.focus();
              return;
            }
            closeModal();
            done(value);
          } }
      ]
    });
  });
}

function confirmDialog(title, text, confirmLabel) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      pendingModal = null;
      resolve(value);
    };
    pendingModal = () => done(false);
    openModal({
      title,
      text,
      actions: [
        { label: '取消', subtle: true, onClick: () => { closeModal(); done(false); } },
        { label: confirmLabel || '确定', primary: true, onClick: () => { closeModal(); done(true); } }
      ]
    });
  });
}

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  document.body.classList.add('toasting');
  toastEl.style.animation = 'none';
  void toastEl.offsetWidth;
  toastEl.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
    document.body.classList.remove('toasting');
  }, 2400);
}

function tickClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  $('clock').textContent = hh + ':' + mm;
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  $('date').textContent = `${now.getMonth() + 1}月${now.getDate()}日 星期${weekdays[now.getDay()]}`;
}

function startPolling() {
  clearInterval(S.pollTimer);
  S.pollTimer = setInterval(async () => {
    try {
      const status = await api('/api/status');
      const done = status.iconStatus ? status.iconStatus.done : 0;
      if (done !== S.lastIconDone) {
        S.lastIconDone = done;
        S.failedIcons.clear();
        S.iconVersion += 1;
        render();
        if (S.openFolderId) renderFolderContent();
      }
      if (S.meta.scanning && !status.scanning) {
        const payload = await api('/api/bootstrap');
        applyBootstrap(payload);
      } else if (!status.scanning && (!status.iconStatus || !status.iconStatus.running)) {
        clearInterval(S.pollTimer);
      }
      if (status.error && status.error !== S.lastErrorShown) {
        S.lastErrorShown = status.error;
        toast(status.error);
      }
    } catch (_) {}
  }, 1400);
}

function bindEvents() {
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault();
    }
  });
  window.addEventListener('drop', (event) => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) {
      event.preventDefault();
    }
  });
  window.addEventListener(
    'dragover',
    (event) => {
      if (S.drag.id) {
        dragScroll.y = event.clientY;
        startDragScroll();
      }
    },
    true
  );
  window.addEventListener(
    'dragend',
    () => {
      stopDragScroll();
      S.drag.id = null;
      S.drag.source = 'home';
    },
    true
  );
  window.addEventListener('drop', stopDragScroll, true);

  searchEl.addEventListener('input', () => {
    S.query = searchEl.value;
    render();
  });
  $('clearSearch').addEventListener('click', () => {
    searchEl.value = '';
    S.query = '';
    render();
    searchEl.focus();
  });
  $('addBtn').addEventListener('click', openAddApp);
  $('moreBtn').addEventListener('click', (event) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openDesktopMenu(rect.right - 210, rect.bottom + 8);
  });

  gridEl.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.tile')) return;
    event.preventDefault();
    openDesktopMenu(event.clientX, event.clientY);
  });
  screenEl.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.tile')) return;
    event.preventDefault();
    openDesktopMenu(event.clientX, event.clientY);
  });
  gridEl.addEventListener('dragover', (event) => {
    if (!S.drag.id) return;
    event.preventDefault();
  });
  gridEl.addEventListener('drop', (event) => {
    if (!S.drag.id) return;
    event.preventDefault();
    const key = appKey(S.drag.id);
    if (!S.data.order.includes(key)) S.data.order.push(key);
    persist();
    render();
  });

  document.addEventListener('click', (event) => {
    if (!menuEl.hidden && !event.target.closest('.menu')) hideMenu();
  });
  window.addEventListener('blur', hideMenu);
  window.addEventListener('resize', hideMenu);

  folderOverlay.addEventListener('click', (event) => {
    if (event.target === folderOverlay) closeFolder();
  });
  $('folderCloseBtn').addEventListener('click', closeFolder);
  $('folderDeleteBtn').addEventListener('click', deleteFolder);
  folderTitleEl.addEventListener('change', () => {
    const folder = S.data.folders.find((item) => item.id === S.openFolderId);
    if (!folder) return;
    const value = folderTitleEl.value.trim();
    if (!value) {
      folderTitleEl.value = folder.name;
      return;
    }
    folder.name = value;
    persist();
    render();
  });
  folderTitleEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') folderTitleEl.blur();
  });
  folderGridEl.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.tile')) return;
    event.preventDefault();
  });
  folderGridEl.addEventListener('dragover', (event) => {
    if (S.drag.id) event.preventDefault();
  });
  folderGridEl.addEventListener('drop', (event) => {
    if (!S.drag.id) return;
    event.preventDefault();
    const folder = S.data.folders.find((item) => item.id === S.openFolderId);
    if (folder && !folder.apps.includes(S.drag.id)) {
      removeFromAllFolders(S.drag.id);
      folder.apps.push(S.drag.id);
      S.data.order = S.data.order.filter((key) => key !== appKey(S.drag.id));
      persist();
      renderFolderContent();
      render();
    }
  });

  modalLayer.addEventListener('click', (event) => {
    if (event.target === modalLayer) dismissModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'F11') {
      event.preventDefault();
      toggleFullscreen();
      return;
    }
    if (event.key === 'Escape') {
      if (S.modalOpen) dismissModal();
      else if (!menuEl.hidden) hideMenu();
      else if (S.openFolderId) closeFolder();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchEl.focus();
      searchEl.select();
    }
  });
}

async function boot() {
  bindEvents();
  tickClock();
  setInterval(tickClock, 15000);
  try {
    const payload = await api('/api/bootstrap');
    applyBootstrap(payload);
    ensureOrder(true);
    post('/api/autostart/sync', {}).catch(() => {});
    startPolling();
  } catch (error) {
    showEmpty('启动失败', error.message);
    toast(error.message);
  }
}

boot();
