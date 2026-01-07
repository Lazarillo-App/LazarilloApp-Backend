// routes/salesImportRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { importFileToDatabase, listImports, getImportDetails } = require('../services/csvSalesImportService');
const { CSV_SALES_IMPORT_ENABLED, MAX_FILE_SIZE_MB } = require('../config/features');

// Asegurar que existe el directorio de uploads
const uploadsDir = path.join(__dirname, '../uploads/csv-temp');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configurar multer para uploads
const upload = multer({
  dest: uploadsDir,
  limits: { 
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024, // Convertir MB a bytes
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExtensions = ['.csv', '.xls', '.xlsx'];
    
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Solo se permiten archivos: ${allowedExtensions.join(', ')}`));
    }
  }
});

/**
 * POST /api/businesses/:businessId/sales/import-csv
 * Importa archivo CSV/XLS/XLSX de ventas
 */
router.post('/:businessId/sales/import-csv', upload.single('file'), async (req, res, next) => {
  try {
    // Verificar feature flag
    if (!CSV_SALES_IMPORT_ENABLED) {
      return res.status(403).json({ 
        error: 'csv_import_disabled',
        message: 'La importación de CSV está deshabilitada temporalmente'
      });
    }

    const businessId = parseInt(req.params.businessId);
    const userId = req.user?.id;
    
    if (!userId) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    if (!req.file) {
      return res.status(400).json({ 
        error: 'file_required',
        message: 'Debe adjuntar un archivo CSV, XLS o XLSX'
      });
    }

    // Detectar tipo de archivo por extensión
    const ext = path.extname(req.file.originalname).toLowerCase();
    const fileType = ext.replace('.', ''); // 'csv', 'xls', 'xlsx'

    console.log(`[CSV Import] Procesando: ${req.file.originalname} (${fileType}) para business ${businessId}`);

    // Importar archivo
    const result = await importFileToDatabase({
      businessId,
      userId,
      filePath: req.file.path,
      originalName: req.file.originalname,
      fileType
    });

    res.json(result);
  } catch (error) {
    console.error('[CSV Import API] Error:', error);
    
    // Limpiar archivo en caso de error
    if (req.file?.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {}
    }

    if (error.message.includes('límite')) {
      return res.status(413).json({ 
        error: 'file_too_large',
        message: error.message
      });
    }

    if (error.message.includes('Formato')) {
      return res.status(400).json({
        error: 'invalid_format',
        message: error.message
      });
    }

    next(error);
  }
});

/**
 * GET /api/businesses/:businessId/sales/imports
 * Lista historial de importaciones
 */
router.get('/:businessId/sales/imports', async (req, res, next) => {
  try {
    const businessId = parseInt(req.params.businessId);
    const limit = parseInt(req.query.limit || '20');
    
    const imports = await listImports(businessId, { limit });
    
    res.json({ 
      ok: true, 
      imports,
      count: imports.length
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/businesses/:businessId/sales/imports/:importId
 * Obtiene detalles de una importación específica
 */
router.get('/:businessId/sales/imports/:importId', async (req, res, next) => {
  try {
    const businessId = parseInt(req.params.businessId);
    const importId = parseInt(req.params.importId);
    
    const importDetails = await getImportDetails(importId, businessId);
    
    if (!importDetails) {
      return res.status(404).json({ 
        error: 'import_not_found',
        message: 'Importación no encontrada'
      });
    }
    
    res.json({ 
      ok: true, 
      import: importDetails
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;