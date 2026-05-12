const pool = require('../config/db');

const AUTO_FIELDS = new Set(['nombre', 'unidad_med', 'rubro']);
const REVIEW_FIELDS = new Set(['precio_ref']); // ajustable

function isDiff(a, b) {
  // normaliza null/undefined y números
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (typeof na === 'number' || typeof nb === 'number') {
    const fa = na == null ? null : Number(na);
    const fb = nb == null ? null : Number(nb);
    return fa !== fb;
  }
  return String(na ?? '') !== String(nb ?? '');
}

function diffFields(prev, next) {
  const out = [];
  const fields = ['nombre', 'unidad_med', 'rubro', 'precio_ref'];

  for (const f of fields) {
    if (isDiff(prev?.[f], next?.[f])) {
      out.push({
        field: f,
        before: prev?.[f] ?? null,
        after: next?.[f] ?? null,
        policy: REVIEW_FIELDS.has(f) ? 'review' : 'auto',
      });
    }
  }
  return out;
}

async function upsertFromMaxi(businessId, items = [], opts = {}) {
  const { useIncomingEstado = true } = opts;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) cargar existentes en un solo tiro
    const codes = items
      .map(it => String(it.codigo_maxi ?? it.codigo ?? it.codigoMaxi ?? '').trim())
      .filter(Boolean);

    const existingMap = new Map();
    if (codes.length) {
      const { rows } = await client.query(
        `
        SELECT id, codigo_maxi, nombre, unidad_med, rubro, precio_ref, estado
        FROM insumos
        WHERE business_id = $1
          AND codigo_maxi = ANY($2::text[])
        `,
        [businessId, codes]
      );
      for (const r of rows) existingMap.set(String(r.codigo_maxi), r);
    }

    let inserted = 0, updated = 0, unchanged = 0, skipped = 0;

    // cambios NO agrupados (uno por insumo, con campos)
    const changes = [];

    for (const it of items) {
      const codigo = String(it.codigo_maxi ?? it.codigo ?? it.codigoMaxi ?? '').trim();
      if (!codigo) { skipped++; continue; }

      const nombre = String(it.nombre ?? '').trim();
      if (!nombre) { skipped++; continue; }

      const prev = existingMap.get(codigo) || null;

      // estado: si viene de normalizador y lo respetamos
      const estado = useIncomingEstado ? (it.estado ?? 'activo') : 'activo';

      // armamos el “next” para diff
      // precio_ref: si Maxi manda 0/null, preservar el existente para no disparar diff
      const precioRefIncoming = (it.precio_ref != null && Number(it.precio_ref) > 0)
        ? Number(it.precio_ref)
        : null;
      const next = {
        nombre,
        unidad_med: it.unidad_med ?? null,
        precio_ref: precioRefIncoming ?? (prev?.precio_ref ?? null),
        rubro: it.rubro ?? null,
        estado,
      };

      const diffs = diffFields(prev, next);

      // Si existía y no cambió nada relevante => unchanged (pero igual podrías tocar updated_at; no lo hagas)
      if (prev && diffs.length === 0 && String(prev.estado ?? 'activo') === String(estado)) {
        unchanged++;
        continue;
      }

      // 2) upsert (solo una query por insumo, ok para 2500)
      const r = await client.query(
        `
        INSERT INTO insumos (
          business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, estado
        )
        VALUES ($1,$2,$3,$4,$5,$6,'maxi',$7)
        ON CONFLICT (business_id, codigo_maxi)
        DO UPDATE SET
          nombre = EXCLUDED.nombre,
          unidad_med = EXCLUDED.unidad_med,
          -- Solo actualizar precio_ref si Maxi trae un valor válido > 0
          -- Si Maxi manda 0 o null, preservar el precio que ya tenemos (de compras importadas)
          precio_ref = CASE
            WHEN EXCLUDED.precio_ref IS NOT NULL AND EXCLUDED.precio_ref > 0
            THEN EXCLUDED.precio_ref
            ELSE insumos.precio_ref
          END,
          rubro = EXCLUDED.rubro,
          estado = EXCLUDED.estado,
          origen = 'maxi',
          updated_at = NOW()
        RETURNING id, (xmax = 0) AS inserted
        `,
        [
          businessId,
          codigo,
          nombre,
          next.unidad_med,
          next.precio_ref,
          next.rubro,
          estado,
        ]
      );

      const insumoId = r.rows?.[0]?.id;
      const wasInserted = Boolean(r.rows?.[0]?.inserted);

      if (wasInserted) inserted++;
      else updated++;

      // 3) registrar cambios (NO agrupado)
      if (diffs.length) {
        changes.push({
          insumo_id: insumoId,
          codigo_maxi: codigo,
          diffs,
        });
      }
    }

    await client.query('COMMIT');

    // ── Reconciliación post-sync ──────────────────────────────────────
    // Buscar insumos manuales sin codigo_maxi que coincidan por nombre
    // con alguno de los insumos que llegaron de Maxi en este batch.
    // Si hay match: asignar el codigo_maxi, actualizar origen a 'maxi',
    // limpiar sin_equivalencia.
    let reconciled = 0;
    try {
      const reconcileClient = await pool.connect();
      try {
        await reconcileClient.query('BEGIN');

        // Insumos manuales sin código de este negocio
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
          // Insumos que llegaron de Maxi en este sync (tienen codigo_maxi)
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

          // Índice por nombre normalizado
          const maxiByNombre = new Map();
          for (const m of deMaxi) {
            if (!maxiByNombre.has(m.nombre_norm)) maxiByNombre.set(m.nombre_norm, m);
          }

          for (const manual of manuales) {
            const match = maxiByNombre.get(manual.nombre_norm);
            if (!match) continue;

            // Actualizar el insumo manual con el código de Maxi
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

            // Eliminar el duplicado de Maxi si quedó uno
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
      updated,
      unchanged,
      skipped,
      reconciled,
      changes,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { upsertFromMaxi };