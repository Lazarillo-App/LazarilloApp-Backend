// Portado de lazarillo_gestion/lib/render/sync.ts (TypeScript → JavaScript, misma lógica).
//
// Cambios respecto de gestion (multi-negocio, ver docs/integracion-gestion/00-diseno-modelo.md):
// - Cada PDV del kit se resuelve con gestion_render_origenes a negocio + sucursal (y su
//   organización); los maestros van a la organización dueña del esquema del kit.
// - Los maestros de proveedores (m00) y artículos (m6) también salen del kit (gestion los
//   cargaba desde Drive): el chequeo "faltan maestros" no aplica a los propios maestros.
// - Es la misma base: no hay conexión aparte a Render.
// - Apertura de gastos y concepto fijo por empleado todavía no están portados: si una corrida
//   toca compras se deja constancia en el log (no se saltean en silencio). Hasta que se migren
//   las reglas desde gestion, esas tablas están vacías y no habría nada que aplicar.
'use strict';

const crypto = require('crypto');
const { sql, db } = require('../db');
const { runETLFilas } = require('../etl/run-etl');
const { linkDetalleCompras } = require('../etl/link-detalle-compras');
const { accumulateAperturaInputs } = require('../hooks/accumulate-apertura-inputs');
const { filaDeRender, informeDeTabla } = require('./filas');
const { huellaTabla, leerCargas, leerTabla, PDV_MAESTROS } = require('./db');
const { revisarHuerfanas } = require('./huerfanas');

// Un ítem = una tabla de Render para un PDV (ej. i14 2026 del BAR → negocio 147),
// o un maestro de la organización (ej. m17 de container → organización 9).

const claveLog = (id) => `render:${id}`;

// Años que se leen de Render: el actual y el anterior (lo viejo ya está importado
// y el kit solo recarga esos dos).
function aniosVigentes(hoy = new Date()) {
  const y = hoy.getUTCFullYear();
  return new Set([y, y - 1]);
}

// Orden de dependencia: maestros → compras → detalle → pagos → nómina → ventas.
const ORDEN = ["proveedores", "articulos", "conceptosCaja", "compras", "detalleCompras", "pagos", "nomina", "ventas"];

async function listarItems() {
  const origenes = await db.many(sql`
    SELECT o.id, o.esquema, o.pdv, o.business_id, o.branch_id, b.organization_id
      FROM gestion_render_origenes o
      JOIN app_businesses b ON b.id = o.business_id
     WHERE o.activo
     ORDER BY o.id`);
  const porEsquema = new Map();
  for (const o of origenes) porEsquema.set(o.esquema, [...(porEsquema.get(o.esquema) ?? []), o]);
  const anios = aniosVigentes();
  const items = [];
  for (const [esquema, origs] of porEsquema) {
    // Los maestros del esquema son de UNA organización (la de todos sus PDV).
    const orgs = [...new Set(origs.map((o) => String(o.organization_id)))];
    if (orgs.length !== 1 || orgs[0] === 'null') {
      console.error(`[render] el esquema ${esquema} no tiene una única organización (${orgs.join(', ')}): se saltea`);
      continue;
    }
    const organizationId = Number(orgs[0]);
    const cargas = await leerCargas(esquema, [...origs.map((o) => o.pdv), PDV_MAESTROS]);
    for (const c of cargas) {
      const inf = informeDeTabla(c.tabla);
      if (!inf || (inf.anio != null && !anios.has(inf.anio))) continue;
      // Maestro de la organización: no es de un PDV.
      if (Boolean(inf.informe.maestro) !== (c.pdv === PDV_MAESTROS)) continue;
      const o = inf.informe.maestro ? null : origs.find((x) => x.pdv === c.pdv);
      items.push({
        id: `${esquema}.${c.tabla}.${c.pdv}`,
        esquema,
        tabla: c.tabla,
        pdv: c.pdv,
        nombre: inf.informe.nombre + (inf.anio ? ` ${inf.anio}` : ""),
        anio: inf.anio,
        fileType: inf.informe.fileType,
        maestro: Boolean(inf.informe.maestro),
        organizationId,
        businessId: o ? Number(o.business_id) : null,
        branchId: o?.branch_id != null ? Number(o.branch_id) : null,
        filas: c.filas,
        cargadoEnRender: c.cargado,
        bloqueado: inf.informe.requiereOrden && !c.tieneFila ? "Falta que el kit suba el orden de las filas" : null,
        ultimo: null,
      });
    }
  }
  if (items.length) {
    const logs = await db.many(sql`
      SELECT "driveFileId", estado, "creadoEn", "driveHuella", created, updated, errors
        FROM gestion_import_logs
       WHERE "driveFileId" = ANY(${items.map((i) => claveLog(i.id))})
       ORDER BY "creadoEn" DESC`);
    for (const it of items) {
      const l = logs.find((x) => x.driveFileId === claveLog(it.id));
      if (l) it.ultimo = {
        estado: l.estado, creadoEn: l.creadoEn.toISOString(), huella: l.driveHuella,
        created: l.created, updated: l.updated, errores: Array.isArray(l.errors) ? l.errors.length : 0,
      };
    }
  }
  return items.sort((a, b) =>
    Number(b.maestro) - Number(a.maestro) ||
    (a.businessId ?? 0) - (b.businessId ?? 0) || (a.branchId ?? 0) - (b.branchId ?? 0) ||
    ORDEN.indexOf(a.fileType) - ORDEN.indexOf(b.fileType) || (a.anio ?? 0) - (b.anio ?? 0));
}

async function maestrosCargados(organizationId) {
  const r = await db.one(sql`
    SELECT (SELECT count(*) FROM gestion_proveedores WHERE organization_id = ${organizationId})::int AS p,
           (SELECT count(*) FROM gestion_conceptos_caja WHERE organization_id = ${organizationId})::int AS c,
           (SELECT count(*) FROM gestion_articulos WHERE organization_id = ${organizationId})::int AS a`);
  return r.p > 0 && r.c > 0 && r.a > 0;
}

// Rubros que el maestro trae por nombre y el Panel todavía no tiene. Render no tiene los
// maestros de rubros (11 de caja, rubros/subrubros de artículos): se crean con el código y
// el nombre que vienen en cada fila, sin pisar uno existente.
async function crearRubrosDelMaestro(item) {
  const { filas } = await leerTabla(item.esquema, item.tabla, item.pdv, false);
  const org = item.organizationId;
  if (item.fileType === "conceptosCaja") {
    // Conceptos nuevos de un rubro que el Panel todavía no tiene: el rubro se crea
    // con el nombre que trae el maestro 17 (Render no tiene el maestro 11).
    const rubros = new Map();
    for (const f of filas) {
      const cod = f.cod_rga != null ? String(f.cod_rga) : null;
      if (cod && Number(cod) > 0 && f.rubro) rubros.set(cod, String(f.rubro).trim());
    }
    if (rubros.size) {
      await db.execute(sql`
        INSERT INTO gestion_rubros_concepto_caja (organization_id, codigo, nombre)
        VALUES ${sql.join([...rubros].map(([codigo, nombre]) => sql`(${org}, ${codigo}, ${nombre})`))}
        ON CONFLICT (organization_id, codigo) DO NOTHING`);
    }
  }
  if (item.fileType === "articulos") {
    const rubros = new Map();
    const subrubros = new Map();
    for (const f of filas) {
      const rua = f.cod_rua != null && Number(f.cod_rua) > 0 ? String(Number(f.cod_rua)) : null;
      const sua = f.cod_sua != null && Number(f.cod_sua) > 0 ? String(Number(f.cod_sua)) : null;
      if (rua && f.rubro) rubros.set(rua, String(f.rubro).trim());
      if (sua && f.subrubro) subrubros.set(sua, { nombre: String(f.subrubro).trim(), rua });
    }
    if (rubros.size) {
      await db.execute(sql`
        INSERT INTO gestion_rubros_articulo (organization_id, codigo, nombre)
        VALUES ${sql.join([...rubros].map(([codigo, nombre]) => sql`(${org}, ${codigo}, ${nombre})`))}
        ON CONFLICT (organization_id, codigo) DO NOTHING`);
    }
    if (subrubros.size) {
      await db.execute(sql`
        INSERT INTO gestion_subrubros_articulo (organization_id, codigo, nombre, "codRua")
        VALUES ${sql.join([...subrubros].map(([codigo, s]) => sql`(${org}, ${codigo}, ${s.nombre}, ${s.rua})`))}
        ON CONFLICT (organization_id, codigo) DO NOTHING`);
    }
  }
}

async function guardarLog(datos) {
  await db.execute(sql`
    INSERT INTO gestion_import_logs (
      business_id, branch_id, "batchId", "fileType", "fileName", estado, "totalRows", created, updated,
      skipped, errors, "skippedRows", "errorMessage", "durationMs", "triggeredBy", "driveFileId", "driveHuella"
    ) VALUES (
      ${datos.businessId}::bigint, ${datos.branchId}::bigint, ${datos.batchId}, ${datos.fileType}, ${datos.fileName},
      ${datos.estado}, ${datos.totalRows ?? null}::integer, ${datos.created ?? null}::integer, ${datos.updated ?? null}::integer,
      ${datos.skipped ?? null}::integer,
      ${datos.errors ? JSON.stringify(datos.errors) : null}::jsonb,
      ${datos.skippedRows ? JSON.stringify(datos.skippedRows) : null}::jsonb,
      ${datos.errorMessage ?? null}, ${datos.durationMs ?? null}::integer, ${datos.triggeredBy},
      ${datos.driveFileId}, ${datos.driveHuella}
    )`);
}

async function sincronizarItem(item, opts) {
  if (item.bloqueado) return { id: item.id, error: item.bloqueado };
  if (!item.maestro && !(await maestrosCargados(item.organizationId))) {
    return { id: item.id, error: "Faltan los maestros de la organización (proveedores, conceptos, artículos)." };
  }

  const huella = await huellaTabla(item.esquema, item.tabla, item.pdv);
  if (!opts.forzar) {
    const ultimo = await db.one(sql`
      SELECT estado, "driveHuella" FROM gestion_import_logs
       WHERE "driveFileId" = ${claveLog(item.id)}
       ORDER BY "creadoEn" DESC LIMIT 1`);
    if (ultimo?.estado === "ok" && ultimo.driveHuella === huella) return { id: item.id, sinCambios: true };
  }

  if (item.fileType === "conceptosCaja" || item.fileType === "articulos") {
    try {
      await crearRubrosDelMaestro(item);
    } catch (e) {
      console.error("[render] rubros del maestro", item.id, e);
    }
  }

  const base = {
    batchId: crypto.randomUUID(),
    fileType: item.fileType,
    fileName: `Render · ${item.nombre} · ${item.pdv}`,
    businessId: item.businessId,
    branchId: item.branchId,
    triggeredBy: opts.triggeredBy ?? "render",
    driveFileId: claveLog(item.id),
    driveHuella: huella,
  };
  // Estadísticas al día antes de compras/detalle: esos normalizadores terminan enlazando
  // detalle→compra con un UPDATE … FROM. Tras una carga grande (la primera de un negocio)
  // sin ANALYZE Postgres lo planifica como si las tablas estuvieran vacías y pasa el
  // statement_timeout (1ª corrida en prod, detalle de Comercio, 02/11/2026).
  if (item.fileType === "compras" || item.fileType === "detalleCompras") {
    for (const t of ["gestion_compras", "gestion_detalle_compras"]) {
      await db.execute(sql`ANALYZE ${sql.raw(t)}`).catch((e) => console.error("[render] analyze", t, e));
    }
  }

  let report;
  try {
    const { filas, tipos } = await leerTabla(item.esquema, item.tabla, item.pdv, item.fileType === "ventas");
    const rows = filas.map((f) => filaDeRender(f, tipos));
    const ctx = { organizationId: item.organizationId, businessId: item.businessId, branchId: item.branchId };
    report = await runETLFilas(item.fileType, rows, ctx, db);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    await guardarLog({ ...base, estado: "error", errorMessage: message })
      .catch((e) => console.error("[render] no se pudo loguear", item.id, e));
    return { id: item.id, error: message };
  }
  await guardarLog({
    ...base,
    estado: "ok",
    totalRows: report.totalRows,
    created: report.created,
    updated: report.updated,
    skipped: report.skipped,
    errors: report.errors.slice(0, 500),
    skippedRows: report.skippedRows?.slice(0, 500),
    durationMs: report.durationMs,
  }).catch((e) => console.error("[render] no se pudo loguear", item.id, e));
  return { id: item.id, report };
}

// Cierre por PDV (negocio + sucursal), igual que /api/etl/drive-import/finalizar:
// vincula el detalle con las compras y reaplica la apertura de gastos si cambiaron compras.
async function finalizarPdv(pdv, reports) {
  await linkDetalleCompras(db, pdv);
  const { huboComprasTocadas, comprasModificadas } = accumulateAperturaInputs(reports);
  if (huboComprasTocadas) {
    // Concepto fijo por empleado (Diego 29/10/2026) y apertura de gastos: pendientes de
    // portar (ver encabezado). Se deja constancia en vez de saltearlos en silencio.
    console.warn("[render] compras tocadas en", pdv, "— concepto fijo por empleado y apertura de gastos todavía no portados;",
      comprasModificadas.length, "compras distribuidas modificadas sin reaplicar");
  }
}

// Corrida completa: todo lo pendiente, con tope de tiempo. onItem informa el
// avance (lo usa la corrida en el servidor para que la pantalla lo muestre).
async function sincronizarTodo(opts) {
  const inicio = Date.now();
  const items = await listarItems();
  await opts.onInicio?.(items.length);
  const resultados = [];
  const reportsPorPdv = new Map();
  let pendientes = 0;
  let hechos = 0;
  const avisar = async (...args) => {
    try { await opts.onItem?.(...args); } catch (e) { console.error("[render] avance", e); }
  };
  for (const it of items) {
    if (Date.now() - inicio > opts.presupuestoMs) { pendientes++; continue; }
    await avisar(it, null, hechos);
    const r = await sincronizarItem(it, { triggeredBy: opts.triggeredBy, forzar: opts.forzar });
    resultados.push(r);
    hechos++;
    await avisar(it, r, hechos);
    if ("report" in r && it.businessId != null) {
      const k = `${it.businessId}|${it.branchId ?? ""}`;
      const prev = reportsPorPdv.get(k) ?? { pdv: { businessId: it.businessId, branchId: it.branchId }, reports: [] };
      prev.reports.push(r.report);
      reportsPorPdv.set(k, prev);
    }
  }
  for (const { pdv, reports } of reportsPorPdv.values()) {
    try { await finalizarPdv(pdv, reports); } catch (e) { console.error("[render] finalizar", pdv, e); }
  }
  // Compras que MaxiRest ya no tiene (versiones viejas de gastos editados), por cada PDV cuyo
  // 14 se leyó en esta corrida — con la foto completa de Render (ver render/huerfanas.js).
  const leidos = new Set(resultados.filter((r) => "report" in r).map((r) => r.id));
  const porPdv = new Map();
  for (const it of items) if (it.fileType === "compras" && it.businessId != null) porPdv.set(`${it.esquema}|${it.pdv}`, [...(porPdv.get(`${it.esquema}|${it.pdv}`) ?? []), it]);
  for (const its of porPdv.values()) {
    if (!its.some((it) => leidos.has(it.id)) || Date.now() - inicio > opts.presupuestoMs) continue;
    try {
      const r = await revisarHuerfanas({ esquema: its[0].esquema, pdv: its[0].pdv, businessId: its[0].businessId, branchId: its[0].branchId, tablas: its.map((it) => it.tabla) });
      if (r.marcadas || r.restauradas) console.log("[render] huérfanas", its[0].pdv, r);
    } catch (e) { console.error("[render] huérfanas", its[0].pdv, e); }
  }
  return { resultados, pendientes };
}

// ── Corrida en el servidor (botón "Actualizar ahora" y cron) ──────────────────
// Una sola a la vez: si hay una corriendo hace menos de VIGENCIA_CANDADO_MS, se
// devuelve esa. El avance queda en gestion_render_corridas para que la pantalla lo
// muestre aunque el usuario cierre la página (Diego, 26/10/2026).
// En gestion el tope era la función de Vercel (5 min); acá no hay ese límite, pero se
// mantiene un presupuesto para que una corrida trabada no tome el candado para siempre.
const PRESUPUESTO_MS = 30 * 60_000;
const VIGENCIA_CANDADO_MS = PRESUPUESTO_MS + 5 * 60_000;

const corto = (r) =>
  "sinCambios" in r ? "sin_cambios" : "report" in r ? "leido" : `error:${r.error}`;

async function corridaEnCurso() {
  return db.one(sql`
    SELECT * FROM gestion_render_corridas
     WHERE estado = 'corriendo' AND inicio > ${new Date(Date.now() - VIGENCIA_CANDADO_MS)}
     ORDER BY inicio DESC LIMIT 1`);
}

async function ultimaCorrida() {
  return db.one(sql`SELECT * FROM gestion_render_corridas ORDER BY inicio DESC LIMIT 1`);
}

// Reserva el candado. null si ya hay una corrida en curso.
async function abrirCorrida(origen) {
  if (await corridaEnCurso()) return null;
  const c = await db.one(sql`
    INSERT INTO gestion_render_corridas (estado, origen, resumen)
    VALUES ('corriendo', ${origen}, '{}'::jsonb) RETURNING id`);
  return c.id;
}

const actualizarCorrida = (id, campos) => db.execute(sql`
  UPDATE gestion_render_corridas SET
    total   = COALESCE(${campos.total ?? null}::integer, total),
    hechos  = COALESCE(${campos.hechos ?? null}::integer, hechos),
    actual  = ${campos.actual ?? null},
    estado  = COALESCE(${campos.estado ?? null}, estado),
    fin     = COALESCE(${campos.fin ?? null}::timestamp, fin),
    resumen = COALESCE(${campos.resumen ? JSON.stringify(campos.resumen) : null}::jsonb, resumen)
  WHERE id = ${id}`);

async function ejecutarCorrida(id, triggeredBy, { forzar = false } = {}) {
  const resultados = {};
  try {
    const { pendientes } = await sincronizarTodo({
      presupuestoMs: PRESUPUESTO_MS,
      triggeredBy,
      forzar,
      onInicio: async (total) => { await actualizarCorrida(id, { total }); },
      onItem: async (it, r, hechos) => {
        if (r) resultados[it.id] = corto(r);
        await actualizarCorrida(id, { hechos, actual: r ? null : `${it.nombre} · ${it.pdv}`, resumen: resultados });
      },
    });
    await actualizarCorrida(id, { estado: "ok", fin: new Date(), resumen: { ...resultados, _pendientes: pendientes } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[render] corrida", id, err);
    await actualizarCorrida(id, { estado: "error", fin: new Date(), resumen: { ...resultados, _error: msg } })
      .catch((e) => console.error("[render] no se pudo cerrar la corrida", id, e));
  }
}

module.exports = { listarItems, sincronizarItem, finalizarPdv, sincronizarTodo, corridaEnCurso, ultimaCorrida, abrirCorrida, ejecutarCorrida };
