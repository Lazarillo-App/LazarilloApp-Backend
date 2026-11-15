// services/mercadopagoDiario.js
// Mercado Pago se trae solo (Diego 14/11/2026: «que todos los días Lazarillo traiga toda la info
// solo, junto con Render o al apretar el botón de sincro»).
//  - Todos los días (services/cron.js, en el back de producción): cada cuenta conectada trae los
//    últimos días — cobros, pagos hechos, devoluciones y el reporte de liberaciones — y una hora
//    después se vuelve a pedir el reporte (MP lo arma en unos minutos).
//  - El punto del header (POST /pulso/actualizar): lo mismo, para un negocio, en segundo plano.
// Qué días: desde lo último que ya hay guardado (o hace 10 días, lo que sea antes; así se
// actualizan devoluciones y acreditaciones recientes), hasta hoy. Tope 92 días por vuelta.
// Además, una vez por cuenta (Diego 14/11: «debe traer todo»): el HISTORIAL completo hacia atrás,
// mes por mes, guardando cada pago entero, hasta 2 meses seguidos sin movimientos (tope 36). Y si
// cambió la forma de armar las filas (VERSION_FILAS), se rearman todas desde lo guardado.
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
    `SELECT m.business_id, m.sucursal, f.hasta::text AS ultimo, m.historial_hasta::text AS historial_hasta,
            m.historial_completo, m.version_filas
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
    if (r.error) return { desde, hasta, ...r };
    if (!c.historial_completo) await recorrerHistorial(c);
    else if ((c.version_filas || 0) < mp.VERSION_FILAS) await mp.rederivarCuenta(c.business_id, c.sucursal);
    return { desde, hasta, ...r };
  } catch (e) {
    return { error: e.message };
  } finally {
    enCurso.delete(clave);
  }
}

/** Meses hacia atrás desde un mes dado (YYYY-MM-01): [{ desde, hasta }] del más nuevo al más viejo. */
function mesesHaciaAtras(desdeMes, cuantos, hoy = hoyAR()) {
  const out = [];
  const d = new Date(`${desdeMes}T12:00:00Z`);
  for (let i = 0; i < cuantos; i++) {
    const ini = d.toISOString().slice(0, 10);
    const f = new Date(d); f.setUTCMonth(f.getUTCMonth() + 1); f.setUTCDate(0);
    const fin = f.toISOString().slice(0, 10);
    out.push({ desde: ini, hasta: fin > hoy ? hoy : fin });
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return out;
}

/** Historial completo, una vez por cuenta: mes por mes hacia atrás, guardando todo entero. */
async function recorrerHistorial(c) {
  const hoy = hoyAR();
  const inicio = c.historial_hasta
    ? mesesHaciaAtras(`${c.historial_hasta.slice(0, 7)}-01`, 2, hoy)[1].desde
    : `${hoy.slice(0, 7)}-01`;
  let vacios = 0, meses = 0, crudos = 0;
  for (const m of mesesHaciaAtras(inicio, 36, hoy)) {
    const r = await mp.sincronizarBanco(c.business_id, c.sucursal, m.desde, m.hasta, { sinReporte: true });
    if (r.error) { console.warn(`[mercadopago:historial] negocio ${c.business_id} ${m.desde}: ${r.error}`); return; }
    meses += 1; crudos += r.crudos || 0;
    vacios = r.crudos ? 0 : vacios + 1;
    await pool.query('UPDATE integraciones_mercadopago SET historial_hasta = $3, historial_intento_at = now() WHERE business_id = $1 AND sucursal = $2',
      [c.business_id, c.sucursal, m.desde]);
    if (vacios >= 2) break;
  }
  await pool.query('UPDATE integraciones_mercadopago SET historial_completo = true, version_filas = $3 WHERE business_id = $1 AND sucursal = $2',
    [c.business_id, c.sucursal, mp.VERSION_FILAS]);
  console.log(`[mercadopago:historial] negocio ${c.business_id} suc ${c.sucursal}: ${meses} meses, ${crudos} pagos guardados enteros`);
  // Pasa una sola vez por cuenta (al vincularla): un aviso para saber que Clientes y Movimientos ya están completos.
  if (crudos) {
    const { avisarAlEquipoSinEsperar } = require('./notificationService');
    avisarAlEquipoSinEsperar({
      businessId: c.business_id, type: 'mercadopago_historial', incluirActor: false,
      title: `Mercado Pago: historial traído (${crudos.toLocaleString('es-AR')} movimientos, ${meses} meses)`,
      message: 'Ya están en Clientes y en Movimientos bancarios.',
      metadata: { link: '/clientes', sucursal: c.sucursal },
    });
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

/**
 * Si alguna cuenta del negocio tiene el historial incompleto y nadie lo está trayendo (sin intento en los
 * últimos 15 minutos), lo arranca. El UPDATE con condición hace que lo tome una sola instancia del back.
 * Lo llama Clientes al abrirse (y en cada vuelta mientras espera): así una cuenta vinculada antes de que
 * existiera el disparo al vincular, o un historial que se cortó (reinicio del server), arranca solo.
 */
async function asegurarHistorial(businessId) {
  const { rows } = await pool.query(
    `UPDATE integraciones_mercadopago SET historial_intento_at = now()
      WHERE business_id = $1 AND NOT coalesce(historial_completo, false)
        AND (historial_intento_at IS NULL OR historial_intento_at < now() - interval '15 minutes')
      RETURNING sucursal`, [businessId]);
  if (rows.length) dispararNegocio(businessId);
  return rows.length;
}

module.exports = { corridaDiaria, dispararNegocio, traerTodas, rangoDiario, mesesHaciaAtras, asegurarHistorial };
