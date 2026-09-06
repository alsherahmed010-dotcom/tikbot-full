const express = require('express');
const { exec } = require('child_process');
const { Pool } = require('pg');
const app = express();
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const databaseUrl = process.env.DATABASE_URL || process.env.DATABASE_URL_INTERNAL || process.env.DATABASE_PUBLIC_URL;
const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS tikbot_accounts (
      id SERIAL PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      coins INTEGER DEFAULT 0,
      status VARCHAR(50) DEFAULT 'active',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS tikbot_stats (
      id SERIAL PRIMARY KEY,
      account_id INTEGER,
      action VARCHAR(50),
      coins_earned INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log('✅ DB');
  } catch (e) { console.error('DB:', e.message); }
}
initDB();

app.get('/', (req, res) => res.json({ status: 'running' }));

// إضافة حساب
app.post('/api/accounts', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    const r = await pool.query('INSERT INTO tikbot_accounts (username) VALUES ($1) RETURNING *', [username.replace('@', '')]);
    res.json({ success: true, account: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// حذف
app.delete('/api/accounts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tikbot_accounts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// عرض الحسابات
app.get('/api/accounts', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM tikbot_accounts ORDER BY created_at DESC');
    res.json({ success: true, accounts: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// إجمالي
app.get('/api/total-coins', async (req, res) => {
  try {
    const r = await pool.query('SELECT SUM(coins) as total FROM tikbot_accounts');
    res.json({ success: true, total: r.rows[0].total || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// تشغيل البوت
app.post('/api/run-bot/:id', async (req, res) => {
  const { id } = req.params;
  const r = await pool.query('SELECT * FROM tikbot_accounts WHERE id = $1', [id]);
  const account = r.rows[0];
  if (!account) return res.status(404).json({ error: 'Not found' });
  
  res.json({ success: true, message: `Started @${account.username}` });
  
  const botPath = path.join(__dirname, 'bot.py');
  exec(`python3 ${botPath} ${account.username} ${id}`, (err, stdout) => {
    if (err) console.error('Error:', err.message);
    else console.log('Output:', stdout);
  });
});

// تحديث عملات
app.post('/api/update-coins/:id', async (req, res) => {
  try {
    const { coins } = req.body;
    await pool.query('UPDATE tikbot_accounts SET coins = coins + $1 WHERE id = $2', [coins, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server on ${PORT}`));
