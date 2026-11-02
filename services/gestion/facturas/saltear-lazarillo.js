// Portado de lazarillo_gestion/lib/facturas/saltear-lazarillo.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../db');

// Comprobantes cargados desde el Panel (origen 'lazarillo') para un local:
// el import de MaxiRest (14 y 25) los saltea — gana lo de Lazarillo y no se
// duplica (Diego, 26/10/2026: un tiempo se carga en los dos lados).
//
// Clave de comparación (revisión 27/10/2026):
//  - Notas de crédito: MaxiRest exporta "NC  0004-…" (manual) o "NcA 0004-…"
//    (electrónica) y Lazarillo guarda "NC…": se comparan sin la letra.
//  - Tickets (Z / "Tic"): el número NO es único (MaxiRest repite números en compras
//    distintas), así que además del número y el proveedor tiene que coincidir la
//    fecha; si no, se importa (mejor ver dos que perder una compra real).

const normalizarComprobante = (c) => c.toUpperCase().replace(/^NC[ABC]?/, "NC");
const esTicket = (c) => /^Z/i.test(c);

function claveSalteo(comprobante, codigo, fechaISO) {
  const cpb = normalizarComprobante(comprobante);
  return esTicket(cpb) ? `${cpb}|${codigo ?? ""}|${(fechaISO ?? "").slice(0, 10)}` : `${cpb}|${codigo ?? ""}`;
}

// Variantes de un comprobante tal como pueden estar guardadas (NC, NCA, NCB, NCC).
function variantes(c) {
  const n = normalizarComprobante(c);
  return n.startsWith("NC") ? [n, `NCA${n.slice(2)}`, `NCB${n.slice(2)}`, `NCC${n.slice(2)}`] : [n];
}

const iso = (f) => (f ? f.toISOString().slice(0, 10) : null);

// En Lazarillo el "local" es negocio + sucursal (ctx).
async function comprobantesDeLazarillo(
  db,
  tabla,
  ctx,
  comprobantes,
) {
  const unicos = [...new Set(comprobantes.filter(Boolean).flatMap(variantes))];
  if (ctx?.businessId == null || unicos.length === 0) return new Set();
  if (tabla === "compras") {
    const filas = await db.many(sql`
      SELECT comprobante, codigo, fecha FROM gestion_compras
       WHERE origen = 'lazarillo' AND business_id = ${ctx.businessId}
         AND branch_id IS NOT DISTINCT FROM ${ctx.branchId ?? null}::bigint
         AND comprobante = ANY(${unicos})`);
    return new Set(filas.map((f) => claveSalteo(f.comprobante ?? "", f.codigo, iso(f.fecha))));
  }
  const filas = await db.many(sql`
    SELECT comprobante, "codPro", fecha FROM gestion_detalle_compras
     WHERE origen = 'lazarillo' AND business_id = ${ctx.businessId}
       AND branch_id IS NOT DISTINCT FROM ${ctx.branchId ?? null}::bigint
       AND comprobante = ANY(${unicos})`);
  return new Set(filas.map((f) => claveSalteo(f.comprobante ?? "", f.codPro, iso(f.fecha))));
}

module.exports = { normalizarComprobante, esTicket, claveSalteo, comprobantesDeLazarillo };
