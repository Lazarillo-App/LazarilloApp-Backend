// routes/recetaUploadRoutes.js
const express = require('express');
const router = express.Router();
const { randomUUID } = require('crypto');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../config/cloudinary');
const { authRequired } = require('../middleware/authMiddleware');
const pool = require('../config/db');

/* ── Cloudinary storage (igual que recetaFotosRoutes) ── */
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: `lazarillo/recetas/${req.params.articuloId || req.body?.articuloId || 'general'}`,
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'gif'],
    transformation: [{ width: 1200, height: 900, crop: 'limit', quality: 'auto' }],
    public_id: `supply_${req.body?.supplyId || 'item'}_${Date.now()}`,
  }),
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /image\/(png|jpe?g|webp|gif)/i.test(file.mimetype);
    cb(ok ? null : Object.assign(new Error('unsupported_file_type'), { code: 'UNSUPPORTED_TYPE' }), ok);
  },
});

/* ══════════════════════════════════════════════════
   1. Generar token de upload (requiere auth)
   POST /api/recetas/:articuloId/upload-token
   Body: { supplyId, supplyNombre, bizId }
   → { token, expiresAt, uploadUrl }
══════════════════════════════════════════════════ */
router.post('/:articuloId/upload-token', authRequired, async (req, res, next) => {
  try {
    const { articuloId } = req.params;
    const { supplyId, supplyNombre, bizId } = req.body;

    if (!bizId) return res.status(400).json({ error: 'missing_bizId' });

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    await pool.query(
      `INSERT INTO receta_upload_tokens
         (token, articulo_id, supply_id, supply_nombre, biz_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [token, articuloId, supplyId || null, supplyNombre || null, bizId, expiresAt]
    );

    // No armamos la URL en el backend — la arma el frontend

    return res.json({ token, expiresAt });

  } catch (err) {
    next(err);
  }
});

/* ══════════════════════════════════════════════════
   2. Upload público desde el celular (sin auth)
   POST /api/recetas/upload-publico
   Query: ?token=xxx
   Body: multipart con field "file"
   → { ok, url }
══════════════════════════════════════════════════ */
router.post('/upload-publico', upload.single('file'), async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'missing_token' });

    // Validar token
    const { rows } = await pool.query(
      `SELECT * FROM receta_upload_tokens
       WHERE token = $1 AND expires_at > NOW()`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'token_invalido_o_expirado' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'missing_file' });
    }

    const url = req.file.path;

    // Agregar URL al array de fotos del token
    await pool.query(
      `UPDATE receta_upload_tokens
       SET fotos_urls = array_append(fotos_urls, $1)
       WHERE token = $2`,
      [url, token]
    );

    return res.json({ ok: true, url });
  } catch (err) {
    next(err);
  }
});

/* ══════════════════════════════════════════════════
   3. Polling — leer fotos nuevas (requiere auth)
   GET /api/recetas/:articuloId/fotos-pendientes
   Query: ?supplyId=X&token=xxx
   → { fotos: string[] }
══════════════════════════════════════════════════ */
router.get('/:articuloId/fotos-pendientes', authRequired, async (req, res, next) => {
  try {
    const { articuloId } = req.params;
    const { supplyId, token } = req.query;

    if (!token) return res.status(400).json({ error: 'missing_token' });

    const { rows } = await pool.query(
      `SELECT fotos_urls FROM receta_upload_tokens
       WHERE token = $1
         AND articulo_id = $2
         AND ($3::integer IS NULL OR supply_id = $3::integer)
         AND expires_at > NOW()`,
      [token, articuloId, supplyId || null]
    );

    const fotos = rows[0]?.fotos_urls || [];
    return res.json({ fotos });
  } catch (err) {
    next(err);
  }
});

module.exports = router;