// routes/insumosImportRoutes.js
'use strict';

const express = require('express');
const router  = express.Router({ mergeParams: true });
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const { importInsumosFromFile }  = require('../services/csvInsumosImportService');
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

const getBizId  = (req) => { const n = Number(req.params.businessId ?? req.params.id); return Number.isFinite(n) && n > 0 ? n : NaN; };
const getUserId = (req) => req.user?.id;

/**
 * POST /api/businesses/:businessId/insumos/import-csv
 *
 * Sube un Excel exportado desde MaxiRest (Stock → Insumos)
 * y hace upsert en la tabla insumos por (business_id, codigo_maxi).
 * Siempre resuelve al negocio principal de la organización.
 */
router.post(
  '/:businessId/insumos/import-csv',
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
        message: 'Adjuntá un archivo CSV, XLS o XLSX exportado desde MaxiRest',
      });

      const ext      = path.extname(req.file.originalname).toLowerCase();
      const fileType = ext.replace('.', '');

      const result = await importInsumosFromFile({
        businessId,
        userId,
        filePath:     req.file.path,
        originalName: req.file.originalname,
        fileType,
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

module.exports = router;
/**
 * POST /api/businesses/:businessId/insumos/preview-columns
 * Analiza columnas del archivo sin importar — reutiliza la lógica de artículos
 */
const { previewColumns } = require('../services/csvInsumosImportService');
router.post(
  '/:businessId/insumos/preview-columns',
  authRequired,
  upload.single('file'),
  async (req, res) => {
    const bizId = getBizId(req);
    if (isNaN(bizId)) return res.status(400).json({ ok: false, error: 'business_id inválido' });
    if (!req.file)    return res.status(400).json({ ok: false, error: 'No se recibió archivo' });
    try {
      const result = await previewColumns(req.file.path);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    } finally {
      try { require('fs').unlinkSync(req.file.path); } catch {}
    }
  }
);

/**
 * POST /api/businesses/:businessId/insumos/import-rubros-csv
 * Importa rubros de insumos desde CSV/XLS
 */
const { upsertRubrosForBusiness } = require('../repos/insumosRubrosRepo');
const { parseFileToRows }         = require('../services/csvInsumosImportService');

router.post(
  '/:businessId/insumos/import-rubros-csv',
  authRequired,
  upload.single('file'),
  async (req, res) => {
    const bizId = getBizId(req);
    if (isNaN(bizId)) return res.status(400).json({ ok: false, error: 'business_id inválido' });
    if (!req.file)    return res.status(400).json({ ok: false, error: 'No se recibió archivo' });

    let mapeo = {};
    try { mapeo = JSON.parse(req.body.mapeo || '{}'); } catch {}

    try {
      const rows = await parseFileToRows(req.file.path);
      const items = [];

      for (const row of rows) {
        let codigo = null, nombre = null;
        for (const [col, rol] of Object.entries(mapeo)) {
          if (rol === 'codigo') codigo = row[col];
          if (rol === 'nombre') nombre = row[col];
        }
        if (codigo == null || nombre == null) continue;
        items.push({ codigo, nombre });
      }

      const result = await upsertRubrosForBusiness(bizId, items);
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[import-rubros-insumos]', e);
      res.status(500).json({ ok: false, error: e.message });
    } finally {
      try { require('fs').unlinkSync(req.file.path); } catch {}
    }
  }
);