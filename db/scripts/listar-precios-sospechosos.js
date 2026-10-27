// db/scripts/listar-precios-sospechosos.js
//
// Diagnóstico de SOLO LECTURA. Para un negocio, compara insumos.precio_ref
// (el que se usa en recetas) contra el precio "fresco" calculado de la
// MISMA forma que precioCosteoInsumos.js en modo 'ultima_compra' (costo real
// por comprobante, bonificaciones incluidas) — y marca los insumos donde la
// diferencia es grande, para ver si bonif_aceptada los tiene congelados o es
// otra cosa (ej. unidad mal configurada).
//
// Uso: node db/scripts/listar-precios-sospechosos.js <business_id> [umbral]
//   umbral = cuántas veces de diferencia como mínimo para listar (default 2 = el doble o la mitad)
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const businessId = Number(process.argv[2]);
  const umbral = Number(process.argv[3]) || 2;
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/listar-precios-sospechosos.js <business_id> [umbral]');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `WITH comp AS (
       SELECT pi.insumo_id, p.factura_key, p.proveedor_id,
              MAX(p.fecha) AS fecha, MAX(p.id) AS pid,
              SUM(pi.precio_total) AS importe, SUM(pi.cantidad) AS unidades
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
        WHERE pi.business_id = $1
        GROUP BY pi.insumo_id, p.factura_key, p.proveedor_id
     ),
     ultimo AS (
       SELECT DISTINCT ON (insumo_id) insumo_id, importe, unidades, fecha
         FROM comp
        WHERE unidades > 0
        ORDER BY insumo_id, fecha DESC, pid DESC
     ),
     fresco AS (
       SELECT insumo_id, ROUND((importe / unidades)::numeric, 4) AS precio_fresco, fecha AS fecha_ultima_compra
         FROM ultimo WHERE importe > 0
     )
     SELECT i.id, i.nombre, i.unidad_med, i.precio_ref, i.bonif_aceptada,
            f.precio_fresco, f.fecha_ultima_compra,
            EXISTS (
              SELECT 1 FROM recetas r
               WHERE r.insumo_id = i.id AND r.business_id = i.business_id AND r.active = TRUE
                 AND EXISTS (SELECT 1 FROM receta_items ri WHERE ri.receta_id = r.id)
            ) AS es_elaborado_real,
            EXISTS (
              SELECT 1 FROM recetas r
               WHERE r.insumo_id = i.id AND r.business_id = i.business_id AND r.active = TRUE
                 AND NOT EXISTS (SELECT 1 FROM receta_items ri WHERE ri.receta_id = r.id)
            ) AS tiene_receta_vacia
       FROM insumos i
       JOIN fresco f ON f.insumo_id = i.id
      WHERE i.business_id = $1
        AND i.precio_ref IS NOT NULL AND i.precio_ref > 0
        AND f.precio_fresco > 0
        AND (i.precio_ref / f.precio_fresco >= $2 OR f.precio_fresco / i.precio_ref >= $2)
      ORDER BY GREATEST(i.precio_ref / f.precio_fresco, f.precio_fresco / i.precio_ref) DESC`,
    [businessId, umbral]
  );

  console.log(`${rows.length} insumo(s) con precio_ref muy distinto al de su última compra real (umbral ${umbral}x):\n`);
  const conBonif = rows.filter((r) => r.bonif_aceptada === true).length;
  const elaboradosReales = rows.filter((r) => r.es_elaborado_real).length;
  const recetaVacia = rows.filter((r) => r.tiene_receta_vacia).length;
  console.log(`  - con bonif_aceptada=true (precio_ref congelado a propósito): ${conBonif}`);
  console.log(`  - elaborado real (receta con ingredientes — diferencia esperada, no tocar): ${elaboradosReales}`);
  console.log(`  - con receta propia VACÍA (sospechoso: insumo comprado con una receta rendimiento/equivalencias pisándole el precio): ${recetaVacia}`);
  console.log(`  - resto (sin ninguna de las anteriores — investigar): ${rows.length - conBonif - elaboradosReales - recetaVacia}\n`);

  rows.forEach((r) => {
    const ratio = (Number(r.precio_ref) / Number(r.precio_fresco)).toFixed(1);
    const etiqueta = r.es_elaborado_real ? ' [ELABORADO REAL]' : r.tiene_receta_vacia ? ' [RECETA VACÍA]' : '';
    console.log(`  #${r.id} "${r.nombre}" (${r.unidad_med}) — precio_ref: $${r.precio_ref} | última compra real: $${r.precio_fresco} (${new Date(r.fecha_ultima_compra).toISOString().slice(0,10)}) — ratio ${ratio}x — bonif_aceptada: ${r.bonif_aceptada === true}${etiqueta}`);
  });

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
