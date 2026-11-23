// services/listasPosSucursal.js
// Lista de precios del POS por sucursal (Diego 23/11/2026). El POS puede tener hasta 4 listas
// (MaxiRest: precio1..precio4, que llegan por el kit a gestion_articulos de la organización) y
// cada sucursal cobra una. Acá se guarda cuál y se arma el precio de cada artículo según la
// sucursal que se mira:
//   · una sucursal → el precio de su lista;
//   · «Todas»      → promedio de las listas pesado por las unidades que vendió cada sucursal en el
//                    período (sin ventas, la lista de la principal).
// Multi-POS: si el POS del negocio no trae listas (gestion_articulos vacío para su organización),
// `disponible` es false y la pantalla sigue con el precio de siempre.
const pool = require('../config/db');

async function orgDe(businessId) {
  const { rows } = await pool.query('SELECT organization_id FROM app_businesses WHERE id = $1', [businessId]);
  return rows[0]?.organization_id ?? null;
}

/** Listas del POS (alias de org_price_list_config), sucursales del negocio y la lista de cada una. */
async function configuracion(businessId) {
  const orgId = await orgDe(businessId);
  const [{ rows: [hay] }, { rows: cfg }, { rows: suc }] = await Promise.all([
    pool.query('SELECT EXISTS (SELECT 1 FROM gestion_articulos WHERE organization_id = $1) AS hay', [orgId]),
    pool.query('SELECT list_number, alias FROM org_price_list_config WHERE organization_id = $1', [orgId]),
    pool.query(
      `SELECT b.id, b.name, COALESCE((b.props->>'is_main')::boolean, false) AS principal, bpl.list_number
         FROM app_branches b
         LEFT JOIN branch_price_list bpl ON bpl.business_id = b.business_id AND bpl.branch_id = b.id
        WHERE b.business_id = $1
        ORDER BY principal DESC, lower(b.name)`, [businessId]),
  ]);
  const listas = [1, 2, 3, 4].map((n) => ({
    listNumber: n,
    alias: cfg.find((c) => c.list_number === n)?.alias || `Lista ${n}`,
  }));
  return {
    disponible: !!hay?.hay,
    listas,
    sucursales: suc.map((s) => ({ branchId: Number(s.id), nombre: s.name, principal: s.principal, listNumber: s.list_number ?? null })),
  };
}

async function guardar(businessId, branchId, listNumber, userId) {
  const { rows } = await pool.query('SELECT name FROM app_branches WHERE id = $1 AND business_id = $2', [branchId, businessId]);
  if (!rows[0]) { const e = new Error('Sucursal inválida'); e.status = 400; throw e; }
  const { rows: [antes] } = await pool.query(
    'SELECT list_number FROM branch_price_list WHERE business_id = $1 AND branch_id = $2', [businessId, branchId]);
  await pool.query(
    `INSERT INTO branch_price_list (business_id, branch_id, list_number, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (business_id, branch_id) DO UPDATE SET list_number = EXCLUDED.list_number,
       updated_by = EXCLUDED.updated_by, updated_at = now()`, [businessId, branchId, listNumber, userId || null]);
  return { nombre: rows[0].name, antes: antes?.list_number ?? null };
}

/**
 * Precio por artículo para lo que se mira. sucursal: 'all' | 'main' | id de app_branches.
 * Devuelve null si el negocio no tiene listas por sucursal configuradas o el POS no trae listas.
 */
async function precios(businessId, { sucursal = 'all', from = null, to = null } = {}) {
  const cfg = await configuracion(businessId);
  const conLista = cfg.sucursales.filter((s) => s.listNumber);
  if (!cfg.disponible || !conLista.length) return null;
  const principal = cfg.sucursales.find((s) => s.principal) || null;
  const listaDe = (branchId) => cfg.sucursales.find((s) => s.branchId === Number(branchId))?.listNumber ?? null;
  const listaPrincipal = principal?.listNumber ?? 1;
  const orgId = await orgDe(businessId);

  const { rows: art } = await pool.query(
    `SELECT codigo::text AS cod, precio1::float8 AS p1, precio2::float8 AS p2, precio3::float8 AS p3, precio4::float8 AS p4
       FROM gestion_articulos WHERE organization_id = $1`, [orgId]);
  const precioDe = (a, n) => { const v = a[`p${n}`]; return Number.isFinite(v) && v > 0 ? v : (a.p1 || 0); };

  const una = sucursal === 'main' ? listaPrincipal : sucursal !== 'all' ? listaDe(sucursal) : null;
  if (sucursal !== 'all') {
    if (!una) return null;
    const out = {};
    for (const a of art) out[a.cod] = precioDe(a, una);
    return { modo: 'lista', listNumber: una, etiqueta: `Lista ${una} del POS`, precios: out };
  }

  // «Todas»: unidades vendidas por sucursal en el período (sin sucursal = la principal).
  const params = [businessId];
  let rango = '';
  if (from) { params.push(from); rango += ` AND day >= $${params.length}::date`; }
  if (to) { params.push(to); rango += ` AND day <= $${params.length}::date`; }
  const { rows: ventas } = await pool.query(
    `SELECT article_id::text AS cod, branch_id, SUM(qty)::float8 AS u
       FROM sales_daily_items WHERE business_id = $1 ${rango}
      GROUP BY 1, 2 HAVING SUM(qty) > 0`, params);
  const porArt = new Map();
  for (const v of ventas) {
    const n = v.branch_id == null ? listaPrincipal : (listaDe(v.branch_id) ?? listaPrincipal);
    if (!porArt.has(v.cod)) porArt.set(v.cod, []);
    porArt.get(v.cod).push([n, v.u]);
  }
  const out = {};
  for (const a of art) {
    const vs = porArt.get(a.cod);
    if (!vs) { out[a.cod] = precioDe(a, listaPrincipal); continue; }
    const tot = vs.reduce((s, [, u]) => s + u, 0);
    out[a.cod] = vs.reduce((s, [n, u]) => s + precioDe(a, n) * u, 0) / tot;
  }
  const distintas = new Set(conLista.map((s) => s.listNumber)).size > 1;
  return { modo: distintas ? 'ponderado' : 'lista', listNumber: distintas ? null : conLista[0].listNumber,
    etiqueta: distintas ? 'ponderado por ventas' : `Lista ${conLista[0].listNumber} del POS`, precios: out };
}

module.exports = { configuracion, guardar, precios };
