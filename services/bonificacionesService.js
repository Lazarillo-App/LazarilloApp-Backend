// services/bonificacionesService.js
// Recalcula el costo de insumos con bonificación aceptada tras un import de compras.
// Modelo A: el costo sale del ÚLTIMO comprobante global del insumo (importe / recibidas).
//  - Si el último comprobante trae bonificación → recalcula y mantiene aplicada.
//  - Si NO trae → vuelve a precio de lista y apaga el flag.
// Nunca pisa el costo crudo: es la lógica de bonificación actualizándose a sí misma.

const { propagarCostoInsumo } = require('./costoRecetaService');

async function getOrgBizIds(bizId, db) {
  const { rows } = await db.query(
    `SELECT id FROM app_businesses
      WHERE organization_id = (SELECT organization_id FROM app_businesses WHERE id = $1)`,
    [bizId]
  );
  const ids = rows.map(r => r.id);
  return ids.length ? ids : [bizId];
}

/**
 * Recalcula bonificaciones de los insumos con bonif_aceptada que recibieron compras.
 * @param {number} bizId    negocio del import (para resolver la org)
 * @param {number[]} insumoIds  insumos tocados por el import (si null, todos los aceptados de la org)
 * @param {object} client   client de la transacción del import
 * @returns {Array} cambios: [{ insumoId, nombre, tipo, ratioViejo, ratioNuevo, costoViejo, costoNuevo }]
 */
async function recalcularBonificaciones(bizId, insumoIds, client) {
  const orgBizIds = await getOrgBizIds(bizId, client);

  // Insumos con bonificación aceptada (opcionalmente filtrados por los tocados en el import)
  const filtroIds = Array.isArray(insumoIds) && insumoIds.length
    ? `AND i.id = ANY($2::int[])` : '';
  const params = filtroIds ? [orgBizIds, insumoIds] : [orgBizIds];
  const { rows: aceptados } = await client.query(
    `SELECT i.id, i.nombre, i.precio_ref, i.bonif_ratio, i.business_id
       FROM insumos i
      WHERE i.bonif_aceptada = TRUE
        AND i.business_id = ANY($1::int[])
        ${filtroIds}`,
    params
  );

  const cambios = [];

  for (const ins of aceptados) {
    // Último comprobante global del insumo (mismo criterio que estadoBonificacion)
    const { rows: compRows } = await client.query(
      `SELECT
         p.factura_key,
         SUM(CASE WHEN pi.precio_total > 0 THEN pi.cantidad ELSE 0 END) AS facturadas,
         SUM(CASE WHEN pi.precio_total = 0 THEN pi.cantidad ELSE 0 END) AS bonificadas,
         SUM(pi.precio_total)                                           AS importe_total
       FROM purchases p
       JOIN purchase_items pi ON pi.purchase_id = p.id
      WHERE pi.insumo_id = $1 AND pi.business_id = ANY($2::int[])
      GROUP BY p.factura_key, p.proveedor_id
      ORDER BY MAX(p.fecha) DESC, MAX(p.id) DESC
      LIMIT 1`,
      [ins.id, orgBizIds]
    );
    const comp = compRows[0];
    if (!comp) continue;

    const facturadas = Number(comp.facturadas) || 0;
    const bonificadas = Number(comp.bonificadas) || 0;
    const importe = Number(comp.importe_total) || 0;
    const costoViejo = Number(ins.precio_ref) || 0;
    const ratioViejo = ins.bonif_ratio != null ? Number(ins.bonif_ratio) : null;

    if (bonificadas > 0 && facturadas > 0) {
      // Sigue trayendo bonificación → recalcular costo real
      const recibidas = facturadas + bonificadas;
      const costoNuevo = recibidas > 0 ? Math.round((importe / recibidas) * 10000) / 10000 : 0;
      const r = facturadas / bonificadas;
      const ratioNuevo = Math.abs(r - Math.round(r)) < 0.01 ? Math.round(r) : null;
      if (!costoNuevo) continue;

      // Solo tocar si cambió el costo (evita writes/propagación innecesaria)
      if (Math.abs(costoNuevo - costoViejo) > 0.0001 || ratioNuevo !== ratioViejo) {
        await client.query(
          `UPDATE insumos SET precio_ref = $1, bonif_ratio = $2, updated_at = NOW()
            WHERE id = $3 AND business_id = $4`,
          [costoNuevo, ratioNuevo, ins.id, ins.business_id]
        );
        await propagarCostoInsumo(ins.id, ins.business_id, client);
        cambios.push({
          insumoId: ins.id, nombre: ins.nombre, tipo: 'actualizada',
          ratioViejo, ratioNuevo, costoViejo, costoNuevo,
        });
      }
    } else {
      // La bonificación dejó de venir → volver a precio de lista + apagar flag
      const { rows: listaRows } = await client.query(
        `SELECT pi_ult.precio AS precio_lista
           FROM purchase_items pi_ult
          WHERE pi_ult.insumo_id = $1 AND pi_ult.business_id = ANY($2::int[]) AND pi_ult.precio > 0
          ORDER BY pi_ult.fecha DESC, pi_ult.id DESC LIMIT 1`,
        [ins.id, orgBizIds]
      );
      const precioLista = Number(listaRows[0]?.precio_lista) || 0;
      if (!precioLista) continue;

      await client.query(
        `UPDATE insumos
            SET precio_ref = $1, bonif_aceptada = FALSE, bonif_ratio = NULL, updated_at = NOW()
          WHERE id = $2 AND business_id = $3`,
        [precioLista, ins.id, ins.business_id]
      );
      await propagarCostoInsumo(ins.id, ins.business_id, client);
      cambios.push({
        insumoId: ins.id, nombre: ins.nombre, tipo: 'volvio_lista',
        ratioViejo, ratioNuevo: null, costoViejo, costoNuevo: precioLista,
      });
    }
  }

  return cambios;
}

module.exports = { recalcularBonificaciones };