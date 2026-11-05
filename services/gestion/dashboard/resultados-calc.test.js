// Portado de lazarillo_gestion/lib/dashboard/resultados-calc.test.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { describe, it, expect } = require('../test-utils/vitest');
const { parseMontoARS, montoNoGuardable, pctSobreIngresos, computeDiferenciaCajaAcumulada, computeDiferenciaCajaPorMes, sumarDiferenciaCajaVisible, heatmapFill, heatmapFillZeroAnchored, heatmapTextZeroAnchored, RESULT_COLORS } = require('./resultados-calc');

describe("parseMontoARS", () => {
  it("acepta coma como separador decimal", () => {
    expect(parseMontoARS("1234,56")).toBe(1234.56);
  });

  it("acepta punto como separador decimal", () => {
    expect(parseMontoARS("1234.56")).toBe(1234.56);
  });

  it("string vacío es 0", () => {
    expect(parseMontoARS("")).toBe(0);
  });

  it("texto no numérico devuelve null", () => {
    expect(parseMontoARS("abc")).toBeNull();
  });

  it("recorta espacios", () => {
    expect(parseMontoARS("  1234,5  ")).toBe(1234.5);
  });

  it("formato AR con separador de miles", () => {
    expect(parseMontoARS("1.234,56")).toBe(1234.56);
  });

  it("formato AR con separador de miles y decimales en cero", () => {
    expect(parseMontoARS("12.345,00")).toBe(12345);
  });

  it("punto sin coma se interpreta como decimal, no como miles (ambigüedad resuelta a favor del comportamiento previo)", () => {
    expect(parseMontoARS("1.234")).toBe(1.234);
  });
});

describe("montoNoGuardable", () => {
  it("celda vacía NO es no-guardable — el vacío borra la fila, es válido", () => {
    expect(montoNoGuardable("")).toBe(false);
    expect(montoNoGuardable("   ")).toBe(false);
  });

  it("cero explícito es no-guardable", () => {
    expect(montoNoGuardable("0")).toBe(true);
    expect(montoNoGuardable("0,00")).toBe(true);
    expect(montoNoGuardable("  0  ")).toBe(true);
    expect(montoNoGuardable("-0")).toBe(true);
  });

  it("un monto real es guardable", () => {
    expect(montoNoGuardable("1000")).toBe(false);
    expect(montoNoGuardable("1.234,56")).toBe(false);
  });

  it("texto no numérico no es no-guardable (lo bloquea parseMontoARS -> null aparte)", () => {
    expect(montoNoGuardable("abc")).toBe(false);
  });
});

describe("pctSobreIngresos", () => {
  it("denominador 0 devuelve guion", () => {
    expect(pctSobreIngresos(100, 0)).toBe("—");
  });

  it("caso normal calcula el porcentaje con un decimal", () => {
    expect(pctSobreIngresos(50, 200)).toBe("25.0%");
  });

  it("numerador negativo conserva el signo", () => {
    expect(pctSobreIngresos(-50, 200)).toBe("-25.0%");
  });
});

describe("computeDiferenciaCajaAcumulada", () => {
  // Serie de ejemplo: primer arqueo cargado en septiembre (mes 9). CA-01 a CA-03 del PDF.
  const serieBase = [
    { anio: 2026, mes: 7, ingresos: 100, egresos: 40, ganancia: 20, disponible: null },  // jul
    { anio: 2026, mes: 8, ingresos: 100, egresos: 40, ganancia: 20, disponible: null },  // ago
    { anio: 2026, mes: 9, ingresos: 100, egresos: 40, ganancia: 20, disponible: 500 },   // sep — primer arqueo
    { anio: 2026, mes: 10, ingresos: 120, egresos: 50, ganancia: 30, disponible: null }, // oct — sin arqueo propio
    { anio: 2026, mes: 11, ingresos: 110, egresos: 45, ganancia: 25, disponible: 600 },  // nov
  ];
  const primerArqueoSep = { anio: 2026, mes: 9 };

  it("CA-01 — sin ningún arqueo, primerArqueo null, todo el resultado es null", () => {
    const resultado = computeDiferenciaCajaAcumulada(serieBase, null);
    expect(resultado).toEqual([null, null, null, null, null]);
  });

  it("CA-02 — julio, agosto y septiembre (mes del primer arqueo inclusive) dan null", () => {
    const resultado = computeDiferenciaCajaAcumulada(serieBase, primerArqueoSep);
    expect(resultado[0]).toBeNull(); // jul
    expect(resultado[1]).toBeNull(); // ago
    expect(resultado[2]).toBeNull(); // sep, mes del primer arqueo
  });

  it("octubre sin arqueo propio → null (no se muestra el acumulado en meses sin arqueo)", () => {
    const resultado = computeDiferenciaCajaAcumulada(serieBase, primerArqueoSep);
    // oct tiene disponible: null → celda vacía, aunque el acumulador ya corre por detrás.
    expect(resultado[3]).toBeNull();
  });

  it("noviembre con arqueo propio → el acumulado arrastra el término contable de octubre (continuidad de CA-03 intacta)", () => {
    const resultado = computeDiferenciaCajaAcumulada(serieBase, primerArqueoSep);
    // oct: sin arqueo, no se muestra, pero acc += 0 - ((120-50)-30) = -40
    // nov: arqueo 600, delta = 600 - 500 = 100; acc += 100 - ((110-45)-25) = +60 → acc = 20
    expect(resultado[4]).toBe(20);
  });

  it("CA-04 — los meses sin cálculo válido son null, nunca 0", () => {
    const resultado = computeDiferenciaCajaAcumulada(serieBase, primerArqueoSep);
    expect(resultado[0]).not.toBe(0);
    expect(resultado[0]).toBeNull();
  });

  it("caso cross-año — primer arqueo en el año anterior al último año de la serie, el acumulado sigue de corrido", () => {
    const serieCrossAnio = [
      { anio: 2025, mes: 11, ingresos: 100, egresos: 40, ganancia: 20, disponible: null },
      { anio: 2025, mes: 12, ingresos: 100, egresos: 40, ganancia: 20, disponible: 1000 }, // primer arqueo
      { anio: 2026, mes: 1, ingresos: 120, egresos: 50, ganancia: 30, disponible: null },
      { anio: 2026, mes: 2, ingresos: 110, egresos: 45, ganancia: 25, disponible: 900 },
    ];
    const primerArqueoDic2025 = { anio: 2025, mes: 12 };
    const resultado = computeDiferenciaCajaAcumulada(serieCrossAnio, primerArqueoDic2025);
    expect(resultado[0]).toBeNull(); // nov 2025
    expect(resultado[1]).toBeNull(); // dic 2025, mes del primer arqueo
    // ene 2026: disponible null → celda vacía (el acumulador sigue por detrás)
    expect(resultado[2]).toBeNull();
    // feb 2026: disponible 900 → delta = 900 - 1000 = -100, referencia pasa a 900
    // contribución = -100 - ((110-45)-25) = -140; acumulado = -40 + (-140) = -180
    expect(resultado[3]).toBe(-180);
  });

  it("primerArqueo posterior al último mes de la serie (rango mal armado por el caller) da todo null", () => {
    const resultado = computeDiferenciaCajaAcumulada(serieBase, { anio: 2027, mes: 1 });
    expect(resultado).toEqual([null, null, null, null, null]);
  });

  it("regresión — fixture real del PDF: acumula la variación de disponible, no el saldo crudo (evita el runaway del 13-ago)", () => {
    const serie = [
      { anio: 2025, mes: 12, ingresos: 0, egresos: 0, ganancia: 0, disponible: 1_181_305 }, // primer arqueo
      { anio: 2026, mes: 1, ingresos: 5_443_199, egresos: 0, ganancia: 3_817_903, disponible: 5_670_649 },
      { anio: 2026, mes: 2, ingresos: 7_876_831, egresos: 0, ganancia: 3_737_455, disponible: 9_297_875 },
    ];
    const primerArqueo = { anio: 2025, mes: 12 };
    const resultado = computeDiferenciaCajaAcumulada(serie, primerArqueo);
    expect(resultado[0]).toBeNull(); // dic 2025, mes del primer arqueo
    // ene 2026: delta = 5.670.649 - 1.181.305 = 4.489.344; contribución = 4.489.344 - (5.443.199-3.817.903) = 4.489.344 - 1.625.296 = 2.864.048
    expect(resultado[1]).toBe(2_864_048);
    // feb 2026: delta = 9.297.875 - 5.670.649 = 3.627.226; contribución = 3.627.226 - (7.876.831-3.737.455) = 3.627.226 - 4.139.376 = -512.150
    // acumulado = 2.864.048 + (-512.150) = 2.351.898
    expect(resultado[2]).toBe(2_351_898);
  });

  it("un disponible en 0 se trata como sin arqueo, no como un arqueo real de cero", () => {
    // jun/jul/ago con disponible 0 (filas fantasma), sep primer arqueo real.
    const serie = [
      { anio: 2025, mes: 6, ingresos: 100, egresos: 40, ganancia: 20, disponible: 0 },   // jun
      { anio: 2025, mes: 7, ingresos: 100, egresos: 40, ganancia: 20, disponible: 0 },   // jul
      { anio: 2025, mes: 8, ingresos: 100, egresos: 40, ganancia: 20, disponible: 0 },   // ago
      { anio: 2025, mes: 9, ingresos: 100, egresos: 40, ganancia: 20, disponible: 500 }, // sep — primer arqueo real
      { anio: 2025, mes: 10, ingresos: 120, egresos: 50, ganancia: 30, disponible: 0 }, // oct — otra fila fantasma, la visita el loop
    ];
    const resultado = computeDiferenciaCajaAcumulada(serie, { anio: 2025, mes: 9 });
    expect(resultado[0]).toBeNull(); // jun
    expect(resultado[1]).toBeNull(); // jul
    expect(resultado[2]).toBeNull(); // ago
    expect(resultado[3]).toBeNull(); // sep, mes del primer arqueo
    // oct con disponible 0 → tratado como sin arqueo (0 ≡ null): celda vacía.
    expect(resultado[4]).toBeNull();
  });

  it("un disponible en 0 entre dos arqueos válidos no resetea la referencia", () => {
    // sep=500, oct=0 (fila fantasma), nov=600. La variación de nov se mide contra sep (500), no contra 0.
    const serie = [
      { anio: 2025, mes: 9, ingresos: 100, egresos: 40, ganancia: 20, disponible: 500 },  // sep — primer arqueo
      { anio: 2025, mes: 10, ingresos: 100, egresos: 40, ganancia: 20, disponible: 0 },   // oct — fila fantasma
      { anio: 2025, mes: 11, ingresos: 110, egresos: 45, ganancia: 25, disponible: 600 }, // nov
    ];
    const resultado = computeDiferenciaCajaAcumulada(serie, { anio: 2025, mes: 9 });
    // oct: disponible 0 → sin arqueo, celda vacía. Por detrás: acc = 0 - ((100-40)-20) = -40
    expect(resultado[1]).toBeNull();
    // nov: disponible 600, delta contra referencia 500 = 100. contribución = 100 - ((110-45)-25) = 60. acc = -40 + 60 = 20
    expect(resultado[2]).toBe(20);
  });

  it("gap de varios meses sin arqueo: todos null, el arqueo posterior reconcilia contra el último arqueo real", () => {
    const serie = [
      { anio: 2025, mes: 1, ingresos: 100, egresos: 40, ganancia: 20, disponible: 1000 }, // ene — primer arqueo
      { anio: 2025, mes: 2, ingresos: 100, egresos: 40, ganancia: 20, disponible: null }, // feb — sin arqueo
      { anio: 2025, mes: 3, ingresos: 100, egresos: 40, ganancia: 20, disponible: null }, // mar — sin arqueo
      { anio: 2025, mes: 4, ingresos: 100, egresos: 40, ganancia: 20, disponible: null }, // abr — sin arqueo
      { anio: 2025, mes: 5, ingresos: 200, egresos: 50, ganancia: 30, disponible: 1300 }, // may — arqueo
    ];
    const resultado = computeDiferenciaCajaAcumulada(serie, { anio: 2025, mes: 1 });
    expect(resultado[0]).toBeNull(); // ene, mes del primer arqueo
    expect(resultado[1]).toBeNull(); // feb
    expect(resultado[2]).toBeNull(); // mar
    expect(resultado[3]).toBeNull(); // abr
    // feb/mar/abr: acc += 0 - ((100-40)-20) = -40 cada uno → -120
    // may: delta = 1300 - 1000 = 300; acc += 300 - ((200-50)-30) = 300 - 120 = +180 → -120 + 180 = 60
    expect(resultado[4]).toBe(60);
  });
});

describe("computeDiferenciaCajaPorMes", () => {
  const serieBase = [
    { anio: 2026, mes: 7, ingresos: 100, egresos: 40, ganancia: 20, disponible: null },  // jul
    { anio: 2026, mes: 8, ingresos: 100, egresos: 40, ganancia: 20, disponible: null },  // ago
    { anio: 2026, mes: 9, ingresos: 100, egresos: 40, ganancia: 20, disponible: 500 },   // sep — primer arqueo
    { anio: 2026, mes: 10, ingresos: 120, egresos: 50, ganancia: 30, disponible: null }, // oct — sin arqueo propio
    { anio: 2026, mes: 11, ingresos: 110, egresos: 45, ganancia: 25, disponible: 600 },  // nov
  ];
  const primerArqueoSep = { anio: 2026, mes: 9 };

  it("CA-01 — sin ningún arqueo, primerArqueo null, todo el resultado es null", () => {
    const resultado = computeDiferenciaCajaPorMes(serieBase, null);
    expect(resultado).toEqual([null, null, null, null, null]);
  });

  it("CA-02 — julio, agosto y septiembre (mes del primer arqueo inclusive) dan null", () => {
    const resultado = computeDiferenciaCajaPorMes(serieBase, primerArqueoSep);
    expect(resultado[0]).toBeNull();
    expect(resultado[1]).toBeNull();
    expect(resultado[2]).toBeNull();
  });

  it("octubre sin arqueo propio → null", () => {
    const resultado = computeDiferenciaCajaPorMes(serieBase, primerArqueoSep);
    expect(resultado[3]).toBeNull();
  });

  it("noviembre con arqueo propio → SOLO el término contable de noviembre, sin arrastrar el de octubre (decisión spec §1.3, difiere de computeDiferenciaCajaAcumulada que da 20)", () => {
    const resultado = computeDiferenciaCajaPorMes(serieBase, primerArqueoSep);
    // referencia sigue siendo 500 (oct no tenía arqueo, no la pisó). delta = 600 - 500 = 100.
    // término nov = (110-45)-25 = 40. valor = 100 - 40 = 60.
    expect(resultado[4]).toBe(60);
  });

  it("CA-04 — los meses sin cálculo válido son null, nunca 0", () => {
    const resultado = computeDiferenciaCajaPorMes(serieBase, primerArqueoSep);
    expect(resultado[0]).not.toBe(0);
    expect(resultado[0]).toBeNull();
  });

  it("un disponible en 0 se trata como sin arqueo, no como un arqueo real de cero", () => {
    const serie = [
      { anio: 2025, mes: 6, ingresos: 100, egresos: 40, ganancia: 20, disponible: 0 },
      { anio: 2025, mes: 7, ingresos: 100, egresos: 40, ganancia: 20, disponible: 0 },
      { anio: 2025, mes: 8, ingresos: 100, egresos: 40, ganancia: 20, disponible: 0 },
      { anio: 2025, mes: 9, ingresos: 100, egresos: 40, ganancia: 20, disponible: 500 }, // primer arqueo real
      { anio: 2025, mes: 10, ingresos: 120, egresos: 50, ganancia: 30, disponible: 0 },  // fantasma
    ];
    const resultado = computeDiferenciaCajaPorMes(serie, { anio: 2025, mes: 9 });
    expect(resultado[3]).toBeNull(); // sep, mes del primer arqueo
    expect(resultado[4]).toBeNull(); // oct con disponible 0 → sin arqueo
  });

  it("un disponible en 0 entre dos arqueos válidos no resetea la referencia", () => {
    const serie = [
      { anio: 2025, mes: 9, ingresos: 100, egresos: 40, ganancia: 20, disponible: 500 },
      { anio: 2025, mes: 10, ingresos: 100, egresos: 40, ganancia: 20, disponible: 0 },   // fantasma
      { anio: 2025, mes: 11, ingresos: 110, egresos: 45, ganancia: 25, disponible: 600 },
    ];
    const resultado = computeDiferenciaCajaPorMes(serie, { anio: 2025, mes: 9 });
    expect(resultado[1]).toBeNull();
    // nov: delta contra referencia 500 = 100. término = (110-45)-25 = 40. valor = 100 - 40 = 60.
    expect(resultado[2]).toBe(60);
  });

  it("cross-año — el mes anterior con arqueo puede ser de diciembre del año anterior, y solo se resta el término del mes actual (no el de enero sin arqueo)", () => {
    const serieCrossAnio = [
      { anio: 2025, mes: 11, ingresos: 100, egresos: 40, ganancia: 20, disponible: null },
      { anio: 2025, mes: 12, ingresos: 100, egresos: 40, ganancia: 20, disponible: 1000 }, // primer arqueo
      { anio: 2026, mes: 1, ingresos: 120, egresos: 50, ganancia: 30, disponible: null },  // sin arqueo
      { anio: 2026, mes: 2, ingresos: 110, egresos: 45, ganancia: 25, disponible: 900 },
    ];
    const primerArqueoDic2025 = { anio: 2025, mes: 12 };
    const resultado = computeDiferenciaCajaPorMes(serieCrossAnio, primerArqueoDic2025);
    expect(resultado[0]).toBeNull();
    expect(resultado[1]).toBeNull();
    expect(resultado[2]).toBeNull(); // ene 2026, sin arqueo
    // feb 2026: referencia sigue en 1000 (dic), delta = 900 - 1000 = -100.
    // término feb = (110-45)-25 = 40. valor = -100 - 40 = -140 (NO -180, que es lo que da el acumulado).
    expect(resultado[3]).toBe(-140);
  });

  it("gap de varios meses sin arqueo: el mes que reabre resta SOLO su propio término, no la suma del hueco (spec §1.3)", () => {
    const serie = [
      { anio: 2025, mes: 1, ingresos: 100, egresos: 40, ganancia: 20, disponible: 1000 }, // primer arqueo
      { anio: 2025, mes: 2, ingresos: 100, egresos: 40, ganancia: 20, disponible: null },
      { anio: 2025, mes: 3, ingresos: 100, egresos: 40, ganancia: 20, disponible: null },
      { anio: 2025, mes: 4, ingresos: 100, egresos: 40, ganancia: 20, disponible: null },
      { anio: 2025, mes: 5, ingresos: 200, egresos: 50, ganancia: 30, disponible: 1300 },
    ];
    const resultado = computeDiferenciaCajaPorMes(serie, { anio: 2025, mes: 1 });
    expect(resultado[1]).toBeNull();
    expect(resultado[2]).toBeNull();
    expect(resultado[3]).toBeNull();
    // may: referencia sigue en 1000 (feb/mar/abr no la tocaron). delta = 1300 - 1000 = 300.
    // término may = (200-50)-30 = 120. valor = 300 - 120 = 180.
    // computeDiferenciaCajaAcumulada da 60 para este mismo caso — la diferencia es la decisión de §1.3.
    expect(resultado[4]).toBe(180);
  });

  it("valores esperados del PDF (Correccion_diferencia_caja_por_mes, San Justo sep-2025 → jul-2026) — serie sintética con inputs despejados hacia atrás desde esos valores, NO son datos reales de producción", () => {
    // Serie construida para producir exactamente los valores "Por mes" del PDF: ingresos=500.000,
    // egresos=0, ganancia=0 todos los meses (término contable constante = 500.000) y `disponible`
    // despejado de la fórmula para que cada delta - término dé el valor esperado del PDF.
    // Los `disponible` de acá abajo están despejados hacia atrás para calzar con los 10 valores
    // esperados del PDF (artefacto de construcción, no datos reales de arqueo) — fija el
    // comportamiento esperado de la fórmula para regresión, pero no la valida contra producción;
    // esa validación es la pasada visual manual pendiente contra el Dashboard real.
    const serie = [
      { anio: 2025, mes: 9, ingresos: 0, egresos: 0, ganancia: 0, disponible: 0 },              // sep — primer arqueo
      { anio: 2025, mes: 10, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: -4_571_746 },
      { anio: 2025, mes: 11, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: 1_022_744 },
      { anio: 2025, mes: 12, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: 2_552_609 },
      { anio: 2026, mes: 1, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: 6_017_489 },
      { anio: 2026, mes: 2, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: 6_031_453 },
      { anio: 2026, mes: 3, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: 3_731_502 },
      { anio: 2026, mes: 4, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: 7_409_647 },
      { anio: 2026, mes: 5, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: 10_638_410 },
      { anio: 2026, mes: 6, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: 16_668_455 },
      { anio: 2026, mes: 7, ingresos: 500_000, egresos: 0, ganancia: 0, disponible: 12_571_571 },
    ];
    const primerArqueo = { anio: 2025, mes: 9 };
    const resultado = computeDiferenciaCajaPorMes(serie, primerArqueo);
    expect(resultado[0]).toBeNull();          // sep, mes del primer arqueo
    expect(resultado[1]).toBe(-5_071_746);    // oct
    expect(resultado[2]).toBe(5_094_490);     // nov
    expect(resultado[3]).toBe(1_029_865);     // dic
    expect(resultado[4]).toBe(2_964_880);     // ene
    expect(resultado[5]).toBe(-486_036);      // feb
    expect(resultado[6]).toBe(-2_799_951);    // mar — faltante real de $2,8M (recuadro rojo del PDF)
    expect(resultado[7]).toBe(3_178_145);     // abr
    expect(resultado[8]).toBe(2_728_763);     // may
    expect(resultado[9]).toBe(5_530_045);     // jun
    expect(resultado[10]).toBe(-4_596_884);   // jul — faltante real de $4,6M (recuadro rojo del PDF)

    // Pin del acumulado final del PDF (fila "Acumulado", jul-26) — no es una auto-consistencia
    // algebraica (eso sería vacío para una serie sin huecos), es el valor real que trae el PDF.
    const acumulado = computeDiferenciaCajaAcumulada(serie, primerArqueo);
    expect(acumulado[10]).toBe(7_571_571);
  });
});

describe("sumarDiferenciaCajaVisible", () => {
  it("todos los meses en null → total null (sin dato)", () => {
    expect(sumarDiferenciaCajaVisible([null, null, null])).toBeNull();
  });

  it("un real $0 total (meses +500 y -500) da 0, no null — no se confunde con 'sin dato'", () => {
    expect(sumarDiferenciaCajaVisible([500, null, -500, null])).toBe(0);
  });

  it("suma normal de varios meses con valor, ignorando los null", () => {
    expect(sumarDiferenciaCajaVisible([100, null, 200, null, -50])).toBe(250);
  });

  it("un solo mes con valor real (incluso 0) da ese valor, no null", () => {
    expect(sumarDiferenciaCajaVisible([null, null, 0, null])).toBe(0);
  });
});

describe("heatmapFill", () => {
  it("banda baja (ratio < 1/3) da rojo con texto blanco", () => {
    expect(heatmapFill(0, 0, 100)).toEqual({ background: RESULT_COLORS.negative, foreground: "#ffffff" });
  });

  it("banda alta (ratio >= 2/3) da verde con texto blanco", () => {
    expect(heatmapFill(100, 0, 100)).toEqual({ background: RESULT_COLORS.positive, foreground: "#ffffff" });
  });

  it("banda media da ámbar con texto blanco", () => {
    expect(heatmapFill(50, 0, 100)).toEqual({ background: RESULT_COLORS.neutral, foreground: "#ffffff" });
  });

  it("ratio exactamente en 1/3 cae en la banda media, no en la baja", () => {
    expect(heatmapFill(100, 0, 300)).toEqual({ background: RESULT_COLORS.neutral, foreground: "#ffffff" });
  });

  it("ratio justo debajo de 1/3 cae en la banda baja", () => {
    expect(heatmapFill(99, 0, 300)).toEqual({ background: RESULT_COLORS.negative, foreground: "#ffffff" });
  });

  it("ratio exactamente en 2/3 cae en la banda alta, no en la media", () => {
    expect(heatmapFill(200, 0, 300)).toEqual({ background: RESULT_COLORS.positive, foreground: "#ffffff" });
  });

  it("ratio justo debajo de 2/3 cae en la banda media", () => {
    expect(heatmapFill(199, 0, 300)).toEqual({ background: RESULT_COLORS.neutral, foreground: "#ffffff" });
  });

  it("min === max (un solo mes visible) devuelve la banda media, no un extremo", () => {
    expect(heatmapFill(50, 50, 50)).toEqual({ background: RESULT_COLORS.neutral, foreground: "#ffffff" });
  });
});

describe("heatmapFillZeroAnchored", () => {
  it("el valor más negativo de la fila da la banda roja", () => {
    expect(heatmapFillZeroAnchored(-100, -100, 50)).toEqual({ background: RESULT_COLORS.negative, foreground: "#ffffff" });
  });

  it("el valor más positivo de la fila da la banda verde", () => {
    expect(heatmapFillZeroAnchored(50, -100, 50)).toEqual({ background: RESULT_COLORS.positive, foreground: "#ffffff" });
  });

  it("valor 0 siempre da la banda ámbar, sea cual sea el resto de la fila", () => {
    expect(heatmapFillZeroAnchored(0, -100, 50)).toEqual({ background: RESULT_COLORS.neutral, foreground: "#ffffff" });
  });

  it("fila toda positiva: el mínimo de la fila (0) no pinta rojo, a diferencia de heatmapFill", () => {
    expect(heatmapFillZeroAnchored(0, 0, 100)).toEqual({ background: RESULT_COLORS.neutral, foreground: "#ffffff" });
  });

  it("fila toda negativa: el máximo de la fila (0) no pinta verde, a diferencia de heatmapFill", () => {
    expect(heatmapFillZeroAnchored(0, -100, 0)).toEqual({ background: RESULT_COLORS.neutral, foreground: "#ffffff" });
  });

  it("min === max positivo (un solo mes visible) da la banda verde, no la ámbar de heatmapFill, porque el punto medio está anclado en 0 real", () => {
    expect(heatmapFillZeroAnchored(50, 50, 50)).toEqual({ background: RESULT_COLORS.positive, foreground: "#ffffff" });
  });

  it("min === max === 0 da la banda ámbar", () => {
    expect(heatmapFillZeroAnchored(0, 0, 0)).toEqual({ background: RESULT_COLORS.neutral, foreground: "#ffffff" });
  });
});

describe("heatmapTextZeroAnchored", () => {
  it("el valor más negativo de la fila da rojo", () => {
    expect(heatmapTextZeroAnchored(-100, -100, 50)).toBe(RESULT_COLORS.negative);
  });

  it("el valor más positivo de la fila da verde", () => {
    expect(heatmapTextZeroAnchored(50, -100, 50)).toBe(RESULT_COLORS.positive);
  });

  it("valor 0 siempre da ámbar", () => {
    expect(heatmapTextZeroAnchored(0, -100, 50)).toBe(RESULT_COLORS.neutral);
  });

  it("fila toda positiva: el mínimo de la fila (0) no pinta rojo", () => {
    expect(heatmapTextZeroAnchored(0, 0, 100)).toBe(RESULT_COLORS.neutral);
  });

  it("fila toda negativa: el máximo de la fila (0) no pinta verde", () => {
    expect(heatmapTextZeroAnchored(0, -100, 0)).toBe(RESULT_COLORS.neutral);
  });

  it("min === max positivo da verde, no el ámbar de heatmapText", () => {
    expect(heatmapTextZeroAnchored(50, 50, 50)).toBe(RESULT_COLORS.positive);
  });

  it("min === max === 0 da ámbar", () => {
    expect(heatmapTextZeroAnchored(0, 0, 0)).toBe(RESULT_COLORS.neutral);
  });
});
