// services/kit/versiones.js
// El kit se baja desde Lazarillo (Diego, 08/11/2026). Una "versión" es el zip "Lazarillo -
// instalar" (INSTALAR EN ESTA PC.bat + _motor con el motor, los generadores y las consultas).
//   - El kit VIVE EN EL SERVIDOR, como código (Diego, 08/11: "no quiero que se publique desde
//     usuario", "¿no podés editarlo igual que el resto de toda la web por código?"): los archivos
//     están en kit/Lazarillo - instalar/ de este repo y se editan como cualquier otro. Al arrancar
//     (y antes de cualquier lectura, por si la migración todavía no estaba) se arma el zip y, si
//     ese contenido todavía no está en kit_versiones, se publica. kit/formato.json dice qué
//     archivos llevan BOM y cuáles saltos CRLF (el repo guarda todo UTF-8 sin BOM y con LF).
//     Se valida que sea el kit y que NO traiga credenciales; se guarda normalizado bajo
//     "Lazarillo - instalar/". No hay forma de publicar desde la app.
//   - zipParaDescargar: la última versión con _motor/lz_api.txt apuntando a ESTE servidor
//     (así el back de pruebas entrega kits que suben a pruebas y producción a producción).
//   - manifiesto / archivo: lo que usa la PC vinculada para actualizarse sin Drive.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const pool = require('../../config/db');

const RAIZ = 'Lazarillo - instalar/';
const PROHIBIDOS = new Set(['lz_vinculo.txt', 'lz_coneccion_render.txt', 'lz_conexion.txt', 'destinos.txt']);
const MAX_ZIP = 20 * 1024 * 1024;

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

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

async function publicar(buffer, { origenSha = null, notas = null } = {}) {
  const archivos = leerKit(buffer);
  const zip = new AdmZip();
  for (const a of archivos) zip.addFile(RAIZ + a.ruta, a.datos);
  const limpio = zip.toBuffer();
  const version = versionDe(archivos);
  const { rows } = await pool.query(
    `INSERT INTO kit_versiones (version, zip, sha256, tamano, archivos, notas, origen_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, version, publicado_en, tamano, archivos`,
    [version, limpio, sha(limpio), limpio.length, archivos.length, notas ? String(notas).slice(0, 500) : null, origenSha]);
  return rows[0];
}

// "V49" -> 49 (para no volver a una versión más vieja si un servicio con el repo atrasado arranca
// después: testing y producción comparten la base).
const numeroDe = (v) => { const m = /(\d+)/.exec(String(v || '')); return m ? Number(m[1]) : null; };

const CARPETA_KIT = path.join(__dirname, '..', '..', 'kit');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

// Arma el zip desde kit/Lazarillo - instalar/ aplicando kit/formato.json. Devuelve
// { buffer, huella } — la huella es del CONTENIDO (rutas + bytes), no del zip, que cambia con la fecha.
function zipDelRepo(carpeta = CARPETA_KIT) {
  const raiz = path.join(carpeta, RAIZ.replace(/\/$/, ''));
  if (!fs.existsSync(raiz)) return null;
  let formato = {};
  try { formato = JSON.parse(fs.readFileSync(path.join(carpeta, 'formato.json'), 'utf8')); } catch { /* sin formato */ }
  const conBom = new Set(formato.bom || []);
  const conCrlf = new Set(formato.crlf || []);
  const rutas = [];
  (function recorrer(dir, rel) {
    for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${n.name}` : n.name;
      if (n.isDirectory()) recorrer(path.join(dir, n.name), r);
      else if (n.isFile()) rutas.push(r);
    }
  })(raiz, '');
  // Un archivo grande puede estar partido en "<nombre>.parte-01", "<nombre>.parte-02"… (el motor,
  // 137 KB): se unen en orden y el zip lleva <nombre>. Así un cambio sube solo el pedazo tocado.
  const PARTE = /^(.+)\.parte-(\d+)$/;
  const partes = new Map();
  const finales = [];
  for (const r of rutas) {
    const m = PARTE.exec(r);
    if (!m) { finales.push(r); continue; }
    if (!partes.has(m[1])) { partes.set(m[1], []); finales.push(m[1]); }
    partes.get(m[1]).push({ n: Number(m[2]), r });
  }
  const leer = (r) => (partes.has(r)
    ? Buffer.concat(partes.get(r).sort((a, b) => a.n - b.n).map((p) => fs.readFileSync(path.join(raiz, p.r))))
    : fs.readFileSync(path.join(raiz, r)));
  finales.sort();
  const zip = new AdmZip();
  const h = crypto.createHash('sha256');
  for (const r of finales) {
    let d = leer(r);
    if (conCrlf.has(r)) d = Buffer.from(d.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'utf8');
    if (conBom.has(r) && !d.subarray(0, 3).equals(BOM)) d = Buffer.concat([BOM, d]);
    zip.addFile(RAIZ + r, d);
    h.update(r).update('\0').update(sha(d)).update('\0');
  }
  return { buffer: zip.toBuffer(), huella: h.digest('hex') };
}

// Al arrancar: publica el kit del repo si ese contenido todavía no está. Nunca tira abajo el
// servidor: cualquier error queda en el log.
async function sincronizarDesdeRepo({ carpeta = CARPETA_KIT } = {}) {
  const delRepo = zipDelRepo(carpeta);
  if (!delRepo) return { estado: 'sin_kit_en_repo' };
  const { buffer, huella: origenSha } = delRepo;
  const cliente = await pool.connect();
  try {
    await cliente.query('SELECT pg_advisory_lock(hashtext($1))', ['kit_versiones_sync']);
    const ya = await cliente.query('SELECT version FROM kit_versiones WHERE origen_sha256 = $1 LIMIT 1', [origenSha]);
    if (ya.rows.length) return { estado: 'al_dia', version: ya.rows[0].version };
    const version = versionDe(leerKit(buffer));
    const act = await leerUltima();
    const nAct = act && numeroDe(act.version);
    const nNueva = numeroDe(version);
    if (nAct != null && nNueva != null && nNueva < nAct) return { estado: 'repo_atrasado', version, vigente: act.version };
    const v = await publicar(buffer, { origenSha, notas: 'desde el repo del servidor' });
    return { estado: 'publicada', version: v.version, archivos: v.archivos, tamano: v.tamano };
  } finally {
    await cliente.query('SELECT pg_advisory_unlock(hashtext($1))', ['kit_versiones_sync']).catch(() => {});
    cliente.release();
  }
}

async function leerUltima({ conZip = false } = {}) {
  const { rows } = await pool.query(
    `SELECT id, version, sha256, tamano, archivos, notas, publicado_en${conZip ? ', zip' : ''}
       FROM kit_versiones ORDER BY publicado_en DESC, id DESC LIMIT 1`);
  return rows[0] || null;
}

// Una sola sincronización por proceso; si falla (ej. la base no respondió) se reintenta en la
// próxima lectura. Toda lectura del kit pasa por acá: así un deploy nuevo entrega siempre el kit
// de su repo, sin que nadie lo publique.
let sincronizacion = null;
function asegurarSincronizado() {
  if (!sincronizacion) {
    sincronizacion = sincronizarDesdeRepo()
      .then((r) => { console.log('[kit] kit del repo:', JSON.stringify(r)); return r; })
      .catch((e) => { sincronizacion = null; console.error('[kit] no se pudo sincronizar el kit del repo:', e.message); return { estado: 'error' }; });
  }
  return sincronizacion;
}

async function ultima(opciones) {
  await asegurarSincronizado();
  return leerUltima(opciones);
}

// Al arrancar el servicio (después de las migraciones, que corren antes del listen).
if (process.env.KIT_NO_SINCRONIZAR !== '1') setTimeout(() => { asegurarSincronizado(); }, 20000).unref();

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

module.exports = { leerKit, publicar, ultima, zipParaDescargar, manifiesto, archivo, sincronizarDesdeRepo, asegurarSincronizado, zipDelRepo, RAIZ };
