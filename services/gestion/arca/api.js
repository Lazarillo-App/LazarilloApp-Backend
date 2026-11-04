// services/gestion/arca/api.js
// ARCA: importar "Mis Comprobantes", cruzar con lo cargado y corregir. Port de lazarillo_gestion
// (app/api/arca/**, lib/arca/query).
//
// Lo que ARCA informa va por CUIT, que es de la razón social: un comprobante puede estar cargado en
// cualquier negocio de la organización, así que el cruce (qué falta) mira toda la organización. Lo
// que se corrige, en cambio, solo son filas del negocio activo: cada negocio corrige lo suyo.
'use strict';

const { randomUUID } = require('crypto');
const { z } = require('zod');
const { sql, db } = require('../db');
const { ErrorDatos } = require('../dashboard/resultados-api');
const { reevaluarCompra } = require('../apertura/motor');
const { leerCsvArca, esNotaCredito, etiquetaTipo, tipoModal } = require('./csv');
const { clasificar } = require('./clasificar');
const { PERCEPCIONES, filasComprobantesSql, diagnosticoImporte, sugerirAnular } = require('./corregir');

const rechazo = (mensaje, status = 400, extra) => {
  const e = new ErrorDatos(mensaje);
  e.status = status;
  e.extra = extra;
  return e;
};
const LOTE = 500;
const r2 = (n) => Math.round(n * 100) / 100;
const CLAVE_ARCA = /^\d{11}-\d{1,3}-\d{1,5}-\d{1,8}$/;

// Los descartes de ARCA son de la empresa, no de un lugar: se guardan todos en el primer negocio de la organización.
async function negocioArca(cliente, organizationId) {
  const r = await cliente.one(sql`SELECT MIN(id) AS id FROM app_businesses WHERE organization_id = ${organizationId}`);
  return Number(r.id);
}

async function importarArca({ organizationId, usuario, body }) {
  const texto = typeof body?.texto === 'string' ? body.texto : '';
  if (!texto.trim()) throw rechazo('El archivo está vacío.');
  if (texto.length > 8_000_000) throw rechazo('El archivo es demasiado grande (partilo por año).', 413);
  const { comprobantes, errores } = leerCsvArca(texto);
  if (!comprobantes.length) throw rechazo(errores[0] ?? 'No se encontraron comprobantes.', 400, { errores });
  // Dentro del mismo archivo, la misma clave una sola vez (queda la última fila).
  const unicos = new Map();
  for (const c of comprobantes) unicos.set(`${c.cuitEmisor}|${c.tipo}|${c.puntoVenta}|${c.numero}`, c);
  const lista = [...unicos.values()];
  let nuevos = 0;
  let actualizados = 0;
  for (let i = 0; i < lista.length; i += LOTE) {
    const l = lista.slice(i, i + LOTE);
    const filas = await db.many(sql`
      INSERT INTO gestion_arca_comprobantes (organization_id, "cuitReceptor", "cuitEmisor", emisor, tipo, "puntoVenta", numero, fecha, cae, moneda, "tipoCambio",
                                             neto, "noGravado", exento, "otrosTributos", iva, total, "importadoPor")
      SELECT ${organizationId}::bigint, u.* FROM unnest(
        ${l.map((c) => c.cuitReceptor)}::text[], ${l.map((c) => c.cuitEmisor)}::text[], ${l.map((c) => c.emisor)}::text[],
        ${l.map((c) => c.tipo)}::int[], ${l.map((c) => c.puntoVenta)}::int[], ${l.map((c) => String(c.numero))}::bigint[],
        ${l.map((c) => c.fecha)}::date[], ${l.map((c) => c.cae)}::text[], ${l.map((c) => c.moneda)}::text[],
        ${l.map((c) => c.tipoCambio)}::numeric[], ${l.map((c) => r2(c.neto))}::numeric[], ${l.map((c) => r2(c.noGravado))}::numeric[],
        ${l.map((c) => r2(c.exento))}::numeric[], ${l.map((c) => r2(c.otrosTributos))}::numeric[], ${l.map((c) => r2(c.iva))}::numeric[],
        ${l.map((c) => r2(c.total))}::numeric[], ${l.map(() => usuario)}::text[]) AS u
      ON CONFLICT (organization_id, "cuitEmisor", tipo, "puntoVenta", numero) DO UPDATE SET
        "cuitReceptor" = EXCLUDED."cuitReceptor", emisor = EXCLUDED.emisor, fecha = EXCLUDED.fecha, cae = EXCLUDED.cae,
        moneda = EXCLUDED.moneda, "tipoCambio" = EXCLUDED."tipoCambio", neto = EXCLUDED.neto, "noGravado" = EXCLUDED."noGravado",
        exento = EXCLUDED.exento, "otrosTributos" = EXCLUDED."otrosTributos", iva = EXCLUDED.iva, total = EXCLUDED.total,
        "importadoEn" = CURRENT_TIMESTAMP, "importadoPor" = EXCLUDED."importadoPor"
      RETURNING (xmax = 0) AS nuevo`);
    for (const f of filas) { if (f.nuevo) nuevos += 1; else actualizados += 1; }
  }
  const fechas = lista.map((c) => c.fecha).sort();
  return { ok: true, nuevos, actualizados, errores, desde: fechas[0], hasta: fechas[fechas.length - 1] };
}

// Compras con número de ARCA, agrupadas por proveedor + comprobante + negocio.
const comprasSql = (organizationId) => sql`
  SELECT regexp_replace(COALESCE(pr.cuit, ''), '\\D', '', 'g') AS cuit,
         CAST(SUBSTRING(c.comprobante FROM LENGTH(c.comprobante) - 11 FOR 4) AS int) AS pv,
         CAST(RIGHT(c.comprobante, 8) AS bigint) AS nro,
         c.comprobante, c.business_id::int AS local_id,
         to_char(MIN(COALESCE(c."fechaManual", c.fecha)), 'YYYY-MM-DD') AS fecha,
         SUM(COALESCE(c."importeManual", c.importe))::float8 AS total,
         MIN(c."rowId") AS row_id
  FROM gestion_compras c
  LEFT JOIN gestion_proveedores pr ON pr.id = c."proveedorId"
  WHERE c.business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})
    AND c.comprobante ~ '[0-9]{12}$' AND UPPER(LEFT(c.comprobante, 1)) NOT IN ('E', 'G')
  GROUP BY 1, 2, 3, 4, 5`;

const claveDe = (a) => `${a.cuit}-${a.tipo}-${a.puntoVenta}-${a.numero}`;

async function cruceArca({ organizationId, businessId }) {
  const [filas, sinPar, resumen, descartes, anuladas, agregadas, negocios] = await Promise.all([
    db.many(sql`
      WITH g AS (${comprasSql(organizationId)}),
      prov AS (
        SELECT regexp_replace(cuit, '\\D', '', 'g') AS cuit, MIN(id) AS id,
               (array_agg(COALESCE(nombre, razon) ORDER BY id))[1] AS nombre
        FROM gestion_proveedores WHERE organization_id = ${organizationId} AND COALESCE(cuit, '') <> '' GROUP BY 1)
      SELECT a."cuitEmisor" AS cuit, a.emisor, a.tipo, a."puntoVenta" AS pv, a.numero::text AS nro,
             to_char(a.fecha, 'YYYY-MM-DD') AS fecha, a.total::float8 AS total, a."otrosTributos"::float8 AS otros,
             a.neto::float8 AS neto, a.iva::float8 AS iva, a."noGravado"::float8 AS no_gravado, a.exento::float8 AS exento,
             p.id AS proveedor_id, p.nombre AS proveedor,
             json_agg(json_build_object('comprobante', g.comprobante, 'localId', g.local_id, 'total', g.total,
                                        'fecha', g.fecha, 'rowId', g.row_id)) FILTER (WHERE g.row_id IS NOT NULL) AS cargados
      FROM gestion_arca_comprobantes a
      LEFT JOIN prov p ON p.cuit = a."cuitEmisor"
      -- Mismo CUIT + punto de venta + número. Si el CUIT no coincide (el proveedor tiene otro o
      -- ninguno), vale el mismo punto de venta + número con fecha a menos de 7 días.
      LEFT JOIN g ON g.pv = a."puntoVenta" AND g.nro = a.numero
                 AND (g.cuit = a."cuitEmisor" OR ABS(g.fecha::date - a.fecha::date) <= 7)
      WHERE a.organization_id = ${organizationId}
      GROUP BY a.id, p.id, p.nombre
      ORDER BY a.fecha DESC, a.id`),
    db.many(sql`
      WITH g AS (${comprasSql(organizationId)}),
      r AS (SELECT MIN(fecha) - 20 AS desde, MAX(fecha) + 20 AS hasta FROM gestion_arca_comprobantes WHERE organization_id = ${organizationId})
      SELECT g.cuit, g.comprobante, g.local_id, g.total, g.fecha, g.row_id
      FROM g, r
      WHERE g.fecha::date BETWEEN r.desde AND r.hasta
        AND EXISTS (SELECT 1 FROM gestion_arca_comprobantes a WHERE a.organization_id = ${organizationId} AND a."cuitEmisor" = g.cuit)
        AND NOT EXISTS (SELECT 1 FROM gestion_arca_comprobantes a WHERE a.organization_id = ${organizationId} AND a."cuitEmisor" = g.cuit AND a."puntoVenta" = g.pv AND a.numero = g.nro)`),
    db.one(sql`
      SELECT COUNT(*)::int AS n, to_char(MIN(fecha), 'YYYY-MM-DD') AS desde, to_char(MAX(fecha), 'YYYY-MM-DD') AS hasta, MAX("importadoEn") AS ultima
      FROM gestion_arca_comprobantes WHERE organization_id = ${organizationId}`),
    db.many(sql`
      SELECT id, clave, nombre, "creadoEn" FROM gestion_sin_carga_descartes
      WHERE business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId}) AND clave ~ '^[ak]:'
      ORDER BY "creadoEn" DESC`),
    db.many(sql`
      SELECT "rowId", comprobante, proveedor, to_char(fecha, 'YYYY-MM-DD') AS fecha, importe::float8 AS importe, "actualizadaEn"
      FROM gestion_compras_huerfanas WHERE business_id = ${businessId} AND motivo = 'duplicado_arca' AND estado = 'aplicada' ORDER BY "actualizadaEn" DESC`),
    db.many(sql`
      SELECT "rowId", comprobante, proveedor, concepto, importe::float8 AS importe FROM gestion_compras
      WHERE business_id = ${businessId} AND origen = 'arca' ORDER BY fecha DESC`),
    db.many(sql`SELECT id, name FROM app_businesses WHERE organization_id = ${organizationId}`),
  ]);
  const partesDe = new Map(filas.map((f) => [`${f.cuit}-${f.tipo}-${f.pv}-${f.nro}`, {
    neto: Number(f.neto), iva: Number(f.iva), noGravado: Number(f.no_gravado), exento: Number(f.exento), otros: Number(f.otros), total: Number(f.total),
  }]));
  // Un ticket (Z) con el mismo número que una factura del mismo negocio es otro gasto: no cuenta.
  const sinTicketsPegados = (cs) => cs.filter((x) => !(/^Z/i.test(x.comprobante) && cs.some((y) => y.localId === x.localId && !/^Z/i.test(y.comprobante))));
  const arca = filas.map((f) => ({
    key: '', cuit: f.cuit, emisor: f.emisor, tipo: f.tipo, puntoVenta: f.pv, numero: Number(f.nro), fecha: f.fecha,
    total: Number(f.total), otros: Number(f.otros), nc: esNotaCredito(f.tipo),
    proveedorId: f.proveedor_id ?? null, proveedor: f.proveedor ?? null, cargados: sinTicketsPegados(f.cargados ?? []),
  }));
  for (const a of arca) a.key = claveDe(a);
  const r = clasificar(arca, sinPar.map((s) => ({ cuit: s.cuit, comprobante: s.comprobante, localId: s.local_id, total: Number(s.total), fecha: s.fecha, rowId: s.row_id })));

  const fuera = new Set(descartes.map((d) => d.clave));
  const nombreLocal = new Map(negocios.map((l) => [Number(l.id), l.name]));
  const comp = (a) => ({
    key: a.key, mes: a.fecha.slice(0, 7), cuit: a.cuit, emisor: a.emisor, proveedorId: a.proveedorId, proveedor: a.proveedor,
    tipo: a.tipo, etiqueta: etiquetaTipo(a.tipo), tipoModal: tipoModal(a.tipo), nc: a.nc,
    puntoVenta: a.puntoVenta, numero: a.numero, fecha: a.fecha, total: a.total,
  });
  const faltan = r.faltan.filter((a) => !fuera.has(`a:${a.key}`)).map(comp);
  // Corregir: solo lo cargado en el negocio activo.
  const aCorregir = r.corregir.filter((c) => !fuera.has(`k:${c.arca.key}`) && c.panel.localId === businessId);
  const comprobantesDe = (c) => (c.motivo === 'numero' ? [c.panel.comprobante] : [...new Set(c.arca.cargados.filter((x) => x.localId === c.panel.localId).map((x) => x.comprobante))]);
  const todos = [...new Set(aCorregir.flatMap(comprobantesDe))];
  const filasComp = todos.length ? await db.many(filasComprobantesSql(organizationId, businessId, todos)) : [];
  const corregir = aCorregir.map((c) => {
    const grupos = comprobantesDe(c).map((comprobante) => ({ comprobante, filas: filasComp.filter((f) => f.comprobante === comprobante) }));
    const partes = partesDe.get(c.arca.key);
    return {
      key: c.arca.key, motivo: c.motivo, detalle: c.detalle, arca: comp(c.arca),
      panel: { comprobante: c.panel.comprobante, localId: c.panel.localId, local: nombreLocal.get(c.panel.localId) ?? null, rowId: c.panel.rowId, total: c.panel.total, fecha: c.panel.fecha },
      dif: Math.round(Math.abs(c.arca.total - Math.abs(c.panel.total))),
      grupos,
      sugerida: c.motivo === 'duplicado' ? sugerirAnular(grupos, c.arca.fecha) : null,
      diag: c.motivo === 'importe' ? diagnosticoImporte(partes, grupos.flatMap((g) => g.filas)) : null,
    };
  }).sort((x, y) => y.dif - x.dif); // las diferencias grandes, arriba
  return {
    importado: resumen?.n ? { n: resumen.n, desde: resumen.desde, hasta: resumen.hasta, ultima: resumen.ultima } : null,
    ok: r.ok, faltan, corregir, descartes, anuladas, agregadas,
    anuladasEntreSi: r.anuladasEntreSi.length, // pares factura + NC por el mismo importe (no se muestran)
  };
}

const fila = z.string().min(6).max(60);
const corregirSchema = z.discriminatedUnion('accion', [
  z.object({ accion: z.literal('fecha'), items: z.array(z.object({ rowIds: z.array(fila).min(1).max(30), fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), key: z.string().max(60), nombre: z.string().max(200) })).min(1).max(300) }),
  z.object({ accion: z.literal('numero'), items: z.array(z.object({ key: z.string().regex(CLAVE_ARCA), nombre: z.string().max(200) })).min(1).max(300) }),
  z.object({ accion: z.literal('anular'), rowIds: z.array(fila).min(1).max(30), nota: z.string().max(120) }),
  z.object({ accion: z.literal('restaurar'), rowId: fila }),
  z.object({ accion: z.literal('igualar'), rowId: fila, importe: z.number().finite(), key: z.string().max(60) }),
  z.object({ accion: z.literal('percepcion'), baseRowId: fila, cod: z.enum(['133', '899', '137']), importe: z.number().positive().max(1e10) }),
  z.object({ accion: z.literal('quitar'), rowId: z.string().regex(/^arca-[0-9a-f-]{36}$/) }),
]);

// Anota una clave en "Ya no van" (de la empresa).
async function marcarRevisadas(cliente, organizationId, items, usuario) {
  const negocio = await negocioArca(cliente, organizationId);
  for (const it of items) {
    await cliente.execute(sql`
      INSERT INTO gestion_sin_carga_descartes (business_id, branch_id, clave, nombre, "creadoPor")
      VALUES (${negocio}, NULL, ${`k:${it.key}`}, ${it.nombre}, ${usuario})
      ON CONFLICT (business_id, branch_id, clave) DO NOTHING`);
  }
}

// Todo se hace como corrección manual del Panel, así una nueva lectura de MaxiRest no la pisa. Si la
// fila ya está repartida por una regla, el reparto se recalcula con el dato nuevo.
async function corregirArca({ organizationId, businessId, usuario, body }) {
  const parsed = corregirSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos');
  const d = parsed.data;
  const ctx = { organizationId, businessId };
  const reevaluar = async (tx, rowIds) => {
    const rep = await tx.many(sql`SELECT "rowId" FROM gestion_compras WHERE business_id = ${businessId} AND "rowId" = ANY(${rowIds}::text[]) AND "esDistribuido"`);
    for (const f of rep) await reevaluarCompra(tx, ctx, f.rowId);
  };

  if (d.accion === 'fecha') {
    return db.transaction(async (tx) => {
      let filas = 0;
      for (const it of d.items) {
        filas += await tx.execute(sql`UPDATE gestion_compras SET "fechaManual" = ${it.fecha}::timestamp WHERE business_id = ${businessId} AND "rowId" = ANY(${it.rowIds}::text[])`);
        await reevaluar(tx, it.rowIds);
      }
      await marcarRevisadas(tx, organizationId, d.items.filter((it) => CLAVE_ARCA.test(it.key)), usuario);
      return { ok: true, comprobantes: d.items.length, filas };
    });
  }
  if (d.accion === 'numero') {
    // Revisada: sale de Corregir y, como ya está apareada, tampoco figura como "sin cargar".
    await marcarRevisadas(db, organizationId, d.items, usuario);
    return { ok: true, comprobantes: d.items.length };
  }
  if (d.accion === 'anular') {
    await db.transaction(async (tx) => {
      const ya = new Set((await tx.many(sql`
        SELECT "rowId" FROM gestion_compras_huerfanas WHERE business_id = ${businessId} AND "rowId" = ANY(${d.rowIds}::text[]) AND estado = 'aplicada'`)).map((x) => x.rowId));
      const ids = d.rowIds.filter((id) => !ya.has(id));
      if (!ids.length) return;
      await tx.execute(sql`
        INSERT INTO gestion_compras_huerfanas (business_id, branch_id, "rowId", fecha, comprobante, codigo, proveedor, concepto, importe,
                                               "importeManualAntes", "observacManualAntes", motivo, estado)
        SELECT business_id, branch_id, "rowId", fecha::date, comprobante, codigo, proveedor, concepto, importe,
               "importeManual", "observacManual", 'duplicado_arca', 'aplicada'
        FROM gestion_compras WHERE business_id = ${businessId} AND "rowId" = ANY(${ids}::text[])
        ON CONFLICT (business_id, "rowId") DO UPDATE SET motivo = 'duplicado_arca', estado = 'aplicada',
          "importeManualAntes" = EXCLUDED."importeManualAntes", "observacManualAntes" = EXCLUDED."observacManualAntes", "actualizadaEn" = CURRENT_TIMESTAMP`);
      await tx.execute(sql`
        UPDATE gestion_compras SET "importeManual" = 0, "observacManual" = ${d.nota} || COALESCE(' · ' || COALESCE("observacManual", observac), '')
        WHERE business_id = ${businessId} AND "rowId" = ANY(${ids}::text[])`);
      await reevaluar(tx, ids);
    });
    return { ok: true };
  }
  if (d.accion === 'restaurar') {
    return db.transaction(async (tx) => {
      const h = await tx.one(sql`
        SELECT "importeManualAntes"::float8 AS "importeManualAntes", "observacManualAntes" FROM gestion_compras_huerfanas
        WHERE business_id = ${businessId} AND "rowId" = ${d.rowId} AND estado = 'aplicada'`);
      if (!h) throw rechazo('No estaba anulada', 404);
      await tx.execute(sql`UPDATE gestion_compras SET "importeManual" = ${h.importeManualAntes}::numeric, "observacManual" = ${h.observacManualAntes} WHERE business_id = ${businessId} AND "rowId" = ${d.rowId}`);
      await tx.execute(sql`UPDATE gestion_compras_huerfanas SET estado = 'restaurada', "actualizadaEn" = CURRENT_TIMESTAMP WHERE business_id = ${businessId} AND "rowId" = ${d.rowId}`);
      await reevaluar(tx, [d.rowId]);
      return { ok: true };
    });
  }
  if (d.accion === 'percepcion') {
    const per = PERCEPCIONES.find((p) => p.cod === d.cod);
    const rowId = `arca-${randomUUID()}`;
    const n = await db.execute(sql`
      INSERT INTO gestion_compras (business_id, branch_id, "rowId", comprobante, "codCga", concepto, fecha, codigo, proveedor, detalle, observac, importe, "importeTrabajado",
                                   per1, per2, per3, "conceptoCodigo", "proveedorId", origen)
      SELECT b.business_id, b.branch_id, ${rowId}, b.comprobante, ${d.cod}, ${per.nombre}, COALESCE(b."fechaManual", b.fecha), b.codigo, b.proveedor, b.detalle,
             ${`Percepción agregada desde ARCA por ${usuario}`}, ${d.importe}::numeric, ${d.importe}::numeric,
             ${d.cod === '133' ? d.importe : 0}::numeric, ${d.cod === '899' ? d.importe : 0}::numeric, ${d.cod === '137' ? d.importe : 0}::numeric,
             (SELECT codigo FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ${d.cod}), b."proveedorId", 'arca'
      FROM gestion_compras b WHERE b.business_id = ${businessId} AND b."rowId" = ${d.baseRowId}`);
    if (!n) throw rechazo('No se encontró la factura', 404);
    return { ok: true, rowId };
  }
  if (d.accion === 'quitar') {
    const n = await db.execute(sql`DELETE FROM gestion_compras WHERE business_id = ${businessId} AND "rowId" = ${d.rowId} AND origen = 'arca'`);
    if (!n) throw rechazo('No se encontró', 404);
    return { ok: true };
  }
  // igualar
  return db.transaction(async (tx) => {
    const n = await tx.execute(sql`
      UPDATE gestion_compras SET "importeManual" = CASE WHEN COALESCE("importeManual", importe) < 0 THEN -ABS(${d.importe}::numeric) ELSE ABS(${d.importe}::numeric) END
      WHERE business_id = ${businessId} AND "rowId" = ${d.rowId}`);
    if (!n) throw rechazo('No se encontró la fila', 404);
    await reevaluar(tx, [d.rowId]);
    return { ok: true };
  });
}

module.exports = { importarArca, cruceArca, corregirArca, negocioArca, CLAVE_ARCA };
