// controllers/agrupacionesController.js
const pool = require('../config/db');

/* ========================= Helpers ========================= */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function getBusinessId(req) {
  const ctx = num(req.businessId);
  if (ctx != null) return ctx;

  const p = num(req.params?.businessId);
  if (p != null) return p;

  const h = num(req.header('X-Business-Id'));
  if (h != null) return h;

  return NaN;
}

function getDivisionId(req) {
  const h = num(req.header('X-Division-Id'));
  if (h != null) return h;

  const q = num(req.query?.divisionId);
  if (q != null) return q;

  return null;
}

/**
 * Resuelve división activa:
 * - si viene X-Division-Id: valida que pertenezca al business
 * - si no viene: usa la main division (is_main=true)
 * Devuelve: { divisionId, isMain }
 */
async function resolveDivision(businessId, req) {
  const requested = getDivisionId(req);

  if (requested != null) {
    const { rows } = await pool.query(
      `
      SELECT id, is_main
        FROM business_divisions
       WHERE id=$1 AND business_id=$2 AND is_active=true
       LIMIT 1
      `,
      [requested, businessId]
    );
    if (!rows[0]) {
      throw Object.assign(new Error('division_not_found'), { status: 404 });
    }
    return { divisionId: rows[0].id, isMain: !!rows[0].is_main };
  }

  const { rows } = await pool.query(
    `
    SELECT id, is_main
      FROM business_divisions
     WHERE business_id=$1 AND is_main=true AND is_active=true
     LIMIT 1
    `,
    [businessId]
  );

  if (!rows[0]) {
    throw Object.assign(new Error('main_division_missing'), { status: 500 });
  }

  return { divisionId: rows[0].id, isMain: true };
}

const normName = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const TODO_NAME = 'Sin Agrupación';
const DISC_NAME = 'Discontinuados';

function isTodoName(s) {
  const n = normName(s);
  return n === 'sin agrupacion' || n === 'todo';
}
function isDiscName(s) {
  const n = normName(s);
  return n === 'discontinuados' || n === 'descontinuados';
}

function parseArticleIds(body) {
  // acepta:
  // - { articulos:[{id,precio}] }
  // - { ids:[1,2] }
  // - { articleIds:[1,2] }
  // - { items:[{id}] } (por si aparece)
  let ids = [];

  if (Array.isArray(body?.articulos)) {
    ids = body.articulos.map((a) => num(a?.id)).filter(Boolean);
  } else if (Array.isArray(body?.items)) {
    ids = body.items.map((a) => num(a?.id)).filter(Boolean);
  } else if (Array.isArray(body?.ids)) {
    ids = body.ids.map(num).filter(Boolean);
  } else if (Array.isArray(body?.articleIds)) {
    ids = body.articleIds.map(num).filter(Boolean);
  }

  // unique
  return Array.from(new Set(ids));
}

/* ========================= System groups per division ========================= */

async function ensureSystemGroup(businessId, divisionId, systemKey, displayName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: found } = await client.query(
      `
      SELECT id
        FROM business_groups
       WHERE business_id=$1
         AND converted_to_division_id=$2
         AND (config->>'system') = $3
       LIMIT 1
      `,
      [businessId, divisionId, systemKey]
    );

    if (found[0]) {
      await client.query('COMMIT');
      return found[0].id;
    }

    const { rows: created } = await client.query(
      `
      INSERT INTO business_groups (business_id, name, status, converted_to_division_id, config)
      VALUES (
        $1, $2, 'active', $3,
        jsonb_set(COALESCE(config,'{}'::jsonb), '{system}', to_jsonb($4::text), true)
      )
      RETURNING id
      `,
      [businessId, displayName, divisionId, systemKey]
    );

    await client.query('COMMIT');
    return created[0].id;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function ensureDiscontinuados(businessId, divisionId) {
  return ensureSystemGroup(businessId, divisionId, 'discontinuados', DISC_NAME);
}

exports.ensureTodoAgrupacion = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    const { divisionId } = await resolveDivision(businessId, req);
    const id = await ensureSystemGroup(businessId, divisionId, 'todo', TODO_NAME);

    res.json({ ok: true, group_id: id, division_id: divisionId });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
};

/* ========================= Exclusiones (schema) =========================
   Tabla: group_exclusions(business_id, group_id, scope, ref_id)
   scope: 'categoria'|'subrubro'|'articulo'
*/

async function ensureGroupExclusionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_exclusions (
      id SERIAL PRIMARY KEY,
      business_id INT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
      group_id INT NOT NULL REFERENCES business_groups(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('categoria','subrubro','articulo')),
      ref_id TEXT NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (business_id, group_id, scope, ref_id)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_group_excl_biz_group
    ON group_exclusions (business_id, group_id);
  `);
}

exports.listarExclusiones = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const groupId = num(req.params.id);

    if (!Number.isFinite(businessId) || !Number.isFinite(groupId)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    await ensureGroupExclusionsTable();

    // Validar que el grupo exista y pertenezca al negocio
    const { rows: okG } = await pool.query(
      `SELECT 1 FROM business_groups WHERE id=$1 AND business_id=$2 LIMIT 1`,
      [groupId, businessId]
    );
    if (!okG[0]) return res.status(404).json({ ok: false, error: 'group_not_found' });

    const { rows } = await pool.query(
      `SELECT scope, ref_id
         FROM group_exclusions
        WHERE business_id=$1 AND group_id=$2
        ORDER BY scope, ref_id`,
      [businessId, groupId]
    );

    return res.json({ ok: true, items: rows });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  }
};

exports.upsertExclusiones = async (req, res) => {
  const client = await pool.connect();
  try {
    const businessId = getBusinessId(req);
    const groupId = num(req.params.id);

    if (!Number.isFinite(businessId) || !Number.isFinite(groupId)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const mode = String(req.body?.mode || '').toLowerCase();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!['add', 'remove'].includes(mode) || !items.length) {
      return res.status(400).json({ ok: false, error: 'payload inválido' });
    }

    await ensureGroupExclusionsTable();

    // Validar grupo
    const { rows: okG } = await pool.query(
      `SELECT 1 FROM business_groups WHERE id=$1 AND business_id=$2 LIMIT 1`,
      [groupId, businessId]
    );
    if (!okG[0]) return res.status(404).json({ ok: false, error: 'group_not_found' });

    await client.query('BEGIN');

    let added = 0;
    let removed = 0;

    if (mode === 'add') {
      for (const raw of items) {
        const scope = String(raw.scope || '').toLowerCase();
        const ref_id = String(raw.ref_id ?? '').trim();
        if (!['categoria', 'subrubro', 'articulo'].includes(scope) || !ref_id) continue;

        const r = await client.query(
          `INSERT INTO group_exclusions (business_id, group_id, scope, ref_id)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT DO NOTHING`,
          [businessId, groupId, scope, ref_id]
        );
        added += r.rowCount || 0;
      }
    } else {
      for (const raw of items) {
        const scope = String(raw.scope || '').toLowerCase();
        const ref_id = String(raw.ref_id ?? '').trim();
        if (!['categoria', 'subrubro', 'articulo'].includes(scope) || !ref_id) continue;

        const r = await client.query(
          `DELETE FROM group_exclusions
            WHERE business_id=$1 AND group_id=$2 AND scope=$3 AND ref_id=$4`,
          [businessId, groupId, scope, ref_id]
        );
        removed += r.rowCount || 0;
      }
    }

    await client.query('COMMIT');
    return res.json({ ok: true, added, removed, total: added + removed });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    return res.status(e.status || 500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};


/* ========================= Listar agrupaciones (main/sub) ========================= */

exports.obtenerAgrupaciones = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!Number.isFinite(businessId)) {
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    const { divisionId, isMain } = await resolveDivision(businessId, req);

    // Asegurar grupos sistema por división
    await ensureSystemGroup(businessId, divisionId, 'todo', TODO_NAME);
    await ensureDiscontinuados(businessId, divisionId);

    // Regla:
    // - MAIN: solo grupos NO convertidos a división y NO system
    // - SUB: grupos convertidos a esa división o asignados por division_group_assignments
    const sql = `
      SELECT 
        bg.id,
        bg.name as nombre,
        bg.description,
        bg.created_at,
        bg.updated_at,
        bg.converted_to_division_id,
        bg.config,
        COALESCE(
          (
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', aa.id,
                'nombre', aa.name,
                'categoria', COALESCE(c.nombre, 'Sin categoría'),
                'subrubro', COALESCE(s.nombre, 'Sin subrubro'),
                'precio', COALESCE(aa.price, 0)
              )
              ORDER BY aa.name
            )
            FROM article_groups ag
            JOIN app_articles aa ON aa.id = ag.article_id
            LEFT JOIN categorias c ON c.id = aa.categoria_id
            LEFT JOIN subrubros s ON s.id = aa.subrubro_id
            WHERE ag.group_id = bg.id
          ),
          '[]'::jsonb
        ) as articulos
      FROM business_groups bg
      WHERE bg.business_id = $1
        AND bg.status = 'active'
        AND (
          CASE WHEN $2::boolean = true
            THEN (
              bg.converted_to_division_id IS NULL
              AND COALESCE(bg.config->>'system','') NOT IN ('todo','discontinuados')
            )
            ELSE (
              bg.converted_to_division_id = $3
              OR EXISTS (
                SELECT 1
                  FROM division_group_assignments dga
                 WHERE dga.group_id = bg.id
                   AND dga.division_id = $3
              )
            )
          END
        )
      ORDER BY bg.id ASC
    `;

    const { rows } = await pool.query(sql, [businessId, isMain, divisionId]);

    // 👇 IMPORTANTE: compatible con tu front (apiAgrupaciones espera data)
    res.json({
      ok: true,
      business_id: businessId,
      division_id: divisionId,
      is_main: isMain,
      data: rows,
    });
  } catch (e) {
    console.error('obtenerAgrupaciones error:', e);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
};

/* ========================= CRUD base ========================= */

exports.crearAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    if (!Number.isFinite(businessId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    const nombre = String(req.body?.nombre ?? req.body?.name ?? '').trim();
    if (!nombre) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'El nombre es obligatorio' });
    }

    // bloquear nombres “system”
    if (isTodoName(nombre) || isDiscName(nombre)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'Nombre reservado' });
    }

    const { rows } = await client.query(
      `
      INSERT INTO business_groups (business_id, name, description, status)
      VALUES ($1, $2, $3, 'active')
      RETURNING id, name as nombre, description, created_at, updated_at
      `,
      [businessId, nombre, req.body?.description || null]
    );

    await client.query('COMMIT');
    res.status(201).json({ ok: true, group: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Ya existe una agrupación con ese nombre' });
    }
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

exports.actualizarAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    const id = num(req.params.id);

    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const sets = [];
    const vals = [];
    let i = 1;

    if (req.body?.nombre !== undefined || req.body?.name !== undefined) {
      const nombre = String(req.body?.nombre ?? req.body?.name ?? '').trim();
      if (!nombre) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'El nombre no puede quedar vacío' });
      }
      if (isTodoName(nombre) || isDiscName(nombre)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'Nombre reservado' });
      }

      vals.push(nombre);
      sets.push(`name = $${i++}`);
    }

    if (req.body?.description !== undefined) {
      vals.push(req.body.description || null);
      sets.push(`description = $${i++}`);
    }

    if (!sets.length) {
      await client.query('COMMIT');
      return res.json({ ok: true, group: null });
    }

    sets.push(`updated_at = NOW()`);
    vals.push(id, businessId);

    const { rows } = await client.query(
      `
      UPDATE business_groups
         SET ${sets.join(', ')}
       WHERE id = $${i++} AND business_id = $${i++}
       RETURNING id, name as nombre, description, created_at, updated_at
      `,
      vals
    );

    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });
    }

    await client.query('COMMIT');
    res.json({ ok: true, group: rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

exports.eliminarAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    const id = num(req.params.id);

    if (!Number.isFinite(businessId) || !Number.isFinite(id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    // no borrar system
    const { rows: meta } = await client.query(
      `SELECT config FROM business_groups WHERE id=$1 AND business_id=$2 LIMIT 1`,
      [id, businessId]
    );
    const system = meta[0]?.config?.system;
    if (system === 'todo' || system === 'discontinuados') {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'No se puede eliminar una agrupación del sistema' });
    }

    const { rowCount } = await client.query(
      `DELETE FROM business_groups WHERE id=$1 AND business_id=$2`,
      [id, businessId]
    );

    await client.query('COMMIT');
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Agrupación no encontrada' });

    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

/* ========================= Artículos en agrupación ========================= */

exports.agregarArticulosAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    const groupId = num(req.params.id);

    if (!Number.isFinite(businessId) || !Number.isFinite(groupId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    const articleIds = parseArticleIds(req.body);
    if (!articleIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'Sin artículos para agregar' });
    }

    for (const articleId of articleIds) {
      await client.query(
        `
        INSERT INTO article_groups (group_id, article_id)
        VALUES ($1, $2)
        ON CONFLICT (group_id, article_id) DO NOTHING
        `,
        [groupId, articleId]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, added: articleIds.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

exports.eliminarArticuloDeAgrupacion = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    const groupId = num(req.params.id);
    const articuloId = num(req.params.articuloId);

    if (!Number.isFinite(businessId) || !Number.isFinite(groupId) || !Number.isFinite(articuloId)) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }

    await pool.query(
      `DELETE FROM article_groups WHERE group_id=$1 AND article_id=$2`,
      [groupId, articuloId]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};

/* ========================= mover items entre grupos ========================= */
/**
 * POST /businesses/:businessId/agrupaciones/:fromId/move-items
 * body: { toGroupId|toId, articleIds|ids }
 */
exports.moveItemsBetweenGroups = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    const fromId = num(req.params.fromId);

    const toGroupId =
      num(req.body?.toGroupId) ??
      num(req.body?.toId) ??
      num(req.body?.groupId);

    const articleIds = Array.from(
      new Set(
        (Array.isArray(req.body?.articleIds) ? req.body.articleIds : Array.isArray(req.body?.ids) ? req.body.ids : [])
          .map(num)
          .filter(Boolean)
      )
    );

    if (!Number.isFinite(businessId) || !Number.isFinite(fromId) || !Number.isFinite(toGroupId) || !articleIds.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'payload inválido' });
    }

    for (const articleId of articleIds) {
      await client.query(`DELETE FROM article_groups WHERE group_id=$1 AND article_id=$2`, [fromId, articleId]);
      await client.query(
        `
        INSERT INTO article_groups (group_id, article_id)
        VALUES ($1,$2)
        ON CONFLICT (group_id, article_id) DO NOTHING
        `,
        [toGroupId, articleId]
      );
    }

    await client.query('COMMIT');
    res.json({ ok: true, moved: articleIds.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

/* ========================= create or move agrupacion ========================= */
/**
 * POST /businesses/:businessId/agrupaciones/create-or-move
 * body admite:
 *  - { nombre, articulos:[{id,precio}] }
 *  - { nombre, ids:[number] }
 *  - compat: { name, articleIds }
 *
 * Comportamiento:
 * - crea agrupación si no existe (por nombre exacto)
 * - mueve cada artículo: lo saca de grupos NO system del negocio y lo pone en el destino
 */
exports.createOrMoveAgrupacion = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const businessId = getBusinessId(req);
    if (!Number.isFinite(businessId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'business_id requerido' });
    }

    const nombre = String(req.body?.nombre ?? req.body?.name ?? '').trim();
    const description = req.body?.description ?? null;

    const explicitGroupId = num(req.body?.toGroupId ?? req.body?.groupId);
    const articleIds = parseArticleIds(req.body);

    let groupId = explicitGroupId;

    if (!groupId && nombre) {
      if (isTodoName(nombre) || isDiscName(nombre)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, error: 'Nombre reservado' });
      }

      const { rows: existing } = await client.query(
        `SELECT id FROM business_groups WHERE business_id=$1 AND name=$2 LIMIT 1`,
        [businessId, nombre]
      );

      if (existing[0]) {
        groupId = existing[0].id;
      } else {
        const { rows: created } = await client.query(
          `
          INSERT INTO business_groups (business_id, name, description, status)
          VALUES ($1,$2,$3,'active')
          RETURNING id
          `,
          [businessId, nombre, description]
        );
        groupId = created[0].id;
      }
    }

    if (!Number.isFinite(groupId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, error: 'nombre o groupId requerido' });
    }

    if (articleIds.length) {
      for (const articleId of articleIds) {
        // borrar asignación del artículo en otros grupos NO system (mismo business)
        await client.query(
          `
          DELETE FROM article_groups ag
          USING business_groups bg
          WHERE ag.group_id = bg.id
            AND ag.article_id = $1
            AND bg.business_id = $2
            AND COALESCE(bg.config->>'system','') NOT IN ('todo','discontinuados')
          `,
          [articleId, businessId]
        );

        // asignar al destino
        await client.query(
          `
          INSERT INTO article_groups (group_id, article_id)
          VALUES ($1,$2)
          ON CONFLICT (group_id, article_id) DO NOTHING
          `,
          [groupId, articleId]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true, groupId, moved: articleIds.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

/* ========================= exports ========================= */

module.exports = {
  crearAgrupacion: exports.crearAgrupacion,
  obtenerAgrupaciones: exports.obtenerAgrupaciones,
  actualizarAgrupacion: exports.actualizarAgrupacion,
  eliminarAgrupacion: exports.eliminarAgrupacion,
  agregarArticulosAgrupacion: exports.agregarArticulosAgrupacion,
  eliminarArticuloDeAgrupacion: exports.eliminarArticuloDeAgrupacion,

  ensureTodoAgrupacion: exports.ensureTodoAgrupacion,
  listarExclusiones: exports.listarExclusiones,
  upsertExclusiones: exports.upsertExclusiones,
  moveItemsBetweenGroups: exports.moveItemsBetweenGroups,
  createOrMoveAgrupacion: exports.createOrMoveAgrupacion,
};
