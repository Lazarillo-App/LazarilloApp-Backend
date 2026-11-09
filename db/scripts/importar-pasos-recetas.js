// db/scripts/importar-pasos-recetas.js
//
// Importación masiva del paso a paso y la foto de las recetas desde una carpeta de la PC (pedido de la
// usuaria 2026-10-30, negocio 147: 200+ archivos). Corre en su PC: los archivos están ahí, y las fotos
// suben a Cloudinary con las credenciales del .env local.
//
// Archivos: "<Categoria>_<codigo>_<nombre>[2].<txt|jpg|png|jpeg>", también dentro de subcarpetas.
//  - Elaborados_<codigo>  → insumo elaborado con ese codigo_maxi (su receta: recetas.insumo_id).
//  - Comidas / Bebidas / Cocteleria_<codigo> → artículo con ese código de MaxiRest (recetas.article_id).
//    El texto de un trago puede llamarse Cocteleria_174 y su foto Bebidas_174: se emparejan por el número.
//  - Los .txt vienen de Notepad (UTF-16): se decodifican según su marca. Cada renglón es un paso; las
//    viñetas (■ • - *) se sacan; "Preparación: …" queda como título "Preparación" + el paso.
//
//   node db/scripts/importar-pasos-recetas.js "<carpeta>" [--negocio=147]
//       PRUEBA (solo lee, no sube nada): qué receta le toca a cada archivo y qué hay que revisar.
//   node db/scripts/importar-pasos-recetas.js "<carpeta>" --aplicar --confirmo-host=<host de DATABASE_URL> [--negocio=147] [--pisar]
//       Carga. Sin --pisar NO toca una receta que ya tiene paso a paso o foto (completa solo lo que falta).
//       Una receta que todavía no existe no se crea: se informa.
'use strict';

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const pool = require('../../config/db');

const argValor = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const CARPETA = process.argv[2];
const APLICAR = process.argv.includes('--aplicar');
const PISAR = process.argv.includes('--pisar');
const PISAR_NOMBRE = process.argv.includes('--incluir-distintos'); // cargar aunque el nombre del archivo no se parezca al de Lazarillo
// Entre varios textos del mismo código, los "viejo" / "copia" / "(1)" van al final.
const viejo = (archivo) => (/(viej|copia|\(\d+\))/i.test(path.basename(archivo)) ? 1 : 0);
const HOST = argValor('confirmo-host');
const NEGOCIO = Number(argValor('negocio') || 147);
const MAX_FOTOS = 6; // lo mismo que admite la pantalla de notas

const RE = /^(?:Copia de )?(Elaborados|Comidas|Bebidas|Cocteleria)_(\d+)_?(.*?)\.(txt|jpe?g|png)$/i;
const TITULO = '## ';

function archivos(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^__MACOSX$/i.test(e.name)) out.push(...archivos(p)); } else out.push(p);
  }
  return out;
}

function decodificar(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  const ceros = buf.filter((x, i) => i % 2 === 1 && x === 0).length;
  if (ceros > buf.length / 4) return buf.toString('utf16le');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return buf.toString('latin1'); }
}

// Texto → pasos de la receta (array de strings; "## X" es un título de sección, como en la pantalla).
function pasosDesdeTexto(texto, nombre) {
  const pasos = [];
  for (let l of texto.replace(/^﻿/, '').split(/\r?\n/)) {
    l = l.replace(/^[\s■•▪●◦\-*·]+/, '').replace(/\s+/g, ' ').trim();
    if (!l) continue;
    if (/^receta\b/i.test(l) && pasos.length === 0 && similitud(l, nombre) > 0.3) continue; // encabezado "Receta Elaborados 1000 …"
    const rotulo = l.match(/^([A-ZÁÉÍÓÚÑa-záéíóúñ ]{3,20}):\s*(.+)$/);
    if (rotulo) { pasos.push(TITULO + rotulo[1].trim()); pasos.push(rotulo[2].trim()); continue; }
    if (/^[A-ZÁÉÍÓÚÑa-záéíóúñ ]{3,25}:$/.test(l)) { pasos.push(TITULO + l.slice(0, -1).trim()); continue; }
    pasos.push(l);
  }
  return pasos;
}

const normalizar = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
function similitud(a, b) {
  const A = new Set(normalizar(a).split(' ').filter((x) => x.length > 1));
  const B = new Set(normalizar(b).split(' ').filter((x) => x.length > 1));
  if (!A.size || !B.size) return 0;
  let comunes = 0;
  for (const x of A) if (B.has(x)) comunes += 1;
  return comunes / Math.min(A.size, B.size);
}

// Agrupa por receta: E<codigo> (elaborado) o A<codigo> (artículo).
function agrupar(lista) {
  const grupos = new Map();
  const sueltos = [];
  for (const p of lista) {
    const m = path.basename(p).match(RE);
    if (!m) { if (/\.(txt|jpe?g|png)$/i.test(p)) sueltos.push(path.basename(p)); continue; }
    const [, cat, cod, resto, ext] = m;
    const clave = `${/^elaborados$/i.test(cat) ? 'E' : 'A'}${Number(cod)}`;
    const g = grupos.get(clave) ?? { clave, tipo: clave[0], codigo: Number(cod), textos: [], fotos: [] };
    grupos.set(clave, g);
    const nombreArchivo = resto.replace(/\(\d+\)$/, '').replace(/\d$/, '').trim();
    if (/^txt$/i.test(ext)) g.textos.push({ archivo: p, nombre: nombreArchivo });
    else g.fotos.push({ archivo: p, nombre: nombreArchivo });
  }
  // Fotos: primero la "principal" (sin número al final), después las demás.
  for (const g of grupos.values()) g.fotos.sort((a, b) => /\d\.\w+$/.test(path.basename(a.archivo)) - /\d\.\w+$/.test(path.basename(b.archivo)) || a.archivo.localeCompare(b.archivo));
  return { grupos: [...grupos.values()], sueltos };
}

async function bizInsumos(c, businessId) {
  const { rows } = await c.query('SELECT created_from, organization_id FROM app_businesses WHERE id = $1', [businessId]);
  const b = rows[0];
  if (!b || b.created_from !== 'from_group' || !b.organization_id) return businessId;
  const { rows: r } = await c.query(
    `SELECT id FROM app_businesses WHERE organization_id = $1 AND (created_from IS NULL OR created_from IN ('manual','onboarding')) ORDER BY id LIMIT 1`, [b.organization_id]);
  return Number(r[0]?.id ?? businessId);
}

async function destino(c, g, bizIns) {
  if (g.tipo === 'E') {
    const { rows } = await c.query(
      `SELECT i.id, i.nombre, r.id AS receta_id, r.pasos, r.foto, r.fotos
         FROM insumos i LEFT JOIN recetas r ON r.insumo_id = i.id AND r.business_id = $3
        WHERE i.business_id = $1 AND regexp_replace(TRIM(i.codigo_maxi::text), '\\.0+$', '') = $2
        ORDER BY (r.id IS NOT NULL) DESC, i.activo DESC NULLS LAST, i.id LIMIT 1`,
      [bizIns, String(g.codigo), NEGOCIO]);
    return rows[0] ? { ...rows[0], que: 'elaborado' } : null;
  }
  const { rows } = await c.query(
    `SELECT a.articulo_id AS id, a.nombre, r.id AS receta_id, r.pasos, r.foto, r.fotos
       FROM maxi_articles a LEFT JOIN recetas r ON r.article_id = a.articulo_id AND r.business_id = a.business_id AND r.active
      WHERE a.business_id = $1 AND a.articulo_id = $2 LIMIT 1`,
    [NEGOCIO, g.codigo]);
  return rows[0] ? { ...rows[0], que: 'artículo' } : null;
}

// Cloudinary no acepta imágenes de más de 10 MB: las más grandes se achican antes a un JPG de 2400 px
// de lado mayor (con lo que trae Windows; el script corre en la PC de la usuaria).
const TOPE_BYTES = 9.5 * 1024 * 1024;
function achicar(archivo) {
  if (fs.statSync(archivo).size <= TOPE_BYTES) return archivo;
  const salida = path.join(require('os').tmpdir(), `receta-${Date.now()}-${path.basename(archivo).replace(/\.[^.]+$/, '')}.jpg`);
  const ps = `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($env:FOTO_IN)
$k = [Math]::Min([double]1, [double]2400 / [Math]::Max($img.Width, $img.Height))
$w = [int]($img.Width * $k); $h = [int]($img.Height * $k)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($img, 0, 0, $w, $h)
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$par = New-Object System.Drawing.Imaging.EncoderParameters 1
$par.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L
$bmp.Save($env:FOTO_OUT, $enc, $par)
$g.Dispose(); $bmp.Dispose(); $img.Dispose()`;
  const r = require('child_process').spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { env: { ...process.env, FOTO_IN: archivo, FOTO_OUT: salida }, encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(salida)) throw new Error(`no se pudo achicar la foto: ${(r.stderr || '').trim().slice(0, 200)}`);
  return salida;
}

async function subirFoto(cloudinary, archivo, recetaId) {
  const r = await cloudinary.uploader.upload(achicar(archivo), {
    folder: `lazarillo/recetas/importacion-${NEGOCIO}`,
    public_id: `receta_${recetaId}_${path.basename(archivo).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 60)}`,
    overwrite: true,
    transformation: [{ width: 1200, height: 900, crop: 'limit', quality: 'auto' }],
  });
  return r.secure_url;
}

async function main() {
  if (!CARPETA || !fs.existsSync(CARPETA)) throw new Error('indicá la carpeta: node db/scripts/importar-pasos-recetas.js "<carpeta>"');
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (APLICAR && HOST !== host) throw new Error(`para aplicar, confirmá el destino: --confirmo-host=${host}`);
  console.log(`${APLICAR ? `APLICAR${PISAR ? ' (pisando lo que haya)' : ''}` : 'PRUEBA (solo lee, no sube nada)'} → ${host} · negocio ${NEGOCIO}\n`);

  const { grupos, sueltos } = agrupar(archivos(CARPETA));
  const c = await pool.connect();
  const cloudinary = APLICAR ? require('../../config/cloudinary') : null;
  const filas = [];
  const cuenta = { cargadas: 0, conPasos: 0, conFoto: 0, revisar: 0, noEncontradas: 0, sinReceta: 0, yaTenian: 0 };
  try {
    if (!APLICAR) await c.query('BEGIN READ ONLY');
    const bizIns = await bizInsumos(c, NEGOCIO);
    for (const g of grupos.sort((a, b) => a.clave.localeCompare(b.clave, undefined, { numeric: true }))) {
      const d = await destino(c, g, bizIns);
      const nombreArchivo = g.textos[0]?.nombre || g.fotos[0]?.nombre || '';
      const obs = [];
      if (!d) { cuenta.noEncontradas += 1; filas.push({ codigo: g.clave, archivo: nombreArchivo, lazarillo: '—', estado: `NO ENCONTRADO (${g.tipo === 'E' ? 'no hay insumo con ese código' : 'no hay artículo con ese código'})` }); continue; }
      if (!d.receta_id) { cuenta.sinReceta += 1; filas.push({ codigo: g.clave, archivo: nombreArchivo, lazarillo: d.nombre, estado: `${d.que} SIN RECETA: no se carga` }); continue; }

      // Texto: si hay varios para el mismo código, el que más se parece al nombre en Lazarillo.
      const textos = g.textos.map((t) => ({ ...t, pasos: pasosDesdeTexto(decodificar(fs.readFileSync(t.archivo)), d.nombre) }))
        .filter((t) => t.pasos.length)
        .sort((a, b) => viejo(a.archivo) - viejo(b.archivo) || similitud(b.nombre, d.nombre) - similitud(a.nombre, d.nombre));
      if (g.textos.length > 1) obs.push(`${g.textos.length} textos, uso "${textos[0]?.nombre ?? '?'}"`);
      if (g.textos.length && !textos.length) obs.push('texto vacío');
      // El nombre más parecido entre los archivos de ese código (a veces uno se llama "34" o "3").
      const sim = Math.max(0, ...[...g.textos, ...g.fotos].map((x) => similitud(x.nombre, d.nombre)));
      const distinto = sim < 0.5;
      if (distinto) obs.push(PISAR_NOMBRE ? 'NOMBRE DISTINTO' : 'NOMBRE DISTINTO: no se carga (--incluir-distintos)');
      const tienePasos = Array.isArray(d.pasos) && d.pasos.length > 0;
      const tieneFoto = !!d.foto || (Array.isArray(d.fotos) && d.fotos.length > 0);
      const vale = !distinto || PISAR_NOMBRE;
      const ponerPasos = vale && textos.length > 0 && (PISAR || !tienePasos);
      const ponerFotos = vale && g.fotos.length > 0 && (PISAR || !tieneFoto);
      if (textos.length && tienePasos && !PISAR) obs.push('ya tenía paso a paso: no se toca');
      if (g.fotos.length && tieneFoto && !PISAR) obs.push('ya tenía foto: no se toca');
      if (g.fotos.length > MAX_FOTOS) obs.push(`${g.fotos.length} fotos, entran ${MAX_FOTOS}`);
      if (!ponerPasos && !ponerFotos) cuenta.yaTenian += 1;
      if (obs.some((o) => /DISTINTO|vacío|textos/.test(o))) cuenta.revisar += 1;

      if (APLICAR && (ponerPasos || ponerFotos)) {
        try {
          const urls = [];
          if (ponerFotos) for (const f of g.fotos.slice(0, MAX_FOTOS)) urls.push(await subirFoto(cloudinary, f.archivo, d.receta_id));
          await c.query(
            `UPDATE recetas SET
               pasos = CASE WHEN $2::boolean THEN $3::jsonb ELSE pasos END,
               foto  = CASE WHEN $4::boolean THEN $5 ELSE foto END,
               fotos = CASE WHEN $4::boolean THEN $6::jsonb ELSE fotos END,
               updated_at = NOW()
             WHERE id = $1`,
            [d.receta_id, ponerPasos, JSON.stringify(textos[0]?.pasos ?? []), ponerFotos, urls[0] ?? null, JSON.stringify(urls)]);
          cuenta.cargadas += 1;
          if (ponerPasos) cuenta.conPasos += 1;
          if (ponerFotos) cuenta.conFoto += 1;
        } catch (e) {
          obs.push(`FALLÓ: ${e.message}`);
        }
      } else if (!APLICAR) {
        if (ponerPasos) cuenta.conPasos += 1;
        if (ponerFotos) cuenta.conFoto += 1;
      }
      filas.push({
        codigo: g.clave, archivo: nombreArchivo, lazarillo: d.nombre,
        estado: [ponerPasos ? `${textos[0].pasos.length} pasos` : null, ponerFotos ? `${Math.min(g.fotos.length, MAX_FOTOS)} foto(s)` : null].filter(Boolean).join(' + ') || '—',
        revisar: obs.join(' · '),
      });
    }
  } finally {
    if (!APLICAR) await c.query('ROLLBACK').catch(() => {});
    c.release();
  }

  console.table(filas.map((f) => ({ ...f, archivo: f.archivo.slice(0, 30), lazarillo: String(f.lazarillo).slice(0, 30) })));
  if (sueltos.length) console.log(`\nArchivos con nombre sin código (no se usan, cargalos a mano si hace falta): ${sueltos.join(' | ')}`);
  const verbo = APLICAR ? 'Se cargaron' : 'Se cargarían';
  console.log(`\n${grupos.length} recetas en la carpeta. ${verbo}: ${APLICAR ? cuenta.cargadas : cuenta.conPasos + cuenta.conFoto ? `${cuenta.conPasos} paso a paso y ${cuenta.conFoto} con foto` : 0}${APLICAR ? ` (${cuenta.conPasos} paso a paso, ${cuenta.conFoto} con foto)` : ''}.`);
  console.log(`No encontradas: ${cuenta.noEncontradas} · sin receta en Lazarillo: ${cuenta.sinReceta} · ya tenían todo: ${cuenta.yaTenian} · para revisar: ${cuenta.revisar}`);
  await pool.end();
}

if (require.main === module) main().catch(async (e) => { console.error('FALLA:', e.message); await pool.end().catch(() => {}); process.exit(1); });

module.exports = { pasosDesdeTexto, decodificar, similitud };
