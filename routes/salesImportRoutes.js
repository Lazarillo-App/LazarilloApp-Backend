// routes/salesImportRoutes.js
const express = require('express');
const router = express.Router({ mergeParams: true });

const multer = require('multer');
const path = require('path');
const fs = require('fs');

const pool = require('../config/db');
const {
  importFileToDatabase,
  listImports,
  getImportDetails,
} = require('../services/csvSalesImportService');

const { CSV_SALES_IMPORT_ENABLED, MAX_FILE_SIZE_MB } = require('../config/features');
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');
const requireBiz = (req, res, next) => requireBusinessAccess(req, res, next);

// si ya tenés auth middleware en el proyecto, usalo
const { authRequired } = require('../middleware/authMiddleware');

// ---------- helpers ----------
const getBusinessIdParam = (req) => {
  // soporta: /:businessId/... o si viene desde router padre /api/businesses/:businessId
  const raw = req.params.businessId ?? req.params.id;
  const bid = Number(raw);
  if (!Number.isFinite(bid) || bid <= 0) return NaN;
  return bid;
};

const getUserId = (req) => req.user?.id;

// ---------- uploads ----------
const uploadsDir = path.join(__dirname, '../uploads/csv-temp');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: (Number(MAX_FILE_SIZE_MB) || 10) * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.csv', '.xls', '.xlsx'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error(`Solo se permiten archivos: ${allowed.join(', ')}`));
  },
});

/**
 * POST /api/businesses/:businessId/sales/import-csv
 * (o si lo montás sin prefijo) POST /:businessId/sales/import-csv
 */
router.post('/:businessId/sales/import-csv', authRequired, requireBiz, upload.single('file'), async (req, res, next) => {
  try {
    if (!CSV_SALES_IMPORT_ENABLED) {
      return res.status(403).json({
        ok: false,
        error: 'csv_import_disabled',
        message: 'La importación de CSV está deshabilitada temporalmente',
      });
    }

    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: 'file_required',
        message: 'Debe adjuntar un archivo CSV, XLS o XLSX',
      });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileType = ext.replace('.', '');

    const result = await importFileToDatabase({
      businessId,
      userId,
      filePath: req.file.path,
      originalName: req.file.originalname,
      fileType,
    });

    return res.json(result);
  } catch (error) {
    // best effort: si el service no lo borró
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch { }
    }

    if (String(error.message || '').includes('límite')) {
      return res.status(413).json({ ok: false, error: 'file_too_large', message: error.message });
    }

    if (String(error.message || '').toLowerCase().includes('formato')) {
      return res.status(400).json({ ok: false, error: 'invalid_format', message: error.message });
    }

    return next(error);
  }
});

/**
 * GET /:businessId/sales/imports
 */
router.get('/:businessId/sales/imports', authRequired, async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 200);
    const imports = await listImports(businessId, { limit });

    res.json({ ok: true, imports, count: imports.length });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /:businessId/sales/imports/:importId
 */
router.get('/:businessId/sales/imports/:importId', authRequired, async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    }

    const importId = Number(req.params.importId);
    if (!Number.isFinite(importId) || importId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_import_id' });
    }

    const importDetails = await getImportDetails(importId, businessId);
    if (!importDetails) {
      return res.status(404).json({ ok: false, error: 'import_not_found' });
    }

    res.json({ ok: true, import: importDetails });
  } catch (error) {
    next(error);
  }
});

/**
 * (DEBUG) GET /:businessId/sales/imports/:importId/items
 * Te muestra cuántas filas hay en staging y rango.
 */
router.get('/:businessId/sales/imports/:importId/items', authRequired, async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    const importId = Number(req.params.importId);
    if (!Number.isFinite(businessId) || !Number.isFinite(importId) || importId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    const { rows: [hdr] } = await pool.query(
      `
      SELECT id, business_id, status, date_from, date_to
      FROM sales_csv_imports
      WHERE id=$1 AND business_id=$2
      LIMIT 1
      `,
      [importId, businessId]
    );

    if (!hdr) return res.status(404).json({ ok: false, error: 'import_not_found' });

    const { rows: [st] } = await pool.query(
      `
      SELECT COUNT(*)::int AS staged_rows,
             MIN(day) AS min_day,
             MAX(day) AS max_day
      FROM sales_csv_import_items
      WHERE import_id=$1 AND business_id=$2
      `,
      [importId, businessId]
    );

    res.json({ ok: true, import: hdr, staging: st });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /:businessId/sales/imports/:importId/apply
 * Aplica el replace_range desde staging a sales_daily_items.
 * Solo cuando status = awaiting_approval (o processing si querés).
 */
router.post('/:businessId/sales/imports/:importId/apply', authRequired, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const businessId = getBusinessIdParam(req);
    const importId = Number(req.params.importId);
    const userId = getUserId(req);

    if (!Number.isFinite(businessId) || !Number.isFinite(importId) || importId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    await client.query('BEGIN');

    const { rows: [imp] } = await client.query(
      `
      SELECT id, business_id, status, date_from, date_to
      FROM sales_csv_imports
      WHERE id=$1 AND business_id=$2
      FOR UPDATE
      `,
      [importId, businessId]
    );

    if (!imp) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'import_not_found' });
    }

    if (!['awaiting_approval', 'completed'].includes(imp.status)) {
      // completed lo dejo pasar si querés re-aplicar (no recomendado) -> podés cambiarlo a strict
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        error: 'import_not_applicable',
        message: `status=${imp.status} no permite apply`,
      });
    }

    const from = imp.date_from;
    const to = imp.date_to;
    if (!from || !to) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'missing_date_range' });
    }

    const { rows: [st] } = await client.query(
      `
      SELECT COUNT(*)::int AS staged_rows
      FROM sales_csv_import_items
      WHERE import_id=$1 AND business_id=$2
      `,
      [importId, businessId]
    );

    if (!st || st.staged_rows <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'no_staging_rows' });
    }

    // replace_range (igual que en service)
    await client.query(
      `
      DELETE FROM sales_daily_items
      WHERE business_id = $1
        AND source='csv'
        AND day BETWEEN $2::date AND $3::date
      `,
      [businessId, from, to]
    );

    const ins = await client.query(
      `
      INSERT INTO sales_daily_items
        (business_id, day, article_id, qty, amount, article_name, source, created_at, updated_at)
      SELECT
        business_id, day, article_id, qty, amount, article_name,
        'csv', NOW(), NOW()
      FROM sales_csv_import_items
      WHERE import_id = $1 AND business_id = $2
      `,
      [importId, businessId]
    );
    const { rebuildSalesDailyRange } = require('../services/salesDailyRebuildService'); 

    await rebuildSalesDailyRange({
      businessId,
      from,
      to,
      client, // misma transacción
    });

    await client.query(
      `
      UPDATE sales_csv_imports
      SET status='completed',
          rows_inserted = COALESCE(rows_inserted,0) + $3,
          processed_at = NOW()
      WHERE id=$1 AND business_id=$2
      `,
      [importId, businessId, ins.rowCount || 0]
    );

    await client.query('COMMIT');

    res.json({ ok: true, applied_rows: ins.rowCount || 0, import_id: importId });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    next(e);
  } finally {
    client.release();
  }
});

/**
 * POST /:businessId/sales/imports/:importId/reject
 * Marca el import como rejected y opcionalmente limpia staging.
 */
router.post('/:businessId/sales/imports/:importId/reject', authRequired, async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    const importId = Number(req.params.importId);
    if (!Number.isFinite(businessId) || !Number.isFinite(importId) || importId <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }

    const { rows: [imp] } = await pool.query(
      `
      UPDATE sales_csv_imports
      SET status='rejected', processed_at=NOW()
      WHERE id=$1 AND business_id=$2 AND status='awaiting_approval'
      RETURNING id
      `,
      [importId, businessId]
    );

    if (!imp) {
      return res.status(409).json({ ok: false, error: 'not_rejectable' });
    }

    // opcional: limpiar staging para no ocupar espacio
    await pool.query(
      `DELETE FROM sales_csv_import_items WHERE import_id=$1 AND business_id=$2`,
      [importId, businessId]
    );

    res.json({ ok: true, import_id: importId, rejected: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
