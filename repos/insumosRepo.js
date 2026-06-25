// repos/insumosRepo.js — VERSIÓN ADITIVA
// La sync de insumos NO actualiza datos existentes.
// Solo inserta nuevos. Esto protege ediciones manuales del usuario.

const pool = require('../config/db');

async function upsertFromMaxi(businessId, items = [], opts = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) cargar existentes en un solo tiro (solo para contar unchanged)
    const codes = items
      .map(it => String(it.codigo_maxi ?? it.codigo ?? it.codigoMaxi ?? '').trim())
      .filter(Boolean);

    const existingSet = new Set();
    if (codes.length) {
      const { rows } = await client.query(
        `SELECT codigo_maxi
           FROM insumos
          WHERE business_id = $1
            AND codigo_maxi = ANY($2::text[])`,
        [businessId, codes]
      );
      for (const r of rows) existingSet.add(String(r.codigo_maxi));
    }

    let inserted = 0, unchanged = 0, skipped = 0;

    for (const it of items) {
      const codigo = String(it.codigo_maxi ?? it.codigo ?? it.codigoMaxi ?? '').trim();
      if (!codigo) { skipped++; continue; }

      const nombre = String(it.nombre ?? '').trim();
      if (!nombre) { skipped++; continue; }

      // Si ya existe → no tocar, no actualizar nada
      if (existingSet.has(codigo)) {
        unchanged++;
        continue;
      }

      // Solo insertar si es nuevo
      const precioRefIncoming = (it.precio_ref != null && Number(it.precio_ref) > 0)
        ? Number(it.precio_ref)
        : null;

      const r = await client.query(
        `INSERT INTO insumos (
           business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, estado
         )
         VALUES ($1,$2,$3,$4,$5,$6,'maxi','activo')
         ON CONFLICT (business_id, codigo_maxi) DO NOTHING
         RETURNING id`,
        [
          businessId,
          codigo,
          nombre,
          it.unidad_med ?? null,
          precioRefIncoming,
          it.rubro ?? null,
        ]
      );

      if (r.rows.length > 0) {
        inserted++;
      } else {
        // Por carrera concurrente (otro proceso lo insertó entre el SELECT y el INSERT)
        unchanged++;
      }
    }

    await client.query('COMMIT');

    // ── Reconciliación post-sync ──────────────────────────────────────
    // Buscar insumos manuales sin codigo_maxi que coincidan por nombre
    // con alguno de los insumos que llegaron de Maxi.
    // Si hay match: asignar el codigo_maxi, actualizar origen a 'maxi',
    // limpiar sin_equivalencia. Esto NO pisa nada del usuario porque
    // solo afecta insumos manuales que el usuario sabe que vienen sin código.
    let reconciled = 0;
    try {
      const reconcileClient = await pool.connect();
      try {
        await reconcileClient.query('BEGIN');

        const { rows: manuales } = await reconcileClient.query(
          `SELECT id, nombre, lower(trim(nombre)) AS nombre_norm
             FROM insumos
            WHERE business_id = $1
              AND (codigo_maxi IS NULL OR codigo_maxi = '')
              AND origen IN ('manual', 'csv')
              AND sin_equivalencia = TRUE`,
          [businessId]
        );

        if (manuales.length > 0) {
          const { rows: deMaxi } = await reconcileClient.query(
            `SELECT id, codigo_maxi, nombre, lower(trim(nombre)) AS nombre_norm,
                    unidad_med, precio_ref, rubro
               FROM insumos
              WHERE business_id = $1
                AND codigo_maxi IS NOT NULL
                AND codigo_maxi != ''
                AND origen = 'maxi'`,
            [businessId]
          );

          const maxiByNombre = new Map();
          for (const m of deMaxi) {
            if (!maxiByNombre.has(m.nombre_norm)) maxiByNombre.set(m.nombre_norm, m);
          }

          for (const manual of manuales) {
            const match = maxiByNombre.get(manual.nombre_norm);
            if (!match) continue;

            await reconcileClient.query(
              `UPDATE insumos SET
                 codigo_maxi      = $1,
                 origen           = 'maxi',
                 sin_equivalencia = FALSE,
                 unidad_med       = COALESCE(unidad_med, $2),
                 precio_ref       = COALESCE(precio_ref, $3),
                 rubro            = COALESCE(rubro, $4),
                 updated_at       = NOW()
               WHERE id = $5`,
              [match.codigo_maxi, match.unidad_med, match.precio_ref, match.rubro, manual.id]
            );

            await reconcileClient.query(
              `DELETE FROM insumos WHERE id = $1`,
              [match.id]
            );

            reconciled++;
          }
        }

        await reconcileClient.query('COMMIT');
      } catch (re) {
        await reconcileClient.query('ROLLBACK');
        console.warn('[upsertFromMaxi] reconciliación falló (no crítico):', re.message);
      } finally {
        reconcileClient.release();
      }
    } catch (re) {
      console.warn('[upsertFromMaxi] reconciliación error:', re.message);
    }

    return {
      inserted,
      updated: 0,        // siempre 0 porque la sync es aditiva
      unchanged,
      skipped,
      reconciled,
      changes: [],       // ya no detectamos cambios — nada se actualiza
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { upsertFromMaxi };