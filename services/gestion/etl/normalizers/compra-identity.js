// Portado de lazarillo_gestion/lib/etl/normalizers/compra-identity.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { createHash } = require('crypto');
const { trim, normalizeText, excelDateToISO, toDecimalStr } = require('../helpers');
const { decimalCanonico } = require('../../decimal-canonico');

// Normaliza un importe ya convertido a string decimal a través de
// Prisma.Decimal, así "1500.50" (fila cruda del Excel) y "1500.5" (lo que
// devuelve Prisma.Decimal#toString() al leer el mismo valor desde la base)
// producen el mismo string canónico — sin esto, computeCompraRowId podía
// discrepar entre compraIdentityFromRawRow y compraIdentityFromDbRecord para
// el mismo importe con formato distinto (riesgo real solo en las compras
// sin comprobante, donde importe entra al hash).
// En Lazarillo no hay Prisma: decimalCanonico reproduce Prisma.Decimal#toString()
// exacto (mismo rowId que gestion para el mismo dato).
function canonicalDecimal(raw) {
  if (raw == null) return null;
  // no debería pasar para un valor que ya pasó toDecimalStr, pero este módulo nunca debe tirar
  return decimalCanonico(raw) ?? raw;
}

// Códigos del ERP en compras que difieren del COD_CPB en detalle_compras.
const CODE_ALIASES = {
  TIC: "Z",
};

// Convierte "A 0606-00761530" → "A060600761530" (mismo formato que detalle_compras.comprobante)
function parseComprobanteFromDetalle(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const match = s.match(/^(\S+)\s+(\d+)-(\d+)$/);
  if (!match) return null;
  const [, cod, num1, num2] = match;
  const normalizedCod = CODE_ALIASES[cod.toUpperCase()] ?? cod.toUpperCase();
  return normalizedCod + num1.padStart(4, "0") + num2.padStart(8, "0");
}

// Un "Tic" (ticket) no es un documento único como una factura real — el mismo
// número de ticket puede repetirse para compras genuinamente distintas el
// mismo día (hallazgo real en datos de producción: dos compras de catering
// con el mismo Tic y distinto importe/observación). No se considera
// comprobante confiable para identidad — solo afecta qué rama de
// computeCompraRowId se usa; el valor aliasado (TIC -> Z) se sigue guardando
// tal cual en la columna `comprobante` para vincular con detalle_compras
// (parseComprobanteFromDetalle sigue igual, esto no lo toca).
function esComprobanteConfiable(detalleRaw) {
  return !/^tic\s/i.test(String(detalleRaw ?? "").trim());
}

// Identidad partida: si hay comprobante parseable y confiable (documento real
// del ERP), el hash NO incluye importe — un cambio de importe para el mismo
// comprobante debe tratarse como actualización del mismo registro, no como
// transacción nueva (spec Apertura de Gastos, sección 10 / CA-12). Se incluye
// OBSERVAC igual: un mismo número de comprobante puede repetirse legítimamente
// entre compras distintas (hallazgo real: "Iva compensacion" reutiliza el
// comprobante de la factura que referencia para cada ajuste; una factura con
// múltiples ítems puede registrarse como varias compras con el mismo
// comprobante) — OBSERVAC es lo que las distingue en esos casos reales.
// Sin comprobante confiable (~40% de las filas: sueldos, alquiler, gastos
// sueltos, tickets) no hay forma de distinguir una corrección de una
// transacción distinta con los mismos campos descriptivos, así que se
// preserva el comportamiento anterior con IMPORTE incluido en el hash.
function computeCompraRowId(input) {
  const keyParts = input.comprobante
    ? [input.codCga, input.fechaISO, input.codigo, input.concepto, input.comprobante, input.observacNormalizado]
    : [input.codCga, input.fechaISO, input.codigo, input.concepto, input.detalle, input.observacNormalizado, input.importe];
  const key = keyParts.map((v) => v ?? "").join("|");
  return createHash("sha256").update(key).digest("hex").substring(0, 24);
}

// Adaptador para una fila cruda del Excel del ERP (ETL en vivo). Los campos se
// normalizan igual que lo hace compraRowSchema (trim/normalizeText) para que el
// resultado sea idéntico al de compraIdentityFromDbRecord sobre el mismo dato ya
// persistido — es la propiedad que garantiza que reimportar el mismo archivo
// actualiza el registro existente en vez de crear uno nuevo.
function compraIdentityFromRawRow(r) {
  return {
    codCga: trim(r["COD_CGA"]),
    fechaISO: excelDateToISO(r["FECHA"]),
    codigo: trim(r["CODIGO"]),
    concepto: trim(r["CONCEPTO"]),
    comprobante: esComprobanteConfiable(r["DETALLE"]) ? parseComprobanteFromDetalle(r["DETALLE"]) : null,
    detalle: trim(r["DETALLE"]),
    observacNormalizado: normalizeText(r["OBSERVAC"]),
    importe: canonicalDecimal(toDecimalStr(r["IMPORTE"])),
  };
}

// Adaptador para una compra ya persistida (usado por el script de migración de
// rowId). fecha se recompone a ISO desde el Date almacenado — safeDate() en el
// ETL siempre construye el Date a partir de un string 'YYYY-MM-DD' (medianoche
// UTC), así que toISOString().slice(0,10) reconstruye el mismo string exacto.
function compraIdentityFromDbRecord(c) {
  return {
    codCga: c.codCga,
    fechaISO: c.fecha ? c.fecha.toISOString().slice(0, 10) : null,
    codigo: c.codigo,
    concepto: c.concepto,
    comprobante: esComprobanteConfiable(c.detalle) ? c.comprobante : null,
    detalle: c.detalle,
    observacNormalizado: c.observac,
    importe: canonicalDecimal(c.importe != null ? c.importe.toString() : null),
  };
}

// Subconjunto estable de CompraIdentityInput usado para reconciliar una fila
// "nueva" (hash de computeCompraRowId sin match) contra una fila existente
// que sea la misma compra real editada por el ERP después de la carga
// inicial — ver docs/superpowers/specs/2026-09-29-reconciliacion-identidad-
// compras-design.md. Deliberadamente NO incluye comprobante/detalle/
// observacNormalizado: son justamente los campos que el ERP edita post-carga
// (comprobante que aparece, observación que se corrige) y por eso rompen el
// hash de computeCompraRowId sin ser, en los hechos, una transacción nueva.
function computeCompraAnchor(input) {
  return {
    codCga: input.codCga,
    fechaISO: input.fechaISO,
    codigo: input.codigo,
    concepto: input.concepto,
    importe: input.importe,
  };
}

// Decide si una fila "nueva" debe reconciliarse con una de las filas
// existentes que comparten su ancla. Exactamente 1 candidato -> se
// reconcilia con esa. 0 candidatos -> nada que reconciliar (se maneja antes
// de llamar a esta función). 2+ candidatos -> ambiguo, no se fusiona (evita
// el caso real de una factura con más de un ítem que coincide en ancla —
// ver spec, caso "mochila/válvula").
function pickReconciliationCandidate (candidatos) {
  return candidatos.length === 1 ? candidatos[0] : null;
}

// "Relación de prefijo": el observac más corto de las dos filas es un
// prefijo textual del más largo — señal de que el ERP amplió/corrigió la
// misma descripción en vez de tratarse de dos compras reales distintas que
// comparten comprobante por casualidad (caso Mochila/Válvula, spec §1).
// Nota: un observac vacío/null del lado más corto pasa trivialmente
// ("".startsWith(...) siempre da true) — no se bloquea acá porque el
// llamador (esReconciliacionSegura) solo usa esta función cuando ya hay
// comprobante compartido, una señal real por sí sola.
function tienenRelacionDePrefijo(obsA, obsB) {
  const a = obsA ?? "";
  const b = obsB ?? "";
  const [corto, largo] = a.length <= b.length ? [a, b] : [b, a];
  return largo.startsWith(corto);
}

// Predicado único compartido entre la reconciliación hacia adelante (import
// en vivo, ver normalizeCompras en compras.ts) y la limpieza retroactiva
// (scripts/reconciliar-duplicados-erp.ts) — ambas rutas fusionan/borran
// compras que comparten ancla (computeCompraAnchor) y ambas necesitan el
// MISMO criterio de seguridad para no confundir dos compras reales
// distintas con la misma compra editada por el ERP (hallazgo Critical +
// Important de la revisión final de rama, 29-sep-2026):
//
// 1) Ambas filas con comprobante no nulo pero DISTINTO -> nunca es la misma
//    compra real (ninguno de los dos mecanismos de este feature — comprobante
//    que aparece después, observac que se corrige — produce dos comprobantes
//    no nulos distintos para la misma compra real). Insegura siempre, sin
//    importar esDistribuido ni el texto de observac.
// 2) Ambas filas con el MISMO comprobante no nulo -> exige relación de
//    prefijo entre observac (caso Mochila/Válvula: mismo comprobante, dos
//    ítems reales distintos de una misma factura).
// 3) EXACTAMENTE un lado con comprobante null (XOR) -> es el caso "comprobante
//    aparece después", el más inequívoco del diseño; no se bloquea por este
//    chequeo (sigue sujeto al chequeo de localId de abajo).
// 4) AMBOS lados con comprobante null -> insegura. La razón de (3) — "el ERP
//    completó un comprobante que antes no tenía" — no aplica cuando ninguna
//    de las dos filas tuvo nunca comprobante: no hay documento que vincule
//    las dos filas como la misma transacción, y coincidir en el ancla
//    (codCga+fecha+codigo+concepto+importe) no alcanza — dos transacciones
//    genuinamente distintas sin comprobante (pagos en efectivo, adelantos de
//    sueldo, honorarios informales) colisionan en el ancla por casualidad con
//    más frecuencia de la esperada (hallazgo real: dry-run de
//    reconciliar-duplicados-erp.ts contra producción, 29-sep-2026 — 654 de
//    706 pares que el script iba a fusionar tenían comprobante null en AMBOS
//    lados y NO eran duplicados reales, ej. "Sergio Profe Fc" vs "Ricardo
//    Profe Fc", pagos a docentes distintos).
// 5) localId conocido de ambos lados y distinto -> insegura (hallazgo real:
//    ERPs de distintos locales pueden reusar código de proveedor/concepto
//    para negocios no relacionados — ver memoria del proyecto, incidente
//    Alta Nuñez-Comercio). Se evalúa solo si 1-4 no determinaron ya que es
//    insegura.
function esReconciliacionSegura(
  a,
  b
) {
  if (a.comprobante != null && b.comprobante != null) {
    if (a.comprobante !== b.comprobante) {
      return { segura: false, motivo: "comprobantes_distintos" };
    }
    if (!tienenRelacionDePrefijo(a.observac, b.observac)) {
      return { segura: false, motivo: "sin_relacion_de_prefijo" };
    }
  } else if (a.comprobante == null && b.comprobante == null) {
    return { segura: false, motivo: "ambas_sin_comprobante" };
  }
  if (a.localId != null && b.localId != null && a.localId !== b.localId) {
    return { segura: false, motivo: "localId_distinto" };
  }
  return { segura: true };
}

// Renombre de concepto en MaxiRest (hallazgo 25/10/2026: "Inflable" pasó a
// llamarse "Inflable Alquiler" y los gastos sin comprobante se duplicaron,
// porque el nombre del concepto entra en el hash y en el ancla). Es la MISMA
// compra si coinciden código de concepto, fecha, código, importe, comprobante
// (o ninguno de los dos tiene) y la observación es idéntica y no vacía; solo
// cambió el nombre. Regla dura de Diego: nunca duplicar registros.
function esRenombreDeConcepto(
  nueva,
  existente
) {
  if (!nueva.observac || nueva.observac !== existente.observac) return false;
  if ((nueva.concepto ?? "") === (existente.concepto ?? "")) return false;
  return (
    nueva.codCga === existente.codCga &&
    nueva.fechaISO === existente.fechaISO &&
    nueva.codigo === existente.codigo &&
    nueva.importe === existente.importe &&
    (nueva.comprobante ?? null) === (existente.comprobante ?? null)
  );
}

module.exports = { canonicalDecimal, parseComprobanteFromDetalle, computeCompraRowId, compraIdentityFromRawRow, compraIdentityFromDbRecord, computeCompraAnchor, pickReconciliationCandidate, esReconciliacionSegura, esRenombreDeConcepto };
