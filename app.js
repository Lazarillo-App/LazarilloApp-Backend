// app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { randomUUID } = require('crypto');
const pool = require('./config/db');
const { runMigrations } = require('./db/migrations');
const agrupacionesRoutes = require('./routes/agrupacionesRoutes');
const authRequired = require('./middleware/authMiddleware');
const { loadActiveBusiness } = require('./middleware/business');

const app = express();

// ---------- Patch de logging (seguro y minimal) ----------
app.set('trust proxy', 1); // Render/NGINX, IP real y HTTPS
app.disable('x-powered-by');

app.use((req, res, next) => {
  const reqId = randomUUID().slice(0, 8);
  const start = Date.now();

  const auth = req.headers.authorization ? '***' : undefined;
  const hdrs = { ...req.headers, authorization: auth };

  console.log(`➡️ [${reqId}] ${req.method} ${req.originalUrl}`);
  if (process.env.LOG_REQUEST_HEADERS === '1') {
    console.log(`   [${reqId}] headers:`, hdrs);
  }

  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`⬅️ [${reqId}] ${res.statusCode} ${req.method} ${req.originalUrl} (${ms}ms)`);
  });

  next();
});

// ---------- CORS primero ----------
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://lazarillo.com.ar',
    'http://lazarillo.com.ar',
  ],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Business-Id'],
  credentials: false,
}));

// ---------- Parsers ----------
app.use(express.json());

// ---------- Logging HTTP ----------
app.use(morgan('➡️ :method :url :status :response-time ms'));

// ---------- Rutas públicas (SIN auth) ----------
app.use('/api/auth', require('./routes/authRoutes')); // login/registro públicos

// 🔒 Todo lo que siga en /api requiere auth + contexto de negocio
app.use('/api', authRequired, loadActiveBusiness);

// ---------- Rutas protegidas (CON auth + negocio activo/override) ----------
app.use('/api/agrupaciones-insumos', require('./routes/agrupacionesInsumosRoutes'));
app.use('/api/insumos', require('./routes/insumosRoutes'));
app.use('/api/ventas', require('./routes/ventasRoutes'));
app.use('/api/businesses', require('./routes/businessRoutes'));
app.use('/api/branches', require('./routes/branchRoutes'));

// 🔒 Agrupaciones (scoped por negocio) — una sola base:
app.use('/api/businesses/:businessId', agrupacionesRoutes);

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/health/db', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    res.json(rows[0]);
  } catch (e) {
    console.error('DB health error:', e);
    res.status(500).json({ error: 'db down' });
  }
});

app.get('/health/agrupaciones', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT to_regclass('public.agrupaciones') IS NOT NULL) AS has_table,
      EXISTS (SELECT 1 FROM information_schema.columns 
              WHERE table_name='agrupaciones' AND column_name='created_at') AS has_created_at,
      EXISTS (SELECT 1 FROM information_schema.columns 
              WHERE table_name='agrupaciones' AND column_name='updated_at') AS has_updated_at,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='set_updated_at_agrupaciones') AS has_trigger
  `);
  res.json(rows[0]);
});

app.get('/health/auth', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        (SELECT to_regclass('public.app_users') IS NOT NULL)  AS has_users,
        (SELECT to_regclass('public.app_businesses') IS NOT NULL) AS has_biz,
        (SELECT to_regclass('public.user_businesses') IS NOT NULL) AS has_link,
        (SELECT to_regclass('public.app_users_email_lower_idx') IS NOT NULL) AS has_email_idx
    `);
    res.json(rows[0]);
  } catch (e) {
    console.error('Auth health error:', e);
    res.status(500).json({ error: 'auth health failed' });
  }
});

// en app.js, arriba del 404
app.get('/health/dbinfo', async (_req, res) => {
  try {
    const cols = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name='agrupaciones'
      ORDER BY 1
    `);
    const db = process.env.PGDATABASE || '(no PGDATABASE)';
    const host = process.env.PGHOST || '(no PGHOST)';
    res.json({
      db,
      host,
      agrupaciones_columns: cols.rows.map(r => r.column_name),
      routes: {
        health: '/health',
        agrupaciones: '/api/businesses/:businessId/agrupaciones'
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 404 explícito ----------
app.use((req, res, _next) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// ---------- Handler de errores AL FINAL ----------
app.use((err, req, res, _next) => {
  console.error('❌ Error:', err);
  res.status(err.status || 500).json({
    error: 'internal',
    message: err?.message,
    code: err?.code,
  });
});

console.log('📂 Usando base de datos PG:', process.env.PGDATABASE);

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await runMigrations();
    console.log('✅ Migraciones ejecutadas');
    app.listen(PORT, () =>
      console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`)
    );
  } catch (err) {
    console.error('❌ Error ejecutando migraciones:', err);
    process.exit(1);
  }
})();

