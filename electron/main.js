const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const runtimeDir = path.join(app.getPath('userData'), 'runtime');
const tunnelInfoPath = path.join(runtimeDir, 'tunnel-info.json');
const serverEntry = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar', 'server.js')
  : path.join(projectRoot, 'server.js');
const cloudflaredPath = app.isPackaged
  ? path.join(process.resourcesPath, 'tools', 'cloudflared.exe')
  : path.join(projectRoot, 'tools', 'cloudflared.exe');
const backendCwd = app.isPackaged ? process.resourcesPath : projectRoot;

const backendState = {
  signalRunning: false,
  tunnelRunning: false,
  signalPid: null,
  tunnelPid: null,
  tunnelUrl: null,
  wsUrl: null,
  lastError: null
};

let signalProc = null;
let tunnelProc = null;

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

  win.loadFile(path.join(projectRoot, 'renderer', 'index.html'));
}

function broadcast(channel, payload) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send(channel, payload);
  }
}

function sendUpdaterStatus(message) {
  broadcast('updater-status', message);
}

function emitBackendStatus(extraMessage) {
  const payload = {
    ...backendState,
    message: extraMessage || null
  };
  broadcast('backend-status', payload);
}

function safeUnlinkTunnelInfo() {
  try {
    if (fs.existsSync(tunnelInfoPath)) {
      fs.unlinkSync(tunnelInfoPath);
    }
  } catch {
    // ignore
  }
}

function writeTunnelInfo(url) {
  const wsUrl = url.replace(/^https:/i, 'wss:') + '/signal';
  backendState.tunnelUrl = url;
  backendState.wsUrl = wsUrl;

  fs.mkdirSync(path.dirname(tunnelInfoPath), { recursive: true });
  fs.writeFileSync(
    tunnelInfoPath,
    JSON.stringify({ url, wsUrl, updatedAt: new Date().toISOString() }, null, 2)
  );
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

function startSignalServer() {
  let reuseExternalSignal = false;

  if (signalProc && !signalProc.killed) {
    backendState.signalRunning = true;
    backendState.signalPid = signalProc.pid || null;
    return;
  }

  signalProc = spawn(process.execPath, [serverEntry], {
    cwd: backendCwd,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  backendState.signalPid = signalProc.pid || null;
  backendState.signalRunning = true;

  signalProc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('Signaling server listening')) {
      backendState.signalRunning = true;
      emitBackendStatus('Signaling server started.');
    }
  });

  signalProc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('EADDRINUSE')) {
      reuseExternalSignal = true;
      backendState.signalRunning = true;
      backendState.signalPid = null;
      backendState.lastError = 'Port 3000 already in use (reusing existing signaling server).';
      emitBackendStatus(backendState.lastError);
      return;
    }

    backendState.lastError = text.trim();
    emitBackendStatus(`Signal error: ${backendState.lastError}`);
  });

  signalProc.on('error', (error) => {
    backendState.signalRunning = false;
    backendState.signalPid = null;
    backendState.lastError = `Signal spawn failed: ${error.message}`;
    emitBackendStatus(backendState.lastError);
  });

  signalProc.on('exit', () => {
    signalProc = null;
    if (reuseExternalSignal) {
      backendState.signalRunning = true;
      backendState.signalPid = null;
      emitBackendStatus('Using existing signaling server on port 3000.');
      return;
    }

    backendState.signalRunning = false;
    backendState.signalPid = null;
    emitBackendStatus('Signaling server stopped.');
  });
}

function startTunnel() {
  if (tunnelProc && !tunnelProc.killed) {
    backendState.tunnelRunning = true;
    backendState.tunnelPid = tunnelProc.pid || null;
    return;
  }

  if (!fs.existsSync(cloudflaredPath)) {
    backendState.lastError = `cloudflared not found at ${cloudflaredPath}`;
    emitBackendStatus(backendState.lastError);
    throw new Error(backendState.lastError);
  }

  tunnelProc = spawn(cloudflaredPath, ['tunnel', '--url', 'http://localhost:3000'], {
    cwd: backendCwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  backendState.tunnelPid = tunnelProc.pid || null;
  backendState.tunnelRunning = true;
  const tryUrlRegex = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

  function handleChunk(chunk) {
    const text = chunk.toString();
    const match = text.match(tryUrlRegex);
    if (match && match[1]) {
      writeTunnelInfo(match[1]);
      emitBackendStatus(`Tunnel ready: ${backendState.wsUrl}`);
    }

    if (text.toLowerCase().includes('error')) {
      backendState.lastError = text.trim();
      emitBackendStatus(`Tunnel error: ${backendState.lastError}`);
    }
  }

  tunnelProc.stdout.on('data', handleChunk);
  tunnelProc.stderr.on('data', handleChunk);

  tunnelProc.on('error', (error) => {
    backendState.tunnelRunning = false;
    backendState.tunnelPid = null;
    backendState.lastError = `Tunnel spawn failed: ${error.message}`;
    emitBackendStatus(backendState.lastError);
  });

  tunnelProc.on('exit', () => {
    tunnelProc = null;
    backendState.tunnelRunning = false;
    backendState.tunnelPid = null;
    emitBackendStatus('Cloudflare tunnel stopped.');
  });
}

function stopBackend() {
  if (tunnelProc && !tunnelProc.killed) {
    try {
      tunnelProc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  if (signalProc && !signalProc.killed) {
    try {
      signalProc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  backendState.signalRunning = false;
  backendState.tunnelRunning = false;
  backendState.signalPid = null;
  backendState.tunnelPid = null;
  backendState.tunnelUrl = null;
  backendState.wsUrl = null;
  safeUnlinkTunnelInfo();
  emitBackendStatus('Backend services stopped.');
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

app.on('before-quit', () => {
  stopBackend();
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

ipcMain.handle('start-backend', async () => {
  try {
    backendState.lastError = null;
    startSignalServer();
    startTunnel();
    emitBackendStatus('Starting signaling + tunnel...');
    return { ok: true, ...backendState };
  } catch (error) {
    backendState.lastError = error.message;
    emitBackendStatus(`Backend start failed: ${backendState.lastError}`);
    return { ok: false, error: error.message, ...backendState };
  }
});

ipcMain.handle('stop-backend', () => {
  stopBackend();
  return { ok: true, ...backendState };
});

ipcMain.handle('backend-status', () => {
  try {
    const wsUrl = fs.existsSync(tunnelInfoPath)
      ? JSON.parse(fs.readFileSync(tunnelInfoPath, 'utf-8'))?.wsUrl || null
      : null;

    if (wsUrl) {
      backendState.wsUrl = wsUrl;
      backendState.tunnelUrl = wsUrl.replace(/^wss:/i, 'https:').replace(/\/signal$/, '');
    }
  } catch {
    // ignore
  }

  return { ...backendState };
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
