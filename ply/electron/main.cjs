const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

app.setName('PLY Chess Arena');
let mainWindow = null;
let arenaServer = null;
let quitting = false;
const ownsInstance = app.requestSingleInstanceLock();

function externalUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

async function createWindow() {
  const root = path.join(__dirname, '..');
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) throw new Error('The PLY interface has not been built. Run pnpm install, then pnpm build, in the PLY folder.');
  const { startServer } = await import(pathToFileURL(path.join(root, 'server', 'index.mjs')).href);
  const dataDir = process.env.PLY_DATA_DIR || path.join(app.getPath('userData'), 'arena');
  // A fixed port keeps invite links working across restarts; fall back if something else holds it.
  try { arenaServer = await startServer({ port: Number(process.env.PLY_PORT) || 4816, dataDir }); }
  catch (error) { if (error.code !== 'EADDRINUSE') throw error; arenaServer = await startServer({ port: 0, dataDir }); }
  const appUrl = `http://127.0.0.1:${arenaServer.port}/`;
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 740,
    title: 'PLY — Chess Arena',
    backgroundColor: '#f8f8f8',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const target = externalUrl(url);
    if (target && new URL(target).origin !== new URL(appUrl).origin) void shell.openExternal(target).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    const target = externalUrl(url);
    if (target && new URL(target).origin !== new URL(appUrl).origin) void shell.openExternal(target).catch(() => {});
  });
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('page-title-updated', event => event.preventDefault());
  mainWindow.once('ready-to-show', () => { mainWindow?.show(); mainWindow?.focus(); });
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(appUrl);
}

if (!ownsInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(createWindow).catch(error => {
    dialog.showErrorBox('PLY could not start', String(error.message || error));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !arenaServer) return;
    event.preventDefault();
    quitting = true;
    const active = arenaServer;
    arenaServer = null;
    void active.close().catch(() => {}).finally(() => app.quit());
  });
}
