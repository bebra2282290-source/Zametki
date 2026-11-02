'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  screen,
  shell,
  nativeImage,
} = require('electron');
const { NotesStore, COLORS } = require('./store');

const APP_ID = 'com.rsh8.zametki';
const APP_TITLE = 'Заметки';
const ASSETS = path.join(__dirname, '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload.js');
const ICON_PATH = path.join(ASSETS, process.platform === 'win32' ? 'icon.ico' : 'icon.png');

/** Фон окон заметок — те же оттенки, что и в renderer/theme.css. */
const NOTE_BG = {
  cream: '#FFF7E8',
  peach: '#FFEADF',
  rose: '#FCE8E8',
  honey: '#FFF2C7',
  sage: '#ECF1E0',
  lavender: '#F0EAF6',
  latte: '#F3E9DE',
};
const LIST_BG = '#FBF5EC';

const NOTE_DEFAULT_SIZE = { width: 300, height: 320 };
const NOTE_MIN_SIZE = { width: 220, height: 180 };
const CASCADE_STEP = 28;

const WELCOME_NOTE = {
  title: 'Привет!',
  body: [
    'Это ваша первая заметка. Что она умеет:',
    '',
    '📌 Булавка вверху — окно будет поверх всех остальных.',
    '✋ Тяните за верхнюю полоску, чтобы переместить.',
    '↘ Тяните за край или уголок, чтобы изменить размер.',
    '⋯ В меню — цвет, прозрачность и размер текста.',
    '+ Плюс слева — новая заметка.',
    '',
    'Всё сохраняется само.',
  ].join('\n'),
  color: 'peach',
};
const WELCOME_SIZE = { width: 340, height: 380 };

// ---------------------------------------------------------------------------
// Один экземпляр приложения
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showListWindow());
  start();
}

let store;
let tray = null;
let listWindow = null;
let isQuitting = false;
/** id заметки → BrowserWindow */
const noteWindows = new Map();

function start() {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);

  app.whenReady().then(() => {
    store = new NotesStore(path.join(app.getPath('userData'), 'notes.json')).load();

    if (store.isFirstRun) {
      const area = screen.getPrimaryDisplay().workArea;
      store.create({
        ...WELCOME_NOTE,
        open: true,
        bounds: {
          ...WELCOME_SIZE,
          x: area.x + area.width - WELCOME_SIZE.width - 64,
          y: area.y + 64,
        },
      });
    }

    registerIpc();
    try {
      createTray();
    } catch (err) {
      // Без трея приложение тоже работает: закрытие списка тогда просто закрывает его.
      console.error('Не удалось создать значок в трее:', err);
      tray = null;
    }

    const startHidden = process.argv.includes('--hidden');
    let opened = 0;
    for (const note of store.list()) {
      if (note.open) {
        openNoteWindow(note.id, { focus: false });
        opened += 1;
      }
    }
    if (!startHidden || opened === 0) showListWindow();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (store) store.flush();
  });

  // Приложение живёт в трее, пока его явно не закроют.
  app.on('window-all-closed', () => {
    if (isQuitting || !tray) app.quit();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('context-menu', (_e, params) => showContextMenu(contents, params));
  });
}

// ---------------------------------------------------------------------------
// Окно со списком заметок
// ---------------------------------------------------------------------------

function showListWindow() {
  if (listWindow && !listWindow.isDestroyed()) {
    if (listWindow.isMinimized()) listWindow.restore();
    listWindow.show();
    listWindow.focus();
    return listWindow;
  }

  const saved = store.getSetting('listBounds', null);
  const bounds = saved && isVisibleOnSomeDisplay(saved) ? saved : centeredBounds(440, 600);

  listWindow = new BrowserWindow({
    ...bounds,
    minWidth: 340,
    minHeight: 420,
    show: false,
    title: APP_TITLE,
    icon: ICON_PATH,
    backgroundColor: LIST_BG,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: LIST_BG, symbolColor: '#7A5F4C', height: 44 },
    webPreferences: secureWebPreferences(),
  });

  listWindow.loadFile(path.join(RENDERER, 'list.html'));
  listWindow.once('ready-to-show', () => listWindow.show());

  const saveBounds = debounce(() => {
    if (listWindow && !listWindow.isDestroyed() && !listWindow.isMinimized()) {
      store.setSetting('listBounds', listWindow.getNormalBounds());
    }
  }, 400);
  listWindow.on('move', saveBounds);
  listWindow.on('resize', saveBounds);

  listWindow.on('close', (event) => {
    if (isQuitting || !tray) return;
    // Крестик прячет список в трей — заметки продолжают жить.
    event.preventDefault();
    listWindow.hide();
    if (!store.getSetting('trayHintShown', false) && process.platform === 'win32') {
      tray.displayBalloon({
        iconType: 'info',
        title: 'Заметки остаются под рукой',
        content: 'Приложение работает в трее рядом с часами. Нажмите на значок, чтобы открыть список.',
      });
      store.setSetting('trayHintShown', true);
    }
  });

  // Windows выключается или пользователь выходит из системы — сохраняемся.
  listWindow.on('query-session-end', () => {
    isQuitting = true;
    store.flush();
  });
  listWindow.on('session-end', () => {
    isQuitting = true;
    store.flush();
  });

  listWindow.on('closed', () => {
    listWindow = null;
  });

  return listWindow;
}

const broadcastNotes = debounce(() => {
  if (listWindow && !listWindow.isDestroyed()) {
    listWindow.webContents.send('notes:changed', store.list());
  }
  refreshTrayMenu();
}, 120);

// ---------------------------------------------------------------------------
// Окна заметок
// ---------------------------------------------------------------------------

function openNoteWindow(id, { focus = true, near = null } = {}) {
  const existing = noteWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    if (focus) existing.focus();
    return existing;
  }

  const note = store.get(id);
  if (!note) return null;

  let bounds = note.bounds && isVisibleOnSomeDisplay(note.bounds) ? note.bounds : null;
  if (!bounds) {
    bounds = newNoteBounds(near);
    store.update(id, { bounds });
  }

  const win = new BrowserWindow({
    ...bounds,
    minWidth: NOTE_MIN_SIZE.width,
    minHeight: NOTE_MIN_SIZE.height,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: noteTitle(note),
    icon: ICON_PATH,
    backgroundColor: NOTE_BG[note.color] || NOTE_BG.cream,
    alwaysOnTop: note.pinned,
    webPreferences: secureWebPreferences(),
  });

  if (note.pinned) win.setAlwaysOnTop(true, 'floating');
  if (note.opacity < 1) win.setOpacity(note.opacity);

  noteWindows.set(id, win);
  win.loadFile(path.join(RENDERER, 'note.html'), { query: { id } });

  win.once('ready-to-show', () => {
    if (focus) win.show();
    else win.showInactive();
  });

  const saveBounds = debounce(() => {
    if (!win.isDestroyed() && !win.isMinimized()) {
      store.update(id, { bounds: win.getNormalBounds() });
    }
  }, 400);
  win.on('move', saveBounds);
  win.on('resize', saveBounds);

  win.on('closed', () => {
    noteWindows.delete(id);
    // При выходе из приложения заметки остаются «открытыми» и вернутся при запуске.
    if (!isQuitting && store.has(id)) store.update(id, { open: false });
    if (!isQuitting) broadcastNotes();
  });

  if (!note.open) store.update(id, { open: true });
  broadcastNotes();
  return win;
}

function createNote(fields = {}, near = null) {
  const note = store.create({ ...fields, open: true, bounds: null });
  openNoteWindow(note.id, { focus: true, near });
  broadcastNotes();
  return note;
}

function closeNoteWindow(id) {
  const win = noteWindows.get(id);
  if (win && !win.isDestroyed()) win.close();
}

function deleteNote(id) {
  const win = noteWindows.get(id);
  store.remove(id);
  if (win && !win.isDestroyed()) win.destroy();
  noteWindows.delete(id);
  broadcastNotes();
}

function setPinned(id, pinned) {
  const result = store.update(id, { pinned });
  if (!result) return null;
  const win = noteWindows.get(id);
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(pinned, 'floating');
    sendNoteMeta(id);
  }
  broadcastNotes();
  return result.note;
}

function sendNoteMeta(id) {
  const win = noteWindows.get(id);
  const note = store.get(id);
  if (!win || win.isDestroyed() || !note) return;
  win.webContents.send('note:meta', {
    pinned: note.pinned,
    color: note.color,
    opacity: note.opacity,
    fontSize: note.fontSize,
  });
}

function showAllNotes() {
  for (const note of store.list()) openNoteWindow(note.id, { focus: false });
}

function hideAllNotes() {
  for (const id of [...noteWindows.keys()]) closeNoteWindow(id);
}

function noteTitle(note) {
  const text = (note.title || note.body || '').trim().split('\n')[0];
  return text ? `${text.slice(0, 60)} — ${APP_TITLE}` : `Заметка — ${APP_TITLE}`;
}

// ---------------------------------------------------------------------------
// Расположение окон
// ---------------------------------------------------------------------------

function newNoteBounds(near) {
  const { width, height } = NOTE_DEFAULT_SIZE;
  if (near) {
    const candidate = { x: near.x + CASCADE_STEP, y: near.y + CASCADE_STEP, width, height };
    if (isFullyInsideWorkArea(candidate)) return candidate;
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const step = noteWindows.size % 8;
  return {
    x: Math.round(area.x + area.width - width - 48 - step * CASCADE_STEP),
    y: Math.round(area.y + 48 + step * CASCADE_STEP),
    width,
    height,
  };
}

function centeredBounds(width, height) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width: Math.min(width, area.width),
    height: Math.min(height, area.height),
  };
}

/** Окно видно хотя бы на 80×40 px какого-нибудь монитора (монитор могли отключить). */
function isVisibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return w >= 80 && h >= 40;
  });
}

function isFullyInsideWorkArea(bounds) {
  return screen.getAllDisplays().some(
    ({ workArea: a }) =>
      bounds.x >= a.x &&
      bounds.y >= a.y &&
      bounds.x + bounds.width <= a.x + a.width &&
      bounds.y + bounds.height <= a.y + a.height,
  );
}

// ---------------------------------------------------------------------------
// Трей
// ---------------------------------------------------------------------------

function createTray() {
  const image = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip(APP_TITLE);
  tray.on('click', () => showListWindow());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const hasNotes = store.list().length > 0;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Новая заметка', click: () => createNote() },
      { label: 'Все заметки', click: () => showListWindow() },
      { type: 'separator' },
      { label: 'Показать все заметки', enabled: hasNotes, click: showAllNotes },
      { label: 'Спрятать все заметки', enabled: noteWindows.size > 0, click: hideAllNotes },
      { type: 'separator' },
      { label: 'Выход', click: () => app.quit() },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Контекстное меню (в Electron его нет по умолчанию)
// ---------------------------------------------------------------------------

function showContextMenu(contents, params) {
  const template = [];
  if (params.misspelledWord && params.dictionarySuggestions.length) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      template.push({
        label: suggestion,
        click: () => contents.replaceMisspelling(suggestion),
      });
    }
    template.push({ type: 'separator' });
  }
  if (params.isEditable) {
    template.push(
      { label: 'Отменить', role: 'undo', enabled: params.editFlags.canUndo },
      { label: 'Повторить', role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { label: 'Вырезать', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Копировать', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Вставить', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Выделить всё', role: 'selectAll' },
    );
  } else if (params.selectionText) {
    template.push({ label: 'Копировать', role: 'copy' });
  }
  if (template.length) Menu.buildFromTemplate(template).popup();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  const validId = (id) => typeof id === 'string' && store.has(id);
  const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle('notes:list', () => store.list());
  ipcMain.handle('note:get', (_e, id) => (validId(id) ? store.get(id) : null));

  ipcMain.handle('note:create', (event) => {
    const source = senderWindow(event);
    const near = source && source !== listWindow ? source.getBounds() : null;
    return createNote({}, near).id;
  });

  ipcMain.on('note:update', (_e, id, patch) => {
    if (!validId(id) || !patch || typeof patch !== 'object') return;
    const { title, body } = patch;
    const result = store.update(id, { title, body });
    if (result && result.contentChanged) {
      const win = noteWindows.get(id);
      if (win && !win.isDestroyed()) win.setTitle(noteTitle(result.note));
      broadcastNotes();
    }
  });

  ipcMain.handle('note:open', (_e, id) => {
    if (validId(id)) openNoteWindow(id, { focus: true });
  });

  ipcMain.handle('note:close', (_e, id) => {
    if (validId(id)) closeNoteWindow(id);
  });

  ipcMain.handle('note:delete', (_e, id) => {
    if (validId(id)) deleteNote(id);
  });

  ipcMain.handle('note:setPinned', (_e, id, pinned) => {
    if (!validId(id) || typeof pinned !== 'boolean') return null;
    return setPinned(id, pinned);
  });

  ipcMain.handle('note:setColor', (_e, id, color) => {
    if (!validId(id) || !COLORS.includes(color)) return null;
    store.update(id, { color });
    const win = noteWindows.get(id);
    if (win && !win.isDestroyed()) win.setBackgroundColor(NOTE_BG[color]);
    sendNoteMeta(id);
    broadcastNotes();
    return store.get(id);
  });

  ipcMain.handle('note:setOpacity', (_e, id, opacity) => {
    if (!validId(id) || typeof opacity !== 'number') return null;
    const result = store.update(id, { opacity });
    const win = noteWindows.get(id);
    if (win && !win.isDestroyed()) win.setOpacity(result.note.opacity);
    return result.note;
  });

  ipcMain.handle('note:setFontSize', (_e, id, fontSize) => {
    if (!validId(id) || typeof fontSize !== 'number') return null;
    return store.update(id, { fontSize }).note;
  });

  ipcMain.on('window:setSize', (event, width, height) => {
    const win = senderWindow(event);
    if (!win || win === listWindow) return;
    if (![width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    const [minW, minH] = win.getMinimumSize();
    win.setSize(Math.max(minW, Math.round(width)), Math.max(minH, Math.round(height)));
  });

  ipcMain.on('window:minimize', (event) => {
    const win = senderWindow(event);
    if (win) win.minimize();
  });

  ipcMain.handle('app:showList', () => {
    showListWindow();
  });
  ipcMain.handle('app:showAll', () => showAllNotes());
  ipcMain.handle('app:hideAll', () => hideAllNotes());

  ipcMain.handle('settings:get', () => ({
    openAtLogin: getOpenAtLogin(),
    canOpenAtLogin: app.isPackaged && process.platform === 'win32',
  }));

  ipcMain.handle('settings:setOpenAtLogin', (_e, value) => {
    if (typeof value !== 'boolean') return getOpenAtLogin();
    if (app.isPackaged && process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: value, path: launchPath(), args: ['--hidden'] });
    }
    return getOpenAtLogin();
  });
}

/** Для portable-версии exe распаковывается во временную папку — берём путь к исходному файлу. */
function launchPath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function getOpenAtLogin() {
  if (!(app.isPackaged && process.platform === 'win32')) return false;
  return app.getLoginItemSettings({ path: launchPath(), args: ['--hidden'] }).openAtLogin;
}

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

function secureWebPreferences() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: true,
  };
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
