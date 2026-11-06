// Portado de lazarillo_gestion/lib/dashboard/pivot-por-proveedor.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { normalizarTexto } = require('../text-normalize');
const { construirEntidadIdProveedorTexto, codigoIdentidadProveedorTexto } = require('../proveedor-entidad-id');
const { mergeComposiciones } = require('./apertura-composicion');

// Hermana de buildPivotData (app/api/dashboard/pivot/route.ts): misma fuente
// de filas (SqlRow[], una por línea de compra con rubro/concepto/proveedor ya
// resueltos), pero agrupa Rubro → Proveedor → Concepto → línea. Ver spec
// docs/superpowers/specs/2026-09-18-vista-por-proveedor-nivel-rubro-design.md §3.2.
function buildPivotDataByProveedor(
  sqlRows,
  composicionPorProveedor
) {
  const rubroMap = new Map ();
  const proveedorMap = new Map ();
  const conceptoMap = new Map ();

  for (const row of sqlRows) {
    const {
      rubro_codigo,
      rubro_nombre,
      proveedor_id,
      proveedor_nombre,
      proveedor_texto_crudo,
      proveedor_codigo,
      concepto_codigo,
      concepto_nombre,
      mes,
      total,
      row_id,
      distribucion_id,
      fecha,
      observac,
      has_manual_override,
      business_id_origen,
      branch_id_origen,
    } = row;

    const t = typeof total === "object" && total !== null ? Number(total.toString()) : Number(total);

    // provKeyOriginal identifica al proveedor a secas (usado para la clave de
    // composición, que no sabe de rubros); provKey lo compone con el rubro
    // para que el mismo proveedor genere un nodo distinto por cada rubro en
    // el que tiene compras (mismo criterio de duplicación que ya usa
    // buildPivotData con sus proveedores-hoja).
    //
    // Sin proveedor_id, proveedor_nombre ya trae el texto crudo del ERP (o el
    // literal "Sin Proveedor" si tampoco hay texto — ver COALESCE en
    // app/api/dashboard/pivot/route.ts) — se usa normalizado como clave para
    // no fragmentar el mismo proveedor por un typo de mayúsculas/tildes en
    // una carga futura (spec 2026-09-19-agrupar-sin-proveedor-por-texto-crudo-design.md §3.2).
    // Con proveedor_id null, el mismo nombre puede corresponder a personas
    // reales distintas (ej. "Abril" con código 368 y otra "Abril" con código
    // 670) — sin el código en la clave, sus compras se sumarían en un solo
    // nodo. Sin código en la compra (proveedor_codigo null), no hay forma de
    // desambiguar: se mantiene el agrupado solo por nombre, igual que antes.
    // Ver docs/superpowers/specs/2026-09-28-codigo-empleado-proveedor-design.md §3.4.
    const provKeyOriginal = proveedor_id != null
      ? String(proveedor_id)
      : construirEntidadIdProveedorTexto(normalizarTexto(proveedor_nombre), proveedor_codigo);
    // En un balde genérico (GASTOS VARIOS) el código de esta compra no es el
    // del nodo — ver codigoIdentidadProveedorTexto.
    const codigoNodo = proveedor_id != null
      ? proveedor_codigo
      : codigoIdentidadProveedorTexto(normalizarTexto(proveedor_nombre), proveedor_codigo);
    const provKey = `${rubro_codigo}|${provKeyOriginal}`;
    const concKey = `${provKey}|${concepto_codigo}`;

    if (!rubroMap.has(rubro_codigo)) {
      rubroMap.set(rubro_codigo, {
        level: 0,
        id: rubro_codigo,
        nombre: rubro_nombre,
        rubroCodigo: rubro_codigo,
        values: {},
        rowTotal: 0,
        children: [],
      });
    }
    const rubro = rubroMap.get(rubro_codigo);

    if (!proveedorMap.has(provKey)) {
      const proveedor = {
        level: 1,
        id: provKey,
        // Empleado con apellido (solo para mostrar; la clave sigue con el texto crudo).
        nombre: row.proveedor_display ?? proveedor_nombre,
        proveedorId: proveedor_id,
        // Ojo: el filtro de drill-down sale de la columna CRUDA, no del
        // proveedor_nombre del COALESCE — cuando no hay ni proveedor ni texto,
        // proveedor_nombre trae el literal 'Sin Proveedor', que no matchea
        // ninguna fila real de c.proveedor y dejaba el modal vacío. Con null
        // acá, la UI cae a su rama sinProveedor:true.
        proveedorTexto: proveedor_id != null ? null : proveedor_texto_crudo,
        // Mismo valor que ya usa condicionMatchNivel (lib/apertura/motor.ts) y
        // resolverEntidadIdProveedor (lib/apertura/reevaluacion.ts) para nivel
        // "proveedor" — la UI nunca recomputa normalizarTexto por su cuenta,
        // así la clave de agrupación y el entidadId de una regla nueva son
        // byte-idénticos por construcción (docs/superpowers/specs/2026-09-20-
        // apertura-proveedor-texto-crudo-design.md §4.3).
        entidadIdProveedor: provKeyOriginal,
        codigo: codigoNodo,
        rubroCodigo: rubro_codigo,
        values: {},
        rowTotal: 0,
        children: [],
      };
      proveedorMap.set(provKey, proveedor);
      rubro.children.push(proveedor);
    }
    const proveedor = proveedorMap.get(provKey);

    if (!conceptoMap.has(concKey)) {
      const concepto = {
        level: 2,
        id: concKey,
        nombre: concepto_nombre,
        conceptoCodigo: concepto_codigo,
        rubroCodigo: rubro_codigo,
        proveedorId: proveedor_id,
        // Misma fuente que el nodo de proveedor (ver comentario arriba).
        proveedorTexto: proveedor_id != null ? null : proveedor_texto_crudo,
        codigo: codigoNodo,
        values: {},
        rowTotal: 0,
        children: [],
        composicion: composicionPorProveedor[`${concepto_codigo}|${provKeyOriginal}`],
      };
      conceptoMap.set(concKey, concepto);
      proveedor.children.push(concepto);
    }
    const concepto = conceptoMap.get(concKey);

    const linea = {
      level: 3,
      id: `${concKey}|${row_id}|${distribucion_id ?? "orig"}${row.pago_ref ? `|${row.pago_ref}` : ""}`,
      rowId: row_id,
      distribucionId: distribucion_id,
      conceptoCodigo: concepto_codigo,
      fecha: fecha ?? null,
      observac: observac ?? null,
      importe: t,
      hasManualOverride: !!has_manual_override,
      businessIdOrigen: business_id_origen, // en gestion: localIdOrigen (dónde se cargó la compra)
      branchIdOrigen: branch_id_origen,     // en gestion: puntoDeVentaIdOrigen
      values: { [mes]: t },
      rowTotal: t,
    };
    concepto.children.push(linea);
  }

  // Roll up bottom-up: línea → concepto → proveedor → rubro.
  for (const [, rubro] of rubroMap) {
    for (const proveedor of rubro.children) {
      for (const concepto of proveedor.children) {
        for (const linea of concepto.children) {
          for (const [m, val] of Object.entries(linea.values)) {
            const mn = Number(m);
            concepto.values[mn] = (concepto.values[mn] ?? 0) + val;
          }
          concepto.rowTotal += linea.rowTotal;
        }
        // composicionTotal del concepto: fusiona su propia composición mensual
        // (si tiene regla aplicada) en una sola composición anual. El
        // "sin regla" son los meses SIN composicion — no `rowTotal - suma`,
        // porque composicion.total es el reparto completo sin filtrar por
        // PDV (ver mergeComposiciones) y no es comparable contra rowTotal
        // cuando hay un filtro de PDV activo.
        const mesesSinComposicion = Object.keys(concepto.values)
          .map(Number)
          .filter((m) => !concepto.composicion?.[m]);
        const totalSinReglaConcepto = mesesSinComposicion.reduce((s, m) => s + concepto.values[m], 0);
        concepto.composicionTotal = mergeComposiciones(
          concepto.composicion ? Object.values(concepto.composicion) : [],
          totalSinReglaConcepto
        );
        for (const [m, val] of Object.entries(concepto.values)) {
          const mn = Number(m);
          proveedor.values[mn] = (proveedor.values[mn] ?? 0) + val;
        }
        proveedor.rowTotal += concepto.rowTotal;
      }
      // composicion del proveedor: fusiona la composición de sus conceptos
      // hijos (por mes y en el total anual) — ver tooltip del total de
      // proveedor, que hasta acá no tenía de dónde sacar este dato.
      const mesesConComposicion = new Set ();
      for (const concepto of proveedor.children) {
        for (const m of Object.keys(concepto.composicion ?? {})) mesesConComposicion.add(Number(m));
      }
      for (const mes of mesesConComposicion) {
        const totalSinReglaMes = proveedor.children
          .filter((c) => !c.composicion?.[mes])
          .reduce((s, c) => s + (c.values[mes] ?? 0), 0);
        const merged = mergeComposiciones(
          proveedor.children.map((c) => c.composicion?.[mes]),
          totalSinReglaMes
        );
        if (merged) {
          proveedor.composicion ??= {};
          proveedor.composicion[mes] = merged;
        }
      }
      const totalSinReglaAnual = proveedor.children
        .filter((c) => !c.composicionTotal)
        .reduce((s, c) => s + c.rowTotal, 0);
      proveedor.composicionTotal = mergeComposiciones(
        proveedor.children.map((c) => c.composicionTotal),
        totalSinReglaAnual
      );
      for (const [m, val] of Object.entries(proveedor.values)) {
        const mn = Number(m);
        rubro.values[mn] = (rubro.values[mn] ?? 0) + val;
      }
      rubro.rowTotal += proveedor.rowTotal;
    }
  }

  const columnTotals = {};
  let grandTotal = 0;
  for (const [, rubro] of rubroMap) {
    for (const [m, val] of Object.entries(rubro.values)) {
      const mn = Number(m);
      columnTotals[mn] = (columnTotals[mn] ?? 0) + val;
    }
    grandTotal += rubro.rowTotal;
  }

  // Sin Rubro va siempre primero, así se ve (Diego 06/11/2026); si no tiene nada, no viene.
  const rows = Array.from(rubroMap.values());
  rows.sort((a, b) => (b.rubroCodigo === "__sin_rubro") - (a.rubroCodigo === "__sin_rubro"));
  return { rows, columnTotals, grandTotal };
}

module.exports = { buildPivotDataByProveedor };
