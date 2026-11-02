// Portado de lazarillo_gestion/lib/feriados.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Feriados nacionales de Argentina (inamovibles, trasladables ya movidos y días no laborables
// con fines turísticos). Para "Sin carga" (Diego 28/10/2026): el concepto "Feriados" de sueldos
// solo se espera en los meses que tuvieron feriados. ACTUALIZAR cada año cuando sale el decreto
// (los no laborables del año siguiente se publican a fin de año). Fuente: calendario oficial
// publicado (argentina.gob.ar / prensa), revisado el 28/10/2026.
const FERIADOS = {
  2025: [
    "2025-01-01", "2025-03-03", "2025-03-04", "2025-03-24", "2025-04-02", "2025-04-18", "2025-05-01", "2025-05-02",
    "2025-05-25", "2025-06-16", "2025-06-20", "2025-07-09", "2025-08-15", "2025-08-17", "2025-10-10", "2025-11-21",
    "2025-11-24", "2025-12-08", "2025-12-25",
  ],
  2026: [
    "2026-01-01", "2026-02-16", "2026-02-17", "2026-03-23", "2026-03-24", "2026-04-02", "2026-04-03", "2026-05-01",
    "2026-05-25", "2026-06-15", "2026-06-20", "2026-07-09", "2026-07-10", "2026-08-17", "2026-10-12", "2026-11-09",
    "2026-11-23", "2026-12-07", "2026-12-08", "2026-12-25",
  ],
  2027: [
    "2027-01-01", "2027-02-08", "2027-02-09", "2027-03-24", "2027-03-26", "2027-04-02", "2027-05-01", "2027-05-25",
    "2027-06-20", "2027-06-21", "2027-07-09", "2027-08-16", "2027-10-11", "2027-11-20", "2027-12-08", "2027-12-25",
  ],
};

/** Feriados del mes ("YYYY-MM"). null = año sin calendario cargado (no se sabe). */
function feriadosDelMes(mes) {
  const lista = FERIADOS[Number(mes.slice(0, 4))];
  return lista ? lista.filter((f) => f.startsWith(mes)) : null;
}

/** Un concepto de feriados ("Feriados", "Feriado trabajado"…). */
const esConceptoFeriado = (concepto) => /feriad/i.test(concepto ?? "");

module.exports = { FERIADOS, feriadosDelMes, esConceptoFeriado };
