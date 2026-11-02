// Portado de lazarillo_gestion/lib/dashboard/primer-arqueo.ts (misma lógica).
// En Lazarillo el filtro local/PDV es el negocio + la sucursal opcional.
'use strict';

const { sql, db } = require('../db');
const { filtroSucursalSql } = require('./query-builders');

// El arqueo (Disponible en caja) más viejo cargado que matchea el filtro de negocio/sucursal.
// "Diferencia de caja" solo tiene sentido a partir del mes SIGUIENTE a este (el arqueo es la
// caja inicial del mes que viene — ver spec 2026-08-24 §1). Un $0 es "sin dato", no ancla el
// cálculo (spec 2026-08-31), por eso `monto <> 0`.
async function findPrimerArqueo({ businessId, sucursal }) {
  const primera = await db.one(sql`
    SELECT f.anio, f.mes FROM gestion_flujo_caja_manual f
    WHERE ${filtroSucursalSql("f", businessId, sucursal)} AND f.monto <> 0
    ORDER BY f.anio, f.mes
    LIMIT 1
  `);
  return primera ? { anio: primera.anio, mes: primera.mes } : null;
}

module.exports = { findPrimerArqueo };
