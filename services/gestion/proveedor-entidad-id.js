// Portado de lazarillo_gestion/lib/proveedor-entidad-id.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Clave "texto:<normalizado>" (proveedor sin proveedorId real) con sufijo
// opcional "|codigo:<codigo>" que desambigua personas reales distintas que
// comparten nombre (ej. dos "Abril" con código 368 y 670 — ver
// docs/superpowers/specs/2026-09-28-codigo-empleado-proveedor-design.md
// §3.4/§3.6). Construida en 3 lugares (lib/dashboard/pivot-por-proveedor.ts,
// lib/dashboard/apertura-composicion.ts, lib/apertura/reevaluacion.ts) y
// parseada en un 4to (lib/apertura/motor.ts) — extraída acá para que las 4
// nunca puedan divergir en el formato (hallazgo de la revisión final de rama:
// estaban duplicadas sin test que probara que coincidían).
const PREFIJO_TEXTO = "texto:";
const SEPARADOR_CODIGO = "|codigo:";

// Baldes genéricos que no son una identidad real a desambiguar — fragmentarlos
// por código solo generaría ruido (una fila por código en vez de un balde
// consolidado), así que nunca llevan el sufijo aunque la compra traiga código:
// - "sinproveedor": sin proveedorId NI texto crudo del ERP (spec §2.7).
// - "gastosvarios": en el ERP su CODIGO es de ítem, no de persona (~310
//   códigos, casi uno por concepto) — con sufijo aparecía un "Gastos Varios"
//   por concepto en la vista por proveedor (reporte 13-oct-2026, revierte
//   para este nombre el §2.5 del spec 2026-09-28-codigo-empleado-proveedor).
const BALDES_SIN_CODIGO = new Set(["sinproveedor", "gastosvarios"]);

// Código que identifica al proveedor de texto crudo junto con su nombre, o
// null si el nombre es un balde genérico. Exportado para que el pivot no
// cuelgue del nodo el código de una sola compra del balde: el drill-down lo
// usa como filtro y el modal no sumaría lo de la celda.
function codigoIdentidadProveedorTexto(normalizado, codigo) {
  return BALDES_SIN_CODIGO.has(normalizado) ? null : codigo;
}

function construirEntidadIdProveedorTexto(normalizado, codigo) {
  const base = `${PREFIJO_TEXTO}${normalizado}`;
  const codigoIdentidad = codigoIdentidadProveedorTexto(normalizado, codigo);
  if (codigoIdentidad == null) return base;
  return `${base}${SEPARADOR_CODIGO}${codigoIdentidad}`;
}

// Inversa de construirEntidadIdProveedorTexto — separa el nombre normalizado
// del código. Devuelve null si entidadId no tiene el prefijo "texto:" (es un
// proveedorId real o un entidadId de otro nivel, no de esta función).
function parsearEntidadIdProveedorTexto(entidadId) {
  if (!entidadId.startsWith(PREFIJO_TEXTO)) return null;
  const resto = entidadId.slice(PREFIJO_TEXTO.length);
  const separador = resto.indexOf(SEPARADOR_CODIGO);
  if (separador === -1) return { normalizado: resto, codigo: null };
  return { normalizado: resto.slice(0, separador), codigo: resto.slice(separador + SEPARADOR_CODIGO.length) };
}

// Durante la ventana entre este deploy y la migración de las reglas de
// Apertura ya existentes en producción (spec §4, plan aparte todavía no
// escrito), las reglas viejas siguen guardadas con el entidadId SIN código
// para casi todos los proveedores de texto crudo. Si la compra resuelve a un
// entidadId CON código, hay que poder seguir encontrando esa regla vieja —
// se prueban ambas variantes, con la específica por código primero (gana si
// compite con una vieja, ver reevaluarCompra). Para un entidadId que no es
// "texto:..." (proveedorId real) o que ya no tiene sufijo, devuelve solo el
// valor tal cual — sin variantes de más.
function candidatosEntidadIdProveedor(entidadId) {
  const parsed = parsearEntidadIdProveedorTexto(entidadId);
  if (parsed === null || parsed.codigo === null) return [entidadId];
  return [entidadId, construirEntidadIdProveedorTexto(parsed.normalizado, null)];
}

module.exports = { codigoIdentidadProveedorTexto, construirEntidadIdProveedorTexto, parsearEntidadIdProveedorTexto, candidatosEntidadIdProveedor };
