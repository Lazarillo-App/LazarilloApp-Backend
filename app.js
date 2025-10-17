// app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { randomUUID } = require('crypto');
const pool = require('./config/db');
const { runMigrations } = require('./db/migrations');

// 🔧 Mitigación dev del warning MaxListeners (opcional)
if (process.env.NODE_ENV !== 'production') {
  require('events').defaultMaxListeners = 30;
}

// ✅ Importa ambos desde authMiddleware (exporta { authRequired, loadActiveBusiness })
const { authRequired, loadActiveBusiness } = require('./middleware/authMiddleware');

const forbidAppAdmin = require('./middleware/forbidAppAdmin');
const requireAppAdmin = require('./middleware/requireAppAdmin'); // admin-only

// Rutas
const authRoutes = require('./routes/authRoutes');
const devRoutes = require('./routes/devRoutes');
const businessRoutes = require('./routes/businessRoutes');
const adminRoutes = require('./routes/admin.routes');
const adminCronRoutes = require('./routes/adminCronRoutes');
const agrupacionesRoutes = require('./routes/agrupacionesRoutes');

const ventasRoutes = require('./routes/ventasRoutes');
const insumosRoutes = require('./routes/insumosRoutes');
const branchesRoutes = require('./routes/branchRoutes');
const agrupInsumosRoutes = require('./routes/agrupacionesInsumosRoutes');

const app = express();

/* ------------ logging de entrada ------------- */
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  const reqId = randomUUID().slice(0, 8);
  const start = Date.now();
  const hdrs = { ...req.headers, authorization: req.headers.authorization ? '***' : undefined };

  console.log(`➡️ [${reqId}] ${req.method} ${req.originalUrl}`);
  if (process.env.LOG_REQUEST_HEADERS === '1') {
    console.log(`   [${reqId}] headers:`, hdrs);
  }
  res.on('finish', () => {
    console.log(`⬅️ [${reqId}] ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - start}ms)`);
  });
  next();
});

/* CORS */
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://lazarillo.com.ar',
    'http://lazarillo.com.ar',
    'https://www.lazarillo.com.ar',
    'https://lazarillo-app.github.io',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Business-Id', 'X-Maxi-Token'],
  credentials: false,
  optionsSuccessStatus: 204,
}));
app.options(/.*/, cors());

// Parsers + logs
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('➡️ :method :url :status :response-time ms'));

// Públicas
app.use('/api/auth', authRoutes);
app.use('/api/dev', devRoutes);

// Admin de plataforma (solo app_admin)
app.use('/api/admin', authRequired, requireAppAdmin, adminRoutes);
app.use('/api/admin/cron', adminCronRoutes);

// Negocios: auth y NO ser app_admin
app.use('/api/businesses', authRequired, loadActiveBusiness, businessRoutes);

// Guard global de negocio activo o X-Business-Id para el resto de /api
app.use('/api', authRequired, loadActiveBusiness);

app.get('/api/_debug/whoami', authRequired, (req, res) => {
  res.json({
    uid: req.user?.id,
    role: req.user?.role,
    active_business_id: req.user?.active_business_id, // si lo pones en el token
    headers_x_business_id: req.header('X-Business-Id')
  });
});

// Rutas que requieren negocio (heredan el guard anterior)
app.use('/api/agrupaciones-insumos', agrupInsumosRoutes);
app.use('/api/insumos', insumosRoutes);
app.use('/api/ventas', ventasRoutes);
app.use('/api/branches', branchesRoutes);

// (histórico) rutas bajo :businessId
app.use('/api/businesses/:businessId', agrupacionesRoutes);

/* --------------- Health --------------- */
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
      db, host,
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

/* ---------------   / error handler --------------- */
app.use((req, res, _next) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

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


