// repos/insumosRepo.js — VERSIÓN ADITIVA
// La sync de insumos NO actualiza datos existentes.
// Solo inserta nuevos. Esto protege ediciones manuales del usuario.

const pool = require('../config/db');

async function upsertFromMaxi(businessId, items = [], opts = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) cargar existentes en un solo tiro — con id + origen, no solo el código,
    // para poder distinguir "ya es un insumo real de Maxi" (no tocar, aditivo)
    // de "es un manual/csv precargado a propósito con este código, fusionar".
    const codes = items
      .map(it => String(it.codigo_maxi ?? it.codigo ?? it.codigoMaxi ?? '').trim())
      .filter(Boolean);

    const existingByCode = new Map(); // codigo_maxi -> { id, origen }
    if (codes.length) {
      const { rows } = await client.query(
        `SELECT id, codigo_maxi, origen
           FROM insumos
          WHERE business_id = $1
            AND codigo_maxi = ANY($2::text[])`,
        [businessId, codes]
      );
      for (const r of rows) existingByCode.set(String(r.codigo_maxi), { id: r.id, origen: r.origen });
    }

    let inserted = 0, unchanged = 0, skipped = 0, merged = 0;

    for (const it of items) {
      const codigo = String(it.codigo_maxi ?? it.codigo ?? it.codigoMaxi ?? '').trim();
      if (!codigo) { skipped++; continue; }

      const nombre = String(it.nombre ?? '').trim();
      if (!nombre) { skipped++; continue; }

      const precioRefIncoming = (it.precio_ref != null && Number(it.precio_ref) > 0)
        ? Number(it.precio_ref)
        : null;

      const existing = existingByCode.get(codigo);
      if (existing) {
        // El código ya existe. Si la fila es un manual/csv (el usuario cargó de
        // antemano el código que este insumo iba a tener en Maxi, precisamente
        // para que se fusionen al llegar) — convertirla en el insumo real, sin
        // pisar lo que el usuario ya haya cargado a mano (COALESCE conserva
        // unidad/precio/rubro existentes, igual que la reconciliación por
        // nombre de más abajo). Si ya era 'maxi', queda como estaba (aditivo).
        if (existing.origen === 'manual' || existing.origen === 'csv') {
          await client.query(
            `UPDATE insumos SET
               origen           = 'maxi',
               sin_equivalencia = FALSE,
               unidad_med       = COALESCE(unidad_med, $1),
               precio_ref       = COALESCE(precio_ref, $2),
               rubro            = COALESCE(rubro, $3),
               updated_at       = NOW()
             WHERE id = $4`,
            [it.unidad_med ?? null, precioRefIncoming, it.rubro ?? null, existing.id]
          );
          merged++;
        } else {
          unchanged++;
        }
        continue;
      }

      // Nuevo: insertar
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
      merged,            // fusionados por código (SKU precargado a mano)
      reconciled: reconciled + merged, // total fusionado (por código + por nombre)
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