// controllers/insumosController.js
const axios = require('axios');
const pool  = require('../config/db');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ====== MAXI CONFIG + TOKEN CACHE ======
const BASE = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';
let cachedToken = null;
let tokenExpiresAt = 0;

async function obtenerTokenMaxi() {
  const now = Date.now();

  // cache
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const email  = process.env.MAXI_EMAIL;
  const pass   = process.env.MAXI_PASS;
  const codCli = process.env.MAXI_CODCLI;

  if (email && pass && codCli) {
    const { data } = await axios.post(`${BASE}/login`, { email, pass, cod_cli: codCli }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 15000
    });
    if (data?.resultCode !== 'SUCCESS') {
      throw new Error(`Login Maxi falló: ${data?.resultDescription || 'desconocido'}`);
    }
    const token = data.content?.tokenAccess;
    const alive = Number(data.content?.aliveTime || 3600);
    cachedToken   = `Bearer ${token}`;
    tokenExpiresAt = now + (alive - 60) * 1000;
    return cachedToken;
  }

  // Fallback por si solo seteaste un token fijo
  if (process.env.MAXI_BEARER_TOKEN) {
    cachedToken   = process.env.MAXI_BEARER_TOKEN.startsWith('Bearer ')
      ? process.env.MAXI_BEARER_TOKEN
      : `Bearer ${process.env.MAXI_BEARER_TOKEN}`;
    tokenExpiresAt = now + (55 * 60 * 1000);
    return cachedToken;
  }

  throw new Error('Faltan credenciales: usa MAXI_EMAIL/MAXI_PASS/MAXI_CODCLI o MAXI_BEARER_TOKEN');
}
console.log('💡 insumosController.js cargado, versión 2.0');
// ====== SYNC DESDE MAXI ======
exports.syncDesdeMaxi = async (req, res) => {
  try {
    const token = await obtenerTokenMaxi();
console.log('BASE=', BASE, 'email=', process.env.MAXI_EMAIL, 'codCli=', process.env.MAXI_CODCLI);
console.log('Llamando a', `${BASE}/estadisticasmaster/insumos`);

    const { data } = await axios.get(`${BASE}/estadisticasmaster/insumos`, {
      headers: { Authorization: token },
      timeout: 30000
    });

    const items = data?.content?.content || data?.content || data || [];
    let count = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const it of items) {
        const row = {
          codigo_maxi: String(it.codigo),
          nombre: it.nombre || '',
          rubro: it.rubro ?? null,
          unidad_med: it.medida ?? null,
          precio_ref: num(it.precio) ?? 0
        };
        await client.query(
          `INSERT INTO insumos (codigo_maxi, nombre, rubro, unidad_med, precio_ref, origen, activo)
           VALUES ($1,$2,$3,$4,$5,'maxi',TRUE)
           ON CONFLICT (codigo_maxi) DO UPDATE SET
             nombre=$2, rubro=$3, unidad_med=$4, precio_ref=$5, activo=TRUE, updated_at=NOW()`,
          [row.codigo_maxi, row.nombre, row.rubro, row.unidad_med, row.precio_ref]
        );
        count++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ ok: true, total: count });
  } catch (e) {
    console.error('syncDesdeMaxi error:', e?.response?.data || e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
};

// ====== LISTAR / CRUD ======
exports.listar = async (req, res) => {
  try {
    const { page=1, limit=50, search='', rubro, unidadMed, origen, activo='true',
            orderBy='nombre', order='ASC' } = req.query;

    const where = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      where.push(`(nombre ILIKE $${params.length-1} OR codigo_maxi ILIKE $${params.length})`);
    }
    if (rubro)     { params.push(rubro);     where.push(`rubro = $${params.length}`); }
    if (unidadMed) { params.push(unidadMed); where.push(`unidad_med = $${params.length}`); }
    if (origen)    { params.push(origen);    where.push(`origen = $${params.length}`); }
    if (activo !== 'all') { params.push(activo === 'true'); where.push(`activo = $${params.length}`); }

    const offset = (Number(page)-1) * Number(limit);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const validOrderBy = ['nombre','codigo_maxi','rubro','unidad_med','precio_ref','created_at','updated_at'].includes(orderBy) ? orderBy : 'nombre';
    const validOrder   = order.toUpperCase()==='DESC' ? 'DESC' : 'ASC';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM insumos ${whereSql} ORDER BY ${validOrderBy} ${validOrder} LIMIT $${params.length+1} OFFSET $${params.length+2}`,
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
        b.codigoMaxi || null, b.nombre || '', b.unidadMed || null, num(b.precioRef),
        b.rubro || null, b.envase ?? null, b.vencimiento ?? null, b.resumen ?? null,
        b.cantIngredientes ?? null, b.agrupacionBase || null, num(b.costoRef), b.nota || null,
        b.origen || 'manual', b.activo ?? true
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
    const sets = [], vals = []; const push = (c,v)=>{ vals.push(v); sets.push(`${c}=$${vals.length}`); };

    if (b.nombre !== undefined)           push('nombre', b.nombre);
    if (b.unidadMed !== undefined)        push('unidad_med', b.unidadMed);
    if (b.precioRef !== undefined)        push('precio_ref', num(b.precioRef));
    if (b.rubro !== undefined)            push('rubro', b.rubro);
    if (b.envase !== undefined)           push('envase', b.envase);
    if (b.vencimiento !== undefined)      push('vencimiento', b.vencimiento);
    if (b.resumen !== undefined)          push('resumen', b.resumen);
    if (b.cantIngredientes !== undefined) push('cant_ingredientes', b.cantIngredientes);
    if (b.agrupacionBase !== undefined)   push('agrupacion_base', b.agrupacionBase);
    if (b.costoRef !== undefined)         push('costo_ref', num(b.costoRef));
    if (b.nota !== undefined)             push('nota', b.nota);
    if (b.activo !== undefined)           push('activo', b.activo);

    if (!sets.length) return res.json({ ok: true, data: null });

    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE insumos SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,
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
    const r = await pool.query(`UPDATE insumos SET activo=FALSE, updated_at=NOW() WHERE id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
