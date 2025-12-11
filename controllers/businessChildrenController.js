// controllers/businessChildrenController.js
/* eslint-disable no-console */
const pool = require('../config/db'); 
const { nanoid } = require('nanoid'); 

/**
 * simple slugify (suficiente para nombres en la app)
 */
function slugify(s = '') {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 120);
}

/**
 * POST /api/businesses/:id/create-child
 * Body: {
 *   name: string,
 *   owner_id?: number,            // opcional
 *   transfer?: {
 *     agrupaciones: boolean,
 *     agrupacionesIds?: number[],
 *     articulos: boolean,
 *     articulosIds?: number[],
 *     insumos: boolean,
 *     insumosIds?: number[]
 *   }
 * }
 *
 * Respuesta: { ok: true, child: {id,name,slug}, moved: { agrupaciones, articulos, insumos } }
 */
async function createChildBusiness(req, res) {
  const parentId = Number(req.params.id);
  if (!Number.isFinite(parentId) || parentId <= 0) {
    return res.status(400).json({ ok: false, error: 'Parent business id inválido' });
  }

  const { name, owner_id: ownerId, transfer = {} } = req.body || {};
  if (!name || String(name).trim() === '') {
    return res.status(400).json({ ok: false, error: 'El campo "name" es requerido' });
  }

  // ---- permiso (placeholder) ----
  // Aquí deberías verificar que req.user tenga permiso para crear subnegocios / mutar recursos.
  // Ejemplo:
  // if (!req.user || !req.user.isAdmin) return res.status(403).json({ ok:false, error:'Forbidden' })
  // Para no romper nada dejo esto como comentario.
  // --------------------------------

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) crear negocio hijo
    const slugBase = slugify(name);
    // para evitar colisiones podrías añadir un sufijo, aquí lo dejamos simple
    const slug = slugBase;
    const insertTxt = `
      INSERT INTO public.app_businesses (name, slug, owner_id, created_at, updated_at, parent_id)
      VALUES ($1, $2, $3, now(), now(), $4)
      RETURNING id, name, slug
    `;
    const insertRes = await client.query(insertTxt, [String(name).trim(), slug, ownerId || null, parentId]);
    const child = insertRes.rows[0];
    const childId = Number(child.id);

    const moved = { agrupaciones: 0, articulos: 0, insumos: 0 };

    // 2) mover agrupaciones (tabla: agrupaciones)
    if (transfer.agrupaciones === true) {
      if (Array.isArray(transfer.agrupacionesIds) && transfer.agrupacionesIds.length) {
        const ids = transfer.agrupacionesIds.map(Number).filter(Number.isFinite);
        if (ids.length) {
          const upd = await client.query(
            `UPDATE agrupaciones SET business_id = $1 WHERE business_id = $2 AND id = ANY($3::int[])`,
            [childId, parentId, ids]
          );
          moved.agrupaciones = upd.rowCount;
        }
      } else {
        const upd = await client.query(
          `UPDATE agrupaciones SET business_id = $1 WHERE business_id = $2`,
          [childId, parentId]
        );
        moved.agrupaciones = upd.rowCount;
      }
    }

    // 3) mover artículos (tabla: app_articles)
    if (transfer.articulos === true) {
      if (Array.isArray(transfer.articulosIds) && transfer.articulosIds.length) {
        const ids = transfer.articulosIds.map(Number).filter(Number.isFinite);
        if (ids.length) {
          const upd = await client.query(
            `UPDATE app_articles SET business_id = $1 WHERE business_id = $2 AND id = ANY($3::int[])`,
            [childId, parentId, ids]
          );
          moved.articulos = upd.rowCount;
        }
      } else {
        const upd = await client.query(
          `UPDATE app_articles SET business_id = $1 WHERE business_id = $2`,
          [childId, parentId]
        );
        moved.articulos = upd.rowCount;
      }
    }

    // 4) mover insumos (si querés: tabla insumos)
    if (transfer.insumos === true) {
      if (Array.isArray(transfer.insumosIds) && transfer.insumosIds.length) {
        const ids = transfer.insumosIds.map(Number).filter(Number.isFinite);
        if (ids.length) {
          const upd = await client.query(
            `UPDATE insumos SET business_id = $1 WHERE business_id = $2 AND id = ANY($3::int[])`,
            [childId, parentId, ids]
          );
          moved.insumos = upd.rowCount;
        }
      } else {
        const upd = await client.query(
          `UPDATE insumos SET business_id = $1 WHERE business_id = $2`,
          [childId, parentId]
        );
        moved.insumos = upd.rowCount;
      }
    }

    // ---- si necesitas mover otras tablas adicionales, aquí las podés añadir
    // ejemplos: agrupacion_articulos (si existe), insumo_group_items, maxi_article_map, etc.
    // Tené en cuenta relaciones y constraints: si alguna tabla tiene FK que impida mover, hay que adaptar.

    await client.query('COMMIT');
    return res.json({ ok: true, child, moved });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('createChildBusiness error', e);
    // intenta devolver info amigable
    const msg = e && e.message ? e.message : 'Error creando subnegocio';
    return res.status(500).json({ ok: false, error: msg });
  } finally {
    client.release();
  }
}

module.exports = {
  createChildBusiness,
};
