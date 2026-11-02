// Portado de lazarillo_gestion/lib/etl/normalizers/rubros-concepto-caja.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../../db');

const { trim } = require('../helpers');

const { rubroConceptoCajaRowSchema } = require('../schemas/rubros-concepto-caja');
const { formatZodError } = require('../schemas/common');
const { insertChunkWithRowFallback } = require('../chunked-upsert');

const CHUNK_SIZE = 500;

async function normalizeRubrosConceptoCaja(
  rows,
  db,
  ctx
) {
  // Maestro de MaxiRest: una lista por organización (la comparten sus negocios).
  const organizationId = ctx?.organizationId;
  if (organizationId == null) throw new Error("normalizeRubrosConceptoCaja: falta organizationId en el contexto");
  const errors = [];
  let skipped = 0;

  // Deduplicar por codigo — last wins (intencional para maestros).
  const parsedByCodigo = new Map();

  rows.forEach((r, idx) => {
    if (trim(r["CODIGO"]) == null) {
      skipped++;
      return;
    }
    const parsed = rubroConceptoCajaRowSchema.safeParse(r);
    if (!parsed.success) {
      errors.push({ rowIndex: idx, rawCodigo: r["CODIGO"], message: formatZodError(parsed.error) });
      return;
    }
    parsedByCodigo.set(parsed.data.CODIGO, { data: parsed.data, idx });
  });

  const deduped = Array.from(parsedByCodigo.values());

  const allCodigos = deduped.map((d) => d.data.CODIGO);
  const existingSet = new Set(
    (await db.many(sql`SELECT codigo FROM gestion_rubros_concepto_caja WHERE organization_id = ${organizationId} AND codigo = ANY(${allCodigos})`))
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
          return sql`(
            ${organizationId},
            ${data.CODIGO},
            ${data.NOMBRE ?? "(sin nombre)"},
            ${data.CALC_RENT}
          )`;
        });

        return sql`
          INSERT INTO gestion_rubros_concepto_caja (organization_id, codigo, nombre, "calcRent")
          VALUES ${sql.join(values)}
          ON CONFLICT (organization_id, codigo) DO UPDATE SET
            nombre     = EXCLUDED.nombre,
            "calcRent" = EXCLUDED."calcRent"
            -- visibleEnDashboard: NO se sobreescribe (config manual del usuario)
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

module.exports = { normalizeRubrosConceptoCaja };
