// services/costoManual.js
//
// Costo manual de insumos (Diego 19/11/2026): cargar un costo a mano, un recargo % (a un insumo o a
// todos los que se le compran a un proveedor) y deshacerlo. Regla: rige hasta que entra una compra
// nueva del insumo (precioCosteoInsumos lo pisa con lo real y limpia la marca).
'use strict';

const { propagarCostoInsumo } = require('./costoRecetaService');

// Pone un costo manual a un insumo simple: guarda el precio previo (solo la primera vez), borra los
// costos por local (mientras rija el manual, todos los locales usan este) y propaga a las recetas.
async function aplicarCostoManual(client, ins, nuevo) {
  await client.query(
    `UPDATE insumos
        SET precio_ref = $2, precio_manual_at = NOW(),
            precio_previo_manual = CASE WHEN precio_manual_at IS NULL THEN precio_ref ELSE precio_previo_manual END,
            updated_at = NOW()
      WHERE id = $1`, [ins.id, nuevo]);
  await client.query(`DELETE FROM insumo_costos_local WHERE insumo_id = $1`, [ins.id]);
  await propagarCostoInsumo(Number(ins.id), Number(ins.business_id), client);
}

// Saca el costo manual: con compras vuelve al costo de las compras; sin compras, al precio previo.
// Devuelve null si el insumo no estaba manual.
async function deshacerCostoManualUno(client, id, orgBizIds) {
  const { rows } = await client.query(
    `SELECT id, business_id, nombre, precio_ref, precio_manual_at, precio_previo_manual
       FROM insumos WHERE id = $1 AND business_id = ANY($2::int[]) FOR UPDATE`, [id, orgBizIds]);
  const ins = rows[0];
  if (!ins || !ins.precio_manual_at) return null;
  await client.query(
    `UPDATE insumos SET precio_manual_at = NULL, precio_ref = COALESCE(precio_previo_manual, precio_ref),
            precio_previo_manual = NULL, updated_at = NOW() WHERE id = $1`, [id]);
  const { rows: locales } = await client.query(
    `SELECT DISTINCT business_id FROM purchase_items WHERE insumo_id = $1 AND precio > 0`, [id]);
  const { actualizarPreciosDeInsumos } = require('./purchasesStore');
  for (const l of locales) {
    await actualizarPreciosDeInsumos(client, { businessId: Number(l.business_id), insumosBizId: Number(ins.business_id), insumoIds: [id] });
  }
  if (!locales.length) await propagarCostoInsumo(Number(id), Number(ins.business_id), client);
  const { rows: fin } = await client.query(`SELECT precio_ref FROM insumos WHERE id = $1`, [id]);
  return {
    id: Number(id), nombre: ins.nombre, antes: Number(ins.precio_ref) || 0, despues: Number(fin[0]?.precio_ref) || 0,
    deCompras: locales.length > 0, sinPrevio: !locales.length && ins.precio_previo_manual == null,
  };
}

// Proveedor de la última compra del insumo y los insumos (simples, activos) cuya última compra es de
// ese mismo proveedor, con el precio que hoy usa este local. Todo filtrado por la organización: los
// POS repiten los números de proveedor entre cuentas.
async function alcanceProveedor(db, { insumoId, businessId, orgBizIds, supplierBizId }) {
  const { rows } = await db.query(
    `WITH prov AS (
       SELECT p.proveedor_id FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
        WHERE pi.insumo_id = $1 AND pi.precio > 0 AND p.business_id = ANY($2::int[]) AND p.proveedor_id IS NOT NULL
        ORDER BY pi.fecha DESC, pi.id DESC LIMIT 1),
     cand AS (
       SELECT DISTINCT pi.insumo_id FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
        WHERE p.proveedor_id = (SELECT proveedor_id FROM prov) AND p.business_id = ANY($2::int[]) AND pi.precio > 0),
     ult AS (
       SELECT DISTINCT ON (pi.insumo_id) pi.insumo_id, p.proveedor_id
         FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
        WHERE pi.insumo_id IN (SELECT insumo_id FROM cand) AND pi.precio > 0 AND p.business_id = ANY($2::int[])
        ORDER BY pi.insumo_id, pi.fecha DESC, pi.id DESC)
     SELECT i.id, i.business_id, i.nombre, i.unidad_med, i.precio_manual_at,
            COALESCE(icl.precio, i.precio_ref)::float AS precio,
            (SELECT proveedor_id FROM prov) AS proveedor_id,
            (SELECT s.nombre FROM suppliers s WHERE s.id = (SELECT proveedor_id FROM prov) AND s.business_id = $3 LIMIT 1) AS proveedor_nombre
       FROM ult JOIN insumos i ON i.id = ult.insumo_id
       LEFT JOIN insumo_costos_local icl ON icl.insumo_id = i.id AND icl.business_id = $4
      WHERE ult.proveedor_id = (SELECT proveedor_id FROM prov)
        AND i.business_id = ANY($2::int[]) AND i.estado = 'activo' AND COALESCE(i.es_elaborado, FALSE) = FALSE
      ORDER BY i.nombre`,
    [insumoId, orgBizIds, supplierBizId, businessId]);
  if (!rows.length) return { proveedor: null, insumos: [] };
  return {
    proveedor: { id: rows[0].proveedor_id, nombre: rows[0].proveedor_nombre || `Proveedor ${rows[0].proveedor_id}` },
    insumos: rows.map((r) => ({ id: Number(r.id), business_id: Number(r.business_id), nombre: r.nombre, unidad_med: r.unidad_med, precio: Number(r.precio) || 0 })),
  };
}

module.exports = { aplicarCostoManual, deshacerCostoManualUno, alcanceProveedor };
