'use strict';
/* Dota Mate Overlay: прозрачное окно без рамки поверх игры. Это тонкая обёртка: вся логика в ../overlay.html и ../js/*.
   Окно загружает только локальный файл overlay.html, переходы по ссылкам внутри окна запрещены, внешние ссылки открываются в браузере.
   Запуск: cd overlay-app && npm install && npm start. Пока не проверено на настоящем Dota 2 (см. README, раздел «Оверлей»). */
const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const HOTKEY_RE = /^((Ctrl|Alt|Shift)\+){1,3}[A-Z0-9]$/;
const OPEN_OK = /^https:\/\/(www\.opendota\.com|label777\.github\.io)\//;
let win = null, hotkey = 'Alt+Shift+D';
const boundsFile = () => path.join(app.getPath('userData'), 'bounds.json');
function loadBounds() { try { const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); return ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) ? b : null; } catch (e) { return null; } }
function saveBounds() { try { if (win && !win.isDestroyed()) fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds())); } catch (e) { /* положение не сохранилось: не критично */ } }

function createWindow() {
  const b = loadBounds() || { width: 780, height: 560 };
  win = new BrowserWindow(Object.assign({}, b, {
    frame: false, transparent: true, alwaysOnTop: true, resizable: true, skipTaskbar: true, hasShadow: false, show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  }));
  win.setAlwaysOnTop(true, 'screen-saver');                  // поверх окон без рамки; поверх «настоящего» полноэкранного режима Windows это не гарантирует
  win.loadFile(path.join(__dirname, '..', 'overlay.html'), { query: { embed: '1' } });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (OPEN_OK.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('moved', saveBounds); win.on('resized', saveBounds);
  win.on('closed', () => { win = null; });
}

function toggle() { if (!win) return; if (win.isVisible()) win.hide(); else win.show(); win.webContents.send('overlay:toggled', win.isVisible()); }
function setHotkey(k) {
  if (typeof k !== 'string' || !HOTKEY_RE.test(k)) return false;
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(k, toggle);
  if (ok) hotkey = k; else globalShortcut.register(hotkey, toggle);
  return ok;
}

app.whenReady().then(() => {
  createWindow(); setHotkey(hotkey);
  ipcMain.on('overlay:hide', () => { if (win) win.hide(); });
  ipcMain.on('overlay:show', () => { if (win) win.show(); });
  ipcMain.on('overlay:hotkey', (_e, k) => { setHotkey(k); });
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
