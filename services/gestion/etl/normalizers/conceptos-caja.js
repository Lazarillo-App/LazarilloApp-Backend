// Portado de lazarillo_gestion/lib/etl/normalizers/conceptos-caja.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../../db');

const { trim } = require('../helpers');

const { conceptoCajaRowSchema } = require('../schemas/conceptos-caja');
const { formatZodError } = require('../schemas/common');
const { insertChunkWithRowFallback } = require('../chunked-upsert');

const CHUNK_SIZE = 500;

async function normalizeConceptosCaja(
  rows,
  db,
  ctx
) {
  // Maestro de MaxiRest: una lista por organización (la comparten sus negocios).
  const organizationId = ctx?.organizationId;
  if (organizationId == null) throw new Error("normalizeConceptosCaja: falta organizationId en el contexto");
  const errors = [];
  let skipped = 0;

  const parsedByCodigo = new Map();

  rows.forEach((r, idx) => {
    if (trim(r["CODIGO"]) == null) {
      skipped++;
      return;
    }
    const parsed = conceptoCajaRowSchema.safeParse(r);
    if (!parsed.success) {
      errors.push({ rowIndex: idx, rawCodigo: r["CODIGO"], message: formatZodError(parsed.error) });
      return;
    }
    parsedByCodigo.set(parsed.data.CODIGO, { data: parsed.data, idx });
  });

  const deduped = Array.from(parsedByCodigo.values());

  const allCodigos = deduped.map((d) => d.data.CODIGO);
  const existingSet = new Set(
    (await db.many(sql`SELECT codigo FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ANY(${allCodigos})`))
      .map((x) => x.codigo)
  );

  const allCodRga = [...new Set(
    deduped.map((d) => (d.data.COD_RGA != null && d.data.COD_RGA > 0 ? String(d.data.COD_RGA) : null)).filter((v) => v != null)
  )];
  const validRgaSet = new Set(
    (await db.many(sql`SELECT codigo FROM gestion_rubros_concepto_caja WHERE organization_id = ${organizationId} AND codigo = ANY(${allCodRga})`))
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
          const rawRga = data.COD_RGA != null && data.COD_RGA > 0 ? String(data.COD_RGA) : null;
          const codRga = rawRga != null && (validRgaSet.size === 0 || validRgaSet.has(rawRga)) ? rawRga : null;
          const nombre = data.NOMBRE ?? "(sin nombre)";
          return sql`(
            ${organizationId},
            ${data.CODIGO},
            ${nombre},
            ${data.TIPO},
            ${data.COD_IMP},
            ${codRga},
            ${nombre},
            ${data.TIPO},
            ${codRga}
          )`;
        });

        // Lo de MaxiRest queda siempre en *Maxirest (el original, en gris en Conceptos). Si el
        // concepto se editó en Lazarillo (Diego 29/10/2026), nombre / tipo / rubro no se pisan.
        return sql`
          INSERT INTO gestion_conceptos_caja (organization_id, codigo, nombre, tipo, "codImp", "codRga", "nombreMaxirest", "tipoMaxirest", "codRgaMaxirest")
          VALUES ${sql.join(values)}
          ON CONFLICT (organization_id, codigo) DO UPDATE SET
            nombre    = CASE WHEN gestion_conceptos_caja."editadoEnLazarillo" THEN gestion_conceptos_caja.nombre ELSE EXCLUDED.nombre END,
            tipo      = CASE WHEN gestion_conceptos_caja."editadoEnLazarillo" THEN gestion_conceptos_caja.tipo ELSE EXCLUDED.tipo END,
            "codImp"  = EXCLUDED."codImp",
            "codRga"  = CASE WHEN gestion_conceptos_caja."editadoEnLazarillo" THEN gestion_conceptos_caja."codRga" ELSE EXCLUDED."codRga" END,
            "nombreMaxirest" = EXCLUDED."nombreMaxirest",
            "tipoMaxirest"   = EXCLUDED."tipoMaxirest",
            "codRgaMaxirest" = EXCLUDED."codRgaMaxirest"
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

module.exports = { normalizeConceptosCaja };
