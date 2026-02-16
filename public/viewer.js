const params = new URLSearchParams(window.location.search);
const roomId = params.get('room') || 'default-room';

const statusEl = document.getElementById('status');
const roomText = document.getElementById('roomText');
const connectBtn = document.getElementById('connectBtn');
const remoteVideo = document.getElementById('remote');

roomText.textContent = `Room: ${roomId}`;

const viewerId = `viewer-${Math.random().toString(36).slice(2, 10)}`;
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`);

let pc;
let joined = false;
let hostAvailable = false;

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  bundlePolicy: 'max-bundle',
  iceCandidatePoolSize: 10
};

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'join', role: 'viewer', roomId, clientId: viewerId }));
});

ws.addEventListener('message', async (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'joined') {
    joined = true;
    hostAvailable = Boolean(message.hostAvailable);
    setStatus(hostAvailable ? 'Host found. Click connect.' : 'Waiting for host to start.');
    connectBtn.disabled = !hostAvailable;
    return;
  }

  if (message.type === 'host-available') {
    hostAvailable = true;
    connectBtn.disabled = false;
    setStatus('Host is online. Click connect.');
    return;
  }

  if (message.type === 'signal') {
    await handleSignal(message.data);
    return;
  }

  if (message.type === 'broadcast-ended') {
    cleanupPeer();
    connectBtn.disabled = false;
    setStatus('Host stopped sharing.');
    return;
  }

  if (message.type === 'error') {
    setStatus(`Error: ${message.message}`);
  }
});

connectBtn.addEventListener('click', connect);

function setStatus(text) {
  statusEl.textContent = text;
}

function makePc() {
  const peer = new RTCPeerConnection(rtcConfig);

  peer.onicecandidate = (event) => {
    if (!event.candidate) return;
    ws.send(JSON.stringify({
      type: 'signal',
      data: { from: viewerId, candidate: event.candidate }
    }));
  };

  peer.ontrack = (event) => {
    const [stream] = event.streams;
    remoteVideo.srcObject = stream;
    remoteVideo.muted = false;
    remoteVideo.play().catch(() => {
      setStatus('Press play to start audio/video.');
    });
  };

  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') {
      setStatus('Connected with low-latency stream.');
      connectBtn.disabled = true;
    }

    if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
      setStatus('Connection dropped. Try reconnecting.');
      connectBtn.disabled = false;
    }
  };

  return peer;
}

async function connect() {
  if (!joined || !hostAvailable) {
    setStatus('Host is not available yet.');
    return;
  }

  cleanupPeer();

  pc = makePc();

  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: true
  });

  await pc.setLocalDescription(offer);

  ws.send(JSON.stringify({
    type: 'signal',
    data: { from: viewerId, offer }
  }));

  setStatus('Connecting...');
}

async function handleSignal(data) {
  if (data.to && data.to !== viewerId) return;

  if (!pc) {
    if (!data.answer && !data.candidate) return;
    pc = makePc();
  }

  if (data.answer) {
    await pc.setRemoteDescription(data.answer);
    return;
  }

  if (data.candidate) {
    await pc.addIceCandidate(data.candidate);
  }
}

function cleanupPeer() {
  if (pc) {
    pc.close();
    pc = null;
  }
  remoteVideo.srcObject = null;
}

window.addEventListener('beforeunload', () => {
  cleanupPeer();
  ws.close();
});
