// Buscador del Panel y rubros visibles, portados de lazarillo_gestion/app/api/search/{suggestions,
// observaciones,importe}/route.ts y app/api/config/rubros-dashboard/route.ts (misma lógica).
//
// Tenancy: todo se busca dentro del negocio activo (nunca en otros negocios de la organización).
// Donde gestion decía en qué local/PDV vive cada cosa ("pdvs"), acá se dice en qué sucursal del
// negocio: { sucursal: null = la principal | id, nombre }. Rubros/conceptos/proveedores son los
// maestros de la organización; la visibilidad de rubros es del negocio.
'use strict';

const { sql, db } = require('../db');
const { buildPivotConditions, importeCondition } = require('./query-builders');
const { SIN_RUBRO_CODE, SIN_RUBRO_NOMBRE, VISIBILIDAD_FIELDS } = require('./constants');
const { ErrorDatos } = require('./resultados-api');

// Nombre de la sucursal de una fila (alias de app_branches = br). NULL = la principal.
const nombreSucursal = sql`COALESCE(br.name, 'Principal')`;

const sucursalDe = (branchId, nombre) => ({ sucursal: branchId == null ? null : Number(branchId), nombre });

// Rubros, conceptos y proveedores con al menos una compra en la sucursal dada (o en el negocio,
// con "todas"), de cualquier año. Mismas reglas que el pivot.
async function origenesConCompras({ organizationId, businessId, sucursal }) {
  const where = sql.join(buildPivotConditions({ tableAlias: "c", businessId, sucursal }), " AND ");
  const rows = await db.many(sql`
    SELECT DISTINCT
      COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") AS "conceptoCodigo",
      cc."codRga"                                            AS "rubroCodigo",
      c."proveedorId"                                        AS "proveedorId"
    FROM gestion_v_compras_distribuidas c
    LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId}
                                       AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
    WHERE ${where}
  `);
  const sinNulos = (xs) => xs.filter((x) => x !== null);
  return {
    rubros: sinNulos(rows.map((r) => r.rubroCodigo)),
    conceptos: sinNulos(rows.map((r) => r.conceptoCodigo)),
    proveedores: sinNulos(rows.map((r) => r.proveedorId)),
  };
}

// Igual pero en todas las sucursales del negocio, agrupando por dónde está cada compra (de la
// más reciente a la más vieja): el buscador etiqueta lo que no tiene compras en la sucursal que
// se mira y, al elegirlo, se va a la primera.
async function origenesPorSucursal({ organizationId, businessId }) {
  const where = sql.join(buildPivotConditions({ tableAlias: "c", businessId }), " AND ");
  const rows = await db.many(sql`
    SELECT
      COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") AS "conceptoCodigo",
      cc."codRga"                                            AS "rubroCodigo",
      c."proveedorId"                                        AS "proveedorId",
      c.branch_id                                            AS "branchId",
      ${nombreSucursal}                                      AS "sucursalNombre",
      MAX(COALESCE(c."fechaManual", c.fecha))                AS ultima
    FROM gestion_v_compras_distribuidas c
    LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId}
                                       AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
    LEFT JOIN app_branches br           ON br.id = c.branch_id
    WHERE ${where}
    GROUP BY 1, 2, 3, 4, 5
  `);
  const agrupar = (clave) => {
    const porClave = new Map();
    for (const r of rows) {
      const k = clave(r);
      if (k === null) continue;
      const lista = porClave.get(k) ?? [];
      const ya = lista.find((x) => x.branchId === r.branchId);
      const t = r.ultima ? new Date(r.ultima).getTime() : 0;
      if (ya) ya.ultima = Math.max(ya.ultima, t);
      else lista.push({ branchId: r.branchId, nombre: r.sucursalNombre, ultima: t });
      porClave.set(k, lista);
    }
    const out = new Map();
    for (const [k, lista] of porClave) {
      out.set(k, [...lista].sort((a, b) => b.ultima - a.ultima).map((p) => sucursalDe(p.branchId, p.nombre)));
    }
    return out;
  };
  return {
    rubros: agrupar((r) => r.rubroCodigo),
    conceptos: agrupar((r) => r.conceptoCodigo),
    proveedores: agrupar((r) => r.proveedorId),
  };
}

// Sin q: preview alfabético acotado a la sucursal que se mira (pantalla "Buscar en").
// Con q: búsqueda real en todo el negocio; cada sugerencia dice en qué sucursales tiene compras.
async function obtenerSugerencias({ organizationId, businessId, sucursal, q: qCrudo }) {
  const q = String(qCrudo ?? "").trim().slice(0, 200);
  const like = q ? `%${q.replace(/[%_\\]/g, "\\$&")}%` : null;
  const porSucursal = like ? await origenesPorSucursal({ organizationId, businessId }) : null;
  const origen = like ? null : await origenesConCompras({ organizationId, businessId, sucursal });
  const codigos = porSucursal
    ? { rubros: [...porSucursal.rubros.keys()], conceptos: [...porSucursal.conceptos.keys()], proveedores: [...porSucursal.proveedores.keys()] }
    : origen;
  const texto = (col) => (like ? sql`AND ${col} ILIKE ${like}` : sql``);

  const [rubros, conceptos, proveedores] = await Promise.all([
    db.many(sql`
      SELECT rc.codigo, rc.nombre FROM gestion_rubros_concepto_caja rc
      WHERE rc.organization_id = ${organizationId} AND rc.codigo = ANY(${codigos.rubros}) ${texto(sql`rc.nombre`)}
      ORDER BY rc.nombre LIMIT ${like ? 50 : 500}`),
    db.many(sql`
      SELECT cc.codigo, cc.nombre, rc.codigo AS "rubroCodigo", rc.nombre AS "rubroNombre"
      FROM gestion_conceptos_caja cc
      LEFT JOIN gestion_rubros_concepto_caja rc ON rc.organization_id = ${organizationId} AND rc.codigo = cc."codRga"
      WHERE cc.organization_id = ${organizationId} AND cc.codigo = ANY(${codigos.conceptos}) ${texto(sql`cc.nombre`)}
      ORDER BY cc.nombre LIMIT ${like ? 50 : 500}`),
    db.many(sql`
      SELECT p.id, p.nombre, p.razon FROM gestion_proveedores p
      WHERE p.id = ANY(${codigos.proveedores.map(Number)}::int[])
        ${like ? sql`AND (p.nombre ILIKE ${like} OR p.razon ILIKE ${like})` : sql``}
      ORDER BY p.nombre LIMIT ${like ? 50 : 200}`),
  ]);

  const donde = (mapa, k) => (porSucursal ? { sucursales: mapa.get(k) ?? [] } : {});
  return [
    ...rubros.map((r) => ({
      id: `rubro:${r.codigo}`, label: r.nombre ?? r.codigo, type: "rubro", param: "rubroCodigo", value: r.codigo,
      ...donde(porSucursal?.rubros, r.codigo),
    })),
    ...conceptos.map((c) => ({
      id: `concepto:${c.codigo}`, label: c.nombre ?? c.codigo, type: "concepto", param: "conceptoCodigo", value: c.codigo,
      rubroNombre: c.rubroNombre ?? undefined, rubroCodigo: c.rubroCodigo ?? undefined,
      ...donde(porSucursal?.conceptos, c.codigo),
    })),
    ...proveedores.map((p) => ({
      id: `proveedor:${p.id}`, label: p.nombre ?? p.razon ?? `Proveedor ${p.id}`, type: "proveedor", param: "proveedorId", value: String(p.id),
      ...donde(porSucursal?.proveedores, p.id),
    })),
  ];
}

// Observaciones que contienen lo tipeado, en todo el negocio y de cualquier año (el buscador
// navega a la sucursal y al año del elegido). Una fila por compra aunque esté aperturada.
async function obtenerObservaciones({ organizationId, businessId, q: qCrudo }) {
  const q = String(qCrudo ?? "").trim().slice(0, 200);
  if (q.length < 2) return [];
  const where = sql.join(buildPivotConditions({ tableAlias: "c", businessId, observacionQuery: q }), " AND ");
  const rows = await db.many(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (c."rowId")
        c."rowId"                                                 AS "rowId",
        COALESCE(c."observacManual", c.observac)                  AS observac,
        TO_CHAR(COALESCE(c."fechaManual", c.fecha), 'YYYY-MM-DD') AS fecha,
        COALESCE(c."importeManual", c.importe)                    AS importe,
        cc.nombre                                                 AS "conceptoNombre",
        COALESCE(p.nombre, p.razon)                               AS "proveedorNombre",
        c.branch_id_origen                                        AS "branchId",
        ${nombreSucursal}                                         AS "sucursalNombre"
      FROM gestion_v_compras_distribuidas c
      LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId}
                                         AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
      LEFT JOIN gestion_proveedores p     ON c."proveedorId" = p.id
      LEFT JOIN app_branches br           ON br.id = c.branch_id_origen
      WHERE ${where}
      ORDER BY c."rowId"
    ) t
    ORDER BY fecha DESC
    LIMIT 12
  `);
  return rows.map((r) => ({
    id: `observacion:${r.rowId}`,
    label: r.observac ?? "",
    fecha: r.fecha,
    importe: r.importe != null ? String(r.importe) : null,
    conceptoNombre: r.conceptoNombre,
    proveedorNombre: r.proveedorNombre,
    ...sucursalDe(r.branchId, r.sucursalNombre),
  }));
}

// Gastos cuyo importe COMPLETO coincide con lo tipeado (sobre gestion_compras, no la vista).
async function obtenerImportes({ organizationId, businessId, q: qCrudo }) {
  const q = String(qCrudo ?? "").trim().slice(0, 40);
  const cond = importeCondition("c", q);
  if (!cond) return [];
  const where = sql.join([...buildPivotConditions({ tableAlias: "c", businessId }), cond], " AND ");
  const rows = await db.many(sql`
    SELECT
      c."rowId"                                                 AS "rowId",
      TO_CHAR(COALESCE(c."fechaManual", c.fecha), 'YYYY-MM-DD') AS fecha,
      COALESCE(c."importeManual", c.importe)                    AS importe,
      COALESCE(c."observacManual", c.observac)                  AS observac,
      cc.nombre                                                 AS "conceptoNombre",
      COALESCE(p.nombre, p.razon)                               AS "proveedorNombre",
      c.branch_id                                               AS "branchId",
      ${nombreSucursal}                                         AS "sucursalNombre"
    FROM gestion_compras c
    LEFT JOIN gestion_conceptos_caja cc ON cc.organization_id = ${organizationId}
                                       AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") = cc.codigo
    LEFT JOIN gestion_proveedores p     ON c."proveedorId" = p.id
    LEFT JOIN app_branches br           ON br.id = c.branch_id
    WHERE ${where}
    ORDER BY COALESCE(c."fechaManual", c.fecha) DESC
    LIMIT 20
  `);
  return rows.map((r) => ({
    id: `importe:${r.rowId}`,
    fecha: r.fecha,
    importe: String(r.importe),
    observac: r.observac,
    conceptoNombre: r.conceptoNombre,
    proveedorNombre: r.proveedorNombre,
    ...sucursalDe(r.branchId, r.sucursalNombre),
  }));
}

// ── Rubros visibles (⚙ de la barra) ────────────────────────────────────────────
// Whitelist estricta: el nombre de columna nunca sale directo del request.
const resolverCampo = (raw) => (VISIBILIDAD_FIELDS.includes(raw) ? raw : "visibleEnDashboard");
const DEFAULT_RUBRO = { visibleEnDashboard: true, visibleEnResultados: false };

async function obtenerRubrosVisibles({ organizationId, businessId, field }) {
  const campo = resolverCampo(field);
  const [rubros, sinRubro] = await Promise.all([
    db.many(sql`
      SELECT rc.codigo, rc.nombre, COALESCE(rv."${sql.raw(campo)}", ${sql.raw(DEFAULT_RUBRO[campo] ? "true" : "false")}) AS visible
      FROM gestion_rubros_concepto_caja rc
      LEFT JOIN gestion_rubros_visibilidad rv ON rv.business_id = ${businessId} AND rv.codigo = rc.codigo
      WHERE rc.organization_id = ${organizationId}
      ORDER BY rc.nombre`),
    db.one(sql`SELECT "${sql.raw(campo)}" AS visible FROM gestion_sin_rubro_config WHERE business_id = ${businessId}`),
  ]);
  // "Sin Rubro" es fijo (Diego 06/11/2026): siempre visible, no se puede apagar.
  void sinRubro;
  return [...rubros, { codigo: SIN_RUBRO_CODE, nombre: SIN_RUBRO_NOMBRE, visible: true, fijo: true }];
}

async function guardarRubroVisible({ organizationId, businessId, body }) {
  const codigo = typeof body?.codigo === "string" ? body.codigo : "";
  const visible = body?.visible;
  if (!codigo || typeof visible !== "boolean" || (body.field != null && !VISIBILIDAD_FIELDS.includes(body.field))) {
    throw new ErrorDatos("Invalid body");
  }
  const campo = resolverCampo(body.field);
  const col = sql.raw(`"${campo}"`);
  // "Sin Rubro" es sintético: su marca vive en gestion_sin_rubro_config.
  if (codigo === SIN_RUBRO_CODE) {
    if (!visible) throw new ErrorDatos("Sin rubro siempre se ve: es gasto y entra al total. Para sacarlo, asignale rubro.");
    await db.execute(sql`
      INSERT INTO gestion_sin_rubro_config (business_id, ${col}) VALUES (${businessId}, ${visible})
      ON CONFLICT (business_id) DO UPDATE SET ${col} = EXCLUDED.${col}`);
    return { ok: true };
  }
  const existe = await db.one(sql`SELECT 1 AS ok FROM gestion_rubros_concepto_caja WHERE organization_id = ${organizationId} AND codigo = ${codigo}`);
  if (!existe) {
    const e = new ErrorDatos("Rubro not found");
    e.status = 404;
    throw e;
  }
  await db.execute(sql`
    INSERT INTO gestion_rubros_visibilidad (business_id, codigo, ${col}) VALUES (${businessId}, ${codigo}, ${visible})
    ON CONFLICT (business_id, codigo) DO UPDATE SET ${col} = EXCLUDED.${col}`);
  return { ok: true };
}

module.exports = { obtenerSugerencias, obtenerObservaciones, obtenerImportes, obtenerRubrosVisibles, guardarRubroVisible };
