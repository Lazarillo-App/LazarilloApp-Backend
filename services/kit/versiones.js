// services/kit/versiones.js
// El kit se baja desde Lazarillo (Diego, 08/11/2026). Una "versión" es el zip "Lazarillo -
// instalar" (INSTALAR EN ESTA PC.bat + _motor con el motor, los generadores y las consultas).
//   - publicar: lo sube el equipo de Lazarillo (KIT_PUBLICADORES o app_admin). Se valida que
//     sea el kit y que NO traiga credenciales; se guarda normalizado bajo "Lazarillo - instalar/".
//   - zipParaDescargar: la última versión con _motor/lz_api.txt apuntando a ESTE servidor
//     (así el back de pruebas entrega kits que suben a pruebas y producción a producción).
//   - manifiesto / archivo: lo que usa la PC vinculada para actualizarse sin Drive.
'use strict';

const crypto = require('crypto');
const AdmZip = require('adm-zip');
const pool = require('../../config/db');

const RAIZ = 'Lazarillo - instalar/';
const PROHIBIDOS = new Set(['lz_vinculo.txt', 'lz_coneccion_render.txt', 'lz_conexion.txt', 'destinos.txt']);
const MAX_ZIP = 20 * 1024 * 1024;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

function puedePublicar(user) {
  if (!user) return false;
  if (user.role === 'app_admin') return true;
  const lista = String(process.env.KIT_PUBLICADORES || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  return !!user.email && lista.includes(String(user.email).toLowerCase());
}

// Devuelve [{ ruta (relativa a la raíz del kit, con /), datos (Buffer) }] o error.
function leerKit(buffer) {
  if (!buffer || buffer.length < 22 || buffer.length > MAX_ZIP) throw err('zip_invalido');
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw err('zip_invalido'); }
  const entradas = zip.getEntries().filter((e) => !e.isDirectory);
  const motor = entradas.find((e) => /(^|\/)_motor\/lz_lazarillo\.ps1$/i.test(e.entryName));
  if (!motor) throw err('no_es_el_kit: falta _motor/lz_lazarillo.ps1');
  const prefijo = motor.entryName.slice(0, motor.entryName.toLowerCase().lastIndexOf('_motor/'));
  const out = [];
  for (const e of entradas) {
    if (!e.entryName.startsWith(prefijo)) continue;
    const ruta = e.entryName.slice(prefijo.length);
    if (!ruta || ruta.includes('..') || ruta.startsWith('/') || ruta.includes('\\')) throw err(`ruta_invalida: ${ruta}`);
    const nombre = ruta.split('/').pop().toLowerCase();
    if (PROHIBIDOS.has(nombre)) throw err(`el_zip_trae_credenciales: ${ruta}`);
    out.push({ ruta, datos: e.getData() });
  }
  return out;
}

function versionDe(archivos) {
  const m = archivos.find((a) => a.ruta.toLowerCase() === '_motor/lz_lazarillo.ps1');
  const v = /\$MOTOR_VER\s*=\s*"([^"]+)"/.exec(m ? m.datos.toString('utf8') : '');
  return v ? v[1] : 'sin_version';
}

async function publicar(buffer, userId, notas) {
  const archivos = leerKit(buffer);
  const zip = new AdmZip();
  for (const a of archivos) zip.addFile(RAIZ + a.ruta, a.datos);
  const limpio = zip.toBuffer();
  const version = versionDe(archivos);
  const { rows } = await pool.query(
    `INSERT INTO kit_versiones (version, zip, sha256, tamano, archivos, notas, publicado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version, publicado_en, tamano, archivos`,
    [version, limpio, sha(limpio), limpio.length, archivos.length, notas ? String(notas).slice(0, 500) : null, userId]);
  return rows[0];
}

async function ultima({ conZip = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, version, sha256, tamano, archivos, notas, publicado_en${conZip ? ', zip' : ''}
       FROM kit_versiones ORDER BY publicado_en DESC, id DESC LIMIT 1`);
  return rows[0] || null;
}

async function zipParaDescargar(apiUrl) {
  const v = await ultima({ conZip: true });
  if (!v) return null;
  const zip = new AdmZip(v.zip);
  const ruta = RAIZ + '_motor/lz_api.txt';
  if (zip.getEntry(ruta)) zip.deleteFile(ruta);
  zip.addFile(ruta, Buffer.from(String(apiUrl).replace(/\/+$/, '') + '\r\n', 'utf8'));
  return { version: v.version, buffer: zip.toBuffer() };
}

// Lo de _motor/ (lo que la PC vinculada se actualiza sola). lz_api.txt no va: es de cada PC.
async function manifiesto() {
  const v = await ultima({ conZip: true });
  if (!v) return null;
  const zip = new AdmZip(v.zip);
  const archivos = zip.getEntries()
    .filter((e) => !e.isDirectory && e.entryName.startsWith(RAIZ + '_motor/') && !/\/lz_api\.txt$/i.test(e.entryName))
    .map((e) => { const d = e.getData(); return { ruta: e.entryName.slice((RAIZ + '_motor/').length), sha256: sha(d), tamano: d.length }; });
  return { version: v.version, publicado: v.publicado_en, archivos };
}

async function archivo(ruta) {
  const r = String(ruta || '');
  if (!r || r.includes('..') || r.startsWith('/') || r.includes('\\') || /(^|\/)lz_api\.txt$/i.test(r)) return null;
  const v = await ultima({ conZip: true });
  if (!v) return null;
  const e = new AdmZip(v.zip).getEntry(RAIZ + '_motor/' + r);
  return e && !e.isDirectory ? e.getData() : null;
}

module.exports = { puedePublicar, leerKit, publicar, ultima, zipParaDescargar, manifiesto, archivo, RAIZ };
