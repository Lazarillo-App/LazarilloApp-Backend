// controllers/sectoresController.js
//
// Vista Operación — sectores: un recorte de adentro de un negocio (Barra,
// Cocina, Salón) armado tildando agrupaciones enteras o rubros/subrubros
// sueltos. Define qué recetas ve una persona con rol Staff.
'use strict';

const pool = require('../config/db');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Cada negocio tiene siempre un sector fijo "Todos" (todo el negocio, no
// editable ni borrable) — se crea solo la primera vez que hace falta, en vez
// de engancharse al alta de negocio (que vive en otro controller).
async function ensureSectorTodos(client, businessId) {
  const { rows } = await client.query(
    `SELECT id FROM sectores WHERE business_id = $1 AND es_fijo = TRUE LIMIT 1`,
    [businessId]
  );
  if (rows.length) return rows[0].id;

  const { rows: created } = await client.query(
    `INSERT INTO sectores (business_id, nombre, color, es_fijo)
     VALUES ($1, 'Todos', '#3b82f6', TRUE)
     RETURNING id`,
    [businessId]
  );
  return created[0].id;
}

// Trae los scope_items de una lista de sectores, con el nombre de la
// agrupación resuelto (para mostrar el alcance resumido en la lista).
async function scopeItemsPorSector(client, sectorIds) {
  if (!sectorIds.length) return new Map();
  const { rows } = await client.query(
    `SELECT ssi.sector_id, ssi.tipo, ssi.agrupacion_id, ssi.rubro, ssi.subrubro,
            a.nombre AS agrupacion_nombre
       FROM sector_scope_items ssi
       JOIN agrupaciones a ON a.id = ssi.agrupacion_id
      WHERE ssi.sector_id = ANY($1::int[])
      ORDER BY a.nombre ASC, ssi.rubro ASC NULLS FIRST, ssi.subrubro ASC NULLS FIRST`,
    [sectorIds]
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.sector_id)) map.set(r.sector_id, []);
    map.get(r.sector_id).push({
      tipo: r.tipo,
      agrupacionId: r.agrupacion_id,
      agrupacionNombre: r.agrupacion_nombre,
      rubro: r.rubro,
      subrubro: r.subrubro,
    });
  }
  return map;
}

/**
 * GET /businesses/:businessId/sectores
 * Lista los sectores del negocio, con alcance resumido y cuántas personas
 * tiene asignadas cada uno (para no dejar borrar uno en uso).
 */
exports.listSectores = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const businessId = num(req.params.businessId);
    if (!businessId) return res.status(400).json({ ok: false, error: 'business_id requerido' });

    await ensureSectorTodos(client, businessId);

    const { rows: sectores } = await client.query(
      `SELECT s.id, s.nombre, s.color, s.es_fijo, s.created_at, s.updated_at,
              COALESCE((
                SELECT COUNT(*)::int FROM user_assignments ua
                 WHERE ua.revoked_at IS NULL
                   AND ua.sector_ids @> ARRAY[s.id]
              ), 0) AS personas
         FROM sectores s
        WHERE s.business_id = $1
        ORDER BY s.es_fijo DESC, s.nombre ASC`,
      [businessId]
    );

    const scopeMap = await scopeItemsPorSector(client, sectores.map((s) => s.id));

    res.json({
      ok: true,
      sectores: sectores.map((s) => ({
        id: s.id,
        nombre: s.nombre,
        color: s.color,
        esFijo: s.es_fijo,
        personas: s.personas,
        scope: s.es_fijo ? [] : (scopeMap.get(s.id) || []),
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      })),
    });
  } catch (e) {
    console.error('[sectores] listSectores error:', e);
    next(e);
  } finally {
    client.release();
  }
};

/**
 * GET /sectores/:sectorId
 */
exports.getSector = async (req, res, next) => {
  try {
    const sectorId = num(req.params.sectorId);
    if (!sectorId) return res.status(400).json({ ok: false, error: 'sector_id requerido' });

    const { rows } = await pool.query(`SELECT * FROM sectores WHERE id = $1`, [sectorId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'sector_not_found' });

    const scopeMap = await scopeItemsPorSector(pool, [sectorId]);
    const s = rows[0];
    res.json({
      ok: true,
      sector: {
        id: s.id,
        nombre: s.nombre,
        color: s.color,
        esFijo: s.es_fijo,
        scope: s.es_fijo ? [] : (scopeMap.get(sectorId) || []),
      },
    });
  } catch (e) {
    console.error('[sectores] getSector error:', e);
    next(e);
  }
};

// Reemplaza todo el scope de un sector de una (el editor manda el árbol
// completo tildado, no altas/bajas incrementales) — mismo criterio que ya usa
// el guardado de receta (DELETE + INSERT de receta_items).
async function reemplazarScope(client, sectorId, businessId, scope) {
  await client.query(`DELETE FROM sector_scope_items WHERE sector_id = $1`, [sectorId]);
  if (!Array.isArray(scope) || !scope.length) return;

  const agrupacionIds = [...new Set(scope.map((it) => num(it.agrupacionId)).filter(Boolean))];
  if (agrupacionIds.length) {
    const { rows: agrRows } = await client.query(
      `SELECT id FROM agrupaciones WHERE id = ANY($1::int[]) AND business_id = $2`,
      [agrupacionIds, businessId]
    );
    const validIds = new Set(agrRows.map((r) => r.id));
    const invalido = agrupacionIds.find((id) => !validIds.has(id));
    if (invalido) {
      const err = new Error('agrupacion_business_mismatch');
      err.status = 400;
      throw err;
    }
  }

  for (const item of scope) {
    const tipo = item.tipo;
    const agrupacionId = num(item.agrupacionId);
    if (!['agrupacion', 'rubro', 'subrubro'].includes(tipo) || !agrupacionId) continue;
    const rubro = tipo !== 'agrupacion' ? String(item.rubro || '').trim() || null : null;
    const subrubro = tipo === 'subrubro' ? String(item.subrubro || '').trim() || null : null;
    await client.query(
      `INSERT INTO sector_scope_items (sector_id, tipo, agrupacion_id, rubro, subrubro)
       VALUES ($1, $2, $3, $4, $5)`,
      [sectorId, tipo, agrupacionId, rubro, subrubro]
    );
  }
}

/**
 * POST /businesses/:businessId/sectores
 * Body: { nombre, color?, scope: [{tipo, agrupacionId, rubro?, subrubro?}] }
 */
exports.createSector = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const businessId = num(req.params.businessId);
    const nombre = String(req.body?.nombre || '').trim();
    const color = req.body?.color ? String(req.body.color).trim() : null;
    const scope = req.body?.scope;

    if (!businessId) return res.status(400).json({ ok: false, error: 'business_id requerido' });
    if (!nombre) return res.status(400).json({ ok: false, error: 'nombre requerido' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO sectores (business_id, nombre, color, es_fijo)
       VALUES ($1, $2, $3, FALSE) RETURNING id`,
      [businessId, nombre, color]
    );
    const sectorId = rows[0].id;
    await reemplazarScope(client, sectorId, businessId, scope);
    await client.query('COMMIT');

    res.status(201).json({ ok: true, sector: { id: sectorId, nombre, color, esFijo: false } });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[sectores] createSector error:', e);
    if (e.status === 400) return res.status(400).json({ ok: false, error: e.message });
    next(e);
  } finally {
    client.release();
  }
};

/**
 * PATCH /sectores/:sectorId
 * Body: { nombre?, color?, scope? }
 */
exports.updateSector = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const sectorId = num(req.params.sectorId);
    if (!sectorId) return res.status(400).json({ ok: false, error: 'sector_id requerido' });

    const { rows } = await client.query(`SELECT * FROM sectores WHERE id = $1`, [sectorId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'sector_not_found' });
    const current = rows[0];
    if (current.es_fijo) {
      return res.status(400).json({ ok: false, error: 'cannot_edit_sector_todos' });
    }

    const nombre = req.body?.nombre !== undefined ? String(req.body.nombre).trim() : null;
    const color = req.body?.color !== undefined ? (String(req.body.color).trim() || null) : undefined;
    const scope = req.body?.scope;

    await client.query('BEGIN');

    const sets = [];
    const vals = [];
    let i = 1;
    if (nombre) { vals.push(nombre); sets.push(`nombre = $${i++}`); }
    if (color !== undefined) { vals.push(color); sets.push(`color = $${i++}`); }
    if (sets.length) {
      sets.push('updated_at = NOW()');
      vals.push(sectorId);
      await client.query(`UPDATE sectores SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    }

    if (scope !== undefined) {
      await reemplazarScope(client, sectorId, current.business_id, scope);
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[sectores] updateSector error:', e);
    if (e.status === 400) return res.status(400).json({ ok: false, error: e.message });
    next(e);
  } finally {
    client.release();
  }
};

/**
 * DELETE /sectores/:sectorId
 */
exports.deleteSector = async (req, res, next) => {
  try {
    const sectorId = num(req.params.sectorId);
    if (!sectorId) return res.status(400).json({ ok: false, error: 'sector_id requerido' });

    const { rows } = await pool.query(`SELECT es_fijo FROM sectores WHERE id = $1`, [sectorId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'sector_not_found' });
    if (rows[0].es_fijo) return res.status(400).json({ ok: false, error: 'cannot_delete_sector_todos' });

    const { rows: enUso } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_assignments
        WHERE revoked_at IS NULL AND sector_ids @> ARRAY[$1::int]`,
      [sectorId]
    );
    if (enUso[0].n > 0) {
      return res.status(400).json({ ok: false, error: 'sector_en_uso', personas: enUso[0].n });
    }

    await pool.query(`DELETE FROM sectores WHERE id = $1`, [sectorId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[sectores] deleteSector error:', e);
    next(e);
  }
};
