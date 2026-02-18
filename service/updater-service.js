const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const OWNER = process.env.RELEASE_OWNER || 'AgentIsComing';
const REPO = process.env.RELEASE_REPO || 'live-screen-share-releases';
const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

const BASE_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'LiveScreenShareUpdater');
const STATE_PATH = path.join(BASE_DIR, 'state.json');
const NOTICE_PATH = path.join(BASE_DIR, 'notice.json');
const DOWNLOAD_DIR = path.join(BASE_DIR, 'downloads');

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const EXE_NAME = 'Live Screen Share Desktop.exe';

fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.appendFileSync(path.join(BASE_DIR, 'service.log'), line + '\n', 'utf8');
  } catch {}
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

function compareVersions(a, b) {
  const pa = normalizeVersion(a).split('.').map((n) => Number(n) || 0);
  const pb = normalizeVersion(b).split('.').map((n) => Number(n) || 0);
  const max = Math.max(pa.length, pb.length);
  for (let i = 0; i < max; i += 1) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

function isAppRunning() {
  try {
    const out = execSync(`tasklist /FI "IMAGENAME eq ${EXE_NAME}" /NH`, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString();
    return out.toLowerCase().includes(EXE_NAME.toLowerCase());
  } catch {
    return false;
  }
}

async function getLatestRelease() {
  const res = await fetch(API_URL, {
    headers: { 'User-Agent': 'LiveScreenShareUpdaterService/1.0' }
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  const release = await res.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];

  const installerAsset = assets.find((asset) => {
    const name = String(asset?.name || '');
    return /setup/i.test(name) && /\.exe$/i.test(name) && !/\.blockmap$/i.test(name);
  });

  if (!installerAsset) {
    throw new Error('No installer asset found in latest release');
  }

  return {
    version: normalizeVersion(release.tag_name || release.name || ''),
    assetName: installerAsset.name,
    assetUrl: installerAsset.browser_download_url
  };
}

async function downloadFile(url, destinationPath) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LiveScreenShareUpdaterService/1.0' }
  });
  if (!res.ok) throw new Error(`Download failed ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  fs.writeFileSync(destinationPath, Buffer.from(arrayBuffer));
}

function runSilentInstaller(installerPath) {
  const command = `Start-Process -FilePath '${installerPath.replace(/'/g, "''")}' -ArgumentList '/S' -WindowStyle Hidden`;
  spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  }).unref();
}

async function checkAndUpdate() {
  const state = readJson(STATE_PATH, {
    knownVersion: '0.0.0',
    downloadedVersion: null,
    installerPath: null,
    lastCheckedAt: null
  });

  let latest;
  try {
    latest = await getLatestRelease();
  } catch (error) {
    log('release check failed:', error.message || String(error));
    return;
  }

  state.lastCheckedAt = new Date().toISOString();

  if (compareVersions(latest.version, state.knownVersion) <= 0) {
    writeJson(STATE_PATH, state);
    return;
  }

  const installerPath = path.join(DOWNLOAD_DIR, latest.assetName);
  if (state.downloadedVersion !== latest.version || !fs.existsSync(installerPath)) {
    try {
      log('downloading', latest.assetName, 'for version', latest.version);
      await downloadFile(latest.assetUrl, installerPath);
      state.downloadedVersion = latest.version;
      state.installerPath = installerPath;
      writeJson(STATE_PATH, state);
    } catch (error) {
      log('download failed:', error.message || String(error));
      return;
    }
  }

  if (isAppRunning()) {
    writeJson(NOTICE_PATH, {
      status: 'ready',
      version: latest.version,
      installerPath,
      updatedAt: new Date().toISOString()
    });
    log('update ready while app running:', latest.version);
    return;
  }

  log('app not running, applying update', latest.version);
  runSilentInstaller(installerPath);
  state.knownVersion = latest.version;
  state.downloadedVersion = latest.version;
  state.installerPath = installerPath;
  writeJson(STATE_PATH, state);
  writeJson(NOTICE_PATH, {
    status: 'applied',
    version: latest.version,
    installerPath,
    updatedAt: new Date().toISOString()
  });
}

async function mainLoop() {
  await checkAndUpdate();
  setInterval(() => {
    checkAndUpdate().catch((error) => {
      log('loop error:', error.message || String(error));
    });
  }, CHECK_INTERVAL_MS);
}

mainLoop().catch((error) => {
  log('fatal:', error.message || String(error));
});
