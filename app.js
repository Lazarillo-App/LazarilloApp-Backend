// app.js
require('dotenv').config();
require('events').defaultMaxListeners = 30;

const express = require('express');
const morgan = require('morgan');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

const { startCron } = require('./services/cron');
const { runMigrations } = require('./db/migrations');

// Auth middlewares
const { authRequired, loadActiveBusiness } = require('./middleware/authMiddleware');
const requireAppAdmin = require('./middleware/requireAppAdmin');

// Rutas
const authRoutes = require('./routes/authRoutes');
const devRoutes = require('./routes/devRoutes');
const businessRoutes = require('./routes/businessRoutes');
const adminRoutes = require('./routes/admin.routes');
const adminCronRoutes = require('./routes/adminCronRoutes');
const adminRebuildAgg = require('./routes/adminRebuildAggRoutes');
const agrupacionesRoutes = require('./routes/agrupacionesRoutes');
const articleListsRoutes = require('./routes/articleListsRoutes');
const priceListsRoutes = require('./routes/priceListsRoutes');
const ventasRoutes = require('./routes/ventasRoutes');
const insumosRoutes = require('./routes/insumosRoutes');
const purchasesRoutes = require('./routes/purchasesRoutes');
const salesBatchesRoutes = require('./routes/salesRoutes');          
const { resolveInsumoBusiness } = require('./middleware/resolveInsumoBusiness');
const divisionsRoutes = require('./routes/divisionsRoutes');
const diagnosticRoutes = require('./routes/diagnosticRoutes');
const organizationsRoutes = require('./routes/organizationsRoutes');
const recetasRoutes       = require('./routes/recetasRoutes');
const recetasBulkRoutes   = require('./routes/recetasBulkRoutes');
const promocionesRoutes = require('./routes/promocionesRoutes');
const recetasElaboradosRoutes = require('./routes/recetasElaboradosRoutes');
const recetasImportRoutes        = require('./routes/recetasImportRoutes');
const articlePriceConfigRoutes   = require('./routes/articlePriceConfigRoutes');
const salesImportRoutes = require('./routes/salesImportRoutes');
const insumosImportRoutes   = require('./routes/insumosImportRoutes');
const insumosElaboradosRoutes = require('./routes/insumosElaboradosRoutes');
const recetaFotosRoutes = require('./routes/recetaFotosRoutes');
const recetaUploadRoutes = require('./routes/recetaUploadRoutes');
const articulosImportRoutes = require('./routes/articulosImportRoutes');
const ventasCSVRoutes = require('./routes/ventasCSVRoutes');    
const purchasesImportRoutes = require('./routes/purchasesImportRoutes');
const notificationsRoutes = require('./routes/notificationsRoutes');
const accessRoutes         = require('./routes/accessRoutes');
const requireActiveAccount = require('./middleware/requireActiveAccount');
const syncRoutes = require('./routes/syncRoutes');
const branchesRouter = require("./routes/branchesRoutes");
const maxiPriceListsRoutes = require('./routes/maxiPriceListsRoutes');
const teamRoutes = require('./routes/teamRoutes');
const meRoutes = require('./routes/meRoutes');
const exposeProbe = process.env.EXPOSE_MAXI_PROBE === '1';
const devMaxiProbeRoutes = exposeProbe ? require('./routes/devMaxiProbeRoutes') : null;

// CORS unificado
const corsWithCache = require('./middleware/cors');

const app = express();

/* ----------- básicos ----------- */
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ----------- CORS (único, arriba de TODO) ----------- */
app.use(corsWithCache);

/* ----------- logging simple por request ----------- */
app.use((req, res, next) => {
  const id = randomUUID().slice(0, 8);
  const t0 = Date.now();
  const hdrs = { ...req.headers, authorization: req.headers.authorization ? '***' : undefined };
  console.log(`➡️ [${id}] ${req.method} ${req.originalUrl}`);
  if (process.env.LOG_REQUEST_HEADERS === '1') console.log(`   [${id}] headers:`, hdrs);
  res.on('finish', () =>
    console.log(`⬅️ [${id}] ${res.statusCode} ${req.method} ${req.originalUrl} (${Date.now() - t0}ms)`)
  );
  next();
});

/* ----------- parsers condicionales + logger HTTP ----------- */
// Skip body parser para upload multipart
app.use((req, res, next) => {
  const isMultipartUpload = 
    req.headers['content-type']?.includes('multipart/form-data') ||
    req.path.includes('/import-csv') ||
    req.path.includes('/purchases/import-csv') ||
    req.path.endsWith('/logo');
    
  if (isMultipartUpload && req.method === 'POST') {
    console.log('⏭️ [Body Parser] Skipping JSON parser para upload:', req.path);
    return next();
  }
  express.json({ limit: '50mb' })(req, res, next);
});

app.use((req, res, next) => {
  const isMultipartUpload = 
    req.headers['content-type']?.includes('multipart/form-data') ||
    req.path.includes('/import-csv') ||
    req.path.endsWith('/logo');
    
  if (isMultipartUpload && req.method === 'POST') {
    console.log('⏭️ [Body Parser] Skipping urlencoded parser para upload:', req.path);
    return next();
  }
  express.urlencoded({ extended: true, limit: '50mb' })(req, res, next);
});

app.use(morgan('➡️ :method :url :status :response-time ms'));

/* ----------- uploads públicos ----------- */
const uploadsDir = path.join(__dirname, 'uploads');
const logosDir = path.join(uploadsDir, 'logos');
fs.mkdirSync(logosDir, { recursive: true });
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* ----------- rutas públicas ----------- */
app.use('/api/auth', authRoutes);
app.use('/api/dev', devRoutes);
app.use('/api/diagnostic', diagnosticRoutes);

// ✅ AGREGAR ACÁ — antes del guard global de /api
app.use('/api/recetas', recetaUploadRoutes);

if (exposeProbe) {
  app.use('/api/dev', devMaxiProbeRoutes);
}

/* ── Acceso/cupones (status y redeem son semipúblicos) ── */
app.use('/api/access', accessRoutes);

/* ----------- CRON sin JWT (X-Cron-Secret) ----------- */
app.use('/api/cron', adminCronRoutes);

/* ----------- rebuild agregados (X-Cron-Secret opcional) ----------- */
app.use('/admin', adminRebuildAgg);

/* ----------- rutas con auth ----------- */
app.use('/api/admin', authRequired, requireAppAdmin, adminRoutes);

// Guard global de /api (después de /api/cron y /api/admin)
app.use('/api', authRequired, loadActiveBusiness);

// Verificar estado de cuenta activa (después de auth, antes de las rutas de negocio)
app.use('/api', requireActiveAccount);
app.use('/api/me', meRoutes);

// rutas con auth
app.use('/api/team', teamRoutes);

// módulos sin :businessId en la URL
app.use('/api/insumos', resolveInsumoBusiness, insumosRoutes);
app.use('/api/ventas', ventasRoutes);
app.use('/api/purchases', authRequired, purchasesRoutes);
app.use('/api/sales', salesBatchesRoutes);                    
app.use('/api/divisions', divisionsRoutes);
app.use('/api/ventas-csv', ventasCSVRoutes);
app.use('/api/insumos', insumosElaboradosRoutes);
app.use("/api/businesses/:bizId/branches", branchesRouter);
app.use('/api', maxiPriceListsRoutes);

/* =========================================================
   ✅ ORDEN IMPORTANTE EN /api/businesses
 ========================================================= */

// 1) IMPORTS CSV (más específico) primero
app.use('/api/businesses', salesImportRoutes);
app.use('/api/businesses', purchasesImportRoutes);
app.use('/api/businesses', insumosImportRoutes);
app.use('/api/businesses', articulosImportRoutes);
app.use('/api/businesses', recetasImportRoutes);
app.use('/api/businesses', articlePriceConfigRoutes);

// 2) rutas específicas por businessId
app.use('/api/businesses/:businessId/notifications', notificationsRoutes);
app.use('/api/businesses/:businessId/sync', syncRoutes);

// organizaciones y recetas
app.use('/api', organizationsRoutes);
app.use('/api/businesses/:businessId/articles/:articleId/receta', recetasRoutes);
app.use('/api/businesses/:businessId/promociones', promocionesRoutes);
app.use('/api/businesses/:businessId/recetas', recetasBulkRoutes);
const { getRecetasElaboradosMapa } = require('./controllers/recetasElaboradosController');
app.use('/api/businesses/:businessId/recetas-elaborados', authRequired, getRecetasElaboradosMapa);
app.use('/api/businesses/:businessId/insumos/:insumoId/receta', recetasElaboradosRoutes);
app.use('/api/recetas', recetaFotosRoutes);

// 3) businesses base después
app.use('/api/businesses', businessRoutes);
app.use('/api/businesses', priceListsRoutes);
app.use('/api/businesses', articleListsRoutes);

// 4) genérica al final
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
  res.status(status).json({
    error: status === 401 ? 'unauthorized' : 'internal',
    message: err.message || 'internal_error',
  });
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