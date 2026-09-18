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

function getClient(sessionId) {
    if (!clients[sessionId]) {
        clients[sessionId] = {
            waSocket: null, waConnected: false, waAuthState: null,
            waInitPromise: null, waNeedsPairing: false, waPairingCode: null,
            waManuallyLoggedOut: false, waManualConnect: false,
            tgClient: null, tgConnected: false,
            pendingTG: {}, activeJobs: {}, socketIds: new Set()
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
    const c = clients[sessionId];
    if (!c) return;
    for (const sid of c.socketIds) io.to(sid).emit(event, data);
}

// ═══════ WHATSAPP ═══════
async function initWA(sessionId, opts = {}) {
    const client = getClient(sessionId);

    if (client.waInitPromise && !opts.force) return client.waInitPromise;
    if (client.waManuallyLoggedOut && !opts.force) return null;

    client.waInitPromise = (async () => {
        try {
            const authDir = path.join(getSessionDir(sessionId), 'wa_auth');
            const { state, saveCreds } = await useMultiFileAuthState(authDir);
            client.waAuthState = state;
            const { version } = await fetchLatestBaileysVersion();

            if (client.waSocket) {
                try { client.waSocket.ev.removeAllListeners(); } catch (e) {}
                try { client.waSocket.end(undefined); } catch (e) {}
                client.waSocket = null;
            }

            const sock = makeWASocket({
                version, auth: state, printQRInTerminal: false,
                logger: pino({ level: 'silent' }),
                browser: ["Ubuntu", "Chrome", "20.0.0"],
                syncFullHistory: false,
                connectTimeoutMs: 300000,          // 5 دقايق
                defaultQueryTimeoutMs: 300000,     // 5 دقايق
                keepAliveIntervalMs: 60000,        // 60 ثانية
                retryRequestDelayMs: 2000,
                generateHighQualityLinkPreview: false,
                markOnlineOnConnect: false,
                getMessage: async () => ({ conversation: '' })
            });

            client.waSocket = sock;
            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('connection.update', (u) => {
                const { connection, lastDisconnect } = u;
                if (connection === 'open') {
                    client.waConnected = true;
                    client.waNeedsPairing = false;
                    client.waPairingCode = null;
                    client.waManuallyLoggedOut = false;
                    console.log('✅ WA connected:', sessionId);
                    emitToSession(sessionId, 'wa-status', 'connected');
                } else if (connection === 'close') {
                    client.waConnected = false;
                    const code = lastDisconnect?.error?.output?.statusCode;
                    console.log('⚠️ WA closed:', sessionId, 'code:', code);
                    emitToSession(sessionId, 'wa-status', 'disconnected');

                    // 🛑 لا يوجد reconnect تلقائي — المستخدم يدوس زرار
                    if (code === DisconnectReason.loggedOut) {
                        client.waManuallyLoggedOut = true;
                        client.waNeedsPairing = false;
                        client.waPairingCode = null;
                        const authDir = path.join(getSessionDir(sessionId), 'wa_auth');
                        if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
                        client.waAuthState = null;
                        emitToSession(sessionId, 'wa-status', 'logged_out');
                    }
                } else if (connection === 'connecting') {
                    emitToSession(sessionId, 'wa-status', 'connecting');
                }
            });

            return sock;
        } catch (e) {
            console.log('WA init error:', e.message);
            throw e;
        } finally {
            setTimeout(() => { if (client) client.waInitPromise = null; }, 2000);
        }
    })();

    return client.waInitPromise;
}

async function manualReconnect(sessionId) {
    const client = getClient(sessionId);
    // اقفل أي حاجة قديمة
    if (client.waSocket) {
        try { client.waSocket.ev.removeAllListeners(); } catch (e) {}
        try { client.waSocket.end(undefined); } catch (e) {}
        client.waSocket = null;
    }
    client.waInitPromise = null;
    client.waManuallyLoggedOut = false;
    client.waConnected = false;

    await initWA(sessionId, { force: true });

    // انتظر لحد 20 ثانية
    let tries = 0;
    while ((!client.waSocket || !client.waAuthState) && tries < 40) {
        await new Promise(r => setTimeout(r, 500));
        tries++;
    }
    return { ok: !!client.waSocket };
}

async function requestWACode(sessionId, phone) {
    try {
        const client = getClient(sessionId);
        client.waManuallyLoggedOut = false;

        await initWA(sessionId, { force: true });

        // انتظر 60 ثانية للـ init
        let tries = 0;
        while ((!client.waSocket || !client.waAuthState) && tries < 120) {
            await new Promise(r => setTimeout(r, 500));
            tries++;
        }
        if (!client.waSocket) return { error: 'WhatsApp init timeout' };
        if (client.waAuthState.creds.registered) return { error: 'مسجل بالفعل — امسح الجلسة أو سجل خروج' };

        const clean = String(phone).replace(/\D/g, '');
        if (clean.length < 8) return { error: 'رقم غير صحيح' };

        const code = await client.waSocket.requestPairingCode(clean);
        client.waPairingCode = code.match(/.{1,4}/g).join('-');
        client.waNeedsPairing = true;
        return { code: client.waPairingCode };
    } catch (e) { return { error: e.message }; }
}

async function logoutWA(sessionId) {
    try {
        const client = getClient(sessionId);
        client.waManuallyLoggedOut = true;
        if (client.waSocket) {
            try { client.waSocket.ev.removeAllListeners(); } catch (e) {}
            try { await client.waSocket.logout(); } catch (e) {}
            try { client.waSocket.end(undefined); } catch (e) {}
            client.waSocket = null;
        }
        client.waConnected = false;
        client.waAuthState = null;
        client.waInitPromise = null;
        client.waNeedsPairing = false;
        client.waPairingCode = null;
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
        connectionRetries: 10, useWSS: true, timeout: 300000, requestRetries: 5,
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
                try { c.waSocket.ev.removeAllListeners(); } catch(e){}
                try { c.waSocket.end(undefined); } catch(e){}
            }
            if (c.tgClient) { try { await c.tgClient.disconnect(); } catch(e){} }
            delete clients[sid];
        }
        if (fs.existsSync(SESSIONS_DIR)) {
            fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        }
        for (const k in allJobs) delete allJobs[k];
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

        socket.emit('wa-status', client.waConnected ? 'connected' : (client.waManuallyLoggedOut ? 'logged_out' : 'disconnected'));
        socket.emit('tg-status', client.tgConnected ? 'connected' : 'disconnected');

        // 🔴 مفيش init تلقائي — المستخدم يدوس "إعادة الاتصال"
        if (client.waNeedsPairing && client.waPairingCode && !client.waConnected) {
            socket.emit('wa-code', client.waPairingCode);
        }

        if (client.tgClient && client.tgConnected) socket.emit('tg-status', 'connected');
    });

    socket.on('disconnect', () => {
        if (socket.sessionId && clients[socket.sessionId]) {
            clients[socket.sessionId].socketIds.delete(socket.id);
        }
    });

    // 🔄 إعادة اتصال يدوي
    socket.on('wa-reconnect', async () => {
        if (!socket.sessionId) return;
        socket.emit('wa-code-status', '🔄 جاري إعادة الاتصال...');
        const r = await manualReconnect(socket.sessionId);
        if (r.ok) {
            socket.emit('wa-code-status', '✅ تم بدء الاتصال — انتظر...');
        } else {
            socket.emit('wa-code-status', '❌ فشل — جرب تاني');
        }
    });

    socket.on('wa-connect', async (phone) => {
        if (!socket.sessionId) return socket.emit('error', 'No session');
        socket.emit('wa-code-status', '⏳ جاري طلب الكود... (ممكن يأخد دقيقة)');
        const r = await requestWACode(socket.sessionId, phone);
        if (r.code) {
            socket.emit('wa-code', r.code);
            socket.emit('wa-code-status', '✅ أدخل الكود في واتساب — استنى شوية لحد الربط');
        } else socket.emit('wa-code-status', '❌ ' + r.error);
    });

    socket.on('wa-logout', async () => {
        if (!socket.sessionId) return;
        await logoutWA(socket.sessionId);
        socket.emit('wa-status', 'logged_out');
        socket.emit('logout-done', 'whatsapp');
    });

    socket.on('wa-spam', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected || !client.waSocket) return socket.emit('error', 'WA not connected');

        const jobId = 'wa_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
        const isGroup = String(d.number).includes('@g.us');
        const target = String(d.number).includes('@') ? d.number : String(d.number).replace(/\D/g, '') + '@s.whatsapp.net';

        allJobs[jobId] = {
            id: jobId, sessionId: socket.sessionId, type: 'whatsapp',
            target: target.split('@')[0], message: d.message,
            count: d.count, sent: 0, failed: 0,
            isGroup, status: 'running', startTime: Date.now()
        };
        client.activeJobs[jobId] = { cancel: false };
        broadcastJobs();

        const DELAY_MS = isGroup ? 100 : 0;
        let successCount = 0, attemptCount = 0;
        const MAX_ATTEMPTS = d.count * 3;

        try {
            while (successCount < d.count && attemptCount < MAX_ATTEMPTS) {
                if (client.activeJobs[jobId]?.cancel) { allJobs[jobId].status = 'stopped'; broadcastJobs(); break; }
                attemptCount++;
                try {
                    await client.waSocket.sendMessage(target, { text: d.message });
                    successCount++; allJobs[jobId].sent = successCount;
                } catch (e) { allJobs[jobId].failed++; }
                broadcastJobs();
                if (DELAY_MS > 0) await new Promise(r => setTimeout(r, DELAY_MS));
            }
        } catch (e) { allJobs[jobId].status = 'error'; allJobs[jobId].error = e.message; }
        if (allJobs[jobId].status === 'running') allJobs[jobId].status = 'done';
        broadcastJobs();
        delete client.activeJobs[jobId];
    });

    socket.on('wa-stop', (jobId) => {
        const client = getClient(socket.sessionId);
        if (client.activeJobs[jobId]) client.activeJobs[jobId].cancel = true;
    });

    socket.on('wa-groups', async () => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected) return socket.emit('error', 'WA not connected');
        try {
            const g = Object.values(await client.waSocket.groupFetchAllParticipating());
            socket.emit('wa-groups-list', g.map(x => ({ id: x.id, name: x.subject })));
        } catch (e) { socket.emit('error', e.message); }
    });

    socket.on('wa-group-messages', async (groupId) => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected) return socket.emit('error', 'WA not connected');
        try {
            let messages = [];
            try { messages = await client.waSocket.loadMessages(groupId, 50); } catch (e) {}
            const formatted = (messages || []).map(m => ({
                id: m.key?.id || '',
                from: m.key?.participant ? m.key.participant.split('@')[0] : (m.key?.remoteJid || '').split('@')[0],
                fromMe: !!m.key?.fromMe,
                text: m.message?.conversation || m.message?.extendedTextMessage?.text || m.message?.imageMessage?.caption || '[media]',
                time: m.messageTimestamp || 0,
                pushName: m.pushName || ''
            })).reverse();
            socket.emit('wa-group-messages-list', { groupId, messages: formatted });
        } catch (e) {
            socket.emit('wa-group-messages-list', { groupId, messages: [], error: e.message });
        }
    });

    socket.on('wa-group-send', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected || !client.waSocket) return socket.emit('error', 'WA not connected');
        try {
            await client.waSocket.sendMessage(d.groupId, { text: d.text });
            socket.emit('wa-group-send-ok', { groupId: d.groupId, text: d.text, time: Math.floor(Date.now()/1000) });
        } catch (e) { socket.emit('error', e.message); }
    });

    socket.on('tg-connect', async (d) => {
        if (!socket.sessionId) return;
        socket.emit('tg-code-status', '⏳ جاري إرسال الكود...');
        const r = await initTG(socket.sessionId, d.phone, socket);
        if (r.error) socket.emit('tg-code-status', '❌ ' + r.error);
    });
    socket.on('tg-verify', async (d) => {
        const r = await verifyTGCode(socket.sessionId, d.phone, d.code, socket);
        if (r.error) socket.emit('tg-code-status', '❌ ' + r.error);
    });
    socket.on('tg-verify-pass', async (d) => {
        const r = await verifyTGPassword(socket.sessionId, d.phone, d.password, socket);
        if (r.error) socket.emit('tg-code-status', '❌ ' + r.error);
    });
    socket.on('tg-logout', async () => {
        await logoutTG(socket.sessionId);
        socket.emit('tg-status', 'disconnected');
        socket.emit('logout-done', 'telegram');
    });

    socket.on('tg-spam', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.tgConnected || !client.tgClient) return socket.emit('error', 'TG not connected');
        const jobId = 'tg_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
        allJobs[jobId] = {
            id: jobId, sessionId: socket.sessionId, type: 'telegram',
            target: d.target, message: d.message, count: d.count,
            sent: 0, failed: 0, status: 'running', startTime: Date.now()
        };
        client.activeJobs[jobId] = { cancel: false };
        broadcastJobs();
        const DELAY_MS = 100;
        let successCount = 0, attemptCount = 0;
        const MAX_ATTEMPTS = d.count * 3;
        try {
            while (successCount < d.count && attemptCount < MAX_ATTEMPTS) {
                if (client.activeJobs[jobId]?.cancel) { allJobs[jobId].status = 'stopped'; broadcastJobs(); break; }
                attemptCount++;
                try {
                    await client.tgClient.sendMessage(d.target, { message: d.message });
                    successCount++; allJobs[jobId].sent = successCount;
                } catch (e) {
                    allJobs[jobId].failed++;
                    if (String(e.message).includes('FLOOD')) await new Promise(r => setTimeout(r, 3000));
                }
                broadcastJobs();
                await new Promise(r => setTimeout(r, DELAY_MS));
            }
        } catch (e) { allJobs[jobId].status = 'error'; allJobs[jobId].error = e.message; }
        if (allJobs[jobId].status === 'running') allJobs[jobId].status = 'done';
        broadcastJobs();
        delete client.activeJobs[jobId];
    });

    socket.on('tg-stop', (jobId) => {
        const client = getClient(socket.sessionId);
        if (client.activeJobs[jobId]) client.activeJobs[jobId].cancel = true;
    });

    socket.on('tg-groups', async () => {
        const client = getClient(socket.sessionId);
        if (!client.tgConnected) return socket.emit('error', 'TG not connected');
        try {
            const d = await client.tgClient.getDialogs({});
            const g = d.filter(x => x.isGroup || x.isChannel);
            socket.emit('tg-groups-list', g.map(x => ({ id: String(x.id), name: x.title || x.name })));
        } catch (e) { socket.emit('error', e.message); }
    });

    socket.on('clear-jobs', () => {
        for (const k in allJobs) if (allJobs[k].sessionId === socket.sessionId) delete allJobs[k];
        broadcastJobs();
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log('🚀 Server on port ' + PORT));
process.on('uncaughtException', (err) => console.log('⚠️ Uncaught:', err.message));
process.on('unhandledRejection', (err) => console.log('⚠️ Unhandled:', err));
