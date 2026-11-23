// services/gestion/pagos-proveedor/comprobante.js
// Comprobante de pago adjunto (Diego 23/11/2026): se sube el PDF o la foto de la transferencia, se
// guarda en la base (por negocio) y se lee con el mismo modelo que lee cartas y facturas en el
// asistente de alta (Haiku): importe, fecha, número de operación y banco. No guarda ningún pago:
// solo devuelve los datos para completar la barra de pago, que el usuario revisa y confirma.
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
  const { datos = {}, error } = await leerConModelo(mime, b64);
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

module.exports = { subirComprobante, archivoComprobante, comprobanteValido, normalizar };
