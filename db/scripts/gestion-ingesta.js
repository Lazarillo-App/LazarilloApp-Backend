// db/scripts/gestion-ingesta.js
//
// Ingesta de gestion (port de lazarillo_gestion, services/gestion): lee los informes
// que el kit sube a container/comercio y llena las tablas gestion_* (compras, detalle,
// pagos, ventas, nómina y maestros) de cada negocio/sucursal configurado en
// gestion_render_origenes.
//
// Solo escribe en tablas gestion_*: no toca purchases/sales ni nada del resto de Lazarillo.
//
// Uso:
//   node db/scripts/gestion-ingesta.js                 → lista qué leería (no escribe nada)
//   node db/scripts/gestion-ingesta.js --configurar    → carga los PDV conocidos en gestion_render_origenes
//   node db/scripts/gestion-ingesta.js --correr        → corre la ingesta (solo lo que cambió en el kit)
//   node db/scripts/gestion-ingesta.js --correr --forzar → relee todo aunque no haya cambiado
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { db, sql } = require('../../services/gestion/db');
const { listarItems, abrirCorrida, ejecutarCorrida, ultimaCorrida } = require('../../services/gestion/render/sync');

// PDV del kit → negocio/sucursal (mismo mapeo que services/maxiPdvMap.js).
const ORIGENES = [
  { esquema: 'container', pdv: 'BAR', businessId: 147, branchId: null },
  { esquema: 'container', pdv: 'FCRAMOS', businessId: 204, branchId: null },
  { esquema: 'container', pdv: 'FCSANJUSTO', businessId: 204, branchId: 15 },
  { esquema: 'comercio', pdv: 'COMERCIO', businessId: 210, branchId: null },
];

async function configurar() {
  for (const o of ORIGENES) {
    await db.execute(sql`
      INSERT INTO gestion_render_origenes (esquema, pdv, business_id, branch_id, activo)
      VALUES (${o.esquema}, ${o.pdv}, ${o.businessId}, ${o.branchId}::bigint, true)
      ON CONFLICT (esquema, pdv) DO UPDATE SET
        business_id = EXCLUDED.business_id, branch_id = EXCLUDED.branch_id, activo = true`);
  }
  console.table(await db.many(sql`
    SELECT o.esquema, o.pdv, o.business_id, o.branch_id, b.name AS negocio, br.name AS sucursal, b.organization_id
      FROM gestion_render_origenes o
      JOIN app_businesses b ON b.id = o.business_id
      LEFT JOIN app_branches br ON br.id = o.branch_id
     ORDER BY o.id`));
}

async function listar() {
  const items = await listarItems();
  if (!items.length) {
    console.log('No hay nada para leer. ¿Corriste --configurar?');
    return;
  }
  console.table(items.map((i) => ({
    tabla: `${i.esquema}.${i.tabla}`,
    pdv: i.pdv,
    destino: i.maestro ? `org ${i.organizationId}` : `negocio ${i.businessId}${i.branchId != null ? ` / suc ${i.branchId}` : ''}`,
    filas: i.filas,
    bloqueado: i.bloqueado ?? '',
    ultimo: i.ultimo ? `${i.ultimo.estado} ${i.ultimo.creadoEn.slice(0, 16)}` : '—',
  })));
}

async function correr(forzar) {
  const id = await abrirCorrida('script');
  if (id == null) {
    console.log('Ya hay una corrida en curso; no se larga otra.');
    return;
  }
  console.log(`Corrida #${id}${forzar ? ' (forzada)' : ''}...`);
  await ejecutarCorrida(id, 'script', { forzar });
  const c = await ultimaCorrida();
  console.log(`\nEstado: ${c.estado} — ${c.hechos}/${c.total} tablas`);
  const res = Object.entries(c.resumen || {});
  console.table(res.map(([tabla, r]) => ({ tabla, resultado: typeof r === 'string' ? r : JSON.stringify(r) })));

  const logs = await db.many(sql`
    SELECT "fileName", estado, "totalRows", created, updated, skipped,
           jsonb_array_length(COALESCE(errors, '[]'::jsonb)) AS errores, "errorMessage", "durationMs"
      FROM gestion_import_logs
     WHERE "creadoEn" >= (SELECT inicio FROM gestion_render_corridas WHERE id = ${id})
     ORDER BY id`);
  console.log('\nDetalle por tabla:');
  console.table(logs);
  const conErrores = await db.many(sql`
    SELECT "fileName", errors->0 AS primer_error
      FROM gestion_import_logs
     WHERE "creadoEn" >= (SELECT inicio FROM gestion_render_corridas WHERE id = ${id})
       AND jsonb_array_length(COALESCE(errors, '[]'::jsonb)) > 0`);
  for (const e of conErrores) console.log(`\nPrimer error en ${e.fileName}:`, JSON.stringify(e.primer_error));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--configurar')) await configurar();
  else if (args.includes('--correr')) await correr(args.includes('--forzar'));
  else await listar();
  await pool.end();
}

main().catch(async (e) => {
  console.error('Fatal:', e);
  await pool.end().catch(() => {});
  process.exit(1);
});
