const express = require('express');
const router = express.Router();
const path = require('path');
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

// almacenamiento local simple (podés cambiar a S3/GCS más adelante)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads', 'logos')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
    cb(null, `biz_${req.params.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// … tu código actual …
router.use(authRequired);
router.param('id', requireBusinessAccessParam);

// ================== LOGO: subir archivo ==================
router.post('/:id/logo', upload.single('file'), businesses.uploadLogo);

// ============ LOGO: setear URL directa (sin archivo) =====
router.patch('/:id/branding-url', businesses.setBrandingUrl);

router.use(authRequired);

// Cargar y validar acceso a :id automáticamente
router.param('id', requireBusinessAccessParam);

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

/* ================ Catálogo / Ventas (legacy) =============== */
router.get('/:id/articles', listArticlesFromDB);
router.get('/:id/articles/tree', listArticlesTreeFromDB);

router.get('/:id/sales/summary', salesSummaryFromDB);
router.get('/:id/sales/:articuloId', salesSeriesFromDB);

/* ================ Sync ventas (nuevo) ====================== */
router.post('/:id/sync-sales', async (req, res, next) => {
  try {
    const biz = req.business;                // ya viene del param
    const mode =
      (req.query.mode === 'backfill' || req.query.mode === 'backfill_30d')
        ? 'backfill_30d'
        : 'auto';

    const dryrun = req.query.dryrun === '1' || req.query.dryrun === 'true';
    const from = req.query.from ? new Date(req.query.from) : null;
    const to   = req.query.to   ? new Date(req.query.to)   : null;
    if ((from && isNaN(+from)) || (to && isNaN(+to))) {
      return res.status(400).json({ error: 'invalid_date' });
    }

    const out = await syncSalesForBusiness(biz, { mode, from, to, dryrun, req });
    res.json({ ok: true, business_id: biz.id, sales: out });
  } catch (e) { next(e); }
});

// Legacy de catálogo/otros (responde y dispara backfill si aplica)
router.post('/:id/sync', syncNow);

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
    // guardamos en props para no romper historiales
    await require('../config/db').query(
      `UPDATE app_businesses
         SET props = COALESCE(props,'{}'::jsonb) || jsonb_build_object('default_group_id', $2::int)
       WHERE id = $1`,
      [biz.id, groupId]
    );
    res.json({ ok: true, business_id: biz.id, default_group_id: groupId });
  } catch (e) { next(e); }
});

module.exports = router;
