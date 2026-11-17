// services/maxiPipelineStockSync.js
//
// Salidas de stock sin venta desde el kit de MaxiRest (informe 27, «movimientos de stock
// detallado por remito») → stock_salidas (Diego 17/11/2026, pendiente #109).
// Mismo esquema que el sync de ventas (maxiPipelineSalesSync.js): por cada PDV del negocio se
// leen las tablas i27_<año>, se agrupa por día + artículo + concepto en la base (no se traen
// las filas sueltas) y se reemplazan esos días de ESA sucursal (borrar + insertar; source 'maxi').
// En el 27 las salidas vienen en negativo: se guardan en positivo. Los pases entre puntos de
// venta («De barra a cancha», «RAMOS A SAN-JUSTO») se marcan como transferencia: no se suman.
'use strict';

const pool = require('../config/db');
const { pdvsDeNegocio, verificarSucursales } = require('./maxiPdvMap');

const SOURCE = 'maxi';
const PREFIJO = 'i27_mov_de_stock_detallado_por_remito';

// «De barra a cancha», «De canchas a barra», «RAMOS A SAN-JUSTO»: «X a Y».
const esTransferencia = (concepto) => /\S\s+a\s+\S/i.test(String(concepto || ''));

async function tablasI27(schema) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE $2`,
    [schema, `${PREFIJO}_%`]
  );
  return rows.map((r) => r.table_name).filter((t) => new RegExp(`^${PREFIJO}_\\d{4}$`).test(t)).sort();
}

async function leerPdv(pdv, schema) {
  const tablas = await tablasI27(schema);
  const grupos = [];
  for (const t of tablas) {
    const { rows } = await pool.query(
      // Según el kit, codigo y cantidad pueden venir como número o como texto (Palermo suites):
      // se normalizan antes de comparar.
      `WITH f AS (
         SELECT fecha::date AS day,
                CASE WHEN TRIM(codigo::text) ~ '^[0-9]+$' THEN TRIM(codigo::text)::bigint ELSE 0 END AS article_id,
                nombre, COALESCE(TRIM(concepto::text), '') AS concepto,
                CASE WHEN TRIM(cantidad::text) ~ '^-?[0-9]+([.,][0-9]+)?$' THEN REPLACE(TRIM(cantidad::text), ',', '.')::numeric ELSE 0 END AS cantidad
           FROM "${schema}"."${t}"
          WHERE pdv = $1 AND fecha IS NOT NULL)
       SELECT day, article_id, MAX(nombre) AS article_name, concepto, -SUM(cantidad)::numeric AS qty
         FROM f WHERE cantidad < 0 AND article_id <> 0
        GROUP BY 1, 2, 4`,
      [pdv]
    );
    grupos.push(...rows);
  }
  return grupos;
}

async function syncSalidasStockDeNegocio(businessId, { dryRun = false } = {}) {
  const pdvs = pdvsDeNegocio(businessId);
  if (!pdvs.length) return { ok: false, error: `Negocio ${businessId} no está en PDV_MAP todavía` };
  await verificarSucursales(pool, businessId);

  const porPdv = [];
  const preparados = [];
  for (const { pdv, schema, branchId } of pdvs) {
    const grupos = await leerPdv(pdv, schema);
    const dias = [...new Set(grupos.map((g) => new Date(g.day).toISOString().slice(0, 10)))].sort();
    preparados.push({ branchId, grupos, dias });
    porPdv.push({ pdv, branchId, lineas: grupos.length, dias: dias.length,
      unidades: grupos.reduce((a, g) => a + Number(g.qty), 0),
      transferencias: grupos.filter((g) => esTransferencia(g.concepto)).length });
  }
  if (dryRun) return { ok: true, dryRun, porPdv };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of preparados) {
      if (!p.dias.length) continue;
      await client.query(
        `DELETE FROM stock_salidas
          WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $2::bigint AND source = '${SOURCE}' AND day = ANY($3::date[])`,
        [businessId, p.branchId, p.dias]
      );
      await client.query(
        `INSERT INTO stock_salidas (business_id, branch_id, day, article_id, article_name, concepto, qty, transferencia, source)
         SELECT $1::bigint, $2::bigint, t.day, t.article_id, t.article_name, t.concepto, t.qty, t.transferencia, '${SOURCE}'
           FROM UNNEST($3::date[], $4::bigint[], $5::text[], $6::text[], $7::numeric[], $8::boolean[])
             AS t(day, article_id, article_name, concepto, qty, transferencia)`,
        [businessId, p.branchId,
          p.grupos.map((g) => g.day), p.grupos.map((g) => g.article_id), p.grupos.map((g) => g.article_name),
          p.grupos.map((g) => g.concepto), p.grupos.map((g) => g.qty), p.grupos.map((g) => esTransferencia(g.concepto))]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, porPdv };
}

module.exports = { syncSalidasStockDeNegocio, esTransferencia };
