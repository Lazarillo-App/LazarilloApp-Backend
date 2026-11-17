// services/gestion/conceptos/base.js
//
// RESPALDO: lo normal es la Plantilla Lazarillo copiada de DEMO (plantilla.js). Esto se usa solo si
// DEMO no está (base local, tests).
//
// Conceptos de caja básicos para un negocio que no tiene ninguno (Diego 17/11/2026: «si no hay
// conceptos de caja, crearlos y asociarlos»). Un negocio con MaxiRest trae los suyos del maestro: acá
// solo se crean si la organización no tiene NI UN concepto, así nunca se mezclan con los de MaxiRest.
// Mismo armado que el ejemplo del panel vacío (PanelEjemplo.jsx): Mercaderías, Gastos en personal,
// Alquiler y servicios, Impuestos, Mantenimiento y Otros gastos.
//  - Rubros del Panel (gestion_rubros_concepto_caja): «Gastos en personal» va con el código 3, el que
//    el Panel usa para sueldos (RUBRO_GASTOS_EN_PERSONAL_CODIGO).
//  - Conceptos propios de Lazarillo: códigos desde 1000 (conceptos/abm.js).
'use strict';

const { CODIGO_MIN_LAZARILLO } = require('./abm');

const BASE = [
  { codigo: '1', nombre: 'Mercaderías', conceptos: ['Carnes', 'Verdulería y frutas', 'Almacén', 'Bebidas', 'Lácteos y fiambres', 'Panadería', 'Descartables y limpieza'] },
  { codigo: '2', nombre: 'Alquiler y servicios', conceptos: ['Alquiler', 'Luz', 'Gas', 'Agua', 'Internet y teléfono'] },
  { codigo: '3', nombre: 'Gastos en personal', conceptos: ['Sueldos y cargas sociales'], tipo: 'E' },
  { codigo: '4', nombre: 'Impuestos', conceptos: ['Impuestos y tasas'] },
  { codigo: '5', nombre: 'Mantenimiento', conceptos: ['Mantenimiento y reparaciones'] },
  { codigo: '6', nombre: 'Otros gastos', conceptos: ['Honorarios', 'Otros gastos'] },
];

/** Filas a crear (pura, testeada): rubros y conceptos con sus códigos. */
function armarBase() {
  const rubros = BASE.map(({ codigo, nombre }) => ({ codigo, nombre }));
  const conceptos = [];
  let n = CODIGO_MIN_LAZARILLO;
  for (const r of BASE) for (const nombre of r.conceptos) conceptos.push({ codigo: String(n++), nombre, tipo: r.tipo || '-', codRga: r.codigo });
  return { rubros, conceptos };
}

/**
 * Crea la base si la organización no tiene conceptos. Va en la transacción que le pasen (client de pg).
 * Devuelve { creados: n } (0 si ya tenía). Candado por organización: dos cargas a la vez no la duplican.
 */
async function asegurarConceptosBase(client, organizationId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`conceptos-base:${organizationId}`]);
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM gestion_conceptos_caja WHERE organization_id = $1', [organizationId]);
  if (rows[0].n > 0) return { creados: 0 };
  const { rubros, conceptos } = armarBase();
  await client.query(
    `INSERT INTO gestion_rubros_concepto_caja (organization_id, codigo, nombre)
     SELECT $1, * FROM UNNEST($2::text[], $3::text[]) ON CONFLICT (organization_id, codigo) DO NOTHING`,
    [organizationId, rubros.map((r) => r.codigo), rubros.map((r) => r.nombre)]);
  await client.query(
    `INSERT INTO gestion_conceptos_caja (organization_id, codigo, nombre, tipo, "codRga")
     SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[]) ON CONFLICT (organization_id, codigo) DO NOTHING`,
    [organizationId, conceptos.map((c) => c.codigo), conceptos.map((c) => c.nombre), conceptos.map((c) => c.tipo), conceptos.map((c) => c.codRga)]);
  return { creados: conceptos.length };
}

module.exports = { asegurarConceptosBase, armarBase, BASE };
