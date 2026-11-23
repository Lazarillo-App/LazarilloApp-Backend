// services/foodCostAjustes.js
// Food cost con UNA sola fuente de compras (Diego 23/11/2026: «una sola fuente y una sola fórmula, en el
// servidor»; «los gastos varios deberían entrar en artículos»; «los renglones sin insumo deben tener
// conceptos asociados»).
//
// El food cost de Artículos/Insumos sumaba solo los renglones de factura CON insumo (purchase_items),
// mientras que el Panel y el celular suman todo lo que en caja va a los conceptos (gestion_compras,
// misma vista que el Panel: lo de MaxiRest, lo cargado en Lazarillo, los gastos varios y lo repartido
// por apertura). Para que den lo mismo, por cada concepto de caja asociado a un rubro de insumo se
// agrega un AJUSTE = lo del Panel − lo de los renglones con insumo de ese concepto, en la misma fecha
// económica. El ajuste se le asigna al rubro de insumo del concepto (si el concepto tiene varios rubros,
// se reparte según lo comprado de cada rubro en ese período; sin compras, al primero).
//
// Así, un KPI que mira todos los rubros de un concepto suma exactamente lo del Panel, y el detalle por
// insumo sigue saliendo de purchase_items.
'use strict';

const pool = require('../config/db');

const ymdOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Principal de la organización (insumos y rubros de insumo son org-wide y viven ahí). */
async function principalDe(bizId) {
  const { rows } = await pool.query('SELECT created_from, organization_id FROM app_businesses WHERE id = $1', [bizId]);
  const b = rows[0];
  if (!b || b.created_from !== 'from_group' || !b.organization_id) return bizId;
  const { rows: r } = await pool.query(
    `SELECT id FROM app_businesses WHERE organization_id = $1
        AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
      ORDER BY id ASC LIMIT 1`, [b.organization_id]);
  return r[0]?.id ?? bizId;
}

/**
 * Ajustes por período, rubro de insumo y concepto.
 * @param agrupar 'dia' | 'mes' | 'total'
 * @param branchId undefined/'all' = todas · 'none' = principal · n = sucursal
 * @returns [{ periodo, rubro, cpto, concepto, importe }]
 */
async function ajustesFoodCost({ businessId, desde, hasta, branchId, agrupar = 'mes' }) {
  const principal = await principalDe(businessId);
  const { rows: mapa } = await pool.query(
    `SELECT ir.nombre AS rubro, COALESCE(ir.cpto_caja_lazarillo::text, ir.cpto_caja::text) AS cpto
       FROM insumo_rubros ir
      WHERE ir.business_id = $1 AND COALESCE(ir.cpto_caja_lazarillo::text, ir.cpto_caja::text) IS NOT NULL
      ORDER BY ir.nombre`, [principal]);
  if (!mapa.length) return [];
  const rubrosDe = new Map();
  for (const m of mapa) { if (!rubrosDe.has(m.cpto)) rubrosDe.set(m.cpto, []); rubrosDe.get(m.cpto).push(m.rubro); }
  const cptos = [...rubrosDe.keys()];

  const fmt = agrupar === 'dia' ? 'YYYY-MM-DD' : agrupar === 'mes' ? 'YYYY-MM' : '"total"';
  const params = [businessId, desde, hasta, cptos];
  let sucV = '', sucP = '';
  if (branchId === 'none') { sucV = 'AND v.branch_id IS NULL'; sucP = 'AND p.branch_id IS NULL'; }
  else if (branchId != null && branchId !== 'all' && branchId !== '' && Number.isFinite(Number(branchId))) {
    params.push(Number(branchId)); sucV = `AND v.branch_id = $${params.length}`; sucP = `AND p.branch_id = $${params.length}`;
  }

  // Panel: misma vista y misma fecha económica que el tablero (COALESCE(fechaManual, periodo, fecha)).
  const fechaV = `COALESCE(v."fechaManual", COALESCE(v.periodo, v.fecha))`;
  const [panel, items, nombres] = await Promise.all([
    pool.query(
      `SELECT to_char(${fechaV}, '${fmt}') AS periodo,
              COALESCE(v."conceptoCodigoManual", v."conceptoCodigo")::text AS cpto,
              SUM(COALESCE(v."importeManual", v.importe))::float8 AS imp
         FROM gestion_v_compras_distribuidas v
        WHERE v.business_id = $1 AND ${fechaV} >= $2::date AND ${fechaV} < ($3::date + 1)
          AND COALESCE(v."conceptoCodigoManual", v."conceptoCodigo")::text = ANY($4::text[]) ${sucV}
        GROUP BY 1, 2`, params).then((r) => r.rows),
    // Renglones con insumo (lo que ya suma el food cost por insumo), por concepto y por rubro.
    pool.query(
      `SELECT to_char(pi.fecha, '${fmt}') AS periodo, pi.cpto_caja::text AS cpto,
              COALESCE(ir.nombre, NULLIF(i.rubro, ''), 'Sin rubro') AS rubro,
              SUM(pi.precio_total + COALESCE(pi.iva_total_item, 0))::float8 AS imp
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
         JOIN insumos i ON i.id = pi.insumo_id
         LEFT JOIN insumo_rubros ir ON ir.business_id = i.business_id AND ir.codigo::text = i.rubro
        WHERE pi.business_id = $1 AND pi.fecha >= $2::date AND pi.fecha < ($3::date + 1)
          AND pi.cpto_caja::text = ANY($4::text[]) ${sucP}
        GROUP BY 1, 2, 3`, params).then((r) => r.rows),
    pool.query(
      `SELECT cc.codigo::text AS cpto, cc.nombre FROM gestion_conceptos_caja cc
         JOIN app_businesses b ON b.organization_id = cc.organization_id
        WHERE b.id = $1 AND cc.codigo::text = ANY($2::text[])`, [businessId, cptos]).then((r) => r.rows),
  ]);
  const nombre = new Map(nombres.map((n) => [n.cpto, n.nombre]));

  // Lo del panel − lo de los renglones con insumo, por período y concepto.
  const k = (p, c) => `${p}|${c}`;
  const neto = new Map();
  const porRubro = new Map(); // `${periodo}|${cpto}` → Map(rubro → importe) para repartir
  for (const r of panel) neto.set(k(r.periodo, r.cpto), (neto.get(k(r.periodo, r.cpto)) || 0) + r.imp);
  for (const r of items) {
    neto.set(k(r.periodo, r.cpto), (neto.get(k(r.periodo, r.cpto)) || 0) - r.imp);
    const m = porRubro.get(k(r.periodo, r.cpto)) || new Map();
    m.set(r.rubro, (m.get(r.rubro) || 0) + r.imp);
    porRubro.set(k(r.periodo, r.cpto), m);
  }

  const out = [];
  for (const [clave, imp] of neto) {
    if (Math.abs(imp) < 0.5) continue;
    const [periodo, cpto] = clave.split('|');
    const rubros = rubrosDe.get(cpto) || [];
    if (!rubros.length) continue;
    const pesos = porRubro.get(clave);
    const base = rubros.map((r) => [r, Math.max(0, pesos?.get(r) || 0)]);
    const tot = base.reduce((s, [, v]) => s + v, 0);
    const reparto = tot > 0 ? base.filter(([, v]) => v > 0).map(([r, v]) => [r, v / tot]) : [[rubros[0], 1]];
    for (const [rubro, f] of reparto) {
      out.push({ periodo, rubro, cpto, concepto: nombre.get(cpto) || cpto, importe: Math.round(imp * f * 100) / 100 });
    }
  }
  return out;
}

/** Ítems «sin insumo» para sumar a la lista de compras por insumo del food cost. */
function itemsDeAjustes(ajustes) {
  const por = new Map();
  for (const a of ajustes) {
    const id = `cpto-${a.cpto}-${a.rubro}`;
    const x = por.get(id) || { id, nombre: `${a.concepto} · sin insumo, gastos varios y cargas en Lazarillo`, agrupacion: 'Sin agrupación', rubro: a.rubro, importe: 0, ajuste: true };
    x.importe += a.importe;
    por.set(id, x);
  }
  return [...por.values()].filter((x) => Math.abs(x.importe) >= 0.5).map((x) => ({ ...x, importe: Math.round(x.importe * 100) / 100 }));
}

module.exports = { ajustesFoodCost, itemsDeAjustes, principalDe, ymdOf };
