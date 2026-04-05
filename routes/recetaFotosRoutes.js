// routes/recetaFotosRoutes.js
// Endpoint para subir fotos de ingredientes de recetas a Cloudinary
// Sigue el mismo patrón que el upload de logos en businessRoutes.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary'); // mismo config que logos
const { authRequired } = require('../middleware/authMiddleware');

/* ───────── Cloudinary Storage para fotos de recetas ───────── */
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const articuloId = req.params.articuloId || req.body?.articuloId || 'general';
    const supplyId   = req.params.supplyId   || req.body?.supplyId   || 'item';
    return {
      folder: `lazarillo/recetas/${articuloId}`,
      allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'gif'],
      transformation: [{ width: 1200, height: 900, crop: 'limit', quality: 'auto' }],
      public_id: `supply_${supplyId}_${Date.now()}`,
    };
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|webp|gif)/i.test(file.mimetype);
    if (!ok) return cb(Object.assign(new Error('unsupported_file_type'), { code: 'UNSUPPORTED_TYPE' }));
    cb(null, true);
  },
});

router.use(authRequired);

/**
 * POST /api/recetas/:articuloId/fotos
 * Sube una foto de un ingrediente de la receta a Cloudinary.
 * Body (multipart): file (imagen)
 * Returns: { ok: true, url: string, public_id: string }
 */
router.post('/:articuloId/fotos', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: 'missing_file',
        accept: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
        max_mb: 8,
      });
    }

    // Cloudinary devuelve la URL en req.file.path cuando se usa multer-storage-cloudinary
    const url       = req.file.path;
    const publicId  = req.file.filename;

    return res.json({ ok: true, url, public_id: publicId });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/recetas/fotos/:publicId
 * Elimina una foto de Cloudinary por su public_id.
 * Body: { publicId: string }
 */
router.delete('/fotos/:publicId(*)', async (req, res, next) => {
  try {
    const publicId = req.params.publicId;
    if (!publicId) return res.status(400).json({ error: 'missing_public_id' });

    await cloudinary.uploader.destroy(publicId);
    return res.json({ ok: true, deleted: publicId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
