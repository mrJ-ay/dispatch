import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import pg from 'pg';
import { Server as SocketIOServer } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 5700);
const DATABASE_URL = process.env.DATABASE_URL || '';
const ONEID_URL = (process.env.ONEID_URL || 'https://oneid-ruddy.vercel.app').replace(/\/+$/, '');
const ONEID_CLIENT_ID = process.env.ONEID_CLIENT_ID || 'dispatch';
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
const MAX_MESSAGES_PER_ROOM = 200;

const pool = DATABASE_URL
  ? new pg.Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  maxHttpBufferSize: 20 * 1024 * 1024,
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Room store: roomId -> { id, title, passwordHash, ownerId, messages: [], members: Map<socketId, member> }
const rooms = new Map();
// userId -> { userId, username, nickname, avatarUrl, avatarColor, statusMsg }
const userProfiles = new Map();
// userId -> Array<{ id, nickname, addedAt }>
const userFriends = new Map();
// userId -> Set<socketId>
const onlineUsers = new Map();

let saveTimer = null;
function scheduleSaveStore() {
  if (pool || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const serialized = {
        rooms: Array.from(rooms.values()).map((r) => ({
          id: r.id,
          title: r.title,
          passwordHash: r.passwordHash || null,
          ownerId: r.ownerId || null,
          createdAt: r.createdAt || Date.now(),
          messages: Array.isArray(r.messages) ? r.messages.slice(-MAX_MESSAGES_PER_ROOM) : [],
        })),
        profiles: Array.from(userProfiles.entries()),
        friends: Array.from(userFriends.entries()),
      };
      await fs.promises.writeFile(STORE_FILE, JSON.stringify(serialized), 'utf8');
    } catch (err) {
      console.warn('Failed to persist store.json:', err?.message || err);
    }
  }, 500);
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.rooms)) {
      for (const r of data.rooms) {
        if (!r?.id) continue;
        rooms.set(r.id, {
          id: r.id,
          title: r.title || `방 #${r.id}`,
          passwordHash: r.passwordHash || null,
          ownerId: r.ownerId || null,
          createdAt: r.createdAt || Date.now(),
          messages: Array.isArray(r.messages) ? r.messages.slice(-MAX_MESSAGES_PER_ROOM) : [],
          members: new Map(),
        });
      }
    }
    if (Array.isArray(data.profiles)) {
      for (const [k, v] of data.profiles) {
        if (k && v) userProfiles.set(k, v);
      }
    }
    if (Array.isArray(data.friends)) {
      for (const [k, v] of data.friends) {
        if (k && Array.isArray(v)) userFriends.set(k, v);
      }
    }
  } catch (err) {
    console.warn('Failed to load store.json:', err?.message || err);
  }
}

async function initDb() {
  if (!pool) {
    loadStore();
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dispatch_rooms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        password_hash TEXT,
        owner_id TEXT,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatch_messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL REFERENCES dispatch_rooms(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        sender JSONB,
        text TEXT,
        reply_to JSONB,
        attachment JSONB,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_messages_room_created
        ON dispatch_messages(room_id, created_at);
      CREATE TABLE IF NOT EXISTS dispatch_profiles (
        user_id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatch_friends (
        user_id TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );
    `);

    const roomRows = await pool.query('SELECT id, title, password_hash, owner_id, created_at FROM dispatch_rooms');
    for (const r of roomRows.rows) {
      rooms.set(r.id, {
        id: r.id,
        title: r.title,
        passwordHash: r.password_hash || null,
        ownerId: r.owner_id || null,
        createdAt: Number(r.created_at) || Date.now(),
        messages: [],
        members: new Map(),
      });
    }

    const msgRows = await pool.query(`
      SELECT id, room_id, type, sender, text, reply_to, attachment, created_at
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY created_at DESC) AS rn
        FROM dispatch_messages
      ) sub
      WHERE rn <= $1
      ORDER BY created_at ASC
    `, [MAX_MESSAGES_PER_ROOM]);

    for (const m of msgRows.rows) {
      const room = rooms.get(m.room_id);
      if (!room) continue;
      room.messages.push({
        id: m.id,
        type: m.type,
        sender: m.sender || {},
        text: m.text || '',
        replyTo: m.reply_to || null,
        attachment: m.attachment || null,
        createdAt: Number(m.created_at) || Date.now(),
      });
    }

    const profRows = await pool.query('SELECT user_id, data FROM dispatch_profiles');
    for (const p of profRows.rows) {
      if (p.user_id && p.data) userProfiles.set(p.user_id, p.data);
    }

    const friendRows = await pool.query('SELECT user_id, data FROM dispatch_friends');
    for (const f of friendRows.rows) {
      if (f.user_id && Array.isArray(f.data)) userFriends.set(f.user_id, f.data);
    }

    console.log(`Loaded ${rooms.size} rooms from Neon PostgreSQL`);
  } catch (err) {
    console.error('Failed to initialize Neon PostgreSQL:', err);
  }
}

function dbUpsertRoom(room) {
  if (!pool || !room) return;
  pool.query(
    `INSERT INTO dispatch_rooms (id, title, password_hash, owner_id, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, password_hash = EXCLUDED.password_hash, owner_id = EXCLUDED.owner_id`,
    [room.id, room.title, room.passwordHash || null, room.ownerId || null, room.createdAt || Date.now()]
  ).catch((err) => console.warn('dbUpsertRoom error:', err?.message || err));
}

function dbInsertMessage(roomId, msg) {
  if (!pool || !roomId || !msg) return;
  pool.query(
    `INSERT INTO dispatch_messages (id, room_id, type, sender, text, reply_to, attachment, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8)
     ON CONFLICT (id) DO NOTHING`,
    [
      msg.id,
      roomId,
      msg.type || 'text',
      JSON.stringify(msg.sender || {}),
      msg.text || '',
      msg.replyTo ? JSON.stringify(msg.replyTo) : null,
      msg.attachment ? JSON.stringify(msg.attachment) : null,
      msg.createdAt || Date.now(),
    ]
  ).catch((err) => console.warn('dbInsertMessage error:', err?.message || err));
}

function dbDeleteMessage(messageId) {
  if (!pool || !messageId) return;
  pool.query('DELETE FROM dispatch_messages WHERE id = $1', [messageId])
    .catch((err) => console.warn('dbDeleteMessage error:', err?.message || err));
}

function dbUpsertProfile(userId, profile) {
  if (!pool || !userId || !profile) return;
  pool.query(
    `INSERT INTO dispatch_profiles (user_id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data`,
    [userId, JSON.stringify(profile)]
  ).catch((err) => console.warn('dbUpsertProfile error:', err?.message || err));
}

function dbUpsertFriends(userId, friends) {
  if (!pool || !userId) return;
  pool.query(
    `INSERT INTO dispatch_friends (user_id, data) VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data`,
    [userId, JSON.stringify(friends || [])]
  ).catch((err) => console.warn('dbUpsertFriends error:', err?.message || err));
}

function extractBearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

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
    dbUpsertRoom(rooms.get(id));
    scheduleSaveStore();
  }
  return rooms.get(id);
}

async function verifyOneIdToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${ONEID_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const user = await res.json();
    return {
      userId: user.user_id || user.id || user.username,
      username: user.username || '',
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

app.get('/api/rooms', async (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const verifiedUser = await verifyOneIdToken(token);
  if (!verifiedUser) {
    return res.json({ ok: true, authed: false, rooms: [] });
  }
  const list = Array.from(rooms.values())
    .map((r) => ({
      roomId: r.id,
      title: r.title,
      hasPassword: Boolean(r.passwordHash),
      memberCount: r.members.size,
      createdAt: r.createdAt,
    }))
    .sort((a, b) => b.memberCount - a.memberCount || b.createdAt - a.createdAt);
  return res.json({ ok: true, authed: true, rooms: list });
});

app.post('/api/profile', async (req, res) => {
  const verifiedUser = await verifyOneIdToken(extractBearer(req));
  if (!verifiedUser) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  const { avatarUrl = '', avatarColor = '', statusMsg = '' } = req.body || {};
  const prev = userProfiles.get(verifiedUser.userId) || {};
  const updated = {
    userId: verifiedUser.userId,
    username: verifiedUser.username,
    nickname: verifiedUser.nickname,
    avatarUrl: String(avatarUrl || '').slice(0, 500),
    avatarColor: String(avatarColor || prev.avatarColor || '').slice(0, 32),
    statusMsg: String(statusMsg || '').trim().slice(0, 60),
  };
  userProfiles.set(verifiedUser.userId, updated);
  dbUpsertProfile(verifiedUser.userId, updated);
  scheduleSaveStore();
  return res.json({ ok: true, profile: updated });
});

app.get('/api/friends', async (req, res) => {
  const verifiedUser = await verifyOneIdToken(extractBearer(req));
  if (!verifiedUser) {
    return res.json({ ok: true, authed: false, friends: [] });
  }
  const raw = userFriends.get(verifiedUser.userId) || [];
  const enriched = raw.map((f) => {
    const prof = userProfiles.get(f.id);
    const isOnline = (onlineUsers.get(f.id)?.size || 0) > 0;
    return {
      id: f.id,
      nickname: prof?.nickname || f.nickname,
      avatarUrl: prof?.avatarUrl || '',
      avatarColor: prof?.avatarColor || '',
      statusMsg: prof?.statusMsg || '',
      online: isOnline,
      addedAt: f.addedAt,
    };
  });
  return res.json({ ok: true, authed: true, friends: enriched });
});

app.post('/api/friends', async (req, res) => {
  const verifiedUser = await verifyOneIdToken(extractBearer(req));
  if (!verifiedUser) {
    return res.status(401).json({ error: '친구 기능은 ONEID 로그인 후 이용할 수 있습니다.' });
  }
  const target = String(req.body?.target || '').trim().slice(0, 40);
  if (!target) {
    return res.status(400).json({ error: '친구의 아이디 또는 닉네임을 입력하세요.' });
  }

  let matchedProfile = null;
  for (const prof of userProfiles.values()) {
    if (
      prof.userId === target ||
      (prof.username && prof.username.toLowerCase() === target.toLowerCase()) ||
      (prof.nickname && prof.nickname.toLowerCase() === target.toLowerCase())
    ) {
      matchedProfile = prof;
      break;
    }
  }

  const friendId = matchedProfile ? matchedProfile.userId : target;
  const friendNick = matchedProfile ? matchedProfile.nickname : target;
  if (friendId === verifiedUser.userId) {
    return res.status(400).json({ error: '자기 자신은 친구로 추가할 수 없습니다.' });
  }

  const list = userFriends.get(verifiedUser.userId) || [];
  if (!list.some((f) => f.id === friendId || f.nickname.toLowerCase() === friendNick.toLowerCase())) {
    list.unshift({ id: friendId, nickname: friendNick, addedAt: Date.now() });
    userFriends.set(verifiedUser.userId, list);
    dbUpsertFriends(verifiedUser.userId, list);
    scheduleSaveStore();
  }
  return res.status(201).json({ ok: true, friend: { id: friendId, nickname: friendNick } });
});

app.delete('/api/friends/:id', async (req, res) => {
  const verifiedUser = await verifyOneIdToken(extractBearer(req));
  if (!verifiedUser) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  const targetId = decodeURIComponent(String(req.params.id || ''));
  const list = (userFriends.get(verifiedUser.userId) || []).filter((f) => f.id !== targetId);
  userFriends.set(verifiedUser.userId, list);
  dbUpsertFriends(verifiedUser.userId, list);
  scheduleSaveStore();
  return res.json({ ok: true });
});

app.post('/api/dm', async (req, res) => {
  const verifiedUser = await verifyOneIdToken(extractBearer(req));
  if (!verifiedUser) {
    return res.status(401).json({ error: '1:1 대화는 ONEID 로그인 후 이용할 수 있습니다.' });
  }
  const friendId = String(req.body?.friendId || '').trim();
  const friendName = String(req.body?.friendName || friendId).trim().slice(0, 20);
  if (!friendId) {
    return res.status(400).json({ error: '대화할 친구를 선택하세요.' });
  }
  const pairHash = crypto
    .createHash('sha1')
    .update([verifiedUser.userId, friendId].sort().join('::'))
    .digest('hex')
    .slice(0, 10)
    .toUpperCase();
  const dmRoomId = `DM_${pairHash}`;
  const room = getOrCreateRoom(dmRoomId, {
    title: `${verifiedUser.nickname} · ${friendName}`,
    ownerId: verifiedUser.userId,
  });
  return res.json({ ok: true, roomId: room.id, title: room.title });
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
    avatarUrl: m.avatarUrl || '',
    avatarColor: m.avatarColor || '',
    statusMsg: m.statusMsg || '',
  }));
  io.to(room.id).emit('room:members', { roomId: room.id, members: list });
  io.emit('rooms:updated');
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentMember = null;
  let connectedUserId = null;

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

    let savedProf = null;
    if (verifiedUser) {
      connectedUserId = verifiedUser.userId;
      if (!onlineUsers.has(verifiedUser.userId)) onlineUsers.set(verifiedUser.userId, new Set());
      onlineUsers.get(verifiedUser.userId).add(socket.id);

      const prevProf = userProfiles.get(verifiedUser.userId) || {};
      savedProf = {
        userId: verifiedUser.userId,
        username: verifiedUser.username,
        nickname: verifiedUser.nickname,
        avatarUrl: String(payload.avatarUrl ?? prevProf.avatarUrl ?? '').slice(0, 500),
        avatarColor: String(payload.avatarColor ?? prevProf.avatarColor ?? '').slice(0, 32),
        statusMsg: String(payload.statusMsg ?? prevProf.statusMsg ?? '').trim().slice(0, 60),
      };
      userProfiles.set(verifiedUser.userId, savedProf);
    }

    if (currentRoomId && rooms.has(currentRoomId)) {
      const prev = rooms.get(currentRoomId);
      prev.members.delete(socket.id);
      socket.leave(currentRoomId);
      broadcastMembers(prev);
    }

    currentRoomId = room.id;
    const clientId = String(payload.clientId || '').trim().slice(0, 64) || null;
    currentMember = {
      socketId: socket.id,
      clientId,
      nickname,
      verified: Boolean(verifiedUser),
      userId: verifiedUser?.userId || null,
      avatarUrl: savedProf ? savedProf.avatarUrl : String(payload.avatarUrl || '').slice(0, 500),
      avatarColor: savedProf ? savedProf.avatarColor : String(payload.avatarColor || '').slice(0, 32),
      statusMsg: savedProf ? savedProf.statusMsg : String(payload.statusMsg || '').trim().slice(0, 60),
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
    socket.emit('call:status', getCallStatus(room.id));
  });

  socket.on('profile:update', (payload = {}, ack) => {
    if (!currentMember) {
      return ack?.({ ok: false });
    }
    if (!currentMember.verified && payload.nickname) {
      const clean = String(payload.nickname).trim().slice(0, 20);
      if (clean) currentMember.nickname = clean;
    }
    if (typeof payload.avatarUrl === 'string') {
      currentMember.avatarUrl = payload.avatarUrl.slice(0, 500);
    }
    if (typeof payload.avatarColor === 'string') {
      currentMember.avatarColor = payload.avatarColor.slice(0, 32);
    }
    if (typeof payload.statusMsg === 'string') {
      currentMember.statusMsg = payload.statusMsg.trim().slice(0, 60);
    }
    if (currentMember.userId) {
      const prev = userProfiles.get(currentMember.userId) || {};
      userProfiles.set(currentMember.userId, {
        ...prev,
        userId: currentMember.userId,
        nickname: currentMember.nickname,
        avatarUrl: currentMember.avatarUrl,
        avatarColor: currentMember.avatarColor,
        statusMsg: currentMember.statusMsg,
      });
    }
    if (currentRoomId && rooms.has(currentRoomId)) {
      broadcastMembers(rooms.get(currentRoomId));
    }
    ack?.({ ok: true, me: currentMember });
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
        clientId: currentMember.clientId || null,
        nickname: currentMember.nickname,
        verified: currentMember.verified,
        userId: currentMember.userId,
        avatarUrl: currentMember.avatarUrl || '',
        avatarColor: currentMember.avatarColor || '',
        statusMsg: currentMember.statusMsg || '',
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
    dbInsertMessage(room.id, msg);
    scheduleSaveStore();

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
    const isSender =
      target.sender.socketId === socket.id ||
      (currentMember.clientId && target.sender.clientId === currentMember.clientId) ||
      (currentMember.userId && target.sender.userId === currentMember.userId);
    const isOwner = Boolean(room.ownerId && currentMember.userId && room.ownerId === currentMember.userId);
    if (!isSender && !isOwner) return;

    room.messages.splice(idx, 1);
    dbDeleteMessage(target.id);
    scheduleSaveStore();
    io.to(room.id).emit('chat:deleted', { messageId: target.id });
  });

  socket.on('disconnect', () => {
    if (connectedUserId && onlineUsers.has(connectedUserId)) {
      const set = onlineUsers.get(connectedUserId);
      set.delete(socket.id);
      if (set.size === 0) onlineUsers.delete(connectedUserId);
    }
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

// =========================================================
// WebRTC Signaling Namespace (/call) for DISPATCH Call
// =========================================================
const callRooms = new Map(); // roomId -> Map<socketId, { socketId, nickname, micEnabled, camEnabled }>
const callNs = io.of('/call');

function getCallStatus(roomId) {
  const members = callRooms.get(roomId);
  const participants = members
    ? Array.from(members.values()).map((m) => ({
        socketId: m.socketId,
        nickname: m.nickname,
        micEnabled: m.micEnabled,
        camEnabled: m.camEnabled,
      }))
    : [];
  return {
    roomId,
    activeCount: participants.length,
    participants,
  };
}

function broadcastCallStatus(roomId) {
  if (!roomId) return;
  io.to(roomId).emit('call:status', getCallStatus(roomId));
}

callNs.on('connection', (socket) => {
  let joinedRoom = null;

  function leaveCurrentRoom() {
    if (!joinedRoom || !callRooms.has(joinedRoom)) return;
    const roomId = joinedRoom;
    const members = callRooms.get(roomId);
    members.delete(socket.id);
    socket.to(roomId).emit('call:peer-left', { socketId: socket.id });
    socket.leave(roomId);
    if (members.size === 0) callRooms.delete(roomId);
    joinedRoom = null;
    broadcastCallStatus(roomId);
  }

  socket.on('call:join', (payload = {}) => {
    const roomId = normalizeRoomId(payload.roomId || '');
    if (!roomId) return;
    leaveCurrentRoom();

    const nickname = String(payload.nickname || '익명').trim().slice(0, 24) || '익명';
    const micEnabled = payload.micEnabled !== false;
    const camEnabled = Boolean(payload.camEnabled);

    if (!callRooms.has(roomId)) callRooms.set(roomId, new Map());
    const members = callRooms.get(roomId);
    const existingPeers = Array.from(members.values());

    const selfInfo = { socketId: socket.id, nickname, micEnabled, camEnabled };
    members.set(socket.id, selfInfo);
    joinedRoom = roomId;
    socket.join(roomId);

    socket.emit('call:peers', { roomId, peers: existingPeers });
    socket.to(roomId).emit('call:peer-joined', selfInfo);
    broadcastCallStatus(roomId);
  });

  socket.on('call:signal', (payload = {}) => {
    const to = String(payload.to || '');
    if (!to || !payload.data) return;
    callNs.to(to).emit('call:signal', {
      from: socket.id,
      data: payload.data,
    });
  });

  socket.on('call:media-state', (payload = {}) => {
    if (!joinedRoom || !callRooms.has(joinedRoom)) return;
    const info = callRooms.get(joinedRoom).get(socket.id);
    if (!info) return;
    if (typeof payload.micEnabled === 'boolean') info.micEnabled = payload.micEnabled;
    if (typeof payload.camEnabled === 'boolean') info.camEnabled = payload.camEnabled;
    socket.to(joinedRoom).emit('call:media-state', {
      socketId: socket.id,
      micEnabled: info.micEnabled,
      camEnabled: info.camEnabled,
    });
  });

  socket.on('call:relay-audio', (payload = {}) => {
    if (!joinedRoom || !payload.pcm) return;
    socket.to(joinedRoom).emit('call:relay-audio', {
      from: socket.id,
      pcm: payload.pcm,
      sampleRate: Number(payload.sampleRate) || 16000,
    });
  });

  socket.on('call:leave', () => {
    leaveCurrentRoom();
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom();
  });
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`DISPATCH running on http://localhost:${PORT}`);
  });
});
