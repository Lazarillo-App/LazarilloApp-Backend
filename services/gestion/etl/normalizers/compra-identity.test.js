// Portado de lazarillo_gestion/lib/etl/normalizers/compra-identity.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../../test-utils/vitest');
const { parseComprobanteFromDetalle, computeCompraRowId, compraIdentityFromRawRow, compraIdentityFromDbRecord, computeCompraAnchor, pickReconciliationCandidate, esReconciliacionSegura } = require('./compra-identity');

describe("parseComprobanteFromDetalle", () => {
  it("parsea 'A 0606-00761530' al formato compacto con zero-padding", () => {
    expect(parseComprobanteFromDetalle("A 0606-00761530")).toBe("A060600761530");
  });

  it("aplica el alias TIC -> Z", () => {
    expect(parseComprobanteFromDetalle("TIC 0001-00000042")).toBe("Z000100000042");
  });

  it("devuelve null si no matchea el formato esperado", () => {
    expect(parseComprobanteFromDetalle("sin comprobante")).toBeNull();
    expect(parseComprobanteFromDetalle(null)).toBeNull();
  });
});

describe("computeCompraRowId", () => {
  it("con comprobante: dos inputs que solo difieren en importe dan el mismo rowId", () => {
    const base = {
      codCga: "GASTO1", fechaISO: "2026-03-15", codigo: "PROV1", concepto: "Alquiler",
      comprobante: "A060600761530", detalle: "A 0606-00761530", observacNormalizado: "Obs", importe: "1000",
    };
    const a = computeCompraRowId(base);
    const b = computeCompraRowId({ ...base, importe: "1200" });
    expect(a).toBe(b);
  });

  it("sin comprobante: dos inputs que solo difieren en importe dan rowId distinto", () => {
    const base = {
      codCga: "GASTO1", fechaISO: "2026-03-15", codigo: "PROV1", concepto: "Sueldos",
      comprobante: null, detalle: null, observacNormalizado: "Juan", importe: "1000",
    };
    const a = computeCompraRowId(base);
    const b = computeCompraRowId({ ...base, importe: "1200" });
    expect(a).not.toBe(b);
  });

  it("sin comprobante: dos inputs idénticos dan el mismo rowId (dedup real)", () => {
    const base = {
      codCga: "GASTO1", fechaISO: "2026-03-15", codigo: "PROV1", concepto: "Sueldos",
      comprobante: null, detalle: null, observacNormalizado: "Juan", importe: "1000",
    };
    expect(computeCompraRowId(base)).toBe(computeCompraRowId({ ...base }));
  });

  // Regresión: hallazgo real en producción (dry-run de la migración de rowId,
  // 19-ago-2026) — "Iva compensacion" reutiliza el mismo comprobante para dos
  // ajustes distintos del mismo período, distinguibles solo por OBSERVAC
  // (null vs "San Justo"). Sin OBSERVAC en el hash, colapsaban al mismo rowId.
  it("con comprobante: mismo comprobante pero OBSERVAC distinto (mismo comprobante reutilizado en dos ajustes reales) da rowId distinto", () => {
    const base = {
      codCga: "820", fechaISO: "2026-01-16", codigo: "17", concepto: "Iva compensacion",
      comprobante: "A000600003425", detalle: "A  0006-00003425", observacNormalizado: null, importe: "13830.96",
    };
    const a = computeCompraRowId(base);
    const b = computeCompraRowId({ ...base, observacNormalizado: "San Justo", importe: "79692.69" });
    expect(a).not.toBe(b);
  });

  // Regresión: hallazgo real — un "Tic" (ticket) no es un documento único como
  // una factura real, el mismo número de ticket se repite para compras
  // genuinamente distintas (dos compras de comida el mismo día, mismo Tic,
  // OBSERVAC null en ambas, solo IMPORTE distingue). Deben tratarse como sin
  // comprobante confiable — de lo contrario colapsan al mismo rowId.
  it("Tic (ticket): dos compras con el mismo Tic, mismo OBSERVAC (null) pero IMPORTE distinto dan rowId distinto (comprobante no confiable, cae a la rama sin comprobante)", () => {
    const base = {
      codCga: "988", fechaISO: "2026-06-19", codigo: "3721", concepto: "Cumple COMIDA",
      comprobante: null, // esComprobanteConfiable(detalle) ya descartó el comprobante derivado del Tic
      detalle: "Tic 1522-19062026", observacNormalizado: null, importe: "112000",
    };
    const a = computeCompraRowId(base);
    const b = computeCompraRowId({ ...base, importe: "75000" });
    expect(a).not.toBe(b);
  });
});

describe("compraIdentityFromRawRow / compraIdentityFromDbRecord — equivalencia", () => {
  // Esta es la propiedad que garantiza que reimportar el mismo archivo produce
  // el mismo rowId que el que la migración le asignó a la compra ya existente.
  it("con comprobante: identidad calculada desde la fila cruda == identidad calculada desde el registro ya persistido", () => {
    const rawRow = {
      COD_CGA: "GASTO1",
      FECHA: 45000, // serial Excel, ~2023-03-15
      CODIGO: "PROV1",
      CONCEPTO: "Alquiler",
      DETALLE: "A 0606-00761530",
      OBSERVAC: "observación   con   espacios",
      IMPORTE: 1000,
    };

    const dbRecord = {
      codCga: "GASTO1",
      fecha: new Date("2023-03-15"),
      codigo: "PROV1",
      concepto: "Alquiler",
      comprobante: "A060600761530",
      detalle: "A 0606-00761530",
      observac: "Observación Con Espacios", // ya normalizado por normalizeText al insertar
      importe: { toString: () => "1000" }, // shape de Prisma.Decimal
    };

    const fromRaw = computeCompraRowId(compraIdentityFromRawRow(rawRow));
    const fromDb = computeCompraRowId(compraIdentityFromDbRecord(dbRecord));
    expect(fromRaw).toBe(fromDb);
  });

  it("sin comprobante: identidad calculada desde la fila cruda == identidad calculada desde el registro ya persistido", () => {
    const rawRow = {
      COD_CGA: "GASTO2",
      FECHA: 45000,
      CODIGO: "EMP5",
      CONCEPTO: "Liquidacion Sueldo",
      DETALLE: null,
      OBSERVAC: "juan perez",
      IMPORTE: 250000,
    };

    const dbRecord = {
      codCga: "GASTO2",
      fecha: new Date("2023-03-15"),
      codigo: "EMP5",
      concepto: "Liquidacion Sueldo",
      comprobante: null,
      detalle: null,
      observac: "Juan Perez",
      importe: { toString: () => "250000" },
    };

    const fromRaw = computeCompraRowId(compraIdentityFromRawRow(rawRow));
    const fromDb = computeCompraRowId(compraIdentityFromDbRecord(dbRecord));
    expect(fromRaw).toBe(fromDb);
  });

  // Regresión: Prisma.Decimal#toString() elimina ceros finales al leer desde
  // la base ("1500.50" persistido vuelve como "1500.5"), mientras que la fila
  // cruda del Excel mantiene el string tal cual. Sin canonicalizar ambos
  // lados a través de Prisma.Decimal, este mismatch de formato hacía que
  // computeCompraRowId discrepara para el mismo importe — justo en las
  // compras sin comprobante, donde importe es parte del hash.
  it("sin comprobante: importe con distinto formato pero mismo valor (Excel '1500.50' vs Decimal#toString() '1500.5') da el mismo rowId", () => {
    const rawRow = {
      COD_CGA: "GASTO3",
      FECHA: 45000,
      CODIGO: "PROV9",
      CONCEPTO: "Gasto suelto",
      DETALLE: null,
      OBSERVAC: "sin comprobante",
      IMPORTE: "1500.50",
    };

    const dbRecord = {
      codCga: "GASTO3",
      fecha: new Date("2023-03-15"),
      codigo: "PROV9",
      concepto: "Gasto suelto",
      comprobante: null,
      detalle: null,
      observac: "Sin Comprobante",
      importe: { toString: () => "1500.5" }, // lo que devuelve Prisma.Decimal para ese mismo valor
    };

    const fromRaw = computeCompraRowId(compraIdentityFromRawRow(rawRow));
    const fromDb = computeCompraRowId(compraIdentityFromDbRecord(dbRecord));
    expect(fromRaw).toBe(fromDb);
  });

  it("Tic (ticket): compraIdentityFromRawRow y compraIdentityFromDbRecord coinciden en tratar el comprobante como no confiable (comprobante queda null pese a que DETALLE parsea)", () => {
    const rawRow = {
      COD_CGA: "988",
      FECHA: 45000, // serial Excel, ~2023-03-15 (mismo serial usado en los demás tests de este archivo)
      CODIGO: "3721",
      CONCEPTO: "Cumple COMIDA",
      DETALLE: "Tic 1522-19062026",
      OBSERVAC: null,
      IMPORTE: 112000,
    };

    const dbRecord = {
      codCga: "988",
      fecha: new Date("2023-03-15"),
      codigo: "3721",
      concepto: "Cumple COMIDA",
      comprobante: "Z152219062026", // valor real guardado en la columna (alias TIC -> Z, se sigue guardando igual)
      detalle: "Tic 1522-19062026",
      observac: null,
      importe: { toString: () => "112000" },
    };

    const fromRaw = compraIdentityFromRawRow(rawRow);
    const fromDb = compraIdentityFromDbRecord(dbRecord);
    expect(fromRaw.comprobante).toBeNull();
    expect(fromDb.comprobante).toBeNull();
    expect(computeCompraRowId(fromRaw)).toBe(computeCompraRowId(fromDb));
  });
});

describe("computeCompraAnchor", () => {
  it("proyecta solo los campos estables (codCga, fechaISO, codigo, concepto, importe)", () => {
    const input = {
      codCga: "201", fechaISO: "2026-08-24", codigo: "68", concepto: "Servicio de Energia Electrica",
      comprobante: "B002752273860", detalle: "B 0027-52273860", observacNormalizado: "Del 23/7 Al 24/8", importe: "1552076.41",
    };
    expect(computeCompraAnchor(input)).toEqual({
      codCga: "201", fechaISO: "2026-08-24", codigo: "68", concepto: "Servicio de Energia Electrica", importe: "1552076.41",
    });
  });

  // Regresión: hallazgo real en producción (29-sep-2026) — el comprobante
  // aparece después de la carga inicial y cambia detalle/observac/comprobante,
  // pero es la misma compra real. El ancla tiene que ignorar esos 3 campos
  // para que la reconciliación los encuentre como la misma transacción.
  it("dos inputs que solo difieren en comprobante/detalle/observacNormalizado dan el mismo ancla", () => {
    const base = {
      codCga: "201", fechaISO: "2026-08-24", codigo: "68", concepto: "Servicio de Energia Electrica",
      comprobante: null, detalle: null, observacNormalizado: "Del 23/7 Al 24/8", importe: "1552076.41",
    };
    const conComprobante = { ...base, comprobante: "B002752273860", detalle: "B 0027-52273860" };
    expect(computeCompraAnchor(base)).toEqual(computeCompraAnchor(conComprobante));
  });

  it("dos inputs que difieren en importe dan ancla distinta", () => {
    const base = {
      codCga: "201", fechaISO: "2026-08-24", codigo: "68", concepto: "Servicio de Energia Electrica",
      comprobante: null, detalle: null, observacNormalizado: null, importe: "1000",
    };
    expect(computeCompraAnchor(base)).not.toEqual(computeCompraAnchor({ ...base, importe: "2000" }));
  });
});

describe("esReconciliacionSegura", () => {
  // Predicado compartido entre la reconciliación hacia adelante (compras.ts,
  // en cada import en vivo) y el script de limpieza retroactiva
  // (scripts/reconciliar-duplicados-erp.ts) — ver finding #4 de la revisión
  // final de rama, 29-sep-2026. Un solo lugar decide si dos filas que
  // comparten ancla son seguras de fusionar.
  const base = { comprobante: null, observac: null, localId: null };

  it("mismo comprobante y relación de prefijo entre OBSERVAC: segura", () => {
    const a = { ...base, comprobante: "A060600761530", observac: "Turbina Inflable" };
    const b = { ...base, comprobante: "A060600761530", observac: "Turbina Inflable Nuevo" };
    expect(esReconciliacionSegura(a, b)).toEqual({ segura: true });
  });

  it("mismo comprobante y OBSERVAC sin relación de prefijo (caso real Mochila/Válvula, spec §1): insegura", () => {
    const a = { ...base, comprobante: "0001-00001234", observac: "Mochila Baño Vestuario" };
    const b = { ...base, comprobante: "0001-00001234", observac: "Valvula + Tecla Descarga Baño" };
    expect(esReconciliacionSegura(a, b)).toEqual({ segura: false, motivo: "sin_relacion_de_prefijo" });
  });

  it("comprobante no nulo distinto entre ambas filas: insegura, sin importar el texto de OBSERVAC", () => {
    const a = { ...base, comprobante: "A060600761530", observac: "Misma Descripcion" };
    const b = { ...base, comprobante: "B000100000001", observac: "Misma Descripcion" };
    expect(esReconciliacionSegura(a, b)).toEqual({ segura: false, motivo: "comprobantes_distintos" });
  });

  it("un lado con comprobante null (el otro lo tiene): segura si el localId coincide (caso 'comprobante aparece después')", () => {
    const a = { ...base, comprobante: null, observac: "Obs", localId: 3 };
    const b = { ...base, comprobante: "A060600761530", observac: "Obs distinta y mas larga", localId: 3 };
    expect(esReconciliacionSegura(a, b)).toEqual({ segura: true });
  });

  it("localId distinto entre ambas filas: insegura aunque el resto coincida (XOR de comprobante, no ambas null — ver test dedicado de 'ambas sin comprobante' abajo)", () => {
    const a = { ...base, comprobante: null, observac: "Obs", localId: 1 };
    const b = { ...base, comprobante: "A060600761530", observac: "Obs", localId: 2 };
    expect(esReconciliacionSegura(a, b)).toEqual({ segura: false, motivo: "localId_distinto" });
  });

  it("localId desconocido (null) de un lado: no bloquea, se trata como sin evidencia de conflicto (XOR de comprobante, no ambas null)", () => {
    const a = { ...base, comprobante: null, observac: "Obs", localId: null };
    const b = { ...base, comprobante: "A060600761530", observac: "Obs", localId: 2 };
    expect(esReconciliacionSegura(a, b)).toEqual({ segura: true });
  });

  // Hallazgo real, dry-run de scripts/reconciliar-duplicados-erp.ts contra
  // producción (29-sep-2026): 654 de 706 pares (92.6%) que el script iba a
  // fusionar tenían comprobante null en AMBOS lados — dos transacciones
  // genuinamente distintas que nunca tuvieron comprobante (pagos en efectivo,
  // adelantos de sueldo, honorarios informales) pueden coincidir en el ancla
  // por casualidad. Ejemplo real: "Sergio Profe Fc" vs "Ricardo Profe Fc",
  // mismo importe/día/centro de costo, pagos a docentes DISTINTOS. La regla
  // anterior ("cualquiera de los dos null salta el chequeo de texto") solo es
  // válida cuando es EXACTAMENTE un lado null (branch-flip real); con ambos
  // null no hay comprobante que vincule nada y ninguna otra señal validada.
  it("ambos comprobante null: insegura, sin importar si OBSERVAC no tiene relación (caso real Sergio/Ricardo Profe Fc)", () => {
    const a = { ...base, comprobante: null, observac: "Sergio Profe Fc", localId: 1 };
    const b = { ...base, comprobante: null, observac: "Ricardo Profe Fc", localId: 1 };
    expect(esReconciliacionSegura(a, b)).toEqual({ segura: false, motivo: "ambas_sin_comprobante" });
  });

  it("ambos comprobante null con el MISMO OBSERVAC: sigue insegura — coincidir en ancla+texto no reemplaza la falta de comprobante", () => {
    const a = { ...base, comprobante: null, observac: "Obs", localId: 1 };
    const b = { ...base, comprobante: null, observac: "Obs", localId: 1 };
    expect(esReconciliacionSegura(a, b)).toEqual({ segura: false, motivo: "ambas_sin_comprobante" });
  });
});

describe("pickReconciliationCandidate", () => {
  it("0 candidatos: null", () => {
    expect(pickReconciliationCandidate([])).toBeNull();
  });

  it("1 candidato: lo elige", () => {
    const candidato = { rowId: "abc" };
    expect(pickReconciliationCandidate([candidato])).toBe(candidato);
  });

  it("2+ candidatos: ambiguo, null (no fusiona)", () => {
    expect(pickReconciliationCandidate([{ rowId: "a" }, { rowId: "b" }])).toBeNull();
  });
});
