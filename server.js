const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let accounts = [];
let processes = {};

app.get('/api/accounts', (req, res) => {
    res.json(accounts);
});

app.post('/api/accounts', (req, res) => {
    const username = req.body.username;
    if (!username) return res.status(400).json({ error: 'Username required' });
    
    // التحقق إن الحساب مش مضاف قبل كده
    if (accounts.some(acc => acc.username === username)) {
        return res.status(400).json({ error: 'Account already exists' });
    }

    const id = Date.now().toString();
    const newAccount = { id, username: username.trim(), coins: 0, status: 'running' };
    accounts.push(newAccount);

    try {
        const botProcess = spawn('python', ['bot.py', username, id]);
        processes[id] = botProcess;

        botProcess.stdout.on('data', (data) => console.log(`[Bot ${username}]: ${data}`));
        botProcess.stderr.on('data', (data) => console.error(`[Bot ${username} Err]: ${data}`));
    } catch (e) {
        console.error('Error starting python bot:', e);
    }

    res.json(newAccount);
});

app.post('/api/update-coins/:id', (req, res) => {
    const { id } = req.params;
    const { coins } = req.body;
    const acc = accounts.find(a => a.id === id);
    if (acc) {
        acc.coins = Number(coins);
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
        try {
            const botProcess = spawn('python', ['bot.py', acc.username, id]);
            processes[id] = botProcess;
        } catch (e) {}
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
