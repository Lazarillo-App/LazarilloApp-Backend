// Rubros de conceptos de caja creados desde Lazarillo (Diego 20/11/2026: «¿y si quiero crear un rubro de
// comisiones?»). Código desde 1000, como los conceptos propios: MaxiRest usa los chicos y su sincronización
// no los pisa. Si ya hay uno con ese nombre en la organización, se devuelve ese (no se duplica).
'use strict';

const { sql, db } = require('../db');
const { ErrorDatos } = require('../dashboard/resultados-api');

const CODIGO_MIN = 1000;

async function crearRubroCaja({ organizationId, body }) {
  const nombre = String(body?.nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!nombre || nombre.length > 60) {
    const e = new ErrorDatos('Poné un nombre para el rubro (hasta 60 letras)'); e.status = 422; throw e;
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`rubros-caja:${organizationId}`}))`);
    const igual = await tx.one(sql`
      SELECT codigo, nombre FROM gestion_rubros_concepto_caja
       WHERE organization_id = ${organizationId} AND LOWER(TRIM(nombre)) = LOWER(${nombre}) LIMIT 1`);
    if (igual) return { codigo: String(igual.codigo).trim(), nombre: String(igual.nombre).trim(), existente: true };
    const mayor = await tx.one(sql`
      SELECT MAX(codigo::int) AS n FROM gestion_rubros_concepto_caja
       WHERE organization_id = ${organizationId} AND TRIM(codigo) ~ '^[0-9]+$' AND TRIM(codigo)::int >= ${CODIGO_MIN}`);
    const codigo = String(Math.max(CODIGO_MIN, (mayor?.n ?? CODIGO_MIN - 1) + 1));
    await tx.execute(sql`
      INSERT INTO gestion_rubros_concepto_caja (organization_id, codigo, nombre) VALUES (${organizationId}, ${codigo}, ${nombre})`);
    return { codigo, nombre, existente: false };
  });
}

module.exports = { crearRubroCaja, CODIGO_MIN };
