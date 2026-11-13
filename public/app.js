(() => {
  'use strict';

  const STORAGE_KEYS = {
    theme: 'dispatch_theme',
    sound: 'dispatch_sound',
    nickname: 'dispatch_nickname',
    rooms: 'dispatch_rooms',
    oneidToken: 'dispatch_oneid_token',
    oneidUser: 'dispatch_oneid_user',
    pkceVerifier: 'dispatch_pkce_verifier',
    pkceState: 'dispatch_pkce_state',
  };

  const state = {
    config: {
      oneidUrl: 'https://oneid-ruddy.vercel.app',
      clientId: 'dispatch',
    },
    token: localStorage.getItem(STORAGE_KEYS.oneidToken) || '',
    user: safeJsonParse(localStorage.getItem(STORAGE_KEYS.oneidUser), null),
    nickname: localStorage.getItem(STORAGE_KEYS.nickname) || '',
    theme: localStorage.getItem(STORAGE_KEYS.theme) || 'light',
    soundEnabled: localStorage.getItem(STORAGE_KEYS.sound) !== 'false',
    savedRooms: safeJsonParse(localStorage.getItem(STORAGE_KEYS.rooms), []),
    serverRooms: [],
    currentRoom: null,
    me: null,
    messages: [],
    members: [],
    typingUsers: new Map(),
    replyTo: null,
    modalMode: 'join',
    socket: null,
    typingTimer: null,
    isTyping: false,
    uploading: false,
    dragDepth: 0,
    audioCtx: null,
  };

  const el = {
    soundToggleBtn: document.getElementById('soundToggleBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    authAvatar: document.getElementById('authAvatar'),
    authName: document.getElementById('authName'),
    authSub: document.getElementById('authSub'),
    oneidAuthBtn: document.getElementById('oneidAuthBtn'),
    openCreateModalBtn: document.getElementById('openCreateModalBtn'),
    openJoinModalBtn: document.getElementById('openJoinModalBtn'),
    roomsList: document.getElementById('roomsList'),

    chatWelcome: document.getElementById('chatWelcome'),
    welcomeCreateBtn: document.getElementById('welcomeCreateBtn'),
    welcomeJoinBtn: document.getElementById('welcomeJoinBtn'),
    chatActive: document.getElementById('chatActive'),
    mobileBackBtn: document.getElementById('mobileBackBtn'),
    roomAvatar: document.getElementById('roomAvatar'),
    roomTitle: document.getElementById('roomTitle'),
    roomIdPill: document.getElementById('roomIdPill'),
    roomStatus: document.getElementById('roomStatus'),
    copyInviteBtn: document.getElementById('copyInviteBtn'),

    messagesWrap: document.getElementById('messagesWrap'),
    messagesList: document.getElementById('messagesList'),
    typingBar: document.getElementById('typingBar'),

    replyPreview: document.getElementById('replyPreview'),
    replySender: document.getElementById('replySender'),
    replySnippet: document.getElementById('replySnippet'),
    replyCancelBtn: document.getElementById('replyCancelBtn'),
    uploadBar: document.getElementById('uploadBar'),
    uploadText: document.getElementById('uploadText'),

    composerForm: document.getElementById('composerForm'),
    fileInput: document.getElementById('fileInput'),
    attachBtn: document.getElementById('attachBtn'),
    msgInput: document.getElementById('msgInput'),
    sendBtn: document.getElementById('sendBtn'),
    dropOverlay: document.getElementById('dropOverlay'),

    roomModal: document.getElementById('roomModal'),
    modalTitle: document.getElementById('modalTitle'),
    modalCloseBtn: document.getElementById('modalCloseBtn'),
    roomForm: document.getElementById('roomForm'),
    roomTitleField: document.getElementById('roomTitleField'),
    inputRoomTitle: document.getElementById('inputRoomTitle'),
    roomIdField: document.getElementById('roomIdField'),
    inputRoomId: document.getElementById('inputRoomId'),
    inputNickname: document.getElementById('inputNickname'),
    inputRoomPassword: document.getElementById('inputRoomPassword'),
    modalError: document.getElementById('modalError'),
    modalSubmitBtn: document.getElementById('modalSubmitBtn'),

    lightbox: document.getElementById('lightbox'),
    lightboxClose: document.getElementById('lightboxClose'),
    lightboxImg: document.getElementById('lightboxImg'),
    lightboxDownload: document.getElementById('lightboxDownload'),
  };

  function safeJsonParse(raw, fallback) {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function applyTheme() {
    const isDark = state.theme === 'dark';
    document.body.classList.toggle('theme-dark', isDark);
    document.body.classList.toggle('theme-light', !isDark);
    if (el.themeToggleBtn) {
      el.themeToggleBtn.textContent = isDark ? '☀️' : '🌙';
      el.themeToggleBtn.title = isDark ? '라이트 모드' : '다크 모드';
    }
  }

  function applySoundUI() {
    if (el.soundToggleBtn) {
      el.soundToggleBtn.textContent = state.soundEnabled ? '🔔' : '🔕';
      el.soundToggleBtn.title = state.soundEnabled ? '알림음 켜짐' : '알림음 꺼짐';
    }
  }

  function playChime() {
    if (!state.soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!state.audioCtx) state.audioCtx = new AudioCtx();
      if (state.audioCtx.state === 'suspended') {
        state.audioCtx.resume().catch(() => {});
      }
      const now = state.audioCtx.currentTime;
      const osc = state.audioCtx.createOscillator();
      const gain = state.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.08);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      osc.connect(gain);
      gain.connect(state.audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.24);
    } catch {
      // Ignore audio restrictions
    }
  }

  function getDisplayName() {
    if (state.user?.nickname) return state.user.nickname;
    if (state.user?.name) return state.user.name;
    if (state.user?.username) return state.user.username;
    return state.nickname || '';
  }

  function renderAuthUI() {
    const name = getDisplayName();
    if (state.user && state.token) {
      const label = state.user.nickname || state.user.name || state.user.username || 'ONEID';
      el.authAvatar.textContent = label.slice(0, 1).toUpperCase();
      el.authName.textContent = `${label} ✓`;
      el.authSub.textContent = 'ONEID 인증됨 · 방 목록 바로 입장';
      el.oneidAuthBtn.textContent = '로그아웃';
      el.oneidAuthBtn.classList.add('is-authed');
    } else {
      el.authAvatar.textContent = name ? name.slice(0, 1).toUpperCase() : '?';
      el.authName.textContent = name || '게스트';
      el.authSub.textContent = '비로그인 · 방 ID로 참여';
      el.oneidAuthBtn.textContent = 'ONEID 로그인';
      el.oneidAuthBtn.classList.remove('is-authed');
    }
  }

  async function fetchServerRooms() {
    if (!state.token || !state.user) {
      state.serverRooms = [];
      renderRoomsList();
      return;
    }
    try {
      const resp = await fetch('/api/rooms', {
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.authed && Array.isArray(data.rooms)) {
        state.serverRooms = data.rooms;
      } else {
        state.serverRooms = [];
      }
      renderRoomsList();
    } catch {
      // Ignore network errors
    }
  }

  function saveRooms() {
    localStorage.setItem(STORAGE_KEYS.rooms, JSON.stringify(state.savedRooms.slice(0, 30)));
  }

  function upsertSavedRoom(roomMeta) {
    if (!roomMeta?.roomId) return;
    const existingIdx = state.savedRooms.findIndex((r) => r.roomId === roomMeta.roomId);
    const entry = {
      roomId: roomMeta.roomId,
      title: roomMeta.title || roomMeta.roomId,
      hasPassword: Boolean(roomMeta.hasPassword),
      lastActiveAt: Date.now(),
    };
    if (existingIdx >= 0) {
      state.savedRooms.splice(existingIdx, 1);
    }
    state.savedRooms.unshift(entry);
    saveRooms();
    renderRoomsList();
  }

  function renderRoomsList() {
    el.roomsList.innerHTML = '';
    const isAuthed = Boolean(state.token && state.user);

    let listToRender = [];
    if (isAuthed) {
      const merged = new Map();
      for (const r of state.serverRooms) {
        merged.set(r.roomId, { ...r });
      }
      for (const r of state.savedRooms) {
        if (!merged.has(r.roomId)) {
          merged.set(r.roomId, { ...r, memberCount: null });
        }
      }
      listToRender = Array.from(merged.values());
    } else {
      listToRender = state.savedRooms;
    }

    if (!listToRender.length) {
      const empty = document.createElement('div');
      empty.className = 'rooms-empty';
      empty.textContent = isAuthed
        ? '열려 있는 방이 없습니다. 새 방을 만들어 보세요.'
        : '비로그인 상태에서는 방 ID로만 입장할 수 있습니다.';
      el.roomsList.appendChild(empty);
      return;
    }

    for (const room of listToRender) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'room-item';
      if (state.currentRoom?.roomId === room.roomId) {
        item.classList.add('is-active');
      }

      const avatar = document.createElement('div');
      avatar.className = 'room-item-avatar';
      avatar.textContent = (room.title || room.roomId).slice(0, 1).toUpperCase();

      const meta = document.createElement('div');
      meta.className = 'room-item-meta';

      const top = document.createElement('div');
      top.className = 'room-item-top';

      const title = document.createElement('span');
      title.className = 'room-item-title';
      title.textContent = room.title || room.roomId;

      const lock = document.createElement('span');
      lock.className = 'room-item-lock';
      lock.textContent = room.hasPassword ? '🔒' : '';

      top.append(title, lock);

      const sub = document.createElement('div');
      sub.className = 'room-item-id';
      sub.textContent =
        typeof room.memberCount === 'number'
          ? `#${room.roomId} · ${room.memberCount}명 온라인`
          : `#${room.roomId}`;

      meta.append(top, sub);
      item.append(avatar, meta);

      item.addEventListener('click', () => {
        if (state.currentRoom?.roomId === room.roomId) {
          document.body.classList.add('mobile-in-chat');
          return;
        }
        if (isAuthed && !room.hasPassword) {
          joinRoom({ roomId: room.roomId, title: room.title });
          return;
        }
        openModal('join', { roomId: room.roomId });
      });

      el.roomsList.appendChild(item);
    }
  }

  function showModalError(msg) {
    el.modalError.textContent = msg || '';
    el.modalError.hidden = !msg;
  }

  function openModal(mode, prefill = {}) {
    state.modalMode = mode;
    showModalError('');
    const isCreate = mode === 'create';
    el.modalTitle.textContent = isCreate ? '새 방 만들기' : '방 ID로 입장';
    el.modalSubmitBtn.textContent = isCreate ? '방 만들고 입장' : '입장하기';
    el.roomTitleField.hidden = !isCreate;
    el.inputRoomTitle.required = isCreate;
    el.inputRoomId.required = !isCreate;

    el.inputRoomTitle.value = prefill.title || '';
    el.inputRoomId.value = prefill.roomId || '';
    el.inputNickname.value = prefill.nickname || getDisplayName() || '';
    el.inputRoomPassword.value = '';

    el.roomModal.hidden = false;
    setTimeout(() => {
      if (isCreate) {
        el.inputRoomTitle.focus();
      } else if (!el.inputRoomId.value) {
        el.inputRoomId.focus();
      } else if (!el.inputNickname.value) {
        el.inputNickname.focus();
      } else {
        el.inputRoomPassword.focus();
      }
    }, 20);
  }

  function closeModal() {
    el.roomModal.hidden = true;
    showModalError('');
  }

  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let idx = 0;
    let val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx += 1;
    }
    return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
  }

  function setReply(msg) {
    if (!msg) {
      state.replyTo = null;
      el.replyPreview.hidden = true;
      return;
    }
    const senderInfo = getSenderInfo(msg);
    state.replyTo = {
      id: msg.id,
      senderName: senderInfo.nickname || '알 수 없음',
      snippet: msg.text ? msg.text.slice(0, 80) : msg.attachment?.name || '파일',
    };
    el.replySender.textContent = state.replyTo.senderName;
    el.replySnippet.textContent = state.replyTo.snippet;
    el.replyPreview.hidden = false;
    el.msgInput.focus();
  }

  function getSenderInfo(msg) {
    const s = msg?.sender || {};
    return {
      socketId: s.socketId || msg?.socketId || null,
      userId: s.userId || msg?.userId || null,
      nickname: s.nickname || msg?.senderName || '',
      verified: Boolean(s.verified ?? msg?.verified),
    };
  }

  function isMyMessage(msg) {
    const s = getSenderInfo(msg);
    return Boolean(
      (state.me?.socketId && s.socketId === state.me.socketId) ||
      (state.me?.userId && s.userId && s.userId === state.me.userId)
    );
  }

  function openLightbox(url, filename) {
    el.lightboxImg.src = url;
    el.lightboxDownload.href = url;
    el.lightboxDownload.download = filename || 'image';
    el.lightbox.hidden = false;
  }

  function closeLightbox() {
    el.lightbox.hidden = true;
    el.lightboxImg.src = '';
  }

  function scrollToBottom(force = false) {
    const wrap = el.messagesWrap;
    if (!wrap) return;
    const distanceFromBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
    if (force || distanceFromBottom < 140) {
      wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function renderTypingBar() {
    const names = Array.from(state.typingUsers.values()).filter(Boolean);
    if (!names.length) {
      el.typingBar.hidden = true;
      el.typingBar.textContent = '';
      return;
    }
    const label =
      names.length === 1
        ? `${names[0]}님이 입력 중...`
        : `${names.slice(0, 2).join(', ')} 외 ${names.length - 2 > 0 ? `${names.length - 2}명 ` : ''}입력 중...`;
    el.typingBar.textContent = label;
    el.typingBar.hidden = false;
  }

  function renderRoomHeader() {
    if (!state.currentRoom) return;
    const title = state.currentRoom.title || state.currentRoom.roomId;
    el.roomAvatar.textContent = title.slice(0, 1).toUpperCase();
    el.roomTitle.textContent = title;
    el.roomIdPill.textContent = `#${state.currentRoom.roomId}`;
    const count = state.members.length;
    const meLabel = state.me?.nickname
      ? `${state.me.nickname}${state.me.verified ? ' ✓' : ''} · `
      : '';
    el.roomStatus.textContent = count > 0 ? `${meLabel}참여자 ${count}명 온라인` : `${meLabel}연결됨`;
  }

  function createMessageNode(msg) {
    if (msg.type === 'system') {
      const sys = document.createElement('div');
      sys.className = 'msg-system';
      sys.dataset.id = msg.id;
      sys.textContent = msg.text;
      return sys;
    }

    const isMine = isMyMessage(msg);
    const senderInfo = getSenderInfo(msg);

    const row = document.createElement('div');
    row.className = `msg-row ${isMine ? 'is-mine' : 'is-theirs'}`;
    row.dataset.id = msg.id;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    const sender = document.createElement('div');
    sender.className = 'msg-sender';
    sender.textContent = senderInfo.nickname || '익명';
    if (senderInfo.verified) {
      const badge = document.createElement('span');
      badge.className = 'verified-badge';
      badge.title = 'ONEID 인증 사용자';
      badge.textContent = '✓';
      sender.appendChild(badge);
    }
    bubble.appendChild(sender);

    if (msg.replyTo) {
      const quote = document.createElement('div');
      quote.className = 'msg-reply-quote';
      const qSender = document.createElement('div');
      qSender.className = 'msg-reply-sender';
      qSender.textContent = msg.replyTo.senderName || '답장';
      const qText = document.createElement('div');
      qText.className = 'msg-reply-text';
      qText.textContent = msg.replyTo.snippet || '';
      quote.append(qSender, qText);
      bubble.appendChild(quote);
    }

    if (msg.attachment) {
      const att = msg.attachment;
      if (att.isImage) {
        const imgWrap = document.createElement('div');
        imgWrap.className = 'msg-image-wrap';
        const img = document.createElement('img');
        img.className = 'msg-image';
        img.src = att.url;
        img.alt = att.name || 'image';
        img.loading = 'lazy';
        img.addEventListener('click', () => openLightbox(att.url, att.name));
        imgWrap.appendChild(img);
        bubble.appendChild(imgWrap);
      } else {
        const card = document.createElement('a');
        card.className = 'msg-file-card';
        card.href = att.url;
        card.download = att.name || 'file';
        card.target = '_blank';
        card.rel = 'noopener noreferrer';

        const icon = document.createElement('div');
        icon.className = 'msg-file-icon';
        icon.textContent = '📄';

        const info = document.createElement('div');
        info.className = 'msg-file-info';
        const fname = document.createElement('div');
        fname.className = 'msg-file-name';
        fname.textContent = att.name || '첨부파일';
        const fsize = document.createElement('div');
        fsize.className = 'msg-file-size';
        fsize.textContent = formatBytes(att.size);
        info.append(fname, fsize);

        const dl = document.createElement('span');
        dl.className = 'msg-file-dl';
        dl.textContent = '⬇';

        card.append(icon, info, dl);
        bubble.appendChild(card);
      }
    }

    if (msg.text) {
      const body = document.createElement('div');
      body.className = 'msg-text';
      body.textContent = msg.text;
      bubble.appendChild(body);
    }

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(msg.createdAt);
    meta.appendChild(time);

    const actions = document.createElement('span');
    actions.className = 'msg-actions';

    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'msg-action-btn';
    replyBtn.title = '답장';
    replyBtn.textContent = '↩';
    replyBtn.addEventListener('click', () => setReply(msg));
    actions.appendChild(replyBtn);

    if (isMine || state.currentRoom?.isOwner) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'msg-action-btn';
      delBtn.title = '삭제';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => {
        state.socket?.emit('chat:delete', { messageId: msg.id });
      });
      actions.appendChild(delBtn);
    }

    meta.appendChild(actions);
    bubble.appendChild(meta);
    row.appendChild(bubble);
    return row;
  }

  function renderAllMessages() {
    el.messagesList.innerHTML = '';
    for (const msg of state.messages) {
      el.messagesList.appendChild(createMessageNode(msg));
    }
    scrollToBottom(true);
  }

  function appendMessage(msg) {
    state.messages.push(msg);
    el.messagesList.appendChild(createMessageNode(msg));
    scrollToBottom(false);

    if (!isMyMessage(msg) && msg.type !== 'system') {
      playChime();
    }
  }

  function ensureSocket() {
    if (state.socket) return state.socket;
    const socket = window.io({ transports: ['websocket', 'polling'] });
    state.socket = socket;

    socket.on('room:members', (payload) => {
      if (!state.currentRoom || payload.roomId !== state.currentRoom.roomId) return;
      state.members = Array.isArray(payload.members) ? payload.members : [];
      renderRoomHeader();
    });

    socket.on('chat:message', (msg) => {
      if (!state.currentRoom) return;
      appendMessage(msg);
    });

    socket.on('chat:typing', ({ socketId, nickname, isTyping }) => {
      if (!state.currentRoom || socketId === socket.id) return;
      if (isTyping) {
        state.typingUsers.set(socketId, nickname || '누군가');
      } else {
        state.typingUsers.delete(socketId);
      }
      renderTypingBar();
    });

    socket.on('chat:deleted', ({ messageId }) => {
      state.messages = state.messages.filter((m) => m.id !== messageId);
      const node = el.messagesList.querySelector(`[data-id="${CSS.escape(messageId)}"]`);
      if (node) node.remove();
    });

    socket.on('rooms:updated', () => {
      if (state.token && state.user) {
        fetchServerRooms();
      }
    });

    return socket;
  }

  function joinRoom({ roomId, title, nickname, password }) {
    const socket = ensureSocket();
    const cleanNick = (nickname || getDisplayName() || '').trim();
    if (cleanNick) {
      state.nickname = cleanNick;
      localStorage.setItem(STORAGE_KEYS.nickname, cleanNick);
      renderAuthUI();
    }

    return new Promise((resolve) => {
      socket.emit(
        'room:join',
        {
          roomId,
          title,
          nickname: cleanNick,
          password,
          token: state.token || undefined,
        },
        (res) => {
          if (!res?.ok) {
            resolve(res || { ok: false, error: '방 입장에 실패했습니다.' });
            return;
          }

          state.currentRoom = {
            roomId: res.room.roomId,
            title: res.room.title,
            hasPassword: res.room.hasPassword,
            isOwner: res.room.isOwner,
          };
          state.me = res.me;
          state.messages = Array.isArray(res.room.messages) ? res.room.messages : [];
          state.typingUsers.clear();
          setReply(null);

          upsertSavedRoom(state.currentRoom);
          el.chatWelcome.hidden = true;
          el.chatActive.hidden = false;
          document.body.classList.add('mobile-in-chat');
          renderRoomHeader();
          renderTypingBar();
          renderAllMessages();

          const url = new URL(window.location.href);
          url.searchParams.set('room', state.currentRoom.roomId);
          window.history.replaceState({}, '', url.toString());

          resolve({ ok: true });
        }
      );
    });
  }

  async function handleModalSubmit(e) {
    e.preventDefault();
    showModalError('');

    const title = el.inputRoomTitle.value.trim();
    const roomId = el.inputRoomId.value.trim();
    const nickname = el.inputNickname.value.trim();
    const password = el.inputRoomPassword.value;

    if (!nickname && !state.token) {
      showModalError('닉네임을 입력하세요.');
      return;
    }

    el.modalSubmitBtn.disabled = true;
    try {
      let targetRoomId = roomId;
      let targetTitle = title;

      if (state.modalMode === 'create') {
        if (!title) {
          showModalError('방 이름을 입력하세요.');
          return;
        }
        const resp = await fetch('/api/rooms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            roomId: roomId || undefined,
            password: password || undefined,
            token: state.token || undefined,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          showModalError(data.error || '방 생성에 실패했습니다.');
          return;
        }
        targetRoomId = data.roomId;
        targetTitle = data.title;
      } else if (!targetRoomId) {
        showModalError('방 ID를 입력하세요.');
        return;
      }

      const res = await joinRoom({
        roomId: targetRoomId,
        title: targetTitle,
        nickname,
        password,
      });

      if (!res.ok) {
        showModalError(res.error || '입장에 실패했습니다.');
        return;
      }

      closeModal();
    } catch {
      showModalError('네트워크 오류가 발생했습니다.');
    } finally {
      el.modalSubmitBtn.disabled = false;
    }
  }

  function emitTyping(isTyping) {
    if (!state.socket || !state.currentRoom) return;
    if (state.isTyping === isTyping) return;
    state.isTyping = isTyping;
    state.socket.emit('chat:typing', { isTyping });
  }

  function sendTextMessage() {
    if (!state.socket || !state.currentRoom) return;
    const text = el.msgInput.value.trim();
    if (!text) return;

    const replyTo = state.replyTo ? { ...state.replyTo } : null;
    el.msgInput.value = '';
    autoResizeTextarea();
    emitTyping(false);
    setReply(null);

    state.socket.emit('chat:send', { text, replyTo }, (ack) => {
      if (ack && !ack.ok) {
        alert(ack.error || '메시지 전송 실패');
      }
    });
  }

  async function uploadAndSendFile(file) {
    if (!file || !state.currentRoom || state.uploading) return;
    state.uploading = true;
    el.uploadBar.hidden = false;
    el.uploadText.textContent = `${file.name} 업로드 중...`;

    try {
      const form = new FormData();
      form.append('file', file);
      const resp = await fetch('/api/upload', {
        method: 'POST',
        body: form,
      });
      const data = await resp.json();
      if (!resp.ok) {
        alert(data.error || '파일 업로드 실패 (최대 15MB)');
        return;
      }

      const text = el.msgInput.value.trim();
      const replyTo = state.replyTo ? { ...state.replyTo } : null;
      if (text) {
        el.msgInput.value = '';
        autoResizeTextarea();
      }
      setReply(null);

      state.socket.emit(
        'chat:send',
        {
          text,
          replyTo,
          attachment: data,
        },
        (ack) => {
          if (ack && !ack.ok) {
            alert(ack.error || '파일 전송 실패');
          }
        }
      );
    } catch {
      alert('파일 업로드 중 오류가 발생했습니다.');
    } finally {
      state.uploading = false;
      el.uploadBar.hidden = true;
      el.fileInput.value = '';
    }
  }

  function autoResizeTextarea() {
    el.msgInput.style.height = 'auto';
    el.msgInput.style.height = `${Math.min(el.msgInput.scrollHeight, 140)}px`;
  }

  // --- ONEID PKCE ---
  function base64UrlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function randomString(len = 48) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return base64UrlEncode(arr);
  }

  async function sha256Base64Url(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return base64UrlEncode(new Uint8Array(buf));
  }

  async function startOneidLogin() {
    const verifier = randomString(48);
    const challenge = await sha256Base64Url(verifier);
    const oauthState = randomString(24);
    sessionStorage.setItem(STORAGE_KEYS.pkceVerifier, verifier);
    sessionStorage.setItem(STORAGE_KEYS.pkceState, oauthState);

    const redirectUri = `${window.location.origin}/`;
    const authUrl = new URL(`${state.config.oneidUrl}/login.html`);
    authUrl.searchParams.set('client_id', state.config.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('state', oauthState);
    window.location.assign(authUrl.toString());
  }

  function logoutOneid() {
    state.token = '';
    state.user = null;
    state.serverRooms = [];
    localStorage.removeItem(STORAGE_KEYS.oneidToken);
    localStorage.removeItem(STORAGE_KEYS.oneidUser);
    renderAuthUI();
    renderRoomsList();
  }

  async function handleOneidCallback() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!code) return;

    const savedState = sessionStorage.getItem(STORAGE_KEYS.pkceState);
    const verifier = sessionStorage.getItem(STORAGE_KEYS.pkceVerifier);
    sessionStorage.removeItem(STORAGE_KEYS.pkceState);
    sessionStorage.removeItem(STORAGE_KEYS.pkceVerifier);

    url.searchParams.delete('code');
    url.searchParams.delete('state');
    window.history.replaceState({}, '', url.toString());

    if (!verifier || (savedState && returnedState !== savedState)) {
      return;
    }

    try {
      const tokenRes = await fetch(`${state.config.oneidUrl}/api/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: state.config.clientId,
          code,
          redirect_uri: `${window.location.origin}/`,
          code_verifier: verifier,
        }),
      });
      if (!tokenRes.ok) return;
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) return;

      let userData = tokenData.user || null;
      if (!userData) {
        const userRes = await fetch(`${state.config.oneidUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (!userRes.ok) return;
        userData = await userRes.json();
      }

      state.token = tokenData.access_token;
      state.user = userData;
      localStorage.setItem(STORAGE_KEYS.oneidToken, state.token);
      localStorage.setItem(STORAGE_KEYS.oneidUser, JSON.stringify(state.user));
      renderAuthUI();
      await fetchServerRooms();
    } catch {
      // Ignore OAuth network errors
    }
  }

  async function loadConfig() {
    try {
      const resp = await fetch('/api/config');
      if (resp.ok) {
        const cfg = await resp.json();
        if (cfg.oneidUrl) state.config.oneidUrl = cfg.oneidUrl;
        if (cfg.clientId) state.config.clientId = cfg.clientId;
      }
    } catch {
      // Use defaults
    }
  }

  function bindEvents() {
    el.themeToggleBtn.addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem(STORAGE_KEYS.theme, state.theme);
      applyTheme();
    });

    el.soundToggleBtn.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      localStorage.setItem(STORAGE_KEYS.sound, String(state.soundEnabled));
      applySoundUI();
    });

    el.oneidAuthBtn.addEventListener('click', () => {
      if (state.token && state.user) {
        logoutOneid();
      } else {
        startOneidLogin();
      }
    });

    el.openCreateModalBtn.addEventListener('click', () => openModal('create'));
    el.welcomeCreateBtn.addEventListener('click', () => openModal('create'));
    el.openJoinModalBtn.addEventListener('click', () => openModal('join'));
    el.welcomeJoinBtn.addEventListener('click', () => openModal('join'));
    el.modalCloseBtn.addEventListener('click', closeModal);
    el.roomModal.addEventListener('click', (e) => {
      if (e.target === el.roomModal) closeModal();
    });
    el.roomForm.addEventListener('submit', handleModalSubmit);

    el.mobileBackBtn.addEventListener('click', () => {
      document.body.classList.remove('mobile-in-chat');
    });

    el.copyInviteBtn.addEventListener('click', async () => {
      if (!state.currentRoom) return;
      const inviteUrl = `${window.location.origin}/?room=${encodeURIComponent(state.currentRoom.roomId)}`;
      try {
        await navigator.clipboard.writeText(inviteUrl);
        const prev = el.copyInviteBtn.textContent;
        el.copyInviteBtn.textContent = '복사됨 ✓';
        setTimeout(() => {
          el.copyInviteBtn.textContent = prev;
        }, 1500);
      } catch {
        prompt('초대 링크를 복사하세요:', inviteUrl);
      }
    });

    el.replyCancelBtn.addEventListener('click', () => setReply(null));

    el.composerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendTextMessage();
    });

    el.msgInput.addEventListener('input', () => {
      autoResizeTextarea();
      emitTyping(el.msgInput.value.trim().length > 0);
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(() => emitTyping(false), 1600);
    });

    el.msgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendTextMessage();
      }
    });

    el.msgInput.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            uploadAndSendFile(file);
            return;
          }
        }
      }
    });

    el.attachBtn.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => {
      const file = el.fileInput.files?.[0];
      if (file) uploadAndSendFile(file);
    });

    el.chatActive.addEventListener('dragenter', (e) => {
      if (!state.currentRoom) return;
      e.preventDefault();
      state.dragDepth += 1;
      el.dropOverlay.hidden = false;
    });

    el.chatActive.addEventListener('dragover', (e) => {
      if (!state.currentRoom) return;
      e.preventDefault();
    });

    el.chatActive.addEventListener('dragleave', (e) => {
      if (!state.currentRoom) return;
      e.preventDefault();
      state.dragDepth = Math.max(0, state.dragDepth - 1);
      if (state.dragDepth === 0) el.dropOverlay.hidden = true;
    });

    el.chatActive.addEventListener('drop', (e) => {
      if (!state.currentRoom) return;
      e.preventDefault();
      state.dragDepth = 0;
      el.dropOverlay.hidden = true;
      const file = e.dataTransfer?.files?.[0];
      if (file) uploadAndSendFile(file);
    });

    el.lightboxClose.addEventListener('click', closeLightbox);
    el.lightbox.addEventListener('click', (e) => {
      if (e.target === el.lightbox) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!el.lightbox.hidden) closeLightbox();
        else if (!el.roomModal.hidden) closeModal();
      }
    });
  }

  async function init() {
    applyTheme();
    applySoundUI();
    renderAuthUI();
    renderRoomsList();
    bindEvents();

    await loadConfig();
    await handleOneidCallback();
    if (state.token && state.user) {
      ensureSocket();
      await fetchServerRooms();
    }

    const params = new URLSearchParams(window.location.search);
    const inviteRoom = params.get('room');
    if (inviteRoom) {
      openModal('join', { roomId: inviteRoom.trim() });
    }
  }

  init();
})();
