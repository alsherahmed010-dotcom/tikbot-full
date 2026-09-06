const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let accounts = [];
let processes = {};

app.get('/api/accounts', (req, res) => {
    res.json(accounts);
});

app.post('/api/accounts', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    
    const id = Date.now().toString();
    const newAccount = { id, username, coins: 0, status: 'running' };
    accounts.push(newAccount);

    // تشغيل ملف bot.py للحساب الجديد تلقائياً
    const botProcess = spawn('python', ['bot.py', username, id]);
    processes[id] = botProcess;

    botProcess.stdout.on('data', (data) => console.log(`[Bot ${username}]: ${data}`));
    botProcess.stderr.on('data', (data) => console.error(`[Bot ${username} Err]: ${data}`));

    res.json(newAccount);
});

app.post('/api/update-coins/:id', (req, res) => {
    const { id } = req.params;
    const { coins } = req.body;
    const acc = accounts.find(a => a.id === id);
    if (acc) {
        acc.coins = coins; // تحديث دقيق بدون مضاعفة
    }
    res.json({ success: true });
});

app.post('/api/accounts/:id/stop', (req, res) => {
    const { id } = req.params;
    const acc = accounts.find(a => a.id === id);
    if (acc) {
        acc.status = 'stopped';
        if (processes[id]) {
            processes[id].kill();
            delete processes[id];
        }
    }
    res.json({ success: true });
});

app.post('/api/accounts/:id/start', (req, res) => {
    const { id } = req.params;
    const acc = accounts.find(a => a.id === id);
    if (acc && acc.status !== 'running') {
        acc.status = 'running';
        const botProcess = spawn('python', ['bot.py', acc.username, id]);
        processes[id] = botProcess;
    }
    res.json({ success: true });
});

app.delete('/api/accounts/:id', (req, res) => {
    const { id } = req.params;
    accounts = accounts.filter(a => a.id !== id);
    if (processes[id]) {
        processes[id].kill();
        delete processes[id];
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
