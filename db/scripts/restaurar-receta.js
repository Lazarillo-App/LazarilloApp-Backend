// db/scripts/restaurar-receta.js
//
// Recuperar una receta borrada (pedido de la usuaria 2026-11-19: #3315 Wrap veggie).
// Borrar UNA receta desde la pantalla no la elimina: queda con active = FALSE y con todos sus
// ingredientes, pasos y fotos. Este script la busca y la vuelve a activar.
// OJO: si después de borrarla se guardó una receta nueva para el mismo artículo, se reusó la misma fila
// y los ingredientes viejos se pisaron (eso ya no se puede recuperar desde acá). Lo mismo con el
// borrado masivo (recetas/bulk), que sí hace DELETE.
//
//   node db/scripts/restaurar-receta.js <codigo|texto> [--negocio=<id>]
//       PRUEBA (solo lee): muestra las recetas de ese código de artículo/elaborado, o cuyo nombre
//       contiene el texto, activas o no, con sus ingredientes.
//   node db/scripts/restaurar-receta.js <codigo|texto> --negocio=<id> --receta=<id> --aplicar --confirmo-host=<host>
//       Vuelve a activar esa receta (y si es de un elaborado, le devuelve el costo al insumo).
'use strict';

require('dotenv').config({ quiet: true });
const pool = require('../../config/db');
const { logAudit } = require('../../services/audit/auditLog');

const argValor = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const BUSCA = (process.argv[2] || '').trim();
const NEGOCIO = argValor('negocio') ? Number(argValor('negocio')) : null;
const RECETA = argValor('receta') ? Number(argValor('receta')) : null;
const APLICAR = process.argv.includes('--aplicar');
const HOST = argValor('confirmo-host');

const fmt = (d) => (d ? new Date(d).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }) : '—');

async function main() {
  if (!BUSCA || BUSCA.startsWith('--')) {
    console.log('Uso: node db/scripts/restaurar-receta.js <codigo|texto> [--negocio=<id>]');
    process.exit(1);
  }
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (APLICAR) {
    if (HOST !== host) throw new Error(`para aplicar, confirmá el destino: --confirmo-host=${host}`);
    if (!NEGOCIO || !RECETA) throw new Error('para aplicar hacen falta --negocio=<id> y --receta=<id>');
  }

  const c = await pool.connect();
  try {
    await c.query(APLICAR ? 'BEGIN' : 'BEGIN READ ONLY');
    const esCodigo = /^\d+$/.test(BUSCA);
    const { rows: recetas } = await c.query(
      `SELECT r.id, r.business_id, b.name AS negocio, r.article_id, r.insumo_id, r.nombre,
              COALESCE(ma.nombre, i.nombre) AS nombre_actual, i.codigo_maxi,
              r.active, r.origen, r.costo_total, r.porciones, r.created_at, r.updated_at,
              jsonb_array_length(COALESCE(r.pasos, '[]'::jsonb)) AS pasos,
              (r.foto IS NOT NULL OR jsonb_array_length(COALESCE(r.fotos, '[]'::jsonb)) > 0) AS tiene_foto,
              (SELECT COUNT(*) FROM receta_items ri WHERE ri.receta_id = r.id)::int AS items
         FROM recetas r
         LEFT JOIN app_businesses b ON b.id = r.business_id
         LEFT JOIN maxi_articles ma ON ma.articulo_id::text = r.article_id::text AND ma.business_id = r.business_id
         LEFT JOIN insumos i ON i.id::text = r.insumo_id::text
        WHERE ($2::int IS NULL OR r.business_id = $2::int)
          AND ( ($3::boolean AND (r.article_id::text = $1::text
                         OR regexp_replace(TRIM(i.codigo_maxi::text), '\\.0+$', '') = $1::text))
                OR (NOT $3::boolean AND (r.nombre ILIKE '%' || $1::text || '%'
                                OR ma.nombre ILIKE '%' || $1::text || '%' OR i.nombre ILIKE '%' || $1::text || '%')) )
        ORDER BY r.business_id, r.updated_at DESC
        LIMIT 30`,
      [BUSCA, NEGOCIO, esCodigo]);

    if (!recetas.length) {
      console.log(`No hay ninguna receta (ni activa ni borrada) para "${BUSCA}"${NEGOCIO ? ` en el negocio ${NEGOCIO}` : ''}.`);
      console.log('Si se borró con el borrado masivo, la fila ya no existe: queda el respaldo de la base en Render.');
      await c.query('ROLLBACK');
      return;
    }

    for (const r of recetas) {
      console.log('\n' + '='.repeat(78));
      console.log(`Receta ${r.id} · negocio ${r.business_id} (${r.negocio || '?'}) · ${r.article_id ? `artículo ${r.article_id}` : `elaborado ${r.codigo_maxi || r.insumo_id}`}`);
      console.log(`  ${r.nombre_actual || r.nombre || '(sin nombre)'} · ${r.active ? 'ACTIVA' : 'BORRADA (inactiva)'} · origen ${r.origen}`);
      console.log(`  creada ${fmt(r.created_at)} · último cambio ${fmt(r.updated_at)}`);
      console.log(`  ${r.items} ingredientes · ${r.pasos} pasos · ${r.tiene_foto ? 'con foto' : 'sin foto'} · costo guardado $${Number(r.costo_total || 0).toFixed(2)} · porciones ${r.porciones}`);
      const { rows: items } = await c.query(
        `SELECT ri.cantidad, ri.unidad, ri.merma, COALESCE(i.nombre, ri.nombre_insumo_maxi, '(?)') AS insumo
           FROM receta_items ri LEFT JOIN insumos i ON i.id::text = ri.insumo_id::text
          WHERE ri.receta_id = $1 ORDER BY ri.orden NULLS LAST, ri.id`, [r.id]);
      for (const it of items) {
        console.log(`    - ${it.insumo}: ${Number(it.cantidad)} ${it.unidad || ''}${Number(it.merma) ? ` (merma ${Number(it.merma)}%)` : ''}`);
      }
      // savepoint: si el historial falla, que no aborte la transacción
      await c.query('SAVEPOINT hist');
      const { rows: hist } = await c.query(
        `SELECT action, created_at, user_alias_snapshot FROM audit_log
          WHERE entity_type = 'receta' AND business_id = $1::int AND entity_id::text = $2::text
          ORDER BY created_at DESC LIMIT 5`,
        [r.business_id, String(r.article_id ?? r.insumo_id)])
        .catch(async () => { await c.query('ROLLBACK TO SAVEPOINT hist'); return { rows: [] }; });
      if (hist.length) console.log('  historial: ' + hist.map((h) => `${h.action} ${fmt(h.created_at)} ${h.user_alias_snapshot || ''}`.trim()).join(' | '));
    }

    if (!APLICAR) {
      const borradas = recetas.filter((r) => !r.active);
      console.log('\n' + '-'.repeat(78));
      if (!borradas.length) console.log('Ninguna está borrada: no hay nada para restaurar.');
      else for (const r of borradas) {
        console.log(`Para restaurar la ${r.id}: node db/scripts/restaurar-receta.js "${BUSCA}" --negocio=${r.business_id} --receta=${r.id} --aplicar --confirmo-host=${host}`);
      }
      await c.query('ROLLBACK');
      return;
    }

    const r = recetas.find((x) => x.id === RECETA && x.business_id === NEGOCIO);
    if (!r) throw new Error(`la receta ${RECETA} no está entre las encontradas para el negocio ${NEGOCIO}`);
    if (r.active) throw new Error(`la receta ${RECETA} ya está activa`);

    await c.query(`UPDATE recetas SET active = TRUE, updated_at = NOW() WHERE id = $1 AND business_id = $2`, [r.id, NEGOCIO]);
    if (r.insumo_id) {
      await c.query(
        `UPDATE insumos SET tiene_receta = TRUE, costo_receta = $1, updated_at = NOW()
          WHERE id = $2 AND business_id = $3`, [r.costo_total || 0, r.insumo_id, NEGOCIO]);
    }
    await logAudit(c, {
      businessId: NEGOCIO, entityType: 'receta', entityId: r.article_id ?? r.insumo_id,
      action: 'restore', diff: { after: { active: true } }, metadata: { origen: 'script restaurar-receta' },
    });
    await c.query('COMMIT');
    console.log(`\nListo: receta ${r.id} (${r.nombre_actual || r.nombre}) restaurada en el negocio ${NEGOCIO}.`);
    console.log('Abrila en Lazarillo y guardala una vez para que recalcule el costo con los precios de hoy.');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* nada */ }
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
