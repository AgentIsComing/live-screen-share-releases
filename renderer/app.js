const modeEl = document.getElementById('mode');
const roomIdInputEl = document.getElementById('roomIdInput');
const roomPasswordEl = document.getElementById('roomPassword');
const connectRoomBtn = document.getElementById('joinRoom');
const viewerFormEl = document.getElementById('viewerForm');

const codeServiceWrapEl = document.getElementById('codeServiceWrap');
const codeServiceUrlEl = document.getElementById('codeServiceUrl');
const startBackendBtn = document.getElementById('startBackend');
const stopBackendBtn = document.getElementById('stopBackend');
const checkUpdatesBtn = document.getElementById('checkUpdates');

const statusEl = document.getElementById('status');
const updateStatusEl = document.getElementById('updateStatus');
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

const bitrateEl = document.getElementById('bitrate');
const latencyProfileEl = document.getElementById('latencyProfile');
const iceJsonEl = document.getElementById('iceJson');
const videoEl = document.getElementById('video');

const DEFAULT_CODE_SERVICE_URL = 'https://live-screen-share-code-service.jaydenrmaine.workers.dev';

const storageKeys = {
  mode: 'lss.mode',
  codeServiceUrl: 'lss.codeServiceUrl',
  bitrate: 'lss.bitrate',
  latencyProfile: 'lss.latencyProfile',
  iceJson: 'lss.iceJson'
};

const defaultIce = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

let mode = 'host';
let signalUrl = '';
let roomId = '';
let roomPassword = '';
let ws = null;
let clientId = null;
let pendingOffer = false;
let joined = false;
let hostAvailable = false;
let reconnectTimer = null;
let lastStatusText = '';
let lastUpdateText = '';
let localStream = null;
let pc = null;
let backendRunning = false;

init();

async function init() {
  versionEl.textContent = `App v${await window.desktopApp.getVersion()}`;

  modeEl.value = localStorage.getItem(storageKeys.mode) || 'host';
  codeServiceUrlEl.value = localStorage.getItem(storageKeys.codeServiceUrl) || DEFAULT_CODE_SERVICE_URL;
  bitrateEl.value = localStorage.getItem(storageKeys.bitrate) || '2500000';
  latencyProfileEl.value = localStorage.getItem(storageKeys.latencyProfile) || 'ultra';
  iceJsonEl.value = localStorage.getItem(storageKeys.iceJson) || JSON.stringify(defaultIce);

  mode = modeEl.value;
  syncModeUI();

  modeEl.addEventListener('change', onModeChange);
  [codeServiceUrlEl, bitrateEl, latencyProfileEl, iceJsonEl].forEach((el) => {
    el.addEventListener('change', persistInputs);
  });

  startBackendBtn.addEventListener('click', startBackendFromApp);
  stopBackendBtn.addEventListener('click', stopBackendFromApp);
  checkUpdatesBtn.addEventListener('click', manualCheckForUpdates);

  connectRoomBtn.addEventListener('click', connectViewerByRoomPassword);

  videoSourceEl.addEventListener('change', syncHostSourceUI);
  refreshDevicesBtn.addEventListener('click', refreshDevices);
  startHostBtn.addEventListener('click', startHostWithPrompt);
  stopHostBtn.addEventListener('click', () => stopHost(true));
  startViewerBtn.addEventListener('click', startViewer);
  stopViewerBtn.addEventListener('click', stopViewer);

  await refreshDevices();
  syncHostSourceUI();

  window.desktopApp.onBackendStatus(handleBackendStatus);
  await refreshBackendState();

  window.desktopApp.onUpdaterStatus((message) => {
    setUpdateStatus(message);
  });
}

function persistInputs() {
  localStorage.setItem(storageKeys.mode, modeEl.value);
  localStorage.setItem(storageKeys.codeServiceUrl, codeServiceUrlEl.value.trim());
  localStorage.setItem(storageKeys.bitrate, bitrateEl.value);
  localStorage.setItem(storageKeys.latencyProfile, latencyProfileEl.value);
  localStorage.setItem(storageKeys.iceJson, iceJsonEl.value.trim());
}

function onModeChange() {
  mode = modeEl.value;
  persistInputs();
  syncModeUI();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
}

function syncModeUI() {
  const isHost = mode === 'host';
  hostPanel.classList.toggle('hidden', !isHost);
  viewerPanel.classList.toggle('hidden', isHost);
  codeServiceWrapEl.classList.toggle('hidden', !isHost);
  startBackendBtn.classList.toggle('hidden', !isHost);
  stopBackendBtn.classList.toggle('hidden', !isHost);
  if (!isHost) {
    checkUpdatesBtn.classList.add('hidden');
  } else {
    checkUpdatesBtn.classList.remove('hidden');
  }
  videoEl.muted = isHost;
}

function syncHostSourceUI() {
  const isDisplay = videoSourceEl.value === 'display';
  displaySourceEl.disabled = !isDisplay;
  cameraDeviceEl.disabled = isDisplay;
}

function setStatus(text, options = {}) {
  const { force = false } = options;
  if (!force && text === lastStatusText) return;
  lastStatusText = text;
  statusEl.textContent = text;
}

function setUpdateStatus(text, options = {}) {
  const { force = false } = options;
  if (!force && text === lastUpdateText) return;
  lastUpdateText = text;
  updateStatusEl.textContent = text;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshBackendState() {
  const state = await window.desktopApp.getBackendStatus();
  handleBackendStatus(state);
}

function handleBackendStatus(state) {
  backendRunning = Boolean(state?.signalRunning) && Boolean(state?.tunnelRunning);
  startBackendBtn.disabled = backendRunning;
  stopBackendBtn.disabled = !Boolean(state?.signalRunning || state?.tunnelRunning);

  if (state?.wsUrl) {
    signalUrl = state.wsUrl;
  }

  if (state?.message && mode === 'host') {
    setStatus(state.message);
  }
}

async function startBackendFromApp() {
  setStatus('Starting signaling + tunnel...');
  const result = await window.desktopApp.startBackend();
  handleBackendStatus(result);
  if (!result.ok) {
    setStatus('Backend start failed: ' + result.error);
    return false;
  }

  for (let i = 0; i < 20; i += 1) {
    const wsUrl = await window.desktopApp.getTunnelUrl();
    if (wsUrl) {
      signalUrl = wsUrl;
      setStatus('Backend ready.');
      return true;
    }
    await wait(500);
  }

  setStatus('Tunnel did not become ready yet.');
  return false;
}

async function stopBackendFromApp() {
  await window.desktopApp.stopBackend();
  backendRunning = false;
  signalUrl = '';
  setStatus('Backend stopped.');
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

function parseIceServers() {
  try {
    const parsed = JSON.parse(iceJsonEl.value.trim());
    if (!Array.isArray(parsed)) throw new Error('ICE servers must be an array');
    return parsed;
  } catch (error) {
    setStatus('Invalid ICE JSON: ' + error.message);
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

function connectSignaling() {
  if (!signalUrl || !roomId) {
    setStatus('Missing signaling or room configuration.');
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
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
        if (hostAvailable) {
          await startViewer();
        } else {
          pendingOffer = true;
          setStatus('Waiting for host...');
        }
      } else {
        setStatus('Host signaling ready.');
      }
      return;
    }

    if (message.type === 'host-available' && mode === 'viewer') {
      hostAvailable = true;
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

    if (message.type === 'broadcast-ended' && mode === 'viewer') {
      stopViewer();
      setStatus('Host stopped sharing.');
      return;
    }

    if (message.type === 'error') {
      setStatus('Signal error: ' + message.message);
    }
  });

  ws.addEventListener('close', (event) => {
    joined = false;
    if (mode === 'host') {
      setStatus(`Signaling disconnected (code ${event.code}). Reconnecting...`);
    }
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectSignaling();
      }
    }, 2000);
  });
}

function reconnectSignaling() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    ws.close();
  }
  joined = false;
  hostAvailable = false;
  connectSignaling();
}

async function waitForSignalingJoin(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (joined && ws && ws.readyState === WebSocket.OPEN) {
      return true;
    }
    await wait(200);
  }
  return false;
}

async function startHostWithPrompt() {
  if (mode !== 'host') {
    setStatus('Switch mode to host first.');
    return;
  }

  const promptedRoomId = window.prompt('Enter Room ID');
  if (!promptedRoomId) return;
  const promptedPassword = window.prompt('Enter Room Password (at least 4 chars)');
  if (!promptedPassword || promptedPassword.length < 4) {
    setStatus('Password must be at least 4 characters.');
    return;
  }

  roomId = promptedRoomId.trim();
  roomPassword = promptedPassword;

  if (!backendRunning) {
    const started = await startBackendFromApp();
    if (!started) return;
  }

  if (!signalUrl) {
    signalUrl = normalizeSignalUrl(await window.desktopApp.getTunnelUrl());
  }
  if (!signalUrl) {
    setStatus('No tunnel signaling URL available yet.');
    return;
  }

  reconnectSignaling();
  const ready = await waitForSignalingJoin();
  if (!ready) {
    setStatus('Signaling join timed out.');
    return;
  }

  const baseUrl = (codeServiceUrlEl.value || DEFAULT_CODE_SERVICE_URL).trim();
  const publish = await window.desktopApp.registerRoomAccess({
    baseUrl,
    roomId,
    password: roomPassword,
    wsUrl: signalUrl,
    ttlSeconds: 900
  });

  if (!publish.ok) {
    setStatus('Publish room failed: ' + publish.error);
    return;
  }

  await startHost();
}

async function connectViewerByRoomPassword() {
  if (mode !== 'viewer') {
    setStatus('Switch mode to viewer first.');
    return;
  }

  const viewerRoomId = roomIdInputEl.value.trim();
  const password = roomPasswordEl.value;
  if (!viewerRoomId) {
    setStatus('Enter Room ID.');
    return;
  }
  if (!password) {
    setStatus('Enter Room password.');
    return;
  }

  roomId = viewerRoomId;
  roomPassword = password;

  const result = await window.desktopApp.resolveRoomAccess({
    baseUrl: DEFAULT_CODE_SERVICE_URL,
    roomId,
    password: roomPassword
  });

  if (!result.ok) {
    setStatus('Room join failed: ' + result.error);
    return;
  }

  signalUrl = normalizeSignalUrl(result.wsUrl);
  reconnectSignaling();

  const ready = await waitForSignalingJoin();
  if (!ready) {
    setStatus('Could not join signaling.');
    return;
  }

  if (hostAvailable) {
    await startViewer();
  } else {
    pendingOffer = true;
    setStatus('Waiting for host...');
  }
}

async function refreshDevices() {
  try {
    const temp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    temp.getTracks().forEach((t) => t.stop());
  } catch {}

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
      if (mode === 'viewer') {
        viewerFormEl.classList.add('hidden');
        tuneReceiversForLatency(peer);
      }
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
    setStatus('Capture failed: ' + error.message);
    return;
  }

  videoEl.srcObject = localStream;
  videoEl.muted = true;

  startHostBtn.disabled = true;
  stopHostBtn.disabled = false;

  setStatus('Hosting started.');
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
  if (!joined) {
    return;
  }

  if (!hostAvailable) {
    pendingOffer = true;
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
    if (!localStream) return;

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
          params.encodings = [{ maxBitrate, maxFramerate: profile.maxFps, networkPriority: 'high' }];
          sender.setParameters(params).catch(() => {});
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
    setUpdateStatus('Update check failed: ' + result.error);
    return;
  }

  setUpdateStatus('Checking for updates...');
}

function getLatencyProfile() {
  const modeName = latencyProfileEl.value;
  if (modeName === 'ultra') {
    return { maxWidth: 1280, maxHeight: 720, maxFps: 24, maxBitrate: 2000000, playoutDelay: 0 };
  }
  if (modeName === 'low') {
    return { maxWidth: 1600, maxHeight: 900, maxFps: 30, maxBitrate: 3000000, playoutDelay: 0.04 };
  }
  return { maxWidth: 1920, maxHeight: 1080, maxFps: 30, maxBitrate: 5000000, playoutDelay: 0.08 };
}

function tuneReceiversForLatency(peer) {
  const profile = getLatencyProfile();
  for (const receiver of peer.getReceivers()) {
    if (receiver.track?.kind === 'video') {
      try {
        receiver.playoutDelayHint = profile.playoutDelay;
      } catch {}
    }
  }
}
