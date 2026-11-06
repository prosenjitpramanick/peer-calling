const SimplePeer = require('simple-peer');

const peerCall = (() => {

const runtimeConfig =
  typeof window !== 'undefined' && window.__PEER_RUNTIME_CONFIG__
    ? window.__PEER_RUNTIME_CONFIG__
    : {};
const EXTERNAL_PEER_SERVER_URL =
  // runtimeConfig.externalPeerServerUrl || 'https://voip.myvipfantasy.com/peer-call/';
  runtimeConfig.externalPeerServerUrl || 'https://peer.mychat/peer-call/';
let ws = null;
let reconnectTimer = null;
let shouldAutoJoinOnOpen = true;
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const features = getRuntimeFeatures(runtimeConfig.features);

const ui = {
  displayName: document.getElementById('displayName'),
  siteId: document.getElementById('siteId'),
  ownerName: document.getElementById('ownername'),
  joinBtn: document.getElementById('joinBtn'),
  selfId: document.getElementById('selfId'),
  peerList: document.getElementById('peerList'),
  peerCount: document.getElementById('peerCount'),
  targetPeerInput: document.getElementById('targetPeerId'),
  mediaToggles: document.querySelector('.av-toggles'),
  videoToggle: document.getElementById('videoToggle'),
  audioToggle: document.getElementById('audioToggle'),
  callBtn: document.getElementById('callBtn'),
  endBtn: document.getElementById('endBtn'),
  localMediaCard: document.getElementById('localMediaCard'),
  remoteMediaCard: document.getElementById('remoteMediaCard'),
  localVideo: document.getElementById('localVideo'),
  localAudio: document.getElementById('localAudio'),
  remoteVideo: document.getElementById('remoteVideo'),
  remoteAudio: document.getElementById('remoteAudio'),
  status: document.getElementById('status'),
  incomingPanel: document.getElementById('incomingPanel'),
  incomingName: document.getElementById('incomingName'),
  acceptBtn: document.getElementById('acceptBtn'),
  rejectBtn: document.getElementById('rejectBtn'),
  chatPanel: document.getElementById('chatPanel'),
  chatLog: document.getElementById('chatLog'),
  chatInput: document.getElementById('chatInput'),
  chatSend: document.getElementById('chatSend'),
  callTimer: document.getElementById('callTimer'),
};

ui.endBtn.classList.add('hidden');
toggleChatPanel(false);

const state = {
  selfId: null,
  selfName: '',
  siteId: '',
  localStream: null,
  selectedPeerId: null,
  incomingFrom: null,
  peers: new Map(),
  peer: null,
  isInitiator: false,
  callStartedAt: null,
  callTimerInterval: null,
  ownerLookupOnline: false,
  ownerLookupTimer: null,
};

applyFeatureAvailability();

connectSocket();

ui.joinBtn.addEventListener('click', async () => {
  await attemptJoin();
});

if (ui.ownerName) {
  ui.ownerName.addEventListener('input', () => {
    stopOwnerLookupPolling();
    refreshOwnerPeerLookup({ silentOffline: true });
    if (state.selfId) {
      startOwnerLookupPolling();
    }
  });
}

// function attemptJoinOnDocumentLoadComplete() {
//   if (state.selfId) return;
//   if (!ui.displayName.value) {
//     ui.displayName.value = generateRandomName();
//   }
//   attemptJoin();
// }

ui.targetPeerInput.addEventListener('input', handleTargetInputChange);
if (ui.videoToggle) {
  ui.videoToggle.addEventListener('change', () => handleMediaToggle('video'));
}
if (ui.audioToggle) {
  ui.audioToggle.addEventListener('change', () => handleMediaToggle('audio'));
}
if (features.textChat && ui.chatSend && ui.chatInput) {
  ui.chatSend.addEventListener('click', sendChatMessage);
  ui.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendChatMessage();
    }
  });
}

ui.callBtn.addEventListener('click', async () => {
  if (!state.selfId) {
    setStatus('Join the lobby before placing a call.');
    return;
  }
  const targetId = getCallTarget();
  if (!targetId) {
    setStatus('Select a peer or enter an ID first.');
    return;
  }
  if (targetId === state.selfId) {
    setStatus('You cannot call yourself.');
    return;
  }
  if (!state.ownerLookupOnline) {
    setStatus('Target peer is not online.');
    return;
  }
  const ready = await ensureLocalStream();
  if (!ready) return;
  state.isInitiator = true;
  state.selectedPeerId = targetId;
  updateSelectedPeer();
  sendWs({ type: 'call:request', targetId });
  setStatus('Calling peer…');
});

ui.endBtn.addEventListener('click', () => {
  if (!state.selectedPeerId) return;
  sendWs({ type: 'call:end', targetId: state.selectedPeerId });
  tearDownPeer();
  setStatus('Call ended.');
});

ui.acceptBtn.addEventListener('click', async () => {
  const incomingId = getIncomingPeerId();
  if (!incomingId) {
    setStatus('No incoming call to accept.');
    toggleIncoming(false);
    return;
  }
  const ready = await ensureLocalStream();
  if (!ready) {
    setStatus('Enable camera/mic to answer the call.');
    return;
  }
  state.isInitiator = false;
  state.selectedPeerId = incomingId;
  updateSelectedPeer();
  sendWs({ type: 'call:accept', fromId: incomingId });
  toggleIncoming(false);
  setStatus('Connecting call…');
});

ui.rejectBtn.addEventListener('click', () => {
  const incomingId = getIncomingPeerId();
  if (!incomingId) {
    setStatus('No incoming call to reject.');
    toggleIncoming(false);
    return;
  }
  sendWs({ type: 'call:reject', fromId: incomingId });
  toggleIncoming(false);
  setStatus('Call rejected.');
});

async function handleMessage(payload) {
  switch (payload.type) {
    case 'registered':
      state.selfId = payload.id;
      state.selfName = payload.name || state.selfName || '';
      ui.selfId.textContent = payload.id;
      ui.joinBtn.disabled = true;
      ui.joinBtn.classList.add('hidden');
      ui.displayName.disabled = true;
      setStatus('Ready. Searching for owner availability...');
      await refreshOwnerPeerLookup({ forceStatus: true });
      startOwnerLookupPolling();
      break;
    case 'peers:update':
      await refreshOwnerPeerLookup({ silentOffline: true });
      break;
    case 'call:incoming':
      state.incomingFrom = payload.fromId;
      state.selectedPeerId = payload.fromId;
      if (ui.incomingPanel) {
        ui.incomingPanel.dataset.peerId = payload.fromId || '';
      }
      ui.incomingName.textContent = payload.fromName || 'Unknown';
      toggleIncoming(true);
      setStatus(`${payload.fromName || 'Peer'} is calling.`);
      break;
    case 'call:accepted':
      if (payload.fromId !== state.selectedPeerId || state.peer) break;
      await beginPeerSession(payload.fromId);
      setStatus('Call connected.');
      break;
    case 'call:rejected':
      if (payload.fromId === state.selectedPeerId) {
        tearDownPeer();
        setStatus('Peer rejected the call.');
      }
      break;
    case 'call:ended':
      if (payload.fromId === state.selectedPeerId) {
        tearDownPeer();
        toggleIncoming(false);
        setStatus('Call ended by peer.');
      }
      break;
    case 'call:initiated':
      state.selectedPeerId = payload.targetId;
      updateSelectedPeer();
      break;
    case 'signal':
      if (state.peer) {
        state.peer.signal(payload.data);
      }
      break;
    case 'call:error':
      setStatus(payload.message || 'Call error.');
      break;
    default:
      if (payload.error) setStatus(payload.message || payload.error);
  }
}

function renderPeers(list) {
  state.peers = new Map((list || []).map((peer) => [peer.id, peer]));
  updateSelectedPeer();
}

function updateSelectedPeer() {
  if (ui.peerList) {
    [...ui.peerList.children].forEach((item) => {
      item.classList.toggle('active', item.dataset.peerId === state.selectedPeerId);
    });
  }
  syncCallControls();
}

function connectSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket(buildWsUrl(EXTERNAL_PEER_SERVER_URL));

  ws.addEventListener('open', async () => {
    if (shouldAutoJoinOnOpen) {
      await attemptJoin();
      return;
    }
    setStatus('WebSocket connected. Enter a name and join.');
  });

  ws.addEventListener('close', () => {
    handleSocketClose();
  });

  ws.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      console.error('Invalid payload', err);
      return;
    }
    handleMessage(payload);
  });
}

function handleSocketClose() {
  resetJoinStateOnDisconnect();
  setStatus('Connection closed. Reconnecting in 1 second...');

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, 1000);
}

function resetJoinStateOnDisconnect() {
  state.selfId = null;
  state.ownerLookupOnline = false;
  stopOwnerLookupPolling();
  ui.selfId.textContent = '—';
  if (ui.joinBtn) {
    ui.joinBtn.disabled = false;
    ui.joinBtn.classList.remove('hidden');
  }
  if (ui.displayName) {
    ui.displayName.disabled = false;
  }
  syncCallControls();
}

function sendWs(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus('Connection not ready. Reconnecting...');
    connectSocket();
    return false;
  }
  ws.send(JSON.stringify(data));
  return true;
}

async function beginPeerSession(remoteId) {
  const ready = await ensureLocalStream();
  if (!ready) {
    setStatus('Camera/mic permission required to continue.');
    return;
  }
  if (state.peer) state.peer.destroy();

  state.peer = new SimplePeer({
    initiator: Boolean(state.isInitiator),
    trickle: false,
    stream: state.localStream,
  });

  ui.endBtn.disabled = false;
  updateCallActionVisibility(true);

  state.peer.on('signal', (data) => {
    sendWs({
      type: 'signal',
      targetId: remoteId,
      data,
    });
  });

  state.peer.on('stream', (remoteStream) => {
    ui.remoteVideo.srcObject = remoteStream;
    ui.remoteAudio.srcObject = remoteStream;
    if (ui.remoteVideo.hidden) {
      ui.remoteAudio.play().catch(() => {});
    }
  });

  state.peer.on('connect', () => {
    toggleChatPanel(true);
    startCallTimer();
    setStatus(features.textChat ? 'Call connected. Chat ready.' : 'Call connected.');
  });

  if (features.textChat) {
    state.peer.on('data', handlePeerData);
  }

  state.peer.on('close', () => {
    tearDownPeer();
    setStatus('Peer connection closed.');
  });

  state.peer.on('error', (err) => {
    console.error('Peer error', err);
    tearDownPeer();
    setStatus('Peer connection failed.');
  });
}

function tearDownPeer() {
  if (state.peer) {
    state.peer.destroy();
    state.peer = null;
  }
  ui.remoteVideo.srcObject = null;
  ui.endBtn.disabled = true;
  state.isInitiator = false;
  updateCallActionVisibility(false);
  toggleChatPanel(false);
  clearChatLog();
  stopCallTimer();
}

function toggleIncoming(show) {
  const visible = Boolean(show);
  if (ui.incomingPanel) {
    ui.incomingPanel.hidden = !visible;
    if (!visible && ui.incomingPanel.dataset) {
      delete ui.incomingPanel.dataset.peerId;
    }
  }
  if (ui.acceptBtn) ui.acceptBtn.disabled = !visible;
  if (ui.rejectBtn) ui.rejectBtn.disabled = !visible;
  if (!visible) {
    state.incomingFrom = null;
  }
}

function getManualTarget() {
  return (ui.targetPeerInput.value || '').trim();
}

function getCallTarget() {
  return getManualTarget() || state.selectedPeerId;
}

function getIncomingPeerId() {
  if (state.incomingFrom) return state.incomingFrom;
  if (ui.incomingPanel && ui.incomingPanel.dataset && ui.incomingPanel.dataset.peerId) {
    return ui.incomingPanel.dataset.peerId;
  }
  return null;
}

function handleTargetInputChange() {
  const manualId = getManualTarget();
  if (manualId && manualId === state.selfId) {
    setStatus('You cannot call yourself.');
  }
  syncCallControls();
}

function syncCallControls() {
  const hasTarget = Boolean(getCallTarget());
  ui.callBtn.disabled = !state.ownerLookupOnline || !hasTarget;
  if (!state.peer) {
    ui.callBtn.classList.toggle('hidden', !state.ownerLookupOnline);
  }
  ui.endBtn.disabled = !state.selectedPeerId;
  if (!state.peer) {
    updateCallActionVisibility(false);
  }
}

function updateCallActionVisibility(inCall) {
  const active = typeof inCall === 'boolean' ? inCall : Boolean(state.peer);
  ui.callBtn.classList.toggle('hidden', active || !state.ownerLookupOnline);
  ui.endBtn.classList.toggle('hidden', !active);
}

async function refreshOwnerPeerLookup(options = {}) {
  const { silentOffline = false, forceStatus = false } = options;
  const ownerName = (ui.ownerName && ui.ownerName.value ? ui.ownerName.value : '').trim();

  console.log('Refreshing owner peer lookup for', ownerName);


  if (!ownerName) {
    state.ownerLookupOnline = false;
    stopOwnerLookupPolling();
    syncCallControls();
    if (!silentOffline) {
      setStatus('Enter owner name to find an online peer.');
    }
    return;
  }

  try {
    const response = await fetch(`/api/peers/by-name?name=${encodeURIComponent(ownerName)}`);
    
    console.log('Requesting API for', ownerName);
    // console.log(response);

    
    if (!response.ok) {
      state.ownerLookupOnline = false;
      startOwnerLookupPolling();
      syncCallControls();
      if (!silentOffline) {
        setStatus(`${ownerName} is Offline.`);
      }
      return;
    }

    const data = await response.json();
    const peerId = (data && data.id ? String(data.id) : '').trim();
    const isBusy = Boolean(data && data.busyState);
    const peerFound = Boolean(peerId) && !isBusy;
    const available = peerFound && peerId !== state.selfId;

    state.ownerLookupOnline = peerFound;
    ui.callBtn.classList.toggle('hidden', !peerFound);

    if (peerFound) {
      stopOwnerLookupPolling();
    } else {
      startOwnerLookupPolling();
    }

    if (available) {
      state.selectedPeerId = peerId;
      ui.targetPeerInput.value = peerId;
      if (forceStatus || !silentOffline) {
        setStatus(`${ownerName} is Online.`);
      }
    } else {
      if (peerId === state.selfId) {
        setStatus(`${ownerName} resolves to your own peer ID.`);
      } else if (isBusy) {
        setStatus(`${ownerName} is Online (busy).`);
      } else if (!silentOffline) {
        setStatus(`${ownerName} is Offline.`);
      }
    }

    syncCallControls();
  } catch (err) {
    console.error('Owner peer lookup failed', err);
    state.ownerLookupOnline = false;
    startOwnerLookupPolling();
    syncCallControls();
    if (!silentOffline) {
      setStatus('Unable to check peer availability right now.');
    }
  }
}

function startOwnerLookupPolling() {
  if (state.ownerLookupTimer || state.ownerLookupOnline) {
    clearInterval(state.ownerLookupTimer);
    if (state.ownerLookupOnline) return;
  }
  state.ownerLookupTimer = window.setInterval(() => {
    refreshOwnerPeerLookup({ silentOffline: true });
  }, 5000);
}

function stopOwnerLookupPolling() {
  if (!state.ownerLookupTimer) return;
  clearInterval(state.ownerLookupTimer);
  state.ownerLookupTimer = null;
}

function parseBooleanFlag(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function getRuntimeFeatures(rawFeatures) {
  const data = rawFeatures || {};
  return {
    audio: parseBooleanFlag(data.audio, true),
    video: parseBooleanFlag(data.video, true),
    textChat: parseBooleanFlag(data.textChat, true),
  };
}

function applyFeatureAvailability() {
  const hideMediaToggles = !features.video;

  if (ui.mediaToggles) {
    ui.mediaToggles.hidden = hideMediaToggles;
    ui.mediaToggles.style.display = hideMediaToggles ? 'none' : '';
  }

  const videoToggleChip = ui.videoToggle ? ui.videoToggle.closest('label.toggle-chip') : null;
  const audioToggleChip = ui.audioToggle ? ui.audioToggle.closest('label.toggle-chip') : null;
  if (videoToggleChip) {
    videoToggleChip.hidden = hideMediaToggles;
  }
  if (audioToggleChip) {
    audioToggleChip.hidden = hideMediaToggles;
  }

  if (ui.audioToggle) {
    ui.audioToggle.checked = features.audio;
    ui.audioToggle.disabled = !features.audio;
  }

  if (ui.videoToggle) {
    ui.videoToggle.checked = features.video;
    ui.videoToggle.disabled = !features.video;
    const wrapper = ui.videoToggle.closest('label.toggle-chip');
    if (wrapper) {
      wrapper.hidden = hideMediaToggles;
    }
  }

  if (ui.localMediaCard) {
    ui.localMediaCard.hidden = !features.video;
  }
  if (ui.remoteMediaCard) {
    ui.remoteMediaCard.hidden = !features.video;
  }

  if (!features.textChat) {
    if (ui.chatPanel) {
      ui.chatPanel.hidden = true;
    }
    if (ui.chatInput) {
      ui.chatInput.disabled = true;
    }
    if (ui.chatSend) {
      ui.chatSend.disabled = true;
    }
  }

  toggleMediaElements(features.video);
}

function applyMediaPreferences() {
  if (features.video) {
    handleMediaToggle('video');
  }
  handleMediaToggle('audio');
}

function handleMediaToggle(kind) {
  if (kind === 'video' && !features.video) {
    toggleMediaElements(false);
    return;
  }
  if (kind === 'audio' && !features.audio) {
    enforceTrackState('audio', false);
    return;
  }
  const enabled = kind === 'video' ? ui.videoToggle.checked : ui.audioToggle.checked;
  enforceTrackState(kind, enabled);
  if (kind === 'video') {
    toggleMediaElements(enabled);
  }
}

function toggleMediaElements(videoEnabled) {
  if (!features.video) {
    ui.localVideo.hidden = true;
    ui.remoteVideo.hidden = true;
    ui.localAudio.hidden = false;
    ui.remoteAudio.hidden = false;
    ui.localAudio.classList.add('audio-fallback');
    ui.remoteAudio.classList.add('audio-fallback');
    if (state.localStream) {
      ui.localAudio.srcObject = state.localStream;
    }
    return;
  }
  const showVideo = videoEnabled && state.localStream && state.localStream.getVideoTracks().length;
  ui.localVideo.hidden = !showVideo;
  ui.remoteVideo.hidden = !showVideo;
  ui.localAudio.hidden = showVideo;
  ui.remoteAudio.hidden = showVideo;
  ui.localAudio.classList.toggle('audio-fallback', !showVideo);
  ui.remoteAudio.classList.toggle('audio-fallback', !showVideo);
  if (state.localStream) {
    ui.localAudio.srcObject = state.localStream;
  }
  if (!showVideo && ui.remoteVideo.srcObject) {
    ui.remoteAudio.srcObject = ui.remoteVideo.srcObject;
    ui.remoteAudio.play().catch(() => {});
  }
}

function enforceTrackState(kind, enabled) {
  if (!state.localStream) return;
  const tracks =
    kind === 'video' ? state.localStream.getVideoTracks() : state.localStream.getAudioTracks();
  tracks.forEach((track) => {
    track.enabled = enabled;
  });
}

function isVideoCaptureRequested() {
  if (!features.video) return false;
  return ui.videoToggle ? ui.videoToggle.checked : true;
}

function getMediaPermissionLabel(forceAudioOnly = false) {
  return forceAudioOnly || !isVideoCaptureRequested() ? 'microphone' : 'camera/mic';
}

function getRequestedConstraints(forceAudioOnly = false) {
  if (!features.audio) {
    return { video: false, audio: false };
  }
  if (forceAudioOnly || !isVideoCaptureRequested()) {
    return { video: false, audio: true };
  }
  return { video: true, audio: true };
}

async function ensureLocalStream(options = {}) {
  if (state.localStream) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    if (!options.silent) {
      setStatus('Media capture not supported in this browser.');
    }
    return false;
  }
  const attempt = async (constraints) => {
    state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    ui.localVideo.srcObject = state.localStream;
    applyMediaPreferences();
    toggleMediaElements(isVideoCaptureRequested());
    return true;
  };
  try {
    return await attempt(getRequestedConstraints());
  } catch (err) {
    console.error('getUserMedia error', err);
    const videoIssueNames = new Set(['NotReadableError', 'OverconstrainedError', 'TrackStartError', 'NotFoundError']);
    const messageHintsVideo = err && typeof err.message === 'string' && err.message.toLowerCase().includes('video');
    const videoIssue = err && (videoIssueNames.has(err.name) || messageHintsVideo);
    if (videoIssue && features.video) {
      if (ui.videoToggle) ui.videoToggle.checked = false;
      setStatus('Camera unavailable, using audio only.');
      try {
        return await attempt(getRequestedConstraints(true));
      } catch (fallbackErr) {
        console.error('Audio-only getUserMedia error', fallbackErr);
        if (!options.silent) {
          setStatus('Unable to access microphone.');
        }
        return false;
      }
    }
    if (!options.silent) {
      setStatus(`Allow ${getMediaPermissionLabel()} access to share media.`);
    }
    return false;
  }
}

function buildWsUrl(baseUrl) {
  const url = new URL(baseUrl, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/ws`.replace(/\/+/g, '/');
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function attemptJoin() {
  if (state.selfId) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus('Connecting...');
    return;
  }
  let name = ui.displayName.value.trim();
  if (!name) {
    name = generateRandomName();
    ui.displayName.value = name;
  }
  const siteId = ui.siteId.value.trim();
  state.selfName = name;
  state.siteId = siteId;
  sendWs({ type: 'register', name, siteId });
  setStatus('Registering…');
}

function generateRandomName() {
  const usernameEl = document.getElementById('username');
  // if (usernameEl && usernameEl.value.trim()) {
  //   return usernameEl.value.trim();
  // }
  const adjectives = ['Nova', 'Lumen', 'Pixel', 'Echo', 'Orbit', 'Quill', 'Sol'];
  const animals = ['Fox', 'Swan', 'Drift', 'Wave', 'Ray', 'Comet', 'Ridge'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  const suffix = Math.floor(Math.random() * 90 + 10);
  const random = `${adj}${animal}${suffix}`;
  if (usernameEl) usernameEl.value = random;
  return random;
}

function detectBasePath(defaultPrefix) {
  if (typeof window === 'undefined') return '';
  if (typeof window.__PEER_BASE_PATH__ === 'string') {
    return normalizePrefix(window.__PEER_BASE_PATH__);
  }
  const meta = document.querySelector('meta[name="peer-base-path"]');
  if (meta && meta.content) {
    return normalizePrefix(meta.content);
  }
  const path = window.location.pathname || '/';
  if (defaultPrefix && path.startsWith(defaultPrefix)) return normalizePrefix(defaultPrefix);
  return '';
}

function normalizePrefix(prefix) {
  if (!prefix || prefix === '/') return '';
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? `/${trimmed}` : '';
}

function toggleChatPanel(visible) {
  if (!features.textChat || !ui.chatPanel) return;
  const show = Boolean(visible);
  ui.chatPanel.hidden = !show;
  ui.chatInput.disabled = !show;
  ui.chatSend.disabled = !show;
  if (show) {
    ui.chatInput.focus();
  } else {
    ui.chatInput.value = '';
  }
}

function clearChatLog() {
  if (!features.textChat || !ui.chatLog) return;
  ui.chatLog.innerHTML = '';
  ui.chatLog.scrollTop = 0;
}

function appendChatMessage(author, text, isSelf = false) {
  if (!features.textChat || !ui.chatLog || !text) return;
  const entry = document.createElement('div');
  entry.className = 'chat-message';
  if (isSelf) entry.classList.add('me');
  const header = document.createElement('strong');
  header.textContent = author || (isSelf ? 'You' : 'Peer');
  const body = document.createElement('p');
  body.textContent = text;
  entry.appendChild(header);
  entry.appendChild(body);
  ui.chatLog.appendChild(entry);
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
}

function sendChatMessage() {
  if (!features.textChat) return;
  if (!state.peer || !state.peer.connected) return;
  const message = ui.chatInput.value.trim();
  if (!message) return;
  const payload = {
    kind: 'chat',
    text: message,
    name: state.selfName || 'You',
    id: state.selfId,
    ts: Date.now(),
  };
  try {
    state.peer.send(JSON.stringify(payload));
    appendChatMessage('You', message, true);
    ui.chatInput.value = '';
  } catch (err) {
    console.error('Chat send failed', err);
    setStatus('Unable to send chat message.');
  }
}

function handlePeerData(data) {
  if (!features.textChat) return;
  const decoded = decodeDataChunk(data);
  if (!decoded) return;
  let parsed;
  try {
    parsed = JSON.parse(decoded);
  } catch (err) {
    return;
  }
  if (parsed && parsed.kind === 'chat' && typeof parsed.text === 'string') {
    appendChatMessage(parsed.name || 'Peer', parsed.text);
  }
}

function decodeDataChunk(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer && textDecoder) {
    return textDecoder.decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data) && textDecoder) {
    return textDecoder.decode(data);
  }
  return '';
}

function startCallTimer() {
  if (!ui.callTimer) return;
  stopCallTimer();
  state.callStartedAt = Date.now();
  ui.callTimer.hidden = false;
  updateCallTimer();
  state.callTimerInterval = window.setInterval(updateCallTimer, 1000);
}

function stopCallTimer() {
  if (state.callTimerInterval) {
    clearInterval(state.callTimerInterval);
    state.callTimerInterval = null;
  }
  state.callStartedAt = null;
  if (ui.callTimer) {
    ui.callTimer.textContent = '00:00';
    ui.callTimer.hidden = true;
  }
}

function updateCallTimer() {
  if (!ui.callTimer || !state.callStartedAt) return;
  const elapsed = Date.now() - state.callStartedAt;
  ui.callTimer.textContent = formatDuration(elapsed);
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

function setStatus(message) {
  ui.status.textContent = message || '';
}

return {
  attemptJoin,
  buildWsUrl,
  setStatus,
};
})();

if (typeof window !== 'undefined') {
  window.peerCall = peerCall;
}

module.exports = peerCall;
