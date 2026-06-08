// routes/articulosImportRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const { importArticulosFromFile, parseFile } = require('../services/csvArticulosImportService');
const { importRubrosArticulosFromFile} = require('../services/csvArticulosRubrosImportService');
const { authRequired }                 = require('../middleware/authMiddleware');
const { requireBusinessAccess }        = require('../middleware/requireBusinessAccess');
const { MAX_FILE_SIZE_MB }             = require('../config/features');

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

const getBizId  = (req) => { const n = Number(req.params.businessId ?? req.params.id); return Number.isFinite(n) && n > 0 ? n : NaN; };
const getUserId = (req) => req.user?.id;


// ── POST /api/businesses/:businessId/articles/preview-columns ─────────────
// Devuelve las columnas detectadas y una muestra de filas sin importar nada
router.post(
  '/:businessId/articles/preview-columns',
  authRequired,
  (req, res, next) => requireBusinessAccess(req, res, next),
  upload.single('file'),
  async (req, res, next) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'file_required' });
    try {
      const rows = await parseFile(req.file.path);
      try { fs.unlinkSync(req.file.path); } catch { }
      const columnas = rows.length ? Object.keys(rows[0]) : [];
      return res.json({ ok: true, columnas, muestra: rows.slice(0, 5) });
    } catch (e) {
      try { fs.unlinkSync(req.file?.path); } catch { }
      return res.status(400).json({ ok: false, error: e.message });
    }
  }
);

// ── POST /api/businesses/:businessId/articles/import-csv ──────────────────
router.post(
  '/:businessId/articles/import-csv',
  authRequired,
  (req, res, next) => requireBusinessAccess(req, res, next),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const businessId = getBizId(req);
      if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

      if (!req.file) return res.status(400).json({
        ok: false, error: 'file_required',
        message: 'Adjuntá un archivo CSV, XLS o XLSX con el listado de artículos',
      });

      // Leer mapeo enviado por el front { COL: 'codigo'|'nombre'|'precio'|'rubro'|'subrubro'|'ignorar' }
      let mapeo = {};
      try {
        if (req.body?.mapeo) mapeo = JSON.parse(req.body.mapeo);
      } catch { mapeo = {}; }

      const result = await importArticulosFromFile({
        businessId,
        filePath:     req.file.path,
        originalName: req.file.originalname,
        mapeo,
      });

      return res.json(result);

    } catch (error) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { } }

      if (String(error.message || '').includes('Columnas faltantes') ||
          String(error.message || '').toLowerCase().includes('formato')) {
        return res.status(400).json({ ok: false, error: 'invalid_format', message: error.message });
      }

      return next(error);
    }
  }
);

// ── POST /api/businesses/:businessId/articles/import-rubros-csv ───────────
router.post(
  '/:businessId/articles/import-rubros-csv',
  authRequired,
  (req, res, next) => requireBusinessAccess(req, res, next),
  upload.single('file'),
  async (req, res, next) => {
    try {
      const businessId = getBizId(req);
      if (!Number.isFinite(businessId)) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

      const userId = getUserId(req);
      if (!userId) return res.status(401).json({ ok: false, error: 'unauthorized' });

      if (!req.file) return res.status(400).json({
        ok: false, error: 'file_required',
        message: 'Adjuntá un archivo CSV, XLS o XLSX con el listado de rubros',
      });

      let mapeoRubros = {};
      try { if (req.body?.mapeo) mapeoRubros = JSON.parse(req.body.mapeo); } catch { }

      // destino: 'categoria' | 'subrubro' — dónde guardar los nombres en maxi_articles
      const destino = ['categoria', 'subrubro'].includes(req.body?.destino)
        ? req.body.destino
        : 'categoria';

      const result = await importRubrosArticulosFromFile({
        businessId,
        filePath:     req.file.path,
        originalName: req.file.originalname,
        mapeo:        mapeoRubros,
        destino,
      });

      return res.json(result);

    } catch (error) {
      if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch { } }
      return next(error);
    }
  }
);

module.exports = router;