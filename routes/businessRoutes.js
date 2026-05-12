// routes/businessRoutes.js
const { cacheJson } = require('../middleware/cacheJson');
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const businesses = require('../controllers/businessController');
const {
  listArticlesFromDB,
  listArticlesTreeFromDB,
  salesSummaryFromDB,
  salesSeriesFromDB,
  syncNow,
  maxiArticlesProxy,
} = require('../controllers/syncController');
const { onboardBusiness } = require('../services/businessOnboarding');
const { authRequired } = require('../middleware/authMiddleware');
const loadBusiness = require('../middleware/loadBusiness');
const { requireBusinessAccessParam } = require('../middleware/requireBusinessAccess');
const { refreshMenu } = require('../controllers/maxiMenuController');
const viewPrefsCtrl = require('../controllers/viewPrefsController');
const syncRoutes = require('./syncRoutes');

// 🔴 ÚNICA importación del controlador de ventas
const sales = require('../controllers/salesSyncController');

const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');

/* ───────── Cloudinary Storage ───────── */
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'lazarillo/business-logos', // ✅ Carpeta en Cloudinary
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'gif', 'svg'],
    transformation: [{ width: 500, height: 500, crop: 'limit' }], // ✅ Resize automático
    public_id: (req, file) => `biz_${req.params.id}_${Date.now()}`, // ✅ Nombre único
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB  
  fileFilter: (req, file, cb) => {
    console.log('🔍 Multer fileFilter:', {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });

    const ok = /image\/(png|jpe?g|webp|gif|svg\+xml)/i.test(file.mimetype);

    if (!ok) {
      console.error('❌ Multer rechazó archivo:', file.mimetype);
      return cb(Object.assign(new Error('unsupported_file_type'), { code: 'UNSUPPORTED_TYPE' }));
    }

    console.log('✅ Multer aceptó archivo');
    cb(null, true);
  },
});

/* ───────── Logo: subir archivo ───────── */
router.post('/:id/logo', upload.any(), (req, res, next) => {
  // Buscar el archivo en cualquier campo
  const file = req.files?.find(f =>
    f.fieldname === 'file' ||
    f.fieldname === 'logo' ||
    f.fieldname === 'image'
  );

  req.file = file || null;

  console.log('🔍 Multer procesó:', {
    hasFiles: !!req.files,
    filesCount: req.files?.length || 0,
    fileFields: req.files?.map(f => f.fieldname) || [],
    selectedFile: req.file ? {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      size: req.file.size,
      cloudinaryUrl: req.file.path, // ✅ URL de Cloudinary
    } : null,
  });

  if (!req.file && !req.body?.url) {
    return res.status(400).json({
      error: 'missing_file',
      accept: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'],
      max_mb: 5,
    });
  }

  return ensureFn('businesses.uploadLogo', businesses.uploadLogo)(req, res, next);
});

/* ───────── Helper anti-crash ───────── */
function ensureFn(name, fn) {
  if (typeof fn !== 'function') {
    console.warn(`[routes/businesses] Handler faltante: ${name} -> responderá 501`);
    return (_req, res) => res.status(501).json({ error: 'not_implemented', handler: name });
  }
  return fn;
}

/* ───────── /uploads/logos ───────── */
const logosDir = path.join(__dirname, '..', 'uploads', 'logos');
fs.mkdirSync(logosDir, { recursive: true });

/* ───────── Auth + param :id ───────── */
router.use(authRequired);
router.param('id', requireBusinessAccessParam);

router.use('/:id/sync', syncRoutes);

/* ───────── Logo: subir archivo ───────── */
router.post('/:id/logo', upload.any(), (req, res, next) => {
  // Buscar el archivo en cualquier campo
  const file = req.files?.find(f =>
    f.fieldname === 'file' ||
    f.fieldname === 'logo' ||
    f.fieldname === 'image'
  );

  req.file = file || null;

  console.log('🔍 Multer procesó:', {
    hasFiles: !!req.files,
    filesCount: req.files?.length || 0,
    fileFields: req.files?.map(f => f.fieldname) || [],
    selectedFile: req.file ? {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      size: req.file.size
    } : null,
    hasBodyUrl: !!req.body?.url,
  });

  if (!req.file && !req.body?.url) {
    return res.status(400).json({
      error: 'missing_file',
      accept: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'],
      max_mb: 5,
      debug: {
        receivedFields: req.files?.map(f => f.fieldname) || [],
        bodyKeys: Object.keys(req.body || {}),
      }
    });
  }

  return ensureFn('businesses.uploadLogo', businesses.uploadLogo)(req, res, next);
});

/* ───────── Diagnóstico artículos directo desde Maxi ───────── */
router.get('/:id/maxi-articles-proxy', ensureFn('maxiArticlesProxy', maxiArticlesProxy));

/* ───────── Branding URL directa ───────── */
router.patch('/:id/branding-url', ensureFn('businesses.setBrandingUrl', businesses.setBrandingUrl));

/* ───────── MAXI: ping (usa sales.maxiPing) ───────── */
router.get('/:id/maxi-ping', ensureFn('sales.maxiPing', sales.maxiPing));

/* ───────── CRUD base ───────── */
router.get('/', ensureFn('businesses.listMine', businesses.listMine));
router.post('/', ensureFn('businesses.create', businesses.create));

/* Negocio activo (¡ojo orden antes de '/:id'!) */
router.get('/active', ensureFn('businesses.getActive', businesses.getActive));
router.patch('/active', ensureFn('businesses.setActive', businesses.setActive));

/* ───────── Maxi credenciales / estado ───────── */
router.get('/:id/maxi-status', ensureFn('businesses.maxiStatus', businesses.maxiStatus));
router.post('/:id/maxi-credentials', ensureFn('businesses.maxiSave', businesses.maxiSave));
router.post('/:id/maxi-refresh-menu', ensureFn('refreshMenu', refreshMenu));

/* ───────── Catálogo (lecturas legacy) ───────── */
router.get('/:id/articles', cacheJson(300), ensureFn('listArticlesFromDB', listArticlesFromDB));
router.get('/:id/articles/tree', cacheJson(300), ensureFn('listArticlesTreeFromDB', listArticlesTreeFromDB));

/* ───────── Ventas: export CSV ───────── */
router.get(
  '/:id/sales/export',
  ensureFn('sales.exportSalesCsv', sales.exportSalesCsv)
);

/* ───────── Ventas: items agregados por día ───────── */
router.get(
  '/:id/sales/items',
  ensureFn('sales.listDailyItems', sales.listDailyItems)
);

/* ───────── Ventas: resumen por artículo ───────── */
router.get(
  '/:id/sales/summary',
  ensureFn('sales.salesSummary', sales.salesSummary)
);

/* ───────── Ventas: primera fecha con datos (para Histórico) ───────── */
router.get(
  '/:id/sales/first-date',
  ensureFn('sales.getFirstSaleDate', sales.getFirstSaleDate)
);

/* ───────── Ventas legacy lectura (serie por artículo) ───────── */
function requireNumericParam(paramName) {
  return (req, res, next) => {
    const v = String(req.params[paramName] || '');
    if (!/^\d+$/.test(v)) return res.status(404).json({ error: 'not_found' });
    next();
  };
}

router.get(
  '/:id/sales/:articuloId',
  cacheJson(300),
  requireNumericParam('articuloId'),
  ensureFn('salesSeriesFromDB', salesSeriesFromDB)
);

/* ───────── Ventas: probes (diagnóstico) ───────── */
router.get('/:id/maxi-sales-probe', ensureFn('sales.maxiSalesProbe', sales.maxiSalesProbe));
router.get('/:id/maxi-sales-probe-v2', ensureFn('sales.maxiSalesProbeV2', sales.maxiSalesProbeV2));

router.get('/:id/sync-sales/diagnostic-raw', ensureFn('sales.diagnosticRaw', sales.diagnosticRaw));

/* ───────── Ventas V2 (estables) ───────── */
router.post('/:id/sync-sales/window', ensureFn('sales.syncWindow', sales.syncWindow));
router.post('/:id/sync-sales/backfill-once', ensureFn('sales.backfillOnce', sales.backfillOnce));
router.post('/:id/sync-sales/daily-auto', ensureFn('sales.dailyAuto', sales.dailyAuto));
router.post('/:id/sync-sales/rebuild-aggregates', ensureFn('sales.rebuildAggregates', sales.rebuildAggregates));

/* ───────── Adapter legacy para sync por body/query ───────── */
function adaptSyncSalesQueryToBody(req, _res, next) {
  const qMode = String(req.query.mode || '').toLowerCase();
  let mode = req.body?.mode || qMode || 'auto';
  if (qMode === 'backfill') mode = 'backfill_30d';

  const patch = { mode };
  if (req.query.windowDays && !req.body?.windowDays) {
    patch.windowDays = parseInt(String(req.query.windowDays), 10);
  }
  const cut = (s) => String(s || '').slice(0, 10);
  if (req.query.from && !req.body?.from) patch.from = cut(req.query.from);
  if (req.query.to && !req.body?.to) patch.to = cut(req.query.to);

  if ((req.query.dryrun === '1' || String(req.query.dryrun).toLowerCase() === 'true') && !req.body?.dryrun) {
    patch.dryrun = true;
  }
  req.body = { ...(req.body || {}), ...patch };
  next();
}

router.post(
  '/:id/sync-sales',
  adaptSyncSalesQueryToBody,
  async (req, res, next) => {
    try {
      const biz = req.business;
      const out = await sales.syncSalesForBusiness(biz, req.body, req);
      res.json({ ok: true, business_id: biz.id, sales: out });
    } catch (e) { next(e); }
  }
);

/* ───────── Sync catálogo (manual) ───────── */
router.post('/:id/sync', ensureFn('syncNow', syncNow));

/* Default group helpers */
router.get('/:id/default-group', (req, res) => {
  const biz = req.business;
  const defaultId = biz?.props?.default_group_id ?? null;
  res.json({ ok: true, business_id: biz.id, default_group_id: defaultId });
});

router.patch('/:id/default-group', async (req, res, next) => {
  try {
    const biz = req.business;
    const groupId = (req.body?.groupId === null) ? null : Number(req.body?.groupId);
    if (groupId !== null && !Number.isFinite(groupId)) {
      return res.status(400).json({ error: 'invalid_group_id' });
    }
    await require('../config/db').query(
      `UPDATE app_businesses
         SET props = COALESCE(props,'{}'::jsonb) || jsonb_build_object('default_group_id', $2::int)
       WHERE id = $1`,
      [biz.id, groupId]
    );
    res.json({ ok: true, business_id: biz.id, default_group_id: groupId });
  } catch (e) { next(e); }
});

router.post('/:id/sync-sales/reconcile-and-rebuild',
  ensureFn('sales.reconcileAndRebuild', sales.reconcileAndRebuild));

router.get('/:id/view-prefs', viewPrefsCtrl.getViewPrefs);
router.post('/:id/view-prefs', viewPrefsCtrl.saveViewPref);
router.get('/:id/fav-group', viewPrefsCtrl.getFavoriteGroup);
router.post('/:id/fav-group', viewPrefsCtrl.saveFavoriteGroup);

router.post('/:businessId/rebuild-article-map', businesses.rebuildForBusiness);

router.post('/:id/onboard', async (req, res, next) => {
  try {
    const businessId = Number(req.params.id);
    const daysBack = Number(req.query.daysBack || 7);

    const result = await onboardBusiness(businessId, { daysBack });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* Config del negocio — props públicas para el front */
router.get('/:id/config', async (req, res, next) => {
  try {
    const biz = req.business;
    const props = biz?.props || {};
    res.json({
      ok: true,
      config: {
        articulos_costo_ideal:  Number(props.articulos_costo_ideal  ?? 30),
        insumos_costo_ideal:    Number(props.insumos_costo_ideal    ?? 30),
        compras_alerta_semanas: Number(props.compras_alerta_semanas ?? 4),
        ventas_alerta_dias:     Number(props.ventas_alerta_dias     ?? 30),
        precio_costeo_insumos:  props.precio_costeo_insumos          || 'ultima_compra',
        redondeo_precios:       props.redondeo_precios               ?? null,
        divisa:                 props.divisa                         || 'ARS',
      },
    });
  } catch (e) { next(e); }
});

/* ───────── Import CSV de insumos (alias para UploadInsumosModal) ───────── */
const multerInsumos = require('multer')({ storage: require('multer').memoryStorage() });
const insumosCtrl   = require('../controllers/insumosController');

// El front llama a /businesses/:id/insumos/import-csv — lo redirigimos al controller
router.post(
  '/:id/insumos/import-csv',
  multerInsumos.single('file'),
  async (req, res, next) => {
    // Inyectar businessId para que getBusinessId() lo tome
    req.params.businessId = req.params.id;
    req.businessId = Number(req.params.id);
    if (!req.business) req.business = { id: Number(req.params.id) };
    return insumosCtrl.bulkUpsertCSV(req, res, next);
  }
);

/* ───────── ABM Manual de artículos ───────── */
const artABM = require('../controllers/articulosABMController');

// Rubros/categorías del negocio (para formulario de alta)
router.get('/:id/rubros', ensureFn('artABM.getRubros', artABM.getRubros));

// Artículos: sin-equivalencia debe ir ANTES de /:id/articles/:articleId
router.get('/:id/articles/sin-equivalencia', ensureFn('artABM.listSinEquivalencia', artABM.listSinEquivalencia));

// Lotes de artículos importados manualmente
router.get('/:id/articles/batches',                    ensureFn('artABM.listBatchesArticulos',   artABM.listBatchesArticulos));
router.get('/:id/articles/batches/:batchId/preview',   ensureFn('artABM.previewBatchArticulos',  artABM.previewBatchArticulos));
router.delete('/:id/articles/batches/:batchId',        ensureFn('artABM.deleteBatchArticulos',   artABM.deleteBatchArticulos));

// Alta manual de artículo
router.post('/:id/articles/manual', ensureFn('artABM.crearArticulo', artABM.crearArticulo));

// Editar artículo (manual o agregar equivalencia externa)
router.patch('/:id/articles/:articleId', ensureFn('artABM.actualizarArticulo', artABM.actualizarArticulo));

// Eliminar artículo manual (solo id < 0)
router.delete('/:id/articles/:articleId', ensureFn('artABM.eliminarArticulo', artABM.eliminarArticulo));

// Alerta de ventas (última fecha con datos)
router.get('/:id/articles-alertas-ventas', ensureFn('artABM.alertasVentas', artABM.alertasVentas));

/* ───────── Config de precio de costeo de insumos ───────── */
router.get('/:id/config-costeo', ensureFn('artABM.getConfigCosteo', artABM.getConfigCosteo));
router.patch('/:id/config-costeo', ensureFn('artABM.saveConfigCosteo', artABM.saveConfigCosteo));

/* ───────── Config endpoint — agregar campos que faltaban ───────── */

/* Por :id */
router.get('/:id', cacheJson(60), ensureFn('businesses.getOne', businesses.getOne));
router.patch('/:id', ensureFn('businesses.update', businesses.update));
router.delete('/:id', ensureFn('businesses.remove', businesses.remove));
router.post('/:id/select', ensureFn('businesses.select', businesses.select));

module.exports = router;