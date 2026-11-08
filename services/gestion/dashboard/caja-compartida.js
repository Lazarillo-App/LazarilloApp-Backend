// Caja compartida (08/11/2026). En gestion la caja era del LOCAL: Ramos Mejía juntaba Bar y Canchas
// y los arqueos se cargaban ahí. En Lazarillo cada negocio va por separado, así que un grupo de
// gestion_caja_compartida dice qué lugares (negocio + sucursal) comparten una caja:
//  - los arqueos se guardan en el lugar ancla del grupo (se carguen desde el Bar o desde Canchas);
//  - Disponible en caja y Diferencia de caja de cualquiera de ellos suman los demás lugares del grupo
//    (sus arqueos —están en el ancla— y sus ventas y compras), igual que la vista del local en gestion.
// Sin grupos configurados nada cambia.
'use strict';

const { sql, db } = require('../db');

const mismoLugar = (fila, businessId, sucursal) =>
  Number(fila.business_id) === Number(businessId)
  && (sucursal === undefined || (fila.branch_id == null ? null : Number(fila.branch_id)) === sucursal);

// Puro: filas = [{ grupo, business_id, branch_id, ancla }] de los grupos que tocan la vista.
// Devuelve los OTROS lugares a sumar (los que el filtro de la vista no cubre ya) y, si la vista es un
// lugar concreto de un grupo, dónde guardar sus arqueos.
function resolverCaja(filas, businessId, sucursal) {
  const tocados = new Set(filas.filter((f) => mismoLugar(f, businessId, sucursal)).map((f) => f.grupo));
  const extras = [];
  const vistos = new Set();
  let ancla = null;
  for (const f of filas) {
    if (!tocados.has(f.grupo)) continue;
    const lugar = { businessId: Number(f.business_id), sucursal: f.branch_id == null ? null : Number(f.branch_id) };
    if (f.ancla && sucursal !== undefined) ancla = lugar;
    if (mismoLugar(f, businessId, sucursal)) continue;
    const k = `${lugar.businessId}:${lugar.sucursal}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    extras.push(lugar);
  }
  return { extras, ancla: tocados.size ? ancla : null };
}

async function cajaDe({ businessId, sucursal }) {
  const filas = await db.many(sql`
    SELECT g.grupo, g.business_id, g.branch_id, g.ancla
      FROM gestion_caja_compartida g
     WHERE g.grupo IN (SELECT grupo FROM gestion_caja_compartida WHERE business_id = ${businessId})
     ORDER BY g.grupo, g.ancla DESC, g.business_id, g.branch_id NULLS FIRST
  `).catch((e) => {
    // Sin la tabla (base vieja) = sin cajas compartidas.
    if (/gestion_caja_compartida/.test(String(e.message))) return [];
    throw e;
  });
  return resolverCaja(filas, businessId, sucursal);
}

// Nombres de los otros lugares, para el aviso del Panel ("Caja compartida con Canchas").
async function nombresDe(lugares) {
  if (!lugares.length) return [];
  const ids = [...new Set(lugares.map((l) => l.businessId))];
  const sucs = [...new Set(lugares.map((l) => l.sucursal).filter((s) => s != null))];
  const negs = await db.many(sql`SELECT id, name FROM app_businesses WHERE id = ANY(${ids}::bigint[])`);
  const brs = sucs.length ? await db.many(sql`SELECT id, name FROM app_branches WHERE id = ANY(${sucs}::bigint[])`) : [];
  const nn = new Map(negs.map((n) => [Number(n.id), n.name]));
  const bn = new Map(brs.map((b) => [Number(b.id), b.name]));
  return lugares.map((l) => [nn.get(l.businessId) ?? `Negocio ${l.businessId}`, l.sucursal != null ? bn.get(l.sucursal) : null].filter(Boolean).join(' · '));
}

module.exports = { cajaDe, resolverCaja, nombresDe };
