const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    pingTimeout: 600000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e8,
    transports: ['websocket', 'polling']
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');
const { computeCheck } = require('telegram/Password');

const TG_API_ID = 38231139;
const TG_API_HASH = '8c6f63a727badd926100bdf80b0566fc';

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const clients = {};
const allJobs = {};
const msgCache = {};
const reconnectTimers = {};

function getClient(sessionId) {
    if (!clients[sessionId]) {
        clients[sessionId] = {
            waSocket: null, waConnected: false, waAuthState: null,
            waNeedsPairing: false, waPairingCode: null, waStarting: false,
            tgClient: null, tgConnected: false,
            pendingTG: {}, activeJobs: {}, socketIds: new Set(),
            contactNames: {}
        };
    }
    return clients[sessionId];
}
function getSessionDir(sessionId) {
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const dir = path.join(SESSIONS_DIR, safe);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function broadcastJobs() { io.emit('jobs-update', Object.values(allJobs)); }
function emitToSession(sessionId, event, data) {
    const c = clients[sessionId]; if (!c) return;
    for (const sid of c.socketIds) io.to(sid).emit(event, data);
}

function extractText(m) {
    if (!m?.message) return '[media]';
    const msg = m.message;
    return msg.conversation
        || msg.extendedTextMessage?.text
        || msg.imageMessage?.caption
        || msg.videoMessage?.caption
        || (msg.imageMessage ? '[صورة]' : null)
        || (msg.videoMessage ? '[فيديو]' : null)
        || (msg.audioMessage ? '[صوت]' : null)
        || (msg.documentMessage ? '[ملف]' : null)
        || (msg.stickerMessage ? '[ملصق]' : null)
        || '[رسالة]';
}

function formatMsg(m, sessionId) {
    const client = clients[sessionId];
    const fromJid = m.key?.participant || m.key?.remoteJid || '';
    let pushName = m.pushName || '';
    if (!pushName && fromJid && client?.contactNames?.[fromJid]) {
        pushName = client.contactNames[fromJid];
    }
    return {
        id: m.key?.id || ('msg_' + Date.now() + Math.random()),
        from: fromJid.split('@')[0],
        fromMe: !!m.key?.fromMe,
        text: extractText(m),
        time: Number(m.messageTimestamp) || 0,
        pushName: pushName || ''
    };
}

function addMsgToCache(sessionId, jid, msgObj) {
    if (!msgCache[sessionId]) msgCache[sessionId] = {};
    if (!msgCache[sessionId][jid]) msgCache[sessionId][jid] = [];
    if (msgCache[sessionId][jid].find(x => x.id === msgObj.id)) return false;
    msgCache[sessionId][jid].push(msgObj);
    if (msgCache[sessionId][jid].length > 1000) {
        msgCache[sessionId][jid] = msgCache[sessionId][jid].slice(-1000);
    }
    return true;
}

// ═══════ WHATSAPP ═══════
async function startWASocket(sessionId, opts = {}) {
    const client = getClient(sessionId);
    if (client.waStarting && !opts.force) {
        while (client.waStarting) await new Promise(r => setTimeout(r, 200));
        return client.waSocket;
    }
    client.waStarting = true;

    try {
        const authDir = path.join(getSessionDir(sessionId), 'wa_auth');
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        client.waAuthState = state;
        const { version } = await fetchLatestBaileysVersion();

        if (client.waSocket && opts.force) {
            try { client.waSocket.ev.removeAllListeners(); } catch (e) {}
            try { client.waSocket.end(undefined); } catch (e) {}
        }

        const sock = makeWASocket({
            version, auth: state, printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "20.0.0"],
            syncFullHistory: true,
            connectTimeoutMs: 300000,
            defaultQueryTimeoutMs: 300000,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 2000,
            generateHighQualityLinkPreview: false,
            markOnlineOnConnect: false
        });

        client.waSocket = sock;
        sock.ev.on('creds.update', saveCreds);

        // 🆕 التقاط الرسائل الحية
        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type !== 'notify' && type !== 'append') return;
            let changed = false;
            for (const m of messages) {
                if (!m.message || !m.key) continue;
                const jid = m.key.remoteJid;
                if (!jid) continue;
                if (addMsgToCache(sessionId, jid, formatMsg(m, sessionId))) changed = true;
            }
            if (changed) emitToSession(sessionId, 'wa-cache-update', getGroupCounts(sessionId));
        });

        // 🆕 التقاط التاريخ (الرسائل القديمة)
        sock.ev.on('messaging-history.set', ({ messages, chats, contacts, isLatest }) => {
            console.log('📜 History set:', sessionId, 'msgs:', messages?.length, 'isLatest:', isLatest);
            let changed = false;
            if (messages) {
                for (const m of messages) {
                    if (!m.message || !m.key) continue;
                    const jid = m.key.remoteJid;
                    if (!jid) continue;
                    if (addMsgToCache(sessionId, jid, formatMsg(m, sessionId))) changed = true;
                }
            }
            if (contacts) {
                for (const c of contacts) {
                    if (c.id && (c.notify || c.name)) client.contactNames[c.id] = c.notify || c.name;
                }
            }
            if (changed) {
                emitToSession(sessionId, 'wa-cache-update', getGroupCounts(sessionId));
                emitToSession(sessionId, 'wa-history-loaded', { count: messages?.length || 0 });
            }
        });

        sock.ev.on('contacts.update', (contacts) => {
            for (const c of contacts) {
                if (c.id && (c.notify || c.name)) client.contactNames[c.id] = c.notify || c.name;
            }
        });
        sock.ev.on('contacts.set', ({ contacts }) => {
            for (const c of contacts) {
                if (c.id && (c.notify || c.name)) client.contactNames[c.id] = c.notify || c.name;
            }
        });

        sock.ev.on('connection.update', (u) => {
            const { connection, lastDisconnect } = u;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('📡 WA:', sessionId, connection, 'code:', code);

            if (connection === 'open') {
                client.waConnected = true;
                client.waNeedsPairing = false;
                client.waPairingCode = null;
                console.log('✅ WA connected:', sessionId);
                emitToSession(sessionId, 'wa-status', 'connected');
            }
            else if (connection === 'close') {
                client.waConnected = false;

                // 🔴 401 loggedOut → امسح الجلسة
                if (code === DisconnectReason.loggedOut) {
                    client.waSocket = null;
                    client.waAuthState = null;
                    client.waNeedsPairing = false;
                    client.waPairingCode = null;
                    if (fs.existsSync(authDir)) {
                        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
                    }
                    emitToSession(sessionId, 'wa-status', 'logged_out');
                    return;
                }

                // 🔴 440 connectionReplaced → مفيش reconnect
                if (code === 440) {
                    client.waSocket = null;
                    emitToSession(sessionId, 'wa-status', 'disconnected');
                    emitToSession(sessionId, 'wa-code-status', '⚠️ الجلسة اتفتحت من جهاز تاني');
                    return;
                }

                // 🟢 كل الأكواد التانية → auto-reconnect
                client.waSocket = null;
                emitToSession(sessionId, 'wa-status', 'reconnecting');

                // 515 أسرع (بعد pairing مباشرة)
                const delay = (code === 515 || code === DisconnectReason.restartRequired) ? 2000 : 5000;

                if (reconnectTimers[sessionId]) clearTimeout(reconnectTimers[sessionId]);
                reconnectTimers[sessionId] = setTimeout(() => {
                    delete reconnectTimers[sessionId];
                    console.log('🔄 Auto-reconnect:', sessionId, 'code:', code);
                    startWASocket(sessionId, { force: true }).catch(() => {});
                }, delay);
            }
            else if (connection === 'connecting') {
                emitToSession(sessionId, 'wa-status', 'connecting');
            }
        });

        return sock;
    } finally {
        client.waStarting = false;
    }
}

function getGroupCounts(sessionId) {
    const cache = msgCache[sessionId] || {};
    return Object.keys(cache).map(gid => ({ id: gid, count: cache[gid].length }));
}

async function requestWACode(sessionId, phone) {
    const client = getClient(sessionId);
    if (client.waAuthState?.creds?.registered) return { error: 'الرقم مسجل — سجل خروج أول' };

    const authDir = path.join(getSessionDir(sessionId), 'wa_auth');
    if (client.waSocket) {
        try { client.waSocket.ev.removeAllListeners(); } catch (e) {}
        try { client.waSocket.end(undefined); } catch (e) {}
        client.waSocket = null;
        client.waAuthState = null;
    }
    if (fs.existsSync(authDir)) {
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
    }

    const clean = String(phone).replace(/\D/g, '');
    if (clean.length < 8) return { error: 'رقم غير صحيح' };

    await startWASocket(sessionId, { force: true });
    let tries = 0;
    while (!client.waSocket && tries < 20) { await new Promise(r => setTimeout(r, 500)); tries++; }
    if (!client.waSocket) return { error: 'Socket init timeout' };
    await new Promise(r => setTimeout(r, 3000));

    try {
        console.log('🔑 Requesting pairing code for', clean);
        const code = await client.waSocket.requestPairingCode(clean);
        client.waPairingCode = code.match(/.{1,4}/g).join('-');
        client.waNeedsPairing = true;
        console.log('✅ Code:', client.waPairingCode);
        return { code: client.waPairingCode };
    } catch (e) {
        console.log('❌ pairing error:', e.message);
        return { error: e.message };
    }
}

async function manualReconnect(sessionId) {
    const client = getClient(sessionId);
    if (!client.waAuthState?.creds?.registered) return { needPairing: true };
    client.waConnected = false;
    await startWASocket(sessionId, { force: true });
    return { ok: true };
}

async function logoutWA(sessionId) {
    try {
        const client = getClient(sessionId);
        if (reconnectTimers[sessionId]) { clearTimeout(reconnectTimers[sessionId]); delete reconnectTimers[sessionId]; }
        if (client.waSocket) {
            try { client.waSocket.ev.removeAllListeners(); } catch (e) {}
            try { await client.waSocket.logout(); } catch (e) {}
            try { client.waSocket.end(undefined); } catch (e) {}
            client.waSocket = null;
        }
        client.waConnected = false;
        client.waAuthState = null;
        client.waNeedsPairing = false;
        client.waPairingCode = null;
        delete msgCache[sessionId];
        const authDir = path.join(getSessionDir(sessionId), 'wa_auth');
        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
        emitToSession(sessionId, 'wa-status', 'disconnected');
        return { success: true };
    } catch (e) { return { error: e.message }; }
}

// ═══════ TELEGRAM ═══════
async function ensureTGClient(sessionId) {
    const client = getClient(sessionId);
    if (client.tgClient && client.tgClient.connected) return client.tgClient;
    const sessionFile = path.join(getSessionDir(sessionId), 'tg_session.txt');
    let ss = '';
    try { ss = fs.readFileSync(sessionFile, 'utf8').trim(); } catch (e) {}
    const tg = new TelegramClient(new StringSession(ss), TG_API_ID, TG_API_HASH, {
        connectionRetries: 10, useWSS: true, timeout: 120000, requestRetries: 5,
        autoReconnect: false, retryDelay: 2000
    });
    await tg.connect();
    client.tgClient = tg;
    return tg;
}
async function initTG(sessionId, phone, socket) {
    try {
        const client = getClient(sessionId);
        const tg = await ensureTGClient(sessionId);
        if (await tg.checkAuthorization()) {
            client.tgConnected = true;
            socket.emit('tg-status', 'connected');
            socket.emit('tg-code-status', '✅ متصل بالفعل!');
            return { alreadyConnected: true };
        }
        const result = await tg.invoke(new Api.auth.SendCode({
            phoneNumber: phone, apiId: TG_API_ID, apiHash: TG_API_HASH,
            settings: new Api.CodeSettings({ allowFlashCall: false, currentNumber: false, allowAppHash: true })
        }));
        client.pendingTG[phone] = { phoneCodeHash: result.phoneCodeHash, phone };
        socket.emit('tg-code-status', '📩 تم إرسال كود على تليجرام');
        socket.emit('tg-need-code');
        return { needCode: true };
    } catch (e) { return { error: e.message }; }
}
async function verifyTGCode(sessionId, phone, code, socket) {
    try {
        const client = getClient(sessionId);
        if (!client.tgClient) return { error: 'TG client not init' };
        if (!client.pendingTG[phone]) return { error: 'لا توجد عملية معلقة' };
        const { phoneCodeHash } = client.pendingTG[phone];
        try {
            await client.tgClient.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
        } catch (e) {
            if (String(e.message).includes('SESSION_PASSWORD_NEEDED')) {
                socket.emit('tg-need-password');
                socket.emit('tg-code-status', '🔐 يحتاج كلمة سر 2FA');
                return { needPassword: true };
            }
            throw e;
        }
        await finalizeTGSession(sessionId, phone, socket);
        return { success: true };
    } catch (e) { return { error: e.message }; }
}
async function verifyTGPassword(sessionId, phone, password, socket) {
    try {
        const client = getClient(sessionId);
        const pwdInfo = await client.tgClient.invoke(new Api.account.GetPassword());
        const pwdCheck = await computeCheck(pwdInfo, password);
        await client.tgClient.invoke(new Api.auth.CheckPassword({ password: pwdCheck }));
        await finalizeTGSession(sessionId, phone, socket);
        return { success: true };
    } catch (e) { return { error: e.message }; }
}
async function finalizeTGSession(sessionId, phone, socket) {
    const client = getClient(sessionId);
    client.tgConnected = true;
    const sessionFile = path.join(getSessionDir(sessionId), 'tg_session.txt');
    fs.writeFileSync(sessionFile, client.tgClient.session.save());
    delete client.pendingTG[phone];
    socket.emit('tg-status', 'connected');
    socket.emit('tg-code-status', '✅ تم الاتصال!');
}
async function logoutTG(sessionId) {
    try {
        const client = getClient(sessionId);
        if (client.tgClient) {
            try { await client.tgClient.logOut(); } catch (e) {}
            try { await client.tgClient.disconnect(); } catch (e) {}
        }
        client.tgClient = null;
        client.tgConnected = false;
        const sessionFile = path.join(getSessionDir(sessionId), 'tg_session.txt');
        if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
        emitToSession(sessionId, 'tg-status', 'disconnected');
        return { success: true };
    } catch (e) { return { error: e.message }; }
}

// ═══════ APIs ═══════
app.post('/api/wipe-sessions', async (req, res) => {
    try {
        for (const sid in clients) {
            const c = clients[sid];
            if (c.waSocket) {
                try { c.waSocket.ev.removeAllListeners(); } catch (e) {}
                try { c.waSocket.end(undefined); } catch (e) {}
            }
            if (c.tgClient) { try { await c.tgClient.disconnect(); } catch (e) {} }
            delete clients[sid];
        }
        for (const k in reconnectTimers) { clearTimeout(reconnectTimers[k]); delete reconnectTimers[k]; }
        if (fs.existsSync(SESSIONS_DIR)) {
            fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        }
        for (const k in allJobs) delete allJobs[k];
        for (const k in msgCache) delete msgCache[k];
        broadcastJobs();
        console.log('🗑️ All sessions wiped');
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════ SOCKET.IO ═══════
io.on('connection', (socket) => {
    console.log('👤 Client:', socket.id);
    socket.emit('jobs-update', Object.values(allJobs));

    socket.on('register-session', async (sessionId) => {
        sessionId = String(sessionId).trim();
        if (!sessionId) return;
        if (socket.sessionId && clients[socket.sessionId]) {
            clients[socket.sessionId].socketIds.delete(socket.id);
        }
        socket.sessionId = sessionId;
        const client = getClient(sessionId);
        client.socketIds.add(socket.id);

        socket.emit('tg-status', client.tgConnected ? 'connected' : 'disconnected');

        const authDir = path.join(getSessionDir(sessionId), 'wa_auth');
        const hasCreds = fs.existsSync(path.join(authDir, 'creds.json'));
        if (client.waConnected) socket.emit('wa-status', 'connected');
        else if (client.waSocket) socket.emit('wa-status', 'reconnecting');
        else if (hasCreds) socket.emit('wa-status', 'session_exists');
        else socket.emit('wa-status', 'disconnected');

        socket.emit('wa-cache-update', getGroupCounts(sessionId));

        if (client.waNeedsPairing && client.waPairingCode && !client.waConnected) {
            socket.emit('wa-code', client.waPairingCode);
            socket.emit('wa-code-status', '🔑 الكود جاهز');
        }

        if (!client.tgClient) {
            ensureTGClient(sessionId).then(async (tg) => {
                if (await tg.checkAuthorization()) {
                    client.tgConnected = true;
                    socket.emit('tg-status', 'connected');
                    socket.emit('tg-code-status', '✅ متصل بالفعل');
                }
            }).catch(() => {});
        } else if (client.tgConnected) socket.emit('tg-status', 'connected');
    });

    socket.on('disconnect', () => {
        if (socket.sessionId && clients[socket.sessionId]) {
            clients[socket.sessionId].socketIds.delete(socket.id);
        }
    });

    socket.on('wa-connect', async (phone) => {
        if (!socket.sessionId) return socket.emit('error', 'No session');
        socket.emit('wa-code-status', '⏳ جاري طلب الكود... استنى 20 ثانية');
        const r = await requestWACode(socket.sessionId, phone);
        if (r.code) {
            socket.emit('wa-code', r.code);
            socket.emit('wa-code-status', '✅ أدخل الكود في واتساب — استنى');
        } else socket.emit('wa-code-status', '❌ ' + r.error);
    });

    socket.on('wa-reconnect', async () => {
        if (!socket.sessionId) return;
        socket.emit('wa-code-status', '🔄 جاري إعادة الاتصال...');
        const r = await manualReconnect(socket.sessionId);
        if (r.ok) socket.emit('wa-code-status', '✅ بدأ الاتصال');
        else if (r.needPairing) socket.emit('wa-code-status', '❌ الرقم مش مربوط');
        else socket.emit('wa-code-status', '❌ فشل');
    });

    socket.on('wa-logout', async () => {
        if (!socket.sessionId) return;
        await logoutWA(socket.sessionId);
        socket.emit('wa-status', 'logged_out');
        socket.emit('logout-done', 'whatsapp');
    });

    // 🆕 إرسال سريع للأرقام (متوازي) + JID check
    socket.on('wa-spam', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected || !client.waSocket) return socket.emit('error', 'WA not connected');

        const rawInput = String(d.number).trim();
        const isGroup = rawInput.includes('@g.us');
        let target, finalDisplay = rawInput;

        if (isGroup || rawInput.includes('@s.whatsapp.net')) {
            target = rawInput;
        } else {
            const clean = rawInput.replace(/\D/g, '');
            if (clean.length < 8) return socket.emit('error', 'رقم غير صحيح');
            try {
                socket.emit('wa-code-status', '🔍 جاري التحقق من الرقم...');
                const results = await client.waSocket.onWhatsApp(clean);
                if (!results || results.length === 0) {
                    return socket.emit('error', '❌ الرقم مش عنده واتساب');
                }
                target = results[0].jid;
                finalDisplay = clean;
                socket.emit('wa-code-status', '✅ الرقم موجود');
            } catch (e) {
                target = clean + '@s.whatsapp.net';
                finalDisplay = clean;
            }
        }

        const jobId = 'wa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        allJobs[jobId] = {
            id: jobId, sessionId: socket.sessionId, type: 'whatsapp',
            target: finalDisplay.split('@')[0], message: d.message,
            count: d.count, sent: 0, failed: 0, isGroup,
            status: 'running', startTime: Date.now()
        };
        client.activeJobs[jobId] = { cancel: false };
        broadcastJobs();

        // 🚀 للأرقام: متوازي (10 مرة واحدة) | للجروبات: 10/ث
        const BATCH = isGroup ? 1 : 10;
        const DELAY = isGroup ? 100 : 0;
        let sent = 0, failed = 0;

        try {
            for (let i = 0; i < d.count; i += BATCH) {
                if (client.activeJobs[jobId]?.cancel) { allJobs[jobId].status = 'stopped'; break; }
                const batchSize = Math.min(BATCH, d.count - i);
                const promises = [];
                for (let j = 0; j < batchSize; j++) {
                    promises.push(
                        client.waSocket.sendMessage(target, { text: d.message })
                            .then(() => { sent++; })
                            .catch(() => { sent++; failed++; })
                    );
                }
                await Promise.all(promises);
                allJobs[jobId].sent = sent;
                allJobs[jobId].failed = failed;
                broadcastJobs();
                if (DELAY > 0) await new Promise(r => setTimeout(r, DELAY));
            }
        } catch (e) {
            allJobs[jobId].status = 'error';
            allJobs[jobId].error = e.message;
        }
        if (allJobs[jobId].status === 'running') allJobs[jobId].status = 'done';
        broadcastJobs();
        delete client.activeJobs[jobId];
    });

    socket.on('wa-stop', (jobId) => { const c = getClient(socket.sessionId); if (c.activeJobs[jobId]) c.activeJobs[jobId].cancel = true; });

    socket.on('wa-groups', async () => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected) return socket.emit('error', 'WA not connected');
        try {
            const g = Object.values(await client.waSocket.groupFetchAllParticipating());
            const cache = msgCache[socket.sessionId] || {};
            socket.emit('wa-groups-list', g.map(x => ({
                id: x.id, name: x.subject,
                count: (cache[x.id] || []).length
            })));
        } catch (e) { socket.emit('error', e.message); }
    });

    // 🆕 جلب رسائل الجروب (cache + loadMessages)
    socket.on('wa-group-messages', async (groupId) => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected) return socket.emit('error', 'WA not connected');

        let messages = [];
        const cached = msgCache[socket.sessionId]?.[groupId] || [];
        messages.push(...cached);

        try {
            const stored = await client.waSocket.loadMessages(groupId, 100);
            if (stored && stored.length) {
                for (const m of stored) {
                    if (!m.message || !m.key) continue;
                    if (!messages.find(x => x.id === m.key.id)) {
                        messages.push(formatMsg(m, socket.sessionId));
                    }
                }
            }
        } catch (e) { console.log('loadMessages err:', e.message); }

        messages.sort((a, b) => (a.time || 0) - (b.time || 0));

        if (!msgCache[socket.sessionId]) msgCache[socket.sessionId] = {};
        msgCache[socket.sessionId][groupId] = messages;

        socket.emit('wa-group-messages-list', {
            groupId, messages, count: messages.length
        });
    });

    // 🆕 إرسال من إطار الجروب (رسالة واحدة أو متعددة)
    socket.on('wa-group-send', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected || !client.waSocket) return socket.emit('error', 'WA not connected');

        const count = Math.max(1, parseInt(d.count) || 1);
        const BATCH = 1;
        const DELAY = 100;
        let ok = 0, failed = 0;

        for (let i = 0; i < count; i++) {
            try {
                await client.waSocket.sendMessage(d.groupId, { text: d.text });
                const entry = {
                    id: 'local_' + Date.now() + '_' + i,
                    from: 'me', fromMe: true, text: d.text,
                    time: Math.floor(Date.now() / 1000), pushName: 'أنت'
                };
                if (!msgCache[socket.sessionId]) msgCache[socket.sessionId] = {};
                if (!msgCache[socket.sessionId][d.groupId]) msgCache[socket.sessionId][d.groupId] = [];
                msgCache[socket.sessionId][d.groupId].push(entry);
                socket.emit('wa-group-send-ok', { groupId: d.groupId, ...entry, index: i + 1, total: count });
                ok++;
            } catch (e) {
                failed++;
                socket.emit('error', 'فشل رسالة ' + (i + 1) + ': ' + e.message);
            }
            if (i < count - 1) await new Promise(r => setTimeout(r, DELAY));
        }
        socket.emit('wa-group-send-done', { groupId: d.groupId, ok, failed, total: count });
    });

    socket.on('tg-connect', async (d) => { if (!socket.sessionId) return; socket.emit('tg-code-status', '⏳ جاري إرسال الكود...'); const r = await initTG(socket.sessionId, d.phone, socket); if (r.error) socket.emit('tg-code-status', '❌ ' + r.error); });
    socket.on('tg-verify', async (d) => { const r = await verifyTGCode(socket.sessionId, d.phone, d.code, socket); if (r.error) socket.emit('tg-code-status', '❌ ' + r.error); });
    socket.on('tg-verify-pass', async (d) => { const r = await verifyTGPassword(socket.sessionId, d.phone, d.password, socket); if (r.error) socket.emit('tg-code-status', '❌ ' + r.error); });
    socket.on('tg-logout', async () => { await logoutTG(socket.sessionId); socket.emit('tg-status', 'disconnected'); socket.emit('logout-done', 'telegram'); });
    socket.on('tg-spam', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.tgConnected || !client.tgClient) return socket.emit('error', 'TG not connected');
        const jobId = 'tg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        allJobs[jobId] = { id: jobId, sessionId: socket.sessionId, type: 'telegram', target: d.target, message: d.message, count: d.count, sent: 0, failed: 0, status: 'running', startTime: Date.now() };
        client.activeJobs[jobId] = { cancel: false };
        broadcastJobs();
        const DELAY_MS = 100;
        let successCount = 0, attemptCount = 0;
        const MAX_ATTEMPTS = d.count * 3;
        try {
            while (successCount < d.count && attemptCount < MAX_ATTEMPTS) {
                if (client.activeJobs[jobId]?.cancel) { allJobs[jobId].status = 'stopped'; broadcastJobs(); break; }
                attemptCount++;
                try { await client.tgClient.sendMessage(d.target, { message: d.message }); successCount++; allJobs[jobId].sent = successCount; }
                catch (e) { allJobs[jobId].failed++; if (String(e.message).includes('FLOOD')) await new Promise(r => setTimeout(r, 3000)); }
                broadcastJobs();
                await new Promise(r => setTimeout(r, DELAY_MS));
            }
        } catch (e) { allJobs[jobId].status = 'error'; allJobs[jobId].error = e.message; }
        if (allJobs[jobId].status === 'running') allJobs[jobId].status = 'done';
        broadcastJobs();
        delete client.activeJobs[jobId];
    });
    socket.on('tg-stop', (jobId) => { const c = getClient(socket.sessionId); if (c.activeJobs[jobId]) c.activeJobs[jobId].cancel = true; });
    socket.on('tg-groups', async () => {
        const client = getClient(socket.sessionId);
        if (!client.tgConnected) return socket.emit('error', 'TG not connected');
        try {
            const d = await client.tgClient.getDialogs({});
            const g = d.filter(x => x.isGroup || x.isChannel);
            socket.emit('tg-groups-list', g.map(x => ({ id: String(x.id), name: x.title || x.name })));
        } catch (e) { socket.emit('error', e.message); }
    });
    socket.on('clear-jobs', () => { for (const k in allJobs) if (allJobs[k].sessionId === socket.sessionId) delete allJobs[k]; broadcastJobs(); });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log('🚀 Server on port ' + PORT));
process.on('uncaughtException', (err) => console.log('⚠️ Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.log('⚠️ Unhandled:', err));
