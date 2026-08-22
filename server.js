const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST_RECONNECT_GRACE_MS = 10000;
const MAX_CHAT_LENGTH = 500;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Live Screen Share signaling server is running.');
});

const wss = new WebSocketServer({ server, path: '/signal' });
const rooms = new Map();

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      host: null,
      hostId: null,
      viewers: new Set(),
      viewersById: new Map(),
      viewerInfoById: new Map(),
      chatEnabled: true,
      requiresModeration: true,
      hostDisconnectTimer: null,
      hostDisconnectDeadline: null
    });
  }
  return rooms.get(roomId);
}

function clearHostDisconnectTimer(room) {
  if (!room?.hostDisconnectTimer) return;
  clearTimeout(room.hostDisconnectTimer);
  room.hostDisconnectTimer = null;
  room.hostDisconnectDeadline = null;
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (!room.host && room.viewers.size === 0 && !room.hostDisconnectTimer) {
    rooms.delete(roomId);
  }
}

wss.on('connection', (ws) => {
  let currentRoomId = null;
  let currentRole = null;
  let currentClientId = null;

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (message.type === 'join') {
      const roomId = String(message.roomId || '').trim().toLowerCase();
      const role = message.role;
      const clientId = String(message.clientId || '').trim();

      if (!roomId || !clientId || (role !== 'host' && role !== 'viewer')) {
        send(ws, { type: 'error', message: 'Invalid join payload' });
        return;
      }
      if (!String(message.sessionToken || '').trim()) {
        send(ws, { type: 'error', message: 'Room authentication required' });
        return;
      }

      currentRoomId = roomId;
      currentRole = role;
      currentClientId = clientId;

      const room = ensureRoom(roomId);

      if (role === 'host') {
        if (room.host && room.host !== ws) {
          send(ws, { type: 'error', message: 'Room already has a host' });
          return;
        }

        clearHostDisconnectTimer(room);

        room.host = ws;
        room.hostId = clientId;
        room.requiresModeration = message.requiresApproval !== false;
        room.chatEnabled = true;
        send(ws, { type: 'joined', role: 'host', roomId });

        send(ws, {
          type: 'viewer-list',
          requiresModeration: room.requiresModeration,
          viewers: Array.from(room.viewerInfoById, ([viewerClientId, info]) => ({ clientId: viewerClientId, ...info }))
        });

        for (const viewer of room.viewers) {
          send(viewer, { type: 'host-available' });
        }
        for (const [viewerClientId, info] of room.viewerInfoById) {
          if (info.status === 'pending') {
            send(ws, { type: 'viewer-join-request', viewer: { clientId: viewerClientId, status: info.status } });
          }
        }
      } else {
        room.viewers.add(ws);
        room.viewersById.set(clientId, ws);
        room.viewerInfoById.set(clientId, { status: room.host && room.requiresModeration ? 'pending' : 'approved', muted: false });
        send(ws, { type: 'joined', role: 'viewer', roomId, hostAvailable: Boolean(room.host), requiresModeration: room.requiresModeration });

        if (room.host && room.requiresModeration) {
          send(room.host, {
            type: 'viewer-join-request',
            viewer: { clientId, status: 'pending' }
          });
          send(room.host, {
            type: 'viewer-list',
            requiresModeration: room.requiresModeration,
            viewers: Array.from(room.viewerInfoById, ([viewerClientId, info]) => ({ clientId: viewerClientId, ...info }))
          });
        }
      }

      return;
    }

    if (!currentRoomId) {
      send(ws, { type: 'error', message: 'Join a room first' });
      return;
    }

    const room = rooms.get(currentRoomId);
    if (!room) {
      send(ws, { type: 'error', message: 'Room not found' });
      return;
    }

    if (message.type === 'signal') {
      const senderInfo = currentRole === 'viewer' ? room.viewerInfoById.get(currentClientId) : null;
      if (senderInfo && senderInfo.status !== 'approved') return;
      if (message.data?.chat) {
        const text = String(message.data.chat.text || '').trim().slice(0, MAX_CHAT_LENGTH);
        if (!text || !room.chatEnabled || senderInfo?.muted) return;
        message.data.chat.text = text;
      }
      if (message.data?.chatControl && currentRole === 'host') {
        room.chatEnabled = message.data.chatControl.enabled !== false;
        for (const viewer of room.viewers) send(viewer, { type: 'signal', data: { from: room.hostId, chatControl: { enabled: room.chatEnabled } } });
        return;
      }
      if (currentRole === 'host') {
        const targetId = message.data?.to;
        if (!targetId) return;
        const viewer = room.viewersById.get(targetId);
        if (viewer) send(viewer, { type: 'signal', data: message.data });
      } else if (room.host) {
        send(room.host, { type: 'signal', data: message.data });
      }
      return;
    }

    if (message.type === 'moderate' && currentRole === 'host') {
      const viewerId = String(message.clientId || '').trim();
      const info = room.viewerInfoById.get(viewerId);
      const viewer = room.viewersById.get(viewerId);
      if (!info || !viewer) return;
      if (message.action === 'approve' || message.action === 'deny') {
        info.status = message.action === 'approve' ? 'approved' : 'denied';
        send(viewer, { type: 'approval', status: info.status });
        if (info.status === 'denied') {
          room.viewers.delete(viewer);
          room.viewersById.delete(viewerId);
          room.viewerInfoById.delete(viewerId);
        }
      } else if (message.action === 'mute' || message.action === 'unmute') {
        info.muted = message.action === 'mute';
        send(viewer, { type: 'signal', data: { from: room.hostId, to: viewerId, chatControl: { muted: info.muted } } });
      }
      send(ws, {
        type: 'viewer-list',
        requiresModeration: room.requiresModeration,
        viewers: Array.from(room.viewerInfoById, ([clientId, viewerInfo]) => ({ clientId, ...viewerInfo }))
      });
      return;
    }

    if (message.type === 'chat-control' && currentRole === 'host') {
      room.chatEnabled = message.enabled !== false;
      for (const viewer of room.viewers) send(viewer, { type: 'signal', data: { from: room.hostId, chatControl: { enabled: room.chatEnabled } } });
      return;
    }

    if (message.type === 'broadcast-end' && currentRole === 'host') {
      clearHostDisconnectTimer(room);
      for (const viewer of room.viewers) {
        send(viewer, { type: 'broadcast-ended' });
      }
    }
  });

  ws.on('close', () => {
    if (!currentRoomId) return;

    const room = rooms.get(currentRoomId);
    if (!room) return;

    if (currentRole === 'host' && room.host === ws) {
      room.host = null;
      room.hostId = null;

      clearHostDisconnectTimer(room);
      room.hostDisconnectDeadline = Date.now() + HOST_RECONNECT_GRACE_MS;
      room.hostDisconnectTimer = setTimeout(() => {
        const freshRoom = rooms.get(currentRoomId);
        if (!freshRoom) return;
        if (freshRoom.host) return;

        freshRoom.hostDisconnectTimer = null;
        freshRoom.hostDisconnectDeadline = null;

        for (const viewer of freshRoom.viewers) {
          send(viewer, { type: 'broadcast-ended' });
        }

        cleanupRoom(currentRoomId);
      }, HOST_RECONNECT_GRACE_MS);
    }

    if (currentRole === 'viewer') {
      room.viewers.delete(ws);
      room.viewersById.delete(currentClientId);
      room.viewerInfoById.delete(currentClientId);
    }

    cleanupRoom(currentRoomId);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on :${PORT}`);
});

