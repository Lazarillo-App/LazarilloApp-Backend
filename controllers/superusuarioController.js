// controllers/superusuarioController.js
// Super usuarios de Lazarillo: listar, buscar cuentas y dar/quitar la bandera.
const pool = require('../config/db');
const { logAudit } = require('../services/audit/auditLog');

// La cuenta dueña de Lazarillo: super usuario fijo, nadie se lo puede quitar.
const DUENO = 'diegosebastianalbo@gmail.com';
const CAMPOS = `id, email, name, display_name, es_superusuario,
  (lower(email) = '${DUENO}') AS protegido`;

// GET /api/superusuarios            → los super usuarios actuales
// GET /api/superusuarios?q=texto    → busca cuentas por email o nombre (máx. 20)
exports.listar = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    let rows;
    if (q.length >= 2) {
      const like = `%${q}%`;
      ({ rows } = await pool.query(
        `SELECT ${CAMPOS} FROM app_users
          WHERE email ILIKE $1 OR COALESCE(name,'') ILIKE $1 OR COALESCE(display_name,'') ILIKE $1
          ORDER BY es_superusuario DESC, lower(email)
          LIMIT 20`, [like]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT ${CAMPOS} FROM app_users WHERE es_superusuario ORDER BY lower(email)`
      ));
    }
    res.json({ usuarios: rows, yo: Number(req.user.id) });
  } catch (e) {
    console.error('[superusuarios/listar] error:', e);
    res.status(500).json({ error: 'internal' });
  }
};

// PUT /api/superusuarios/:id  { es_superusuario: true|false }
exports.cambiar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const valor = req.body?.es_superusuario;
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id_invalido' });
    if (typeof valor !== 'boolean') return res.status(400).json({ error: 'es_superusuario_requerido' });
    // Nadie se quita a sí mismo: evita quedarse sin ningún super usuario por un clic.
    if (id === Number(req.user.id) && valor === false) {
      return res.status(400).json({ error: 'no_podes_quitarte_a_vos' });
    }
    if (valor === false) {
      const { rows: t } = await pool.query('SELECT lower(email) AS email FROM app_users WHERE id = $1', [id]);
      if (t[0]?.email === DUENO) return res.status(400).json({ error: 'es_el_dueno' });
    }
    const { rows } = await pool.query(
      `UPDATE app_users SET es_superusuario = $2 WHERE id = $1 RETURNING ${CAMPOS}`, [id, valor]
    );
    if (!rows[0]) return res.status(404).json({ error: 'no_encontrado' });
    try {
      await logAudit(null, {
        userId: req.user.id, entityType: 'app_user', entityId: id,
        action: 'update',
        diff: { after: { email: rows[0].email, es_superusuario: valor } },
        metadata: { tipo: valor ? 'superusuario_dar' : 'superusuario_quitar' },
      });
    } catch { /* la auditoría no frena el cambio */ }
    res.json({ usuario: rows[0] });
  } catch (e) {
    console.error('[superusuarios/cambiar] error:', e);
    res.status(500).json({ error: 'internal' });
  }
};
