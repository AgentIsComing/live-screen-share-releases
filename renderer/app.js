const modeEl = document.getElementById('mode');
const modeButtons = Array.from(document.querySelectorAll('.mode-chip'));
const roomIdInputEl = document.getElementById('roomIdInput');
const roomPasswordEl = document.getElementById('roomPassword');
const connectRoomBtn = document.getElementById('joinRoom');
const viewerFormEl = document.getElementById('viewerForm');

const codeServiceWrapEl = document.getElementById('codeServiceWrap');
const codeServiceUrlEl = document.getElementById('codeServiceUrl');
const connectivityWrapEl = document.getElementById('connectivityWrap');
const latencyWrapEl = document.getElementById('latencyWrap');
const bitrateWrapEl = document.getElementById('bitrateWrap');

const startBackendBtn = document.getElementById('startBackend');
const stopBackendBtn = document.getElementById('stopBackend');
const checkUpdatesBtn = document.getElementById('checkUpdates');

const hostStartModalEl = document.getElementById('hostStartModal');
const hostModalRoomIdEl = document.getElementById('hostModalRoomId');
const hostModalPasswordEl = document.getElementById('hostModalPassword');
const hostModalConfirmBtn = document.getElementById('hostModalConfirm');
const hostModalCancelBtn = document.getElementById('hostModalCancel');

const statusEl = document.getElementById('status');
const updateStatusEl = document.getElementById('updateStatus');
const statusBadgeEl = document.getElementById('statusBadge');
const versionEl = document.getElementById('version');
const hostStatsEl = document.getElementById('hostStats');
const captureModeDisplayEl = document.getElementById('captureModeDisplay');

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

const bitrateEl = document.getElementById('bitrate');
const latencyProfileEl = document.getElementById('latencyProfile');
const videoEl = document.getElementById('video');

const DEFAULT_CODE_SERVICE_URL = 'https://live-screen-share-code-service.jaydenrmaine.workers.dev';

const storageKeys = {
  mode: 'lss.mode',
  codeServiceUrl: 'lss.codeServiceUrl',
  bitrate: 'lss.bitrate',
  latencyProfile: 'lss.latencyProfile'
};

const backendIceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
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
let backendRunning = false;
let backendStarting = false;
let hostStarting = false;
let suppressTrackEndedUntil = 0;
let adaptiveTuneTimer = null;

let localStream = null;
let viewerPc = null;
let viewerPendingIceCandidates = [];
const hostPeers = new Map();
const hostPendingIceCandidates = new Map();
const adaptivePeerState = new Map();

init();

async function init() {
  versionEl.textContent = `App v${await window.desktopApp.getVersion()}`;

  modeEl.value = localStorage.getItem(storageKeys.mode) || 'host';
  codeServiceUrlEl.value = localStorage.getItem(storageKeys.codeServiceUrl) || DEFAULT_CODE_SERVICE_URL;
  bitrateEl.value = localStorage.getItem(storageKeys.bitrate) || '16000000';
  latencyProfileEl.value = localStorage.getItem(storageKeys.latencyProfile) || 'auto';

  mode = modeEl.value;
  syncModeUI();
  updateHostStats();

  modeEl.addEventListener('change', onModeChange);
  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextMode = button.dataset.mode;
      if (!nextMode || nextMode === modeEl.value) return;
      modeEl.value = nextMode;
      onModeChange();
    });
  });
  [codeServiceUrlEl, bitrateEl, latencyProfileEl].forEach((el) => el.addEventListener('change', onStreamingSettingsChanged));

  startBackendBtn.addEventListener('click', startBackendFromApp);
  stopBackendBtn.addEventListener('click', stopBackendFromApp);
  checkUpdatesBtn.addEventListener('click', manualCheckForUpdates);
  connectRoomBtn.addEventListener('click', connectViewerByRoomPassword);

  hostModalConfirmBtn.addEventListener('click', confirmHostStartFromModal);
  hostModalCancelBtn.addEventListener('click', closeHostStartModal);
  hostStartModalEl.addEventListener('click', (event) => {
    if (event.target === hostStartModalEl) closeHostStartModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !hostStartModalEl.classList.contains('hidden')) {
      closeHostStartModal();
    }
  });

  videoSourceEl.addEventListener('change', async () => {
    syncHostSourceUI();
    await handleLiveSourceChange();
  });
  displaySourceEl.addEventListener('change', handleLiveSourceChange);
  audioModeEl.addEventListener('change', handleLiveSourceChange);
  cameraDeviceEl.addEventListener('change', handleLiveSourceChange);
  audioDeviceEl.addEventListener('change', handleLiveSourceChange);

  refreshDevicesBtn.addEventListener('click', async () => {
    try {
      await refreshDevices(true);
      if (mode === 'host' && localStream) {
        await rebuildHostStreamForActiveSession();
      }
    } catch (error) {
      setStatus('Refresh devices failed: ' + (error?.message || error));
    }
  });

  startHostBtn.addEventListener('click', startHostWithPrompt);
  stopHostBtn.addEventListener('click', () => stopHost(true));

  syncHostSourceUI();
  setTimeout(() => {
    refreshDevices(false).catch((error) => setStatus('Refresh devices failed: ' + (error?.message || error)));
  }, 0);

  window.desktopApp.onBackendStatus(handleBackendStatus);
  await refreshBackendState();

  window.desktopApp.onUpdaterStatus((message) => setUpdateStatus(message));

  // Pre-warm backend in host mode so Start hosting is faster.
  setTimeout(() => {
    if (mode === 'host' && !backendRunning) {
      startBackendFromApp().catch(() => {});
    }
  }, 600);
}

function persistInputs() {
  localStorage.setItem(storageKeys.mode, modeEl.value);
  localStorage.setItem(storageKeys.codeServiceUrl, codeServiceUrlEl.value.trim());
  localStorage.setItem(storageKeys.bitrate, bitrateEl.value);
  localStorage.setItem(storageKeys.latencyProfile, latencyProfileEl.value);
}

function onStreamingSettingsChanged() {
  persistInputs();
  syncAdaptiveStreamingLoop();
  if (mode !== 'host' || !localStream) return;
  for (const peer of hostPeers.values()) {
    applyVideoSenderSettings(peer);
  }
}

function onModeChange() {
  mode = modeEl.value;
  persistInputs();
  syncModeUI();
  syncAdaptiveStreamingLoop();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
}

function syncModeUI() {
  const isHost = mode === 'host';
  hostPanel.classList.toggle('hidden', !isHost);
  viewerPanel.classList.toggle('hidden', isHost);

  modeEl.parentElement.classList.remove('hidden');
  codeServiceWrapEl.classList.toggle('hidden', !isHost);
  connectivityWrapEl.classList.toggle('hidden', !isHost);
  latencyWrapEl.classList.toggle('hidden', !isHost);
  bitrateWrapEl.classList.toggle('hidden', !isHost);
  modeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });

  videoEl.muted = isHost;
}

function syncHostSourceUI() {
  const isDisplay = videoSourceEl.value === 'display';
  displaySourceEl.disabled = !isDisplay;
  cameraDeviceEl.disabled = isDisplay;
  if (captureModeDisplayEl) {
    captureModeDisplayEl.textContent = isDisplay ? 'Display / Window capture' : 'OBS Virtual Camera';
  }
}

function setStatus(text, options = {}) {
  const { force = false } = options;
  if (!force && text === lastStatusText) return;
  lastStatusText = text;
  statusEl.textContent = text;
  updateStatusBadge(text);
}

function setUpdateStatus(text, options = {}) {
  const { force = false } = options;
  if (!force && text === lastUpdateText) return;
  lastUpdateText = text;
  updateStatusEl.textContent = text;
}

function updateStatusBadge(text) {
  if (!statusBadgeEl) return;

  const normalized = String(text || '').toLowerCase();
  statusBadgeEl.classList.remove('live', 'warn', 'error', 'neutral');

  if (!normalized) {
    statusBadgeEl.textContent = 'Idle';
    statusBadgeEl.classList.add('neutral');
    return;
  }

  if (normalized.includes('connected')) {
    statusBadgeEl.textContent = 'Connected';
    statusBadgeEl.classList.add('live');
    return;
  }

  if (normalized.includes('error') || normalized.includes('failed') || normalized.includes('disconnected')) {
    statusBadgeEl.textContent = 'Attention';
    statusBadgeEl.classList.add('error');
    return;
  }

  if (normalized.includes('waiting') || normalized.includes('checking') || normalized.includes('reconnect')) {
    statusBadgeEl.textContent = 'Pending';
    statusBadgeEl.classList.add('warn');
    return;
  }

  statusBadgeEl.textContent = 'Idle';
  statusBadgeEl.classList.add('neutral');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateHostStats() {
  const peerCount = hostPeers.size;
  const autoTuneActive = latencyProfileEl.value === 'auto' ? ' | Auto tune on' : '';
  hostStatsEl.textContent = mode === 'host'
    ? `Connected viewers: ${peerCount}${autoTuneActive}`
    : '';
}

async function refreshBackendState() {
  const state = await window.desktopApp.getBackendStatus();
  handleBackendStatus(state);
}

function handleBackendStatus(state) {
  backendRunning = Boolean(state?.signalRunning) && Boolean(state?.tunnelRunning);
  startBackendBtn.disabled = backendRunning || backendStarting || hostStarting;
  stopBackendBtn.disabled = !Boolean(state?.signalRunning || state?.tunnelRunning);

  if (state?.wsUrl) {
    signalUrl = state.wsUrl;
  }

  if (state?.message && mode === 'host') {
    setStatus(state.message);
  }
}

async function startBackendFromApp() {
  if (backendRunning) {
    return true;
  }

  if (backendStarting) {
    for (let i = 0; i < 20; i += 1) {
      if (backendRunning) return true;
      await wait(250);
    }
    return backendRunning;
  }

  backendStarting = true;
  setStatus('Starting signaling + tunnel...');
  try {
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
  } finally {
    backendStarting = false;
  }
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

function rtcConfig() {
  return {
    iceServers: backendIceServers,
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
      viewerFormEl.classList.remove('hidden');
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
    } else {
      stopViewer();
      viewerFormEl.classList.remove('hidden');
      setStatus(`Disconnected from host (code ${event.code}). Reconnecting...`);
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

function openHostStartModal() {
  hostModalRoomIdEl.value = '';
  hostModalPasswordEl.value = '';
  hostStartModalEl.hidden = false;
  hostStartModalEl.classList.remove('hidden');
  hostModalRoomIdEl.focus();
}

function closeHostStartModal() {
  hostStartModalEl.classList.add('hidden');
  hostStartModalEl.hidden = true;
}

async function startHostWithPrompt() {
  if (mode !== 'host') {
    setStatus('Switch mode to host first.');
    return;
  }
  openHostStartModal();
}

async function confirmHostStartFromModal() {
  const promptedRoomId = hostModalRoomIdEl.value.trim();
  const promptedPassword = hostModalPasswordEl.value;

  if (!promptedRoomId) {
    setStatus('Room ID is required.');
    return;
  }

  if (!promptedPassword || promptedPassword.length < 4) {
    setStatus('Password must be at least 4 characters.');
    return;
  }

  closeHostStartModal();
  roomId = promptedRoomId;
  roomPassword = promptedPassword;
  hostStarting = true;
  startHostBtn.disabled = true;

  if (!backendRunning) {
    setStatus('Preparing backend...');
    const started = await startBackendFromApp();
    if (!started) {
      hostStarting = false;
      startHostBtn.disabled = false;
      return;
    }
  }

  if (!signalUrl) {
    signalUrl = normalizeSignalUrl(await window.desktopApp.getTunnelUrl());
  }
  if (!signalUrl) {
    setStatus('No tunnel signaling URL available yet.');
    hostStarting = false;
    startHostBtn.disabled = false;
    return;
  }

  setStatus('Connecting signaling...');
  reconnectSignaling();
  const ready = await waitForSignalingJoin();
  if (!ready) {
    setStatus('Signaling join timed out.');
    hostStarting = false;
    startHostBtn.disabled = false;
    return;
  }

  const baseUrl = (codeServiceUrlEl.value || DEFAULT_CODE_SERVICE_URL).trim();
  setStatus('Publishing room...');
  const publish = await window.desktopApp.registerRoomAccess({
    baseUrl,
    roomId,
    password: roomPassword,
    wsUrl: signalUrl,
    ttlSeconds: 900
  });

  if (!publish.ok) {
    setStatus('Publish room failed: ' + publish.error);
    hostStarting = false;
    startHostBtn.disabled = false;
    return;
  }

  setStatus('Starting capture...');
  await startHost();
  hostStarting = false;
  if (!localStream) {
    startHostBtn.disabled = false;
  }
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

async function refreshDevices(requestPermissions = false) {
  if (requestPermissions) {
    try {
      const temp = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      temp.getTracks().forEach((t) => t.stop());
    } catch {}
  }

  const [devices, desktopSources] = await Promise.all([
    navigator.mediaDevices.enumerateDevices(),
    window.desktopApp.listDesktopSources()
  ]);

  const previousCamera = cameraDeviceEl.value;
  const previousAudio = audioDeviceEl.value;
  const previousDisplay = displaySourceEl.value;

  const videoInputs = devices.filter((d) => d.kind === 'videoinput');
  const audioInputs = devices.filter((d) => d.kind === 'audioinput');

  displaySourceEl.innerHTML = '';
  cameraDeviceEl.innerHTML = '';
  audioDeviceEl.innerHTML = '';

  if (desktopSources.length === 0) {
    displaySourceEl.innerHTML = '<option value="">No display sources found</option>';
  } else {
    for (const source of desktopSources) {
      const option = document.createElement('option');
      option.value = source.id;
      option.textContent = source.name;
      displaySourceEl.appendChild(option);
    }
    if (previousDisplay && desktopSources.some((s) => s.id === previousDisplay)) {
      displaySourceEl.value = previousDisplay;
    }
  }

  if (videoInputs.length === 0) {
    cameraDeviceEl.innerHTML = '<option value="">No camera devices found</option>';
  } else {
    for (const input of videoInputs) {
      const option = document.createElement('option');
      option.value = input.deviceId;
      option.textContent = input.label || `Camera ${cameraDeviceEl.length + 1}`;
      cameraDeviceEl.appendChild(option);
    }

    if (previousCamera && videoInputs.some((v) => v.deviceId === previousCamera)) {
      cameraDeviceEl.value = previousCamera;
    } else {
      const obsOption = Array.from(cameraDeviceEl.options).find((option) => /obs|virtual camera/i.test(option.textContent));
      if (obsOption) {
        cameraDeviceEl.value = obsOption.value;
      }
    }
  }

  const defaultAudio = document.createElement('option');
  defaultAudio.value = '';
  defaultAudio.textContent = 'System default audio input';
  audioDeviceEl.appendChild(defaultAudio);

  for (const input of audioInputs) {
    const option = document.createElement('option');
    option.value = input.deviceId;
    option.textContent = input.label || `Audio input ${audioDeviceEl.length}`;
    audioDeviceEl.appendChild(option);
  }

  if (previousAudio && audioInputs.some((a) => a.deviceId === previousAudio)) {
    audioDeviceEl.value = previousAudio;
  }
}

function makePeerConnection(role, targetViewerId = null) {
  const peer = new RTCPeerConnection(rtcConfig());

  peer.onicecandidate = (event) => {
    if (!event.candidate || !ws || ws.readyState !== WebSocket.OPEN) return;

    const data = {
      from: clientId,
      candidate: event.candidate
    };

    if (role === 'host' && targetViewerId) {
      data.to = targetViewerId;
    }

    ws.send(JSON.stringify({ type: 'signal', data }));
  };

  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;

    if (role === 'viewer') {
      if (state === 'connected') {
        setStatus('Connected to host stream.');
        viewerFormEl.classList.add('hidden');
        tuneReceiversForLatency(peer);
      }
      if (state === 'failed' || state === 'disconnected') {
        setStatus('Viewer connection dropped. Reconnect.');
      }
      return;
    }

    if (state === 'failed' || state === 'closed' || state === 'disconnected') {
      closeHostPeer(targetViewerId);
    }
    updateHostStats();
  };

  if (role === 'viewer') {
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      videoEl.srcObject = stream;
      videoEl.muted = false;
      videoEl.play().catch(() => setStatus('Press play to start video/audio.'));
    };
  }

  return peer;
}

function applyVideoSenderSettings(peer) {
  const profile = getLatencyProfile();
  const adaptive = adaptivePeerState.get(getPeerIdForConnection(peer)) || {};
  const maxBitrate = Math.min(
    adaptive.targetBitrate || Number(bitrateEl.value),
    profile.maxBitrate
  );
  for (const sender of peer.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const params = sender.getParameters() || {};
    const encoding = (params.encodings && params.encodings[0]) || {};
    encoding.maxBitrate = maxBitrate;
    encoding.maxFramerate = adaptive.targetFps || profile.maxFps;
    encoding.scaleResolutionDownBy = adaptive.scaleResolutionDownBy || 1;
    encoding.priority = 'high';
    encoding.networkPriority = 'high';
    encoding.active = true;
    if (profile.maxBitrate >= 20000000) {
      encoding.maxQuantizationParameter = 34;
    }
    params.encodings = [encoding];
    params.degradationPreference = 'maintain-resolution';
    sender.setParameters(params).catch(() => {});
  }
}

function addOrReplaceTrack(peer, stream, kind) {
  const track = stream.getTracks().find((t) => t.kind === kind) || null;
  const sender = peer.getSenders().find((s) => s.track?.kind === kind || (!s.track && kind === 'audio'));

  if (sender) {
    sender.replaceTrack(track).catch(() => {});
    return;
  }

  if (track) {
    peer.addTrack(track, stream);
  }
}

function syncPeerTracks(peer, stream) {
  addOrReplaceTrack(peer, stream, 'video');
  addOrReplaceTrack(peer, stream, 'audio');
  applyVideoSenderSettings(peer);
}

function getPeerIdForConnection(peer) {
  for (const [viewerId, mappedPeer] of hostPeers.entries()) {
    if (mappedPeer === peer) return viewerId;
  }
  return null;
}

function closeHostPeer(viewerId) {
  if (!viewerId) return;
  const peer = hostPeers.get(viewerId);
  if (peer) {
    try { peer.close(); } catch {}
  }
  hostPeers.delete(viewerId);
  hostPendingIceCandidates.delete(viewerId);
  adaptivePeerState.delete(viewerId);
  updateHostStats();
  syncAdaptiveStreamingLoop();
}

function closeAllHostPeers() {
  for (const [viewerId, peer] of hostPeers.entries()) {
    try { peer.close(); } catch {}
    hostPeers.delete(viewerId);
  }
  hostPendingIceCandidates.clear();
  adaptivePeerState.clear();
  updateHostStats();
  syncAdaptiveStreamingLoop();
}

function resetViewerPeer() {
  viewerPendingIceCandidates = [];
  if (viewerPc) {
    try { viewerPc.close(); } catch {}
    viewerPc = null;
  }
}

async function queueOrAddViewerIceCandidate(candidate) {
  if (!candidate || !viewerPc) return;
  if (!viewerPc.remoteDescription) {
    viewerPendingIceCandidates.push(candidate);
    return;
  }
  try {
    await viewerPc.addIceCandidate(candidate);
  } catch {}
}

async function flushViewerPendingIceCandidates() {
  if (!viewerPc || !viewerPc.remoteDescription || viewerPendingIceCandidates.length === 0) return;
  for (const candidate of viewerPendingIceCandidates.splice(0)) {
    try {
      await viewerPc.addIceCandidate(candidate);
    } catch {}
  }
}

async function queueOrAddHostIceCandidate(viewerId, candidate) {
  if (!viewerId || !candidate) return;

  const peer = hostPeers.get(viewerId);
  if (!peer || !peer.remoteDescription) {
    const queue = hostPendingIceCandidates.get(viewerId) || [];
    queue.push(candidate);
    hostPendingIceCandidates.set(viewerId, queue);
    return;
  }

  try {
    await peer.addIceCandidate(candidate);
  } catch {}
}

async function flushHostPendingIceCandidates(viewerId) {
  const peer = hostPeers.get(viewerId);
  const queue = hostPendingIceCandidates.get(viewerId) || [];
  if (!peer || !peer.remoteDescription || queue.length === 0) return;

  for (const candidate of queue.splice(0)) {
    try {
      await peer.addIceCandidate(candidate);
    } catch {}
  }
  hostPendingIceCandidates.set(viewerId, queue);
}

async function captureDisplayStream(useDisplayAudio) {
  const sourceId = displaySourceEl.value;
  if (!sourceId) {
    throw new Error('Select a display/window source first.');
  }

  const profile = getLatencyProfile();
  const videoConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      minWidth: 1280,
      maxWidth: profile.maxWidth,
      minHeight: 720,
      maxHeight: profile.maxHeight,
      minFrameRate: 30,
      maxFrameRate: profile.maxFps
    }
  };

  const audioConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId
    }
  };

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: useDisplayAudio ? audioConstraints : false
    });
  } catch (error) {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    } catch (fallbackError) {
      throw new Error(`Desktop capture failed: ${error?.message || error} / ${fallbackError?.message || fallbackError}`);
    }
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

    const profile = getLatencyProfile();
    const obsMaxWidth = profile.maxWidth;
    const obsMaxHeight = profile.maxHeight;
    const obsMaxFps = profile.maxFps;

    const camera = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: cameraId },
        frameRate: { ideal: obsMaxFps, max: obsMaxFps },
        width: { ideal: obsMaxWidth, max: obsMaxWidth },
        height: { ideal: obsMaxHeight, max: obsMaxHeight }
      },
      audio: false
    });
    tracks.push(...camera.getVideoTracks());
  }

  const useInputAudio = audioMode === 'input' || audioMode === 'display+input';
  if (useInputAudio) {
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2
    };

    if (audioDeviceEl.value) {
      audioConstraints.deviceId = { exact: audioDeviceEl.value };
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
    videoTrack.contentHint = source === 'display' ? 'detail' : 'motion';
    videoTrack.addEventListener('ended', () => {
      if (Date.now() < suppressTrackEndedUntil) return;
      if (!localStream) return;
      if (!localStream.getTracks().includes(videoTrack)) return;
      stopHost(true);
    });
  }

  return stream;
}

function stopTracks(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
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

  setStatus('Hosting started. Share Room ID + password.');
  syncAdaptiveStreamingLoop();
}

async function rebuildHostStreamForActiveSession() {
  if (!localStream) return;

  const oldStream = localStream;
  try {
    localStream = await buildHostStream();
  } catch (error) {
    setStatus('Could not apply new source: ' + (error?.message || error));
    localStream = oldStream;
    return;
  }

  videoEl.srcObject = localStream;
  videoEl.muted = true;

  for (const peer of hostPeers.values()) {
    syncPeerTracks(peer, localStream);
  }

  // Avoid false host-stop when old tracks end during source switch.
  suppressTrackEndedUntil = Date.now() + 2500;
  stopTracks(oldStream);
  setStatus('Source updated while live.');
}

async function handleLiveSourceChange() {
  if (mode !== 'host' || !localStream) return;
  await rebuildHostStreamForActiveSession();
}

function stopHost(sendSignal) {
  stopTracks(localStream);
  localStream = null;
  closeAllHostPeers();
  stopAdaptiveStreamingLoop();

  videoEl.srcObject = null;
  startHostBtn.disabled = false;
  stopHostBtn.disabled = true;

  if (sendSignal && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'broadcast-end' }));
  }

  hostStarting = false;
  setStatus('Hosting stopped.');
}

async function startViewer() {
  if (!joined) return;

  if (!hostAvailable) {
    pendingOffer = true;
    return;
  }

  resetViewerPeer();
  viewerPc = makePeerConnection('viewer');

  viewerPc.addTransceiver('video', { direction: 'recvonly' });
  viewerPc.addTransceiver('audio', { direction: 'recvonly' });

  setStatus('Connecting to host stream...');
  const offer = await viewerPc.createOffer();
  await viewerPc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: 'signal',
    data: {
      from: clientId,
      offer
    }
  }));
}

function stopViewer() {
  resetViewerPeer();
  videoEl.srcObject = null;
  viewerFormEl.classList.remove('hidden');
}

function createHostPeer(viewerId) {
  closeHostPeer(viewerId);
  const peer = makePeerConnection('host', viewerId);
  hostPeers.set(viewerId, peer);
  hostPendingIceCandidates.set(viewerId, hostPendingIceCandidates.get(viewerId) || []);
  adaptivePeerState.set(viewerId, {});
  syncPeerTracks(peer, localStream);
  updateHostStats();
  syncAdaptiveStreamingLoop();
  return peer;
}

async function handleSignal(data) {
  if (!data) return;

  try {
    if (mode === 'host') {
      if (!localStream) return;

      if (data.offer && data.from) {
        const viewerId = data.from;
        const peer = createHostPeer(viewerId);

        await peer.setRemoteDescription(data.offer);
        await flushHostPendingIceCandidates(viewerId);

        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);

        ws.send(JSON.stringify({
          type: 'signal',
          data: {
            from: clientId,
            to: viewerId,
            answer
          }
        }));
      }

      if (data.candidate && data.from) {
        await queueOrAddHostIceCandidate(data.from, data.candidate);
      }

      return;
    }

    if (mode === 'viewer') {
      if (data.to && data.to !== clientId) return;

      if (!viewerPc) {
        if (!data.answer && !data.candidate) return;
        viewerPc = makePeerConnection('viewer');
      }

      if (data.answer) {
        // Ignore stale/duplicate answers that arrive after negotiation already completed.
        if (viewerPc.signalingState !== 'have-local-offer') {
          return;
        }

        await viewerPc.setRemoteDescription(data.answer);
        await flushViewerPendingIceCandidates();
        tuneReceiversForLatency(viewerPc);
      }

      if (data.candidate) {
        await queueOrAddViewerIceCandidate(data.candidate);
      }
    }
  } catch (error) {
    setStatus('WebRTC signal error: ' + (error?.message || error));
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
  if (modeName === 'auto') {
    return { maxWidth: 3840, maxHeight: 2160, maxFps: 60, maxBitrate: 30000000, playoutDelay: 0.01 };
  }
  if (modeName === 'ultra') {
    return { maxWidth: 1920, maxHeight: 1080, maxFps: 60, maxBitrate: 12000000, playoutDelay: 0 };
  }
  if (modeName === 'low') {
    return { maxWidth: 2560, maxHeight: 1440, maxFps: 60, maxBitrate: 18000000, playoutDelay: 0.01 };
  }
  return { maxWidth: 3840, maxHeight: 2160, maxFps: 60, maxBitrate: 30000000, playoutDelay: 0.03 };
}

function tuneReceiversForLatency(peer) {
  const profile = getLatencyProfile();
  for (const receiver of peer.getReceivers()) {
    if (receiver.track?.kind === 'video') {
      try {
        receiver.playoutDelayHint = profile.playoutDelay;
      } catch {}
      try {
        receiver.jitterBufferTarget = 0;
      } catch {}
    }
  }
}

function syncAdaptiveStreamingLoop() {
  updateHostStats();
  if (mode !== 'host' || !localStream || latencyProfileEl.value !== 'auto' || hostPeers.size === 0) {
    stopAdaptiveStreamingLoop();
    return;
  }
  if (adaptiveTuneTimer) return;
  adaptiveTuneTimer = setInterval(() => {
    runAdaptiveStreamingPass().catch(() => {});
  }, 2500);
  runAdaptiveStreamingPass().catch(() => {});
}

function stopAdaptiveStreamingLoop() {
  if (adaptiveTuneTimer) {
    clearInterval(adaptiveTuneTimer);
    adaptiveTuneTimer = null;
  }
}

async function runAdaptiveStreamingPass() {
  if (latencyProfileEl.value !== 'auto' || mode !== 'host' || !localStream) return;
  for (const [viewerId, peer] of hostPeers.entries()) {
    if (!peer || peer.connectionState !== 'connected') continue;
    const adaptiveSettings = await measureAdaptiveSettings(peer);
    adaptivePeerState.set(viewerId, adaptiveSettings);
    applyVideoSenderSettings(peer);
  }
}

async function measureAdaptiveSettings(peer) {
  const profile = getLatencyProfile();
  const manualCap = Math.min(Number(bitrateEl.value), profile.maxBitrate);
  const stats = await peer.getStats();

  let availableOutgoingBitrate = 0;
  let roundTripTime = 0;
  let packetsLostRatio = 0;

  for (const report of stats.values()) {
    if (report.type === 'candidate-pair' && (report.nominated || report.selected)) {
      availableOutgoingBitrate = Math.max(availableOutgoingBitrate, Number(report.availableOutgoingBitrate) || 0);
      roundTripTime = Math.max(roundTripTime, Number(report.currentRoundTripTime) || 0);
    }
    if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
      roundTripTime = Math.max(roundTripTime, Number(report.roundTripTime) || 0);
      if (typeof report.fractionLost === 'number') {
        packetsLostRatio = Math.max(packetsLostRatio, Number(report.fractionLost) || 0);
      }
    }
  }

  const networkCap = availableOutgoingBitrate > 0 ? Math.min(availableOutgoingBitrate * 0.82, manualCap) : manualCap;
  let targetBitrate = Math.max(3_500_000, networkCap);
  let targetFps = 60;
  let scaleResolutionDownBy = 1;

  if (packetsLostRatio > 0.08 || roundTripTime > 0.18) {
    targetBitrate = Math.max(3_500_000, networkCap * 0.42);
    targetFps = 24;
    scaleResolutionDownBy = 2;
  } else if (packetsLostRatio > 0.045 || roundTripTime > 0.12) {
    targetBitrate = Math.max(5_000_000, networkCap * 0.58);
    targetFps = 30;
    scaleResolutionDownBy = 1.5;
  } else if (packetsLostRatio > 0.02 || roundTripTime > 0.08) {
    targetBitrate = Math.max(7_000_000, networkCap * 0.72);
    targetFps = 45;
    scaleResolutionDownBy = 1.25;
  } else {
    targetBitrate = Math.max(8_000_000, networkCap * 0.9);
    targetFps = profile.maxFps;
    scaleResolutionDownBy = 1;
  }

  return {
    targetBitrate: Math.round(Math.min(targetBitrate, profile.maxBitrate)),
    targetFps,
    scaleResolutionDownBy,
    roundTripTime,
    packetsLostRatio
  };
}

