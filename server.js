require('dotenv').config();
const express     = require('express');
const path        = require('path');
const { Pool }    = require('pg');
const multer      = require('multer');
const cloudinary  = require('cloudinary').v2;
const compression = require('compression');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
}));

// ── IN-MEMORY CACHE ──
const _mc   = {};
const mcGet = k         => { const e = _mc[k]; return e && Date.now() < e.t ? e.v : null; };
const mcSet = (k,v,ms=30_000) => { _mc[k] = { v, t: Date.now() + ms }; };
const mcDel = (...ks)   => ks.forEach(k => delete _mc[k]);

// ── RATE LIMITERS ──
const chatLimiter  = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Cuba semula sebentar.' } });
const orderLimiter = rateLimit({ windowMs: 60_000, max: 6,  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many orders. Sila tunggu sebentar.' } });

// ── DATABASE (Neon PostgreSQL) ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      key   TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT 'null'
    );
    INSERT INTO store (key, value) VALUES
      ('orders',   '[]'),
      ('products', '[]'),
      ('settings', '{}'),
      ('faqs',     '[]'),
      ('chatlogs', '[]')
    ON CONFLICT DO NOTHING;
  `);
  console.log('✅ Database sedia');
}

async function dbGet(key, fallback) {
  try {
    const r = await pool.query('SELECT value FROM store WHERE key = $1', [key]);
    return r.rows.length ? r.rows[0].value : fallback;
  } catch { return fallback; }
}

async function dbSet(key, value) {
  await pool.query(
    'INSERT INTO store (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb',
    [key, JSON.stringify(value)]
  );
}

// ── CLOUDINARY ──
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }
});

app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'tiada fail' });
  try {
    const result = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        { folder: 'haus-street', resource_type: 'image' },
        (err, r) => err ? reject(err) : resolve(r)
      ).end(req.file.buffer);
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('Cloudinary error:', err);
    res.status(500).json({ error: 'Muat naik gambar gagal' });
  }
});

// ── INIT (products + settings + faqs in one call) ──
app.get('/api/init', async (_req, res) => {
  let products = mcGet('products');
  let settings = mcGet('settings');
  let faqs     = mcGet('faqs');
  if (!products || !settings || !faqs) {
    [products, settings, faqs] = await Promise.all([
      products ?? dbGet('products', []),
      settings ?? dbGet('settings', {}),
      faqs     ?? dbGet('faqs', [])
    ]);
    if (!mcGet('products')) mcSet('products', products);
    if (!mcGet('settings')) mcSet('settings', settings);
    if (!mcGet('faqs'))     mcSet('faqs', faqs);
  }
  res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=20');
  res.json({ products, settings, faqs });
});

// ── ORDERS ──
app.get('/api/orders', async (_req, res) => {
  res.json(await dbGet('orders', []));
});

app.post('/api/orders', orderLimiter, async (req, res) => {
  const order = req.body;
  if (!order?.id || typeof order.name !== 'string' || typeof order.phone !== 'string')
    return res.status(400).json({ error: 'invalid' });
  order.name  = order.name.slice(0, 100).trim();
  order.phone = order.phone.replace(/[^\d+\-\s]/g, '').slice(0, 20);
  if (order.address) order.address = String(order.address).slice(0, 300).trim();
  if (order.note)    order.note    = String(order.note).slice(0, 500).trim();
  const orders = await dbGet('orders', []);
  orders.push(order);
  await dbSet('orders', orders);
  res.json({ ok: true });
});

app.patch('/api/order/:id', async (req, res) => {
  const orders = await dbGet('orders', []);
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'not found' });
  if (req.body.status) orders[idx].status = req.body.status;
  await dbSet('orders', orders);
  res.json({ ok: true });
});

app.delete('/api/order/:id', async (req, res) => {
  const orders = await dbGet('orders', []);
  await dbSet('orders', orders.filter(o => o.id !== req.params.id));
  res.json({ ok: true });
});

app.delete('/api/orders', async (_req, res) => {
  await dbSet('orders', []);
  res.json({ ok: true });
});

// ── TRACKING ──
app.get('/api/track', async (req, res) => {
  const orders = await dbGet('orders', []);
  const { id, phone } = req.query;
  if (id) {
    const order = orders.find(o => o.id === id.toUpperCase());
    return order ? res.json([order]) : res.status(404).json({ error: 'not found' });
  }
  if (phone) {
    const clean  = phone.replace(/\D/g, '');
    const result = orders.filter(o => o.phone.replace(/\D/g, '') === clean);
    return result.length ? res.json(result) : res.status(404).json({ error: 'not found' });
  }
  res.status(400).json({ error: 'provide id or phone' });
});

// ── PRODUCTS ──
app.get('/api/products', async (_req, res) => {
  let data = mcGet('products');
  if (!data) { data = await dbGet('products', []); mcSet('products', data); }
  res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=20');
  res.json(data);
});

app.post('/api/products', async (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products)) return res.status(400).json({ error: 'invalid' });
  await dbSet('products', products);
  mcDel('products');
  res.json({ ok: true });
});

// ── FAQS ──
app.get('/api/faqs', async (_req, res) => {
  let data = mcGet('faqs');
  if (!data) { data = await dbGet('faqs', []); mcSet('faqs', data); }
  res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
  res.json(data);
});

app.post('/api/faqs', async (req, res) => {
  const { faqs } = req.body;
  if (!Array.isArray(faqs)) return res.status(400).json({ error: 'invalid' });
  await dbSet('faqs', faqs);
  mcDel('faqs');
  res.json({ ok: true });
});

// ── SETTINGS ──
app.get('/api/settings', async (_req, res) => {
  let data = mcGet('settings');
  if (!data) { data = await dbGet('settings', {}); mcSet('settings', data); }
  res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=20');
  res.json(data);
});

app.post('/api/settings', async (req, res) => {
  const current = await dbGet('settings', {});
  const updated = { ...current, ...req.body };
  await dbSet('settings', updated);
  mcDel('settings');
  res.json({ ok: true });
});

// ── SALES REPORT ──
function calculateSalesReport({ start_datetime, end_datetime, items, actual_revenue }) {
  const errors = [];

  const processedItems = items.map(item => {
    const { name, price, stock_start, stock_end } = item;

    if (!name || typeof name !== 'string' || !name.trim())
      return errors.push(`Nama produk tidak sah`) && null;
    if (typeof price !== 'number' || price < 0)
      return errors.push(`Harga tidak sah untuk "${name}"`) && null;
    if (!Number.isInteger(stock_start) || !Number.isInteger(stock_end))
      return errors.push(`Stok mesti integer untuk "${name}"`) && null;
    if (stock_start < 0 || stock_end < 0)
      return errors.push(`"${name}": stok tidak boleh negatif`) && null;
    if (stock_end > stock_start)
      return errors.push(`"${name}": stok_end (${stock_end}) > stok_start (${stock_start})`) && null;

    const quantity_sold    = stock_start - stock_end;
    const expected_revenue = +(quantity_sold * price).toFixed(2);
    return { name: name.trim(), price, stock_start, stock_end, quantity_sold, expected_revenue };
  });

  if (errors.length) return { ok: false, errors };

  const total_items_sold       = processedItems.reduce((s, i) => s + i.quantity_sold, 0);
  const total_expected_revenue = +processedItems.reduce((s, i) => s + i.expected_revenue, 0).toFixed(2);
  const short                  = +(total_expected_revenue - actual_revenue).toFixed(2);
  const loss_percentage        = total_expected_revenue > 0
    ? +((short / total_expected_revenue) * 100).toFixed(2)
    : 0;

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    period:  { start: start_datetime, end: end_datetime },
    items:   processedItems,
    summary: { total_items_sold, total_expected_revenue, actual_revenue: +actual_revenue.toFixed(2), short, loss_percentage }
  };
}

app.post('/api/sales-report', (req, res) => {
  const { start_datetime, end_datetime, items, actual_revenue } = req.body;

  if (!start_datetime || !end_datetime)
    return res.status(400).json({ ok: false, errors: ['start_datetime dan end_datetime diperlukan'] });
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ ok: false, errors: ['items mesti array tidak kosong'] });
  if (typeof actual_revenue !== 'number')
    return res.status(400).json({ ok: false, errors: ['actual_revenue mesti nombor'] });

  res.json(calculateSalesReport({ start_datetime, end_datetime, items, actual_revenue }));
});

// ── CHAT ──
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'messages required' });
  if (messages.length > 30) return res.status(400).json({ error: 'too many messages' });
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://haus-street.onrender.com',
        'X-Title': 'Haus Street'
      },
      body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages, max_tokens: 220, temperature: 0.85 })
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('Groq error:', err);
      return res.status(502).json({ error: 'AI tidak dapat dihubungi' });
    }
    const data = await response.json();
    const reply = data.choices[0].message.content;
    res.json({ reply });

    // Save to chat logs (fire-and-forget)
    const userMsg = [...messages].reverse().find(m => m.role === 'user');
    if (userMsg) {
      const now  = new Date();
      const date = now.getFullYear() + '-' +
        String(now.getMonth()+1).padStart(2,'0') + '-' +
        String(now.getDate()).padStart(2,'0') + ' ' +
        String(now.getHours()).padStart(2,'0') + ':' +
        String(now.getMinutes()).padStart(2,'0');
      const logs = await dbGet('chatlogs', []);
      logs.push({ id: Date.now().toString(), date, q: userMsg.content, a: reply });
      if (logs.length > 200) logs.splice(0, logs.length - 200); // keep latest 200
      await dbSet('chatlogs', logs);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── CHAT LOGS ──
app.get('/api/chatlogs', async (_req, res) => {
  res.json(await dbGet('chatlogs', []));
});

app.delete('/api/chatlogs', async (_req, res) => {
  await dbSet('chatlogs', []);
  res.json({ ok: true });
});

// ── NOTIFY ──
app.post('/api/notify', async (req, res) => {
  const { message, order_id } = req.body;
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return res.json({ ok: false, reason: 'not configured' });
  try {
    const body = { chat_id: chatId, text: message };
    if (order_id) {
      body.reply_markup = {
        inline_keyboard: [[
          { text: '🔄 Proses',   callback_data: `t|${order_id}|proses`  },
          { text: '📦 Siap',     callback_data: `t|${order_id}|siap`    },
          { text: '🚗 Hantar',   callback_data: `t|${order_id}|hantar`  },
          { text: '✅ Selesai',  callback_data: `t|${order_id}|selesai` }
        ]]
      };
    }
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// ── TELEGRAM BOT ──
const TG_TOKEN = process.env.TELEGRAM_TOKEN;
const TG_CHAT  = String(process.env.TELEGRAM_CHAT_ID || '');

const BOT_LOCS = [
  { id: 'dobi',   name: 'Dobi Kerawang',   key: 'loc_dobi'   },
  { id: 'basket', name: 'Gelanggan Basket', key: 'loc_basket' },
  { id: 'bilik',  name: 'Bilik',            key: 'loc_bilik'  }
];
const BOT_STATUSES = ['baru', 'proses', 'siap', 'hantar', 'selesai'];

async function tgSend(chatId, text) {
  if (!TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  }).catch(() => {});
}

async function registerWebhook() {
  if (!TG_TOKEN) return;
  const appUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || 'https://haus-street.onrender.com';
  if (!appUrl) return console.log('⚠️  APP_URL tiada, webhook tidak didaftar');
  const r    = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${appUrl}/telegram-webhook`, allowed_updates: ['message', 'callback_query'] })
  }).then(r => r.json()).catch(() => ({}));
  console.log('🤖 Telegram webhook:', r.ok ? 'berjaya' : (r.description || 'gagal'));
}

app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  // Inline keyboard button tap
  const cb = req.body?.callback_query;
  if (cb) {
    const chatId = String(cb.message?.chat?.id);
    if (TG_CHAT && chatId === TG_CHAT) {
      const parts  = (cb.data || '').split('|');
      const oid    = parts[1];
      const status = parts[2];
      if (oid && status && BOT_STATUSES.includes(status)) {
        try {
          const orders = await dbGet('orders', []);
          const idx    = orders.findIndex(o => o.id === oid);
          if (idx >= 0) {
            orders[idx].status = status;
            await dbSet('orders', orders);

            const statusEmoji = { proses: '🔄', siap: '📦', hantar: '🚗', selesai: '✅' };
            const updatedBy   = cb.from?.first_name || cb.from?.username || 'Admin';
            const order       = orders[idx];

            // Answer the button tap (dismiss loading state)
            await fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callback_query_id: cb.id, text: `✅ ${oid} → ${status}`, show_alert: false })
            }).catch(() => {});

            // Notify the whole group
            await tgSend(TG_CHAT,
              `${statusEmoji[status] || '📋'} <b>STATUS DIKEMASKINI</b>\n\n` +
              `Order  : <b>${oid}</b>\n` +
              `Nama   : ${order.name}\n` +
              `Status : <b>${status.toUpperCase()}</b>\n` +
              `Oleh   : ${updatedBy}`
            );
          }
        } catch {}
      }
    }
    return;
  }

  const msg = req.body?.message;
  if (!msg?.text) return;
  const fromChat = String(msg.chat.id);
  if (TG_CHAT && fromChat !== TG_CHAT) return;
  const text = msg.text.trim();

  // Reply to order notification with status word → auto update tracking
  if (msg.reply_to_message?.text) {
    const status = text.toLowerCase();
    if (BOT_STATUSES.includes(status)) {
      const match = msg.reply_to_message.text.match(/#HS\d+/);
      if (match) {
        try {
          const oid    = match[0];
          const orders = await dbGet('orders', []);
          const idx    = orders.findIndex(o => o.id === oid);
          if (idx >= 0) {
            orders[idx].status = status;
            await dbSet('orders', orders);
            await tgSend(fromChat, `✅ Order <b>${oid}</b> → <b>${status}</b>`);
          } else {
            await tgSend(fromChat, `❌ Order ${oid} tidak dijumpai.`);
          }
        } catch { await tgSend(fromChat, '❌ Ralat. Cuba lagi.'); }
        return;
      }
    }
  }

  if (!text.startsWith('/')) return;
  const parts = text.split(/\s+/);
  const cmd   = parts[0].split('@')[0].toLowerCase();
  const args  = parts.slice(1);
  try { await handleBotCmd(cmd, args, fromChat); }
  catch { await tgSend(fromChat, '❌ Ralat berlaku. Cuba lagi.'); }
});

async function handleBotCmd(cmd, args, chatId) {
  const settings = await dbGet('settings', {});

  switch (cmd) {
    case '/help': {
      await tgSend(chatId,
        `🤖 <b>Haus Street Bot</b>\n\n` +
        `<b>Kedai:</b>\n/buka — Buka kedai\n/tutup — Tutup kedai\n/status — Status semasa\n\n` +
        `<b>Lokasi COD:</b>\n/senarai — Tunjuk lokasi\n/on dobi — Aktifkan lokasi\n/off dobi — Disable lokasi\n\n` +
        `<b>Stok Produk:</b>\n/stok — Senarai stok\n/stok Monster 5 — Set stok kepada 5\n\n` +
        `<b>Order:</b>\n/pesanan — 5 order terbaru\n/tracking #HS12345 siap — Kemaskini status\n` +
        `Status: ${BOT_STATUSES.join(' | ')}`
      );
      break;
    }

    case '/status': {
      const open     = settings.shop !== '0';
      const locLines = BOT_LOCS.map(l => `${settings[l.key] !== '0' ? '🟢' : '🔴'} ${l.name}`).join('\n');
      await tgSend(chatId, `📊 <b>Status Haus Street</b>\n\n🏪 Kedai: ${open ? '🟢 Buka' : '🔴 Tutup'}\n\n<b>Lokasi COD:</b>\n${locLines}`);
      break;
    }

    case '/buka': {
      await dbSet('settings', { ...settings, shop: '1' });
      mcDel('settings');
      await tgSend(chatId, '✅ Kedai <b>dibuka</b>. Customer boleh buat order sekarang.');
      break;
    }

    case '/tutup': {
      await dbSet('settings', { ...settings, shop: '0' });
      mcDel('settings');
      await tgSend(chatId, '🔴 Kedai <b>ditutup</b>. Customer tidak boleh order.');
      break;
    }

    case '/senarai': {
      const lines = BOT_LOCS.map(l => `${settings[l.key] !== '0' ? '🟢' : '🔴'} ${l.name}`).join('\n');
      await tgSend(chatId, `📍 <b>Lokasi COD:</b>\n\n${lines}\n\nGuna /on [nama] atau /off [nama] untuk tukar`);
      break;
    }

    case '/on':
    case '/off': {
      if (!args.length) return tgSend(chatId, `Contoh: ${cmd} dobi`);
      const q   = args.join(' ').toLowerCase();
      const loc = BOT_LOCS.find(l => l.name.toLowerCase().includes(q) || l.id.includes(q));
      if (!loc) return tgSend(chatId,
        `❌ Lokasi tidak dijumpai: "${args.join(' ')}"\n\nPilihan:\n${BOT_LOCS.map(l => `• ${l.name}`).join('\n')}`
      );
      await dbSet('settings', { ...settings, [loc.key]: cmd === '/on' ? '1' : '0' });
      mcDel('settings');
      await tgSend(chatId, `${cmd === '/on' ? '✅' : '❌'} <b>${loc.name}</b> ${cmd === '/on' ? 'diaktifkan' : 'disabled'}`);
      break;
    }

    case '/stok': {
      const products = await dbGet('products', []);
      if (!args.length) {
        if (!products.length) return tgSend(chatId, 'Tiada produk lagi.');
        const lines = products.map(p => `• ${p.name}: <b>${p.stock !== undefined ? p.stock + ' unit' : '—'}</b>`).join('\n');
        await tgSend(chatId, `📦 <b>Stok Produk:</b>\n\n${lines}\n\nGuna /stok [nama] [qty] untuk kemaskini`);
        return;
      }
      const qty = parseInt(args[args.length - 1]);
      if (isNaN(qty) || qty < 0) return tgSend(chatId, '❌ Kuantiti tidak sah. Contoh: /stok Monster 5');
      const q   = args.slice(0, -1).join(' ').toLowerCase();
      const idx = products.findIndex(p => p.name.toLowerCase().includes(q));
      if (idx < 0) return tgSend(chatId, `❌ Produk tidak dijumpai: "${args.slice(0, -1).join(' ')}"`);
      products[idx].stock = qty;
      await dbSet('products', products);
      mcDel('products');
      await tgSend(chatId, `✅ Stok <b>${products[idx].name}</b> dikemaskini → <b>${qty} unit</b>`);
      break;
    }

    case '/pesanan': {
      const orders = await dbGet('orders', []);
      if (!orders.length) return tgSend(chatId, 'Tiada order lagi.');
      const recent = [...orders].reverse().slice(0, 5);
      const lines  = recent.map(o => `${o.id} | ${o.name} | <b>${o.status}</b> | RM${o.total}`).join('\n');
      await tgSend(chatId, `📋 <b>5 Order Terbaru:</b>\n\n${lines}`);
      break;
    }

    case '/tracking': {
      if (args.length < 2) return tgSend(chatId,
        `Format: /tracking #HS12345 siap\nStatus: ${BOT_STATUSES.join(' | ')}`
      );
      const oid    = args[0].toUpperCase();
      const status = args[1].toLowerCase();
      if (!BOT_STATUSES.includes(status)) return tgSend(chatId,
        `❌ Status tidak sah: "${status}"\nGuna: ${BOT_STATUSES.join(' | ')}`
      );
      const orders = await dbGet('orders', []);
      const idx    = orders.findIndex(o => o.id === oid);
      if (idx < 0) return tgSend(chatId, `❌ Order "${oid}" tidak dijumpai.`);
      orders[idx].status = status;
      await dbSet('orders', orders);
      const statusEmoji2 = { proses: '🔄', siap: '📦', hantar: '🚗', selesai: '✅' };
      await tgSend(chatId,
        `${statusEmoji2[status] || '📋'} <b>STATUS DIKEMASKINI</b>\n\n` +
        `Order  : <b>${oid}</b>\n` +
        `Nama   : ${orders[idx].name}\n` +
        `Status : <b>${status.toUpperCase()}</b>`
      );
      break;
    }

    default:
      await tgSend(chatId, 'Arahan tidak dikenali. Taip /help untuk senarai arahan.');
  }
}

// ── START ──
const PORT = process.env.PORT || 3000;
initDB().then(async () => {
  await registerWebhook();
  app.listen(PORT, () => console.log(`\n🥤 Haus Street berjalan di http://localhost:${PORT}\n`));
}).catch(err => {
  console.error('Gagal sambung database:', err.message);
  process.exit(1);
});
