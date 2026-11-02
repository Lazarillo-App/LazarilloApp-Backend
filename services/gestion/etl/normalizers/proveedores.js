// Portado de lazarillo_gestion/lib/etl/normalizers/gestion_proveedores.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../../db');

const { trim } = require('../helpers');

const { proveedorRowSchema } = require('../schemas/proveedores');
const { formatZodError } = require('../schemas/common');
const { insertChunkWithRowFallback } = require('../chunked-upsert');

const CHUNK_SIZE = 500;

async function normalizeProveedores(
  rows,
  db,
  ctx
) {
  // Maestro de MaxiRest: una lista por organización (la comparten sus negocios).
  const organizationId = ctx?.organizationId;
  if (organizationId == null) throw new Error("normalizeProveedores: falta organizationId en el contexto");
  const errors = [];
  let skipped = 0;

  // Dedup por CODIGO (last-wins) es intencional para maestros: una fila con el
  // mismo código en el mismo export es la misma entidad real, no una colisión
  // de hash entre dos entidades distintas (a diferencia de compras/ventas).
  const parsedByCodigo = new Map();

  rows.forEach((r, idx) => {
    if (trim(r["CODIGO"]) == null) {
      skipped++;
      return;
    }
    const parsed = proveedorRowSchema.safeParse(r);
    if (!parsed.success) {
      errors.push({ rowIndex: idx, rawCodigo: r["CODIGO"], message: formatZodError(parsed.error) });
      return;
    }
    parsedByCodigo.set(parsed.data.CODIGO, { data: parsed.data, idx });
  });

  const deduped = Array.from(parsedByCodigo.values());

  const allCodigos = deduped.map((d) => d.data.CODIGO);
  const existingSet = new Set(
    (await db.many(sql`SELECT codigo FROM gestion_proveedores WHERE organization_id = ${organizationId} AND codigo = ANY(${allCodigos})`))
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
            ${data.NOMBRE},
            ${data.RAZON},
            ${data.DIRECCION},
            ${data.LOCALIDAD},
            ${data.CONTACTO},
            ${data.TELEFONO},
            ${data.FAX},
            ${data.CELULAR},
            ${data.TIPO_IVA},
            ${data.CUIT},
            ${data.CBU},
            ${data.ALIASCBU},
            ${data.DIAS_VENC},
            ${data.IVA != null ? (data.IVA ? 1 : 0) : null},
            ${data.IVA_DIF != null ? (data.IVA_DIF ? 1 : 0) : null},
            ${data.E_MAIL},
            ${data.OBSERVAC},
            ${data.DETPERC}
          )`;
        });

        return sql`
          INSERT INTO gestion_proveedores (organization_id, 
            codigo, nombre, razon, direccion, localidad, contacto,
            telefono, fax, celular, "tipoIva", cuit, cbu, "aliasCbu",
            "diasVenc", iva, "ivaDif", email, observac, "detPerc"
          )
          VALUES ${sql.join(values)}
          ON CONFLICT (organization_id, codigo) DO UPDATE SET
            nombre     = EXCLUDED.nombre,
            razon      = EXCLUDED.razon,
            direccion  = EXCLUDED.direccion,
            localidad  = EXCLUDED.localidad,
            contacto   = EXCLUDED.contacto,
            telefono   = EXCLUDED.telefono,
            fax        = EXCLUDED.fax,
            celular    = EXCLUDED.celular,
            "tipoIva"  = EXCLUDED."tipoIva",
            cuit       = EXCLUDED.cuit,
            cbu        = EXCLUDED.cbu,
            "aliasCbu" = EXCLUDED."aliasCbu",
            "diasVenc" = EXCLUDED."diasVenc",
            iva        = EXCLUDED.iva,
            "ivaDif"   = EXCLUDED."ivaDif",
            email      = EXCLUDED.email,
            observac   = EXCLUDED.observac,
            "detPerc"  = EXCLUDED."detPerc"
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

module.exports = { normalizeProveedores };
