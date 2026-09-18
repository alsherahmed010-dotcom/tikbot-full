const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

// ============ Global State ============
let waSocket = null, waConnected = false, waState = null;
let tgClient = null, tgConnected = false;
let pendingTG = {};

// ============ WhatsApp ============
async function initWA() {
    const { state, saveCreds } = await useMultiFileAuthState('wa_auth');
    waState = state;
    const { version } = await fetchLatestBaileysVersion();

    waSocket = makeWASocket({
        version, auth: state, printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.0"],
        syncFullHistory: false
    });

    waSocket.ev.on('creds.update', saveCreds);

    waSocket.ev.on('connection.update', (u) => {
        if (u.connection === 'open') {
            waConnected = true;
            io.emit('wa-status', 'connected');
            console.log('✅ WhatsApp Connected');
        } else if (u.connection === 'close') {
            waConnected = false;
            io.emit('wa-status', 'disconnected');
            const code = (u.lastDisconnect?.error)?.output?.statusCode;
            console.log('❌ WA Closed, code:', code);
            if (code !== DisconnectReason.loggedOut) {
                setTimeout(() => initWA(), 5000);
            }
        }
    });
}

async function requestWACode(phone) {
    try {
        if (!waSocket) await initWA();
        if (waState.creds.registered) return { error: 'already registered' };
        const clean = phone.replace(/\D/g, '');
        const code = await waSocket.requestPairingCode(clean);
        return { code: code.match(/.{1,4}/g).join('-') };
    } catch(e) {
        return { error: e.message };
    }
}

// ============ Telegram ============
async function initTG(apiId, apiHash, phone, sessionSocket) {
    try {
        let ss = '';
        try { ss = fs.readFileSync('tg_session.txt', 'utf8'); } catch(e) {}

        tgClient = new TelegramClient(new StringSession(ss), parseInt(apiId), apiHash, {
            connectionRetries: 3,
            useWSS: true
        });

        // Manual login flow (بدون input library)
        await tgClient.connect();

        if (!await tgClient.checkAuthorization()) {
            // 1. Send code
            const result = await tgClient.invoke(
                new (require('telegram').Api.auth.SendCode)({
                    phoneNumber: phone,
                    apiId: parseInt(apiId),
                    apiHash: apiHash,
                    settings: new (require('telegram').Api.CodeSettings)({
                        allowFlashCall: false,
                        currentNumber: false,
                        allowAppHash: true
                    })
                })
            );

            pendingTG[phone] = {
                phoneCodeHash: result.phoneCodeHash,
                apiId, apiHash, phone
            };

            sessionSocket.emit('tg-need-code', 'تم إرسال الكود - أدخله في الأسفل');
            return { needCode: true };
        } else {
            tgConnected = true;
            fs.writeFileSync('tg_session.txt', tgClient.session.save());
            sessionSocket.emit('tg-status', 'connected');
            io.emit('tg-status', 'connected');
            return { success: true };
        }
    } catch(e) {
        console.log('TG Error:', e.message);
        return { error: e.message };
    }
}

async function verifyTGCode(phone, code) {
    try {
        if (!pendingTG[phone]) return { error: 'no pending login' };
        const { phoneCodeHash, apiId, apiHash } = pendingTG[phone];

        try {
            await tgClient.invoke(
                new (require('telegram').Api.auth.SignIn)({
                    phoneNumber: phone,
                    phoneCodeHash: phoneCodeHash,
                    phoneCode: code
                })
            );
        } catch(e) {
            if (e.message && e.message.includes('SESSION_PASSWORD_NEEDED')) {
                pendingTG[phone].needPassword = true;
                return { needPassword: true };
            }
            throw e;
        }

        tgConnected = true;
        fs.writeFileSync('tg_session.txt', tgClient.session.save());
        delete pendingTG[phone];
        io.emit('tg-status', 'connected');
        return { success: true };
    } catch(e) {
        return { error: e.message };
    }
}

async function verifyTGPassword(phone, password) {
    try {
        const { apiId, apiHash } = pendingTG[phone];
        const { computeCheck } = require('telegram/Password');
        const passwordInfo = await tgClient.invoke(
            new (require('telegram').Api.account.GetPassword)()
        );
        const passwordCheck = await computeCheck(passwordInfo, password);

        await tgClient.invoke(
            new (require('telegram').Api.auth.CheckPassword)({
                password: passwordCheck
            })
        );

        tgConnected = true;
        fs.writeFileSync('tg_session.txt', tgClient.session.save());
        delete pendingTG[phone];
        io.emit('tg-status', 'connected');
        return { success: true };
    } catch(e) {
        return { error: e.message };
    }
}

// ============ Socket.IO ============
io.on('connection', (socket) => {
    console.log('👤 Client:', socket.id);
    socket.emit('wa-status', waConnected ? 'connected' : 'disconnected');
    socket.emit('tg-status', tgConnected ? 'connected' : 'disconnected');

    // WhatsApp Connect
    socket.on('wa-connect', async (phone) => {
        socket.emit('wa-code-status', '⏳ جاري طلب الكود...');
        const r = await requestWACode(phone);
        if (r.code) socket.emit('wa-code', r.code);
        else socket.emit('wa-code-status', '❌ ' + r.error);
    });

    // WhatsApp Spam
    socket.on('wa-spam', async (d) => {
        if (!waConnected) return socket.emit('error', 'WA not connected');
        const target = d.number.includes('@s.whatsapp.net') ? d.number : d.number.replace(/\D/g, '') + '@s.whatsapp.net';
        let sent = 0, failed = 0;
        const BATCH = 30;
        for (let i = 0; i < d.count; i += BATCH) {
            const batch = [];
            for (let j = i; j < Math.min(i + BATCH, d.count); j++) {
                batch.push(
                    waSocket.sendMessage(target, { text: d.message })
                        .then(() => sent++)
                        .catch(() => { sent++; failed++; })
                );
            }
            await Promise.all(batch);
            socket.emit('wa-progress', { sent, failed, total: d.count });
        }
        socket.emit('wa-done', { sent, failed });
    });

    // WhatsApp Groups
    socket.on('wa-groups', async () => {
        if (!waConnected) return socket.emit('error', 'WA not connected');
        try {
            const g = Object.values(await waSocket.groupFetchAllParticipating());
            socket.emit('wa-groups-list', g.map(x => ({ id: x.id, name: x.subject })));
        } catch(e) { socket.emit('error', e.message); }
    });

    // Add Members
    socket.on('wa-add-members', async (d) => {
        if (!waConnected) return socket.emit('error', 'WA not connected');
        let added = 0, failed = 0;
        for (const num of d.numbers) {
            const jid = num.includes('@s.whatsapp.net') ? num : num.replace(/\D/g, '') + '@s.whatsapp.net';
            try {
                await waSocket.groupParticipantsUpdate(d.groupId, [jid], 'add');
                added++;
            } catch(e) { failed++; }
            socket.emit('wa-add-progress', { added, failed, total: d.numbers.length });
            await new Promise(r => setTimeout(r, 300));
        }
        socket.emit('wa-add-done', { added, failed });
    });

    // Telegram Connect (Step 1)
    socket.on('tg-connect', async (d) => {
        socket.emit('tg-code-status', '⏳ جاري الاتصال...');
        const r = await initTG(d.apiId, d.apiHash, d.phone, socket);
        if (r.needCode) socket.emit('tg-code-status', '📩 أدخل كود التحقق');
        else if (r.success) socket.emit('tg-code-status', '✅ تم الاتصال');
        else socket.emit('tg-code-status', '❌ ' + r.error);
    });

    // Telegram Verify Code (Step 2)
    socket.on('tg-verify', async (d) => {
        const r = await verifyTGCode(d.phone, d.code);
        if (r.needPassword) socket.emit('tg-need-password', '🔐 أدخل كلمة السر (2FA)');
        else if (r.success) socket.emit('tg-code-status', '✅ تم الاتصال');
        else socket.emit('tg-code-status', '❌ ' + r.error);
    });

    // Telegram Verify Password (Step 3)
    socket.on('tg-verify-pass', async (d) => {
        const r = await verifyTGPassword(d.phone, d.password);
        if (r.success) socket.emit('tg-code-status', '✅ تم الاتصال');
        else socket.emit('tg-code-status', '❌ ' + r.error);
    });

    // Telegram Spam
    socket.on('tg-spam', async (d) => {
        if (!tgConnected) return socket.emit('error', 'TG not connected');
        let sent = 0, failed = 0;
        for (let i = 0; i < d.count; i++) {
            try {
                await tgClient.sendMessage(d.target, { message: d.message });
                sent++;
                socket.emit('tg-progress', { sent, failed, total: d.count });
            } catch(e) {
                failed++;
                if (e.message && e.message.includes('FLOOD')) {
                    await new Promise(r => setTimeout(r, 5000));
                }
            }
            await new Promise(r => setTimeout(r, 100));
        }
        socket.emit('tg-done', { sent, failed });
    });

    // Telegram Groups
    socket.on('tg-groups', async () => {
        if (!tgConnected) return socket.emit('error', 'TG not connected');
        try {
            const d = await tgClient.getDialogs({});
            const g = d.filter(x => x.isGroup || x.isChannel);
            socket.emit('tg-groups-list', g.map(x => ({ id: String(x.id), name: x.name })));
        } catch(e) { socket.emit('error', e.message); }
    });
});

// ============ Start ============
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log('🚀 Server on port ' + PORT);
    initWA().catch(e => console.log('WA init error:', e.message));
});
