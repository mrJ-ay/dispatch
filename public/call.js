const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export function initCallManager({ getRoomId, getNickname }) {
  const el = {
    startVoiceBtn: document.getElementById('startVoiceCallBtn'),
    startVideoBtn: document.getElementById('startVideoCallBtn'),
    callBanner: document.getElementById('callBanner'),
    callBannerText: document.getElementById('callBannerText'),
    joinBannerVoiceBtn: document.getElementById('joinBannerVoiceBtn'),
    joinBannerVideoBtn: document.getElementById('joinBannerVideoBtn'),
    callStage: document.getElementById('callStage'),
    callStageTitle: document.getElementById('callStageTitle'),
    callTimer: document.getElementById('callTimer'),
    callPeerCount: document.getElementById('callPeerCount'),
    callMinimizeBtn: document.getElementById('callMinimizeBtn'),
    callGrid: document.getElementById('callGrid'),
    callMicBtn: document.getElementById('callMicBtn'),
    callCamBtn: document.getElementById('callCamBtn'),
    callScreenBtn: document.getElementById('callScreenBtn'),
    callLeaveBtn: document.getElementById('callLeaveBtn'),
  };

  const state = {
    inCall: false,
    roomId: null,
    socket: null,
    localStream: null,
    screenStream: null,
    micEnabled: true,
    camEnabled: false,
    isScreenSharing: false,
    isMinimized: false,
    peers: new Map(), // socketId -> { pc, nickname, micEnabled, camEnabled, stream }
    lastStatus: null,
    startedAt: 0,
    timerId: null,
  };

  function ensureCallSocket() {
    if (state.socket) return state.socket;
    const s = window.io('/call', {
      transports: ['websocket', 'polling'],
    });

    s.on('call:peers', async ({ peers }) => {
      for (const peer of peers || []) {
        await createPeerConnection(peer.socketId, peer, true);
      }
      renderGrid();
    });

    s.on('call:peer-joined', async (peer) => {
      if (!peer?.socketId || peer.socketId === s.id) return;
      await createPeerConnection(peer.socketId, peer, false);
      renderGrid();
    });

    s.on('call:signal', async ({ from, data }) => {
      if (!from || !data) return;
      let entry = state.peers.get(from);
      if (!entry) {
        entry = await createPeerConnection(from, { socketId: from, nickname: '참여자' }, false);
      }
      const pc = entry.pc;
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          if (data.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            s.emit('call:signal', { to: from, data: { sdp: pc.localDescription } });
          }
        } else if (data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch (err) {
        console.warn('WebRTC signaling error:', err);
      }
    });

    s.on('call:media-state', ({ socketId, micEnabled, camEnabled }) => {
      const entry = state.peers.get(socketId);
      if (!entry) return;
      if (typeof micEnabled === 'boolean') entry.micEnabled = micEnabled;
      if (typeof camEnabled === 'boolean') entry.camEnabled = camEnabled;
      renderGrid();
    });

    s.on('call:peer-left', ({ socketId }) => {
      removePeer(socketId);
      renderGrid();
    });

    s.on('disconnect', () => {
      if (state.inCall) {
        cleanupCallState();
      }
    });

    state.socket = s;
    return s;
  }

  async function createPeerConnection(peerId, info, isInitiator) {
    if (state.peers.has(peerId)) {
      return state.peers.get(peerId);
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const remoteStream = new MediaStream();
    const entry = {
      pc,
      socketId: peerId,
      nickname: info?.nickname || '참여자',
      micEnabled: info?.micEnabled !== false,
      camEnabled: Boolean(info?.camEnabled),
      stream: remoteStream,
    };
    state.peers.set(peerId, entry);

    if (state.localStream) {
      for (const track of state.localStream.getTracks()) {
        pc.addTrack(track, state.localStream);
      }
    }

    pc.ontrack = (event) => {
      const streams = event.streams && event.streams.length > 0 ? event.streams : [new MediaStream([event.track])];
      for (const t of streams[0].getTracks()) {
        if (!remoteStream.getTracks().some((existing) => existing.id === t.id)) {
          remoteStream.addTrack(t);
        }
      }
      renderGrid();
    };

    pc.onicecandidate = (event) => {
      if (event.candidate && state.socket) {
        state.socket.emit('call:signal', {
          to: peerId,
          data: { candidate: event.candidate },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        removePeer(peerId);
        renderGrid();
      }
    };

    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        state.socket.emit('call:signal', {
          to: peerId,
          data: { sdp: pc.localDescription },
        });
      } catch (err) {
        console.warn('Offer creation failed:', err);
      }
    }

    return entry;
  }

  function removePeer(peerId) {
    const entry = state.peers.get(peerId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {}
    state.peers.delete(peerId);
  }

  async function acquireMedia(withVideo) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 브라우저는 음성/영상 통화를 지원하지 않습니다.');
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
      });
    } catch (err) {
      if (withVideo) {
        // Fallback to audio-only if camera is missing or denied
        return await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
      }
      throw err;
    }
  }

  async function startCall(withVideo) {
    const roomId = getRoomId();
    if (!roomId) return;
    if (state.inCall) {
      if (withVideo && !state.camEnabled) {
        await toggleCam();
      }
      return;
    }

    try {
      const stream = await acquireMedia(withVideo);
      state.localStream = stream;
      state.micEnabled = stream.getAudioTracks().length > 0;
      state.camEnabled = stream.getVideoTracks().length > 0;
    } catch (err) {
      window.alert(err?.message || '마이크/카메라 권한을 확인할 수 없습니다.');
      return;
    }

    state.inCall = true;
    state.roomId = roomId;
    state.isMinimized = false;
    state.startedAt = Date.now();
    startTimer();

    const s = ensureCallSocket();
    s.emit('call:join', {
      roomId,
      nickname: getNickname() || '익명',
      micEnabled: state.micEnabled,
      camEnabled: state.camEnabled,
    });

    updateBannerVisibility();
    updateControlButtons();
    el.callStage.hidden = false;
    el.callStage.classList.remove('is-minimized');
    el.callMinimizeBtn.textContent = '▾';
    renderGrid();
  }

  function cleanupCallState() {
    if (state.timerId) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    for (const peerId of Array.from(state.peers.keys())) {
      removePeer(peerId);
    }
    if (state.screenStream) {
      state.screenStream.getTracks().forEach((t) => t.stop());
      state.screenStream = null;
    }
    if (state.localStream) {
      state.localStream.getTracks().forEach((t) => t.stop());
      state.localStream = null;
    }
    state.inCall = false;
    state.roomId = null;
    state.isScreenSharing = false;
    state.micEnabled = true;
    state.camEnabled = false;
    el.callStage.hidden = true;
    el.callGrid.innerHTML = '';
    el.callTimer.textContent = '00:00';
    updateBannerVisibility();
  }

  function leaveCall() {
    if (!state.inCall) return;
    if (state.socket) {
      state.socket.emit('call:leave');
    }
    cleanupCallState();
  }

  async function toggleMic() {
    if (!state.inCall || !state.localStream) return;
    const audioTracks = state.localStream.getAudioTracks();
    if (audioTracks.length === 0) return;
    state.micEnabled = !state.micEnabled;
    audioTracks.forEach((t) => {
      t.enabled = state.micEnabled;
    });
    emitMediaState();
    updateControlButtons();
    renderGrid();
  }

  async function toggleCam() {
    if (!state.inCall || !state.localStream) return;
    const existingVideo = state.localStream.getVideoTracks()[0];

    if (existingVideo) {
      state.camEnabled = !state.camEnabled;
      existingVideo.enabled = state.camEnabled;
      emitMediaState();
      updateControlButtons();
      renderGrid();
      return;
    }

    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      });
      const newTrack = camStream.getVideoTracks()[0];
      if (!newTrack) return;
      state.localStream.addTrack(newTrack);
      state.camEnabled = true;

      for (const entry of state.peers.values()) {
        const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newTrack);
        } else {
          entry.pc.addTrack(newTrack, state.localStream);
          const offer = await entry.pc.createOffer();
          await entry.pc.setLocalDescription(offer);
          state.socket.emit('call:signal', {
            to: entry.socketId,
            data: { sdp: entry.pc.localDescription },
          });
        }
      }

      emitMediaState();
      updateControlButtons();
      renderGrid();
    } catch {
      window.alert('카메라를 시작할 수 없습니다.');
    }
  }

  async function toggleScreenShare() {
    if (!state.inCall || !state.localStream) return;

    if (state.isScreenSharing) {
      await stopScreenShare();
      return;
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      window.alert('이 브라우저는 화면 공유를 지원하지 않습니다.');
      return;
    }

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) return;

      state.screenStream = screenStream;
      state.isScreenSharing = true;
      state.camEnabled = true;

      screenTrack.onended = () => {
        stopScreenShare();
      };

      await replaceVideoTrackForPeers(screenTrack);
      emitMediaState();
      updateControlButtons();
      renderGrid();
    } catch {
      // User cancelled screen picker
    }
  }

  async function stopScreenShare() {
    if (!state.isScreenSharing) return;
    if (state.screenStream) {
      state.screenStream.getTracks().forEach((t) => t.stop());
      state.screenStream = null;
    }
    state.isScreenSharing = false;

    const camTrack = state.localStream?.getVideoTracks()?.[0] || null;
    state.camEnabled = Boolean(camTrack && camTrack.enabled);
    if (camTrack) {
      await replaceVideoTrackForPeers(camTrack);
    } else {
      for (const entry of state.peers.values()) {
        const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(null);
        }
      }
    }

    emitMediaState();
    updateControlButtons();
    renderGrid();
  }

  async function replaceVideoTrackForPeers(track) {
    for (const entry of state.peers.values()) {
      const sender = entry.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(track);
      } else {
        entry.pc.addTrack(track, state.localStream);
        const offer = await entry.pc.createOffer();
        await entry.pc.setLocalDescription(offer);
        state.socket.emit('call:signal', {
          to: entry.socketId,
          data: { sdp: entry.pc.localDescription },
        });
      }
    }
  }

  function emitMediaState() {
    if (!state.socket || !state.inCall) return;
    state.socket.emit('call:media-state', {
      micEnabled: state.micEnabled,
      camEnabled: state.camEnabled,
    });
  }

  function startTimer() {
    if (state.timerId) clearInterval(state.timerId);
    const update = () => {
      const sec = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      el.callTimer.textContent = `${mm}:${ss}`;
    };
    update();
    state.timerId = setInterval(update, 1000);
  }

  function updateControlButtons() {
    el.callMicBtn.classList.toggle('is-active', state.micEnabled);
    el.callMicBtn.classList.toggle('is-muted', !state.micEnabled);
    el.callMicBtn.textContent = state.micEnabled ? '🎙️ 마이크' : '🔇 음소거됨';

    el.callCamBtn.classList.toggle('is-active', state.camEnabled && !state.isScreenSharing);
    el.callCamBtn.textContent = state.camEnabled ? '📷 카메라 ON' : '📷 카메라';

    el.callScreenBtn.classList.toggle('is-active', state.isScreenSharing);
    el.callScreenBtn.textContent = state.isScreenSharing ? '🛑 공유 중지' : '🖥️ 화면 공유';
  }

  function buildTile({ id, nickname, stream, isSelf, micEnabled, camEnabled }) {
    const tile = document.createElement('div');
    tile.className = `call-tile ${camEnabled ? 'has-video' : 'audio-only'}`;
    tile.dataset.peerId = id;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isSelf) video.muted = true;
    if (stream) video.srcObject = stream;
    tile.appendChild(video);

    const avatarOverlay = document.createElement('div');
    avatarOverlay.className = 'call-tile-avatar';
    const initial = (nickname || '?').slice(0, 1).toUpperCase();
    const circle = document.createElement('div');
    circle.className = 'call-avatar-circle';
    circle.textContent = initial;
    avatarOverlay.appendChild(circle);
    tile.appendChild(avatarOverlay);

    const label = document.createElement('div');
    label.className = 'call-tile-label';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = isSelf ? `${nickname} (나)` : nickname;
    label.appendChild(nameSpan);

    if (!micEnabled) {
      const muteBadge = document.createElement('span');
      muteBadge.className = 'call-mute-badge';
      muteBadge.textContent = '🔇';
      label.appendChild(muteBadge);
    }
    tile.appendChild(label);

    return tile;
  }

  function renderGrid() {
    if (!state.inCall) return;
    el.callGrid.innerHTML = '';

    const selfStream = state.isScreenSharing && state.screenStream ? state.screenStream : state.localStream;
    el.callGrid.appendChild(
      buildTile({
        id: 'self',
        nickname: getNickname() || '나',
        stream: selfStream,
        isSelf: true,
        micEnabled: state.micEnabled,
        camEnabled: state.camEnabled,
      })
    );

    for (const peer of state.peers.values()) {
      const hasLiveVideo = peer.camEnabled && peer.stream && peer.stream.getVideoTracks().length > 0;
      el.callGrid.appendChild(
        buildTile({
          id: peer.socketId,
          nickname: peer.nickname,
          stream: peer.stream,
          isSelf: false,
          micEnabled: peer.micEnabled,
          camEnabled: hasLiveVideo,
        })
      );
    }

    const total = 1 + state.peers.size;
    el.callPeerCount.textContent = `${total}명 참여 중`;
    el.callGrid.dataset.count = String(Math.min(total, 6));
  }

  function updateBannerVisibility() {
    const currentRoomId = getRoomId();
    const st = state.lastStatus;
    const shouldShow =
      Boolean(currentRoomId) &&
      !state.inCall &&
      st &&
      st.roomId === currentRoomId &&
      st.activeCount > 0;

    el.callBanner.hidden = !shouldShow;
    if (shouldShow) {
      const names = (st.participants || []).map((p) => p.nickname).filter(Boolean);
      const lead = names[0] || '멤버';
      const summary =
        st.activeCount === 1
          ? `${lead}님이 통화를 시작했습니다`
          : `${lead}님 외 ${st.activeCount - 1}명이 통화 중입니다`;
      el.callBannerText.textContent = summary;
    }
  }

  function handleCallStatus(status) {
    state.lastStatus = status || null;
    updateBannerVisibility();
  }

  function handleRoomChange(newRoomId) {
    if (state.inCall && state.roomId !== newRoomId) {
      leaveCall();
    }
    state.lastStatus = null;
    updateBannerVisibility();
  }

  el.startVoiceBtn.addEventListener('click', () => startCall(false));
  el.startVideoBtn.addEventListener('click', () => startCall(true));
  el.joinBannerVoiceBtn.addEventListener('click', () => startCall(false));
  el.joinBannerVideoBtn.addEventListener('click', () => startCall(true));
  el.callMicBtn.addEventListener('click', toggleMic);
  el.callCamBtn.addEventListener('click', toggleCam);
  el.callScreenBtn.addEventListener('click', toggleScreenShare);
  el.callLeaveBtn.addEventListener('click', leaveCall);
  el.callMinimizeBtn.addEventListener('click', () => {
    state.isMinimized = !state.isMinimized;
    el.callStage.classList.toggle('is-minimized', state.isMinimized);
    el.callMinimizeBtn.textContent = state.isMinimized ? '▸' : '▾';
  });

  window.addEventListener('beforeunload', () => {
    if (state.inCall && state.socket) {
      state.socket.emit('call:leave');
    }
  });

  return {
    handleCallStatus,
    handleRoomChange,
    leaveCall,
  };
}
