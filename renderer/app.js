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
const annotationCanvasEl = document.getElementById('annotationCanvas');
const annotationHintEl = document.getElementById('annotationHint');
const viewerAnnotationPanelEl = document.getElementById('viewerAnnotationPanel');
const viewerBrushColorEl = document.getElementById('viewerBrushColor');
const viewerClearOwnBtn = document.getElementById('viewerClearOwn');
const hostAnnotationPanelEl = document.getElementById('hostAnnotationPanel');
const annotationViewerSelectEl = document.getElementById('annotationViewerSelect');
const hostClearViewerBtn = document.getElementById('hostClearViewer');
const hostClearAllBtn = document.getElementById('hostClearAll');

const DEFAULT_CODE_SERVICE_URL = 'https://live-screen-share-code-service.jaydenrmaine.workers.dev';
const DRAWING_FEATURE_ENABLED = false;

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
let adaptiveTuneInFlight = false;
let hostAllowsViewerDrawing = false;
let viewerDrawingEnabled = false;
let annotationPointerActive = false;
let annotationStrokeId = null;
let annotationStrokeWidth = 3;
let annotationBrushColor = '#ff6b57';
let annotationContext = null;
let annotationCanvasW = 0;
let annotationCanvasH = 0;

let localStream = null;
let viewerPc = null;
let viewerPendingIceCandidates = [];
const hostPeers = new Map();
const hostPendingIceCandidates = new Map();
const adaptivePeerState = new Map();
const hostPeerDisconnectTimers = new Map();
const annotationStrokeState = new Map();
const annotationSegments = [];
const MAX_ANNOTATION_SEGMENTS = 4000;

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
  if (DRAWING_FEATURE_ENABLED) {
    viewerBrushColorEl.addEventListener('input', () => {
      annotationBrushColor = viewerBrushColorEl.value || '#ff6b57';
    });
    viewerClearOwnBtn.addEventListener('click', clearOwnViewerAnnotations);
    hostClearViewerBtn.addEventListener('click', clearSelectedViewerAnnotations);
    hostClearAllBtn.addEventListener('click', clearAllAnnotationsFromHost);
  }

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
  if (DRAWING_FEATURE_ENABLED) {
    document.addEventListener('keydown', onGlobalKeydown);
    window.addEventListener('resize', resizeAnnotationCanvas);
    videoEl.addEventListener('loadedmetadata', resizeAnnotationCanvas);
    annotationCanvasEl.addEventListener('pointerdown', onAnnotationPointerDown);
    annotationCanvasEl.addEventListener('pointermove', onAnnotationPointerMove);
    annotationCanvasEl.addEventListener('pointerup', onAnnotationPointerUp);
    annotationCanvasEl.addEventListener('pointercancel', onAnnotationPointerUp);
    annotationCanvasEl.addEventListener('pointerleave', onAnnotationPointerUp);
  }

  syncHostSourceUI();
  if (DRAWING_FEATURE_ENABLED) {
    updateAnnotationPermissionUI();
    resizeAnnotationCanvas();
  } else {
    annotationCanvasEl.classList.add('hidden');
    annotationHintEl.classList.add('hidden');
    viewerAnnotationPanelEl.classList.add('hidden');
    hostAnnotationPanelEl.classList.add('hidden');
  }
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
  if (DRAWING_FEATURE_ENABLED) {
    clearAnnotationOverlay();
    updateAnnotationPermissionUI();
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
  }
}

function syncModeUI() {
  const isHost = mode === 'host';
  hostPanel.classList.toggle('hidden', !isHost);
  viewerPanel.classList.toggle('hidden', isHost);
  if (DRAWING_FEATURE_ENABLED) {
    hostAnnotationPanelEl.classList.toggle('hidden', !isHost);
    viewerAnnotationPanelEl.classList.toggle('hidden', isHost);
  } else {
    hostAnnotationPanelEl.classList.add('hidden');
    viewerAnnotationPanelEl.classList.add('hidden');
  }

  modeEl.parentElement.classList.remove('hidden');
  codeServiceWrapEl.classList.toggle('hidden', !isHost);
  connectivityWrapEl.classList.toggle('hidden', !isHost);
  latencyWrapEl.classList.toggle('hidden', !isHost);
  bitrateWrapEl.classList.toggle('hidden', !isHost);
  modeButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });

  videoEl.muted = isHost;
  if (DRAWING_FEATURE_ENABLED) {
    updateAnnotationViewerSelect();
  }
}

function onGlobalKeydown(event) {
  if (!DRAWING_FEATURE_ENABLED) return;
  if (mode !== 'host') return;
  if (!event.ctrlKey || !event.shiftKey) return;
  if (event.repeat) return;
  if (String(event.key || '').toLowerCase() !== 'd') return;

  event.preventDefault();
  hostAllowsViewerDrawing = !hostAllowsViewerDrawing;
  updateAnnotationPermissionUI();
  broadcastDrawingPermission();
  setStatus(hostAllowsViewerDrawing
    ? 'Viewer drawing enabled. Press Ctrl+Shift+D to lock drawing.'
    : 'Viewer drawing locked. Press Ctrl+Shift+D to allow drawing.');
}

function updateAnnotationPermissionUI() {
  if (!DRAWING_FEATURE_ENABLED) return;
  if (!annotationCanvasEl || !annotationHintEl) return;
  const drawingAllowedOnThisClient = mode === 'viewer' && viewerDrawingEnabled;
  annotationCanvasEl.classList.toggle('draw-enabled', drawingAllowedOnThisClient);
  viewerBrushColorEl.disabled = mode !== 'viewer' || !viewerDrawingEnabled;
  viewerClearOwnBtn.disabled = mode !== 'viewer';
  hostClearViewerBtn.disabled = mode !== 'host' || !annotationViewerSelectEl.value;
  hostClearAllBtn.disabled = mode !== 'host' || annotationSegments.length === 0;

  if (mode === 'host') {
    annotationHintEl.textContent = hostAllowsViewerDrawing
      ? 'Viewer drawing: ON (Ctrl+Shift+D to lock)'
      : 'Viewer drawing: OFF (Ctrl+Shift+D to allow)';
    return;
  }

  annotationHintEl.textContent = viewerDrawingEnabled
    ? 'Drawing enabled by host. Hold left-click and draw.'
    : 'Host has drawing locked.';
}

function updateAnnotationViewerSelect() {
  if (!DRAWING_FEATURE_ENABLED) return;
  if (!annotationViewerSelectEl) return;
  const viewerIds = Array.from(hostPeers.keys());
  const previousValue = annotationViewerSelectEl.value;
  annotationViewerSelectEl.innerHTML = '';

  if (viewerIds.length === 0) {
    annotationViewerSelectEl.innerHTML = '<option value="">No viewers connected</option>';
    annotationViewerSelectEl.value = '';
    updateAnnotationPermissionUI();
    return;
  }

  for (const viewerId of viewerIds) {
    const option = document.createElement('option');
    option.value = viewerId;
    option.textContent = viewerId;
    annotationViewerSelectEl.appendChild(option);
  }

  annotationViewerSelectEl.value = viewerIds.includes(previousValue) ? previousValue : viewerIds[0];
  updateAnnotationPermissionUI();
}

function resizeAnnotationCanvas() {
  if (!annotationCanvasEl) return;
  const rect = annotationCanvasEl.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(rect.width));
  const cssHeight = Math.max(1, Math.round(rect.height));
  const dpr = window.devicePixelRatio || 1;
  const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
  const targetHeight = Math.max(1, Math.round(cssHeight * dpr));

  if (annotationCanvasW === targetWidth && annotationCanvasH === targetHeight && annotationContext) {
    return;
  }

  annotationCanvasW = targetWidth;
  annotationCanvasH = targetHeight;
  annotationCanvasEl.width = targetWidth;
  annotationCanvasEl.height = targetHeight;

  annotationContext = annotationCanvasEl.getContext('2d');
  if (!annotationContext) return;
  annotationContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawAllAnnotationSegments();
}

function clearAnnotationOverlay(ownerId = null) {
  if (!ownerId) {
    annotationStrokeState.clear();
    annotationSegments.length = 0;
  } else {
    for (const [strokeId, state] of annotationStrokeState.entries()) {
      if (state.ownerId === ownerId) {
        annotationStrokeState.delete(strokeId);
      }
    }
    for (let i = annotationSegments.length - 1; i >= 0; i -= 1) {
      if (annotationSegments[i].ownerId === ownerId) {
        annotationSegments.splice(i, 1);
      }
    }
  }
  if (!annotationContext) {
    resizeAnnotationCanvas();
  }
  redrawAllAnnotationSegments();
  updateAnnotationPermissionUI();
}

function getVideoContentRect() {
  const width = videoEl.clientWidth || annotationCanvasEl.clientWidth || 1;
  const height = videoEl.clientHeight || annotationCanvasEl.clientHeight || 1;
  const videoWidth = videoEl.videoWidth || 16;
  const videoHeight = videoEl.videoHeight || 9;

  let drawWidth = width;
  let drawHeight = drawWidth * (videoHeight / videoWidth);
  if (drawHeight > height) {
    drawHeight = height;
    drawWidth = drawHeight * (videoWidth / videoHeight);
  }

  return {
    x: (width - drawWidth) / 2,
    y: (height - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight
  };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function toNormalizedPoint(event) {
  const canvasRect = annotationCanvasEl.getBoundingClientRect();
  if (!canvasRect.width || !canvasRect.height) return null;

  const pointerX = event.clientX - canvasRect.left;
  const pointerY = event.clientY - canvasRect.top;
  const videoRect = getVideoContentRect();
  if (videoRect.width <= 0 || videoRect.height <= 0) return null;

  if (
    pointerX < videoRect.x
    || pointerX > videoRect.x + videoRect.width
    || pointerY < videoRect.y
    || pointerY > videoRect.y + videoRect.height
  ) {
    return null;
  }

  return {
    x: clamp01((pointerX - videoRect.x) / videoRect.width),
    y: clamp01((pointerY - videoRect.y) / videoRect.height)
  };
}

function toCanvasPoint(point) {
  const videoRect = getVideoContentRect();
  return {
    x: videoRect.x + (clamp01(point.x) * videoRect.width),
    y: videoRect.y + (clamp01(point.y) * videoRect.height)
  };
}

function drawAnnotationSegmentRaw(fromPoint, toPoint, color = '#ff6b57', width = 3) {
  if (!annotationContext) {
    resizeAnnotationCanvas();
  }
  if (!annotationContext) return;

  const fromCanvas = toCanvasPoint(fromPoint);
  const toCanvas = toCanvasPoint(toPoint);
  annotationContext.strokeStyle = color;
  annotationContext.lineWidth = width;
  annotationContext.lineCap = 'round';
  annotationContext.lineJoin = 'round';
  annotationContext.shadowColor = 'rgba(255, 107, 87, 0.22)';
  annotationContext.shadowBlur = 3;
  annotationContext.beginPath();
  annotationContext.moveTo(fromCanvas.x, fromCanvas.y);
  annotationContext.lineTo(toCanvas.x, toCanvas.y);
  annotationContext.stroke();
  annotationContext.shadowBlur = 0;
}

function pushAndDrawAnnotationSegment(segment) {
  annotationSegments.push(segment);
  if (annotationSegments.length > MAX_ANNOTATION_SEGMENTS) {
    annotationSegments.splice(0, annotationSegments.length - MAX_ANNOTATION_SEGMENTS);
  }
  drawAnnotationSegmentRaw(segment.from, segment.to, segment.color, segment.width);
}

function clearOwnViewerAnnotations() {
  if (!DRAWING_FEATURE_ENABLED) return;
  if (mode !== 'viewer') return;
  sendDrawSignal({
    type: 'clear-owner',
    ownerId: clientId
  });
}

function clearSelectedViewerAnnotations() {
  if (!DRAWING_FEATURE_ENABLED) return;
  if (mode !== 'host') return;
  const ownerId = annotationViewerSelectEl.value;
  if (!ownerId) return;
  applyAndBroadcastDrawPayload({
    type: 'clear-owner',
    ownerId
  });
}

function clearAllAnnotationsFromHost() {
  if (!DRAWING_FEATURE_ENABLED) return;
  if (mode !== 'host') return;
  applyAndBroadcastDrawPayload({
    type: 'clear'
  });
}

function applyAndBroadcastDrawPayload(drawPayload) {
  if (!drawPayload) return;
  if (drawPayload.type === 'clear') {
    clearAnnotationOverlay();
  } else if (drawPayload.type === 'clear-owner' && drawPayload.ownerId) {
    clearAnnotationOverlay(drawPayload.ownerId);
  } else if (drawPayload.type.startsWith('stroke-')) {
    handleDrawEvent(drawPayload);
  }

  for (const viewerId of hostPeers.keys()) {
    if (!ws || ws.readyState !== WebSocket.OPEN) break;
    ws.send(JSON.stringify({
      type: 'signal',
      data: {
        from: clientId,
        to: viewerId,
        draw: drawPayload
      }
    }));
  }
  updateAnnotationPermissionUI();
}

function redrawAllAnnotationSegments() {
  if (!annotationContext) return;
  annotationContext.clearRect(0, 0, annotationCanvasEl.clientWidth, annotationCanvasEl.clientHeight);
  for (const segment of annotationSegments) {
    drawAnnotationSegmentRaw(segment.from, segment.to, segment.color, segment.width);
  }
}

function sendDrawSignal(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'signal',
    data: {
      from: clientId,
      draw: payload
    }
  }));
}

function onAnnotationPointerDown(event) {
  if (mode !== 'viewer' || !viewerDrawingEnabled || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (event.button !== 0) return;

  const point = toNormalizedPoint(event);
  if (!point) return;

  annotationPointerActive = true;
  annotationStrokeId = `${clientId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  annotationCanvasEl.setPointerCapture(event.pointerId);

  sendDrawSignal({
    type: 'stroke-start',
    strokeId: annotationStrokeId,
    ownerId: clientId,
    point,
    color: annotationBrushColor,
    width: annotationStrokeWidth
  });
}

function onAnnotationPointerMove(event) {
  if (!annotationPointerActive || !annotationStrokeId || mode !== 'viewer' || !viewerDrawingEnabled) return;
  const point = toNormalizedPoint(event);
  if (!point) return;

  sendDrawSignal({
    type: 'stroke-move',
    strokeId: annotationStrokeId,
    ownerId: clientId,
    point,
    color: annotationBrushColor,
    width: annotationStrokeWidth
  });
}

function onAnnotationPointerUp(event) {
  if (!annotationPointerActive || !annotationStrokeId || mode !== 'viewer') return;
  const point = toNormalizedPoint(event);
  sendDrawSignal({
    type: 'stroke-end',
    strokeId: annotationStrokeId,
    ownerId: clientId,
    point,
    color: annotationBrushColor,
    width: annotationStrokeWidth
  });

  annotationPointerActive = false;
  annotationStrokeId = null;
  try {
    annotationCanvasEl.releasePointerCapture(event.pointerId);
  } catch {}
}

function handleDrawEvent(drawEvent) {
  if (!drawEvent || !drawEvent.strokeId || !drawEvent.type) return;
  const strokeId = drawEvent.strokeId;
  const ownerId = drawEvent.ownerId || 'unknown';
  const color = drawEvent.color || '#ff6b57';
  const width = Number(drawEvent.width) || annotationStrokeWidth;

  if (drawEvent.type === 'stroke-start') {
    if (!drawEvent.point) return;
    annotationStrokeState.set(strokeId, {
      point: drawEvent.point,
      ownerId,
      color,
      width
    });
    updateAnnotationPermissionUI();
    return;
  }

  if (drawEvent.type === 'stroke-move' || drawEvent.type === 'stroke-end') {
    const state = annotationStrokeState.get(strokeId);
    const nextPoint = drawEvent.point || state?.point;
    if (!state || !nextPoint) {
      if (drawEvent.type === 'stroke-end') {
        annotationStrokeState.delete(strokeId);
      }
      return;
    }

    const segment = {
      from: state.point,
      to: nextPoint,
      ownerId: state.ownerId,
      color,
      width
    };
    pushAndDrawAnnotationSegment(segment);
    annotationStrokeState.set(strokeId, {
      point: nextPoint,
      ownerId: state.ownerId,
      color,
      width
    });

    if (drawEvent.type === 'stroke-end') {
      annotationStrokeState.delete(strokeId);
    }
    updateAnnotationPermissionUI();
  }
}

function sendDrawPermissionToViewer(viewerId) {
  if (!viewerId || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'signal',
    data: {
      from: clientId,
      to: viewerId,
      draw: {
        type: 'permission',
        allowed: hostAllowsViewerDrawing
      }
    }
  }));
}

function broadcastDrawingPermission() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  for (const viewerId of hostPeers.keys()) {
    sendDrawPermissionToViewer(viewerId);
  }
  if (!hostAllowsViewerDrawing) {
    applyAndBroadcastDrawPayload({ type: 'clear' });
  }
}

function handleHostDrawSignal(drawPayload) {
  if (!DRAWING_FEATURE_ENABLED) return;
  if (!drawPayload || !drawPayload.type) return;
  if (drawPayload.type === 'permission') {
    viewerDrawingEnabled = Boolean(drawPayload.allowed);
    if (!viewerDrawingEnabled) {
      annotationPointerActive = false;
      annotationStrokeId = null;
    }
    updateAnnotationPermissionUI();
    return;
  }

  if (drawPayload.type === 'clear') {
    clearAnnotationOverlay();
    return;
  }

  if (drawPayload.type === 'clear-owner' && drawPayload.ownerId) {
    clearAnnotationOverlay(drawPayload.ownerId);
    return;
  }

  if (drawPayload.type.startsWith('stroke-')) {
    handleDrawEvent(drawPayload);
  }
}

function handleViewerDrawSignal(fromViewerId, drawPayload) {
  if (!DRAWING_FEATURE_ENABLED) return;
  if (!drawPayload || !drawPayload.type) return;
  if (!hostAllowsViewerDrawing) return;
  const normalizedPayload = { ...drawPayload, ownerId: drawPayload.ownerId || fromViewerId };
  if (normalizedPayload.type === 'clear-owner') {
    normalizedPayload.ownerId = fromViewerId;
  }
  applyAndBroadcastDrawPayload(normalizedPayload);
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

    if (state === 'connected') {
      clearHostPeerDisconnectTimer(targetViewerId);
    }
    if (state === 'disconnected') {
      scheduleHostPeerDisconnectClose(targetViewerId, peer);
    }
    if (state === 'failed' || state === 'closed') {
      closeHostPeer(targetViewerId);
    }
    updateHostStats();
  };

  if (role === 'viewer') {
    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
      }
      videoEl.muted = false;
      videoEl.play().catch(() => setStatus('Press play to start video/audio.'));
    };
  }

  return peer;
}

function applyVideoSenderSettings(peer) {
  const profile = getLatencyProfile();
  const viewerId = getPeerIdForConnection(peer);
  const adaptive = adaptivePeerState.get(viewerId) || {};
  const connectedPeers = Array.from(hostPeers.values()).filter((hostPeer) => hostPeer.connectionState === 'connected');
  const activeViewerCount = Math.max(connectedPeers.length, 1);
  const manualCap = Math.min(Number(bitrateEl.value), profile.maxBitrate);
  const perViewerBudget = activeViewerCount > 1
    ? Math.max(2_200_000, Math.round((manualCap * 0.9) / activeViewerCount))
    : manualCap;
  const maxBitrate = Math.min(
    adaptive.targetBitrate || manualCap,
    profile.maxBitrate,
    perViewerBudget
  );
  const framerateBudgetCap = activeViewerCount > 1 ? Math.min(profile.maxFps, 45) : profile.maxFps;
  const maxFramerate = Math.min(adaptive.targetFps || profile.maxFps, framerateBudgetCap);
  let scaleResolutionDownBy = adaptive.scaleResolutionDownBy || 1;
  if (activeViewerCount > 1 && scaleResolutionDownBy < 1.15) {
    scaleResolutionDownBy = 1.15;
  }
  for (const sender of peer.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    const params = sender.getParameters() || {};
    const currentEncoding = (params.encodings && params.encodings[0]) || {};
    const encoding = { ...currentEncoding };
    encoding.maxBitrate = maxBitrate;
    encoding.maxFramerate = maxFramerate;
    encoding.scaleResolutionDownBy = scaleResolutionDownBy;
    encoding.priority = 'high';
    encoding.networkPriority = 'high';
    encoding.active = true;
    if (profile.maxBitrate >= 20000000) {
      encoding.maxQuantizationParameter = 34;
    }

    const bitrateDelta = Math.abs((currentEncoding.maxBitrate || 0) - maxBitrate);
    const fpsDelta = Math.abs((currentEncoding.maxFramerate || 0) - maxFramerate);
    const scaleDelta = Math.abs((currentEncoding.scaleResolutionDownBy || 1) - scaleResolutionDownBy);
    const degradationPreference = latencyProfileEl.value === 'auto' ? 'balanced' : 'maintain-resolution';
    if (
      bitrateDelta < 350000
      && fpsDelta < 6
      && scaleDelta < 0.24
      && params.degradationPreference === degradationPreference
    ) {
      continue;
    }

    params.encodings = [encoding];
    params.degradationPreference = degradationPreference;
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

function clearHostPeerDisconnectTimer(viewerId) {
  if (!viewerId) return;
  const timer = hostPeerDisconnectTimers.get(viewerId);
  if (!timer) return;
  clearTimeout(timer);
  hostPeerDisconnectTimers.delete(viewerId);
}

function scheduleHostPeerDisconnectClose(viewerId, peer) {
  if (!viewerId || !peer || hostPeerDisconnectTimers.has(viewerId)) return;
  const timer = setTimeout(() => {
    hostPeerDisconnectTimers.delete(viewerId);
    const currentPeer = hostPeers.get(viewerId);
    if (currentPeer !== peer) return;
    if (peer.connectionState === 'connected') return;
    closeHostPeer(viewerId);
  }, 8500);
  hostPeerDisconnectTimers.set(viewerId, timer);
}

function closeHostPeer(viewerId) {
  if (!viewerId) return;
  clearHostPeerDisconnectTimer(viewerId);
  const peer = hostPeers.get(viewerId);
  if (peer) {
    try { peer.close(); } catch {}
  }
  hostPeers.delete(viewerId);
  hostPendingIceCandidates.delete(viewerId);
  adaptivePeerState.delete(viewerId);
  clearAnnotationOverlay(viewerId);
  updateAnnotationViewerSelect();
  updateHostStats();
  syncAdaptiveStreamingLoop();
}

function closeAllHostPeers() {
  for (const timer of hostPeerDisconnectTimers.values()) {
    clearTimeout(timer);
  }
  hostPeerDisconnectTimers.clear();
  for (const [viewerId, peer] of hostPeers.entries()) {
    try { peer.close(); } catch {}
    hostPeers.delete(viewerId);
  }
  hostPendingIceCandidates.clear();
  adaptivePeerState.clear();
  updateAnnotationViewerSelect();
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
  updateAnnotationPermissionUI();
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
  clearAnnotationOverlay();
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
  clearAnnotationOverlay();
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
  viewerDrawingEnabled = false;
  annotationPointerActive = false;
  annotationStrokeId = null;
  updateAnnotationPermissionUI();
  clearAnnotationOverlay();
  viewerFormEl.classList.remove('hidden');
}

function createHostPeer(viewerId) {
  closeHostPeer(viewerId);
  const peer = makePeerConnection('host', viewerId);
  hostPeers.set(viewerId, peer);
  hostPendingIceCandidates.set(viewerId, hostPendingIceCandidates.get(viewerId) || []);
  adaptivePeerState.set(viewerId, createInitialAdaptiveState());
  syncPeerTracks(peer, localStream);
  sendDrawPermissionToViewer(viewerId);
  updateAnnotationViewerSelect();
  updateHostStats();
  syncAdaptiveStreamingLoop();
  return peer;
}

async function handleSignal(data) {
  if (!data) return;

  try {
    if (mode === 'host') {
      if (!localStream) return;

      if (data.draw && data.from) {
        handleViewerDrawSignal(data.from, data.draw);
        return;
      }

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

      if (data.draw) {
        handleHostDrawSignal(data.draw);
        return;
      }

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
  setUpdateStatus('Checking for updates...');
  const result = await window.desktopApp.checkForUpdates();
  if (!result.ok) {
    setUpdateStatus('Update check failed: ' + result.error);
    return;
  }
}

function getLatencyProfile() {
  const modeName = latencyProfileEl.value;
  if (modeName === 'auto') {
    return { maxWidth: 1920, maxHeight: 1080, maxFps: 60, maxBitrate: 16000000, playoutDelay: 0.01 };
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
  adaptiveTuneInFlight = false;
}

async function runAdaptiveStreamingPass() {
  if (adaptiveTuneInFlight || latencyProfileEl.value !== 'auto' || mode !== 'host' || !localStream) return;
  adaptiveTuneInFlight = true;
  try {
  for (const [viewerId, peer] of hostPeers.entries()) {
    if (!peer || peer.connectionState !== 'connected') continue;
    const adaptiveSettings = await measureAdaptiveSettings(peer, adaptivePeerState.get(viewerId) || createInitialAdaptiveState());
    adaptivePeerState.set(viewerId, adaptiveSettings);
    applyVideoSenderSettings(peer);
  }
  } finally {
    adaptiveTuneInFlight = false;
  }
}

function createInitialAdaptiveState() {
  return {
    connectedAt: Date.now(),
    smoothedRoundTripTime: 0,
    smoothedPacketsLostRatio: 0,
    poorPasses: 0,
    goodPasses: 0,
    targetBitrate: 9000000,
    targetFps: 60,
    scaleResolutionDownBy: 1,
    lastAppliedAt: 0
  };
}

function normalizePacketsLostRatio(value) {
  const parsed = Number(value) || 0;
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  if (parsed > 1) return Math.min(parsed / 256, 1);
  return Math.min(parsed, 1);
}

function smoothValue(previousValue, nextValue, riseFactor, fallFactor) {
  if (!previousValue) return nextValue;
  const factor = nextValue >= previousValue ? riseFactor : fallFactor;
  return previousValue + ((nextValue - previousValue) * factor);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function measureAdaptiveSettings(peer, previousState) {
  const profile = getLatencyProfile();
  const manualCap = Math.min(Number(bitrateEl.value), profile.maxBitrate);
  const connectedViewerCount = Math.max(
    1,
    Array.from(hostPeers.values()).filter((hostPeer) => hostPeer.connectionState === 'connected').length
  );
  const minBitrate = connectedViewerCount > 1 ? 1_800_000 : 2_500_000;
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
        packetsLostRatio = Math.max(packetsLostRatio, normalizePacketsLostRatio(report.fractionLost));
      }
    }
  }

  const connectedAt = previousState.connectedAt || Date.now();
  const connectionAgeMs = Date.now() - connectedAt;
  const smoothedRoundTripTime = smoothValue(previousState.smoothedRoundTripTime, roundTripTime, 0.2, 0.35);
  const smoothedPacketsLostRatio = smoothValue(previousState.smoothedPacketsLostRatio, packetsLostRatio, 0.22, 0.38);
  const networkCap = availableOutgoingBitrate > 0 ? Math.min(availableOutgoingBitrate * 0.9, manualCap) : manualCap;
  const warmupBitrateFloor = Math.min(manualCap, connectedViewerCount > 1 ? 6_500_000 : 8_500_000);
  let poorPasses = previousState.poorPasses || 0;
  let goodPasses = previousState.goodPasses || 0;
  let targetBitrate = Math.max(warmupBitrateFloor, networkCap);
  let targetFps = connectedViewerCount > 1 ? Math.min(profile.maxFps, 45) : profile.maxFps;
  let scaleResolutionDownBy = 1;

  const severe = smoothedPacketsLostRatio > 0.08 || smoothedRoundTripTime > 0.2;
  const moderate = smoothedPacketsLostRatio > 0.04 || smoothedRoundTripTime > 0.12;
  const mild = smoothedPacketsLostRatio > 0.02 || smoothedRoundTripTime > 0.08;

  if (severe || moderate) {
    poorPasses += 1;
    goodPasses = 0;
  } else if (!mild) {
    goodPasses += 1;
    poorPasses = 0;
  } else {
    poorPasses = Math.max(poorPasses - 1, 0);
    goodPasses = 0;
  }

  if (connectionAgeMs < 7000 && !severe) {
    targetBitrate = clamp(networkCap, warmupBitrateFloor, manualCap);
    targetFps = profile.maxFps;
  } else if (severe && poorPasses >= 2) {
    targetBitrate = Math.max(minBitrate, networkCap * 0.5);
    targetFps = 24;
    scaleResolutionDownBy = poorPasses >= 4 ? 1.75 : 1.4;
  } else if (moderate && poorPasses >= 2) {
    targetBitrate = Math.max(Math.round(minBitrate * 1.4), networkCap * 0.65);
    targetFps = 30;
    scaleResolutionDownBy = 1.25;
  } else if (mild) {
    targetBitrate = Math.max(Math.round(minBitrate * 1.8), networkCap * 0.8);
    targetFps = 45;
    scaleResolutionDownBy = connectedViewerCount > 1 ? 1.2 : 1.1;
  } else {
    targetBitrate = Math.max(Math.round(minBitrate * 2.1), networkCap * 0.92);
    targetFps = connectedViewerCount > 1 ? Math.min(profile.maxFps, 45) : profile.maxFps;
    scaleResolutionDownBy = connectedViewerCount > 1 ? 1.15 : 1;
  }

  if (goodPasses >= 3) {
    scaleResolutionDownBy = 1;
    targetFps = profile.maxFps;
  }

  targetBitrate = clamp(
    smoothValue(previousState.targetBitrate, targetBitrate, 0.18, 0.32),
    minBitrate,
    manualCap
  );
  targetFps = Math.round(clamp(smoothValue(previousState.targetFps, targetFps, 0.25, 0.4), 30, profile.maxFps));
  scaleResolutionDownBy = clamp(
    smoothValue(previousState.scaleResolutionDownBy, scaleResolutionDownBy, 0.2, 0.45),
    1,
    1.75
  );

  return {
    connectedAt,
    targetBitrate: Math.round(Math.min(targetBitrate, profile.maxBitrate)),
    targetFps,
    scaleResolutionDownBy,
    roundTripTime,
    packetsLostRatio,
    smoothedRoundTripTime,
    smoothedPacketsLostRatio,
    poorPasses,
    goodPasses,
    lastAppliedAt: Date.now()
  };
}

