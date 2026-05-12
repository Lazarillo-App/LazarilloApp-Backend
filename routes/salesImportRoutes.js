// routes/salesImportRoutes.js
// Igual que el original + soporte de branch_id en import y apply
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const pool = require('../config/db');
const { importFileToDatabase, listImports, getImportDetails } = require('../services/csvSalesImportService');
const { CSV_SALES_IMPORT_ENABLED, MAX_FILE_SIZE_MB } = require('../config/features');
const { requireBusinessAccess } = require('../middleware/requireBusinessAccess');
const { authRequired }          = require('../middleware/authMiddleware');

const requireBiz = (req, res, next) => requireBusinessAccess(req, res, next);

/* ─── helpers ─── */
const getBusinessIdParam = (req) => {
  const raw = req.params.businessId ?? req.params.id;
  const bid = Number(raw);
  return Number.isFinite(bid) && bid > 0 ? bid : NaN;
};

const getUserId = (req) => req.user?.id;

async function resolveSalesBizId(rawId) {
  if (!Number.isFinite(rawId) || rawId <= 0) return rawId;
  const { rows: [biz] } = await pool.query(
    `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [rawId]
  );
  if (biz?.created_from === 'from_group' && biz.organization_id) {
    const { rows: [root] } = await pool.query(
      `SELECT id FROM app_businesses
        WHERE organization_id = $1
          AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
        ORDER BY id ASC LIMIT 1`,
      [biz.organization_id]
    );
    if (root?.id) return root.id;
  }
  return rawId;
}

/* ─── multer ─── */
const uploadsDir = path.join(__dirname, '../uploads/csv-temp');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: (Number(MAX_FILE_SIZE_MB) || 10) * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.csv', '.xls', '.xlsx'].includes(ext)
      ? cb(null, true)
      : cb(new Error('Solo se permiten archivos: .csv, .xls, .xlsx'));
  },
});

/* ══════════════════════════════════════════════════════════════
   POST /:businessId/sales/import-csv
   ── CAMBIO: lee branch_id del body y lo propaga al import
════════════════════════════════════════════════════════════════ */
router.post('/:businessId/sales/import-csv', authRequired, requireBiz, upload.single('file'), async (req, res, next) => {
  try {
    if (!CSV_SALES_IMPORT_ENABLED) {
      return res.status(403).json({ ok: false, error: 'csv_import_disabled' });
    }

    const businessId = getBusinessIdParam(req);
    if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    if (!req.file) return res.status(400).json({ ok: false, error: 'file_required' });

    // ── NUEVO: branch_id desde el body del form (enviado por UploadCSVModal) ──
    const rawBranchId = req.body?.branch_id;
    const branchId    = rawBranchId && rawBranchId !== 'main' && rawBranchId !== ''
      ? Number(rawBranchId)
      : null;
    // null = datos del principal (sin sucursal), Number = sucursal específica

    // Validar que la sucursal pertenece al negocio (seguridad)
    if (branchId) {
      const { rows: bCheck } = await pool.query(
        `SELECT id FROM app_branches WHERE id = $1 AND business_id = $2`,
        [branchId, businessId]
      );
      if (!bCheck.length) {
        return res.status(400).json({ ok: false, error: 'branch_not_found_for_business' });
      }
    }

    const ext    = path.extname(req.file.originalname).toLowerCase();

    // Mapeo custom enviado desde el front (campo_interno → columna_archivo)
    const mapeoCustom = req.body?.mapeo
      ? (() => { try { return JSON.parse(req.body.mapeo); } catch { return {}; } })()
      : {};

    const result = await importFileToDatabase({
      businessId,
      userId,
      filePath:     req.file.path,
      originalName: req.file.originalname,
      fileType:     ext.replace('.', ''),
      branchId,
      mapeoCustom,
    });

    // Workaround: asegurarse de que branch_id quede guardado en el header del import
    // (por si el service no lo persiste internamente todavía)
    const importId = result?.import_id ?? result?.id ?? result?.data?.id;
    if (branchId && importId) {
      try {
        await pool.query(
          `UPDATE sales_csv_imports SET branch_id = $1 WHERE id = $2 AND business_id = $3`,
          [branchId, importId, businessId]
        );
        // También actualizar los items de staging
        await pool.query(
          `UPDATE sales_csv_import_items SET branch_id = $1 WHERE import_id = $2 AND business_id = $3`,
          [branchId, importId, businessId]
        );
      } catch (e) {
        console.warn('[salesImport] No se pudo setear branch_id en import:', e.message);
      }
    }

    return res.json({ ...result, branch_id: branchId });
  } catch (error) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch { }
    if (String(error.message || '').includes('límite'))
      return res.status(413).json({ ok: false, error: 'file_too_large', message: error.message });
    if (String(error.message || '').toLowerCase().includes('formato'))
      return res.status(400).json({ ok: false, error: 'invalid_format', message: error.message });
    return next(error);
  }
});

/* ─── GET /:businessId/sales/imports ─── */
router.get('/:businessId/sales/imports', authRequired, async (req, res, next) => {
  try {
    const rawId = getBusinessIdParam(req);
    if (!Number.isFinite(rawId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    const businessId = await resolveSalesBizId(rawId);
    const limit      = Math.min(Math.max(Number(req.query.limit || 20), 1), 200);
    const imports    = await listImports(businessId, { limit });
    res.json({ ok: true, imports, count: imports.length });
  } catch (e) { next(e); }
});

/* ─── GET /:businessId/sales/imports/:importId ─── */
router.get('/:businessId/sales/imports/:importId', authRequired, async (req, res, next) => {
  try {
    const rawId    = getBusinessIdParam(req);
    if (!Number.isFinite(rawId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    const businessId = await resolveSalesBizId(rawId);
    const importId   = Number(req.params.importId);
    if (!Number.isFinite(importId) || importId <= 0) return res.status(400).json({ ok: false, error: 'invalid_import_id' });
    const importDetails = await getImportDetails(importId, businessId);
    if (!importDetails) return res.status(404).json({ ok: false, error: 'import_not_found' });
    res.json({ ok: true, import: importDetails });
  } catch (e) { next(e); }
});

/* ─── GET /:businessId/sales/imports/:importId/items (debug) ─── */
router.get('/:businessId/sales/imports/:importId/items', authRequired, async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    const importId   = Number(req.params.importId);
    if (!Number.isFinite(businessId) || !Number.isFinite(importId) || importId <= 0)
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    const { rows: [hdr] } = await pool.query(
      `SELECT id, business_id, branch_id, status, date_from, date_to
       FROM sales_csv_imports WHERE id=$1 AND business_id=$2 LIMIT 1`,
      [importId, businessId]
    );
    if (!hdr) return res.status(404).json({ ok: false, error: 'import_not_found' });
    const { rows: [st] } = await pool.query(
      `SELECT COUNT(*)::int AS staged_rows, MIN(day) AS min_day, MAX(day) AS max_day
       FROM sales_csv_import_items WHERE import_id=$1 AND business_id=$2`,
      [importId, businessId]
    );
    res.json({ ok: true, import: hdr, staging: st });
  } catch (e) { next(e); }
});

/* ══════════════════════════════════════════════════════════════
   POST /:businessId/sales/imports/:importId/apply
   ── CAMBIO: propaga branch_id al INSERT en sales_daily_items
════════════════════════════════════════════════════════════════ */
router.post('/:businessId/sales/imports/:importId/apply', authRequired, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const rawBusinessId = getBusinessIdParam(req);
    const importId      = Number(req.params.importId);
    const userId        = getUserId(req);

    if (!Number.isFinite(rawBusinessId) || !Number.isFinite(importId) || importId <= 0)
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

    // Resolver subnegocio → principal
    const { rows: [biz] } = await pool.query(
      `SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [rawBusinessId]
    );
    let businessId = rawBusinessId;
    if (biz?.created_from === 'from_group' && biz.organization_id) {
      const { rows: [root] } = await pool.query(
        `SELECT id FROM app_businesses
          WHERE organization_id = $1
            AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
          ORDER BY id ASC LIMIT 1`,
        [biz.organization_id]
      );
      if (root?.id) businessId = root.id;
    }

    await client.query('BEGIN');

    const { rows: [imp] } = await client.query(
      `SELECT id, business_id, branch_id, status, date_from, date_to
       FROM sales_csv_imports
       WHERE id=$1 AND business_id=$2 FOR UPDATE`,
      [importId, businessId]
    );

    if (!imp) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'import_not_found' });
    }

    if (!['awaiting_approval', 'completed'].includes(imp.status)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'import_not_applicable', message: `status=${imp.status}` });
    }

    const { date_from: from, date_to: to, branch_id: branchId } = imp;
    if (!from || !to) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'missing_date_range' });
    }

    const { rows: [st] } = await client.query(
      `SELECT COUNT(*)::int AS staged_rows FROM sales_csv_import_items WHERE import_id=$1 AND business_id=$2`,
      [importId, businessId]
    );
    if (!st || st.staged_rows <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, error: 'no_staging_rows' });
    }

    // ── CAMBIO: DELETE y INSERT filtran por branch_id ──
    // Si hay branchId: solo reemplazar datos de esa sucursal en el rango
    // Si no (principal, null): solo reemplazar datos sin branch_id
    if (branchId) {
      await client.query(
        `DELETE FROM sales_daily_items
         WHERE business_id=$1 AND source='csv' AND day BETWEEN $2::date AND $3::date AND branch_id=$4`,
        [businessId, from, to, branchId]
      );
    } else {
      await client.query(
        `DELETE FROM sales_daily_items
         WHERE business_id=$1 AND source='csv' AND day BETWEEN $2::date AND $3::date AND branch_id IS NULL`,
        [businessId, from, to]
      );
    }

    const ins = await client.query(
      `INSERT INTO sales_daily_items
         (business_id, branch_id, day, article_id, qty, amount, article_name, source, created_at, updated_at)
       SELECT
         sci.business_id,
         $3,               -- branch_id del import header
         sci.day, sci.article_id, sci.qty, sci.amount, sci.article_name,
         'csv', NOW(), NOW()
       FROM sales_csv_import_items sci
       WHERE sci.import_id=$1 AND sci.business_id=$2`,
      [importId, businessId, branchId]
    );

    const { rebuildSalesDailyRange } = require('../services/salesDailyRebuildService');
    await rebuildSalesDailyRange({ businessId, from, to, client });

    await client.query(
      `UPDATE sales_csv_imports
       SET status='completed', rows_inserted=COALESCE(rows_inserted,0)+$3, processed_at=NOW()
       WHERE id=$1 AND business_id=$2`,
      [importId, businessId, ins.rowCount || 0]
    );

    await client.query('COMMIT');
    res.json({ ok: true, applied_rows: ins.rowCount || 0, import_id: importId, branch_id: branchId });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { }
    next(e);
  } finally {
    client.release();
  }
});

/* ─── POST /:businessId/sales/imports/:importId/reject ─── */
router.post('/:businessId/sales/imports/:importId/reject', authRequired, async (req, res, next) => {
  try {
    const businessId = getBusinessIdParam(req);
    const importId   = Number(req.params.importId);
    if (!Number.isFinite(businessId) || !Number.isFinite(importId) || importId <= 0)
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    const { rows: [imp] } = await pool.query(
      `UPDATE sales_csv_imports SET status='rejected', processed_at=NOW()
       WHERE id=$1 AND business_id=$2 AND status='awaiting_approval' RETURNING id`,
      [importId, businessId]
    );
    if (!imp) return res.status(409).json({ ok: false, error: 'not_rejectable' });
    await pool.query(
      `DELETE FROM sales_csv_import_items WHERE import_id=$1 AND business_id=$2`,
      [importId, businessId]
    );
    res.json({ ok: true, import_id: importId, rejected: true });
  } catch (e) { next(e); }
});

module.exports = router;