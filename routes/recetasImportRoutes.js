// routes/recetasImportRoutes.js
'use strict';

/**
 * Rutas para sync y carga de recetas:
 *
 *   POST /api/businesses/:businessId/recetas/sync-maxi
 *     → Llama a MaxiRest y sincroniza todas las recetas del negocio
 *
 *   POST /api/businesses/:businessId/recetas/import-csv
 *     → Sube un archivo CSV/XLSX y hace upsert de recetas
 */

const express = require('express');
const router  = express.Router({ mergeParams: true });
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const { syncRecetasFromMaxi }    = require('../services/maxiRecetasService');
const { importRecetasFromFile }  = require('../services/csvRecetasImportService');
const { authRequired }           = require('../middleware/authMiddleware');
const { requireBusinessAccess }  = require('../middleware/requireBusinessAccess');
const { MAX_FILE_SIZE_MB }       = require('../config/features');

const uploadsDir = path.join(__dirname, '../uploads/csv-temp');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: (Number(MAX_FILE_SIZE_MB) || 10) * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.csv', '.xls', '.xlsx'].includes(ext)) cb(null, true);
    else cb(new Error('Solo se permiten archivos CSV, XLS o XLSX'));
  },
});

const getBizId = (req) => {
  const n = Number(req.params.businessId ?? req.params.id);
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

// ── POST /:businessId/recetas/sync-maxi ──────────────────────────────────────
router.post(
  '/:businessId/recetas/sync-maxi',
  authRequired,
  (req, res, next) => requireBusinessAccess(req, res, next),
  async (req, res, next) => {
    try {
      const businessId = getBizId(req);
      if (!Number.isFinite(businessId)) {
        return res.status(400).json({ ok: false, error: 'invalid_business_id' });
      }

      const result = await syncRecetasFromMaxi({ businessId, req });
      return res.json(result);

    } catch (error) {
      console.error('[recetasImport] sync-maxi error:', error);

      // Errores conocidos de MaxiRest
      if (error.status === 400 || error.status === 401) {
        return res.status(error.status).json({
          ok: false,
          error: 'maxi_auth_error',
          message: error.message,
        });
      }
      if (error.status === 502 || error._maxi) {
        return res.status(502).json({
          ok: false,
          error: 'maxi_unavailable',
          message: error.message,
          detail: error._maxi,
        });
      }

      return next(error);
    }
  }
);

// ── POST /:businessId/recetas/import-csv ─────────────────────────────────────
router.post(
  '/:businessId/recetas/import-csv',
  authRequired,
  (req, res, next) => requireBusinessAccess(req, res, next),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const businessId = getBizId(req);
      if (!Number.isFinite(businessId)) {
        return res.status(400).json({ ok: false, error: 'invalid_business_id' });
      }

      if (!req.file) {
        return res.status(400).json({
          ok: false, error: 'file_required',
          message: 'Adjuntá un archivo CSV, XLS o XLSX',
        });
      }

      const result = await importRecetasFromFile({
        businessId,
        filePath:     req.file.path,
        originalName: req.file.originalname,
      });

      return res.json(result);

    } catch (error) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch {} }

      if (String(error.message || '').includes('Columnas faltantes')) {
        return res.status(400).json({ ok: false, error: 'invalid_format', message: error.message });
      }

      return next(error);
    }
  }
);

module.exports = router;