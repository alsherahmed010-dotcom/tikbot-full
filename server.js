const express = require('express');
const { exec } = require('child_process');
const app = express();
const cors = require('cors');
const fs = require('fs');
const path = require('path');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// تخزين محلي مؤقت (بدل PostgreSQL)
let accounts = [];
let totalCoins = 0;

// تحميل الحسابات من ملف لو موجود
if (fs.existsSync('accounts.json')) {
    accounts = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));
    totalCoins = accounts.reduce((sum, acc) => sum + acc.coins, 0);
}

function saveAccounts() {
    fs.writeFileSync('accounts.json', JSON.stringify(accounts, null, 2));
}

app.get('/', (req, res) => res.json({ status: 'running', service: 'TikBot' }));

// إضافة حساب
app.post('/api/accounts', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    
    const clean = username.replace('@', '').trim();
    const exists = accounts.find(a => a.username === clean);
    if (exists) return res.status(400).json({ error: 'Account already exists' });
    
    const account = {
        id: Date.now(),
        username: clean,
        coins: 0,
        status: 'active',
        createdAt: Date.now()
    };
    
    accounts.push(account);
    saveAccounts();
    res.json({ success: true, account });
});

// حذف
app.delete('/api/accounts/:id', (req, res) => {
    const id = parseInt(req.params.id);
    accounts = accounts.filter(a => a.id !== id);
    totalCoins = accounts.reduce((sum, acc) => sum + acc.coins, 0);
    saveAccounts();
    res.json({ success: true });
});

// عرض الحسابات
app.get('/api/accounts', (req, res) => {
    res.json({ success: true, accounts });
});

// إجمالي
app.get('/api/total-coins', (req, res) => {
    totalCoins = accounts.reduce((sum, acc) => sum + acc.coins, 0);
    res.json({ success: true, total: totalCoins });
});

// تشغيل البوت
app.post('/api/run-bot/:id', (req, res) => {
    const account = accounts.find(a => a.id === parseInt(req.params.id));
    if (!account) return res.status(404).json({ error: 'Not found' });
    
    res.json({ success: true, message: `Started @${account.username}` });
    
    // تشغيل البوت في الخلفية
    const botPath = path.join(__dirname, 'bot.py');
    exec(`python3 ${botPath} ${account.username} ${account.id}`, (err, stdout, stderr) => {
        if (err) console.error('Bot error:', err.message);
        if (stdout) console.log('Bot output:', stdout);
    });
});

// تحديث العملات (بيستدعيها البوت)
app.post('/api/update-coins/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { coins } = req.body;
    
    const account = accounts.find(a => a.id === id);
    if (account) {
        account.coins += parseInt(coins) || 0;
        totalCoins += parseInt(coins) || 0;
        saveAccounts();
    }
    
    res.json({ success: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
