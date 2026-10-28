// db/scripts/probar-calculo-precio.js
//
// Diagnóstico de SOLO LECTURA y LIVIANO: llama a calcularPreciosPorModo
// directamente para un puñado de insumos puntuales, sin tocar MaxiRest ni
// reinsertar nada — una sola consulta agrupada (la misma que ya corre en
// cada sync), para verificar el fix de "caja vs. unidad" sin la carga de
// un --aplicar completo.
//
// Uso: node db/scripts/probar-calculo-precio.js <business_id> <insumo_id> [insumo_id...]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { calcularPreciosPorModo } = require('../../services/precioCosteoInsumos');

async function main() {
  const businessId = Number(process.argv[2]);
  const insumoIds = process.argv.slice(3).map(Number).filter(Number.isFinite);
  if (!Number.isFinite(businessId) || !insumoIds.length) {
    console.log('Uso: node db/scripts/probar-calculo-precio.js <business_id> <insumo_id> [insumo_id...]');
    process.exit(1);
  }

  const { rows: actuales } = await pool.query(
    `SELECT id, nombre, precio_ref FROM insumos WHERE id = ANY($1::int[])`,
    [insumoIds]
  );
  const porId = new Map(actuales.map((r) => [r.id, r]));

  const precios = await calcularPreciosPorModo(pool, businessId, insumoIds, 'ultima_compra');

  console.log(`=== Comparación precio_ref actual vs. calculado (sin guardar nada) ===\n`);
  for (const id of insumoIds) {
    const ins = porId.get(id);
    const calculado = precios.get(id);
    console.log(`#${id} "${ins?.nombre ?? '?'}" — actual: $${ins?.precio_ref ?? '?'} → calculado: $${calculado ?? '(sin resultado)'}`);
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
