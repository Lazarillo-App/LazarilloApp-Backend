// Portado de lazarillo_gestion/lib/etl/normalizers/gestion_articulos.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../../db');

const { trim } = require('../helpers');

const { articuloRowSchema } = require('../schemas/articulos');
const { formatZodError } = require('../schemas/common');
const { insertChunkWithRowFallback } = require('../chunked-upsert');

const CHUNK_SIZE = 500;

async function normalizeArticulos(
  rows,
  db,
  ctx
) {
  // Maestro de MaxiRest: una lista por organización (la comparten sus negocios).
  const organizationId = ctx?.organizationId;
  if (organizationId == null) throw new Error("normalizeArticulos: falta organizationId en el contexto");
  const errors = [];
  let skipped = 0;

  // Dedup por CODIGO (last-wins) intencional para maestros.
  const parsedByCodigo = new Map();

  rows.forEach((r, idx) => {
    if (trim(r["CODIGO"]) == null) {
      skipped++;
      return;
    }
    const parsed = articuloRowSchema.safeParse(r);
    if (!parsed.success) {
      errors.push({ rowIndex: idx, rawCodigo: r["CODIGO"], message: formatZodError(parsed.error) });
      return;
    }
    parsedByCodigo.set(parsed.data.CODIGO, { data: parsed.data, idx });
  });

  const deduped = Array.from(parsedByCodigo.values());

  const allCodigos = deduped.map((d) => d.data.CODIGO);
  const existingSet = new Set(
    (await db.many(sql`SELECT codigo FROM gestion_articulos WHERE organization_id = ${organizationId} AND codigo = ANY(${allCodigos})`))
      .map((x) => x.codigo)
  );

  let created = 0, updated = 0;

  for (let i = 0; i < deduped.length; i += CHUNK_SIZE) {
    const chunk = deduped.slice(i, i + CHUNK_SIZE);

    const chunkErrors = await insertChunkWithRowFallback(
      db,
      chunk,
      (rowsToInsert) => {
        const values = rowsToInsert.map(({ data }) => {
          const codRua = data.COD_RUA != null && data.COD_RUA > 0 ? String(data.COD_RUA) : null;
          const codSua = data.COD_SUA != null && data.COD_SUA > 0 ? String(data.COD_SUA) : null;
          return sql`(
            ${organizationId},
            ${data.CODIGO},
            ${data.NOMBRE ?? "(sin nombre)"},
            ${data.PRECIO1}::numeric,
            ${data.PRECIO2}::numeric,
            ${data.PRECIO3}::numeric,
            ${data.PRECIO4}::numeric,
            ${codRua},
            ${codSua}
          )`;
        });

        return sql`
          INSERT INTO gestion_articulos (organization_id, codigo, nombre, precio1, precio2, precio3, precio4, "codRua", "codSua")
          VALUES ${sql.join(values)}
          ON CONFLICT (organization_id, codigo) DO UPDATE SET
            nombre   = EXCLUDED.nombre,
            precio1  = EXCLUDED.precio1,
            precio2  = EXCLUDED.precio2,
            precio3  = EXCLUDED.precio3,
            precio4  = EXCLUDED.precio4,
            "codRua" = EXCLUDED."codRua",
            "codSua" = EXCLUDED."codSua"
        `;
      },
      ({ data, idx }, err) => ({
        rowIndex: idx,
        rawCodigo: data.CODIGO,
        message: err instanceof Error ? err.message : String(err),
      }),
      (insertedRows) => {
        for (const { data } of insertedRows) {
          if (existingSet.has(data.CODIGO)) updated++; else created++;
        }
      }
    );
    errors.push(...chunkErrors);
  }

  return { created, updated, skipped, errors };
}

module.exports = { normalizeArticulos };
