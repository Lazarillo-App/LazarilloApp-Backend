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

    return {
      inserted,
      updated,
      unchanged,
      skipped,
      changes, // <- clave para notificar sin agrupar
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { upsertFromMaxi };