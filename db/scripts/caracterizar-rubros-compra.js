// db/scripts/caracterizar-rubros-compra.js
//
// Diagnóstico de SOLO LECTURA. El tipo de comprobante (cod_cpb: 'C', 'N', y
// ahora una variante de 'A' con proveedor 68 = "Servicio de Energia
// Electrica") NO alcanza como regla única para detectar gasto administrativo
// — aparecen en más de un tipo. Lo constante en todos los casos encontrados
// hasta ahora es que son gasto, nunca mercadería. cpto_caja/referencia en
// purchase_items ya guardan el cod_cga/nom_cga crudo de origen — agrupar por
// ESO (el rubro/concepto real de MaxiRest) para armar la lista definitiva,
// en vez de perseguir tipos de comprobante uno por uno.
//
// Uso: node db/scripts/caracterizar-rubros-compra.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = Number(process.argv[2]);
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/caracterizar-rubros-compra.js <business_id>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT pi.cpto_caja, pi.referencia,
            COUNT(*)::int AS lineas,
            COUNT(DISTINCT pi.insumo_id)::int AS insumos_distintos,
            COUNT(*) FILTER (WHERE pi.insumo_id IS NOT NULL)::int AS lineas_con_insumo,
            MIN(pi.precio_total)::numeric(14,2) AS min_total,
            MAX(pi.precio_total)::numeric(14,2) AS max_total,
            (array_agg(DISTINCT i.nombre ORDER BY i.nombre) FILTER (WHERE i.nombre IS NOT NULL))[1:8] AS insumos_matcheados_sample
       FROM purchase_items pi
       LEFT JOIN insumos i ON i.id = pi.insumo_id
      WHERE pi.business_id = $1
      GROUP BY pi.cpto_caja, pi.referencia
      ORDER BY lineas_con_insumo DESC, lineas DESC`,
    [businessId]
  );

  console.log(`=== Rubros/conceptos de compra (cod_cga/nom_cga) — negocio ${businessId} ===`);
  console.log(`${rows.length} combinación(es) distinta(s)\n`);
  rows.forEach((r) => {
    console.log(`cod_cga=${r.cpto_caja}  "${r.referencia}"  — ${r.lineas} línea(s), ${r.insumos_distintos} insumo(s) distinto(s) matcheado(s) (${r.lineas_con_insumo} línea(s) con insumo), montos $${r.min_total} a $${r.max_total}`);
    if (r.insumos_matcheados_sample?.length) {
      console.log(`    matchea con: ${r.insumos_matcheados_sample.join(', ')}`);
    }
  });

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
