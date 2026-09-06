const express = require('express');
const { exec } = require('child_process');
const app = express();
const cors = require('cors');
const fs = require('fs');
const path = require('path');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

let accounts = [];
if (fs.existsSync('accounts.json')) {
    accounts = JSON.parse(fs.readFileSync('accounts.json', 'utf8'));
}

function saveAccounts() {
    fs.writeFileSync('accounts.json', JSON.stringify(accounts, null, 2));
}

app.get('/', (req, res) => res.json({ status: 'running' }));

app.post('/api/accounts', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    
    const clean = username.replace('@', '').trim();
    const exists = accounts.find(a => a.username === clean);
    if (exists) return res.status(400).json({ error: 'Already exists' });
    
    const account = { id: Date.now(), username: clean, coins: 0, running: false };
    accounts.push(account);
    saveAccounts();
    res.json({ success: true, account });
});

app.delete('/api/accounts/:id', (req, res) => {
    accounts = accounts.filter(a => a.id !== parseInt(req.params.id));
    saveAccounts();
    res.json({ success: true });
});

app.get('/api/accounts', (req, res) => {
    res.json({ success: true, accounts });
});

app.get('/api/total-coins', (req, res) => {
    const total = accounts.reduce((sum, acc) => sum + (acc.coins || 0), 0);
    res.json({ success: true, total });
});

app.post('/api/run-bot/:id', (req, res) => {
    const account = accounts.find(a => a.id === parseInt(req.params.id));
    if (!account) return res.status(404).json({ error: 'Not found' });
    
    account.running = true;
    saveAccounts();
    res.json({ success: true });
    
    const botPath = path.join(__dirname, 'bot.py');
    exec(`python3 ${botPath} ${account.username} ${account.id}`, (err, stdout) => {
        if (stdout) console.log(stdout);
    });
});

app.post('/api/stop-bot/:id', (req, res) => {
    const account = accounts.find(a => a.id === parseInt(req.params.id));
    if (account) {
        account.running = false;
        saveAccounts();
    }
    res.json({ success: true });
});

app.post('/api/update-coins/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { coins } = req.body;
    const account = accounts.find(a => a.id === id);
    if (account) {
        account.coins += parseInt(coins) || 0;
        saveAccounts();
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
