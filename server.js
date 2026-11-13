import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { Server as SocketIOServer } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 5700);
const ONEID_URL = (process.env.ONEID_URL || 'https://oneid-ruddy.vercel.app').replace(/\/+$/, '');
const ONEID_CLIENT_ID = process.env.ONEID_CLIENT_ID || 'dispatch';
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
const MAX_MESSAGES_PER_ROOM = 200;

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  maxHttpBufferSize: 20 * 1024 * 1024,
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// In-memory room store: roomId -> { id, title, passwordHash, ownerId, messages: [], members: Map<socketId, member> }
const rooms = new Map();

function normalizeRoomId(raw = '') {
  return String(raw).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
}

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
}

function hashPassword(pw = '') {
  if (!pw) return null;
  return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

function getOrCreateRoom(roomId, opts = {}) {
  const id = normalizeRoomId(roomId);
  if (!id) return null;
  if (!rooms.has(id)) {
    rooms.set(id, {
      id,
      title: String(opts.title || `방 #${id}`).trim().slice(0, 40) || `방 #${id}`,
      passwordHash: opts.password ? hashPassword(opts.password) : null,
      ownerId: opts.ownerId || null,
      createdAt: Date.now(),
      messages: [],
      members: new Map(),
    });
  }
  return rooms.get(id);
}

async function verifyOneIdToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${ONEID_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return {
      userId: user.user_id || user.id || user.username,
      nickname: user.nickname || user.username,
      verified: true,
    };
  } catch {
    return null;
  }
}

// Multer storage for file transfers
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES },
});

// Cleanup uploads older than 24h periodically
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err || !files) return;
    for (const f of files) {
      const p = path.join(UPLOAD_DIR, f);
      fs.stat(p, (e, st) => {
        if (!e && st.mtimeMs < cutoff) {
          fs.unlink(p, () => {});
        }
      });
    }
  });
}, 60 * 60 * 1000).unref();

app.get('/api/health', (_, res) => {
  res.json({ ok: true, service: 'dispatch', rooms: rooms.size });
});

app.get('/api/config', (_, res) => {
  res.json({ oneidUrl: ONEID_URL, clientId: ONEID_CLIENT_ID });
});

app.post('/api/rooms', async (req, res) => {
  const { title, roomId, password, token } = req.body || {};
  let id = normalizeRoomId(roomId);
  if (!id) {
    do {
      id = generateRoomId();
    } while (rooms.has(id));
  } else if (rooms.has(id)) {
    return res.status(409).json({ error: '이미 사용 중인 방 ID입니다.' });
  }

  const verifiedUser = await verifyOneIdToken(token);
  const room = getOrCreateRoom(id, {
    title: title || `방 #${id}`,
    password: password ? String(password) : '',
    ownerId: verifiedUser?.userId || null,
  });

  res.status(201).json({
    roomId: room.id,
    title: room.title,
    hasPassword: Boolean(room.passwordHash),
  });
});

app.get('/api/rooms/:roomId/info', (req, res) => {
  const id = normalizeRoomId(req.params.roomId);
  const room = rooms.get(id);
  if (!room) {
    return res.json({ exists: false, roomId: id, hasPassword: false, memberCount: 0 });
  }
  return res.json({
    exists: true,
    roomId: room.id,
    title: room.title,
    hasPassword: Boolean(room.passwordHash),
    memberCount: room.members.size,
  });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '파일이 첨부되지 않았습니다.' });
  }
  // Fix UTF-8 filename encoding from multipart headers
  let originalName = req.file.originalname || 'file';
  try {
    const decoded = Buffer.from(originalName, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) originalName = decoded;
  } catch {
    // keep original
  }

  const mimeType = req.file.mimetype || 'application/octet-stream';
  const isImage = mimeType.startsWith('image/');
  res.json({
    storedName: req.file.filename,
    url: `/api/files/${encodeURIComponent(req.file.filename)}?name=${encodeURIComponent(originalName)}`,
    name: originalName,
    size: req.file.size,
    mimeType,
    isImage,
  });
});

app.get('/api/files/:storedName', (req, res) => {
  const safeName = path.basename(String(req.params.storedName || ''));
  const filePath = path.join(UPLOAD_DIR, safeName);
  if (!filePath.startsWith(UPLOAD_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).send('File not found');
  }
  const downloadName = String(req.query.name || safeName);
  const ext = path.extname(safeName).toLowerCase();
  const inlineExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf']);
  if (req.query.dl === '1' || !inlineExts.has(ext)) {
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  } else {
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  }
  res.sendFile(filePath);
});

app.use((err, _, res, __) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: '파일 크기는 최대 15MB까지 전송할 수 있습니다.' });
  }
  return res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

function broadcastMembers(room) {
  const list = Array.from(room.members.values()).map((m) => ({
    socketId: m.socketId,
    nickname: m.nickname,
    verified: m.verified,
    userId: m.userId,
  }));
  io.to(room.id).emit('room:members', { roomId: room.id, members: list });
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentMember = null;

  socket.on('room:join', async (payload = {}, ack) => {
    const roomId = normalizeRoomId(payload.roomId);
    if (!roomId) {
      return ack?.({ ok: false, error: '올바른 방 ID를 입력해 주세요.' });
    }

    const room = getOrCreateRoom(roomId, { title: payload.title });
    if (room.passwordHash && hashPassword(payload.password || '') !== room.passwordHash) {
      return ack?.({ ok: false, error: '방 비밀번호가 올바르지 않습니다.', needPassword: true });
    }

    const verifiedUser = await verifyOneIdToken(payload.token);
    const nickname = verifiedUser?.nickname || String(payload.nickname || '').trim().slice(0, 20) || `익명-${socket.id.slice(0, 4)}`;

    if (currentRoomId && rooms.has(currentRoomId)) {
      const prev = rooms.get(currentRoomId);
      prev.members.delete(socket.id);
      socket.leave(currentRoomId);
      broadcastMembers(prev);
    }

    currentRoomId = room.id;
    currentMember = {
      socketId: socket.id,
      nickname,
      verified: Boolean(verifiedUser),
      userId: verifiedUser?.userId || null,
    };

    room.members.set(socket.id, currentMember);
    socket.join(room.id);

    ack?.({
      ok: true,
      room: {
        roomId: room.id,
        title: room.title,
        hasPassword: Boolean(room.passwordHash),
        isOwner: Boolean(room.ownerId && currentMember.userId && room.ownerId === currentMember.userId),
        messages: room.messages,
      },
      me: currentMember,
    });

    broadcastMembers(room);
  });

  socket.on('chat:send', (payload = {}, ack) => {
    if (!currentRoomId || !currentMember) {
      return ack?.({ ok: false, error: '먼저 대화방에 입장해 주세요.' });
    }
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const text = String(payload.text || '').trim().slice(0, 4000);
    const attachment = payload.attachment || null;
    if (!text && !attachment) return;

    const msg = {
      id: crypto.randomUUID(),
      roomId: room.id,
      sender: {
        socketId: currentMember.socketId,
        nickname: currentMember.nickname,
        verified: currentMember.verified,
        userId: currentMember.userId,
      },
      text,
      replyTo: payload.replyTo || null,
      attachment,
      createdAt: Date.now(),
    };

    room.messages.push(msg);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.shift();
    }

    io.to(room.id).emit('chat:message', msg);
    ack?.({ ok: true, id: msg.id });
  });

  socket.on('chat:typing', (payload = {}) => {
    if (!currentRoomId || !currentMember) return;
    socket.to(currentRoomId).emit('chat:typing', {
      socketId: socket.id,
      nickname: currentMember.nickname,
      isTyping: Boolean(payload.isTyping),
    });
  });

  socket.on('chat:delete', (payload = {}) => {
    if (!currentRoomId || !currentMember) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;
    const idx = room.messages.findIndex((m) => m.id === payload.messageId);
    if (idx === -1) return;

    const target = room.messages[idx];
    const isSender = target.sender.socketId === socket.id || (currentMember.userId && target.sender.userId === currentMember.userId);
    const isOwner = Boolean(room.ownerId && currentMember.userId && room.ownerId === currentMember.userId);
    if (!isSender && !isOwner) return;

    room.messages.splice(idx, 1);
    io.to(room.id).emit('chat:deleted', { messageId: target.id });
  });

  socket.on('disconnect', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      room.members.delete(socket.id);
      socket.to(currentRoomId).emit('chat:typing', {
        socketId: socket.id,
        nickname: currentMember?.nickname,
        isTyping: false,
      });
      broadcastMembers(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`DISPATCH running on http://localhost:${PORT}`);
});
