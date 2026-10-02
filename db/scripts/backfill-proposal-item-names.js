// db/scripts/backfill-proposal-item-names.js
//
// Uso único: las propuestas creadas ANTES del fix de "(sin nombre)" (ver
// services/recetaProposals.js → enrichItemsConNombre) quedaron guardadas sin
// el nombre del ingrediente en payload_after. Este script re-resuelve el
// nombre de cada item de las propuestas pending/in_revision existentes y las
// actualiza in place — no toca status ni nada más.
//
// Uso: node db/scripts/backfill-proposal-item-names.js
'use strict';
require('dotenv').config();
const pool = require('../../config/db');
const { enrichItemsConNombre } = require('../../services/recetaProposals');

async function main() {
  const { rows } = await pool.query(
    `SELECT id, business_id, payload_after FROM receta_proposals WHERE status IN ('pending', 'in_revision')`
  );
  console.log(`${rows.length} propuesta(s) pendiente(s)/en revisión encontradas.`);

  for (const p of rows) {
    const items = Array.isArray(p.payload_after?.items) ? p.payload_after.items : [];
    const enriched = await enrichItemsConNombre(items, p.business_id);
    const nuevoPayload = { ...p.payload_after, items: enriched };
    await pool.query(
      `UPDATE receta_proposals SET payload_after = $1::jsonb WHERE id = $2`,
      [JSON.stringify(nuevoPayload), p.id]
    );
    console.log(`  propuesta ${p.id}: ${enriched.length} item(s) actualizados`);
  }

  await pool.end();
  console.log('Listo.');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
