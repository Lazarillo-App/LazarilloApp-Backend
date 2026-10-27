// db/scripts/check-elaborados-con-compras.js
//
// Diagnóstico de SOLO LECTURA. Un elaborado (es_elaborado=true) se hace en
// cocina a partir de una receta — su costo sale de ahí (propagarCostoInsumo),
// NO de compras. Si tiene filas en purchase_items igual, algo está mal
// matcheado (ej. codigo_maxi colisiona con un código de compra real que no
// le corresponde) y el backfill de precio_ref le pisaría el costo real con
// un número de una compra ajena.
//
// Uso: node db/scripts/check-elaborados-con-compras.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = Number(process.argv[2]);
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/check-elaborados-con-compras.js <business_id>');
    process.exit(1);
  }

  // "Elaborado" = insumo con una receta PROPIA activa Y CON INGREDIENTES
  // (receta.insumo_id = insumo.id). Una receta propia VACÍA es de rendimiento/
  // equivalencias (ej. "GINPAFF BOTELLA"), no de costeo — ese caso se compra
  // de verdad y no debe aparecer acá. Su costo debe salir de la receta
  // (propagarCostoInsumo), nunca de purchase_items.
  const { rows } = await pool.query(
    `SELECT i.id, i.nombre, i.codigo_maxi, i.precio_ref, i.bonif_aceptada,
            COUNT(pi.id)::int AS lineas_compra,
            MIN(p.fecha) AS primera_compra, MAX(p.fecha) AS ultima_compra
       FROM insumos i
       JOIN recetas r ON r.insumo_id = i.id AND r.business_id = i.business_id AND r.active = TRUE
       JOIN purchase_items pi ON pi.insumo_id = i.id AND pi.business_id = i.business_id
       JOIN purchases p ON p.id = pi.purchase_id
      WHERE i.business_id = $1
        AND EXISTS (SELECT 1 FROM receta_items ri WHERE ri.receta_id = r.id)
      GROUP BY i.id, i.nombre, i.codigo_maxi, i.precio_ref, i.bonif_aceptada
      ORDER BY lineas_compra DESC`,
    [businessId]
  );

  console.log(`${rows.length} elaborado(s) con líneas de compra asociadas (no debería pasar):\n`);
  rows.forEach((r) => {
    console.log(`  #${r.id} "${r.nombre}" (codigo_maxi: ${r.codigo_maxi}) — ${r.lineas_compra} línea(s), ${new Date(r.primera_compra).toISOString().slice(0,10)} a ${new Date(r.ultima_compra).toISOString().slice(0,10)} — precio_ref actual: $${r.precio_ref}`);
  });

  if (rows.length) {
    // Para el primero de la lista: mostrar el detalle de esas compras, para
    // ver si son compras reales (proveedor externo) o un codigo_maxi que
    // en realidad pertenece a otra cosa.
    const primero = rows[0];
    const detalle = await pool.query(
      `SELECT p.fecha, p.factura_key, pr.nombre AS proveedor, pi.cantidad, pi.precio, pi.precio_total
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
         LEFT JOIN suppliers pr ON pr.id = p.proveedor_id AND pr.business_id = p.business_id
        WHERE pi.insumo_id = $1
        ORDER BY p.fecha DESC LIMIT 10`,
      [primero.id]
    );
    console.log(`\n=== Detalle de compras de "${primero.nombre}" (#${primero.id}) ===`);
    console.table(detalle.rows);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
