const path = require('path');
require('dotenv').config();
const express = require('express');
const { v4: uuid } = require('uuid');
const { WebSocketServer } = require('ws');
const { createClient } = require('redis');

const PORT = process.env.PORT || 4000;
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_REQUIRED = process.env.REDIS_REQUIRED === 'true';
const EXTERNAL_PEER_SERVER_URL =
  process.env.EXTERNAL_PEER_SERVER_URL || 'https://voip.myvipfantasy.com/peer-call/';
const CALL_WEBHOOK_URL = String(process.env.CALL_WEBHOOK_URL || '').trim();

function parseEnvBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

const FEATURE_FLAGS = {
  audio: parseEnvBoolean(process.env.ENABLE_AUDIO_CALL, true),
  video: parseEnvBoolean(process.env.ENABLE_VIDEO_CALL, false),
  textChat: parseEnvBoolean(process.env.ENABLE_TEXT_CHAT, false),
};

const app = express();
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Feature flags', FEATURE_FLAGS);
  console.log('External peer server URL', EXTERNAL_PEER_SERVER_URL);
});

app.get('/runtime-config.js', (_req, res) => {
  const safeConfig = {
    externalPeerServerUrl: EXTERNAL_PEER_SERVER_URL,
    features: {
      audio: FEATURE_FLAGS.audio,
      video: FEATURE_FLAGS.video,
      textChat: FEATURE_FLAGS.textChat,
    },
  };

  res.type('application/javascript').send(
    `window.__PEER_RUNTIME_CONFIG__ = ${JSON.stringify(safeConfig)};`
  );
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/peers/by-name', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) {
      return res.status(400).json({
        error: 'invalid-name',
        message: 'Query parameter "name" is required.',
      });
    }

    const peers = await listPeers();
    const nameLower = name.toLowerCase();
    const peer = peers.find((p) => p.name.toLowerCase() === nameLower);

    if (!peer) {
      return res.status(404).json({
        error: 'peer-not-found',
        message: `No peer found with name "${name}".`,
      });
    }

    return res.json({
      id: peer.id,
      busyState: Boolean(peer.busyWith),
    });
  } catch (err) {
    console.error('REST /api/peers/by-name error', err);
    return res.status(500).json({
      error: 'server-error',
      message: 'Internal server error. Try again.',
    });
  }
});

const wss = new WebSocketServer({ server });

const redisClient = createClient({
  url: REDIS_URL,
  socket: {
    reconnectStrategy: () => {
      if (!REDIS_REQUIRED) return false;
      return 1000;
    },
  },
});
let redisReady = false;
let hasLoggedRedisError = false;
const memoryPeers = new Map(); // id -> { id, name, busyWith }

redisClient.on('error', (err) => {
  if (REDIS_REQUIRED || !hasLoggedRedisError) {
    console.error('Redis client error', err);
    hasLoggedRedisError = true;
  }
});
redisClient.on('ready', () => {
  redisReady = true;
  console.log('Connected to Redis');
});
redisClient.on('end', () => {
  redisReady = false;
  console.warn('Redis connection ended, using in-memory peer state');
});
redisClient
  .connect()
  .catch((err) => {
    console.error('Failed to connect to Redis', err);
    redisReady = false;
    if (REDIS_REQUIRED) {
      process.exit(1);
    }
    console.warn('Continuing without Redis; peer state will be in-memory only');
  });

const connections = new Map(); // id -> { socket, name }
const activeCalls = new Map(); // sortedPairKey -> accepted call metadata
const PEER_INDEX_KEY = 'peers:active';
const peerKey = (id) => `peer:${id}`;

function getCallKey(peerA, peerB) {
  return [peerA, peerB].filter(Boolean).sort().join(':');
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) {
    parts.push(String(hours).padStart(2, '0'));
  }
  parts.push(String(minutes).padStart(2, '0'));
  parts.push(String(seconds).padStart(2, '0'));
  return parts.join(':');
}

async function sendCallWebhook(eventName, payload) {

  // console.log('======== payload ========');  
  console.log(payload);
  // console.log(CALL_WEBHOOK_URL);
  // console.log('======== payload ========');

  if (!CALL_WEBHOOK_URL) return;

  try {
    const webhookPayload = {
      event: eventName,
      ...payload,
    };

    let requestUrl = CALL_WEBHOOK_URL;
    let response = null;

    // Some endpoints redirect POST requests and drop the body.
    // Handle redirects manually so JSON payload is always re-posted.
    for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
      response = await fetch(requestUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(webhookPayload),
      });

      if (response.status < 300 || response.status >= 400) {
        break;
      }

      const location = response.headers.get('location');
      if (!location) {
        break;
      }

      requestUrl = new URL(location, requestUrl).toString();
    }

    const responseText = await response.text();
    let responseJson = null;
    try {
      responseJson = responseText ? JSON.parse(responseText) : null;
    } catch (_err) {
      responseJson = null;
    }

    console.log('Call webhook response', eventName, response.status, responseJson || responseText);

    if (!response.ok) {
      console.error('Call webhook failed', eventName, response.status, response.statusText);
    }
  } catch (err) {
    console.error('Call webhook error', eventName, err);
  }
}

function trackAcceptedCall({ callerId, callerName, calleeId, calleeName, callerSiteId, calleeSiteId }) {
  if (!callerId || !calleeId) return null;

  const callRecord = {
    callerId,
    callerName,
    calleeId,
    calleeName,
    callerSiteId: callerSiteId || '',
    calleeSiteId: calleeSiteId || '',
    acceptedAt: Date.now(),
  };

  activeCalls.set(getCallKey(callerId, calleeId), callRecord);
  return callRecord;
}

function finishAcceptedCall(peerA, peerB) {
  const key = getCallKey(peerA, peerB);
  if (!key) return null;
  const callRecord = activeCalls.get(key) || null;
  if (callRecord) {
    activeCalls.delete(key);
  }
  return callRecord;
}

function emitCallAcceptedWebhook(callRecord) {
  if (!callRecord) return;
  
  console.log('Call accepted')

  void sendCallWebhook('call.accepted', {
    ownerName: callRecord.calleeName,
    ownerId: callRecord.calleeId,
    ownerSiteId: callRecord.calleeSiteId,
    peerName: callRecord.callerName,
    peerId: callRecord.callerId,
    peerSiteId: callRecord.callerSiteId,
    acceptedAt: new Date(callRecord.acceptedAt).toISOString(),
  });
}

function emitCallEndedWebhook(peerA, peerB, reason) {
  const callRecord = finishAcceptedCall(peerA, peerB);
  if (!callRecord) return;

  console.log('Call Ended')

  const endedAt = Date.now();
  const elapsedMs = Math.max(0, endedAt - callRecord.acceptedAt);

  void sendCallWebhook('call.ended', {
    ownerName: callRecord.calleeName,
    ownerId: callRecord.calleeId,
    ownerSiteId: callRecord.calleeSiteId,
    peerName: callRecord.callerName,
    peerId: callRecord.callerId,
    peerSiteId: callRecord.callerSiteId,
    acceptedAt: new Date(callRecord.acceptedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    elapsedMs,
    elapsedSeconds: Math.floor(elapsedMs / 1000),
    elapsedTime: formatDuration(elapsedMs),
    reason: reason || 'ended',
  });
}

async function removeStalePeerIfOffline(id) {
  if (!id || connections.has(id)) return false;
  await removePeer(id);
  return true;
}

async function listPeers() {
  if (!redisReady) {
    return Array.from(memoryPeers.values()).map((peer) => ({ ...peer }));
  }

  const ids = await redisClient.sMembers(PEER_INDEX_KEY);
  if (!ids.length) return [];

  const peers = await Promise.all(
    ids.map(async (id) => {
      if (!connections.has(id)) {
        await removePeer(id);
        return null;
      }
      const data = await redisClient.hGetAll(peerKey(id));
      if (!data || Object.keys(data).length === 0) {
        await redisClient.sRem(PEER_INDEX_KEY, id);
        return null;
      }
      return {
        id,
        name: data.name || 'Anonymous',
        busyWith: data.busyWith ? data.busyWith : null,
      };
    })
  );

  return peers.filter(Boolean);
}

async function isPeerNameTaken(name, excludeId = null) {
  const normalized = String(name || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;

  const peers = await listPeers();
  return peers.some((peer) => {
    if (excludeId && peer.id === excludeId) return false;
    return String(peer.name || '')
      .trim()
      .toLowerCase() === normalized;
  });
}

async function upsertPeer(id, name, siteId = '') {
  if (await isPeerNameTaken(name, id)) {
    return false;
  }

  if (!redisReady) {
    memoryPeers.set(id, {
      id,
      name,
      siteId: siteId || '',
      busyWith: null,
    });
    return true;
  }

  await redisClient.sAdd(PEER_INDEX_KEY, id);
  await redisClient.hSet(peerKey(id), {
    id,
    name,
    siteId: siteId || '',
    busyWith: '',
    updatedAt: Date.now().toString(),
  });
  return true;
}

async function removePeer(id) {
  if (!redisReady) {
    memoryPeers.delete(id);
    return;
  }

  await redisClient.del(peerKey(id));
  await redisClient.sRem(PEER_INDEX_KEY, id);
}

async function getPeer(id) {
  if (!redisReady) {
    const peer = memoryPeers.get(id);
    return peer ? { ...peer } : null;
  }

  const data = await redisClient.hGetAll(peerKey(id));
  if (!data || Object.keys(data).length === 0) return null;
  return {
    id,
    name: data.name || 'Anonymous',
    siteId: data.siteId || '',
    busyWith: data.busyWith ? data.busyWith : null,
  };
}

async function setBusyPair(clientA, clientB) {
  if (!redisReady) {
    const a = memoryPeers.get(clientA);
    const b = memoryPeers.get(clientB);
    if (a) a.busyWith = clientB;
    if (b) b.busyWith = clientA;
    return;
  }

  await Promise.all([
    redisClient.hSet(peerKey(clientA), { busyWith: clientB }),
    redisClient.hSet(peerKey(clientB), { busyWith: clientA }),
  ]);
}

async function clearBusy(clientId, peerId) {
  if (!redisReady) {
    const peer = memoryPeers.get(clientId);
    if (!peer) return;
    if (!peerId || peer.busyWith === peerId) {
      peer.busyWith = null;
    }
    return;
  }

  const peer = await getPeer(clientId);
  if (!peer) return;
  if (!peerId || peer.busyWith === peerId) {
    await redisClient.hSet(peerKey(clientId), { busyWith: '' });
  }
}

async function broadcastPeers() {
  const peers = await listPeers();
  const payload = JSON.stringify({ type: 'peers:update', peers });

  for (const [, connection] of connections) {
    try {
      connection.socket.send(payload);
    } catch (err) {
      console.error('WS broadcast error', err);
    }
  }
}

function sendTo(targetId, data) {
  const connection = connections.get(targetId);
  if (!connection) return false;
  try {
    connection.socket.send(JSON.stringify(data));
    return true;
  } catch (err) {
    console.error('WS send error', err);
    return false;
  }
}

wss.on('connection', (socket) => {
  let clientId = null;

  socket.on('message', async (raw) => {
    try {
      let payload;
      try {
        payload = JSON.parse(raw.toString());
      } catch (err) {
        console.error('Invalid JSON payload', err);
        return;
      }

      const { type } = payload;

      if (type === 'register') {
        const name = (payload.name || 'Anonymous').trim().slice(0, 32);
        const siteId = (payload.siteId || '').trim().slice(0, 64);
        clientId = uuid();
        const inserted = await upsertPeer(clientId, name, siteId);
        if (!inserted) {
          clientId = null;
          socket.send(
            JSON.stringify({
              error: 'duplicate-name',
              message: 'Peer name already exists. Choose a different name.',
            })
          );
          return;
        }
        connections.set(clientId, { socket, name });
        socket.send(
          JSON.stringify({
            type: 'registered',
            id: clientId,
            name,
            peers: await listPeers(),
          })
        );
        await broadcastPeers();
        return;
      }

      if (!clientId || !connections.has(clientId)) {
        socket.send(
          JSON.stringify({ error: 'not-registered', message: 'Please register first.' })
        );
        return;
      }

      switch (type) {
        case 'call:request': {
          const { targetId } = payload;
          if (!targetId || !connections.has(targetId)) {
            await removeStalePeerIfOffline(targetId);
            socket.send(JSON.stringify({ type: 'call:error', message: 'Peer not found.' }));
            await broadcastPeers();
            return;
          }
          const caller = await getPeer(clientId);
          const target = await getPeer(targetId);
          if (!caller || !target) {
            if (!caller) {
              await upsertPeer(clientId, connections.get(clientId)?.name || 'Anonymous');
            }
            if (!target) {
              await removePeer(targetId);
            }
            socket.send(JSON.stringify({ type: 'call:error', message: 'Peer not found.' }));
            await broadcastPeers();
            return;
          }
          if (caller.busyWith || target.busyWith) {
            socket.send(
              JSON.stringify({ type: 'call:error', message: 'Either you or the peer is busy.' })
            );
            return;
          }
          await setBusyPair(clientId, targetId);
          const callerName = connections.get(clientId)?.name || 'Anonymous';
          sendTo(targetId, {
            type: 'call:incoming',
            fromId: clientId,
            fromName: callerName,
          });
          socket.send(JSON.stringify({ type: 'call:initiated', targetId }));
          await broadcastPeers();
          break;
        }
        case 'call:accept': {
          const { fromId } = payload;
          if (!fromId || !connections.has(fromId)) {
            await removeStalePeerIfOffline(fromId);
            await broadcastPeers();
            break;
          }
          const callerName = connections.get(clientId)?.name || 'Anonymous';
          const callerPeer = await getPeer(fromId);
          const calleePeer = await getPeer(clientId);
          const acceptedCall = trackAcceptedCall({
            callerId: fromId,
            callerName: connections.get(fromId)?.name || 'Anonymous',
            calleeId: clientId,
            calleeName: callerName,
            callerSiteId: callerPeer?.siteId || '',
            calleeSiteId: calleePeer?.siteId || '',
          });
          sendTo(fromId, {
            type: 'call:accepted',
            fromId: clientId,
            fromName: callerName,
          });
          const fromName = connections.get(fromId)?.name || 'Anonymous';
          socket.send(JSON.stringify({ type: 'call:accepted', fromId, fromName }));
          emitCallAcceptedWebhook(acceptedCall);
          break;
        }
        case 'call:reject': {
          const { fromId } = payload;
          if (!fromId || !connections.has(fromId)) {
            await removeStalePeerIfOffline(fromId);
            await clearBusy(clientId, fromId || null);
            await broadcastPeers();
            break;
          }
          sendTo(fromId, {
            type: 'call:rejected',
            fromId: clientId,
          });
          await clearBusy(clientId, fromId);
          await clearBusy(fromId, clientId);
          await broadcastPeers();
          break;
        }
        case 'call:end': {
          const { targetId } = payload;
          if (targetId) {
            sendTo(targetId, { type: 'call:ended', fromId: clientId });
            emitCallEndedWebhook(clientId, targetId, 'ended');
            await clearBusy(clientId, targetId);
            await clearBusy(targetId, clientId);
          }
          await broadcastPeers();
          break;
        }
        case 'signal': {
          const { targetId, data } = payload;
          if (!targetId || !connections.has(targetId)) {
            await removeStalePeerIfOffline(targetId);
            await broadcastPeers();
            break;
          }
          sendTo(targetId, {
            type: 'signal',
            fromId: clientId,
            data,
          });
          break;
        }
        default:
          socket.send(
            JSON.stringify({ error: 'unknown-type', message: 'Unsupported message type.' })
          );
      }
    } catch (err) {
      console.error('WS handler error', err);
      socket.send(
        JSON.stringify({ error: 'server-error', message: 'Internal server error. Try again.' })
      );
    }
  });

  socket.on('close', () => {
    if (!clientId) return;
    connections.delete(clientId);
    (async () => {
      const peer = await getPeer(clientId);
      const peerId = peer?.busyWith || null;
      await removePeer(clientId);
      if (peerId) {
        emitCallEndedWebhook(clientId, peerId, 'disconnect');
        await clearBusy(peerId, clientId);
        sendTo(peerId, { type: 'call:ended', fromId: clientId });
      }
      await broadcastPeers();
    })().catch((err) => console.error('Close handler error', err));
  });
});
