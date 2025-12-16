const pool = require('../config/db');

async function upsertFromMaxi(businessId, items = []) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const it of items) {
      const codigo = String(it.codigo ?? it.codigoMaxi ?? '');
      if (!codigo) continue;

      const estado = it.discontinuado ? 'discontinuado' : 'activo';

      await client.query(
        `
        INSERT INTO insumos (
          business_id,
          codigo_maxi,
          nombre,
          unidad_med,
          precio_ref,
          rubro,
          origen,
          estado
        )
        VALUES ($1,$2,$3,$4,$5,$6,'maxi',$7)
        ON CONFLICT (business_id, codigo_maxi)
        DO UPDATE SET
          nombre = EXCLUDED.nombre,
          unidad_med = EXCLUDED.unidad_med,
          precio_ref = EXCLUDED.precio_ref,
          rubro = EXCLUDED.rubro,
          estado = EXCLUDED.estado,
          updated_at = NOW()
        `,
        [
          businessId,
          codigo,
          it.nombre?.trim() || '',
          it.unidad_med || null,
          it.precio_ref || null,
          it.rubro || null,
          estado,
        ]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { upsertFromMaxi };
