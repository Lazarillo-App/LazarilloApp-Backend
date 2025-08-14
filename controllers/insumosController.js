// controllers/insumosController.js
const pool = require('../config/db');
const { parse } = require('csv-parse/sync');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

console.log('💡 insumosController.js cargado (modo limpio)');

// ===================== LISTAR / CRUD BÁSICO =====================
exports.listar = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search = '',
      // rubro,  // 👈 deprecado
      unidadMed,
      origen,
      activo = 'true',
      orderBy = 'nombre',
      order = 'ASC'
    } = req.query;

    const where = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      where.push(`(nombre ILIKE $${params.length - 1} OR codigo_maxi ILIKE $${params.length})`);
    }
    // if (rubro)     { params.push(rubro);     where.push(`rubro = $${params.length}`); } // 👈 deprecado
    if (unidadMed) { params.push(unidadMed); where.push(`unidad_med = $${params.length}`); }
    if (origen)    { params.push(origen);    where.push(`origen = $${params.length}`); }
    if (activo !== 'all') { params.push(activo === 'true'); where.push(`activo = $${params.length}`); }

    const offset = (Number(page) - 1) * Number(limit);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const validOrderByWhitelist = ['nombre', 'codigo_maxi', 'unidad_med', 'precio_ref', 'created_at', 'updated_at']; // 👈 sin rubro
    const validOrderBy = validOrderByWhitelist.includes(orderBy) ? orderBy : 'nombre';
    const validOrder = (String(order).toUpperCase() === 'DESC') ? 'DESC' : 'ASC';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM insumos ${whereSql}
         ORDER BY ${validOrderBy} ${validOrder}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, Number(limit), Number(offset)]
      ),
      pool.query(`SELECT COUNT(*)::int AS total FROM insumos ${whereSql}`, params)
    ]);

    res.json({
      ok: true,
      data: dataRes.rows,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total: countRes.rows[0].total,
        pages: Math.ceil(countRes.rows[0].total / Number(limit))
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.crearManual = async (req, res) => {
  try {
    const b = req.body || {};
    const { rows } = await pool.query(
      `INSERT INTO insumos
        (codigo_maxi, nombre, unidad_med, precio_ref, rubro,
         envase, vencimiento, resumen, cant_ingredientes,
         agrupacion_base, costo_ref, nota, origen, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        b.codigoMaxi || null,
        b.nombre || '',
        b.unidadMed || null,
        num(b.precioRef),
        // 👇 podés mandar o no; si no mandás, queda null
        b.rubro ?? null,
        b.envase ?? null,
        b.vencimiento ?? null,
        b.resumen ?? null,
        b.cantIngredientes ?? null,
        b.agrupacionBase || null,
        num(b.costoRef),
        b.nota || null,
        b.origen || 'manual',
        b.activo ?? true
      ]
    );
    res.status(201).json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.actualizar = async (req, res) => {
  try {
    const { id } = req.params, b = req.body || {};
    const sets = [], vals = [];
    const push = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };

    if (b.nombre           !== undefined) push('nombre', b.nombre);
    if (b.unidadMed        !== undefined) push('unidad_med', b.unidadMed);
    if (b.precioRef        !== undefined) push('precio_ref', num(b.precioRef));
    if (b.rubro            !== undefined) push('rubro', b.rubro);
    if (b.envase           !== undefined) push('envase', b.envase);
    if (b.vencimiento      !== undefined) push('vencimiento', b.vencimiento);
    if (b.resumen          !== undefined) push('resumen', b.resumen);
    if (b.cantIngredientes !== undefined) push('cant_ingredientes', b.cantIngredientes);
    if (b.agrupacionBase   !== undefined) push('agrupacion_base', b.agrupacionBase);
    if (b.costoRef         !== undefined) push('costo_ref', num(b.costoRef));
    if (b.nota             !== undefined) push('nota', b.nota);
    if (b.activo           !== undefined) push('activo', b.activo);

    if (!sets.length) return res.json({ ok: true, data: null });

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE insumos SET ${sets.join(', ')}, updated_at=NOW()
       WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    res.json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

exports.eliminar = async (req, res) => {
  try {
    const { id } = req.params;
    const r = await pool.query(
      `UPDATE insumos SET activo=FALSE, updated_at=NOW() WHERE id=$1`,
      [id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ===================== BULK (JSON/CSV) =====================
exports.bulkUpsert = async (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) return res.status(400).json({ ok:false, error:'Body debe ser un array de insumos' });

    const client = await pool.connect();
    let inserted = 0, updated = 0, skipped = 0;

    try {
      await client.query('BEGIN');
      for (const it of items) {
        const codigo = it.codigoMaxi ?? it.codigo_maxi ?? it.codigo ?? null;
        if (!codigo || String(codigo).trim() === '') { skipped++; continue; }

        const nombre     = (it.nombre ?? '').trim();
        const unidad_med = it.unidadMed ?? it.unidad_med ?? null;
        const precio_ref = (it.precioRef ?? it.precio_ref ?? null);
        const origen     = it.origen ?? 'manual';
        const activo     = typeof it.activo === 'boolean' ? it.activo : true;

        // rubro deprecado: solo si viene
        const rubro = it.rubro ?? null;

        const r = await client.query(
          `INSERT INTO insumos (codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, activo)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (codigo_maxi) DO UPDATE SET
             nombre=EXCLUDED.nombre,
             unidad_med=EXCLUDED.unidad_med,
             precio_ref=EXCLUDED.precio_ref,
             rubro=EXCLUDED.rubro,
             origen=EXCLUDED.origen,
             activo=EXCLUDED.activo,
             updated_at=NOW()
           RETURNING (xmax = 0) AS inserted`,
          [String(codigo), nombre, unidad_med, (precio_ref == null ? null : Number(precio_ref)), rubro, origen, activo]
        );
        if (r.rows?.[0]?.inserted) inserted++; else updated++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally {
      client.release();
    }

    return res.json({ ok:true, summary:{ inserted, updated, skipped, total: inserted+updated+skipped } });
  } catch (e) {
    console.error('bulkUpsert error:', e.message);
    return res.status(500).json({ ok:false, error:e.message });
  }
};


exports.bulkUpsertCSV = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'Subí un CSV en el campo "file"' });
    const text = req.file.buffer.toString('utf8');
    const rows = parse(text, { columns:true, skip_empty_lines:true, trim:true });

    // Normalizamos columnas comunes y reusamos bulkUpsert
    req.body = rows.map(r => ({
      codigoMaxi: r.codigoMaxi ?? r.codigo_maxi ?? r.codigo,
      nombre: r.nombre ?? '',
      unidadMed: r.unidadMed ?? r.unidad_med ?? null,
      precioRef: r.precioRef ?? r.precio_ref ?? null,
      rubro: r.rubro ?? null,
      origen: r.origen ?? 'csv',
      activo: (String(r.activo ?? 'true').toLowerCase() !== 'false')
    }));

    return exports.bulkUpsert(req, res);
  } catch (e) {
    console.error('bulkUpsertCSV error:', e.message);
    return res.status(500).json({ ok:false, error:e.message });
  }
};

// ===================== MANTENIMIENTO =====================
exports.__cleanupNullInsumos = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Borra SOLO filas sin nombre (dato claramente inválido).
    const r1 = await client.query(`
      DELETE FROM insumos
      WHERE nombre IS NULL OR TRIM(COALESCE(nombre, '')) = ''
    `);

    // 2) Normaliza espacios
    const r2 = await client.query(`
      UPDATE insumos
         SET nombre = NULLIF(TRIM(nombre), ''),
             unidad_med = NULLIF(TRIM(unidad_med), ''),
             updated_at = NOW()
       WHERE (nombre IS NOT NULL AND nombre <> TRIM(nombre))
          OR (unidad_med IS NOT NULL AND unidad_med <> TRIM(unidad_med))
    `);

    // 3) Colapsa duplicados por codigo_maxi (solo si codigo_maxi NO es null)
    const r3 = await client.query(`
      DELETE FROM insumos a
      USING insumos b
      WHERE a.id < b.id
        AND a.codigo_maxi IS NOT NULL
        AND a.codigo_maxi = b.codigo_maxi
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
    return res.status(500).json({ ok:false, error: e.message });
  } finally {
    client.release();
  }
};

// ===================== (OPCIONAL) SYNC DESDE COMPRAS =====================
// Dejalo activado sólo si realmente lo vas a usar ahora.
// Para desactivarlo sin borrar, usa la flag de entorno: ENABLE_SYNC_COMPRAS=false
exports.syncDesdeCompras = async (req, res) => {
  if (String(process.env.ENABLE_SYNC_COMPRAS || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok:false, error:'syncDesdeCompras deshabilitado' });
  }
  return res.status(501).json({ ok:false, error:'No implementado en modo limpio' });
};