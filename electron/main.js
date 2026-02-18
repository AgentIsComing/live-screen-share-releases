const { app, BrowserWindow, ipcMain, desktopCapturer, Menu } = require('electron');
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  autoUpdater = null;
}
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

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
const updaterServiceDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'LiveScreenShareUpdater');
const updaterServiceNoticePath = path.join(updaterServiceDir, 'notice.json');
const updaterServiceInstallScript = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar', 'scripts', 'install_update_service.js')
  : path.join(projectRoot, 'scripts', 'install_update_service.js');
const updaterServiceUninstallScript = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar', 'scripts', 'uninstall_update_service.js')
  : path.join(projectRoot, 'scripts', 'uninstall_update_service.js');

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
let updateDownloaded = false;
let pendingUpdaterServiceTask = null;

if (app?.commandLine?.appendSwitch) {
  app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer,AllowWgcWindowCapturer,AllowWgcZeroHz');
}

{
  const args = new Set(process.argv.map((value) => String(value || '').toLowerCase()));
  if (args.has('--install-updater-service')) {
    pendingUpdaterServiceTask = 'install';
  }
  if (args.has('--uninstall-updater-service')) {
    pendingUpdaterServiceTask = 'uninstall';
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1300,
    height: 900,
    minWidth: 980,
    minHeight: 720,
    autoHideMenuBar: true,
    backgroundColor: '#10131c',
    icon: path.join(projectRoot, 'assets', 'app.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  Menu.setApplicationMenu(null);
  win.setMenuBarVisibility(false);
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


function readUpdaterServiceNotice() {
  try {
    if (!fs.existsSync(updaterServiceNoticePath)) return null;
    return JSON.parse(fs.readFileSync(updaterServiceNoticePath, 'utf-8'));
  } catch {
    return null;
  }
}

function clearUpdaterServiceNotice() {
  try {
    if (fs.existsSync(updaterServiceNoticePath)) {
      fs.unlinkSync(updaterServiceNoticePath);
    }
  } catch {
    // ignore
  }
}

function runSilentInstaller(installerPath) {
  const escaped = String(installerPath || '').replace(/'/g, "''");
  const command = `Start-Process -FilePath '${escaped}' -ArgumentList '/S' -WindowStyle Hidden`;
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  }).unref();
}

function maybeNotifyUpdaterServiceReady() {
  const notice = readUpdaterServiceNotice();
  if (!notice || notice.status !== 'ready' || !notice.version) return;
  sendUpdaterStatus(`Background update ${notice.version} is ready. Click Check app updates to install now.`);
}

function hasUpdaterServiceInstalled() {
  if (process.platform !== 'win32') return false;
  try {
    const output = execSync('sc query "LiveScreenShareUpdaterService"', {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString();
    return !/does not exist/i.test(output);
  } catch {
    return false;
  }
}

function runUpdaterServiceScript(task) {
  const scriptPath = task === 'uninstall' ? updaterServiceUninstallScript : updaterServiceInstallScript;
  if (!fs.existsSync(scriptPath)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        RELEASE_OWNER: process.env.RELEASE_OWNER || 'AgentIsComing',
        RELEASE_REPO: process.env.RELEASE_REPO || 'live-screen-share-releases'
      },
      windowsHide: true,
      stdio: 'ignore'
    });

    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function ensureUpdaterServiceInstalled() {
  if (process.platform !== 'win32') return;
  if (hasUpdaterServiceInstalled()) return;
  await runUpdaterServiceScript('install');
}
function normalizeWsUrl(value) {
  const wsUrl = String(value || '').trim();
  if (!/^wss?:\/\//i.test(wsUrl)) {
    throw new Error('Signaling URL must start with ws:// or wss://');
  }
  return wsUrl;
}

function normalizeServiceBaseUrl(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error('Code service URL is required.');
  }
  if (!/^https?:\/\//i.test(base)) {
    throw new Error('Code service URL must start with http:// or https://');
  }
  return base;
}

function normalizeRoomId(value) {
  const roomId = String(value || '').trim();
  if (!roomId) {
    throw new Error('Room ID is required.');
  }
  return roomId;
}

function normalizePassword(value) {
  const password = String(value || '');
  if (!password || password.length < 4) {
    throw new Error('Room password must be at least 4 characters.');
  }
  return password;
}

async function callCodeService(baseUrl, route, body) {
  const endpoint = `${normalizeServiceBaseUrl(baseUrl)}${route}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const detail = data?.error || `${response.status} ${response.statusText}`;
    throw new Error(`Code service request failed: ${detail}`);
  }

  return data;
}

function setupAutoUpdater() {
  if (!app.isPackaged || !autoUpdater) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => sendUpdaterStatus('Checking for updates...'));
  autoUpdater.on('update-available', () => {
    updateDownloaded = false;
    sendUpdaterStatus('Update available. Downloading in background...');
  });
  autoUpdater.on('update-not-available', () => {
    updateDownloaded = false;
    sendUpdaterStatus('App is up to date.');
  });
  autoUpdater.on('update-downloaded', () => {
    updateDownloaded = true;
    sendUpdaterStatus('Update downloaded. Click Check app updates to install now.');
  });
  autoUpdater.on('error', (err) => sendUpdaterStatus(`Update error: ${err.message}`));

  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // ignore
    });
  }, 3000);

  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      // ignore
    });
  }, 30 * 60 * 1000);
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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  backendState.signalPid = signalProc.pid || null;
  backendState.signalRunning = true;

  signalProc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('Signaling server listening')) {
      emitBackendStatus('Signaling server started.');
    }
  });

  signalProc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('EADDRINUSE')) {
      reuseExternalSignal = true;
      backendState.signalRunning = true;
      backendState.signalPid = null;
      emitBackendStatus('Port 3000 already in use (reusing existing signaling server).');
      return;
    }
    backendState.lastError = text.trim();
    emitBackendStatus(`Signal error: ${backendState.lastError}`);
  });

  signalProc.on('error', (error) => {
    backendState.signalRunning = false;
    backendState.signalPid = null;
    emitBackendStatus(`Signal spawn failed: ${error.message}`);
  });

  signalProc.on('exit', () => {
    signalProc = null;
    if (reuseExternalSignal) {
      backendState.signalRunning = true;
      backendState.signalPid = null;
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
    throw new Error(`cloudflared not found at ${cloudflaredPath}`);
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
  }

  tunnelProc.stdout.on('data', handleChunk);
  tunnelProc.stderr.on('data', handleChunk);

  tunnelProc.on('error', (error) => {
    backendState.tunnelRunning = false;
    backendState.tunnelPid = null;
    emitBackendStatus(`Tunnel spawn failed: ${error.message}`);
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
    try { tunnelProc.kill('SIGTERM'); } catch {}
  }
  if (signalProc && !signalProc.killed) {
    try { signalProc.kill('SIGTERM'); } catch {}
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

  setTimeout(() => maybeNotifyUpdaterServiceReady(), 3500);
  setInterval(() => maybeNotifyUpdaterServiceReady(), 60 * 1000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => stopBackend());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app-version', () => app.getVersion());

ipcMain.handle('list-desktop-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 }
  });
  return sources.map((source) => ({ id: source.id, name: source.name }));
});

ipcMain.handle('get-tunnel-url', () => {
  try {
    if (!fs.existsSync(tunnelInfoPath)) return null;
    const raw = fs.readFileSync(tunnelInfoPath, 'utf-8');
    return JSON.parse(raw)?.wsUrl || null;
  } catch {
    return null;
  }
});

ipcMain.handle('register-room-access', async (_event, payload = {}) => {
  try {
    const result = await callCodeService(payload.baseUrl, '/register-room', {
      roomId: normalizeRoomId(payload.roomId),
      password: normalizePassword(payload.password),
      wsUrl: normalizeWsUrl(payload.wsUrl),
      ttlSeconds: Number(payload.ttlSeconds || 900)
    });
    return { ok: true, roomId: result.roomId, expiresAt: result.expiresAt || null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('resolve-room-access', async (_event, payload = {}) => {
  try {
    const result = await callCodeService(payload.baseUrl, '/resolve-room', {
      roomId: normalizeRoomId(payload.roomId),
      password: normalizePassword(payload.password)
    });
    return { ok: true, roomId: result.roomId, wsUrl: result.wsUrl };
  } catch (error) {
    return { ok: false, error: error.message };
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
  } catch {}
  return { ...backendState };
});

ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged || !autoUpdater) {
    return { ok: false, error: 'Update checks run only in installed builds.' };
  }

  try {
    const serviceNotice = readUpdaterServiceNotice();
    if (serviceNotice?.status === 'ready' && serviceNotice?.installerPath && fs.existsSync(serviceNotice.installerPath)) {
      sendUpdaterStatus(`Installing background update ${serviceNotice.version || ''}...`);
      runSilentInstaller(serviceNotice.installerPath);
      clearUpdaterServiceNotice();
      setTimeout(() => app.quit(), 350);
      return { ok: true, installing: true, source: 'service' };
    }

    if (updateDownloaded) {
      sendUpdaterStatus('Installing update now...');
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall(true, true);
        } catch (error) {
          sendUpdaterStatus(`Install failed: ${error.message}`);
        }
      }, 400);
      return { ok: true, installing: true, source: 'app' };
    }

    await autoUpdater.checkForUpdates();
    return { ok: true, installing: false };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

