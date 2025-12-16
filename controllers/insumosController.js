// controllers/insumosController.js
const pool = require('../config/db');
const db = require('../config/db');
const { parse } = require('csv-parse/sync');
const getBusinessId = require('../utils/getBusinessId'); // ✅ ÚNICO punto de verdad
const {
  fetchMaxiInsumos,
  normalizarInsumosMaxi,
  fetchMaxiInsumosRubros,
  normalizarInsumosRubros,
} = require('../services/maxiSuppliesService');

const { upsertFromMaxi } = require('../repos/insumosRepo');
const insumosRubrosRepo = require('../repos/insumosRubrosRepo');

// ✅ Helpers seguros
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ✅ Whitelist para ORDER BY (evita SQL injection)
const ALLOWED_ORDER_BY = ['nombre', 'codigo_maxi', 'rubro', 'unidad_med', 'precio_ref', 'created_at'];

if (process.env.NODE_ENV !== 'production') {
  console.log('💡 insumosController.js cargado');
}

// ===================== LISTAR / CRUD BÁSICO =====================
exports.listar = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = '',
      rubro,
      unidadMed,
      origen,
      orderBy = 'nombre',
      order = 'ASC',
      elaborados,
      estado,
      sinAgrupacion,
    } = req.query;

    const businessId = getBusinessId(req); // ✅ función única
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const where = [];
    const params = [];

    params.push(businessId);
    where.push(`business_id = $${params.length}`);

    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      where.push(
        `(nombre ILIKE $${params.length - 1} OR codigo_maxi ILIKE $${params.length})`
      );
    }

    if (rubro) {
      params.push(String(rubro));
      where.push(`rubro = $${params.length}`);
    }

    if (unidadMed) {
      params.push(unidadMed);
      where.push(`unidad_med = $${params.length}`);
    }

    if (origen) {
      params.push(origen);
      where.push(`origen = $${params.length}`);
    }

    if (estado && estado !== 'all') {
      params.push(estado);
      where.push(`estado = $${params.length}`);
    }

    if (sinAgrupacion === 'true') {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM insumo_group_items gi
          JOIN insumo_groups g ON g.id = gi.group_id
          WHERE gi.insumo_id = insumos.id
            AND g.business_id = insumos.business_id
        )
      `);
    }

    if (elaborados === 'true') {
      where.push(`
        EXISTS (
          SELECT 1
          FROM insumo_rubros ir
          WHERE ir.business_id = insumos.business_id
            AND ir.codigo::text = insumos.rubro
            AND ir.es_elaborador = true
        )
      `);
    }

    if (elaborados === 'false') {
      where.push(`
        NOT EXISTS (
          SELECT 1
          FROM insumo_rubros ir
          WHERE ir.business_id = insumos.business_id
            AND ir.codigo::text = insumos.rubro
            AND ir.es_elaborador = true
        )
      `);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const hardLimit = Math.min(Math.max(Number(limit), 1), 10000);
    const offset = (Number(page) - 1) * hardLimit;

    // ✅ ORDER BY seguro
    const safeOrderBy = ALLOWED_ORDER_BY.includes(orderBy) ? orderBy : 'nombre';
    const safeOrder = order === 'DESC' ? 'DESC' : 'ASC';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `
        SELECT *
        FROM insumos
        ${whereSql}
        ORDER BY ${safeOrderBy} ${safeOrder}
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
      `,
        [...params, hardLimit, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM insumos ${whereSql}`,
        params
      ),
    ]);

    res.json({
      ok: true,
      data: dataRes.rows,
      pagination: {
        page: Number(page),
        limit: hardLimit,
        total: countRes.rows[0].total,
      },
    });
  } catch (e) {
    console.error('listar error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.crearManual = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const b = req.body || {};
    if (!b.nombre?.trim()) {
      return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    }

    const estado = b.estado === 'discontinuado' ? 'discontinuado' : 'activo';

    const { rows } = await pool.query(
      `
      INSERT INTO insumos
      (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro,
       envase, vencimiento, resumen, cant_ingredientes,
       agrupacion_base, costo_ref, nota, origen, estado)
      VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `,
      [
        businessId,
        b.codigoMaxi ?? null,
        b.nombre.trim(),
        b.unidadMed ?? null,
        num(b.precioRef),
        b.rubro ?? null,
        b.envase ?? null,
        b.vencimiento ?? null,
        b.resumen ?? null,
        b.cantIngredientes ?? null,
        b.agrupacionBase ?? null,
        num(b.costoRef),
        b.nota ?? null,
        b.origen ?? 'manual',
        estado,
      ]
    );

    res.status(201).json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('crearManual error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.actualizar = async (req, res) => {
  try {
    const { id } = req.params;
    const businessId = getBusinessId(req); // ✅ obligatorio
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const b = req.body || {};
    const sets = [];
    const vals = [];

    const push = (c, v) => {
      vals.push(v);
      sets.push(`${c} = $${vals.length}`);
    };

    if (b.nombre !== undefined) push('nombre', b.nombre);
    if (b.unidadMed !== undefined) push('unidad_med', b.unidadMed);
    if (b.precioRef !== undefined) push('precio_ref', num(b.precioRef));
    if (b.rubro !== undefined) push('rubro', b.rubro);
    if (b.estado !== undefined) push('estado', b.estado);
    if (b.nota !== undefined) push('nota', b.nota);

    if (!sets.length) return res.json({ ok: true });

    vals.push(id, businessId); // ✅ CLAVE: validar negocio

    const { rows } = await pool.query(
      `
      UPDATE insumos
      SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = $${vals.length - 1}
        AND business_id = $${vals.length}
      RETURNING *
    `,
      vals
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }

    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('actualizar error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.eliminar = async (req, res) => {
  try {
    const { id } = req.params;
    const businessId = getBusinessId(req); // ✅ obligatorio
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const r = await pool.query(
      `
      UPDATE insumos
      SET estado = 'discontinuado', updated_at = NOW()
      WHERE id = $1 AND business_id = $2
    `,
      [id, businessId]
    );

    if (!r.rowCount) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('eliminar error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== BULK (JSON/CSV) =====================
exports.bulkUpsert = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) {
      return res.status(400).json({ ok: false, error: 'Body debe ser un array de insumos' });
    }

    const client = await pool.connect();
    let inserted = 0, updated = 0, skipped = 0;

    try {
      await client.query('BEGIN');
      
      for (const it of items) { // ✅ ahora es "it", no "b"
        const codigo = it.codigoMaxi ?? it.codigo_maxi ?? it.codigo ?? null;
        if (!codigo || String(codigo).trim() === '') {
          skipped++;
          continue;
        }

        const nombre = (it.nombre ?? '').trim();
        const unidad_med = it.unidadMed ?? it.unidad_med ?? null;
        const precio_ref = it.precioRef ?? it.precio_ref ?? null;
        const rubro = it.rubro ?? null;
        const origen = it.origen ?? 'manual';
        const estado = it.estado === 'discontinuado' ? 'discontinuado' : 'activo'; // ✅ ahora usa "it"

        const r = await client.query(
          `INSERT INTO insumos
           (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, estado)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (business_id, codigo_maxi) DO UPDATE SET
             nombre = EXCLUDED.nombre,
             unidad_med = EXCLUDED.unidad_med,
             precio_ref = EXCLUDED.precio_ref,
             rubro = EXCLUDED.rubro,
             origen = EXCLUDED.origen,
             estado = EXCLUDED.estado,
             updated_at = NOW()
           RETURNING (xmax = 0) AS inserted`,
          [
            businessId,
            String(codigo),
            nombre,
            unidad_med,
            precio_ref == null ? null : Number(precio_ref),
            rubro,
            origen,
            estado,
          ]
        );
        
        if (r.rows?.[0]?.inserted) inserted++;
        else updated++;
      }
      
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    return res.json({
      ok: true,
      summary: {
        inserted,
        updated,
        skipped,
        total: inserted + updated + skipped
      }
    });
  } catch (e) {
    console.error('bulkUpsert error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

exports.bulkUpsertCSV = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Subí un CSV en el campo "file"' });
    }

    const text = req.file.buffer.toString('utf8');
    const rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    req.body = rows.map(r => ({
      codigoMaxi: r.codigoMaxi ?? r.codigo_maxi ?? r.codigo,
      nombre: r.nombre ?? '',
      unidadMed: r.unidadMed ?? r.unidad_med ?? null,
      precioRef: r.precioRef ?? r.precio_ref ?? null,
      rubro: r.rubro ?? null,
      origen: r.origen ?? 'csv',
      estado: String(r.estado ?? r.activo ?? 'activo').toLowerCase() === 'discontinuado' 
        ? 'discontinuado' 
        : 'activo'
    }));

    return exports.bulkUpsert(req, res);
  } catch (e) {
    console.error('bulkUpsertCSV error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== MANTENIMIENTO =====================
exports.__cleanupNullInsumos = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r1 = await client.query(`
      DELETE FROM insumos
      WHERE nombre IS NULL OR TRIM(COALESCE(nombre, '')) = ''
    `);

    const r2 = await client.query(`
      UPDATE insumos
      SET nombre = NULLIF(TRIM(nombre), ''),
          unidad_med = NULLIF(TRIM(unidad_med), ''),
          updated_at = NOW()
      WHERE (nombre IS NOT NULL AND nombre <> TRIM(nombre))
         OR (unidad_med IS NOT NULL AND unidad_med <> TRIM(unidad_med))
    `);

    const r3 = await client.query(`
      DELETE FROM insumos a
      USING insumos b
      WHERE a.id > b.id
        AND a.codigo_maxi IS NOT NULL
        AND a.codigo_maxi = b.codigo_maxi
        AND a.business_id = b.business_id
    `);

    await client.query('COMMIT');
    
    return res.json({
      ok: true,
      removed_without_name: r1.rowCount,
      normalized: r2.rowCount,
      removed_dupes_by_code: r3.rowCount
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('__cleanupNullInsumos error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  } finally {
    client.release();
  }
};

// ===================== MAXI SYNC =====================
exports.listarMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const { rows } = await pool.query(
      `SELECT *
       FROM insumos
       WHERE business_id = $1
         AND origen = 'maxi'
       ORDER BY nombre ASC`,
      [businessId]
    );

    return res.json({
      ok: true,
      business_id: businessId,
      items: rows,
    });
  } catch (e) {
    console.error('listarMaxi error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

exports.syncFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const raw = await fetchMaxiInsumos({ businessId, req });
    const norm = normalizarInsumosMaxi(raw);
    const summary = await upsertFromMaxi(businessId, norm);

    res.json({ ok: true, ...summary });
  } catch (e) {
    console.error('syncFromMaxi error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.listarRubrosMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const items = await insumosRubrosRepo.listRubrosForBusiness(businessId);
    return res.json({ ok: true, business_id: businessId, items });
  } catch (e) {
    console.error('listarRubrosMaxi error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

exports.syncRubrosFromMaxi = async (req, res) => {
  try {
    const businessId = getBusinessId(req);
    if (!businessId) {
      return res.status(400).json({ ok: false, error: 'Negocio activo requerido' });
    }

    const raw = await fetchMaxiInsumosRubros({ businessId, req });
    const norm = normalizarInsumosRubros(raw);
    const summary = await insumosRubrosRepo.upsertRubrosForBusiness(businessId, norm);

    return res.json({
      ok: true,
      business_id: businessId,
      received: raw.length,
      normalized: norm.length,
      ...summary,
    });
  } catch (e) {
    console.error('syncRubrosFromMaxi error:', e);
    const status = e.status || 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
};

// ===================== SYNC COMPRAS (opcional) =====================
exports.syncDesdeCompras = async (req, res) => {
  if (String(process.env.ENABLE_SYNC_COMPRAS || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok: false, error: 'syncDesdeCompras deshabilitado' });
  }
  return res.status(501).json({ ok: false, error: 'No implementado' });
};

exports.addItemToGroup = async (req, res) => {
  const { groupId } = req.params;
  const { insumoId } = req.body;
  const businessId = getBusinessId(req);

  if (!insumoId) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Se requiere insumoId' 
    });
  }

  try {
    // Verificar que el grupo existe
    const grupo = await db('insumo_groups')
      .where({ id: groupId, business_id: businessId })
      .first();

    if (!grupo) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Grupo no encontrado' 
      });
    }

    console.log(`📦 [addItemToGroup] Agregando insumo ${insumoId} al grupo ${groupId}`);

    // Insertar (ignorar si ya existe)
    await db('insumo_group_items')
      .insert({
        group_id: Number(groupId),
        insumo_id: Number(insumoId),
      })
      .onConflict(['group_id', 'insumo_id'])
      .ignore();

    console.log(`✅ [addItemToGroup] Insumo agregado`);

    res.json({ 
      ok: true, 
      message: 'Insumo agregado al grupo' 
    });
  } catch (err) {
    console.error('[addItemToGroup] Error:', err);
    res.status(500).json({ 
      ok: false, 
      error: err.message || 'Error al agregar insumo'
    });
  }
}

/**
 * 🆕 Agregar MÚLTIPLES insumos a un grupo (BULK)
 */
exports.addMultipleItemsToGroup = async (req, res) => {
  const { groupId } = req.params;
  const { insumoIds } = req.body;
  const businessId = getBusinessId(req);

  if (!Array.isArray(insumoIds) || insumoIds.length === 0) {
    return res.status(400).json({ 
      ok: false, 
      error: 'Se requiere un array de insumoIds' 
    });
  }

  try {
    // Verificar que el grupo existe
    const grupo = await db('insumo_groups')
      .where({ id: groupId, business_id: businessId })
      .first();

    if (!grupo) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Grupo no encontrado' 
      });
    }

    console.log(`📦 [addMultipleItemsToGroup] Agregando ${insumoIds.length} insumos al grupo ${groupId}`);

    // Preparar datos para inserción
    const items = insumoIds.map(insumoId => ({
      group_id: Number(groupId),
      insumo_id: Number(insumoId),
    }));

    // Insertar en batch, ignorando duplicados
    const inserted = await db('insumo_group_items')
      .insert(items)
      .onConflict(['group_id', 'insumo_id'])
      .ignore();

    console.log(`✅ [addMultipleItemsToGroup] Insertados: ${inserted?.length || insumoIds.length}`);

    res.json({ 
      ok: true, 
      added: insumoIds.length,
      message: `${insumoIds.length} insumos agregados correctamente`
    });
  } catch (err) {
    console.error('[addMultipleItemsToGroup] Error:', err);
    res.status(500).json({ 
      ok: false, 
      error: err.message || 'Error al agregar insumos en bulk'
    });
  }
}

/**
 * ✅ Quitar un insumo de un grupo
 */
exports.removeItemFromGroup = async (req, res) => {
  const { groupId, insumoId } = req.params;
  const businessId = getBusinessId(req);

  try {
    // Verificar que el grupo existe
    const grupo = await db('insumo_groups')
      .where({ id: groupId, business_id: businessId })
      .first();

    if (!grupo) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Grupo no encontrado' 
      });
    }

    console.log(`🗑️ [removeItemFromGroup] Quitando insumo ${insumoId} del grupo ${groupId}`);

    const deleted = await db('insumo_group_items')
      .where({
        group_id: Number(groupId),
        insumo_id: Number(insumoId),
      })
      .del();

    if (deleted === 0) {
      return res.status(404).json({ 
        ok: false, 
        error: 'Item no encontrado en el grupo' 
      });
    }

    console.log(`✅ [removeItemFromGroup] Insumo quitado`);

    res.json({ 
      ok: true, 
      message: 'Insumo quitado del grupo' 
    });
  } catch (err) {
    console.error('[removeItemFromGroup] Error:', err);
    res.status(500).json({ 
      ok: false, 
      error: err.message || 'Error al quitar insumo'
    });
  }
}
