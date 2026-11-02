// Portado de lazarillo_gestion/lib/dashboard/apertura-composicion.ts (TypeScript → JavaScript, misma lógica).
'use strict';


const { normalizarTexto } = require('../text-normalize');
const { construirEntidadIdProveedorTexto } = require('../proveedor-entidad-id');

const toNum = (x) =>
  typeof x === "object" && x !== null ? Number(x.toString()) : Number(x);

// Arma el mapa concepto -> mes -> { total (= 100%), destinos[] } que consume el
// tooltip de pivot-table. `total` viene de importe_original YA deduplicado por
// compra en SQL (ver app/api/dashboard/pivot/route.ts) — acá solo se suman las
// filas ya agregadas.
function buildComposicion(
  destinoRows,
  originalRows
) {
  const out = {};

  const ensure = (concepto, mes) => {
    out[concepto] ??= {};
    out[concepto][mes] ??= { total: 0, destinos: [] };
    return out[concepto][mes];
  };

  for (const row of originalRows) {
    ensure(row.concepto_codigo, row.mes).total += toNum(row.importe_original);
  }
  for (const row of destinoRows) {
    const bucket = ensure(row.concepto_codigo, row.mes);
    const pct = toNum(row.pct);
    const importe = toNum(row.importe_calculado);
    // La SQL ahora particiona estas filas también por proveedor_id (para poder
    // alimentar buildComposicionPorProveedor) — acá se vuelven a fusionar por
    // (nombre, pct) para reproducir exactamente el agrupamiento que la propia
    // query hacía antes de esa partición (GROUP BY ..., destino_nombre, da.porcentaje).
    const existente = bucket.destinos.find((d) => d.nombre === row.destino_nombre && d.pct === pct);
    if (existente) {
      existente.importe += importe;
    } else {
      bucket.destinos.push({ nombre: row.destino_nombre, pct, importe });
    }
  }
  return out;
}

// Misma idea que buildComposicion, pero indexada también por proveedor: el
// tooltip de la vista "por Proveedor" necesita el reparto de ESE proveedor en
// ESE concepto, no el total cruzando todos los proveedores del concepto (que
// es lo que devuelve buildComposicion) — ver spec §3.3.
//
// Sin proveedor_id, la clave usa el texto crudo normalizado (mismo formato
// `texto:<normalizado>` que arma provKeyOriginal en pivot-por-proveedor.ts,
// para que el lookup por esa clave encuentre esta entrada) en vez de un
// sentinela fijo — así "Diego" y "GASTOS VARIOS" no comparten composición
// aunque ninguno tenga proveedor real (spec 2026-09-19-agrupar-sin-proveedor-por-texto-crudo-design.md §3.3).
function buildComposicionPorProveedor(
  destinoRows,
  originalRows
) {
  const out = {};

  // Mismo formato que provKeyOriginal en pivot-por-proveedor.ts — ver comentario
  // ahí sobre por qué el código hace falta para no mezclar personas distintas
  // que comparten nombre.
  const key = (concepto, proveedorId, proveedorNombre, proveedorCodigo) => {
    if (proveedorId != null) return `${concepto}|${proveedorId}`;
    return `${concepto}|${construirEntidadIdProveedorTexto(normalizarTexto(proveedorNombre), proveedorCodigo)}`;
  };

  const ensure = (concepto, proveedorId, proveedorNombre, proveedorCodigo, mes) => {
    const k = key(concepto, proveedorId, proveedorNombre, proveedorCodigo);
    out[k] ??= {};
    out[k][mes] ??= { total: 0, destinos: [] };
    return out[k][mes];
  };

  for (const row of originalRows) {
    ensure(row.concepto_codigo, row.proveedor_id, row.proveedor_nombre, row.proveedor_codigo, row.mes).total += toNum(row.importe_original);
  }
  // Misma fusión por (nombre, pct) que buildComposicion, por una razón
  // análoga: el GROUP BY de la SQL particiona también por proveedor_nombre,
  // pero la clave de este bucket usa proveedor_id cuando existe. Un proveedor
  // real cuyo maestro no tiene nombre NI razón hace que el COALESCE caiga a
  // c.proveedor (que varía fila a fila), fragmentando un mismo proveedor_id en
  // varias filas SQL que caen todas en este bucket — sin fusionar, el mismo
  // destino aparecería duplicado en el tooltip.
  for (const row of destinoRows) {
    const bucket = ensure(row.concepto_codigo, row.proveedor_id, row.proveedor_nombre, row.proveedor_codigo, row.mes);
    const pct = toNum(row.pct);
    const importe = toNum(row.importe_calculado);
    const existente = bucket.destinos.find((d) => d.nombre === row.destino_nombre && d.pct === pct);
    if (existente) {
      existente.importe += importe;
    } else {
      bucket.destinos.push({ nombre: row.destino_nombre, pct, importe });
    }
  }
  return out;
}

// Umbral bajo el cual un `totalSinRegla` se considera error de redondeo
// flotante, no un remanente real sin apertura — evita un bucket "Sin
// apertura" espurio de centavos (o negativo).
const EPSILON_SIN_APERTURA = 0.01;

// Fusiona N ComposicionMes (de distintos conceptos de un mismo proveedor en
// un mes, o de distintos meses de un mismo concepto/proveedor en el año) en
// una sola composición agregada, sumando importe por destino (agrupado por
// nombre).
//
// OJO: `composicion.total` de cada parte es SIEMPRE el reparto completo sin
// filtrar por PDV (ver app/api/dashboard/pivot/route.ts, comentario sobre
// `conditionsComposicion` — decisión a propósito para que el tooltip no
// desaparezca al filtrar por un PDV destino). Por eso el total agregado acá
// NO se fuerza contra el valor (posiblemente filtrado) de la celda que
// dispara el tooltip — sería mezclar dos bases distintas y da porcentajes
// sin sentido (>100%). En cambio, `totalSinRegla` lo arma el caller sumando
// el `values`/`rowTotal` de los hijos que NO tienen composicion — para esos
// sí es válido usar el valor (filtrado o no) tal cual, porque un concepto
// sin regla no se reparte: su valor ES su total real.
function mergeComposiciones(
  partes,
  totalSinRegla
) {
  if (partes.every((p) => p === undefined)) return undefined;

  const importePorDestino = new Map ();
  let totalConRegla = 0;
  for (const parte of partes) {
    if (!parte) continue;
    totalConRegla += parte.total;
    for (const d of parte.destinos) {
      importePorDestino.set(d.nombre, (importePorDestino.get(d.nombre) ?? 0) + d.importe);
    }
  }

  const sinRegla = totalSinRegla > EPSILON_SIN_APERTURA ? totalSinRegla : 0;
  const total = totalConRegla + sinRegla;
  const pct = (importe) => (total !== 0 ? (importe / total) * 100 : 0);
  const destinos = Array.from(importePorDestino.entries()).map(([nombre, importe]) => ({
    nombre,
    pct: pct(importe),
    importe,
  }));

  if (sinRegla > 0) {
    destinos.push({ nombre: "Sin apertura", pct: pct(sinRegla), importe: sinRegla });
  }

  return { total, destinos };
}

module.exports = { buildComposicion, buildComposicionPorProveedor, mergeComposiciones };
