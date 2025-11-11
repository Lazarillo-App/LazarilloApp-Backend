// routes/businesses.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const businesses = require('../controllers/businessController');
const syncCtrl = require('../controllers/syncController');
// const salesSyncCtrl = require('../controllers/salesSyncController'); // ← legacy/opcional

const { authRequired } = require('../middleware/authMiddleware');
// Si seguís usando el viejo param-guard, podés quitarlo. Lo reemplazamos por loadActiveBusiness.
//// const { requireBusinessAccessParam } = require('../middleware/requireBusinessAccess');

const { refreshMenu } = require('../controllers/maxiMenuController');

// Carga de negocio activo + membresía (lee businessId de header/query/body)
const { loadActiveBusiness } = require('../middleware/activeBusiness');
const { requireOwner, requireManager, requireStaff, requireViewer } = require('../middleware/requireBizRole');

// Para mantener consistencia en handlers movidos a businessController
const ctrl = require('../controllers/businessController');

// Sync ventana simple (últimos N días)
const { runWindow } = require('../services/salesSyncPolicy');

/* ───────── ensureFn: evita TypeError si falta algún handler ───────── */
function ensureFn(name, fn) {
  if (typeof fn !== 'function') {
    console.warn(`[routes/businesses] Handler faltante: ${name} -> responderá 501`);
    return (_req, res) => res.status(501).json({ error: 'not_implemented', handler: name });
  }
  return fn;
}

/* ───────── Fallbacks defensivos para controladores opcionales ───────── */
const maxiPing = ensureFn('salesSyncCtrl.maxiPing', undefined);
const syncSalesForBusiness = ensureFn('salesSyncCtrl.syncSalesForBusiness', undefined);

/* ───────── Carpeta de logos + Multer ───────── */
const logosDir = path.join(__dirname, '..', 'uploads', 'logos');
fs.mkdirSync(logosDir, { recursive: true });

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

/* ───────── Auth global ───────── */
router.use(authRequired);

/* 
 * Para rutas que llevan :id usamos este pequeño adaptador:
 * - inyecta businessId en req.query para que loadActiveBusiness lo capture
 * - luego ejecuta loadActiveBusiness que coloca req.business + req.membership
 */
function withBizFromParam(req, _res, next) {
  if (req.params?.id) req.query.businessId = req.params.id;
  next();
}

/* ───────── Rutas SIN :id (no requieren negocio cargado) ───────── */
// CRUD base (crear negocio = asigna owner en el controller)
router.get('/', businesses.listMine);          // ver mis negocios (auth)
router.post('/', businesses.create);           // crear negocio (asigna owner al creador)

// Negocio activo guardado en el perfil/props de usuario (no necesita rol de negocio)
router.get('/active', businesses.getActive);
router.patch('/active', businesses.setActive);

/* ───────── Rutas CON :id (cargan negocio + membership) ───────── */
router.use('/:id', withBizFromParam, loadActiveBusiness);

/* ───────── Branding / logos ───────── */
router.post('/:id/logo', requireManager, (req, res, next) => {
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

    if (!req.file) return res.status(400).json({ error: 'missing_file' });
    ctrl.uploadLogo(req, res, next);
  });
});

router.patch('/:id/branding-url', requireManager, businesses.setBrandingUrl);

/* ───────── MAXI: ping (diagnóstico) ───────── */
router.get('/:id/maxi-ping', requireViewer, maxiPing);

/* ───────── CRUD por :id ───────── */
router.get('/:id', requireViewer, businesses.getOne);     // ver datos del negocio
router.patch('/:id', requireManager, businesses.update);   // editar branding, props, etc.
router.delete('/:id', requireOwner, businesses.remove);    // eliminar negocio (solo owner)
router.post('/:id/select', requireViewer, businesses.select);

/* ───────── Maxi credenciales / estado ───────── */
router.get('/:id/maxi-status', requireViewer, businesses.maxiStatus);
router.post('/:id/maxi-credentials', requireManager, businesses.maxiSave); // owner/manager

/* ───────── RAW Maxi para diagnóstico (usa flujo del probe) ───────── */
router.get('/:id/maxi-raw-invoices', requireManager, businesses.maxiRawInvoices);
router.get('/:id/maxi-items',        requireManager, businesses.maxiItemsByDate);
router.post('/:id/maxi-refresh-menu', requireManager, refreshMenu);

/* ───────── Catálogo / Ventas (legacy compat) ───────── */
const {
  listArticlesFromDB,
  listArticlesTreeFromDB,
  salesSummaryFromDB,
  salesSeriesFromDB,
  syncNow,
} = syncCtrl;

// Lecturas → viewer+
router.get('/:id/articles',          requireViewer, listArticlesFromDB);
router.get('/:id/articles/tree',     requireViewer, listArticlesTreeFromDB);
router.get('/:id/sales/summary',     requireViewer, salesSummaryFromDB);
router.get('/:id/sales/:articuloId', requireViewer, salesSeriesFromDB);

// Legacy (dispara backfill/otros) → manager+
router.post('/:id/sync', requireManager, syncNow);

/* ───────── Sync ventas (oficial) ─────────
   Soporta mode=auto | range | backfill_30d en ctrl.syncSales (manager+)
*/
router.post('/:id/sync-sales-7d', requireManager, ensureFn('businesses.syncSalesLast7d', ctrl.syncSalesLast7d));
router.post('/:id/sync-sales',    requireManager, ensureFn('businesses.syncSales',       ctrl.syncSales));

/* ───────── Sync manual: “últimos N días” (default 7) → manager+ ───────── */
router.post('/:id/sync-sales-window', requireManager, async (req, res, next) => {
  try {
    const biz = req.business;
    const windowDays = Math.min(Math.max(parseInt(req.body?.windowDays ?? '7', 10), 1), 30);
    const detail = await runWindow({ businessId: biz.id, days: windowDays });
    res.json({ ok: true, business_id: String(biz.id), window_days: windowDays, detail });
  } catch (e) {
    next(e);
  }
});

/* ───────── Default group helpers (viewer+ lectura / manager+ escritura) ───────── */
router.get('/:id/default-group', requireViewer, (req, res) => {
  const biz = req.business;
  const defaultId = biz?.props?.default_group_id ?? null;
  res.json({ ok: true, business_id: biz.id, default_group_id: defaultId });
});

router.patch('/:id/default-group', requireManager, async (req, res, next) => {
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

/* ───────── Árbol artículos por businessId (duplicado compatible) ───────── */
router.get('/:businessId/articles-tree', withBizFromParam, loadActiveBusiness, requireViewer, businesses.getArticlesTree);

module.exports = router;
