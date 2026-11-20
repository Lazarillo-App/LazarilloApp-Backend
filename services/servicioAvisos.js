// services/servicioAvisos.js — avisos de los servicios por hora (Diego 20/11/2026, parte 3 de canchas).
// Una vez por día, para cada ancla de cada negocio:
//   1. recalcula su familia (los costos del local cambian mes a mes y la tabla tiene que mostrarlos);
//   2. si desde el último aumento sus costos subieron 5 % o más (o es marzo, el mes de revisión, y
//      subieron algo), avisa: «tus costos subieron X % → hora a $ Y»;
//   3. si en los últimos 3 meses se usó 10 % menos que el promedio del año, avisa que no suba el precio:
//      que empuje la venta.
// Un aviso por ancla y por mes (clave con el mes): si cambia el número, se renueva, no se repite.
'use strict';
const pool = require('../config/db');
const srv = require('./servicioCosto');
const { avisarAlEquipo } = require('./notificationService');

const UMBRAL_SUBA = 0.05;
const UMBRAL_HORAS = 0.10;
const pesos = (x) => `$ ${Math.round(Number(x) || 0).toLocaleString('es-AR')}`;
const pct = (x) => `${(Math.round(x * 1000) / 10).toLocaleString('es-AR')} %`;
const ddmmaa = (f) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(2, 4)}`;

async function revisarServicios({ hoy = new Date() } = {}) {
  const { rows: anclas } = await pool.query(
    `SELECT business_id, article_id, nombre FROM recetas
      WHERE active = TRUE AND servicio->>'tipo' = 'ancla' ORDER BY business_id, article_id`);
  const mes = hoy.toISOString().slice(0, 7);
  const esMarzo = hoy.getUTCMonth() === 2;
  let avisos = 0;
  for (const a of anclas) {
    try {
      const calc = await srv.recalcularServicio(Number(a.business_id), Number(a.article_id));
      if (!calc || calc.sinDatos) continue;
      const nombre = String(a.nombre || '').replace(/\.$/, '');
      const v = calc.vsBase;
      if (v && v.suba != null && (v.suba >= UMBRAL_SUBA || (esMarzo && v.suba > 0))) {
        await avisarAlEquipo({
          businessId: a.business_id, type: 'servicio_costos',
          title: `${nombre}: tus costos subieron ${pct(v.suba)} desde el ${ddmmaa(v.desde)}${v.precioSugerido ? ` → hora a ${pesos(Math.round(v.precioSugerido / 100) * 100)}` : ''}`,
          message: 'Para sostener el margen, la hora sube lo mismo que tus costos. Los servicios atados se recalculan solos.',
          metadata: { kind: 'servicio_costos', articleId: Number(a.article_id), suba: v.suba, precioSugerido: v.precioSugerido },
          clave: `servicio-costos:${a.business_id}:${a.article_id}:${mes}`, agruparMin: 60 * 24 * 40,
        });
        avisos++;
      }
      if (calc.horasUltimos3 != null && calc.horas > 0 && calc.horasUltimos3 < calc.horas * (1 - UMBRAL_HORAS)) {
        await avisarAlEquipo({
          businessId: a.business_id, type: 'servicio_horas',
          title: `${nombre}: bajó el uso (${Math.round(calc.horasUltimos3)} h por mes en los últimos 3, contra ${Math.round(calc.horas)} h del año)`,
          message: 'No subas el precio por esto: empujá la venta (promos en horarios flojos, abonos, escuelitas).',
          metadata: { kind: 'servicio_horas', articleId: Number(a.article_id) },
          clave: `servicio-horas:${a.business_id}:${a.article_id}:${mes}`, agruparMin: 60 * 24 * 40,
        });
        avisos++;
      }
    } catch (e) {
      console.error('[servicioAvisos]', a.business_id, a.article_id, e.message);
    }
  }
  console.log(`[servicioAvisos] ${anclas.length} anclas revisadas, ${avisos} avisos`);
  return { anclas: anclas.length, avisos };
}

module.exports = { revisarServicios, UMBRAL_SUBA, UMBRAL_HORAS };
