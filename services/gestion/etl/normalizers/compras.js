// Portado de lazarillo_gestion/lib/etl/normalizers/compras.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../../db');

const { trim, toDecimalStr, excelDateToISO, filaCruda } = require('../helpers');
const { linkDetalleComprasByComprobante } = require('../normalizer-utils');
const { compraRowSchema } = require('../schemas/compras');
const { formatZodError } = require('../schemas/common');
const { parseComprobanteFromDetalle, computeCompraRowId, compraIdentityFromRawRow, compraIdentityFromDbRecord, computeCompraAnchor, pickReconciliationCandidate, esReconciliacionSegura, esRenombreDeConcepto } = require('./compra-identity');
const { camposErpCambiaron } = require('./compras-diff');
const { canonicalDecimal } = require('./compra-identity');
const { comprobantesDeLazarillo, claveSalteo } = require('../../facturas/saltear-lazarillo');
const { resolveProveedorId } = require('./proveedor-match');
const { normalizarProveedorTexto } = require('../../text-normalize');
const { insertChunkWithRowFallback } = require('../chunked-upsert');
const { normalizarSignoNotaCredito } = require('./nota-credito');

// Filas por chunk de INSERT ... ON CONFLICT. Con ~18 columnas: ~9k params/chunk < 65535.
const CHUNK_SIZE = 500;

// Anclas distintas por consulta de reconciliación (OR). 5 columnas por ancla
// + el notIn de rowIdsEnArchivo (todo el archivo, unos miles) → bien por
// debajo del límite de 65535 parámetros de Postgres.
const ANCHOR_BATCH = 200;

// Clave de agrupación en memoria para repartir los candidatos devueltos por la
// consulta en lote entre las filas nuevas que comparten ancla. Usa los MISMOS
// cinco campos que computeCompraAnchor, canonizados igual de ambos lados
// (fecha ISO, importe vía canonicalDecimal) para que la fila cruda y el
// registro persistido produzcan la misma clave.
function claveAncla(a) {
  return [a.codCga, a.fechaISO, a.codigo, a.concepto, a.importe].map((v) => v ?? "").join("|");
}

function anclaDesdeCompraExistente(c) {
  return {
    codCga: c.codCga,
    fechaISO: c.fecha ? c.fecha.toISOString().slice(0, 10) : null,
    codigo: c.codigo,
    concepto: c.concepto,
    importe: canonicalDecimal(c.importe != null ? c.importe.toString() : null),
  };
}

function formatFechaDisplay(val) {
  const iso = excelDateToISO(val);
  if (!iso) return undefined;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Identidad partida (con/sin comprobante) delegada a compra-identity.ts — ver ese
// módulo para el porqué. Opera SIEMPRE sobre la fila cruda (ETLRow), nunca sobre
// datos ya coercionados por Zod, para que el resultado sea reproducible por el
// script de migración de rowId (que reconstruye la misma identidad desde la
// compra ya persistida, no desde el Excel original).
function makeRowId(r) {
  return computeCompraRowId(compraIdentityFromRawRow(r));
}

function erpFieldsDesdeDatoParseado(data) {
  return {
    codCga: data.COD_CGA,
    concepto: data.CONCEPTO,
    fecha: data.FECHA,
    codigo: data.CODIGO,
    proveedor: data.PROVEEDOR,
    detalle: data.DETALLE,
    observac: data.OBSERVAC,
    importe: canonicalDecimal(data.IMPORTE?.toString() ?? null),
    impInt: canonicalDecimal(data.IMP_INT?.toString() ?? null),
    imputac: data.IMPUTAC,
    per1: canonicalDecimal(data.PER1?.toString() ?? null),
    per2: canonicalDecimal(data.PER2?.toString() ?? null),
    per3: canonicalDecimal(data.PER3?.toString() ?? null),
  };
}

function erpFieldsDesdeCompraExistente(row) {
  return {
    codCga: row.codCga,
    concepto: row.concepto,
    fecha: row.fecha,
    codigo: row.codigo,
    proveedor: row.proveedor,
    detalle: row.detalle,
    observac: row.observac,
    importe: canonicalDecimal(row.importe != null ? row.importe.toString() : null),
    impInt: canonicalDecimal(row.impInt != null ? row.impInt.toString() : null),
    imputac: row.imputac,
    per1: canonicalDecimal(row.per1 != null ? row.per1.toString() : null),
    per2: canonicalDecimal(row.per2 != null ? row.per2.toString() : null),
    per3: canonicalDecimal(row.per3 != null ? row.per3.toString() : null),
  };
}

async function normalizeCompras(
  rows,
  db,
  ctx
) {
  const organizationId = ctx?.organizationId;
  if (ctx?.businessId == null || organizationId == null) throw new Error("normalizeCompras: falta businessId/organizationId en el contexto");
  const skippedRows = [];
  const errors = [];

  // 1) Filtro de presencia: identificadores realmente ausentes → sin_datos.
  //    Endurecido con trim() en COD_CGA para capturar strings vacíos/whitespace,
  //    no sólo null (gap que existía en el chequeo anterior).
  // 2) Zod: fila con identificadores presentes pero algún campo (incluida FECHA
  //    corrupta, no sólo ausente) que no parsea → errors, no null en silencio.

  const parsedRows = [];

  rows.forEach((r, idx) => {
    if (trim(r["COD_CGA"]) == null || r["FECHA"] == null) {
      skippedRows.push({
        fecha: formatFechaDisplay(r["FECHA"]),
        concepto: trim(r["CONCEPTO"]) ?? undefined,
        importe: toDecimalStr(r["IMPORTE"]) ?? undefined,
        proveedor: trim(r["PROVEEDOR"]) ?? undefined,
        motivo: "sin_datos",
        ...filaCruda(r, idx),
      });
      return;
    }
    const parsed = compraRowSchema.safeParse(r);
    if (!parsed.success) {
      errors.push({ rowIndex: idx, rawCodigo: r["CODIGO"], message: formatZodError(parsed.error), ...filaCruda(r, idx) });
      return;
    }
    // El signo se normaliza DESPUÉS de calcular la identidad: rowId y ancla salen
    // de la fila cruda, así que invertir el importe no cambia a qué registro
    // existente apunta una NC al reimportar.
    const data = { ...parsed.data, IMPORTE: normalizarSignoNotaCredito(parsed.data.DETALLE, parsed.data.IMPORTE) };
    parsedRows.push({ rowId: makeRowId(r), row: r, data, idx });
  });

  // Dedup por rowId — last-wins, pero ahora la fila que se pisa se reporta en
  // skippedRows con motivo "duplicado" en vez de perderse en silencio (antes
  // era exactamente el patrón que causó la pérdida del registro de $2.6M).
  const rowIdMap = new Map();
  for (const pr of parsedRows) {
    const prev = rowIdMap.get(pr.rowId);
    if (prev) {
      skippedRows.push({
        fecha: formatFechaDisplay(prev.row["FECHA"]),
        concepto: trim(prev.row["CONCEPTO"]) ?? undefined,
        importe: toDecimalStr(prev.row["IMPORTE"]) ?? undefined,
        proveedor: trim(prev.row["PROVEEDOR"]) ?? undefined,
        motivo: "duplicado",
        ...filaCruda(prev.row, prev.idx),
        original: filaCruda(pr.row, pr.idx),
      });
    }
    rowIdMap.set(pr.rowId, pr);
  }
  // Comprobantes ya cargados en Lazarillo: se saltean (gana esa versión, no se duplica).
  const enLazarillo = await comprobantesDeLazarillo(
    db, "compras", ctx,
    [...rowIdMap.values()].map((pr) => parseComprobanteFromDetalle(pr.row["DETALLE"]) ?? ""),
  );
  const filtered = Array.from(rowIdMap.values()).filter((pr) => {
    const cpb = parseComprobanteFromDetalle(pr.row["DETALLE"]);
    if (!cpb || !enLazarillo.has(claveSalteo(cpb, pr.data.CODIGO, excelDateToISO(pr.row["FECHA"])))) return true;
    skippedRows.push({
      fecha: formatFechaDisplay(pr.row["FECHA"]),
      concepto: trim(pr.row["CONCEPTO"]) ?? undefined,
      importe: toDecimalStr(pr.row["IMPORTE"]) ?? undefined,
      proveedor: trim(pr.row["PROVEEDOR"]) ?? undefined,
      motivo: "cargada_en_lazarillo",
      ...filaCruda(pr.row, pr.idx),
    });
    return false;
  });
  const skipped = skippedRows.length;

  // Todos los rowId que este archivo va a computar, de punta a punta — no solo
  // los del chunk que se esté procesando. La búsqueda de candidatos de
  // reconciliación (más abajo) tiene que excluir este conjunto COMPLETO, no
  // solo el del chunk actual: si no, una fila de un chunk posterior que
  // todavía no se procesó (pero cuyo hash SÍ va a aparecer en este mismo
  // archivo) puede ser "robada" por error como huérfana de otra fila de un
  // chunk anterior que comparte ancla — y cuando esa fila posterior por fin
  // se procesa en su propio chunk, ya no encuentra su lugar (fue renombrado)
  // y termina insertándose de nuevo como duplicado. Ver hallazgo Important
  // #3 de la revisión final de rama, 29-sep-2026.
  const rowIdsEnArchivo = new Set(filtered.map((pr) => pr.rowId));

  // Lookup tables — una sola query cada una para todo el archivo
  const codigosProv = [...new Set(filtered.map((pr) => pr.data.CODIGO).filter((v) => v != null))];
  const provMap = new Map(
    (await db.many(sql`
      SELECT id, codigo, nombre, razon FROM gestion_proveedores
       WHERE organization_id = ${organizationId} AND codigo = ANY(${codigosProv})`)).map((p) => [p.codigo, { id: p.id, nombre: p.nombre, razon: p.razon }])
  );

  const codigosConcepto = [...new Set(filtered.map((pr) => pr.data.COD_CGA).filter((v) => v != null))];
  const conceptoSet = new Set(
    (await db.many(sql`
      SELECT codigo FROM gestion_conceptos_caja
       WHERE organization_id = ${organizationId} AND codigo = ANY(${codigosConcepto})`)).map((c) => c.codigo)
  );

  // En Lazarillo el "local" de gestion es negocio + sucursal. La sucursal se usa
  // como clave del chequeo "localId distinto" de esReconciliacionSegura (nunca
  // fusionar compras de sucursales distintas: son otra PC de MaxiRest).
  const businessId = ctx.businessId;
  const branchId = ctx.branchId ?? null;
  const claveSucursal = (b) => String(b ?? "principal");
  const localId = claveSucursal(branchId);

  let created = 0;
  let updated = 0;
  const comprasDistribuidasModificadas = [];
  const comprasReconciliadas = [];
  const reconciliacionesAmbiguas = [];

  for (let i = 0; i < filtered.length; i += CHUNK_SIZE) {
    const chunk = filtered.slice(i, i + CHUNK_SIZE);
    const chunkRowIds = chunk.map((pr) => pr.rowId);

    const existingRows = await db.many(sql`
      SELECT "rowId", "esDistribuido", "codCga", concepto, fecha, codigo, proveedor,
               detalle, observac, importe, "impInt", imputac, per1, per2, per3,
               comprobante, branch_id
        FROM gestion_compras
       WHERE business_id = ${businessId} AND "rowId" = ANY(${chunkRowIds})`);
    const existingMap = new Map(existingRows.map((r) => [r.rowId, r]));

    // Reconciliación: sigue con manejo de errores a nivel de todo el chunk (sin
    // cambios de comportamiento respecto a antes — si algo de acá tira, el
    // chunk entero se reporta como error y ni siquiera llega al INSERT de
    // abajo). Solo el INSERT gana aislamiento fila por fila más abajo.
    const reconciliacionPorRowId = new Map

     ();
    try {
      // 1) Ancla de cada fila NUEVA del chunk (sin match exacto por hash).
      //    El ancla busca contra lo persistido, donde una NC ya está en negativo:
      //    con el importe crudo (positivo) nunca encontraría su fila vieja y el
      //    ERP editando su OBSERVAC la duplicaría en vez de reconciliarla.
      const filasNuevas = [];
      for (const pr of chunk) {
        if (existingMap.has(pr.rowId)) continue;
        const identidad = compraIdentityFromRawRow(pr.row);
        const anchor = computeCompraAnchor({
          ...identidad,
          importe: canonicalDecimal(normalizarSignoNotaCredito(identidad.detalle, identidad.importe)),
        });
        if (anchor.importe == null || anchor.fechaISO == null) continue;
        filasNuevas.push({ pr, identidad, anchor, clave: claveAncla(anchor) });
      }

      // 2) Candidatos de reconciliación para TODAS las anclas del chunk en
      //    pocas consultas (OR de anclas distintas, en lotes de ANCHOR_BATCH),
      //    en vez de una consulta por fila nueva. Con cientos de filas nuevas
      //    (p. ej. un mes nuevo del informe 14, o las percepciones por
      //    comprobante que agregó gen14) la versión fila-por-fila superaba el
      //    maxDuration de Vercel (60 s en plan Hobby) y el import quedaba a
      //    medias — hallazgo 21-oct-2026, archivo 14 BAR_2026.
      //    La búsqueda sigue excluyendo TODOS los rowId del archivo (ver
      //    rowIdsEnArchivo) y los resultados se reparten en memoria por ancla,
      //    así que cada fila ve exactamente los mismos candidatos que antes.
      const anclasDistintas = new Map();
      for (const f of filasNuevas) anclasDistintas.set(f.clave, f.anchor);
      const candidatosPorAncla = new Map();
      const anclas = [...anclasDistintas.values()];
      for (let j = 0; j < anclas.length; j += ANCHOR_BATCH) {
        const lote = anclas.slice(j, j + ANCHOR_BATCH);
        // Solo dentro del negocio: una compra no se mueve de un negocio a otro.
        // IS NOT DISTINCT FROM = la igualdad de Prisma (un null del ancla busca IS NULL).
        const encontrados = await db.many(sql`
          SELECT "rowId", "esDistribuido", "codCga", concepto, fecha, codigo, proveedor,
                   detalle, observac, importe, "impInt", imputac, per1, per2, per3,
                   comprobante, branch_id
            FROM gestion_compras
           WHERE business_id = ${businessId}
             -- Excluye TODOS los rowId que este archivo va a computar, no solo
             -- los del chunk actual — ver comentario en rowIdsEnArchivo arriba.
             AND NOT ("rowId" = ANY(${[...rowIdsEnArchivo]}))
             -- Nunca reconciliar contra facturas cargadas en el Panel (revisión 27/10/2026).
             AND (origen IS NULL OR origen NOT IN ('lazarillo', 'sin-concepto')) -- ni facturas del Panel ni las de render/sin-concepto.js
             AND (${sql.join(lote.map((a) => sql`(
               "codCga" IS NOT DISTINCT FROM ${a.codCga}
               AND fecha = ${a.fechaISO}::timestamp
               AND codigo IS NOT DISTINCT FROM ${a.codigo}
               AND concepto IS NOT DISTINCT FROM ${a.concepto}
               AND importe = ${a.importe}::numeric
             )`), " OR ")})`);
        for (const c of encontrados) {
          const clave = claveAncla(anclaDesdeCompraExistente(c));
          const lista = candidatosPorAncla.get(clave);
          if (lista) lista.push(c); else candidatosPorAncla.set(clave, [c]);
        }
      }

      // 3) Resolución fila por fila, en el mismo orden y con la misma regla
      //    que antes. Un candidato ya fusionado con una fila anterior del
      //    chunk no se vuelve a ofrecer (antes quedaba excluido solo porque su
      //    rowId renombrado ya pertenecía a rowIdsEnArchivo).
      const candidatosUsados = new Set();
      for (const { pr, identidad, clave } of filasNuevas) {
        const candidatos = (candidatosPorAncla.get(clave) ?? []).filter((c) => !candidatosUsados.has(c.rowId));
        if (candidatos.length === 0) continue;

        const elegido = pickReconciliationCandidate(candidatos);
        // Exactamente 1 candidato no alcanza: además tiene que ser seguro
        // fusionarlo (mismo predicado que usa el script de limpieza
        // retroactiva — ver compra-identity.ts, esReconciliacionSegura). Si
        // no lo es, se trata igual que 2+ candidatos: ambiguo, se reporta en
        // vez de fusionarse en silencio (hallazgo Important #4 de la
        // revisión final de rama, 29-sep-2026).
        // Nota: elegido.comprobante pasa por compraIdentityFromDbRecord (no
        // se usa crudo) para aplicar la MISMA regla de "Tic no es
        // comprobante confiable" que ya se le aplicó a `identidad` del lado
        // de la fila nueva — sin esto, un Tic reutilizado del lado del
        // candidato se comparaba crudo contra un lado ya filtrado,
        // asimetría que podía dejar pasar (o bloquear) casos por el motivo
        // equivocado.
        const identidadCandidato = elegido ? compraIdentityFromDbRecord(elegido) : null;
        const esSegura = elegido != null && identidadCandidato != null && esReconciliacionSegura(
          { comprobante: identidad.comprobante, observac: identidad.observacNormalizado, localId },
          { comprobante: identidadCandidato.comprobante, observac: identidadCandidato.observacNormalizado, localId: claveSucursal(elegido.branch_id) }
        ).segura;

        if (elegido && esSegura) {
          // Sin transacción: si el INSERT de esta fila falla más abajo (fallback
          // fila por fila), este rename ya quedó commiteado y no se reporta en
          // comprasReconciliadas — se autocorrige en el próximo reimport (el hash
          // vuelve a encontrarla), pero no queda visible en el reporte de este import.
          await db.execute(sql`UPDATE gestion_compras SET "rowId" = ${pr.rowId} WHERE business_id = ${businessId} AND "rowId" = ${elegido.rowId}`);
          candidatosUsados.add(elegido.rowId);
          reconciliacionPorRowId.set(pr.rowId, { tipo: "reconciliada", rowIdViejo: elegido.rowId });
          existingMap.set(pr.rowId, elegido);
        } else {
          reconciliacionPorRowId.set(pr.rowId, { tipo: "ambigua", candidatos: candidatos.map((c) => c.rowId) });
        }
      }

      // 4) Renombre de concepto en MaxiRest: filas nuevas sin candidato por
      //    ancla (el ancla incluye el nombre del concepto) que coinciden en
      //    todo lo demás —mismo PDV, código de concepto, fecha, código,
      //    importe, comprobante y observación idéntica— con UNA sola compra
      //    existente que tiene otro nombre de concepto. Es la misma compra:
      //    se renombra su rowId y conserva ediciones y aperturas (Diego,
      //    26/10/2026: "nunca se pueden duplicar registros").
      const sinCandidato = filasNuevas.filter(
        (f) => !reconciliacionPorRowId.has(f.pr.rowId) && !!f.identidad.observacNormalizado
      );
      for (let j = 0; j < sinCandidato.length; j += ANCHOR_BATCH) {
        const lote = sinCandidato.slice(j, j + ANCHOR_BATCH);
        // "Mismo PDV" de gestion = mismo negocio y misma sucursal.
        const encontrados = await db.many(sql`
          SELECT "rowId", "esDistribuido", "codCga", concepto, fecha, codigo, proveedor,
                   detalle, observac, importe, "impInt", imputac, per1, per2, per3,
                   comprobante, branch_id
            FROM gestion_compras
           WHERE business_id = ${businessId}
             AND branch_id IS NOT DISTINCT FROM ${branchId}::bigint
             AND NOT ("rowId" = ANY(${[...rowIdsEnArchivo]}))
             AND (origen IS NULL OR origen NOT IN ('lazarillo', 'sin-concepto')) -- ni facturas del Panel ni las de render/sin-concepto.js
             AND (${sql.join(lote.map(({ anchor, identidad }) => sql`(
               "codCga" IS NOT DISTINCT FROM ${anchor.codCga}
               AND fecha = ${anchor.fechaISO}::timestamp
               AND codigo IS NOT DISTINCT FROM ${anchor.codigo}
               AND importe = ${anchor.importe}::numeric
               AND observac IS NOT DISTINCT FROM ${identidad.observacNormalizado}
               AND NOT (concepto = ${anchor.concepto ?? ""})
             )`), " OR ")})`);
        for (const { pr, identidad, anchor } of lote) {
          const nueva = { ...anchor, comprobante: identidad.comprobante, observac: identidad.observacNormalizado };
          const candidatos = encontrados.filter((c) => {
            if (candidatosUsados.has(c.rowId)) return false;
            const id = compraIdentityFromDbRecord(c);
            return esRenombreDeConcepto(nueva, {
              codCga: id.codCga, fechaISO: id.fechaISO, codigo: id.codigo, concepto: id.concepto,
              comprobante: id.comprobante, observac: id.observacNormalizado, importe: id.importe,
            });
          });
          if (candidatos.length !== 1) continue;
          const elegido = candidatos[0];
          await db.execute(sql`UPDATE gestion_compras SET "rowId" = ${pr.rowId} WHERE business_id = ${businessId} AND "rowId" = ${elegido.rowId}`);
          candidatosUsados.add(elegido.rowId);
          reconciliacionPorRowId.set(pr.rowId, { tipo: "reconciliada", rowIdViejo: elegido.rowId });
          existingMap.set(pr.rowId, elegido);
        }
      }
    } catch (err) {
      errors.push({
        rowIndex: i,
        rawCodigo: chunk[0]?.data.CODIGO,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const chunkErrors = await insertChunkWithRowFallback(
      db,
      chunk,
      (rowsToInsert) => {
        const rowValues = rowsToInsert.map(({ rowId, row, data }) => {
          const proveedorId = resolveProveedorId(data.CODIGO, data.PROVEEDOR, provMap);
          const conceptoCodigo = conceptoSet.has(data.COD_CGA) ? data.COD_CGA : null;
          // Solo se calcula cuando NO hay proveedorId real — es la dimensión de
          // matching que usa el motor de Apertura para nivel "proveedor" cuando
          // el ERP no linkeó un proveedor real (ver lib/apertura/motor.ts).
          const proveedorTextoNormalizado = proveedorId == null
            ? normalizarProveedorTexto(data.PROVEEDOR)
            : null;

          return sql`(
            ${rowId},
            ${data.COD_CGA},
            ${data.CONCEPTO},
            ${parseComprobanteFromDetalle(row["DETALLE"])},
            ${data.FECHA},
            ${data.CODIGO},
            ${data.PROVEEDOR},
            ${data.DETALLE},
            ${data.OBSERVAC},
            ${data.IMPORTE}::numeric,
            ${data.IMPORTE}::numeric,
            ${data.IMP_INT}::numeric,
            ${data.IMPUTAC},
            ${data.PER1}::numeric,
            ${data.PER2}::numeric,
            ${data.PER3}::numeric,
            ${proveedorId}::integer,
            ${conceptoCodigo},
            ${businessId}::bigint,
            ${branchId}::bigint,
            ${proveedorTextoNormalizado},
            ${data.FECHA_PAGO ?? null}::timestamp,
            ${data.CAJA_PAGO},
            ${data.PERIODO ?? null}::timestamp
          )`;
        });

        return sql`
          INSERT INTO gestion_compras (
            "rowId", "codCga", concepto, comprobante, fecha, codigo, proveedor, detalle, observac,
            importe, "importeTrabajado", "impInt", imputac, per1, per2, per3,
            "proveedorId", "conceptoCodigo", business_id, branch_id, "proveedorTextoNormalizado",
            "fechaPago", "cajaPago", periodo
          )
          VALUES ${sql.join(rowValues)}
          ON CONFLICT (business_id, "rowId") DO UPDATE SET
            "codCga"           = EXCLUDED."codCga",
            concepto           = EXCLUDED.concepto,
            comprobante        = EXCLUDED.comprobante,
            fecha              = EXCLUDED.fecha,
            codigo             = EXCLUDED.codigo,
            proveedor          = EXCLUDED.proveedor,
            detalle            = EXCLUDED.detalle,
            observac           = EXCLUDED.observac,
            importe            = EXCLUDED.importe,
            "importeTrabajado" = EXCLUDED."importeTrabajado",
            "impInt"           = EXCLUDED."impInt",
            imputac            = EXCLUDED.imputac,
            per1               = EXCLUDED.per1,
            per2               = EXCLUDED.per2,
            per3               = EXCLUDED.per3,
            -- COALESCE: un 14 viejo (sin estas columnas) no borra lo que trajo uno nuevo.
            "fechaPago"        = COALESCE(EXCLUDED."fechaPago", gestion_compras."fechaPago"),
            "cajaPago"         = COALESCE(EXCLUDED."cajaPago", gestion_compras."cajaPago"),
            periodo            = COALESCE(EXCLUDED.periodo, gestion_compras.periodo),
            "proveedorId"      = EXCLUDED."proveedorId",
            "conceptoCodigo"   = EXCLUDED."conceptoCodigo",
            "proveedorTextoNormalizado" = EXCLUDED."proveedorTextoNormalizado"
            -- branch_id NO se toca: en gestion el COALESCE reclamaba filas sin local
            -- (localId = null); en Lazarillo branch_id null es el negocio principal,
            -- así que "adoptar" la sucursal nueva movería compras de una sucursal a otra.
            -- importeManual, fechaManual, conceptoCodigoManual: NO se sobreescriben (overrides manuales)
        `;
      },
      ({ idx, row, data }, err) => ({
        rowIndex: idx,
        rawCodigo: data.CODIGO,
        message: err instanceof Error ? err.message : String(err),
        ...filaCruda(row, idx),
      }),
      (insertedRows) => {
        for (const { rowId, data } of insertedRows) {
          const oldRow = existingMap.get(rowId);
          if (oldRow) updated++; else created++;
          if (oldRow?.esDistribuido && camposErpCambiaron(erpFieldsDesdeCompraExistente(oldRow), erpFieldsDesdeDatoParseado(data))) {
            comprasDistribuidasModificadas.push(rowId);
          }
          const recon = reconciliacionPorRowId.get(rowId);
          if (recon?.tipo === "reconciliada") {
            comprasReconciliadas.push(recon.rowIdViejo);
          } else if (recon?.tipo === "ambigua") {
            reconciliacionesAmbiguas.push({ rowIdNuevo: rowId, candidatos: recon.candidatos });
          }
        }
      }
    );
    errors.push(...chunkErrors);
  }

  if (created > 0 || updated > 0) {
    await linkDetalleComprasByComprobante(db, { businessId, branchId });
  }

  return {
    created, updated, skipped, skippedRows, errors,
    comprasDistribuidasModificadas, comprasReconciliadas, reconciliacionesAmbiguas,
  };
}

module.exports = { normalizeCompras };
