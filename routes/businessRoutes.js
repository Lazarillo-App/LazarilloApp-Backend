// routes/businessRoutes.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const businesses = require('../controllers/businessController');
const {
  listArticlesFromDB,
  listArticlesTreeFromDB,
  salesSummaryFromDB,
  salesSeriesFromDB,
  syncNow,
} = require('../controllers/syncController');

const { maxiPing, syncSalesForBusiness } = require('../controllers/salesSyncController');
const { authRequired } = require('../middleware/authMiddleware');
const { requireBusinessAccessParam } = require('../middleware/requireBusinessAccess');
const { refreshMenu } = require('../controllers/maxiMenuController');

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

/* ───────── Multer ───────── */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, logosDir),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '') || '.png').toLowerCase();
    cb(null, `biz_${req.params.id}_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|webp|gif|svg\+xml)/i.test(file.mimetype);
    cb(ok ? null : Object.assign(new Error('unsupported_file_type'), { code: 'UNSUPPORTED_TYPE' }));
  },
});

/* ───────── Auth + param :id ───────── */
router.use(authRequired);
router.param('id', requireBusinessAccessParam);

/* ───────── Logo: subir archivo ───────── */
const uploadFields = upload.fields([
  { name: 'file',  maxCount: 1 },
  { name: 'logo',  maxCount: 1 },
  { name: 'image', maxCount: 1 },
]);
router.post('/:id/logo', (req, res, next) => {
  uploadFields(req, res, (err) => {
    if (err) {
      const status = (err.code === 'LIMIT_FILE_SIZE' || err.code === 'UNSUPPORTED_TYPE') ? 400 : 500;
      return res.status(status).json({
        error:
          err.code === 'LIMIT_FILE_SIZE' ? 'file_too_large' :
          err.code === 'UNSUPPORTED_TYPE' ? 'unsupported_file_type' :
          'upload_error',
      });
    }
    const files = req.files || {};
    req.file = (files.file?.[0]) || (files.logo?.[0]) || (files.image?.[0]) || null;

    if (!req.file && !req.body?.url) return res.status(400).json({ error: 'missing_file' });
    return ensureFn('businesses.uploadLogo', businesses.uploadLogo)(req, res, next);
  });
});

/* ───────── Branding URL directa ───────── */
router.patch('/:id/branding-url', ensureFn('businesses.setBrandingUrl', businesses.setBrandingUrl));

/* ───────── MAXI: ping ───────── */
router.get('/:id/maxi-ping', ensureFn('maxiPing', maxiPing));

/* ───────── CRUD base ───────── */
router.get('/', ensureFn('businesses.listMine', businesses.listMine));
router.post('/', ensureFn('businesses.create', businesses.create));

/* Negocio activo (¡ojo orden antes de '/:id'!) */
router.get('/active', ensureFn('businesses.getActive', businesses.getActive));
router.patch('/active', ensureFn('businesses.setActive', businesses.setActive));

/* Por :id */
router.get('/:id', ensureFn('businesses.getOne', businesses.getOne));
router.patch('/:id', ensureFn('businesses.update', businesses.update));
router.delete('/:id', ensureFn('businesses.remove', businesses.remove));
router.post('/:id/select', ensureFn('businesses.select', businesses.select));

/* ───────── Maxi credenciales / estado ───────── */
router.get('/:id/maxi-status', ensureFn('businesses.maxiStatus', businesses.maxiStatus));
router.post('/:id/maxi-credentials', ensureFn('businesses.maxiSave', businesses.maxiSave));
// Diagnóstico crudo (si tuvieras handlers):
// router.get('/:id/maxi-raw-invoices', ensureFn('businesses.maxiRawInvoices', businesses.maxiRawInvoices));
// router.get('/:id/maxi-items', ensureFn('businesses.maxiItemsByDate', businesses.maxiItemsByDate));

router.post('/:id/maxi-refresh-menu', ensureFn('refreshMenu', refreshMenu));

/* ───────── Catálogo / Ventas (legacy lectura) ───────── */
router.get('/:id/articles', ensureFn('listArticlesFromDB', listArticlesFromDB));
router.get('/:id/articles/tree', ensureFn('listArticlesTreeFromDB', listArticlesTreeFromDB));
router.get('/:id/sales/summary', ensureFn('salesSummaryFromDB', salesSummaryFromDB));
router.get('/:id/sales/:articuloId', ensureFn('salesSeriesFromDB', salesSeriesFromDB));

/* ───────── Adapter para sync ventas (acepta query o body) ───────── */
function adaptSyncSalesQueryToBody(req, _res, next) {
  const qMode = String(req.query.mode || '').toLowerCase();
  let mode = req.body?.mode || qMode || 'auto';
  if (qMode === 'backfill') mode = 'backfill_30d';

  const patch = { mode };

  if (req.query.windowDays && !req.body?.windowDays) {
    patch.windowDays = parseInt(String(req.query.windowDays), 10);
  }
  if (req.query.from && !req.body?.from) patch.from = req.query.from;
  if (req.query.to   && !req.body?.to)   patch.to   = req.query.to;

  if ((req.query.dryrun === '1' || String(req.query.dryrun).toLowerCase() === 'true') && !req.body?.dryrun) {
    patch.dryrun = true;
  }

  req.body = { ...(req.body || {}), ...patch };
  next();
}

/* ───────── Sync ventas (oficial) ─────────
   OJO: syncSalesForBusiness no es handler Express; armamos wrapper.
*/
router.post(
  '/:id/sync-sales',
  adaptSyncSalesQueryToBody,
  async (req, res, next) => {
    try {
      const biz = req.business; // seteado por requireBusinessAccessParam
      const out = await syncSalesForBusiness(biz, req.body);
      res.json({ ok: true, business_id: biz.id, sales: out });
    } catch (e) {
      next(e);
    }
  }
);

/* ───────── Sync catálogo (manual) ───────── */
router.post('/:id/sync', ensureFn('syncNow', syncNow));

/* ───────── Default group helpers ───────── */
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

/* Ruta legacy eliminada: '/:businessId/articles-tree' */

module.exports = router;
