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
app.use(express.json({ limit: '100mb' }));
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

const clients = {}, allJobs = {}, msgCache = {}, reconnectTimers = {};

function getClient(sid) {
    if (!clients[sid]) clients[sid] = { waSocket:null, waConnected:false, waAuthState:null, waNeedsPairing:false, waPairingCode:null, waStarting:false, tgClient:null, tgConnected:false, pendingTG:{}, activeJobs:{}, socketIds:new Set(), contactNames:{} };
    return clients[sid];
}
function getSessionDir(sid) {
    const s = String(sid).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,64);
    const d = path.join(SESSIONS_DIR, s);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive:true });
    return d;
}
function getMsgFile(sid) { return path.join(getSessionDir(sid), 'messages.json'); }
function saveMsgsToDisk(sid) { try { fs.writeFileSync(getMsgFile(sid), JSON.stringify(msgCache[sid]||{})); } catch(e){} }
function loadMsgsFromDisk(sid) { try { const f=getMsgFile(sid); if(fs.existsSync(f)) msgCache[sid]=JSON.parse(fs.readFileSync(f,'utf8')); } catch(e){} }
function broadcastJobs() { io.emit('jobs-update', Object.values(allJobs)); }
function emitToSession(sid, ev, data) { const c=clients[sid]; if(!c) return; for(const s of c.socketIds) io.to(s).emit(ev,data); }

function extractText(m) {
    if (!m?.message) return '[media]';
    const x = m.message;
    return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption
        || (x.imageMessage?'[صورة]':null) || (x.videoMessage?'[فيديو]':null) || (x.audioMessage?'[صوت]':null)
        || (x.documentMessage?'[ملف]':null) || (x.stickerMessage?'[ملصق]':null) || '[رسالة]';
}
function formatMsg(m, sid) {
    const c = clients[sid];
    const fj = m.key?.participant || m.key?.remoteJid || '';
    let pn = m.pushName || '';
    if (!pn && fj && c?.contactNames?.[fj]) pn = c.contactNames[fj];
    return { id:m.key?.id||('m_'+Date.now()+Math.random()), from:fj.split('@')[0], fromMe:!!m.key?.fromMe, text:extractText(m), time:Number(m.messageTimestamp)||0, pushName:pn };
}
function addMsgToCache(sid, jid, o) {
    if (!msgCache[sid]) msgCache[sid]={};
    if (!msgCache[sid][jid]) msgCache[sid][jid]=[];
    if (msgCache[sid][jid].find(x=>x.id===o.id)) return false;
    msgCache[sid][jid].push(o);
    if (msgCache[sid][jid].length>2000) msgCache[sid][jid]=msgCache[sid][jid].slice(-2000);
    return true;
}
function getGroupCounts(sid) { const c=msgCache[sid]||{}; return Object.keys(c).map(g=>({id:g,count:c[g].length})); }

async function startWASocket(sid, opts={}) {
    const client = getClient(sid);
    if (client.waStarting && !opts.force) { while(client.waStarting) await new Promise(r=>setTimeout(r,200)); return client.waSocket; }
    client.waStarting = true;
    try {
        const authDir = path.join(getSessionDir(sid), 'wa_auth');
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        client.waAuthState = state;
        const { version } = await fetchLatestBaileysVersion();
        if (client.waSocket && opts.force) {
            try { client.waSocket.ev.removeAllListeners(); } catch(e){}
            try { client.waSocket.end(undefined); } catch(e){}
        }
        const sock = makeWASocket({
            version, auth:state, printQRInTerminal:false,
            logger: pino({ level:'silent' }),
            browser:["Ubuntu","Chrome","20.0.0"],
            syncFullHistory:true, connectTimeoutMs:300000, defaultQueryTimeoutMs:300000,
            keepAliveIntervalMs:25000, retryRequestDelayMs:2000,
            generateHighQualityLinkPreview:false, markOnlineOnConnect:false
        });
        client.waSocket = sock;
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('messages.upsert', ({ messages, type }) => {
            if (type!=='notify' && type!=='append') return;
            let changed = false;
            for (const m of messages) {
                if (!m.message||!m.key) continue;
                const jid = m.key.remoteJid; if (!jid) continue;
                const fmt = formatMsg(m, sid);
                if (addMsgToCache(sid, jid, fmt)) { changed=true; emitToSession(sid,'wa-new-message',{groupId:jid,message:fmt}); }
            }
            if (changed) { saveMsgsToDisk(sid); emitToSession(sid,'wa-cache-update',getGroupCounts(sid)); }
        });
        sock.ev.on('messaging-history.set', ({ messages, contacts }) => {
            let changed = false;
            if (messages) for (const m of messages) {
                if (!m.message||!m.key) continue;
                const jid = m.key.remoteJid; if (!jid) continue;
                if (addMsgToCache(sid, jid, formatMsg(m, sid))) changed=true;
            }
            if (contacts) for (const c of contacts) if (c.id && (c.notify||c.name)) client.contactNames[c.id]=c.notify||c.name;
            if (changed) { saveMsgsToDisk(sid); emitToSession(sid,'wa-cache-update',getGroupCounts(sid)); }
        });
        sock.ev.on('contacts.update', cs => { for (const c of cs) if (c.id && (c.notify||c.name)) client.contactNames[c.id]=c.notify||c.name; });
        sock.ev.on('contacts.set', ({ contacts }) => { for (const c of contacts) if (c.id && (c.notify||c.name)) client.contactNames[c.id]=c.notify||c.name; });
        sock.ev.on('connection.update', u => {
            const { connection, lastDisconnect } = u;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('📡 WA:', sid, connection, 'code:', code);
            if (connection==='open') {
                client.waConnected = true; client.waNeedsPairing = false; client.waPairingCode = null;
                emitToSession(sid,'wa-status','connected');
            } else if (connection==='close') {
                client.waConnected = false;
                if (code===DisconnectReason.loggedOut) {
                    client.waSocket=null; client.waAuthState=null; client.waNeedsPairing=false; client.waPairingCode=null;
                    if (fs.existsSync(authDir)) try { fs.rmSync(authDir,{recursive:true,force:true}); } catch(e){}
                    emitToSession(sid,'wa-status','logged_out'); return;
                }
                if (code===440) { client.waSocket=null; emitToSession(sid,'wa-status','disconnected'); return; }
                client.waSocket = null;
                emitToSession(sid,'wa-status','reconnecting');
                const delay = (code===515||code===DisconnectReason.restartRequired)?2000:5000;
                if (reconnectTimers[sid]) clearTimeout(reconnectTimers[sid]);
                reconnectTimers[sid] = setTimeout(()=>{ delete reconnectTimers[sid]; startWASocket(sid,{force:true}).catch(()=>{}); }, delay);
            } else if (connection==='connecting') emitToSession(sid,'wa-status','connecting');
        });
        return sock;
    } finally { client.waStarting = false; }
}

async function requestWACode(sid, phone) {
    const client = getClient(sid);
    if (client.waAuthState?.creds?.registered) return { error:'الرقم مسجل' };
    const authDir = path.join(getSessionDir(sid), 'wa_auth');
    if (client.waSocket) { try{client.waSocket.ev.removeAllListeners();}catch(e){} try{client.waSocket.end(undefined);}catch(e){} client.waSocket=null; client.waAuthState=null; }
    if (fs.existsSync(authDir)) try{fs.rmSync(authDir,{recursive:true,force:true});}catch(e){}
    const clean = String(phone).replace(/\D/g,'');
    if (clean.length<8) return { error:'رقم غير صحيح' };
    await startWASocket(sid, { force:true });
    let t=0; while(!client.waSocket && t<20){ await new Promise(r=>setTimeout(r,500)); t++; }
    if (!client.waSocket) return { error:'Socket timeout' };
    await new Promise(r=>setTimeout(r,3000));
    try {
        const code = await client.waSocket.requestPairingCode(clean);
        client.waPairingCode = code.match(/.{1,4}/g).join('-');
        client.waNeedsPairing = true;
        return { code: client.waPairingCode };
    } catch(e) { return { error:e.message }; }
}

async function manualReconnect(sid) {
    const client = getClient(sid);
    if (!client.waAuthState?.creds?.registered) return { needPairing:true };
    client.waConnected = false;
    await startWASocket(sid, { force:true });
    return { ok:true };
}

async function logoutWA(sid) {
    try {
        const client = getClient(sid);
        if (reconnectTimers[sid]) { clearTimeout(reconnectTimers[sid]); delete reconnectTimers[sid]; }
        if (client.waSocket) { try{client.waSocket.ev.removeAllListeners();}catch(e){} try{await client.waSocket.logout();}catch(e){} try{client.waSocket.end(undefined);}catch(e){} client.waSocket=null; }
        client.waConnected=false; client.waAuthState=null; client.waNeedsPairing=false; client.waPairingCode=null;
        delete msgCache[sid];
        const authDir = path.join(getSessionDir(sid), 'wa_auth');
        if (fs.existsSync(authDir)) fs.rmSync(authDir,{recursive:true,force:true});
        const mf = getMsgFile(sid); if (fs.existsSync(mf)) fs.unlinkSync(mf);
        emitToSession(sid,'wa-status','disconnected');
        return { success:true };
    } catch(e) { return { error:e.message }; }
}

async function ensureTGClient(sid) {
    const client = getClient(sid);
    if (client.tgClient && client.tgClient.connected) return client.tgClient;
    const sf = path.join(getSessionDir(sid), 'tg_session.txt');
    let ss=''; try{ss=fs.readFileSync(sf,'utf8').trim();}catch(e){}
    const tg = new TelegramClient(new StringSession(ss), TG_API_ID, TG_API_HASH, { connectionRetries:10, useWSS:true, timeout:120000, requestRetries:5, autoReconnect:false, retryDelay:2000 });
    await tg.connect();
    client.tgClient = tg;
    return tg;
}
async function initTG(sid, phone, socket) {
    try {
        const client = getClient(sid);
        const tg = await ensureTGClient(sid);
        if (await tg.checkAuthorization()) { client.tgConnected=true; socket.emit('tg-status','connected'); socket.emit('tg-code-status','✅ متصل بالفعل!'); return { alreadyConnected:true }; }
        const r = await tg.invoke(new Api.auth.SendCode({ phoneNumber:phone, apiId:TG_API_ID, apiHash:TG_API_HASH, settings:new Api.CodeSettings({allowFlashCall:false,currentNumber:false,allowAppHash:true}) }));
        client.pendingTG[phone] = { phoneCodeHash:r.phoneCodeHash, phone };
        socket.emit('tg-code-status','📩 تم إرسال الكود');
        socket.emit('tg-need-code');
        return { needCode:true };
    } catch(e) { return { error:e.message }; }
}
async function verifyTGCode(sid, phone, code, socket) {
    try {
        const client = getClient(sid);
        if (!client.tgClient || !client.pendingTG[phone]) return { error:'no pending' };
        const { phoneCodeHash } = client.pendingTG[phone];
        try { await client.tgClient.invoke(new Api.auth.SignIn({ phoneNumber:phone, phoneCodeHash, phoneCode:code })); }
        catch(e) { if (String(e.message).includes('SESSION_PASSWORD_NEEDED')) { socket.emit('tg-need-password'); return { needPassword:true }; } throw e; }
        client.tgConnected = true;
        fs.writeFileSync(path.join(getSessionDir(sid),'tg_session.txt'), client.tgClient.session.save());
        delete client.pendingTG[phone];
        socket.emit('tg-status','connected'); socket.emit('tg-code-status','✅ تم الاتصال!');
        return { success:true };
    } catch(e) { return { error:e.message }; }
}
async function verifyTGPassword(sid, phone, password, socket) {
    try {
        const client = getClient(sid);
        const pi = await client.tgClient.invoke(new Api.account.GetPassword());
        const pc = await computeCheck(pi, password);
        await client.tgClient.invoke(new Api.auth.CheckPassword({ password:pc }));
        client.tgConnected = true;
        fs.writeFileSync(path.join(getSessionDir(sid),'tg_session.txt'), client.tgClient.session.save());
        delete client.pendingTG[phone];
        socket.emit('tg-status','connected'); socket.emit('tg-code-status','✅ تم الاتصال!');
        return { success:true };
    } catch(e) { return { error:e.message }; }
}
async function logoutTG(sid) {
    try {
        const client = getClient(sid);
        if (client.tgClient) { try{await client.tgClient.logOut();}catch(e){} try{await client.tgClient.disconnect();}catch(e){} }
        client.tgClient=null; client.tgConnected=false;
        const sf = path.join(getSessionDir(sid),'tg_session.txt'); if (fs.existsSync(sf)) fs.unlinkSync(sf);
        emitToSession(sid,'tg-status','disconnected');
        return { success:true };
    } catch(e) { return { error:e.message }; }
}

app.post('/api/wipe-sessions', async (req, res) => {
    try {
        for (const sid in clients) {
            const c = clients[sid];
            if (c.waSocket) { try{c.waSocket.ev.removeAllListeners();}catch(e){} try{c.waSocket.end(undefined);}catch(e){} }
            if (c.tgClient) try{await c.tgClient.disconnect();}catch(e){}
            delete clients[sid];
        }
        for (const k in reconnectTimers) { clearTimeout(reconnectTimers[k]); delete reconnectTimers[k]; }
        if (fs.existsSync(SESSIONS_DIR)) { fs.rmSync(SESSIONS_DIR,{recursive:true,force:true}); fs.mkdirSync(SESSIONS_DIR,{recursive:true}); }
        for (const k in allJobs) delete allJobs[k];
        for (const k in msgCache) delete msgCache[k];
        broadcastJobs();
        res.json({ success:true });
    } catch(e) { res.status(500).json({ error:e.message }); }
});

io.on('connection', (socket) => {
    socket.emit('jobs-update', Object.values(allJobs));
    socket.on('register-session', async (sid) => {
        sid = String(sid).trim(); if (!sid) return;
        if (socket.sessionId && clients[socket.sessionId]) clients[socket.sessionId].socketIds.delete(socket.id);
        socket.sessionId = sid;
        const client = getClient(sid);
        client.socketIds.add(socket.id);
        if (!msgCache[sid]) loadMsgsFromDisk(sid);
        socket.emit('tg-status', client.tgConnected?'connected':'disconnected');
        const hasCreds = fs.existsSync(path.join(getSessionDir(sid),'wa_auth','creds.json'));
        if (client.waConnected && client.waSocket) socket.emit('wa-status','connected');
        else if (client.waSocket) socket.emit('wa-status','reconnecting');
        else if (hasCreds) socket.emit('wa-status','session_exists');
        else socket.emit('wa-status','disconnected');
        socket.emit('wa-cache-update', getGroupCounts(sid));
        if (client.waNeedsPairing && client.waPairingCode && !client.waConnected) { socket.emit('wa-code', client.waPairingCode); socket.emit('wa-code-status','🔑 الكود جاهز'); }
        if (!client.tgClient) ensureTGClient(sid).then(async tg => { if (await tg.checkAuthorization()) { client.tgConnected=true; socket.emit('tg-status','connected'); } }).catch(()=>{});
        else if (client.tgConnected) socket.emit('tg-status','connected');
    });
    socket.on('disconnect', () => { if (socket.sessionId && clients[socket.sessionId]) clients[socket.sessionId].socketIds.delete(socket.id); });
    socket.on('wa-connect', async (phone) => {
        if (!socket.sessionId) return socket.emit('error','No session');
        socket.emit('wa-code-status','⏳ جاري طلب الكود...');
        const r = await requestWACode(socket.sessionId, phone);
        if (r.code) { socket.emit('wa-code', r.code); socket.emit('wa-code-status','✅ أدخل الكود في واتساب'); }
        else socket.emit('wa-code-status','❌ '+r.error);
    });
    socket.on('wa-reconnect', async () => {
        if (!socket.sessionId) return;
        socket.emit('wa-code-status','🔄 جاري إعادة الاتصال...');
        const r = await manualReconnect(socket.sessionId);
        if (r.ok) socket.emit('wa-code-status','✅ بدأ الاتصال');
        else if (r.needPairing) socket.emit('wa-code-status','❌ الرقم مش مربوط');
        else socket.emit('wa-code-status','❌ فشل');
    });
    socket.on('wa-logout', async () => { if (!socket.sessionId) return; await logoutWA(socket.sessionId); socket.emit('wa-status','logged_out'); socket.emit('logout-done','whatsapp'); });

    // ═════ TEXT SPAM ═════
    socket.on('wa-spam', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.waSocket) {
            if (client.waAuthState?.creds?.registered) { await startWASocket(socket.sessionId,{force:true}); let t=0; while((!client.waConnected||!client.waSocket)&&t<20){await new Promise(r=>setTimeout(r,500));t++;} }
            if (!client.waConnected||!client.waSocket) return socket.emit('error','WA not connected — اضغط إعادة الاتصال');
        }
        const raw = String(d.number).trim();
        const isGroup = raw.includes('@g.us');
        let target, finalDisplay = raw;
        if (isGroup || raw.includes('@s.whatsapp.net')) target = raw;
        else {
            const clean = raw.replace(/\D/g,'');
            if (clean.length<8) return socket.emit('error','رقم غير صحيح');
            try { const r = await client.waSocket.onWhatsApp(clean); if (!r||!r.length) return socket.emit('error','❌ الرقم مش عنده واتساب'); target=r[0].jid; finalDisplay=clean; }
            catch(e) { target = clean+'@s.whatsapp.net'; finalDisplay=clean; }
        }
        const jobId = 'wa_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
        allJobs[jobId] = { id:jobId, sessionId:socket.sessionId, type:'whatsapp', target:finalDisplay.split('@')[0], message:d.message, count:d.count, sent:0, failed:0, isGroup, status:'running', startTime:Date.now() };
        client.activeJobs[jobId] = { cancel:false };
        broadcastJobs();
        const BATCH = isGroup?1:10, DELAY = isGroup?100:0;
        let sent=0, failed=0;
        try {
            for (let i=0; i<d.count; i+=BATCH) {
                if (client.activeJobs[jobId]?.cancel) { allJobs[jobId].status='stopped'; break; }
                if (!client.waSocket) { allJobs[jobId].status='error'; break; }
                const bs = Math.min(BATCH, d.count-i), ps = [];
                for (let j=0;j<bs;j++) ps.push(client.waSocket.sendMessage(target,{text:d.message}).then(()=>{sent++;}).catch(()=>{sent++;failed++;}));
                await Promise.all(ps);
                allJobs[jobId].sent = sent; allJobs[jobId].failed = failed; broadcastJobs();
                if (DELAY>0) await new Promise(r=>setTimeout(r,DELAY));
            }
        } catch(e) { allJobs[jobId].status='error'; allJobs[jobId].error=e.message; }
        if (allJobs[jobId].status==='running') allJobs[jobId].status='done';
        broadcastJobs(); delete client.activeJobs[jobId];
    });

    // ═════ MEDIA SPAM ═════
    socket.on('wa-spam-media', async (d) => {
        console.log('🎬 wa-spam-media received. files:', d.files?.length);
        const client = getClient(socket.sessionId);
        if (!client.waSocket) {
            if (client.waAuthState?.creds?.registered) { await startWASocket(socket.sessionId,{force:true}); let t=0; while((!client.waConnected||!client.waSocket)&&t<20){await new Promise(r=>setTimeout(r,500));t++;} }
            if (!client.waConnected||!client.waSocket) return socket.emit('error','WA not connected');
        }
        const raw = String(d.number).trim();
        const isGroup = raw.includes('@g.us');
        let target, finalDisplay = raw;
        if (isGroup || raw.includes('@s.whatsapp.net')) target = raw;
        else {
            const clean = raw.replace(/\D/g,'');
            if (clean.length<8) return socket.emit('error','رقم غير صحيح');
            try { const r = await client.waSocket.onWhatsApp(clean); if (!r||!r.length) return socket.emit('error','❌ الرقم مش عنده واتساب'); target=r[0].jid; finalDisplay=clean; }
            catch(e) { target = clean+'@s.whatsapp.net'; finalDisplay=clean; }
        }
        const files = Array.isArray(d.files) ? d.files : [];
        if (!files.length) return socket.emit('error','مفيش ملفات');
        const repeatEach = Math.max(1, parseInt(d.repeatEach)||1);
        const caption = d.caption || '';
        const jobId = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
        let totalMsgs = 0;
        for (const f of files) totalMsgs += (f.count || repeatEach);
        allJobs[jobId] = { id:jobId, sessionId:socket.sessionId, type:'whatsapp-media', target:finalDisplay.split('@')[0], message:(caption||'[وسائط]').slice(0,40), count:totalMsgs, sent:0, failed:0, isGroup, files:files.length, status:'running', startTime:Date.now() };
        client.activeJobs[jobId] = { cancel:false };
        broadcastJobs();
        const DELAY = isGroup?500:100;
        let sent=0, failed=0;
        try {
            for (const f of files) {
                if (client.activeJobs[jobId]?.cancel) break;
                const mt = String(f.mimetype||'');
                const isVideo = mt.startsWith('video/');
                const buffer = Buffer.from(f.buffer);
                const payload = isVideo ? { video:buffer, caption, mimetype:mt } : { image:buffer, caption, mimetype:mt };
                const times = Math.max(1, parseInt(f.count||repeatEach));
                console.log('🎬 Sending', f.name, 'x', times, '('+buffer.length+' bytes)');
                for (let k=0; k<times; k++) {
                    if (client.activeJobs[jobId]?.cancel) break;
                    if (!client.waSocket) break;
                    try { await client.waSocket.sendMessage(target, payload); sent++; }
                    catch(e) { failed++; console.log('send err:', e.message); }
                    allJobs[jobId].sent = sent; allJobs[jobId].failed = failed; broadcastJobs();
                    await new Promise(r=>setTimeout(r,DELAY));
                }
            }
        } catch(e) { allJobs[jobId].status='error'; allJobs[jobId].error=e.message; }
        if (allJobs[jobId].status==='running') allJobs[jobId].status='done';
        broadcastJobs(); delete client.activeJobs[jobId];
    });

    socket.on('wa-stop', (jid) => { const c=getClient(socket.sessionId); if(c.activeJobs[jid]) c.activeJobs[jid].cancel=true; });

    socket.on('wa-groups', async () => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected) return socket.emit('error','WA not connected');
        try {
            const g = Object.values(await client.waSocket.groupFetchAllParticipating());
            const cache = msgCache[socket.sessionId]||{};
            socket.emit('wa-groups-list', g.map(x=>({ id:x.id, name:x.subject, count:(cache[x.id]||[]).length })));
        } catch(e) { socket.emit('error', e.message); }
    });
    socket.on('wa-group-messages', async (gid) => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected) return socket.emit('error','WA not connected');
        if (!msgCache[socket.sessionId]) loadMsgsFromDisk(socket.sessionId);
        let msgs = [...(msgCache[socket.sessionId]?.[gid]||[])];
        try {
            const stored = await client.waSocket.loadMessages(gid, 200);
            if (stored) for (const m of stored) { if (m.message && m.key && !msgs.find(x=>x.id===m.key.id)) msgs.push(formatMsg(m, socket.sessionId)); }
        } catch(e) {}
        msgs.sort((a,b)=>(a.time||0)-(b.time||0));
        if (!msgCache[socket.sessionId]) msgCache[socket.sessionId]={};
        msgCache[socket.sessionId][gid] = msgs;
        socket.emit('wa-group-messages-list', { groupId:gid, messages:msgs, count:msgs.length });
    });
    socket.on('wa-group-send', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.waConnected || !client.waSocket) return socket.emit('error','WA not connected');
        const count = Math.max(1, parseInt(d.count)||1);
        let ok=0, failed=0;
        for (let i=0; i<count; i++) {
            try {
                await client.waSocket.sendMessage(d.groupId, { text:d.text });
                const entry = { id:'local_'+Date.now()+'_'+i, from:'me', fromMe:true, text:d.text, time:Math.floor(Date.now()/1000), pushName:'أنت' };
                if (!msgCache[socket.sessionId]) msgCache[socket.sessionId]={};
                if (!msgCache[socket.sessionId][d.groupId]) msgCache[socket.sessionId][d.groupId]=[];
                msgCache[socket.sessionId][d.groupId].push(entry);
                socket.emit('wa-group-send-ok', { groupId:d.groupId, ...entry, index:i+1, total:count });
                ok++;
            } catch(e) { failed++; }
            if (i<count-1) await new Promise(r=>setTimeout(r,100));
        }
        saveMsgsToDisk(socket.sessionId);
        socket.emit('wa-group-send-done', { groupId:d.groupId, ok, failed, total:count });
    });

    // ═════ TELEGRAM ═════
    socket.on('tg-connect', async (d) => { if (!socket.sessionId) return; socket.emit('tg-code-status','⏳ جاري إرسال الكود...'); const r = await initTG(socket.sessionId, d.phone, socket); if (r.error) socket.emit('tg-code-status','❌ '+r.error); });
    socket.on('tg-verify', async (d) => { const r = await verifyTGCode(socket.sessionId, d.phone, d.code, socket); if (r.error) socket.emit('tg-code-status','❌ '+r.error); });
    socket.on('tg-verify-pass', async (d) => { const r = await verifyTGPassword(socket.sessionId, d.phone, d.password, socket); if (r.error) socket.emit('tg-code-status','❌ '+r.error); });
    socket.on('tg-logout', async () => { await logoutTG(socket.sessionId); socket.emit('tg-status','disconnected'); socket.emit('logout-done','telegram'); });
    socket.on('tg-spam', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.tgConnected || !client.tgClient) return socket.emit('error','TG not connected');
        const jobId = 'tg_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
        allJobs[jobId] = { id:jobId, sessionId:socket.sessionId, type:'telegram', target:d.target, message:d.message, count:d.count, sent:0, failed:0, status:'running', startTime:Date.now() };
        client.activeJobs[jobId] = { cancel:false };
        broadcastJobs();
        let sc=0, ac=0;
        const MAX = d.count*3;
        try {
            while (sc<d.count && ac<MAX) {
                if (client.activeJobs[jobId]?.cancel) { allJobs[jobId].status='stopped'; break; }
                ac++;
                try { await client.tgClient.sendMessage(d.target,{message:d.message}); sc++; allJobs[jobId].sent=sc; }
                catch(e) { allJobs[jobId].failed++; if (String(e.message).includes('FLOOD')) await new Promise(r=>setTimeout(r,3000)); }
                broadcastJobs();
                await new Promise(r=>setTimeout(r,100));
            }
        } catch(e) { allJobs[jobId].status='error'; allJobs[jobId].error=e.message; }
        if (allJobs[jobId].status==='running') allJobs[jobId].status='done';
        broadcastJobs(); delete client.activeJobs[jobId];
    });
    socket.on('tg-spam-media', async (d) => {
        const client = getClient(socket.sessionId);
        if (!client.tgConnected || !client.tgClient) return socket.emit('error','TG not connected');
        const files = Array.isArray(d.files) ? d.files : [];
        if (!files.length) return socket.emit('error','مفيش ملفات');
        const repeatEach = Math.max(1, parseInt(d.repeatEach)||1);
        const caption = d.caption || '';
        const jobId = 'tgm_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
        let totalMsgs = 0;
        for (const f of files) totalMsgs += (f.count || repeatEach);
        allJobs[jobId] = { id:jobId, sessionId:socket.sessionId, type:'telegram-media', target:d.target, message:(caption||'[وسائط]').slice(0,40), count:totalMsgs, sent:0, failed:0, files:files.length, status:'running', startTime:Date.now() };
        client.activeJobs[jobId] = { cancel:false };
        broadcastJobs();
        let sent=0, failed=0;
        try {
            for (const f of files) {
                if (client.activeJobs[jobId]?.cancel) break;
                const buffer = Buffer.from(f.buffer);
                const times = Math.max(1, parseInt(f.count||repeatEach));
                for (let k=0; k<times; k++) {
                    if (client.activeJobs[jobId]?.cancel) break;
                    try { await client.tgClient.sendFile(d.target, { file:buffer, caption, forceDocument:false }); sent++; }
                    catch(e) { failed++; if (String(e.message).includes('FLOOD')) await new Promise(r=>setTimeout(r,3000)); }
                    allJobs[jobId].sent=sent; allJobs[jobId].failed=failed; broadcastJobs();
                    await new Promise(r=>setTimeout(r,500));
                }
            }
        } catch(e) { allJobs[jobId].status='error'; allJobs[jobId].error=e.message; }
        if (allJobs[jobId].status==='running') allJobs[jobId].status='done';
        broadcastJobs(); delete client.activeJobs[jobId];
    });
    socket.on('tg-stop', (jid) => { const c=getClient(socket.sessionId); if(c.activeJobs[jid]) c.activeJobs[jid].cancel=true; });
    socket.on('tg-groups', async () => {
        const client = getClient(socket.sessionId);
        if (!client.tgConnected) return socket.emit('error','TG not connected');
        try {
            const d = await client.tgClient.getDialogs({});
            const g = d.filter(x=>x.isGroup||x.isChannel);
            socket.emit('tg-groups-list', g.map(x=>({ id:String(x.id), name:x.title||x.name })));
        } catch(e) { socket.emit('error', e.message); }
    });
    socket.on('clear-jobs', () => { for (const k in allJobs) if (allJobs[k].sessionId===socket.sessionId) delete allJobs[k]; broadcastJobs(); });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log('🚀 Server on port ' + PORT));
process.on('uncaughtException', e => console.log('⚠️', e.message));
process.on('unhandledRejection', e => console.log('⚠️', e));
