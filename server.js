require('dotenv').config();
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Turso client
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

app.set('trust proxy', true);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB Init ──────────────────────────────────────────────────────────────────
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS auth (
      id INTEGER PRIMARY KEY,
      password_hash TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Tab',
      content TEXT NOT NULL DEFAULT '',
      tab_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  console.log('Database initialized.');
}

// ── Auth Middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Check if setup is needed (no password set yet)
app.get('/api/status', async (req, res) => {
  try {
    const result = await db.execute('SELECT id FROM auth WHERE id = 1');
    res.json({ setup: result.rows.length === 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trusted-IP auto-login: skip password for trusted devices
app.get('/api/check-ip', async (req, res) => {
  try {
    // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
    const normalise = ip => (ip || '').replace(/^::ffff:/i, '').trim();

    const forwarded = req.headers['x-forwarded-for'];
    const clientIP  = normalise(forwarded ? forwarded.split(',')[0] : req.ip);
    const directIP  = normalise(req.ip);

    const LOCALHOST = ['127.0.0.1', '::1', '0:0:0:0:0:0:0:1'];
    const trustedIP = process.env.TRUSTED_IP ? normalise(process.env.TRUSTED_IP) : null;

    // Trust if: (a) request is from localhost (same machine), OR
    //           (b) IP matches the configured TRUSTED_IP
    const isTrusted =
      LOCALHOST.includes(clientIP) || LOCALHOST.includes(directIP) ||
      (trustedIP && (clientIP === trustedIP || directIP === trustedIP));

    if (!isTrusted) return res.json({ trusted: false });

    // Only auto-login if a password has already been set up
    const result = await db.execute('SELECT id FROM auth WHERE id = 1');
    if (result.rows.length === 0) return res.json({ trusted: false, reason: 'not_setup' });

    const token = jwt.sign({ user: 'owner' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ trusted: true, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: shows what IP the server actually sees (remove in production)
app.get('/api/debug-ip', (req, res) => {
  const forwarded = req.headers['x-forwarded-for'];
  const clientIP  = forwarded ? forwarded.split(',')[0].trim() : req.ip;
  res.json({
    req_ip:          req.ip,
    x_forwarded_for: forwarded || null,
    client_ip_used:  clientIP,
    trusted_ip:      process.env.TRUSTED_IP || '(not set)',
    all_headers:     req.headers,
  });
});

// First-time setup: set initial password
app.post('/api/setup', async (req, res) => {
  try {
    const existing = await db.execute('SELECT id FROM auth WHERE id = 1');
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Password already set. Use change-password instead.' });
    }
    const { password } = req.body;
    if (!password || password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    }
    const hash = await bcrypt.hash(password, 12);
    await db.execute({ sql: 'INSERT INTO auth (id, password_hash) VALUES (1, ?)', args: [hash] });

    // Create a default tab on first setup
    await db.execute({
      sql: "INSERT INTO tabs (name, content, tab_order) VALUES (?, ?, ?)",
      args: ['Notes', '', 0]
    });

    const token = jwt.sign({ user: 'owner' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;
    const result = await db.execute('SELECT password_hash FROM auth WHERE id = 1');
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Not set up yet.' });
    }
    const valid = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Wrong password.' });
    }
    const token = jwt.sign({ user: 'owner' }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password
app.post('/api/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }
    const result = await db.execute('SELECT password_hash FROM auth WHERE id = 1');
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is wrong.' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await db.execute({ sql: 'UPDATE auth SET password_hash = ? WHERE id = 1', args: [hash] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all tabs
app.get('/api/tabs', authMiddleware, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM tabs ORDER BY tab_order ASC, id ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a tab
app.post('/api/tabs', authMiddleware, async (req, res) => {
  try {
    const { name, content, tab_order } = req.body;
    const result = await db.execute({
      sql: "INSERT INTO tabs (name, content, tab_order, updated_at) VALUES (?, ?, ?, datetime('now'))",
      args: [name || 'Tab', content || '', tab_order ?? 0]
    });
    const newTab = await db.execute({
      sql: 'SELECT * FROM tabs WHERE id = ?',
      args: [result.lastInsertRowid]
    });
    res.json(newTab.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a tab
app.put('/api/tabs/:id', authMiddleware, async (req, res) => {
  try {
    const { name, content, tab_order } = req.body;
    await db.execute({
      sql: "UPDATE tabs SET name = ?, content = ?, tab_order = ?, updated_at = datetime('now') WHERE id = ?",
      args: [name, content, tab_order ?? 0, req.params.id]
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a tab
app.delete('/api/tabs/:id', authMiddleware, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM tabs WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve app.html for /app route
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`KnullProtected running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
