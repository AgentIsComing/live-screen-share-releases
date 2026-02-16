const params = new URLSearchParams(window.location.search);
const roomId = params.get('room') || 'default-room';

const statusEl = document.getElementById('status');
const roomText = document.getElementById('roomText');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const preview = document.getElementById('preview');
const qualitySelect = document.getElementById('quality');
const viewerLinkInput = document.getElementById('viewerLink');
const copyBtn = document.getElementById('copyBtn');

roomText.textContent = `Room: ${roomId}`;
const viewerUrl = `${window.location.origin}/viewer.html?room=${encodeURIComponent(roomId)}`;
viewerLinkInput.value = viewerUrl;

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(viewerUrl);
    setStatus('Viewer link copied. Send it to your friend.');
  } catch {
    setStatus('Could not copy. Copy the link manually.');
  }
});

const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`);
const pcMap = new Map();
let localStream = null;
let isSharing = false;
const hostId = `host-${Math.random().toString(36).slice(2, 10)}`;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  bundlePolicy: 'max-bundle',
  iceCandidatePoolSize: 10
};

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'join', role: 'host', roomId, clientId: hostId }));
});

ws.addEventListener('message', async (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'joined') {
    setStatus('Connected to signaling server.');
    return;
  }

  if (message.type === 'viewer-joined') {
    setStatus('Viewer joined. Start sharing to connect.');
    return;
  }

  if (message.type === 'signal') {
    await handleSignal(message.data);
    return;
  }

  if (message.type === 'error') {
    setStatus(`Error: ${message.message}`);
  }
});

startBtn.addEventListener('click', startSharing);
stopBtn.addEventListener('click', stopSharing);

function setStatus(text) {
  statusEl.textContent = text;
}

async function startSharing() {
  if (isSharing) return;

  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2
      }
    });
  } catch (error) {
    setStatus(`Share canceled or failed: ${error.message}`);
    return;
  }

  const videoTrack = localStream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.contentHint = 'detail';
    videoTrack.addEventListener('ended', stopSharing);
  }

  preview.srcObject = localStream;
  isSharing = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;

  setStatus('Sharing started. Waiting for viewer offer...');
}

async function stopSharing() {
  if (!isSharing && !localStream) return;

  isSharing = false;

  if (localStream) {
    for (const track of localStream.getTracks()) {
      track.stop();
    }
  }

  localStream = null;
  preview.srcObject = null;

  for (const pc of pcMap.values()) {
    pc.close();
  }
  pcMap.clear();

  ws.send(JSON.stringify({ type: 'broadcast-end' }));

  startBtn.disabled = false;
  stopBtn.disabled = true;
  setStatus('Sharing stopped.');
}

function makePc(peerId) {
  const pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    ws.send(JSON.stringify({
      type: 'signal',
      data: { from: hostId, to: peerId, candidate: event.candidate }
    }));
  };

  if (localStream) {
    const maxBitrate = Number(qualitySelect.value);

    for (const track of localStream.getTracks()) {
      const sender = pc.addTrack(track, localStream);

      if (track.kind === 'video') {
        const params = sender.getParameters();
        params.degradationPreference = 'maintain-resolution';
        params.encodings = [{ maxBitrate, maxFramerate: 60 }];
        sender.setParameters(params).catch(() => {
          // Ignore unsupported parameter config.
        });
      }
    }
  }

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setStatus('Viewer connected with P2P stream.');
    }
  };

  return pc;
}

async function handleSignal(data) {
  const peerId = data.from;
  if (!peerId) return;

  let pc = pcMap.get(peerId);

  if (!pc && data.offer) {
    if (!localStream) {
      setStatus('Viewer requested stream, but sharing is not started.');
      return;
    }

    pc = makePc(peerId);
    pcMap.set(peerId, pc);

    await pc.setRemoteDescription(data.offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    ws.send(JSON.stringify({
      type: 'signal',
      data: { from: hostId, to: peerId, answer }
    }));
    return;
  }

  if (!pc) return;

  if (data.candidate) {
    await pc.addIceCandidate(data.candidate);
  }
}

window.addEventListener('beforeunload', () => {
  stopSharing();
  ws.close();
});
