const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    pingTimeout: 600000,
    pingInterval: 25000,
    maxHttpBufferSize: 200 * 1024 * 1024,
    transports: ['websocket', 'polling']
});
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const PROXIES_FILE = path.join(__dirname, 'proxies.json');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const clients = {}, allJobs = {}, msgCache = {}, reconnectTimers = {}, jobPayloads = {};

let proxies = [];
try { if (fs.existsSync(PROXIES_FILE)) proxies = JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf8')); } catch(e){}
function saveProxies(){ try { fs.writeFileSync(PROXIES_FILE, JSON.stringify(proxies)); } catch(e){} }

// ═══════════ 🔍 اختبار البروكسي السريع ═══════════
async function testProxy(proxyUrl, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        let resolved = false;
        const done = (ok, reason) => {
            if (resolved) return;
            resolved = true;
            resolve({ ok, ms: Date.now() - startTime, reason, url: proxyUrl });
        };
        setTimeout(() => done(false, 'timeout'), timeoutMs);

        try {
            let agent;
            if (proxyUrl.startsWith('socks')) agent = new SocksProxyAgent(proxyUrl);
            else agent = new HttpsProxyAgent(proxyUrl);

            const testUrl = 'https://web.whatsapp.com/favicon.ico';
            const req = (testUrl.startsWith('https') ? require('https') : require('http')).get(testUrl, { agent, timeout: timeoutMs }, (res) => {
                res.resume();
                if (res.statusCode >= 200 && res.statusCode < 500) done(true, 'ok');
                else done(false, 'status_' + res.statusCode);
            });
            req.on('error', (e) => done(false, e.message));
            req.on('timeout', () => { req.destroy(); done(false, 'req_timeout'); });
            req.setTimeout(timeoutMs);
        } catch(e) {
            done(false, e.message);
        }
    });
}

// 🌐 اختبار كل البروكسيات وتصفية الشغال
async function getWorkingProxy() {
    if (!proxies.length) return null;
    // اختبر البروكسيات بالتوازي — أول واحد ينجح
    const results = await Promise.all(proxies.map(async (p) => {
        if (!p.active) return null;
        const r = await testProxy(p.url, 6000);
        if (r.ok) console.log('✅ Proxy OK:', p.url, r.ms + 'ms');
        else console.log('❌ Proxy FAIL:', p.url, r.reason);
        return r.ok ? { ...p, ms: r.ms } : null;
    }));
    const working = results.filter(Boolean);
    if (!working.length) return null;
    // رتب حسب السرعة
    working.sort((a, b) => a.ms - b.ms);
    return working[0];
}

function getProxyAgent(proxyUrl){
    if(!proxyUrl) return undefined;
    try {
        if(proxyUrl.startsWith('socks')) return new SocksProxyAgent(proxyUrl);
        return new HttpsProxyAgent(proxyUrl);
    } catch(e) { return undefined; }
}

function getClient(sid) {
    if (!clients[sid]) clients[sid] = {
        waSocket:null, waConnected:false, waAuthState:null,
        waNeedsPairing:false, waPairingCode:null, waStarting:false,
        activeJobs:{}, socketIds:new Set(), contactNames:{},
        sentCount: 0, failedCount: 0, currentProxy: null,
        waBlocked: false, blockReason: null,
        deliveryTracking: {}  // { msgId: { jobId, at } }
    };
    return clients[sid];
}
function getSessionDir(sid) {
    const s = String(sid).replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,64);
    const d = path.join(SESSIONS_DIR, s);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
}
function getMsgFile(sid){ return path.join(getSessionDir(sid), 'messages.json'); }
function saveMsgs(sid){ try{ fs.writeFileSync(getMsgFile(sid), JSON.stringify(msgCache[sid]||{})); }catch(e){} }
function loadMsgs(sid){ try{ const f=getMsgFile(sid); if(fs.existsSync(f)) msgCache[sid]=JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){} }
function broadcastJobs(){ io.emit('jobs-update', Object.values(allJobs)); }
function emit(sid, ev, data){ const c=clients[sid]; if(!c) return; for(const s of c.socketIds) io.to(s).emit(ev,data); }

function extractText(m){
    if(!m?.message) return '[media]';
    const x = m.message;
    return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption
        || (x.imageMessage?'[صورة]':null) || (x.videoMessage?'[فيديو]':null) || (x.audioMessage?'[صوت]':null)
        || (x.documentMessage?'[ملف]':null) || (x.stickerMessage?'[ملصق]':null) || '[رسالة]';
}
function fmtMsg(m, sid){
    const c = clients[sid];
    const fj = m.key?.participant || m.key?.remoteJid || '';
    let pn = m.pushName || '';
    if(!pn && fj && c?.contactNames?.[fj]) pn = c.contactNames[fj];
    return { id:m.key?.id||('m_'+Date.now()+Math.random()), from:fj.split('@')[0], fromMe:!!m.key?.fromMe, text:extractText(m), time:Number(m.messageTimestamp)||0, pushName:pn };
}
function addMsg(sid, jid, o){
    if(!msgCache[sid]) msgCache[sid]={};
    if(!msgCache[sid][jid]) msgCache[sid][jid]=[];
    if(msgCache[sid][jid].find(x=>x.id===o.id)) return false;
    msgCache[sid][jid].push(o);
    if(msgCache[sid][jid].length>2000) msgCache[sid][jid]=msgCache[sid][jid].slice(-2000);
    return true;
}
function counts(sid){ const c=msgCache[sid]||{}; return Object.keys(c).map(g=>({id:g,count:c[g].length})); }

function varyMessage(text){
    const zw = ['\u200B','\u200C','\u200D','\uFEFF'];
    const r = Math.floor(Math.random() * 3);
    if(r === 0) return text;
    if(r === 1) return zw[Math.floor(Math.random()*zw.length)] + text;
    return text + zw[Math.floor(Math.random()*zw.length)];
}
function randomDelay(baseMs){ return baseMs + Math.floor(Math.random() * baseMs); }

// 🌐 إنشاء WA socket مع اختبار بروكسي ذكي
async function startWA(sid, opts={}){
    const client = getClient(sid);
    if(client.waStarting && !opts.force){ while(client.waStarting) await new Promise(r=>setTimeout(r,200)); return client.waSocket; }
    client.waStarting = true;
    try {
        const authDir = path.join(getSessionDir(sid), 'wa_auth');
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        client.waAuthState = state;
        const { version } = await fetchLatestBaileysVersion();
        if(client.waSocket && opts.force){
            try{ client.waSocket.ev.removeAllListeners(); }catch(e){}
            try{ client.waSocket.end(undefined); }catch(e){}
        }

        // 🌐 اختبار البروكسي — لو شغال استخدمه، لو علق تجاهله
        let agent, proxyUsed = null;
        if(proxies.length && opts.useProxy !== false){
            emit(sid, 'wa-code-status', '🌐 جاري اختبار البروكسيات...');
            console.log('🌐 Testing', proxies.length, 'proxies...');
            const working = await getWorkingProxy();
            if(working){
                agent = getProxyAgent(working.url);
                proxyUsed = working.url;
                client.currentProxy = working.url;
                console.log('✅ Using proxy:', working.url, '(' + working.ms + 'ms)');
                emit(sid, 'proxy-status', { url: working.url, ms: working.ms, ok: true });
            } else {
                client.currentProxy = null;
                console.log('⚠️ No working proxies — using direct connection');
                emit(sid, 'proxy-status', { ok: false, msg: 'البروكسيات مش شغالة — استخدام اتصال مباشر' });
                emit(sid, 'wa-code-status', '⚠️ البروكسيات فشلت — اتصال مباشر');
            }
        }

        const sockOpts = {
            version, auth:state, printQRInTerminal:false,
            logger: pino({ level:'silent' }),
            browser:["Ubuntu","Chrome","20.0.0"],
            syncFullHistory:true,
            connectTimeoutMs: 600000,          // ⏱️ 10 دقايق
            defaultQueryTimeoutMs: 300000,     // 5 دقايق
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 3000,
            generateHighQualityLinkPreview:false,
            markOnlineOnConnect:false
        };
        if(agent) sockOpts.agent = agent;

        const sock = makeWASocket(sockOpts);
        client.waSocket = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', ({ messages, type })=>{
            if(type!=='notify' && type!=='append') return;
            let ch = false;
            for(const m of messages){
                if(!m.message||!m.key) continue;
                const jid = m.key.remoteJid; if(!jid) continue;
                const fm = fmtMsg(m, sid);
                if(addMsg(sid, jid, fm)){ ch=true; emit(sid,'wa-new-message',{groupId:jid,message:fm}); }
            }
            if(ch){ saveMsgs(sid); emit(sid,'wa-cache-update',counts(sid)); }
        });
        sock.ev.on('messaging-history.set', ({ messages, contacts })=>{
            let ch = false;
            if(messages) for(const m of messages){
                if(!m.message||!m.key) continue;
                const jid = m.key.remoteJid; if(!jid) continue;
                if(addMsg(sid, jid, fmtMsg(m, sid))) ch=true;
            }
            if(contacts) for(const c of contacts) if(c.id && (c.notify||c.name)) client.contactNames[c.id]=c.notify||c.name;
            if(ch){ saveMsgs(sid); emit(sid,'wa-cache-update',counts(sid)); }
        });

        // ✅ استقبال تأكيدات التسليم الفعلية
        sock.ev.on('message-receipt.update', (receipts) => {
            try {
                for (const r of receipts) {
                    const msgId = r.key?.id;
                    if (!msgId) continue;
                    const track = client.deliveryTracking[msgId];
                    if (track) {
                        // تأكيد التسليم الفعلي
                        if (r.receipt?.receiptTimestamp || r.receipt?.readTimestamp) {
                            emit(sid, 'msg-confirmed', { jobId: track.jobId, msgId });
                        }
                        delete client.deliveryTracking[msgId];
                    }
                }
            } catch(e) {}
        });
        // تحديثات الرسائل (تأكيد إضافي)
        sock.ev.on('messages.update', (updates) => {
            try {
                for (const u of updates) {
                    const msgId = u.key?.id;
                    if (!msgId) continue;
                    const track = client.deliveryTracking[msgId];
                    if (track) {
                        const status = u.update?.status;
                        // 3 = DELIVERY_ACK, 4 = READ, 5 = PLAYED
                        if (status >= 3) {
                            emit(sid, 'msg-confirmed', { jobId: track.jobId, msgId });
                            delete client.deliveryTracking[msgId];
                        }
                    }
                }
            } catch(e) {}
        });
        sock.ev.on('contacts.update', cs=>{ for(const c of cs) if(c.id && (c.notify||c.name)) client.contactNames[c.id]=c.notify||c.name; });
        sock.ev.on('contacts.set', ({ contacts })=>{ for(const c of contacts) if(c.id && (c.notify||c.name)) client.contactNames[c.id]=c.notify||c.name; });

        sock.ev.on('connection.update', u=>{
            const { connection, lastDisconnect } = u;
            const code = lastDisconnect?.error?.output?.statusCode;
            console.log('📡 WA:', sid, connection, 'code:', code, 'proxy:', proxyUsed || 'none');
            if(connection==='open'){
                client.waConnected = true; client.waNeedsPairing = false; client.waPairingCode = null;
                client.waBlocked = false; client.blockReason = null;
                emit(sid,'wa-status','connected');
                emit(sid, 'proxy-status', proxyUsed ? { url: proxyUsed, ok: true, active: true } : { ok: true, direct: true, msg: 'اتصال مباشر' });
                setTimeout(()=>resumeJobs(sid).catch(()=>{}), 2000);
            } else if(connection==='close'){
                client.waConnected = false;

                // 🚨 403 = banned, 428 = throttled
                if(code === 403){
                    client.waBlocked = true;
                    client.blockReason = 'رقمك محظور من واتساب (403)';
                    emit(sid, 'wa-blocked', { reason: client.blockReason, code: 403 });
                    emit(sid,'wa-status','banned');
                    return;
                }
                if(code === 428){
                    client.waBlocked = true;
                    client.blockReason = 'واتساب أوقف الجلسة مؤقتاً (428 - Rate Limit)';
                    emit(sid, 'wa-blocked', { reason: client.blockReason, code: 428 });
                    emit(sid,'wa-status','throttled');
                    return;
                }
                if(code === 429){
                    client.waBlocked = true;
                    client.blockReason = 'تم تجاوز الحد المسموح (429 - Too Many Requests)';
                    emit(sid, 'wa-blocked', { reason: client.blockReason, code: 429 });
                    emit(sid,'wa-status','throttled');
                    return;
                }

                if(code===DisconnectReason.loggedOut || code===401){
                    client.waSocket=null; client.waAuthState=null; client.waNeedsPairing=false; client.waPairingCode=null;
                    if(fs.existsSync(authDir)) try{ fs.rmSync(authDir,{recursive:true,force:true}); }catch(e){}
                    emit(sid,'wa-status','logged_out'); return;
                }
                if(code===440){ client.waSocket=null; emit(sid,'wa-status','disconnected'); return; }
                client.waSocket = null;
                emit(sid,'wa-status','reconnecting');
                const delay = (code===515||code===DisconnectReason.restartRequired)?3000:7000;
                if(reconnectTimers[sid]) clearTimeout(reconnectTimers[sid]);
                reconnectTimers[sid] = setTimeout(()=>{ delete reconnectTimers[sid]; startWA(sid,{force:true}).catch(()=>{}); }, delay);
            } else if(connection==='connecting') emit(sid,'wa-status','connecting');
        });
        return sock;
    } finally { client.waStarting = false; }
}

async function requestCode(sid, phone){
    const client = getClient(sid);
    const clean = String(phone).replace(/\D/g,'');
    if(clean.length < 8) return { error:'رقم غير صحيح' };
    if(client.waSocket){
        try{ client.waSocket.ev.removeAllListeners(); }catch(e){}
        try{ client.waSocket.end(undefined); }catch(e){}
        client.waSocket = null; client.waAuthState = null; client.waStarting = false;
    }
    const authDir = path.join(getSessionDir(sid), 'wa_auth');
    if(fs.existsSync(authDir)) try{ fs.rmSync(authDir,{recursive:true,force:true}); }catch(e){}
    await new Promise(r=>setTimeout(r,800));

    try { await startWA(sid, { force:true }); } catch(e){ return { error:'init: '+e.message }; }

    // ⏱️ استنى لحد 90 ثانية للسوكيت
    let t = 0;
    while(!client.waSocket && t < 180){ await new Promise(r=>setTimeout(r,500)); t++; }
    if(!client.waSocket) return { error:'Socket timeout — جرب تاني' };

    // ⏱️ استنى 5 ثواني عشان handshake
    await new Promise(r=>setTimeout(r,5000));

    try {
        const code = await client.waSocket.requestPairingCode(clean);
        client.waPairingCode = code.match(/.{1,4}/g).join('-');
        client.waNeedsPairing = true;
        console.log('🔑 Code:', client.waPairingCode);
        return { code: client.waPairingCode };
    } catch(e) {
        console.log('🔑 pairing error:', e.message);
        // محاولة تانية
        await new Promise(r=>setTimeout(r,3000));
        try {
            const code = await client.waSocket.requestPairingCode(clean);
            client.waPairingCode = code.match(/.{1,4}/g).join('-');
            client.waNeedsPairing = true;
            return { code: client.waPairingCode };
        } catch(e2) {
            return { error:'فشل: ' + e2.message };
        }
    }
}

async function manualReconn(sid){
    const client = getClient(sid);
    if(!client.waAuthState?.creds?.registered) return { needPairing:true };
    client.waConnected = false;
    client.waBlocked = false;
    client.blockReason = null;
    await startWA(sid, { force:true });
    return { ok:true };
}
async function logoutWA(sid){
    try {
        const client = getClient(sid);
        if(reconnectTimers[sid]){ clearTimeout(reconnectTimers[sid]); delete reconnectTimers[sid]; }
        if(client.waSocket){ try{client.waSocket.ev.removeAllListeners();}catch(e){} try{await client.waSocket.logout();}catch(e){} try{client.waSocket.end(undefined);}catch(e){} client.waSocket=null; }
        client.waConnected=false; client.waAuthState=null; client.waNeedsPairing=false; client.waPairingCode=null;
        delete msgCache[sid];
        const authDir = path.join(getSessionDir(sid), 'wa_auth');
        if(fs.existsSync(authDir)) fs.rmSync(authDir,{recursive:true,force:true});
        const mf = getMsgFile(sid); if(fs.existsSync(mf)) fs.unlinkSync(mf);
        emit(sid,'wa-status','disconnected');
        return { success:true };
    } catch(e){ return { error:e.message }; }
}

// ⚡ blastInstant — rate-limited + delivery tracking
async function blastInstant(target, payload, count, isGroup, opts){
    let sent = 0, failed = 0, confirmed = 0;
    let lastError = null;
    const antiBan = opts.antiBan !== false;
    const sessionId = opts.sessionId;
    const jobId = opts.jobId;
    const speed = Math.max(1, parseInt(opts.speed) || 999); // رسائل/ثانية
    const isUnlimited = speed >= 999;

    // Delay لكل رسالة حسب السرعة
    // 2/s = 500ms | 3/s = 333ms | 10/s = 100ms | MAX = 0ms
    const perMsgDelay = isUnlimited ? 0 : Math.max(0, Math.floor(1000 / speed));

    // Rate limiter بسيط: نستخدم semaphore بـ concurrency صغير
    const CONCURRENCY = isUnlimited ? 2000 : Math.max(1, Math.min(speed, 20));

    let processed = 0;
    const sendOne = async () => {
        if (opts.cancelled && opts.cancelled()) return;
        if (processed >= count) return;
        processed++;
        let finalPayload = payload;
        if (antiBan && payload.text) finalPayload = { text: varyMessage(payload.text) };
        try {
            const result = await opts.send(finalPayload);
            // result = message object
            const msgId = result?.key?.id;
            if (msgId && sessionId && clients[sessionId]) {
                clients[sessionId].deliveryTracking[msgId] = { jobId, at: Date.now() };
            }
            sent++;
            // ملاحظة: "sent" هنا معناه واتساب قبل الرسالة، مش وصلت فعلاً
            // التأكيد الفعلي يجي من message-receipt.update
        } catch (err) {
            failed++;
            lastError = String(err?.message || err || 'unknown');
        }
        if (opts.update) opts.update(sent, failed, confirmed);
        if (perMsgDelay > 0 && !isUnlimited) {
            await new Promise(r => setTimeout(r, perMsgDelay));
        }
    };

    // دفعات صغيرة (chunks) — تمنع انهيار المتصفح
    while (processed < count) {
        if (opts.cancelled && opts.cancelled()) break;
        const batch = [];
        const batchSize = Math.min(CONCURRENCY, count - processed);
        for (let i = 0; i < batchSize; i++) batch.push(sendOne());
        await Promise.all(batch);
        processed += batchSize;
        // تأخير بسيط بين الدفعات للسرعات العالية
        if (isUnlimited && processed < count) await new Promise(r => setTimeout(r, 30));
    }

    return { sent, failed, confirmed, lastError, completed: processed >= count };
}

async function resumeJobs(sid){
    const client = getClient(sid);
    if(!client.waConnected || !client.waSocket) return;
    const payloads = jobPayloads[sid] || {};
    const pending = Object.values(allJobs).filter(j => j.sessionId === sid && j.status === 'running' && payloads[j.id]);
    if(!pending.length) return;
    for(const job of pending){
        const p = payloads[job.id];
        if(!p) continue;
        const remaining = p.count - (job.sent + job.failed);
        if(remaining <= 0){ job.status='done'; broadcastJobs(); continue; }
        try {
            const sentBefore = job.sent, failedBefore = job.failed;
            await blastInstant(p.target, { text: p.message }, remaining, p.isGroup, {
                sessionId: sid,
                jobId: job.id,
                speed: p.speed || 999,
                cancelled: () => client.activeJobs[job.id]?.cancel,
                send: (pl) => client.waSocket.sendMessage(p.target, pl),
                update: (s, f) => {
                    job.sent = sentBefore + s;
                    job.failed = failedBefore + f;
                    broadcastJobs();
                    emit(sid, 'wa-live', { jobId: job.id, sent: job.sent, failed: job.failed, count: job.count, delta: 1 });
                }
            });
        } catch(e){ console.log('resume err:', e.message); }
        if(job.status === 'running') job.status = 'done';
        broadcastJobs();
        delete client.activeJobs[job.id];
        delete jobPayloads[sid][job.id];
    }
}

// ═══════════ PROXY APIs ═══════════
app.get('/api/proxies', (req, res) => { res.json({ proxies, count: proxies.length }); });

app.post('/api/proxies/add', (req, res) => {
    try {
        const url = String(req.body.url||'').trim();
        if(!url || !url.match(/^(http|https|socks4|socks5):\/\//)) return res.json({ error:'رابط غير صحيح' });
        if(proxies.find(p => p.url === url)) return res.json({ error:'موجود مسبقاً' });
        proxies.push({ url, added: Date.now(), active: true });
        saveProxies();
        io.emit('proxies-update', { proxies, count: proxies.length });
        res.json({ success:true, count: proxies.length });
    } catch(e){ res.status(500).json({ error:e.message }); }
});
app.post('/api/proxies/remove', (req, res) => {
    try {
        const url = String(req.body.url||'');
        proxies = proxies.filter(p => p.url !== url);
        saveProxies();
        io.emit('proxies-update', { proxies, count: proxies.length });
        res.json({ success:true, count: proxies.length });
    } catch(e){ res.status(500).json({ error:e.message }); }
});
app.post('/api/proxies/clear', (req, res) => {
    proxies = [];
    saveProxies();
    io.emit('proxies-update', { proxies, count: proxies.length });
    res.json({ success:true });
});

// 🔍 اختبار بروكسي واحد
app.post('/api/proxies/test', async (req, res) => {
    try {
        const url = String(req.body.url||'').trim();
        if(!url) return res.json({ error:'مفيش رابط' });
        const r = await testProxy(url, 10000);
        res.json(r);
    } catch(e){ res.status(500).json({ error:e.message }); }
});

// 🔍 اختبار كل البروكسيات
app.post('/api/proxies/test-all', async (req, res) => {
    try {
        const results = await Promise.all(proxies.map(async (p) => {
            const r = await testProxy(p.url, 8000);
            p.lastTest = { ok: r.ok, ms: r.ms, reason: r.reason, at: Date.now() };
            return { url: p.url, ...r };
        }));
        saveProxies();
        io.emit('proxies-update', { proxies, count: proxies.length });
        res.json({ results });
    } catch(e){ res.status(500).json({ error:e.message }); }
});

app.get('/api/status/:sid', (req, res) => {
    const c = clients[req.params.sid];
    if(!c) return res.json({ connected: false, blocked: false });
    res.json({
        connected: c.waConnected,
        blocked: c.waBlocked || false,
        blockReason: c.blockReason || null,
        sent: c.sentCount,
        failed: c.failedCount
    });
});

app.post('/api/wipe-sessions', async (req, res) => {
    try {
        for(const sid in clients){
            const c = clients[sid];
            if(c.waSocket){ try{c.waSocket.ev.removeAllListeners();}catch(e){} try{c.waSocket.end(undefined);}catch(e){} }
            delete clients[sid];
        }
        for(const k in reconnectTimers){ clearTimeout(reconnectTimers[k]); delete reconnectTimers[k]; }
        if(fs.existsSync(SESSIONS_DIR)){ fs.rmSync(SESSIONS_DIR,{recursive:true,force:true}); fs.mkdirSync(SESSIONS_DIR,{recursive:true}); }
        for(const k in allJobs) delete allJobs[k];
        for(const k in msgCache) delete msgCache[k];
        for(const k in jobPayloads) delete jobPayloads[k];
        broadcastJobs();
        res.json({ success:true });
    } catch(e){ res.status(500).json({ error:e.message }); }
});

io.on('connection', (socket)=>{
    socket.emit('jobs-update', Object.values(allJobs));
    socket.emit('proxies-update', { proxies, count: proxies.length });

    socket.on('register-session', async (sid)=>{
        sid = String(sid).trim(); if(!sid) return;
        if(socket.sessionId && clients[socket.sessionId]) clients[socket.sessionId].socketIds.delete(socket.id);
        socket.sessionId = sid;
        const c = getClient(sid);
        c.socketIds.add(socket.id);
        if(!msgCache[sid]) loadMsgs(sid);
        const hasCreds = fs.existsSync(path.join(getSessionDir(sid),'wa_auth','creds.json'));
        if(c.waConnected && c.waSocket) socket.emit('wa-status','connected');
        else if(c.waSocket) socket.emit('wa-status','reconnecting');
        else if(hasCreds) socket.emit('wa-status','session_exists');
        else socket.emit('wa-status','disconnected');
        socket.emit('wa-cache-update', counts(sid));
        socket.emit('stats-update', { sent: c.sentCount, failed: c.failedCount });
        if(c.currentProxy) socket.emit('proxy-status', { url: c.currentProxy, ok: true, active: true });
        if(c.waNeedsPairing && c.waPairingCode && !c.waConnected){ socket.emit('wa-code', c.waPairingCode); socket.emit('wa-code-status','🔑 الكود جاهز'); }
    });
    socket.on('disconnect', ()=>{ if(socket.sessionId && clients[socket.sessionId]) clients[socket.sessionId].socketIds.delete(socket.id); });

    socket.on('wa-connect', async (phone)=>{
        if(!socket.sessionId) return;
        socket.emit('wa-code-status','⏳ جاري التحضير...');
        const r = await requestCode(socket.sessionId, phone);
        if(r.code){ socket.emit('wa-code', r.code); socket.emit('wa-code-status','✅ أدخل الكود في واتساب'); }
        else socket.emit('wa-code-status','❌ '+r.error);
    });
    socket.on('wa-reconnect', async ()=>{
        if(!socket.sessionId) return;
        socket.emit('wa-code-status','🔄 جاري إعادة الاتصال...');
        const r = await manualReconn(socket.sessionId);
        if(r.ok) socket.emit('wa-code-status','✅ بدأ الاتصال');
        else if(r.needPairing) socket.emit('wa-code-status','❌ مش مربوط');
    });
    socket.on('wa-logout', async ()=>{ if(!socket.sessionId) return; await logoutWA(socket.sessionId); socket.emit('wa-status','logged_out'); socket.emit('logout-done','whatsapp'); });

    socket.on('wa-spam', async (d)=>{
        const client = getClient(socket.sessionId);
        if(!client.waSocket){
            if(client.waAuthState?.creds?.registered){ await startWA(socket.sessionId,{force:true}); let t=0; while((!client.waConnected||!client.waSocket)&&t<20){await new Promise(r=>setTimeout(r,500));t++;} }
            if(!client.waConnected||!client.waSocket) return socket.emit('error','WA not connected');
        }
        const raw = String(d.number).trim();
        const isGroup = raw.includes('@g.us');
        let target = raw, display = raw;
        if(!isGroup && !raw.includes('@s.whatsapp.net')){
            const clean = raw.replace(/\D/g,'');
            if(clean.length<8) return socket.emit('error','رقم غير صحيح');
            try{ const r = await client.waSocket.onWhatsApp(clean); if(!r||!r.length) return socket.emit('error','❌ الرقم مش عنده واتساب'); target=r[0].jid; display=clean; }
            catch(e){ target = clean+'@s.whatsapp.net'; display=clean; }
        }
        const jobId = 'wa_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
        allJobs[jobId] = { id:jobId, sessionId:socket.sessionId, type:'whatsapp', target:display.split('@')[0], message:d.message, count:d.count, sent:0, failed:0, isGroup, status:'running', startTime:Date.now() };
        client.activeJobs[jobId] = { cancel:false };
        if(!jobPayloads[socket.sessionId]) jobPayloads[socket.sessionId] = {};
        jobPayloads[socket.sessionId][jobId] = { type:'text', message:d.message, target, isGroup, count:d.count };
        broadcastJobs();
        const blastRes = await blastInstant(target, { text: d.message }, d.count, isGroup, {
            sessionId: socket.sessionId,
            jobId: jobId,
            speed: d.speed || 999,
            cancelled: () => client.activeJobs[jobId]?.cancel,
            send: (p) => client.waSocket.sendMessage(target, p),
            update: (s, f, c) => {
                allJobs[jobId].sent = s;
                allJobs[jobId].failed = f;
                allJobs[jobId].confirmed = c || 0;
                broadcastJobs();
                emit(socket.sessionId, 'wa-live', { jobId, sent:s, failed:f, confirmed: c||0, count:d.count, delta:1 });
            }
        });
        client.sentCount += allJobs[jobId].sent;
        client.failedCount += allJobs[jobId].failed;
        emit(socket.sessionId, 'stats-update', { sent: client.sentCount, failed: client.failedCount });
        if(blastRes?.aborted) allJobs[jobId].status = 'error';
        else if(allJobs[jobId].status === 'running') allJobs[jobId].status = 'done';
        broadcastJobs();
        delete client.activeJobs[jobId];
        if(jobPayloads[socket.sessionId]) delete jobPayloads[socket.sessionId][jobId];
    });

    socket.on('wa-spam-media', async (d)=>{
        const client = getClient(socket.sessionId);
        if(!client.waSocket){
            if(client.waAuthState?.creds?.registered){ await startWA(socket.sessionId,{force:true}); let t=0; while((!client.waConnected||!client.waSocket)&&t<20){await new Promise(r=>setTimeout(r,500));t++;} }
            if(!client.waConnected||!client.waSocket) return socket.emit('error','WA not connected');
        }
        const raw = String(d.number).trim();
        const isGroup = raw.includes('@g.us');
        let target = raw, display = raw;
        if(!isGroup && !raw.includes('@s.whatsapp.net')){
            const clean = raw.replace(/\D/g,'');
            if(clean.length<8) return socket.emit('error','رقم غير صحيح');
            try{ const r = await client.waSocket.onWhatsApp(clean); if(!r||!r.length) return socket.emit('error','❌ مش عنده واتساب'); target=r[0].jid; display=clean; }
            catch(e){ target = clean+'@s.whatsapp.net'; display=clean; }
        }
        const files = Array.isArray(d.files) ? d.files : [];
        if(!files.length) return socket.emit('error','مفيش ملفات');
        const repeatEach = Math.max(1, parseInt(d.repeatEach)||1);
        const caption = d.caption || '';
        const queue = [];
        for(const f of files){
            const times = Math.max(1, parseInt(f.count||repeatEach));
            const buf = Buffer.from(f.buffer);
            const isVideo = String(f.mimetype).startsWith('video/');
            const payload = isVideo ? { video: buf, caption, mimetype: f.mimetype } : { image: buf, caption, mimetype: f.mimetype };
            for(let i = 0; i < times; i++) queue.push(payload);
        }
        const jobId = 'wam_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
        allJobs[jobId] = { id:jobId, sessionId:socket.sessionId, type:'whatsapp-media', target:display.split('@')[0], message:(caption||'[وسائط]').slice(0,40), count:queue.length, sent:0, failed:0, isGroup, files:files.length, status:'running', startTime:Date.now() };
        client.activeJobs[jobId] = { cancel:false };
        if(!jobPayloads[socket.sessionId]) jobPayloads[socket.sessionId] = {};
        jobPayloads[socket.sessionId][jobId] = { type:'media', files, caption, repeatEach, target, isGroup, count:queue.length };
        broadcastJobs();
        let sent=0, failed=0;
        const promises = [];
        for(const payload of queue){
            if(client.activeJobs[jobId]?.cancel) break;
            promises.push(
                client.waSocket.sendMessage(target, payload)
                    .then(()=>{ sent++; allJobs[jobId].sent=sent; broadcastJobs(); emit(socket.sessionId,'wa-live',{ jobId, sent, failed, count:queue.length, delta:1 }); })
                    .catch(()=>{ failed++; allJobs[jobId].failed=failed; broadcastJobs(); })
            );
        }
        await Promise.all(promises);
        client.sentCount += sent;
        client.failedCount += failed;
        emit(socket.sessionId, 'stats-update', { sent: client.sentCount, failed: client.failedCount });
        if(allJobs[jobId].status === 'running') allJobs[jobId].status = 'done';
        broadcastJobs();
        delete client.activeJobs[jobId];
        if(jobPayloads[socket.sessionId]) delete jobPayloads[socket.sessionId][jobId];
    });

    socket.on('wa-stop', (jid)=>{ const c=getClient(socket.sessionId); if(c.activeJobs[jid]) c.activeJobs[jid].cancel=true; });
    socket.on('wa-groups', async ()=>{
        const client = getClient(socket.sessionId);
        if(!client.waConnected) return socket.emit('error','WA not connected');
        try{ const g = Object.values(await client.waSocket.groupFetchAllParticipating()); const cache = msgCache[socket.sessionId]||{}; socket.emit('wa-groups-list', g.map(x=>({ id:x.id, name:x.subject, count:(cache[x.id]||[]).length }))); } catch(e){ socket.emit('error', e.message); }
    });
    socket.on('wa-group-messages', async (gid)=>{
        const client = getClient(socket.sessionId);
        if(!client.waConnected) return socket.emit('error','WA not connected');
        if(!msgCache[socket.sessionId]) loadMsgs(socket.sessionId);
        let msgs = [...(msgCache[socket.sessionId]?.[gid]||[])];
        try{ const stored = await client.waSocket.loadMessages(gid, 200); if(stored) for(const m of stored){ if(m.message && m.key && !msgs.find(x=>x.id===m.key.id)) msgs.push(fmtMsg(m, socket.sessionId)); } }catch(e){}
        msgs.sort((a,b)=>(a.time||0)-(b.time||0));
        if(!msgCache[socket.sessionId]) msgCache[socket.sessionId]={};
        msgCache[socket.sessionId][gid] = msgs;
        socket.emit('wa-group-messages-list', { groupId:gid, messages:msgs, count:msgs.length });
    });
    socket.on('wa-group-send', async (d)=>{
        const client = getClient(socket.sessionId);
        if(!client.waConnected || !client.waSocket) return socket.emit('error','WA not connected');
        const cnt = Math.max(1, parseInt(d.count)||1);
        const promises = [];
        for(let i=0; i<cnt; i++){
            promises.push(client.waSocket.sendMessage(d.groupId, { text:d.text })
                .then(()=>{ const entry = { id:'local_'+Date.now()+'_'+i, from:'me', fromMe:true, text:d.text, time:Math.floor(Date.now()/1000), pushName:'أنت' }; if(!msgCache[socket.sessionId]) msgCache[socket.sessionId]={}; if(!msgCache[socket.sessionId][d.groupId]) msgCache[socket.sessionId][d.groupId]=[]; msgCache[socket.sessionId][d.groupId].push(entry); socket.emit('wa-group-send-ok', { groupId:d.groupId, ...entry, index:i+1, total:cnt }); })
                .catch(()=>{})
            );
        }
        await Promise.all(promises);
        saveMsgs(socket.sessionId);
        socket.emit('wa-group-send-done', { groupId:d.groupId, ok:cnt, failed:0, total:cnt });
    });
    socket.on('clear-jobs', ()=>{ for(const k in allJobs) if(allJobs[k].sessionId===socket.sessionId) delete allJobs[k]; broadcastJobs(); });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log('🚀 Server on port ' + PORT));
process.on('uncaughtException', e => console.log('⚠️', e.message));
process.on('unhandledRejection', e => console.log('⚠️', e));
