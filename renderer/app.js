const modeEl = document.getElementById('mode');
const roomEl = document.getElementById('roomId');
const signalUrlEl = document.getElementById('signalUrl');
const autoTunnelBtn = document.getElementById('autoTunnel');
const testSignalBtn = document.getElementById('testSignal');
const checkUpdatesBtn = document.getElementById('checkUpdates');
const startBackendBtn = document.getElementById('startBackend');
const stopBackendBtn = document.getElementById('stopBackend');
const latencyProfileEl = document.getElementById('latencyProfile');
const bitrateEl = document.getElementById('bitrate');
const iceJsonEl = document.getElementById('iceJson');
const statusEl = document.getElementById('status');
const versionEl = document.getElementById('version');

const hostPanel = document.getElementById('hostPanel');
const viewerPanel = document.getElementById('viewerPanel');

const videoSourceEl = document.getElementById('videoSource');
const displaySourceEl = document.getElementById('displaySource');
const audioModeEl = document.getElementById('audioMode');
const cameraDeviceEl = document.getElementById('cameraDevice');
const audioDeviceEl = document.getElementById('audioDevice');
const refreshDevicesBtn = document.getElementById('refreshDevices');
const startHostBtn = document.getElementById('startHost');
const stopHostBtn = document.getElementById('stopHost');

const startViewerBtn = document.getElementById('startViewer');
const stopViewerBtn = document.getElementById('stopViewer');

const videoEl = document.getElementById('video');

const defaultIce = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

const storageKeys = {
  mode: 'lss.mode',
  room: 'lss.room',
  signalUrl: 'lss.signalUrl',
  iceJson: 'lss.iceJson',
  bitrate: 'lss.bitrate',
  latencyProfile: 'lss.latencyProfile'
};

let ws = null;
let mode = 'host';
let clientId = null;
let roomId = null;
let pendingOffer = false;
let joined = false;
let hostAvailable = false;
let localStream = null;
let pc = null;
let reconnectTimer = null;
let lastStatusText = '';
let lastAutoFilledTunnelUrl = '';

init();

async function init() {
  versionEl.textContent = `App v${await window.desktopApp.getVersion()}`;

  modeEl.value = localStorage.getItem(storageKeys.mode) || 'host';
  roomEl.value = localStorage.getItem(storageKeys.room) || 'jayde-room';
  signalUrlEl.value = localStorage.getItem(storageKeys.signalUrl) || 'ws://localhost:3000/signal';
  iceJsonEl.value = localStorage.getItem(storageKeys.iceJson) || JSON.stringify(defaultIce);
  bitrateEl.value = localStorage.getItem(storageKeys.bitrate) || '2500000';
  latencyProfileEl.value = localStorage.getItem(storageKeys.latencyProfile) || 'ultra';

  mode = modeEl.value;
  syncModeUI();

  modeEl.addEventListener('change', onModeChange);
  videoSourceEl.addEventListener('change', syncHostSourceUI);
  [roomEl, signalUrlEl, iceJsonEl, bitrateEl, latencyProfileEl].forEach((el) => el.addEventListener('change', persistInputs));
  autoTunnelBtn.addEventListener('click', () => autoFillTunnelUrl(false));
  testSignalBtn.addEventListener('click', testSignalingEndpoint);
  checkUpdatesBtn.addEventListener('click', manualCheckForUpdates);
  startBackendBtn.addEventListener('click', startBackendFromApp);
  stopBackendBtn.addEventListener('click', stopBackendFromApp);

  refreshDevicesBtn.addEventListener('click', refreshDevices);
  startHostBtn.addEventListener('click', startHost);
  stopHostBtn.addEventListener('click', () => stopHost(true));
  startViewerBtn.addEventListener('click', startViewer);
  stopViewerBtn.addEventListener('click', stopViewer);

  await refreshDevices();
  syncHostSourceUI();
  await autoFillTunnelUrl(true);
  setInterval(() => {
    autoFillTunnelUrl(true);
  }, 5000);
  connectSignaling();

  window.desktopApp.onUpdaterStatus((message) => {
    setStatus(message);
  });}

function persistInputs() {
  localStorage.setItem(storageKeys.mode, modeEl.value);
  localStorage.setItem(storageKeys.room, roomEl.value.trim());
  localStorage.setItem(storageKeys.signalUrl, signalUrlEl.value.trim());
  localStorage.setItem(storageKeys.iceJson, iceJsonEl.value.trim());
  localStorage.setItem(storageKeys.bitrate, bitrateEl.value);
  localStorage.setItem(storageKeys.latencyProfile, latencyProfileEl.value);
}

function onModeChange() {
  mode = modeEl.value;
  persistInputs();
  syncModeUI();
  reconnectSignaling();}

function syncModeUI() {
  const isHost = mode === 'host';
  hostPanel.classList.toggle('hidden', !isHost);
  viewerPanel.classList.toggle('hidden', isHost);
  videoEl.muted = isHost;
}

function syncHostSourceUI() {
  const isDisplay = videoSourceEl.value === 'display';
  displaySourceEl.disabled = !isDisplay;
  cameraDeviceEl.disabled = isDisplay;
}

function setStatus(text, options = {}) {
  const { force = false } = options;
  if (!force && text === lastStatusText) {
    return;
  }
  lastStatusText = text;
  statusEl.textContent = text;
  console.log(`[status ${new Date().toISOString()}] ${text}`);
}

async function refreshBackendState() {
  try {
    const state = await window.desktopApp.getBackendStatus();
    handleBackendStatus(state);
  } catch (error) {
    setStatus(`Backend status check failed: ${error.message}`);
  }
}

function handleBackendStatus(state) {
  const signalRunning = Boolean(state?.signalRunning);
  const tunnelRunning = Boolean(state?.tunnelRunning);

  startBackendBtn.disabled = signalRunning && tunnelRunning;
  stopBackendBtn.disabled = !signalRunning && !tunnelRunning;

  if (state?.wsUrl) {
    lastAutoFilledTunnelUrl = state.wsUrl;
  }

  if (state?.message) {
    setStatus(state.message);
  }
}

async function startBackendFromApp() {
  startBackendBtn.disabled = true;
  setStatus('Starting local signaling and Cloudflare tunnel...');

  const result = await window.desktopApp.startBackend();
  handleBackendStatus(result);

  if (!result.ok) {
    setStatus(`Backend start failed: ${result.error}`);
    return;
  }

  setTimeout(async () => {
    await autoFillTunnelUrl(false);
    reconnectSignaling();
  }, 1200);
}

async function stopBackendFromApp() {
  await window.desktopApp.stopBackend();
  handleBackendStatus({ signalRunning: false, tunnelRunning: false, message: 'Backend stopped.' });
}
function normalizeSignalUrl(value) {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';

  if (/^https:\/\//i.test(trimmed)) {
    return trimmed.replace(/^https:/i, 'wss:').replace(/\/+$/, '') + '/signal';
  }

  if (/^wss:\/\//i.test(trimmed) || /^ws:\/\//i.test(trimmed)) {
    if (trimmed.endsWith('/signal')) return trimmed;
    return trimmed.replace(/\/+$/, '') + '/signal';
  }

  return trimmed;
}

function signalToHealthUrl(signalUrl) {
  if (!signalUrl) return '';
  try {
    const url = new URL(signalUrl);
    if (url.protocol === 'wss:') url.protocol = 'https:';
    if (url.protocol === 'ws:') url.protocol = 'http:';
    url.pathname = '/health';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

async function testSignalingEndpoint() {
  const healthUrl = signalToHealthUrl(signalUrlEl.value.trim());
  if (!healthUrl) {
    setStatus('Signal URL is invalid.');
    return;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(healthUrl, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(timeout);

    if (!response.ok) {
      setStatus(`Signaling health check failed: HTTP ${response.status}`);
      return;
    }

    const body = await response.text();
    setStatus(`Signaling health check OK (${healthUrl}) ${body.slice(0, 50)}`);
  } catch (error) {
    setStatus(`Signaling health check failed: ${error.message}`);
  }
}

async function autoFillTunnelUrl(silent) {
  const tunnelWs = normalizeSignalUrl(await window.desktopApp.getTunnelUrl());
  if (!tunnelWs) {
    if (!silent) setStatus('No active tunnel URL found. Start `npm run start:public-signal` first.');
    return;
  }

  const current = signalUrlEl.value.trim();

  if (current === tunnelWs) {
    lastAutoFilledTunnelUrl = tunnelWs;
    if (!silent) setStatus('Signaling URL already uses active Cloudflare tunnel.');
    return;
  }

  // Silent auto-fill should not override user-entered custom URLs.
  if (silent) {
    const isDefaultOrLocal =
      current === '' ||
      /localhost|127\.0\.0\.1/i.test(current) ||
      /trycloudflare\.com/i.test(current) ||
      current === lastAutoFilledTunnelUrl;

    if (!isDefaultOrLocal) {
      return;
    }
  }

  signalUrlEl.value = tunnelWs;
  lastAutoFilledTunnelUrl = tunnelWs;
  persistInputs();
  reconnectSignaling();
  setStatus(`Auto-filled signaling URL: ${tunnelWs}`);
}

function parseIceServers() {
  try {
    const parsed = JSON.parse(iceJsonEl.value.trim());
    if (!Array.isArray(parsed)) throw new Error('ICE servers must be an array');
    return parsed;
  } catch (error) {
    setStatus(`Invalid ICE JSON: ${error.message}`);
    return null;
  }
}

function rtcConfig() {
  const iceServers = parseIceServers();
  if (!iceServers) return null;

  return {
    iceServers,
    bundlePolicy: 'max-bundle',
    iceCandidatePoolSize: 10
  };
}

function currentRoomId() {
  return roomEl.value.trim();
}

function connectSignaling() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const signalUrl = signalUrlEl.value.trim();
  roomId = currentRoomId();

  if (!signalUrl || !roomId) {
    setStatus('Signal URL and room ID are required.');
    return;
  }

  clientId = `${mode}-${Math.random().toString(36).slice(2, 10)}`;
  ws = new WebSocket(signalUrl);

  ws.addEventListener('open', () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    joined = false;
    ws.send(JSON.stringify({ type: 'join', role: mode, roomId, clientId }));
  });

  ws.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === 'joined') {
      joined = true;
      hostAvailable = Boolean(message.hostAvailable);
      if (mode === 'viewer') {
        setStatus(hostAvailable ? 'Viewer ready. Click connect.' : 'Viewer ready. Waiting for host.');
        startViewerBtn.disabled = !hostAvailable;
      } else {
        setStatus('Host ready. Configure source and start hosting.');
      }
      return;
    }

    if (message.type === 'host-available' && mode === 'viewer') {
      hostAvailable = true;
      startViewerBtn.disabled = false;
      setStatus('Host is online. Click connect.');
      if (pendingOffer) {
        pendingOffer = false;
        await startViewer();
      }
      return;
    }

    if (message.type === 'signal') {
      await handleSignal(message.data);
      return;
    }

    if (message.type === 'broadcast-ended') {
      if (mode === 'viewer') {
        stopViewer();
        setStatus('Host stopped sharing.');
      }
      return;
    }

    if (message.type === 'error') {
      setStatus(`Signal error: ${message.message}`);
    }
  });

  ws.addEventListener('close', (event) => {
    joined = false;
    const reason = event.reason ? `, reason: ${event.reason}` : '';
    setStatus(`Signaling disconnected (code ${event.code}${reason}). Reconnecting in 2s...`);
    if (reconnectTimer) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectSignaling();
      }
    }, 2000);
  });

  ws.addEventListener('error', () => {
    setStatus(`Signaling socket error for ${signalUrl}`);
  });
}

function reconnectSignaling() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }
  joined = false;
  hostAvailable = false;
  connectSignaling();}

async function refreshDevices() {
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    temp.getTracks().forEach((t) => t.stop());
  } catch {
    // OS/browser permissions may block labels.
  }

  const [devices, desktopSources] = await Promise.all([
    navigator.mediaDevices.enumerateDevices(),
    window.desktopApp.listDesktopSources()
  ]);

  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  const audioInputs = devices.filter((d) => d.kind === 'audioinput');

  displaySourceEl.innerHTML = '';
  cameraDeviceEl.innerHTML = '';
  audioDeviceEl.innerHTML = '';

  if (desktopSources.length === 0) {
    displaySourceEl.innerHTML = '<option value="">No display sources found</option>';
  } else {
    for (const s of desktopSources) {
      const option = document.createElement('option');
      option.value = s.id;
      option.textContent = s.name;
      displaySourceEl.appendChild(option);
    }
  }

  if (videoInputs.length === 0) {
    cameraDeviceEl.innerHTML = '<option value="">No camera devices found</option>';
  } else {
    for (const d of videoInputs) {
      const option = document.createElement('option');
      option.value = d.deviceId;
      option.textContent = d.label || `Camera ${cameraDeviceEl.length + 1}`;
      cameraDeviceEl.appendChild(option);
    }
  }

  const defaultAudio = document.createElement('option');
  defaultAudio.value = '';
  defaultAudio.textContent = 'System default audio input';
  audioDeviceEl.appendChild(defaultAudio);

  for (const d of audioInputs) {
    const option = document.createElement('option');
    option.value = d.deviceId;
    option.textContent = d.label || `Audio input ${audioDeviceEl.length}`;
    audioDeviceEl.appendChild(option);
  }

  setStatus('Device and display source list refreshed.');
}

function makePeerConnection() {
  const config = rtcConfig();
  if (!config) return null;

  const peer = new RTCPeerConnection(config);

  peer.onicecandidate = (event) => {
    if (!event.candidate || !ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      type: 'signal',
      data: {
        from: clientId,
        candidate: event.candidate
      }
    }));
  };

  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    if (state === 'connected') {
      setStatus(mode === 'host' ? 'Viewer connected.' : 'Connected to host stream.');
      if (mode === 'viewer') { tuneReceiversForLatency(peer); }
    }
    if (state === 'failed' || state === 'disconnected') {
      setStatus('Peer connection dropped.');
      if (mode === 'viewer') {
        startViewerBtn.disabled = false;
        stopViewerBtn.disabled = true;
      }
      if (mode === 'host') {
        startHostBtn.disabled = false;
        stopHostBtn.disabled = true;
      }
    }
  };

  if (mode === 'viewer') {
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      videoEl.srcObject = stream;
      videoEl.muted = false;
      videoEl.play().catch(() => {
        setStatus('Press play to start video/audio.');
      });
    };
  }

  return peer;
}

async function captureDisplayStream(useDisplayAudio) {
  const sourceId = displaySourceEl.value;
  if (!sourceId) {
    throw new Error('Select a display/window source first.');
  }

  function desktopVideoConstraints(frameRateMax) {
    const profile = getLatencyProfile();
    return {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        minWidth: 1280,
        maxWidth: profile.maxWidth,
        minHeight: 720,
        maxHeight: profile.maxHeight,
        minFrameRate: 20,
        maxFrameRate: Math.min(frameRateMax, profile.maxFps)
      }
    };
  }

  function desktopAudioConstraints() {
    return {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId
      }
    };
  }

  let firstError = null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: desktopVideoConstraints(getLatencyProfile().maxFps),
      audio: useDisplayAudio ? desktopAudioConstraints() : false
    });
  } catch (error) {
    firstError = error;
  }

  if (useDisplayAudio) {
    setStatus('Display audio capture failed, retrying with video-only desktop capture.');
  } else {
    setStatus('Desktop capture retrying with lower frame rate.');
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: desktopVideoConstraints(getLatencyProfile().maxFps),
      audio: false
    });
  } catch (secondError) {
    const reason1 = firstError?.message || String(firstError || 'unknown');
    const reason2 = secondError?.message || String(secondError || 'unknown');
    throw new Error(`Desktop capture failed. First attempt: ${reason1}. Retry: ${reason2}`);
  }
}

async function buildHostStream() {
  const source = videoSourceEl.value;
  const audioMode = audioModeEl.value;
  const tracks = [];

  if (source === 'display') {
    const useDisplayAudio = audioMode === 'display' || audioMode === 'display+input';
    const display = await captureDisplayStream(useDisplayAudio);
    tracks.push(...display.getTracks());
  } else {
    const cameraId = cameraDeviceEl.value;
    if (!cameraId) throw new Error('Select OBS Virtual Camera device first.');

    const camera = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: cameraId },
        frameRate: { ideal: getLatencyProfile().maxFps, max: getLatencyProfile().maxFps },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    tracks.push(...camera.getVideoTracks());
  }

  const useInputAudio = audioMode === 'input' || audioMode === 'display+input';
  if (useInputAudio) {
    const audioId = audioDeviceEl.value;
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2
    };
    if (audioId) {
      audioConstraints.deviceId = { exact: audioId };
    }

    const audio = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });
    tracks.push(...audio.getAudioTracks());
  }

  const stream = new MediaStream(tracks);
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.contentHint = 'motion';
    videoTrack.addEventListener('ended', () => stopHost(true));
  }

  return stream;
}

async function startHost() {
  if (mode !== 'host') {
    setStatus('Switch mode to host first.');
    return;
  }

  if (!joined || !ws || ws.readyState !== WebSocket.OPEN) {
    setStatus('Signaling not ready yet.');
    return;
  }

  if (localStream) {
    setStatus('Already hosting.');
    return;
  }

  try {
    localStream = await buildHostStream();
  } catch (error) {
    setStatus(`Capture failed: ${error.message}`);
    return;
  }

  videoEl.srcObject = localStream;
  videoEl.muted = true;

  startHostBtn.disabled = true;
  stopHostBtn.disabled = false;

  setStatus('Hosting started. Ask viewer to connect now.');
}

function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

function resetPeer() {
  if (pc) {
    pc.close();
    pc = null;
  }
}

function stopHost(sendSignal) {
  stopTracks(localStream);
  localStream = null;
  resetPeer();

  videoEl.srcObject = null;
  startHostBtn.disabled = false;
  stopHostBtn.disabled = true;

  if (sendSignal && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'broadcast-end' }));
  }

  setStatus('Hosting stopped.');
}

async function startViewer() {
  if (mode !== 'viewer') {
    setStatus('Switch mode to viewer first.');
    return;
  }

  if (!joined) {
    setStatus('Signaling not joined yet.');
    return;
  }

  if (!hostAvailable) {
    pendingOffer = true;
    setStatus('Waiting for host. Will auto-connect when host appears.');
    return;
  }

  resetPeer();
  pc = makePeerConnection();
  if (!pc) return;

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true, voiceActivityDetection: false });
  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: 'signal',
    data: {
      from: clientId,
      offer
    }
  }));

  startViewerBtn.disabled = true;
  stopViewerBtn.disabled = false;
  setStatus('Connecting to host...');
}

function stopViewer() {
  resetPeer();
  videoEl.srcObject = null;
  startViewerBtn.disabled = !hostAvailable;
  stopViewerBtn.disabled = true;
}

async function handleSignal(data) {
  if (!data) return;

  if (mode === 'host') {
    if (!localStream) {
      setStatus('Viewer requested stream, but hosting has not started.');
      return;
    }

    if (data.offer) {
      resetPeer();
      pc = makePeerConnection();
      if (!pc) return;

      const profile = getLatencyProfile();
      const maxBitrate = Math.min(Number(bitrateEl.value), profile.maxBitrate);

      for (const track of localStream.getTracks()) {
        const sender = pc.addTrack(track, localStream);
        if (track.kind === 'video') {
          const params = sender.getParameters();
          params.degradationPreference = 'maintain-framerate';
          params.encodings = [{ maxBitrate, maxFramerate: profile.maxFps, networkPriority: "high" }];
          sender.setParameters(params).catch(() => {
            // Some runtimes reject advanced encoding params.
          });
        }
      }

      await pc.setRemoteDescription(data.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      ws.send(JSON.stringify({
        type: 'signal',
        data: {
          from: clientId,
          to: data.from,
          answer
        }
      }));
    }

    if (data.candidate && pc) {
      await pc.addIceCandidate(data.candidate);
    }

    return;
  }

  if (mode === 'viewer') {
    if (data.to && data.to !== clientId) return;

    if (!pc) {
      if (!data.answer && !data.candidate) return;
      pc = makePeerConnection();
      if (!pc) return;
    }

    if (data.answer) {
      await pc.setRemoteDescription(data.answer);
      tuneReceiversForLatency(pc);
    }

    if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  }
}

window.addEventListener('beforeunload', () => {
  if (mode === 'host') stopHost(true);
  if (mode === 'viewer') stopViewer();
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
});

async function manualCheckForUpdates() {
  const result = await window.desktopApp.checkForUpdates();
  if (!result.ok) {
    setStatus('Update check failed: ' + result.error);
    return;
  }

  setStatus('Checking for updates...');
}
function getLatencyProfile() {
  const modeName = latencyProfileEl.value;
  if (modeName === 'ultra') {
    return { name: modeName, maxWidth: 1280, maxHeight: 720, maxFps: 24, maxBitrate: 2000000, playoutDelay: 0 };
  }
  if (modeName === 'low') {
    return { name: modeName, maxWidth: 1600, maxHeight: 900, maxFps: 30, maxBitrate: 3000000, playoutDelay: 0.04 };
  }
  return { name: modeName, maxWidth: 1920, maxHeight: 1080, maxFps: 30, maxBitrate: 5000000, playoutDelay: 0.08 };
}

function tuneReceiversForLatency(peer) {
  const profile = getLatencyProfile();
  for (const receiver of peer.getReceivers()) {
    if (receiver.track?.kind === 'video') {
      try {
        receiver.playoutDelayHint = profile.playoutDelay;
      } catch {
        // Browser/runtime may not support playoutDelayHint.
      }
    }
  }
}




