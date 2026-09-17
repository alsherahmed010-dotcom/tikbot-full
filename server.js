const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static('public'));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

let waSocket = null, waConnected = false;
let tgClient = null, tgConnected = false;

async function connectWA(phone) {
    const { state, saveCreds } = await useMultiFileAuthState('wa_auth');
    const { version } = await fetchLatestBaileysVersion();
    waSocket = makeWASocket({
        version, auth: state, printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.0"],
        syncFullHistory: false
    });
    waSocket.ev.on('creds.update', saveCreds);

    if (!waSocket.authState.creds.registered && phone) {
        setTimeout(async () => {
            try {
                const code = await waSocket.requestPairingCode(phone.replace(/\D/g, ''));
                io.emit('wa-code', code.match(/.{1,4}/g).join('-'));
            } catch(e) { io.emit('error', 'WA: ' + e.message); }
        }, 3000);
    }

    waSocket.ev.on('connection.update', (u) => {
        if (u.connection === 'open') { waConnected = true; io.emit('wa-status', 'connected'); }
        else if (u.connection === 'close') {
            waConnected = false; io.emit('wa-status', 'disconnected');
            const code = (u.lastDisconnect?.error)?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) setTimeout(() => connectWA(null), 5000);
        }
    });
}

async function connectTG(apiId, apiHash, phone) {
    let ss = '';
    try { ss = fs.readFileSync('tg_session.txt', 'utf8'); } catch(e) {}
    tgClient = new TelegramClient(new StringSession(ss), parseInt(apiId), apiHash, { connectionRetries: 5 });
    try {
        const input = require('input');
        await tgClient.start({
            phoneNumber: async () => phone,
            password: async () => await input.text('2FA: '),
            phoneCode: async () => await input.text('Code: '),
            onError: (e) => io.emit('error', 'TG: ' + e.message)
        });
        fs.writeFileSync('tg_session.txt', tgClient.session.save());
        tgConnected = true;
        io.emit('tg-status', 'connected');
    } catch(e) { io.emit('error', 'TG: ' + e.message); }
}

io.on('connection', (socket) => {
    socket.emit('wa-status', waConnected ? 'connected' : 'disconnected');
    socket.emit('tg-status', tgConnected ? 'connected' : 'disconnected');

    socket.on('wa-connect', (phone) => connectWA(phone));
    socket.on('tg-connect', (d) => connectTG(d.apiId, d.apiHash, d.phone));

    socket.on('wa-spam', async (d) => {
        if (!waConnected) return socket.emit('error', 'WA not connected');
        const target = d.number.includes('@s.whatsapp.net') ? d.number : d.number + '@s.whatsapp.net';
        let sent = 0;
        for (let i = 0; i < d.count; i += 30) {
            const batch = [];
            for (let j = i; j < Math.min(i + 30, d.count); j++) {
                batch.push(waSocket.sendMessage(target, { text: d.message }).then(() => sent++).catch(() => sent++));
            }
            await Promise.all(batch);
            socket.emit('wa-progress', { sent, total: d.count });
        }
        socket.emit('wa-done', sent);
    });

    socket.on('tg-spam', async (d) => {
        if (!tgConnected) return socket.emit('error', 'TG not connected');
        let sent = 0;
        for (let i = 0; i < d.count; i++) {
            try {
                await tgClient.sendMessage(d.target, { message: d.message });
                sent++;
                socket.emit('tg-progress', { sent, total: d.count });
            } catch(e) {
                if (e.message && e.message.includes('FLOOD')) await new Promise(r => setTimeout(r, 5000));
            }
            await new Promise(r => setTimeout(r, 100));
        }
        socket.emit('tg-done', sent);
    });

    socket.on('wa-groups', async () => {
        if (!waConnected) return;
        const g = Object.values(await waSocket.groupFetchAllParticipating());
        socket.emit('wa-groups-list', g.map(x => ({ id: x.id, name: x.subject })));
    });

    socket.on('tg-groups', async () => {
        if (!tgConnected) return;
        const d = await tgClient.getDialogs({});
        const g = d.filter(x => x.isGroup || x.isChannel);
        socket.emit('tg-groups-list', g.map(x => ({ id: String(x.id), name: x.name })));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on ' + PORT));
