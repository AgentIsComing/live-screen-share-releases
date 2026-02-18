const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const HOST_RECONNECT_GRACE_MS = 10000;

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
      const roomId = String(message.roomId || '').trim();
      const role = message.role;
      const clientId = String(message.clientId || '').trim();

      if (!roomId || !clientId || (role !== 'host' && role !== 'viewer')) {
        send(ws, { type: 'error', message: 'Invalid join payload' });
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
        send(ws, { type: 'joined', role: 'host', roomId });

        for (const viewer of room.viewers) {
          send(viewer, { type: 'host-available' });
        }
      } else {
        room.viewers.add(ws);
        room.viewersById.set(clientId, ws);
        send(ws, { type: 'joined', role: 'viewer', roomId, hostAvailable: Boolean(room.host) });

        if (room.host) {
          send(room.host, { type: 'viewer-joined' });
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
    }

    cleanupRoom(currentRoomId);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on :${PORT}`);
});

