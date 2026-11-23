// services/gestion/pagos-proveedor/comprobante.js
// Comprobante de pago adjunto (Diego 23/11/2026): se sube el PDF o la foto de la transferencia, se
// guarda en la base (por negocio) y se lee: importe, fecha, número de operación y banco. No guarda
// ningún pago: solo devuelve los datos para completar la barra de pago, que el usuario revisa.
// Lectura GRATIS primero: el navegador saca el texto (PDF con pdf.js, foto con OCR) y acá se busca
// con reglas. Si con eso no sale el importe y el servidor tiene ANTHROPIC_API_KEY, se le pide al
// modelo (Haiku, el del asistente de alta).
'use strict';

const { sql, db } = require('../db');
const { ErrorDatos } = require('../dashboard/resultados-api');

const rechazo = (mensaje, status = 400) => Object.assign(new ErrorDatos(mensaje), { status });
const MIMES = /^(application\/pdf|image\/(png|jpe?g|webp|gif))$/i;
const MAX_BYTES = 5 * 1024 * 1024;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODELO = 'claude-haiku-4-5-20251001';

const SISTEMA = `Leés comprobantes de pago argentinos (transferencias bancarias, Mercado Pago, depósitos, cheques).
Devolvé SOLO un JSON con estas claves (null si no está):
{"importe": número en pesos (punto decimal, sin separador de miles),
 "fecha": "AAAA-MM-DD" (la fecha de la operación),
 "operacion": número o código de operación/transacción/comprobante (solo letras y números),
 "banco": banco o billetera DESDE donde se pagó (ej. "Galicia", "Santander", "Mercado Pago"),
 "tipo": "transferencia" | "deposito" | "cheque" | "efectivo" | "otro",
 "destinatario": a quién se pagó (nombre o razón social),
 "cuitDestino": CUIT/CUIL del destinatario (solo números)}`;

function extraerJSON(txt) {
  const t = String(txt || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const i = t.indexOf('{'); const j = t.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
}

// Lo que devuelve el modelo, limpio y con tipos seguros.
function normalizar(x) {
  if (!x || typeof x !== 'object') return {};
  const num = (v) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(x.fecha || '')) ? x.fecha : null;
  const txt = (v, n = 80) => (v == null || v === '' ? null : String(v).trim().slice(0, n) || null);
  const operacion = txt(x.operacion, 60) ? String(x.operacion).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 40) || null : null;
  return { importe: num(x.importe), fecha, operacion, banco: txt(x.banco), tipo: txt(x.tipo, 20), destinatario: txt(x.destinatario), cuitDestino: txt(x.cuitDestino, 13)?.replace(/\D/g, '') || null };
}

// ── Lectura por reglas sobre el texto del comprobante (gratis) ──
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const BANCOS = [
  ['Mercado Pago', /mercado\s*pago/i], ['Galicia', /galicia/i], ['Santander', /santander/i], ['BBVA', /bbva|franc[eé]s/i],
  ['Macro', /\bmacro\b/i], ['Nación', /naci[oó]n\b|\bbna\b/i], ['Provincia', /provincia|\bbapro\b|cuenta dni/i], ['Ciudad', /banco ciudad|\bciudad\b/i],
  ['ICBC', /\bicbc\b/i], ['HSBC', /\bhsbc\b/i], ['Credicoop', /credicoop/i], ['Supervielle', /supervielle/i], ['Patagonia', /patagonia/i],
  ['Hipotecario', /hipotecario/i], ['Comafi', /comafi/i], ['Itaú', /ita[uú]/i], ['Brubank', /brubank/i], ['Ualá', /ual[aá]/i],
  ['Naranja X', /naranja\s*x/i], ['Personal Pay', /personal\s*pay/i], ['Prex', /\bprex\b/i],
];
// "372.385,83" / "372385,83" / "372,385.83" / "372385.83" → número.
function numeroAR(t) {
  let x = String(t).replace(/[^\d.,]/g, '');
  if (!x) return null;
  const c = x.lastIndexOf(','), p = x.lastIndexOf('.');
  if (c > p) x = x.replace(/\./g, '').replace(',', '.');
  else if (p > c && x.length - p - 1 === 2 && c >= 0) x = x.replace(/,/g, '');
  else if (p > c && x.length - p - 1 !== 2) x = x.replace(/\./g, '').replace(',', '.');
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}
function leerTexto(texto) {
  const t = String(texto || '').replace(/\r/g, '');
  if (t.replace(/\s/g, '').length < 10) return {};
  const lineas = t.split('\n').map((l) => l.trim()).filter(Boolean);
  // Importe: el que está junto a «importe / monto / total / transferiste…»; si no, el mayor con $.
  const montos = [];
  const reMonto = /(\$|ars)\s*-?\s*(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi;
  lineas.forEach((l, i) => {
    let m; reMonto.lastIndex = 0;
    while ((m = reMonto.exec(l))) {
      const n = numeroAR(m[2].replace(/\s/g, ''));
      if (n) montos.push({ n, clave: /importe|monto|total|transfer|enviaste|pagaste|pago|debitado/i.test(l + ' ' + (lineas[i - 1] || '')) });
    }
  });
  const importe = (montos.find((m) => m.clave) || montos.sort((a, b) => b.n - a.n)[0] || {}).n || null;
  // Fecha: dd/mm/aaaa, dd-mm-aa, «21 de noviembre de 2026» o aaaa-mm-dd; primero la que dice «fecha».
  const fechas = [];
  const anio = (a) => (String(a).length === 2 ? 2000 + Number(a) : Number(a));
  lineas.forEach((l) => {
    const conFecha = /fecha/i.test(l);
    for (const m of l.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g)) fechas.push({ d: +m[1], m: +m[2], a: anio(m[3]), conFecha });
    for (const m of l.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) fechas.push({ d: +m[3], m: +m[2], a: +m[1], conFecha });
    for (const m of l.toLowerCase().matchAll(/\b(\d{1,2})\s+(?:de\s+)?([a-zé]+)\.?\s+(?:de\s+)?(\d{4})\b/g)) {
      const mes = MESES[m[2]] || Object.entries(MESES).find(([k]) => k.startsWith(m[2].slice(0, 3)))?.[1];
      if (mes) fechas.push({ d: +m[1], m: mes, a: +m[3], conFecha });
    }
  });
  const fv = fechas.filter((f) => f.d >= 1 && f.d <= 31 && f.m >= 1 && f.m <= 12 && f.a >= 2000 && f.a <= 2100);
  const f0 = fv.find((f) => f.conFecha) || fv[0];
  const fecha = f0 ? `${f0.a}-${String(f0.m).padStart(2, '0')}-${String(f0.d).padStart(2, '0')}` : null;
  // Número de operación / transacción / comprobante.
  let operacion = null;
  const reClave = /operaci[oó]n|transacci[oó]n|comprobante|referencia|c[oó]digo|\bid\b|n[°º]|nro/i;
  for (let i = 0; i < lineas.length && !operacion; i++) {
    const k = reClave.exec(lineas[i]);
    if (!k) continue;
    const resto = `${lineas[i].slice(k.index + k[0].length)} ${lineas[i + 1] || ''}`;
    for (const m of resto.matchAll(/[A-Za-z0-9][A-Za-z0-9-]{4,}/g)) {
      const tok = m[0];
      if ((tok.match(/\d/g) || []).length < 4 || /^\d{1,2}[/.-]\d/.test(tok) || /^\d{2}-\d{8}-\d$/.test(tok)) continue;
      operacion = tok.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 40);
      break;
    }
  }
  const banco = (BANCOS.find(([, re]) => re.test(t)) || [null])[0];
  const tipo = /transfer/i.test(t) ? 'transferencia' : /dep[oó]sito/i.test(t) ? 'deposito' : /cheque|echeq/i.test(t) ? 'cheque' : /efectivo/i.test(t) ? 'efectivo' : null;
  let destinatario = null;
  for (let i = 0; i < lineas.length && !destinatario; i++) {
    const m = /^(destinatario|beneficiario|para|a nombre de|titular destino)\s*:?\s*(.*)$/i.exec(lineas[i]);
    if (m) destinatario = (m[2] || lineas[i + 1] || '').slice(0, 80) || null;
  }
  return normalizar({ importe, fecha, operacion, banco, tipo, destinatario });
}

// El medio del negocio que corresponde: el que se llama como el banco; si no, el primero de tipo
// banco (transferencias) o de tipo caja (efectivo). Nunca un Descuento.
async function medioSugerido(businessId, leido) {
  const medios = await db.many(sql`SELECT nombre, tipo FROM gestion_medios_pago WHERE business_id = ${businessId} AND activo ORDER BY orden, nombre`);
  const sinTilde = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const banco = sinTilde(leido.banco).replace(/^banco\s+(de\s+)?/, '').trim();
  if (banco) {
    const igual = medios.find((m) => m.tipo !== 'descuento' && sinTilde(m.nombre).includes(banco.split(' ')[0]));
    if (igual) return igual.nombre;
  }
  const tipo = leido.tipo === 'efectivo' ? 'caja' : 'banco';
  return (medios.find((m) => m.tipo === tipo) || medios.find((m) => m.tipo !== 'descuento') || {}).nombre || null;
}

async function leerConModelo(mime, b64) {
  if (!process.env.ANTHROPIC_API_KEY) return { error: 'El lector de comprobantes no está configurado en este servidor.' };
  const bloque = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: mime.replace('jpg', 'jpeg'), data: b64 } };
  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODELO, max_tokens: 400, system: SISTEMA, messages: [{ role: 'user', content: [bloque, { type: 'text', text: 'Leé este comprobante de pago. Solo el JSON.' }] }] }),
    });
    if (!resp.ok) { console.error('[comprobante] Anthropic', resp.status, (await resp.text().catch(() => '')).slice(0, 300)); return { error: 'No se pudo leer el comprobante. Completá los datos a mano.' }; }
    const data = await resp.json();
    const texto = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { datos: normalizar(extraerJSON(texto)) };
  } catch (e) {
    console.error('[comprobante] error', e);
    return { error: 'No se pudo leer el comprobante. Completá los datos a mano.' };
  }
}

// POST /pagos-proveedor/comprobante  { archivo: base64, mime, nombre }
// → { comprobanteId, nombre, datos: {importe, fecha, operacion, banco, tipo, destinatario}, medio, error? }
async function subirComprobante({ organizationId, businessId, usuario, body }) {
  const mime = String(body?.mime || '').toLowerCase();
  if (!MIMES.test(mime)) throw rechazo('Subí un PDF o una foto (JPG o PNG).');
  const b64 = String(body?.archivo || '').replace(/^data:[^,]*,/, '');
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) throw rechazo('El archivo está vacío.');
  if (bytes.length > MAX_BYTES) throw rechazo('El archivo pasa los 5 MB.');
  const nombre = String(body?.nombre || 'comprobante').trim().slice(0, 120) || 'comprobante';
  let datos = leerTexto(String(body?.texto || '').slice(0, 20000));
  let error = null;
  if (!datos.importe && process.env.ANTHROPIC_API_KEY) {
    const r = await leerConModelo(mime, b64);
    if (r.datos && (r.datos.importe || r.datos.fecha)) datos = r.datos;
    else error = r.error || null;
  }
  if (!datos.importe && !error) error = 'No pude leer el importe del comprobante: completalo a mano.';
  const medio = datos.importe || datos.banco ? await medioSugerido(businessId, datos) : null;
  const fila = await db.one(sql`
    INSERT INTO gestion_comprobantes_pago (organization_id, business_id, nombre, mime, bytes, datos, leido, "creadoPor")
    VALUES (${organizationId}, ${businessId}, ${nombre}, ${mime}, ${bytes.length}, ${bytes}, ${JSON.stringify(datos)}::jsonb, ${usuario || null})
    RETURNING id`);
  return { comprobanteId: Number(fila.id), nombre, datos, medio, error: error || null };
}

// GET /pagos-proveedor/comprobante/:id → el archivo (solo del negocio).
async function archivoComprobante({ businessId, id }) {
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.one(sql`SELECT nombre, mime, datos FROM gestion_comprobantes_pago WHERE id = ${id} AND business_id = ${businessId}`);
}

// Que el comprobante sea de este negocio (al guardar el pago).
async function comprobanteValido(cliente, businessId, id) {
  if (id == null) return null;
  const r = await cliente.one(sql`SELECT id FROM gestion_comprobantes_pago WHERE id = ${id} AND business_id = ${businessId}`);
  if (!r) throw rechazo('Ese comprobante no existe.');
  return Number(r.id);
}

module.exports = { subirComprobante, archivoComprobante, comprobanteValido, normalizar, leerTexto };
