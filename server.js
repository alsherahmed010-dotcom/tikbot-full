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
    pingTimeout: 300000,
    pingInterval: 25000
});
app.use(express.static(path.join(__dirname, 'public')));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram');

const TG_API_ID = 38231139;
const TG_API_HASH = '8c6f63a727badd926100bdf80b0566fc';

// ═══════ State ═══════
let waSocket = null, waConnected = false, waState = null;
let tgClient = null, tgConnected = false;
let pendingTG = {};

// Jobs tracking
let jobs = {};
let activeJobs = {};

function broadcastJobs() {
    io.emit('jobs-update', Object.values(jobs));
}

// ═══════ WhatsApp ═══════
async function initWA() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('wa_auth');
        waState = state;
        const { version } = await fetchLatestBaileysVersion();

        waSocket = makeWASocket({
            version, auth: state, printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "20.0.0"],
            syncFullHistory: false,
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 120000
        });

        waSocket.ev.on('creds.update', saveCreds);

        waSocket.ev.on('connection.update', (u) => {
            if (u.connection === 'open') {
                waConnected = true;
                io.emit('wa-status', 'connected');
                console.log('✅ WA Connected');
            } else if (u.connection === 'close') {
                waConnected = false;
                io.emit('wa-status', 'disconnected');
                const code = (u.lastDisconnect?.error)?.output?.statusCode;
                if (code !== DisconnectReason.loggedOut) setTimeout(() => initWA(), 5000);
            }
        });
    } catch(e) { console.log('WA init:', e.message); }
}

async function requestWACode(phone) {
    try {
        if (!waSocket) await initWA();
        if (waState.creds.registered) return { error: 'Already registered' };
        const code = await waSocket.requestPairingCode(phone.replace(/\D/g, ''));
        return { code: code.match(/.{1,4}/g).join('-') };
    } catch(e) { return { error: e.message }; }
}

// ═══════ Telegram ═══════
async function initTG(phone, socket) {
    try {
        let ss = '';
        try { ss = fs.readFileSync('tg_session.txt', 'utf8'); } catch(e) {}

        tgClient = new TelegramClient(new StringSession(ss), TG_API_ID, TG_API_HASH, {
            connectionRetries: 5, useWSS: true, timeout: 120000
        });

        await tgClient.connect();

        if (await tgClient.checkAuthorization()) {
            tgConnected = true;
            socket.emit('tg-status', 'connected');
            socket.emit('tg-code-status', '✅ متصل بالفعل!');
            return { alreadyConnected: true };
        }

        const result = await tgClient.invoke(new Api.auth.SendCode({
            phoneNumber: phone,
            apiId: TG_API_ID,
            apiHash: TG_API_HASH,
            settings: new Api.CodeSettings({ allowFlashCall: false, currentNumber: false, allowAppHash: true })
        }));

        pendingTG[phone] = { phoneCodeHash: result.phoneCodeHash, phone };
        socket.emit('tg-code-status', '📩 تم إرسال كود على تليجرام');
        socket.emit('tg-need-code', 'أدخل كود التحقق');
        return { needCode: true };
    } catch(e) { return { error: e.message }; }
}

async function verifyTGCode(phone, code, socket) {
    try {
        if (!pendingTG[phone]) return { error: 'No pending login' };
        const { phoneCodeHash } = pendingTG[phone];

        try {
            await tgClient.invoke(new Api.auth.SignIn({
                phoneNumber: phone, phoneCodeHash, phoneCode: code
            }));
        } catch(e) {
            if (e.message && e.message.includes('SESSION_PASSWORD_NEEDED')) {
                socket.emit('tg-need-password', '🔐 أدخل كلمة سر 2FA');
                return { needPassword: true };
            }
            throw e;
        }

        tgConnected = true;
        fs.writeFileSync('tg_session.txt', tgClient.session.save());
        delete pendingTG[phone];
        socket.emit('tg-status', 'connected');
        socket.emit('tg-code-status', '✅ تم الاتصال!');
        return { success: true };
    } catch(e) { return { error: e.message }; }
}

async function verifyTGPassword(phone, password, socket) {
    try {
        const { computeCheck } = require('telegram/Password');
        const passwordInfo = await tgClient.invoke(new Api.account.GetPassword());
        const passwordCheck = await computeCheck(passwordInfo, password);
        await tgClient.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));

        tgConnected = true;
        fs.writeFileSync('tg_session.txt', tgClient.session.save());
        delete pendingTG[phone];
        socket.emit('tg-status', 'connected');
        socket.emit('tg-code-status', '✅ تم الاتصال!');
        return { success: true };
    } catch(e) { return { error: e.message }; }
}

// ═══════ Socket.IO ═══════
io.on('connection', (socket) => {
    console.log('👤 Client:', socket.id);
    socket.emit('wa-status', waConnected ? 'connected' : 'disconnected');
    socket.emit('tg-status', tgConnected ? 'connected' : 'disconnected');
    socket.emit('jobs-update', Object.values(jobs));

    // WhatsApp
    socket.on('wa-connect', async (phone) => {
        socket.emit('wa-code-status', '⏳ جاري طلب الكود...');
        const r = await requestWACode(phone);
        if (r.code) socket.emit('wa-code', r.code);
        else socket.emit('wa-code-status', '❌ ' + r.error);
    });

    socket.on('wa-spam', async (d) => {
        if (!waConnected) return socket.emit('error', 'WA not connected');
        const jobId = 'wa_' + Date.now();
        const target = d.number.includes('@s.whatsapp.net') ? d.number : d.number.replace(/\D/g, '') + '@s.whatsapp.net';
        
        jobs[jobId] = {
            id: jobId, type: 'whatsapp', target: target.split('@')[0],
            count: d.count, sent: 0, failed: 0,
            status: 'running', startTime: Date.now()
        };
        activeJobs[jobId] = { cancel: false };
        broadcastJobs();

        const BATCH = 1;
        for (let i = 0; i < d.count; i += BATCH) {
            if (activeJobs[jobId].cancel) {
                jobs[jobId].status = 'stopped';
                broadcastJobs();
                break;
            }
            const batch = [];
            for (let j = i; j < Math.min(i + BATCH, d.count); j++) {
                batch.push(
                    waSocket.sendMessage(target, { text: d.message })
                        .then(() => { jobs[jobId].sent++; })
                        .catch(() => { jobs[jobId].sent++; jobs[jobId].failed++; })
                );
            }
            await Promise.all(batch);
            broadcastJobs();
        }
        if (jobs[jobId].status === 'running') jobs[jobId].status = 'done';
        broadcastJobs();
        delete activeJobs[jobId];
    });

    socket.on('wa-stop', (jobId) => {
        if (jobId && activeJobs[jobId]) activeJobs[jobId].cancel = true;
        else {
            // إلغاء آخر عملية
            const ids = Object.keys(activeJobs);
            if (ids.length > 0) activeJobs[ids[ids.length - 1]].cancel = true;
        }
    });

    socket.on('wa-groups', async () => {
        if (!waConnected) return socket.emit('error', 'WA not connected');
        try {
            const g = Object.values(await waSocket.groupFetchAllParticipating());
            socket.emit('wa-groups-list', g.map(x => ({ id: x.id, name: x.subject })));
        } catch(e) { socket.emit('error', e.message); }
    });

    socket.on('wa-reset', () => {
        try {
            fs.rmSync('wa_auth', { recursive: true, force: true });
            waConnected = false;
            if (waSocket) waSocket.end();
            setTimeout(() => initWA(), 2000);
            socket.emit('wa-status', 'disconnected');
        } catch(e) { socket.emit('error', e.message); }
    });

    // Telegram
    socket.on('tg-connect', async (d) => {
        socket.emit('tg-code-status', '⏳ جاري إرسال الكود...');
        const r = await initTG(d.phone, socket);
        if (r.error) socket.emit('tg-code-status', '❌ ' + r.error);
    });

    socket.on('tg-verify', async (d) => {
        const r = await verifyTGCode(d.phone, d.code, socket);
        if (r.error) socket.emit('tg-code-status', '❌ ' + r.error);
    });

    socket.on('tg-verify-pass', async (d) => {
        const r = await verifyTGPassword(d.phone, d.password, socket);
        if (r.error) socket.emit('tg-code-status', '❌ ' + r.error);
    });

    socket.on('tg-spam', async (d) => {
        if (!tgConnected) return socket.emit('error', 'TG not connected');
        const jobId = 'tg_' + Date.now();
        
        jobs[jobId] = {
            id: jobId, type: 'telegram', target: d.target,
            count: d.count, sent: 0, failed: 0,
            status: 'running', startTime: Date.now()
        };
        activeJobs[jobId] = { cancel: false };
        broadcastJobs();

        const BATCH = 20;
        for (let i = 0; i < d.count; i += BATCH) {
            if (activeJobs[jobId].cancel) {
                jobs[jobId].status = 'stopped';
                broadcastJobs();
                break;
            }
            const batch = [];
            for (let j = i; j < Math.min(i + BATCH, d.count); j++) {
                batch.push(
                    tgClient.sendMessage(d.target, { message: d.message })
                        .then(() => { jobs[jobId].sent++; })
                        .catch((e) => { 
                            jobs[jobId].failed++;
                            if (e.message && e.message.includes('FLOOD')) {
                                return new Promise(r => setTimeout(r, 3000));
                            }
                        })
                );
            }
            await Promise.all(batch);
            broadcastJobs();
        }
        if (jobs[jobId].status === 'running') jobs[jobId].status = 'done';
        broadcastJobs();
        delete activeJobs[jobId];
    });

    socket.on('tg-stop', (jobId) => {
        if (jobId && activeJobs[jobId]) activeJobs[jobId].cancel = true;
        else {
            const ids = Object.keys(activeJobs);
            if (ids.length > 0) activeJobs[ids[ids.length - 1]].cancel = true;
        }
    });

    socket.on('tg-groups', async () => {
        if (!tgConnected) return socket.emit('error', 'TG not connected');
        try {
            const d = await tgClient.getDialogs({});
            const g = d.filter(x => x.isGroup || x.isChannel);
            socket.emit('tg-groups-list', g.map(x => ({ id: String(x.id), name: x.name })));
        } catch(e) { socket.emit('error', e.message); }
    });

    socket.on('tg-reset', () => {
        try {
            fs.rmSync('tg_session.txt', { force: true });
            tgConnected = false;
            if (tgClient) tgClient.disconnect();
            socket.emit('tg-status', 'disconnected');
        } catch(e) { socket.emit('error', e.message); }
    });

    socket.on('clear-jobs', () => {
        jobs = {};
        broadcastJobs();
    });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Server on port ' + PORT);
    initWA().catch(e => console.log('WA error:', e.message));
});
