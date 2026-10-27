// db/scripts/debug-precio-costeo.js
//
// Diagnóstico de SOLO LECTURA, paso a paso, para encontrar dónde se corta la
// cadena que debería actualizar insumos.precio_ref al entrar compras nuevas
// (preciosActualizados:0 en todas las corridas de sync-maxi-pipeline-compras,
// aunque el modo de costeo es 'ultima_compra' y no hay redirección de
// business_id de por medio — ya descartados).
//
// Uso: node db/scripts/debug-precio-costeo.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { calcularPreciosPorModo } = require('../../services/precioCosteoInsumos');

async function main() {
  const businessId = Number(process.argv[2]);
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/debug-precio-costeo.js <business_id>');
    process.exit(1);
  }

  // 1) Cuántas líneas de purchase_items de este negocio tienen insumo_id,
  //    precio > 0 y fecha — la condición que arma insumoIdsConCompra en
  //    purchasesStore.js.
  const base = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE insumo_id IS NOT NULL)::int AS con_insumo,
            COUNT(*) FILTER (WHERE insumo_id IS NOT NULL AND precio > 0)::int AS con_insumo_y_precio,
            COUNT(*) FILTER (WHERE insumo_id IS NOT NULL AND precio > 0 AND fecha IS NOT NULL)::int AS cumple_los_3,
            COUNT(DISTINCT insumo_id) FILTER (WHERE insumo_id IS NOT NULL AND precio > 0 AND fecha IS NOT NULL)::int AS insumos_distintos
       FROM purchase_items WHERE business_id = $1`,
    [businessId]
  );
  console.log('=== purchase_items de este negocio ===');
  console.log(base.rows[0]);

  // 2) Mismos insumo_id, pero mirando precio_total (no precio) — por si "precio"
  //    (precio unitario) vino en 0 mientras precio_total sí tiene datos reales.
  const alt = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE insumo_id IS NOT NULL AND precio_total > 0)::int AS con_insumo_y_precio_total
       FROM purchase_items WHERE business_id = $1`,
    [businessId]
  );
  console.log('\n=== Mismo filtro pero con precio_total en vez de precio ===');
  console.log(alt.rows[0]);

  // 3) Tomar hasta 20 insumo_id reales con compras y correr calcularPreciosPorModo
  //    tal cual lo llama purchasesStore.js, para ver qué devuelve de verdad.
  const ids = await pool.query(
    `SELECT DISTINCT insumo_id FROM purchase_items
      WHERE business_id = $1 AND insumo_id IS NOT NULL AND precio > 0 AND fecha IS NOT NULL
      LIMIT 20`,
    [businessId]
  );
  const insumoIds = ids.rows.map((r) => Number(r.insumo_id));
  console.log(`\n=== calcularPreciosPorModo con ${insumoIds.length} insumo_id de prueba ===`);
  console.log('insumoIds:', insumoIds);

  const precios = await calcularPreciosPorModo(pool, businessId, insumoIds, 'ultima_compra');
  console.log('Resultado (Map):', precios ? [...precios.entries()] : precios);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
