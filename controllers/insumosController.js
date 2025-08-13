// controllers/insumosController.js
const axios = require('axios');
const pool = require('../config/db');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

// ====== MAXI CONFIG + TOKEN CACHE ======
const BASE = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';
let cachedToken = null;
let tokenExpiresAt = 0;

async function obtenerTokenMaxi() {
  const now = Date.now();

  // cache en memoria
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const email = process.env.MAXI_EMAIL;
  const pass = process.env.MAXI_PASS;
  const codCli = process.env.MAXI_CODCLI;

  // Modo 1: login automático (recomendado)
  if (email && pass && codCli) {
    const { data } = await axios.post(`${BASE}/login`, { email, pass, cod_cli: codCli }, {
      headers: { 'Content-Type': 'application/json' }, timeout: 15000
    });
    if (data?.resultCode !== 'SUCCESS') {
      throw new Error(`Login Maxi falló: ${data?.resultDescription || 'desconocido'}`);
    }
    const token = data.content?.tokenAccess;
    const alive = Number(data.content?.aliveTime || 3600); // segundos
    cachedToken = `Bearer ${token}`;
    tokenExpiresAt = now + (alive - 60) * 1000; // renueva 1 min antes
    return cachedToken;
  }

  // Modo 2: token fijo (fallback)
  if (process.env.MAXI_BEARER_TOKEN) {
    cachedToken = process.env.MAXI_BEARER_TOKEN.startsWith('Bearer ')
      ? process.env.MAXI_BEARER_TOKEN
      : `Bearer ${process.env.MAXI_BEARER_TOKEN}`;
    tokenExpiresAt = now + (55 * 60 * 1000);
    return cachedToken;
  }

  throw new Error('Faltan credenciales: usa MAXI_EMAIL/MAXI_PASS/MAXI_CODCLI o MAXI_BEARER_TOKEN');
}

console.log('💡 insumosController.js cargado');

// ====== SYNC DESDE API ======
exports.syncDesdeMaxi = async (req, res) => {
  try {
    console.log('▶️  Sync de insumos (mconn → partners)');

    const email  = process.env.MAXI_EMAIL;
    const pass   = process.env.MAXI_PASS;
    const codCli = process.env.MAXI_CODCLI;
    const BASE_LOGIN = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';
    const BASE_STATS = process.env.MAXI_STATS_BASE_URL || 'https://partners.maxisistemas.com.ar';

    // 1) Login en mconn
    const lr = await axios.post(`${BASE_LOGIN}/login`, { email, pass, cod_cli: codCli }, {
      headers: { 'Content-Type':'application/json' }, timeout: 15000
    });
    if (lr.data?.resultCode !== 'SUCCESS') {
      return res.status(401).json({ ok:false, error:'login_failed', data: lr.data });
    }
    const token = lr.data?.content?.tokenAccess;
    const auth = { Authorization: `Bearer ${token}` };

    // 2) Insumos en partners (intento sin y con cod_cli)
    let ir;
    try {
      ir = await axios.get(`${BASE_STATS}/estadisticasmaster/insumos`, { headers: auth, timeout: 30000 });
    } catch {
      ir = await axios.get(`${BASE_STATS}/estadisticasmaster/insumos`, {
        headers: auth, params: { cod_cli: codCli }, timeout: 30000
      });
    }

    console.log('📦 Respuesta completa de insumos:', JSON.stringify(ir.data, null, 2));

    const raw = ir.data?.content?.content || ir.data?.content || [];
    const items = Array.isArray(raw) ? raw : [];
    console.log('ℹ️  Insumos recibidos:', items.length);

    // 3) UPSERT con filtro de código válido
    let count = 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const it of items) {
        const codigo = it?.codigo ?? it?.cod_rui ?? it?.id ?? null;
        if (!codigo) continue;

        const row = {
          codigo_maxi : String(codigo),
          nombre      : (it?.nombre ?? '').trim(),
          rubro       : it?.rubro ?? null,
          unidad_med  : it?.medida ?? it?.unidad_med ?? null,
          precio_ref  : num(it?.precio) ?? 0
        };

        await client.query(
          `INSERT INTO insumos (codigo_maxi, nombre, rubro, unidad_med, precio_ref, origen, activo)
           VALUES ($1,$2,$3,$4,$5,'maxi',TRUE)
           ON CONFLICT (codigo_maxi) DO UPDATE SET
             nombre=EXCLUDED.nombre,
             rubro=EXCLUDED.rubro,
             unidad_med=EXCLUDED.unidad_med,
             precio_ref=EXCLUDED.precio_ref,
             activo=TRUE,
             updated_at=NOW()`,
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

    return res.json({ ok:true, total: count });
  } catch (e) {
    console.error('syncDesdeMaxi error:', e.response?.data || e.message);
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// ====== LISTAR / CRUD ======
exports.listar = async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '', rubro, unidadMed, origen, activo = 'true',
      orderBy = 'nombre', order = 'ASC' } = req.query;

    const where = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      where.push(`(nombre ILIKE $${params.length - 1} OR codigo_maxi ILIKE $${params.length})`);
    }
    if (rubro) { params.push(rubro); where.push(`rubro = $${params.length}`); }
    if (unidadMed) { params.push(unidadMed); where.push(`unidad_med = $${params.length}`); }
    if (origen) { params.push(origen); where.push(`origen = $${params.length}`); }
    if (activo !== 'all') { params.push(activo === 'true'); where.push(`activo = $${params.length}`); }

    const offset = (Number(page) - 1) * Number(limit);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const validOrderBy = ['nombre', 'codigo_maxi', 'rubro', 'unidad_med', 'precio_ref', 'created_at', 'updated_at'].includes(orderBy) ? orderBy : 'nombre';
    const validOrder = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    const [dataRes, countRes] = await Promise.all([
      pool.query(
        `SELECT * FROM insumos ${whereSql} ORDER BY ${validOrderBy} ${validOrder} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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
    const sets = [], vals = []; const push = (c, v) => { vals.push(v); sets.push(`${c}=$${vals.length}`); };

    if (b.nombre !== undefined) push('nombre', b.nombre);
    if (b.unidadMed !== undefined) push('unidad_med', b.unidadMed);
    if (b.precioRef !== undefined) push('precio_ref', num(b.precioRef));
    if (b.rubro !== undefined) push('rubro', b.rubro);
    if (b.envase !== undefined) push('envase', b.envase);
    if (b.vencimiento !== undefined) push('vencimiento', b.vencimiento);
    if (b.resumen !== undefined) push('resumen', b.resumen);
    if (b.cantIngredientes !== undefined) push('cant_ingredientes', b.cantIngredientes);
    if (b.agrupacionBase !== undefined) push('agrupacion_base', b.agrupacionBase);
    if (b.costoRef !== undefined) push('costo_ref', num(b.costoRef));
    if (b.nota !== undefined) push('nota', b.nota);
    if (b.activo !== undefined) push('activo', b.activo);

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

// ====== DEBUG UTILS (opcionales) ======
exports.__debugLogin = async (req, res) => {
  try {
    const email  = process.env.MAXI_EMAIL;
    const pass   = process.env.MAXI_PASS;
    const codCli = process.env.MAXI_CODCLI;
    const bases = [
      process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar',
      process.env.MAXI_STATS_BASE_URL || 'https://partners.maxisistemas.com.ar'
    ];
    const out = [];
    for (const b of bases) {
      try {
        const r = await axios.post(`${b}/login`, { email, pass, cod_cli: codCli }, {
          headers: { 'Content-Type': 'application/json' }, timeout: 15000
        });
        out.push({ base:b, ok:true, resultCode:r.data?.resultCode, hasToken: !!r.data?.content?.tokenAccess });
      } catch (e) {
        out.push({ base:b, ok:false, status:e.response?.status, data:e.response?.data || e.message });
      }
    }
    res.json({ ok:true, out });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
};

exports.__debugInsumos = async (req, res) => {
  try {
    const email  = process.env.MAXI_EMAIL;
    const pass   = process.env.MAXI_PASS;
    const codCli = process.env.MAXI_CODCLI;
    const bases = [
      process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar',
      process.env.MAXI_STATS_BASE_URL || 'https://partners.maxisistemas.com.ar'
    ];
    const out = [];
    for (const b of bases) {
      try {
        const lr = await axios.post(`${b}/login`, { email, pass, cod_cli: codCli }, {
          headers: { 'Content-Type':'application/json' }, timeout:15000
        });
        const token = lr.data?.content?.tokenAccess;
        if (!token) throw new Error('sin token');
        const auth = { Authorization: `Bearer ${token}` };

        let ir;
        try {
          ir = await axios.get(`${b}/estadisticasmaster/insumos`, { headers: auth, timeout:30000 });
        } catch {
          ir = await axios.get(`${b}/estadisticasmaster/insumos`, {
            headers: auth, params:{ cod_cli: codCli }, timeout:30000
          });
        }

        const raw = ir.data?.content?.content || ir.data?.content || [];
        const items = Array.isArray(raw) ? raw : [];
        out.push({ base:b, ok:true, count: items.length, sampleKeys: items[0] ? Object.keys(items[0]) : [] });
      } catch (e) {
        out.push({ base:b, ok:false, where:'insumos', status:e.response?.status, data:e.response?.data || e.message });
      }
    }
    res.json({ ok:true, out });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
};

exports.__debugCombo = async (req, res) => {
  try {
    const email  = process.env.MAXI_EMAIL;
    const pass   = process.env.MAXI_PASS;
    const codCli = process.env.MAXI_CODCLI;
    const BASE_LOGIN = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';
    const BASE_STATS = process.env.MAXI_STATS_BASE_URL || 'https://partners.maxisistemas.com.ar';

    // 1) login en api-mconn
    const lr = await axios.post(`${BASE_LOGIN}/login`, { email, pass, cod_cli: codCli }, {
      headers: { 'Content-Type':'application/json' }, timeout: 15000
    });
    const token = lr.data?.content?.tokenAccess;
    if (!token) return res.json({ ok:false, step:'login', data:lr.data });

    const auth = { Authorization: `Bearer ${token}` };

    // 2) pedir insumos en partners (A: sin params, B: con cod_cli)
    let ir;
    try {
      ir = await axios.get(`${BASE_STATS}/estadisticasmaster/insumos`, { headers: auth, timeout: 30000 });
    } catch (e1) {
      try {
        ir = await axios.get(`${BASE_STATS}/estadisticasmaster/insumos`, {
          headers: auth, params: { cod_cli: codCli }, timeout: 30000
        });
      } catch (e2) {
        return res.json({ ok:false, step:'insumos', status:e2.response?.status, data:e2.response?.data || e2.message });
      }
    }

    const raw = ir.data?.content?.content || ir.data?.content || [];
    const items = Array.isArray(raw) ? raw : [];
    return res.json({
      ok: true,
      count: items.length,
      sampleKeys: items[0] ? Object.keys(items[0]) : []
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message });
  }
};

// ====== SYNC DESDE COMPRAS (mconn con reintentos; fallback partners; chunking) ======
exports.syncDesdeCompras = async (req, res) => {
  try {
    const email  = process.env.MAXI_EMAIL;
    const pass   = process.env.MAXI_PASS;
    const codCli = process.env.MAXI_CODCLI;

    const MCONN   = process.env.MAXI_BASE_URL       || 'https://api-mconn.maxisistemas.com.ar';
    const PARTNER = process.env.MAXI_STATS_BASE_URL || 'https://partners.maxisistemas.com.ar';

    const hoy = new Date();
    const toRequested   = (req.body?.to)   || hoy.toISOString().slice(0,10);
    const fromRequested = (req.body?.from) || new Date(hoy.getTime() - 1*86400000).toISOString().slice(0,10); // por defecto 2 días
    const chunkDays = Math.max(1, Math.min(Number(req.body?.chunkDays) || 2, 7)); // 1..7

    const toDate = (s) => new Date(`${s}T00:00:00Z`);
    const toStr  = (d) => d.toISOString().slice(0,10);
    const buildRanges = () => {
      const ranges = [];
      let from = toDate(fromRequested);
      const end = toDate(toRequested);
      while (from <= end) {
        const chunkEnd = new Date(Math.min(from.getTime() + (chunkDays-1)*86400000, end.getTime()));
        ranges.push([toStr(from), toStr(chunkEnd)]);
        from = new Date(chunkEnd.getTime() + 86400000);
      }
      return ranges;
    };

    const login = async (BASE) => {
      const lr = await axios.post(`${BASE}/login`, { email, pass, cod_cli: codCli }, {
        headers: { 'Content-Type':'application/json', 'Accept':'application/json' }, timeout: 20000
      });
      if (lr.data?.resultCode !== 'SUCCESS') {
        throw new Error(`Login falló en ${BASE}: ${lr.data?.resultDescription || 'desconocido'}`);
      }
      return `Bearer ${lr.data?.content?.tokenAccess}`;
    };

    const postCompras = async (BASE, token, from, to) => {
      const AUTH = { Authorization: token, 'Content-Type': 'application/json', 'Accept':'application/json' };
      // intento A: sin cod_cli
      try {
        const r = await axios.post(`${BASE}/estadisticas/compras`, { from, to }, { headers: AUTH, timeout: 120000 });
        if (r.data?.resultCode === 'SUCCESS') return r.data;
      } catch (_) { /* seguimos */ }
      // intento B: con cod_cli
      const url2 = `${BASE}/estadisticas/compras?cod_cli=${encodeURIComponent(codCli||'')}`;
      const r2 = await axios.post(url2, { from, to }, { headers: AUTH, timeout: 120000 });
      if (r2.data?.resultCode !== 'SUCCESS') {
        const desc = r2.data?.resultDescription || 'desconocido';
        throw new Error(`compras falló en ${BASE}: ${desc}`);
      }
      return r2.data;
    };

    // Reintentos con backoff para mconn
    const fetchMconn = async (from, to) => {
      let lastErr;
      for (let i=0;i<3;i++){
        try {
          const token = await login(MCONN);
          return await postCompras(MCONN, token, from, to);
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 1000 * (2**i))); // 1s, 2s, 4s
        }
      }
      throw lastErr || new Error('mconn no disponible');
    };

    // Fallback simple a partners (sabemos que suele dar 0, pero lo intentamos)
    const fetchPartner = async (from, to) => {
      try {
        // partners a veces permite sin token
        try {
          const r = await axios.post(`${PARTNER}/estadisticas/compras`, { from, to }, {
            headers: { 'Content-Type':'application/json', 'Accept':'application/json' }, timeout: 120000
          });
          return r.data;
        } catch (_){
          const token = await login(PARTNER);
          return await postCompras(PARTNER, token, from, to);
        }
      } catch (e) {
        throw e;
      }
    };

    const ranges = buildRanges();
    const map = new Map();
    const chunksMeta = [];
    let source = 'mconn';

    for (const [f,t] of ranges) {
      let data;
      try {
        data = await fetchMconn(f,t);
      } catch (eM) {
        // si mconn cae con 502, probamos partners solo para no frenar
        source = 'partners';
        data = await fetchPartner(f,t);
      }

      const docs = data?.content?.content || data?.content || [];
      chunksMeta.push({ from: f, to: t, docs: Array.isArray(docs) ? docs.length : -1, source });
      for (const doc of (Array.isArray(docs) ? docs : [])) {
        const items = Array.isArray(doc?.items) ? doc.items : [];
        for (const it of items) {
          const codigo = it?.insumo;
          if (!codigo || Number(codigo) === 0) continue;
          const precio = Number(it?.precio) || 0;
          map.set(String(codigo), { codigo_maxi: String(codigo), precio_ref: precio });
        }
      }
    }

    if (map.size === 0) {
      return res.json({ ok:true, total:0, from: fromRequested, to: toRequested, source, chunks: chunksMeta, note:'Sin items de compras' });
    }

    const client = await pool.connect();
    let count = 0;
    try {
      await client.query('BEGIN');
      for (const { codigo_maxi, precio_ref } of map.values()) {
        await client.query(
          `INSERT INTO insumos (codigo_maxi, nombre, rubro, unidad_med, precio_ref, origen, activo)
           VALUES ($1, $2, $3, $4, $5, 'compras', TRUE)
           ON CONFLICT (codigo_maxi) DO UPDATE SET
             precio_ref = EXCLUDED.precio_ref,
             origen = 'compras',
             activo = TRUE,
             updated_at = NOW()`,
          [codigo_maxi, '', null, null, precio_ref]
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

    return res.json({ ok:true, total: count, from: fromRequested, to: toRequested, source, chunks: chunksMeta });
  } catch (e) {
    console.error('syncDesdeCompras error:', e?.response?.data || e.message);
    return res.status(500).json({ ok:false, error: e?.message || 'error' });
  }
};


// ====== MANTENIMIENTO / CLEANUP ======
exports.__cleanupNullInsumos = async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) Borra filas sin código o sin nombre (si querés conservarlas, comentá estas líneas)
    const r1 = await client.query(`
      DELETE FROM insumos
      WHERE (codigo_maxi IS NULL OR TRIM(COALESCE(codigo_maxi, '')) = '')
         OR (nombre IS NULL OR TRIM(COALESCE(nombre, '')) = '')
    `);

    // 2) Normaliza espacios en nombre y unidad_med
    const r2 = await client.query(`
      UPDATE insumos
         SET nombre = NULLIF(TRIM(nombre), ''),
             unidad_med = NULLIF(TRIM(unidad_med), ''),
             updated_at = NOW()
       WHERE (nombre IS NOT NULL AND nombre <> TRIM(nombre))
          OR (unidad_med IS NOT NULL AND unidad_med <> TRIM(unidad_med))
    `);

    // 3) Colapsa duplicados por codigo_maxi dejando el más reciente
    //    (si ya tenés UNIQUE(codigo_maxi), esto es opcional)
    const r3 = await client.query(`
      DELETE FROM insumos a
      USING insumos b
      WHERE a.id < b.id
        AND a.codigo_maxi = b.codigo_maxi
    `);

    await client.query('COMMIT');
    return res.json({
      ok: true,
      removed_nulls: r1.rowCount,
      normalized: r2.rowCount,
      removed_dupes: r3.rowCount
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('__cleanupNullInsumos error:', e.message);
    return res.status(500).json({ ok:false, error: e.message });
  } finally {
    client.release();
  }
};
// 🔍 DEBUG: probar /estadisticas/compras en ambos hosts con login por host
exports.__debugCompras = async (req, res) => {
  try {
    const email  = process.env.MAXI_EMAIL;
    const pass   = process.env.MAXI_PASS;
    const codCli = process.env.MAXI_CODCLI;
    const from = (req.body?.from);
    const to   = (req.body?.to);

    if (!from || !to) {
      return res.status(400).json({ ok:false, error:'Falta from/to (YYYY-MM-DD)' });
    }

    const BASES = [
      process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar',
      process.env.MAXI_STATS_BASE_URL || 'https://partners.maxisistemas.com.ar'
    ];

    const out = [];
    for (const BASE of BASES) {
      const step = { base: BASE };
      try {
        // 1) login en el mismo host
        const lr = await axios.post(`${BASE}/login`, { email, pass, cod_cli: codCli }, {
          headers: { 'Content-Type':'application/json' }, timeout: 20000
        });
        step.login = {
          status:   'ok',
          resultCode: lr.data?.resultCode,
          hasToken: !!lr.data?.content?.tokenAccess
        };
        const token = lr.data?.content?.tokenAccess;
        const AUTH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

        // 2) compras sin y con cod_cli
        const tries = [
          { url: `${BASE}/estadisticas/compras`, query: 'none' },
          { url: `${BASE}/estadisticas/compras?cod_cli=${encodeURIComponent(codCli||'')}`, query: 'cod_cli' },
        ];

        step.calls = [];
        for (const t of tries) {
          try {
            const r = await axios.post(t.url, { from, to }, { headers: AUTH, timeout: 120000 });
            const raw = r.data;
            const list = raw?.content?.content || raw?.content || [];
            step.calls.push({
              url: t.url,
              ok:  true,
              resultCode: raw?.resultCode,
              resultDescription: raw?.resultDescription,
              items: Array.isArray(list) ? list.length : -1,
              sampleKeys: Array.isArray(list) && list[0] ? Object.keys(list[0]) : []
            });
          } catch (e) {
            step.calls.push({
              url: t.url,
              ok: false,
              status: e.response?.status,
              data: e.response?.data || e.message
            });
          }
        }
      } catch (e) {
        step.login = { status: 'fail', data: e.response?.data || e.message };
      }
      out.push(step);
    }

    return res.json({ ok:true, out });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  }
};
