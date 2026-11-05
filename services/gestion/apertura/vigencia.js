// Portado de lazarillo_gestion/lib/apertura/vigencia.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { sql } = require('../db');
const ts = (d) => sql`${d.toISOString()}::timestamp`;

// Expresión SQL de la fecha EFECTIVA de una compra — reusada por todo caller
// que arma su propio vigenciaSql fuera de aplicarRegla (liberarComprasReclamables
// y los route handlers que la invocan). Un solo lugar evita que esta expresión
// diverja entre callers — si difiere, liberarComprasReclamables podría liberar
// compras que aplicarRegla después no reclama, dejándolas sin distribuir.
const FECHA_EFECTIVA_COMPRA_SQL = sql`COALESCE(c."fechaManual", c.fecha)`;

// Puro — sin acceso a SQL/DB, así que es 100% testeable. La conversión a SQL
// vive en vigenciaToSql(), abajo, deliberadamente separada.
function resolverVigencia(regla) {
  switch (regla.modo) {
    case "historico":
      return { tipo: "historico" };
    case "entre_fechas":
      if (!regla.fechaDesde) throw new Error("modo 'entre_fechas' requiere fechaDesde");
      if (!regla.fechaHasta) throw new Error("modo 'entre_fechas' requiere fechaHasta");
      return { tipo: "entre_fechas", desde: regla.fechaDesde, hasta: regla.fechaHasta, inclusivo: regla.extremosInclusivos };
    case "desde_adelante":
      if (!regla.fechaDesde) throw new Error("modo 'desde_adelante' requiere fechaDesde");
      return { tipo: "desde_adelante", desde: regla.fechaDesde, inclusivo: regla.extremosInclusivos };
    case "desde_atras":
      if (!regla.fechaHasta) throw new Error("modo 'desde_atras' requiere fechaHasta");
      return { tipo: "desde_atras", hasta: regla.fechaHasta, inclusivo: regla.extremosInclusivos };
  }
}

// Puro — versión en memoria de vigenciaToSql, para decidir si UNA compra
// concreta cae en la ventana de una regla (lib/apertura/reevaluacion.ts).
// vigenciaToSql sigue siendo la fuente para el filtrado masivo en SQL; esta
// función replica la MISMA semántica de extremos para el caso puntual.
function fechaEnVigencia(fecha, regla) {
  const cond = resolverVigencia(regla);
  const t = fecha.getTime();
  switch (cond.tipo) {
    case "historico":
      return true;
    case "entre_fechas":
      return cond.inclusivo
        ? t >= cond.desde.getTime() && t <= cond.hasta.getTime()
        : t > cond.desde.getTime() && t < cond.hasta.getTime();
    case "desde_adelante":
      return cond.inclusivo ? t >= cond.desde.getTime() : t > cond.desde.getTime();
    case "desde_atras":
      return cond.inclusivo ? t <= cond.hasta.getTime() : t < cond.hasta.getTime();
  }
}

// Glue a Prisma.Sql — no testeado unitariamente (sin DB para verificar que el
// SQL generado es correcto de punta a punta), la lógica de negocio ya está
// cubierta por los tests de resolverVigencia(). fechaCol es la expresión SQL
// de la fecha EFECTIVA (COALESCE ya resuelto por el caller, ver motor.ts).
function vigenciaToSql(cond, fechaCol) {
  switch (cond.tipo) {
    case "historico":
      return sql`TRUE`;
    case "entre_fechas":
      return cond.inclusivo
        ? sql`${fechaCol} >= ${ts(cond.desde)} AND ${fechaCol} <= ${ts(cond.hasta)}`
        : sql`${fechaCol} > ${ts(cond.desde)} AND ${fechaCol} < ${ts(cond.hasta)}`;
    case "desde_adelante":
      return cond.inclusivo ? sql`${fechaCol} >= ${ts(cond.desde)}` : sql`${fechaCol} > ${ts(cond.desde)}`;
    case "desde_atras":
      return cond.inclusivo ? sql`${fechaCol} <= ${ts(cond.hasta)}` : sql`${fechaCol} < ${ts(cond.hasta)}`;
  }
}

module.exports = { FECHA_EFECTIVA_COMPRA_SQL, resolverVigencia, fechaEnVigencia, vigenciaToSql };
