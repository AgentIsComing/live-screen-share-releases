function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders()
    }
  });
}

function badRequest(message) {
  return json({ ok: false, error: message }, 400);
}

function randomCode() {
  return String(Math.floor(10000 + Math.random() * 90000));
}

function normalizeWsUrl(value) {
  const url = String(value || '').trim();
  if (!/^wss?:\/\//i.test(url)) {
    throw new Error('wsUrl must start with ws:// or wss://');
  }
  return url;
}

function normalizeRoomId(value) {
  const roomId = String(value || '').trim();
  if (!roomId) {
    throw new Error('roomId is required');
  }
  return roomId;
}

function normalizePassword(value) {
  const password = String(value || '');
  if (!password || password.length < 4) {
    throw new Error('password must be at least 4 characters');
  }
  return password;
}

function computeTtlSeconds(env, requested) {
  const ttlFromBody = Number(requested || 0);
  const fallbackTtl = Number(env.DEFAULT_TTL_SECONDS || 900);
  return Math.min(Math.max(ttlFromBody || fallbackTtl, 60), 3600);
}

async function registerCode(env, body) {
  const wsUrl = normalizeWsUrl(body.wsUrl);
  const roomId = String(body.roomId || '').trim();
  const ttlSeconds = computeTtlSeconds(env, body.ttlSeconds);

  let code = null;
  for (let i = 0; i < 30; i += 1) {
    const candidate = randomCode();
    const existing = await env.JOIN_CODES.get(`code:${candidate}`);
    if (!existing) {
      code = candidate;
      break;
    }
  }

  if (!code) {
    return json({ ok: false, error: 'No free code available. Retry.' }, 503);
  }

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await env.JOIN_CODES.put(
    `code:${code}`,
    JSON.stringify({ wsUrl, roomId, expiresAt }),
    { expirationTtl: ttlSeconds }
  );

  return json({ ok: true, code, wsUrl, roomId, expiresAt, ttlSeconds });
}

async function resolveCode(env, body) {
  const code = String(body.code || '').trim();
  if (!/^\d{5}$/.test(code)) {
    return badRequest('code must be exactly 5 digits');
  }

  const raw = await env.JOIN_CODES.get(`code:${code}`);
  if (!raw) {
    return json({ ok: false, error: 'Code not found or expired' }, 404);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'Stored code is invalid' }, 500);
  }

  return json({
    ok: true,
    code,
    wsUrl: parsed.wsUrl,
    roomId: parsed.roomId || null,
    expiresAt: parsed.expiresAt || null
  });
}

async function registerRoom(env, body) {
  const roomId = normalizeRoomId(body.roomId);
  const password = normalizePassword(body.password);
  const wsUrl = normalizeWsUrl(body.wsUrl);
  const ttlSeconds = computeTtlSeconds(env, body.ttlSeconds);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  await env.JOIN_CODES.put(
    `room:${roomId.toLowerCase()}`,
    JSON.stringify({ roomId, password, wsUrl, expiresAt }),
    { expirationTtl: ttlSeconds }
  );

  return json({ ok: true, roomId, wsUrl, expiresAt, ttlSeconds });
}

async function resolveRoom(env, body) {
  const roomId = normalizeRoomId(body.roomId);
  const password = normalizePassword(body.password);

  const raw = await env.JOIN_CODES.get(`room:${roomId.toLowerCase()}`);
  if (!raw) {
    return json({ ok: false, error: 'Room not found or expired' }, 404);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'Stored room is invalid' }, 500);
  }

  if (parsed.password !== password) {
    return json({ ok: false, error: 'Invalid room password' }, 401);
  }

  return json({
    ok: true,
    roomId: parsed.roomId || roomId,
    wsUrl: parsed.wsUrl,
    expiresAt: parsed.expiresAt || null
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'live-screen-share-code-service' });
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'Not found' }, 404);
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      return badRequest('Invalid JSON body');
    }

    try {
      if (url.pathname === '/register') {
        return registerCode(env, body);
      }

      if (url.pathname === '/resolve') {
        return resolveCode(env, body);
      }

      if (url.pathname === '/register-room') {
        return registerRoom(env, body);
      }

      if (url.pathname === '/resolve-room') {
        return resolveRoom(env, body);
      }

      return json({ ok: false, error: 'Not found' }, 404);
    } catch (error) {
      return badRequest(error.message || 'Invalid request');
    }
  }
};
