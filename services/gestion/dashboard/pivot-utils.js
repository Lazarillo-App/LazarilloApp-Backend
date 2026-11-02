// Portado de lazarillo_gestion/lib/dashboard/pivot-utils.ts (TypeScript → JavaScript, misma lógica).
'use strict';



function toNumber(v) {
  return typeof v === "object" && v !== null ? Number(v.toString()) : Number(v);
}

const EPSILON = 0.01;

function hasValue(v) {
  return (v ?? 0) > EPSILON;
}

// Velocidad (Diego 27/10): abrir un concepto con ~1.500 registros tardaba ~1 s en
// dibujarse. Se muestran de a TANDA_PIVOT y una fila "mas" ofrece ver el resto.
// Totales, celdas y búsqueda siguen sobre todos los registros (vienen del servidor).
const TANDA_PIVOT = 100;

function getValue(row, col) {
  return col === "total" ? row.rowTotal : (row.values[col] ?? 0);
}

/** Compara por valor y, ante empate, desempata alfabéticamente por nombre (PivotLineaRow no tiene nombre y queda sin desempate). */
function compareRows(a, b, col, factor) {
  const diff = getValue(a, col) - getValue(b, col);
  if (diff !== 0) return factor * diff;
  const nombreA = "nombre" in a ? a.nombre : "";
  const nombreB = "nombre" in b ? b.nombre : "";
  return nombreA.localeCompare(nombreB, "es", { sensitivity: "base" });
}

/** Ordena cada nivel del árbol pivot sin mutar el original. */
function sortPivotRows(
  rows,
  col,
  dir
) {
  const factor = dir === "desc" ? -1 : 1;
  return [...rows]
    .sort((a, b) => compareRows(a, b, col, factor))
    .map((rubro) => ({
      ...rubro,
      children: [...rubro.children]
        .sort((a, b) => compareRows(a, b, col, factor))
        .map((concepto) => ({
          ...concepto,
          children: [...concepto.children].sort(
            (a, b) => compareRows(a, b, col, factor)
          ),
        })),
    }));
}

/**
 * Aplana el árbol pivot respetando el estado de expansión.
 * maxDepth=2: renderiza rubro+concepto (ventas — sin nivel proveedor)
 * maxDepth=3: renderiza rubro+concepto+proveedor (compras)
 */
function flattenRows(
  pivotData,
  expanded,
  maxDepth,
  // Cuántos registros mostrar por concepto (id → cantidad). Sin mapa: todos.
  mostrar
) {
  const result = [];
  for (const rubro of pivotData.rows) {
    result.push({ type: "rubro", data: rubro });
    if (!expanded.has(rubro.id)) continue;
    for (const concepto of rubro.children) {
      result.push({ type: "concepto", data: concepto });
      if (maxDepth < 3 || !expanded.has(concepto.id)) continue;
      const tope = mostrar ? (mostrar.get(concepto.id) ?? TANDA_PIVOT) : Infinity;
      const hijos = concepto.children.length > tope ? concepto.children.slice(0, tope) : concepto.children;
      for (const prov of hijos) {
        result.push({ type: "proveedor", data: prov });
      }
      if (hijos.length < concepto.children.length) {
        result.push({
          type: "mas",
          data: { id: `${concepto.id}|mas`, conceptoId: concepto.id, mostrados: hijos.length, total: concepto.children.length },
        });
      }
    }
  }
  return result;
}

/** Ordena el árbol "por proveedor" — misma lógica que sortPivotRows, sobre los tipos nuevos, con un nivel más (rubro). */
function sortPivotRowsPorProveedor(
  rows,
  col,
  dir
) {
  const factor = dir === "desc" ? -1 : 1;
  return [...rows]
    .sort((a, b) => compareRows(a, b, col, factor))
    .map((rubro) => ({
      ...rubro,
      children: [...rubro.children]
        .sort((a, b) => compareRows(a, b, col, factor))
        .map((proveedor) => ({
          ...proveedor,
          children: [...proveedor.children]
            .sort((a, b) => compareRows(a, b, col, factor))
            .map((concepto) => ({
              ...concepto,
              children: [...concepto.children].sort(
                (a, b) => compareRows(a, b, col, factor)
              ),
            })),
        })),
    }));
}

/** Aplana el árbol "por proveedor" respetando expansión — siempre 4 niveles (no hay variante maxDepth como en Ventas). */
function flattenRowsPorProveedor(
  pivotData,
  expanded
) {
  const result = [];
  for (const rubro of pivotData.rows) {
    result.push({ type: "rubroTop", data: rubro });
    if (!expanded.has(rubro.id)) continue;
    for (const proveedor of rubro.children) {
      result.push({ type: "proveedorSub", data: proveedor });
      if (!expanded.has(proveedor.id)) continue;
      for (const concepto of proveedor.children) {
        result.push({ type: "conceptoSub", data: concepto });
        if (!expanded.has(concepto.id)) continue;
        for (const linea of concepto.children) {
          result.push({ type: "linea", data: linea });
        }
      }
    }
  }
  return result;
}

module.exports = { toNumber, EPSILON, hasValue, TANDA_PIVOT, sortPivotRows, flattenRows, sortPivotRowsPorProveedor, flattenRowsPorProveedor };
