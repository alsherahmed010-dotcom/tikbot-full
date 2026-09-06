const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const app = express();
app.use(express.json());
let sock = null;
let isConnected = false;
let lastTargetNumber = "";

app.get('/status', (req, res) => {
    res.json({ connected: isConnected, lastTarget: lastTargetNumber });
});

app.post('/connect', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'رقم الهاتف مطلوب' });
    try {
        const cleanPhone = phoneNumber.replace(/\D/g, '');
        const code = await sock.requestPairingCode(cleanPhone);
        res.json({ status: 'pairing_code_generated', code: code.match(/.{1,4}/g).join('-') });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/send', async (req, res) => {
    const { target, message, count } = req.body;
    if (!isConnected) return res.status(400).json({ error: 'البوت غير متصل' });
    try {
        const targetJid = target.includes('@') ? target : target + '@s.whatsapp.net';
        lastTargetNumber = targetJid;
        res.json({ status: 'sending', target: targetJid });
        await executeSpam(sock, targetJid, message, count || 1);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/send-last', async (req, res) => {
    const { message, count } = req.body;
    if (!lastTargetNumber) return res.status(400).json({ error: 'لا يوجد هدف سابق' });
    res.json({ status: 'sending' });
    await executeSpam(sock, lastTargetNumber, message, count || 1);
});

app.post('/send-group', async (req, res) => {
    const { groupId, message, count } = req.body;
    if (!isConnected) return res.status(400).json({ error: 'البوت غير متصل' });
    res.json({ status: 'sending' });
    await executeSpam(sock, groupId, message, count || 1);
});

app.get('/groups', async (req, res) => {
    if (!isConnected) return res.status(400).json({ error: 'البوت غير متصل' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        res.json(groupList);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Ubuntu", "Chrome", "20.0.0"],
        syncFullHistory: false
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            isConnected = true;
            console.log('✅ تم اتصال الواتساب بنجاح!');
        }
    });
}

async function executeSpam(sock, target, text, count) {
    console.log(`🚀 جاري إرسال ${count} رسالة إلى ${target}`);
    let sentSuccessfully = 0;
    const batchSize = 20;
    for (let i = 0; i < count; i += batchSize) {
        const currentBatch = Math.min(batchSize, count - i);
        const promises = [];
        for (let j = 0; j < currentBatch; j++) {
            const p = sock.sendMessage(target, { text: text })
                .then(() => { sentSuccessfully++; console.log(`✔️ رسالة (${sentSuccessfully}/${count})`); })
                .catch(() => {});
            promises.push(p);
        }
        await Promise.all(promises);
    }
    console.log(`✅ تم الإرسال! ${sentSuccessfully} رسالة`);
    return sentSuccessfully;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    startBot();
});
