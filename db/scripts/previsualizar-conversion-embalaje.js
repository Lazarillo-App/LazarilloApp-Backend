// db/scripts/previsualizar-conversion-embalaje.js
//
// Diagnóstico de SOLO LECTURA y liviano: muestra, para un negocio puntual,
// cómo quedaría cada línea de i25 después de aplicar el factor de embalaje
// (m0), SIN tocar la base — para revisar antes de correr el sync real.
//
// Uso: node db/scripts/previsualizar-conversion-embalaje.js <business_id> [codigo]
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { PDV_MAP } = require('../../services/maxiPipelinePurchasesSync');

function resolverPdv(businessId) {
  const entry = Object.entries(PDV_MAP).find(([, v]) => v.businessId === Number(businessId));
  return entry ? { pdv: entry[0], schema: entry[1].schema } : null;
}

async function main() {
  const businessId = Number(process.argv[2]);
  const codigoFiltro = process.argv[3] ? Number(process.argv[3]) : null;
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/previsualizar-conversion-embalaje.js <business_id> [codigo]');
    process.exit(1);
  }
  const resuelto = resolverPdv(businessId);
  if (!resuelto) { console.log('Negocio no está en PDV_MAP'); process.exit(1); }
  const { pdv, schema } = resuelto;

  const { rows: tablas } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name LIKE 'i25_compras_detalle_de_compras_%'
      ORDER BY table_name DESC`,
    [schema]
  );
  let filas = [];
  for (const t of tablas) {
    const { rows } = await pool.query(`SELECT * FROM "${schema}"."${t.table_name}" WHERE pdv = $1`, [pdv]);
    filas = filas.concat(rows);
  }
  if (codigoFiltro) filas = filas.filter((f) => Number(f.codigo) === codigoFiltro);
  filas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  filas = filas.slice(0, 15);

  const { rows: m0 } = await pool.query(
    `SELECT codigo, envase1, neto1, envase2, neto2, envase3, neto3
       FROM "${schema}".m0_listado_de_insumos_con_discontinuados`
  );
  const factores = new Map();
  for (const r of m0) {
    const envases = new Map();
    for (const [envase, neto] of [[r.envase1, r.neto1], [r.envase2, r.neto2], [r.envase3, r.neto3]]) {
      const label = String(envase ?? '').trim();
      const factor = Number(neto);
      if (label && Number.isFinite(factor) && factor > 0) envases.set(label, factor);
    }
    if (envases.size) factores.set(Number(r.codigo), envases);
  }

  console.log(`=== Previsualización conversión embalaje — negocio ${businessId}, últimas ${filas.length} líneas ===\n`);
  const tabla = filas.map((f) => {
    const envases = factores.get(Number(f.codigo));
    const medida = String(f.medida ?? '').trim();
    const factor = envases?.get(medida) ?? 1;
    const cantidadBase = Number(f.cantidad ?? 0) * factor;
    const netoBase = factor !== 1 && cantidadBase > 0 ? Number(f.totalins ?? 0) / cantidadBase : f.neto;
    return {
      fecha: String(f.fecha).slice(0, 10),
      codigo: f.codigo,
      nombre: f.nombre,
      medida,
      cantidad_i25: f.cantidad,
      factor,
      cantidad_real: cantidadBase,
      precio_i25: f.neto,
      precio_real: Number(netoBase).toFixed(4),
      total_linea: f.totalins,
    };
  });
  console.table(tabla);

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
