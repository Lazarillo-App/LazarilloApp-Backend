// repos/insumosRepo.js
'use strict';
const pool = require('../config/db');

async function upsertFromMaxi(items = []) {
  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');

    for (const it of items) {
      const codigo = it.codigo ?? it.codigoMaxi ?? it.codigo_maxi;
      if (!codigo && codigo !== 0) { skipped++; continue; }

      const nombre     = (it.nombre ?? '').trim();
      const unidadMed  = it.medida ?? it.unidadMed ?? it.unidad_med ?? null;
      const precioRef  = it.precio ?? it.precioRef ?? it.precio_ref ?? null;
      const rubro      = it.rubro ?? null;
      const activo     = it.discontinuado ? false : true; // discontinuado=1 → inactivo

      const r = await client.query(
        `INSERT INTO insumos (codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, activo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (codigo_maxi) DO UPDATE SET
           nombre      = EXCLUDED.nombre,
           unidad_med  = EXCLUDED.unidad_med,
           precio_ref  = EXCLUDED.precio_ref,
           rubro       = EXCLUDED.rubro,
           origen      = EXCLUDED.origen,
           activo      = EXCLUDED.activo,
           updated_at  = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          String(codigo),
          nombre,
          unidadMed,
          precioRef == null ? null : Number(precioRef),
          rubro,
          'maxi',
          activo,
        ]
      );

      if (r.rows?.[0]?.inserted) inserted++;
      else updated++;
    }

    await client.query('COMMIT');
    return { inserted, updated, skipped, total: inserted + updated + skipped };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('upsertFromMaxi error:', e);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { upsertFromMaxi };
