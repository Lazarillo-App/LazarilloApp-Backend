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
    // Solo los campos que la doc acepta en el PUT (15/11: mandar la config entera, con campos de solo
    // lectura que devuelve el GET, puede ser lo que MP rechazaba). Los vacíos no se mandan.
    // 15/11 (log real de FC): MP devolvía «Invalid execute_after_withdrawal» con el valor que él mismo da en
    // el GET. Se manda lo mínimo que hace falta; el resto de la config de la cuenta queda como está.
    const ACEPTA = ['file_name_prefix', 'frequency', 'separator', 'display_timezone', 'report_translation', 'include_withdrawal_at_end'];
    const cfg = { columns: [...(actual.data.columns || []).map((c) => ({ key: c.key })), ...faltan.map((key) => ({ key }))] };
    ACEPTA.forEach((k) => { const v = actual.data[k]; if (v != null && !(Array.isArray(v) && v.every((x) => x == null))) cfg[k] = v; });
    // 17/11 (logs de FC y Mairene): sin execute_after_withdrawal MP sigue diciendo «Invalid execute_after_withdrawal»
    // (lo valida aunque no se mande). Va explícito, como en el ejemplo de la doc: false = no arma un reporte tras
    // cada retiro. include_withdrawal_at_end también como booleano.
    cfg.execute_after_withdrawal = false;
    cfg.include_withdrawal_at_end = actual.data.include_withdrawal_at_end === true;
    if (!cfg.file_name_prefix) cfg.file_name_prefix = 'lazarillo';
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
  const todos = Array.isArray(lista.data) ? lista.data : [];
  const items = todos.filter((x) => mismaFecha(x.begin_date, b) && mismaFecha(x.end_date, e));
  const esListo = (x) => x.file_name && (!x.status || /processed|ready|done|enabled/i.test(x.status));
  // 17/11 (quedaba «armando reporte» sin fin): también sirve uno listo que CUBRA el rango, aunque MP haya
  // guardado las fechas con otro formato o se haya pedido uno más largo.
  const cubre = (x) => Date.parse(x.begin_date) <= Date.parse(b) + 1000 && Date.parse(x.end_date) >= Date.parse(e) - 1000;
  const listo = items.find(esListo) || todos.filter((x) => esListo(x) && cubre(x)).sort((x, y) => Date.parse(x.begin_date) - Date.parse(y.begin_date)).pop();
  if (listo) return { listo: true, archivo: listo.file_name };
  const enCurso = items.filter((x) => !/error|deleted|failed/i.test(String(x.status || '')));
  if (enCurso.length) {
    // Diagnóstico: qué dice MP del pedido mientras espera (estado y fechas, sin datos de la cuenta).
    const ver = (x) => `${x.status || '-'} ${x.begin_date}→${x.end_date}${x.file_name ? ' con archivo' : ''}`;
    return { pendiente: true, detalle: `${enCurso.length} pedido(s): ${enCurso.slice(0, 3).map(ver).join(' | ')} · últimos de la cuenta: ${todos.slice(-3).map(ver).join(' | ')}` };
  }
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
const fechaAR = (v) => fechaDe(enAR(v) || v);
// 17/11: el reporte viene en la zona de la cuenta (GMT-04 por defecto) y Lautaro veía todo una hora antes.
// Con zona en el texto se pasa a la hora de Argentina; sin zona queda como viene.
const fmtAR = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const enAR = (v) => {
  const t = String(v || '');
  if (!/T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(t)) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? fmtAR.format(new Date(ms)).replace(' ', 'T') : null;
};
const horaDe = (v) => ((enAR(v) || String(v || '')).match(/T(\d{2}:\d{2})/) || ['', ''])[1];

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
  const docs = new Map(); // documento (CUIT/DNI) de quien pagó, por id de pago
  const egresos = [];
  const comisionesDia = new Map();
  const vistos = new Map();
  for (const f of filas) {
    if (String(f.RECORD_TYPE || '').toLowerCase() !== 'release') continue;
    const id = String(f.SOURCE_ID || '').trim();
    const nombre = String(f.PAYER_NAME || '').replace(/\s+/g, ' ').trim();
    if (id && nombre && num(f.NET_CREDIT_AMOUNT) > 0) nombres.set(id, nombre);
    const doc = String(f.PAYER_ID_NUMBER || '').replace(/\s+/g, '').trim();
    if (id && doc && num(f.NET_CREDIT_AMOUNT) > 0) docs.set(id, doc);
    const fecha = fechaAR(f.DATE) || fechaAR(f.TRANSACTION_DATE);
    if (!fecha) continue;
    const debito = Math.abs(num(f.NET_DEBIT_AMOUNT));
    // 17/11: «reserve_for_payout/payment/refund…» es la plata que MP aparta antes de mandar el retiro o el pago:
    // el mismo importe vuelve a aparecer como payout/payment. No es otra salida (duplicaba 41 de 42 en el Bar).
    if (/^reserve_for_/i.test(String(f.DESCRIPTION || ''))) continue;
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
  return { nombres, docs, egresos };
}

module.exports = { COLUMNAS, asegurarConfig, buscarOPedir, bajar, parsearCSV, analizar, tipoEgreso, _inicioAR: inicioAR, _finAR: finAR };
