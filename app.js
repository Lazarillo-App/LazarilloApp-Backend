// app.js
require('dotenv').config();
require('events').defaultMaxListeners = 30;

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

const { startCron } = require('./services/cron');
const pool = require('./config/db');
const { runMigrations } = require('./db/migrations');

// Auth middlewares
const { authRequired, loadActiveBusiness } = require('./middleware/authMiddleware');
const requireAppAdmin = require('./middleware/requireAppAdmin');

// Rutas
const authRoutes         = require('./routes/authRoutes');
const devRoutes          = require('./routes/devRoutes');
const businessRoutes     = require('./routes/businessRoutes');
const adminRoutes        = require('./routes/admin.routes');
const adminCronRoutes    = require('./routes/adminCronRoutes');        // ⬅ cron sin JWT (X-Cron-Secret)
const adminRebuildAgg    = require('./routes/adminRebuildAggRoutes');  // ⬅ rebuild agregados (X-Cron-Secret)
const agrupacionesRoutes = require('./routes/agrupacionesRoutes');
const ventasRoutes       = require('./routes/ventasRoutes');
const insumosRoutes      = require('./routes/insumosRoutes');
const branchesRoutes     = require('./routes/branchRoutes');
const agrupInsumosRoutes = require('./routes/agrupacionesInsumosRoutes');

// (Opcional) probe directo a Maxi en dev
const exposeProbe = process.env.EXPOSE_MAXI_PROBE === '1';
const devMaxiProbeRoutes = exposeProbe ? require('./routes/devMaxiProbeRoutes') : null;

const app = express();

/* ----------- básicos ----------- */
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* logging simple por request */
app.use((req, res, next) => {
  const id = randomUUID().slice(0, 8);
  const t0 = Date.now();
  const hdrs = { ...req.headers, authorization: req.headers.authorization ? '***' : undefined };
  console.log(`➡️ [${id}] ${req.method} ${req.originalUrl}`);
  if (process.env.LOG_REQUEST_HEADERS === '1') console.log(`   [${id}] headers:`, hdrs);
  res.on('finish', () => console.log(`⬅️ [${id}] ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - t0}ms)`));
  next();
});

/* ----------- CORS ----------- */
app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://lazarillo.com.ar',
    'http://lazarillo.com.ar',
    'https://www.lazarillo.com.ar',
    'https://lazarillo-app.github.io',
  ],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Business-Id','X-Maxi-Token','X-Cron-Secret'],
  credentials: false,
  optionsSuccessStatus: 204,
}));
app.options(/.*/, cors());

/* ----------- parsers + logger HTTP ----------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('➡️ :method :url :status :response-time ms'));

/* ----------- uploads públicos ----------- */
const uploadsDir = path.join(__dirname, 'uploads');
const logosDir   = path.join(uploadsDir, 'logos');
fs.mkdirSync(logosDir, { recursive: true });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* ----------- rutas públicas ----------- */
app.use('/api/auth', authRoutes);
app.use('/api/dev',  devRoutes);
if (exposeProbe) {
  app.use('/api/dev', devMaxiProbeRoutes); // GET /api/dev/maxi-probe?biz=&from=&to=
}

/* ----------- CRON sin JWT (X-Cron-Secret) ----------- */
app.use('/api/cron', adminCronRoutes);

/* ----------- rebuild agregados (X-Cron-Secret opcional) ----------- */
app.use('/admin', adminRebuildAgg);

/* ----------- rutas con auth ----------- */
app.use('/api/admin', authRequired, requireAppAdmin, adminRoutes);
app.use('/api/businesses', authRequired, businessRoutes);

/* guard global de /api (después de /api/cron y /api/admin) */
app.use('/api', authRequired, loadActiveBusiness);

/* módulos con negocio */
app.use('/api/agrupaciones-insumos', agrupInsumosRoutes);
app.use('/api/insumos',               insumosRoutes);
app.use('/api/ventas',                ventasRoutes);
app.use('/api/branches',              branchesRoutes);

/* histórico: rutas bajo :businessId */
app.use('/api/businesses/:businessId', agrupacionesRoutes);

/* util debug */
app.get('/api/_debug/whoami', authRequired, (req, res) => {
  res.json({
    uid: req.user?.id,
    role: req.user?.role,
    active_business_id: req.user?.active_business_id,
    headers_x_business_id: req.header('X-Business-Id'),
  });
});

/* health */
app.get('/health', (_req, res) => res.json({ ok: true }));

/* 404 + errores */
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.originalUrl }));
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err.stack || err);
  const status = err.status || 500;
  res.status(status).json({ error: status === 401 ? 'unauthorized' : 'internal', message: err.message || 'internal_error' });
});

/* ----------- cron en prod ----------- */
if (process.env.CRON_ENABLED === '1') {
  startCron();
}

console.log('📂 Usando base de datos PG:', process.env.PGDATABASE);

const PORT = process.env.PORT || 4000;
(async () => {
  try {
    await runMigrations();
    console.log('✅ Migraciones ejecutadas');
    app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
  } catch (err) {
    console.error('❌ Error ejecutando migraciones:', err);
    process.exit(1);
  }
})();
