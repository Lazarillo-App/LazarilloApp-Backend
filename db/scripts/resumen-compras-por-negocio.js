// db/scripts/resumen-compras-por-negocio.js
//
// Diagnóstico de SOLO LECTURA. Qué negocios tienen datos de compras
// cargados hoy, y un pantallazo de posibles duplicados: facturas con más
// de una fila en `purchases` para la misma business_id+factura_key (no
// debería pasar nunca, hay UNIQUE sobre eso) y, más relevante, insumos con
// MÚLTIPLES grupos factura_key el MISMO día que claramente no son el
// mismo comprobante remarcado (candidatos a residuo del pipeline viejo).
//
// Uso: node db/scripts/resumen-compras-por-negocio.js [business_id]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = process.argv[2] ? Number(process.argv[2]) : null;

  const { rows: porNegocio } = await pool.query(
    `SELECT p.business_id, COUNT(DISTINCT p.id)::int AS facturas,
            COUNT(pi.id)::int AS items, SUM(p.total)::numeric(14,2) AS total,
            MIN(p.fecha) AS desde, MAX(p.fecha) AS hasta
       FROM purchases p
       LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
      GROUP BY p.business_id
      ORDER BY p.business_id`
  );
  console.log('=== Compras cargadas por negocio ===');
  console.table(porNegocio);

  // Duplicados reales a nivel de fila (no deberían existir, hay UNIQUE).
  const { rows: dupFactura } = await pool.query(
    `SELECT business_id, factura_key, COUNT(*)::int AS filas
       FROM purchases
      WHERE $1::int IS NULL OR business_id = $1
      GROUP BY business_id, factura_key
     HAVING COUNT(*) > 1
      ORDER BY filas DESC
      LIMIT 20`,
    [businessId]
  );
  console.log(`\n=== factura_key con más de 1 fila en purchases (duplicado real, no debería haber) — ${dupFactura.length} ===`);
  if (dupFactura.length) console.table(dupFactura);

  if (businessId) {
    // Insumos con más de un grupo (factura_key, proveedor) el MISMO día —
    // candidatos a residuo del pipeline viejo (ver conversación: "A 0004-..."
    // que ya no existe en el i25 actual, pero sigue en purchase_items).
    const { rows: mismosDia } = await pool.query(
      `WITH grupos AS (
         SELECT pi.insumo_id, p.factura_key, p.proveedor_id, p.fecha,
                SUM(pi.precio_total) AS importe
           FROM purchase_items pi
           JOIN purchases p ON p.id = pi.purchase_id
          WHERE pi.business_id = $1
          GROUP BY pi.insumo_id, p.factura_key, p.proveedor_id, p.fecha
       )
       SELECT insumo_id, proveedor_id, fecha, COUNT(*)::int AS grupos_ese_dia,
              SUM(importe)::numeric(14,2) AS importe_total_sumado
         FROM grupos
        GROUP BY insumo_id, proveedor_id, fecha
       HAVING COUNT(*) > 1
        ORDER BY importe_total_sumado DESC
        LIMIT 30`,
      [businessId]
    );
    console.log(`\n=== Insumo+proveedor+día con MÁS DE UN comprobante (negocio ${businessId}) — ${mismosDia.length} (mostrando hasta 30) ===`);
    if (mismosDia.length) console.table(mismosDia);

    const { rows: totalSumado } = await pool.query(
      `SELECT COUNT(*)::int AS filas, SUM(importe)::numeric(14,2) AS importe_total FROM (
         SELECT pi.insumo_id, p.factura_key, p.proveedor_id, p.fecha,
                SUM(pi.precio_total) AS importe
           FROM purchase_items pi
           JOIN purchases p ON p.id = pi.purchase_id
          WHERE pi.business_id = $1
          GROUP BY pi.insumo_id, p.factura_key, p.proveedor_id, p.fecha
       ) x`,
      [businessId]
    );
    const { rows: totalInsumo } = await pool.query(
      `WITH grupos AS (
         SELECT pi.insumo_id, p.factura_key, p.proveedor_id, p.fecha,
                SUM(pi.precio_total) AS importe
           FROM purchase_items pi
           JOIN purchases p ON p.id = pi.purchase_id
          WHERE pi.business_id = $1
          GROUP BY pi.insumo_id, p.factura_key, p.proveedor_id, p.fecha
       ),
       porDia AS (
         SELECT insumo_id, proveedor_id, fecha,
                SUM(importe) AS importe_dia, COUNT(*) AS grupos
           FROM grupos
          GROUP BY insumo_id, proveedor_id, fecha
       )
       SELECT
         SUM(importe_dia) FILTER (WHERE grupos > 1)::numeric(14,2) AS importe_en_dias_duplicados,
         SUM(importe_dia) FILTER (WHERE grupos = 1)::numeric(14,2) AS importe_en_dias_simples
         FROM porDia`,
      [businessId]
    );
    console.log(`\n=== Pantallazo total (negocio ${businessId}) ===`);
    console.log(totalSumado[0]);
    console.log(totalInsumo[0]);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
