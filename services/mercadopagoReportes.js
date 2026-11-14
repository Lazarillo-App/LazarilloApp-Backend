// services/mercadopagoReportes.js
// Reporte de liberaciones de Mercado Pago por API (usuaria 14/11/2026). La búsqueda de pagos
// (payments/search) no trae el nombre de quien transfiere ni lo que sale de la cuenta; este
// reporte sí: PAYER_NAME (transferencias y QR) y todos los débitos (retiros, impuestos,
// devoluciones, contracargos, cuotas de préstamos) más las comisiones de cada cobro.
//
// MP lo arma de forma asincrónica: se pide para un rango y en unos minutos aparece en la lista.
// Docs: https://www.mercadopago.com.ar/developers/es/docs/reports/released-money/api
'use strict';

const API = 'https://api.mercadopago.com';

// Columnas que necesitamos (se agregan a la configuración del reporte de la cuenta).
const COLUMNAS = [
  'DATE', 'SOURCE_ID', 'EXTERNAL_REFERENCE', 'RECORD_TYPE', 'DESCRIPTION', 'NET_CREDIT_AMOUNT', 'NET_DEBIT_AMOUNT',
  'GROSS_AMOUNT', 'MP_FEE_AMOUNT', 'FINANCING_FEE_AMOUNT', 'SHIPPING_FEE_AMOUNT', 'TAXES_AMOUNT', 'PAYMENT_METHOD',
  'PAYMENT_METHOD_TYPE', 'TRANSACTION_DATE', 'PAYER_NAME', 'PAYER_ID_NUMBER', 'PAYOUT_BANK_ACCOUNT_NUMBER',
];

async function llamar(url, { token, method = 'GET', body, texto = false, timeout = 30000 } = {}) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await r.text();
  let data = raw;
  if (!texto) { try { data = raw ? JSON.parse(raw) : null; } catch { data = null; } }
  return { status: r.status, ok: r.ok, data };
}

/** Deja la configuración del reporte con nuestras columnas (sin sacar las que ya tenga). */
async function asegurarConfig(token, { llamar: ll = llamar } = {}) {
  const url = `${API}/v1/account/release_report/config`;
  const actual = await ll(url, { token });
  if (actual.ok && actual.data) {
    const tiene = new Set((actual.data.columns || []).map((c) => c.key));
    const faltan = COLUMNAS.filter((k) => !tiene.has(k));
    if (!faltan.length) return { ok: true };
    const cfg = { ...actual.data, columns: [...(actual.data.columns || []), ...faltan.map((key) => ({ key }))] };
    delete cfg.scheduled;
    const r = await ll(url, { token, method: 'PUT', body: cfg });
    return r.ok ? { ok: true } : { error: 'mp_reporte_config', detalle: r.data };
  }
  if (actual.status !== 404) return { error: 'mp_reporte_config', detalle: actual.data };
  const r = await ll(url, {
    token, method: 'POST',
    body: {
      columns: COLUMNAS.map((key) => ({ key })), file_name_prefix: 'lazarillo', display_timezone: 'GMT-03',
      report_translation: 'en', include_withdrawal_at_end: false, frequency: { hour: 0, type: 'monthly', value: 1 },
    },
  });
  return r.ok ? { ok: true } : { error: 'mp_reporte_config', detalle: r.data };
}

// Un día de Argentina en UTC: 00:00 -03 = 03:00Z.
const inicioAR = (dia) => `${dia}T03:00:00Z`;
const finAR = (dia) => {
  const d = new Date(`${dia}T03:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCSeconds(d.getUTCSeconds() - 1);
  return d.toISOString().replace('.000Z', 'Z');
};
const mismaFecha = (a, b) => Date.parse(a) === Date.parse(b);

/**
 * Busca un reporte de ese rango; si no hay ninguno, lo pide. Devuelve
 * { listo: true, archivo } | { pendiente: true } | { error }.
 */
async function buscarOPedir(token, desde, hasta, { llamar: ll = llamar } = {}) {
  const b = inicioAR(desde);
  const e = finAR(hasta);
  const lista = await ll(`${API}/v1/account/release_report/list`, { token });
  if (!lista.ok) return { error: 'mp_reporte_lista', detalle: lista.data };
  const items = (Array.isArray(lista.data) ? lista.data : []).filter((x) => mismaFecha(x.begin_date, b) && mismaFecha(x.end_date, e));
  const listo = items.find((x) => x.file_name && (!x.status || /processed|ready|done/i.test(x.status)));
  if (listo) return { listo: true, archivo: listo.file_name };
  if (items.some((x) => !/error|deleted|failed/i.test(String(x.status || '')))) return { pendiente: true };
  const r = await ll(`${API}/v1/account/release_report`, { token, method: 'POST', body: { begin_date: b, end_date: e } });
  if (r.status === 202 || r.ok) return r.status === 203 ? { error: 'mp_reporte_no_creado' } : { pendiente: true };
  return { error: 'mp_reporte_no_creado', detalle: r.data };
}

async function bajar(token, archivo, { llamar: ll = llamar } = {}) {
  const r = await ll(`${API}/v1/account/release_report/${encodeURIComponent(archivo)}`, { token, texto: true, timeout: 60000 });
  if (!r.ok) return { error: 'mp_reporte_descarga' };
  return { csv: String(r.data || '') };
}

/** CSV (coma o punto y coma, con comillas) → objetos por encabezado. */
function parsearCSV(texto) {
  const t = String(texto || '').replace(/^﻿/, '');
  const primera = t.split(/\r?\n/, 1)[0] || '';
  const sep = (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ';' : ',';
  const filas = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (comillas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i++; } else if (c === '"') comillas = false; else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === sep) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.some((x) => x !== '')) filas.push(fila);
      fila = [];
    } else campo += c;
  }
  fila.push(campo);
  if (fila.some((x) => x !== '')) filas.push(fila);
  if (!filas.length) return [];
  const enc = filas[0].map((h) => h.trim().toUpperCase());
  return filas.slice(1).map((f) => Object.fromEntries(enc.map((h, i) => [h, (f[i] ?? '').trim()])));
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const fechaDe = (v) => (String(v || '').match(/\d{4}-\d{2}-\d{2}/) || [''])[0];
const horaDe = (v) => (String(v || '').match(/T(\d{2}:\d{2})/) || ['', ''])[1];

// Qué es cada débito, en palabras.
function tipoEgreso(desc) {
  const d = String(desc || '').toLowerCase();
  if (d === 'payout' || d.includes('withdrawal')) return 'Retiro';
  if (d.startsWith('tax_') || d.includes('tax')) return 'Impuesto';
  if (d.includes('refund')) return 'Devolución';
  if (d.includes('chargeback') || d.includes('dispute')) return 'Contracargo';
  if (d === 'credit_payment') return 'Cuota de préstamo';
  if (d.startsWith('reserve_')) return 'Reserva';
  if (d.startsWith('shipping')) return 'Envío';
  if (d.includes('fee')) return 'Comisión';
  if (d === 'payment') return 'Pago';
  return 'Otro';
}

/**
 * Del reporte: nombres de pagadores por id de pago, y los egresos (débitos + comisiones e
 * impuestos que MP descontó de cada cobro, sumados por día).
 */
function analizar(filas) {
  const nombres = new Map();
  const egresos = [];
  const comisionesDia = new Map();
  const vistos = new Map();
  for (const f of filas) {
    if (String(f.RECORD_TYPE || '').toLowerCase() !== 'release') continue;
    const id = String(f.SOURCE_ID || '').trim();
    const nombre = String(f.PAYER_NAME || '').replace(/\s+/g, ' ').trim();
    if (id && nombre && num(f.NET_CREDIT_AMOUNT) > 0) nombres.set(id, nombre);
    const fecha = fechaDe(f.DATE) || fechaDe(f.TRANSACTION_DATE);
    if (!fecha) continue;
    const debito = Math.abs(num(f.NET_DEBIT_AMOUNT));
    if (debito > 0) {
      const base = `mpr:${id || fecha}:${String(f.DESCRIPTION || '').toLowerCase()}`;
      const n = (vistos.get(base) || 0) + 1;
      vistos.set(base, n);
      egresos.push({
        id: n > 1 ? `${base}:${n}` : base, origen: 'reporte', fecha, hora: horaDe(f.DATE),
        tipo: tipoEgreso(f.DESCRIPTION), detalle: String(f.DESCRIPTION || ''), imp: Math.round(debito * 100) / 100,
        cuenta: String(f.PAYOUT_BANK_ACCOUNT_NUMBER || ''), mpId: id || null,
      });
    }
    if (num(f.NET_CREDIT_AMOUNT) > 0) {
      const com = Math.abs(num(f.MP_FEE_AMOUNT)) + Math.abs(num(f.FINANCING_FEE_AMOUNT)) + Math.abs(num(f.SHIPPING_FEE_AMOUNT));
      const imp = Math.abs(num(f.TAXES_AMOUNT));
      const d = comisionesDia.get(fecha) || { com: 0, imp: 0, n: 0 };
      d.com += com; d.imp += imp; d.n += 1;
      comisionesDia.set(fecha, d);
    }
  }
  for (const [fecha, d] of comisionesDia) {
    if (d.com > 0) egresos.push({ id: `mpc:${fecha}:comision`, origen: 'reporte', fecha, hora: '', tipo: 'Comisión', detalle: `Comisiones de MP de ${d.n} cobro${d.n === 1 ? '' : 's'}`, imp: Math.round(d.com * 100) / 100 });
    if (d.imp > 0) egresos.push({ id: `mpc:${fecha}:retencion`, origen: 'reporte', fecha, hora: '', tipo: 'Impuesto', detalle: `Retenciones sobre ${d.n} cobro${d.n === 1 ? '' : 's'}`, imp: Math.round(d.imp * 100) / 100 });
  }
  return { nombres, egresos };
}

module.exports = { COLUMNAS, asegurarConfig, buscarOPedir, bajar, parsearCSV, analizar, tipoEgreso, _inicioAR: inicioAR, _finAR: finAR };
