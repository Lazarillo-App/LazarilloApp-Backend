// services/mercadopagoDiario.js
// Mercado Pago se trae solo (Diego 14/11/2026: «que todos los días Lazarillo traiga toda la info
// solo, junto con Render o al apretar el botón de sincro»).
//  - Todos los días (services/cron.js, en el back de producción): cada cuenta conectada trae los
//    últimos días — cobros, pagos hechos, devoluciones y el reporte de liberaciones — y una hora
//    después se vuelve a pedir el reporte (MP lo arma en unos minutos).
//  - El punto del header (POST /pulso/actualizar): lo mismo, para un negocio, en segundo plano.
// Qué días: desde lo último que ya hay guardado (o hace 10 días, lo que sea antes; así se
// actualizan devoluciones y acreditaciones recientes), hasta hoy. Tope 92 días por vuelta.
'use strict';

const pool = require('../config/db');
const mp = require('./mercadopagoService');

const TZ = 'America/Argentina/Buenos_Aires';
const DIAS_ATRAS = 10;
const TOPE_DIAS = 92;
const enCurso = new Set();

const hoyAR = () => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date());
const restar = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

/** Rango a traer para una cuenta: desde lo último guardado (o 10 días atrás) hasta hoy. */
function rangoDiario(ultimoGuardado, hoy = hoyAR()) {
  let desde = restar(hoy, DIAS_ATRAS);
  if (ultimoGuardado && ultimoGuardado < desde) desde = ultimoGuardado;
  const tope = restar(hoy, TOPE_DIAS - 1);
  if (desde < tope) desde = tope;
  return { desde, hasta: hoy };
}

async function cuentas(businessId = null) {
  const { rows } = await pool.query(
    `SELECT m.business_id, m.sucursal, f.hasta::text AS ultimo
       FROM integraciones_mercadopago m
       LEFT JOIN conciliacion_fuentes f ON f.business_id = m.business_id AND f.sucursal = m.sucursal AND f.tipo = 'banco'
      WHERE ($1::int IS NULL OR m.business_id = $1)
      ORDER BY m.business_id, m.sucursal`, [businessId]);
  return rows;
}

/** Trae lo de una cuenta. Devuelve el resultado de sincronizarBanco (o el error). */
async function traerCuenta(c) {
  const clave = `${c.business_id}:${c.sucursal}`;
  if (enCurso.has(clave)) return { saltada: 'en_curso' };
  enCurso.add(clave);
  try {
    const { desde, hasta } = rangoDiario(c.ultimo);
    const r = await mp.sincronizarBanco(c.business_id, c.sucursal, desde, hasta);
    return { desde, hasta, ...r };
  } catch (e) {
    return { error: e.message };
  } finally {
    enCurso.delete(clave);
  }
}

/** Todas las cuentas conectadas (cron diario). Una por vez: no satura la API de MP. */
async function traerTodas({ businessId = null, origen = 'cron' } = {}) {
  const lista = await cuentas(businessId);
  const pendientes = [];
  for (const c of lista) {
    const r = await traerCuenta(c);
    console.log(`[mercadopago:${origen}] negocio ${c.business_id} suc ${c.sucursal} ${r.desde || ''}→${r.hasta || ''}`,
      r.error ? `error ${r.error}` : `cobros ${r.cobros ?? '-'} pagos ${r.pagos_hechos ?? '-'} devol ${r.devoluciones ?? '-'} reporte ${r.reporte || '-'}${r.motivo ? ` (${r.motivo})` : ''}`);
    if (r.reporte === 'pendiente') pendientes.push({ ...c, desde: r.desde, hasta: r.hasta });
  }
  return { cuentas: lista.length, pendientes };
}

/** Segunda pasada del reporte para las que quedaron pendientes. */
async function reintentarReportes(pendientes, origen = 'cron') {
  for (const c of pendientes) {
    const r = await mp.aplicarReporte(c.business_id, c.sucursal, c.desde, c.hasta).catch((e) => ({ reporte: 'error', motivo: e.message }));
    console.log(`[mercadopago:${origen}] reporte negocio ${c.business_id} suc ${c.sucursal}: ${r.reporte || r.error}${r.motivo ? ` (${r.motivo})` : ''}`);
  }
}

/** Cron: trae todo y, una hora después, el reporte que quedó pendiente. */
async function corridaDiaria() {
  const { pendientes } = await traerTodas({ origen: 'cron' });
  if (pendientes.length) setTimeout(() => { reintentarReportes(pendientes, 'cron').catch(() => {}); }, 60 * 60_000).unref?.();
}

/** Botón del header: un negocio, en segundo plano; el reporte se vuelve a pedir a los 5 minutos. */
function dispararNegocio(businessId) {
  setImmediate(async () => {
    try {
      const { cuentas: n, pendientes } = await traerTodas({ businessId, origen: 'pulso' });
      if (n && pendientes.length) setTimeout(() => { reintentarReportes(pendientes, 'pulso').catch(() => {}); }, 5 * 60_000).unref?.();
    } catch (e) {
      console.error('[mercadopago:pulso]', e.message);
    }
  });
}

module.exports = { corridaDiaria, dispararNegocio, traerTodas, rangoDiario };
