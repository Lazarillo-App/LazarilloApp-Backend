// routes/businessRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const businesses = require('../controllers/businessController');
const syncCtrl = require('../controllers/syncController');
const salesSyncCtrl = require('../controllers/salesSyncController');
const { authRequired } = require('../middleware/authMiddleware');
const { requireBusinessAccessParam } = require('../middleware/requireBusinessAccess');
const { refreshMenu } = require('../controllers/maxiMenuController');

// 🔹 Nuevo: sync ventana simple (últimos N días)
const { runWindow } = require('../services/salesSyncPolicy');

// ===== Fallbacks defensivos para evitar TypeError si algo está indefinido =====
const maxiPing = (salesSyncCtrl && typeof salesSyncCtrl.maxiPing === 'function')
  ? salesSyncCtrl.maxiPing
  : (_req, res) => res.status(501).json({ error: 'not_implemented' });

const syncSalesForBusiness = (salesSyncCtrl && typeof salesSyncCtrl.syncSalesForBusiness === 'function')
  ? salesSyncCtrl.syncSalesForBusiness
  : async (_biz, _opts) => ({ note: 'not_implemented' });

const {
  listArticlesFromDB,
  listArticlesTreeFromDB,
  salesSummaryFromDB,
  salesSeriesFromDB,
  syncNow,
} = syncCtrl;

// ===== Carpeta de logos =====
const logosDir = path.join(__dirname, '..', 'uploads', 'logos');
fs.mkdirSync(logosDir, { recursive: true });

// ===== Multer storage =====
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, logosDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.png').toLowerCase();
    cb(null, `biz_${req.params.id}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|webp|gif|svg\+xml)/i.test(file.mimetype);
    cb(ok ? null : Object.assign(new Error('unsupported_file_type'), { code: 'UNSUPPORTED_TYPE' }));
  }
});

// ===== Auth/param =====
router.use(authRequired);
router.param('id', requireBusinessAccessParam);

// ===== Upload logo =====
// Acepta 'file', 'logo' o 'image' como nombre de campo (y fallback a any)
router.post('/:id/logo', (req, res, next) => {
  const uploadAny = upload.any();
  uploadAny(req, res, (err) => {
    if (err) {
      const status = (err.code === 'LIMIT_FILE_SIZE' || err.code === 'UNSUPPORTED_TYPE') ? 400 : 500;
      return res.status(status).json({
        error:
          err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' :
          err.code === 'UNSUPPORTED_TYPE' ? 'unsupported_file_type' :
          'upload_error'
      });
    }
    const arr = Array.isArray(req.files) ? req.files : [];
    const firstImg = arr.find(f => /^image\//i.test(f.mimetype)) || null;
    req.file = firstImg;

    // DEBUG temporal
    console.log('[upload-logo] content-type:', req.headers['content-type']);
    console.log('[upload-logo] files:', arr.map(f => ({ field: f.fieldname, type: f.mimetype, size: f.size })));
    console.log('[upload-logo] chosen:', !!req.file, req.file?.fieldname);

    if (!req.file) return res.status(400).json({ error: 'missing_file' });
    businesses.uploadLogo(req, res, next);
  });
});

/* ============ Logo: setear URL directa ============ */
router.patch('/:id/branding-url', businesses.setBrandingUrl);

/* =================== MAXI: ping =================== */
router.get('/:id/maxi-ping', maxiPing);

/* ========================= CRUD base ======================= */
router.get('/', businesses.listMine);
router.post('/', businesses.create);

// Negocio activo
router.get('/active', businesses.getActive);
router.patch('/active', businesses.setActive);

// Por :id (req.business ya cargado por router.param)
router.get('/:id', businesses.getOne);
router.patch('/:id', businesses.update);
router.delete('/:id', businesses.remove);
router.post('/:id/select', businesses.select);

/* ============== Maxi credenciales / estado ================= */
router.get('/:id/maxi-status', businesses.maxiStatus);
router.post('/:id/maxi-credentials', businesses.maxiSave);

// RAW Maxi (fullinvoicebydate) para diagnóstico
router.get('/:id/maxi-raw-invoices', businesses.maxiRawInvoices);
router.get('/:id/maxi-items', businesses.maxiItemsByDate);
router.post('/:id/maxi-refresh-menu', refreshMenu);

/* ================ Catálogo / Ventas (legacy) =============== */
router.get('/:id/articles', listArticlesFromDB);
router.get('/:id/articles/tree', listArticlesTreeFromDB);

router.get('/:id/sales/summary', salesSummaryFromDB);
router.get('/:id/sales/:articuloId', salesSeriesFromDB);

/* ================ Sync ventas: modo actual ================= */
router.post('/:id/sync-sales', async (req, res, next) => {
  try {
    const biz = req.business;
    const mode = (req.query.mode === 'backfill' || req.query.mode === 'backfill_30d') ? 'backfill_30d' : 'auto';
    const dryrun = req.query.dryrun === '1' || req.query.dryrun === 'true';
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    if ((from && isNaN(+from)) || (to && isNaN(+to))) {
      return res.status(400).json({ error: 'invalid_date' });
    }
    const out = await syncSalesForBusiness(biz, { mode, from, to, dryrun, req });
    res.json({ ok: true, business_id: biz.id, sales: out });
  } catch (e) { next(e); }
});

/* ========== 🔹 Nuevo: Sync manual “últimos N días” (default 7) ========== */
router.post('/:id/sync-sales-window', async (req, res, next) => {
  try {
    const biz = req.business;
    const windowDays = Math.min(Math.max(parseInt(req.body?.windowDays ?? '7', 10), 1), 30);
    const detail = await runWindow({ businessId: biz.id, days: windowDays });
    res.json({ ok: true, business_id: biz.id, window_days: windowDays, detail });
  } catch (e) { next(e); }
});

// Legacy de catálogo/otros (responde y dispara backfill si aplica)
router.post('/:id/sync', syncNow);

/* ============ Default group helpers ============ */
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

/* ====== (duplicado compatible) árbol artículos por businessId ====== */
router.get('/:businessId/articles-tree', businesses.getArticlesTree);

module.exports = router;
