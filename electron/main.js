const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}
const fs = require('fs');
const path = require('path');

const tunnelInfoPath = path.join(__dirname, '..', 'runtime', 'tunnel-info.json');

// WGC can freeze/fail on some Windows systems; force legacy desktop capturer path.
if (app?.commandLine?.appendSwitch) {
  app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer,AllowWgcWindowCapturer,AllowWgcZeroHz');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 980,
    minHeight: 720,
    backgroundColor: '#10131c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function sendUpdaterStatus(message) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send('updater-status', message);
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged || !autoUpdater) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => sendUpdaterStatus('Checking for updates...'));
  autoUpdater.on('update-available', () => sendUpdaterStatus('Update available. Downloading...'));
  autoUpdater.on('update-not-available', () => sendUpdaterStatus('App is up to date.'));
  autoUpdater.on('update-downloaded', () => sendUpdaterStatus('Update downloaded. Restart app to apply.'));
  autoUpdater.on('error', (err) => sendUpdaterStatus(`Update error: ${err.message}`));

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // ignore updater failures in misconfigured environments
    });
  }, 3000);
}

app.whenReady().then(() => {
  setupAutoUpdater();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('list-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 }
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name
  }));
});

ipcMain.handle('get-tunnel-url', () => {
  try {
    if (!fs.existsSync(tunnelInfoPath)) return null;
    const raw = fs.readFileSync(tunnelInfoPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed?.wsUrl || null;
  } catch {
    return null;
  }
});

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged || !autoUpdater) {
    return { ok: false, error: 'Update checks run only in installed builds.' };
  }

  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});