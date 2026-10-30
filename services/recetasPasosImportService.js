// services/recetasPasosImportService.js
//
// Import masivo de paso-a-paso + foto para recetas existentes, desde un ZIP
// con pares de archivos .txt (método) + imagen (foto del plato), mismo
// nombre base. Nombre de archivo esperado: "<categoria>_<codigo>_<NOMBRE>.ext"
// (ej. "Comidas_432_TORRE CONTAINER.txt") — el <codigo> es el articulo_id
// real de MaxiRest (maxi_articles.articulo_id), NO app_articles.codigo (ese
// campo está vacío para artículos sincronizados — su identidad vive en
// maxi_articles, confirmado con muestra-articulos-reales.js).
//
// NO crea recetas nuevas — solo actualiza `pasos`/`foto` de una receta YA
// existente para ese artículo (decisión explícita: lo que no tiene receta
// previa queda listado para revisar a mano, no se crea nada solo).
//
// Siempre corre en dos pasos: análisis (dry-run, default) y aplicar
// (aplicar=true) — mismo patrón de todo el resto del proyecto este mes.
'use strict';

const AdmZip = require('adm-zip');
const pool = require('../config/db');
const cloudinary = require('../config/cloudinary');

const EXTENSIONES_IMAGEN = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function decodeTxt(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.slice(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let i = 2; i < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.slice(3).toString('utf8');
  }
  // Sin BOM: si hay muchos bytes 0x00 (texto ascii en utf16le tiene uno por
  // cada caracter), es casi seguro "Unicode" de Notepad sin BOM.
  const muestra = buffer.slice(0, Math.min(buffer.length, 2000));
  let nulos = 0;
  for (let i = 0; i < muestra.length; i++) if (muestra[i] === 0x00) nulos++;
  if (muestra.length > 0 && nulos / muestra.length > 0.25) {
    return buffer.toString('utf16le');
  }
  return buffer.toString('utf8');
}

function parsePasos(texto) {
  return texto
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s•\-*◦▪]+/, '').trim())
    .filter((l) => l.length > 0);
}

function parseNombreArchivo(nombreSinExt) {
  const partes = nombreSinExt.split('_');
  if (partes.length < 2) return null;
  const codigo = partes[1];
  if (!/^\d+$/.test(codigo)) return null;
  return {
    categoria: partes[0],
    codigo: Number(codigo),
    nombre: partes.slice(2).join('_').trim(),
  };
}

function normalizar(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function subirFotoACloudinary(buffer, businessId, codigo) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `lazarillo/recetas/${businessId}`,
        public_id: `import_${codigo}_${Date.now()}`,
        transformation: [{ width: 1200, height: 900, crop: 'limit', quality: 'auto' }],
      },
      (err, result) => (err ? reject(err) : resolve(result.secure_url))
    );
    stream.end(buffer);
  });
}

async function importarPasosDesdeZip({ businessId, zipPath, aplicar = false }) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !e.entryName.includes('__MACOSX'));

  // Agrupar por nombre base (sin extensión, sin carpeta).
  const grupos = new Map();
  for (const entry of entries) {
    const base = entry.entryName.split('/').pop();
    const puntoIdx = base.lastIndexOf('.');
    if (puntoIdx < 1) continue;
    const nombreSinExt = base.slice(0, puntoIdx);
    const ext = base.slice(puntoIdx).toLowerCase();
    if (!grupos.has(nombreSinExt)) grupos.set(nombreSinExt, { txt: null, imagen: null });
    const g = grupos.get(nombreSinExt);
    if (ext === '.txt') g.txt = entry;
    else if (EXTENSIONES_IMAGEN.has(ext)) g.imagen = entry;
  }

  // Maestro de artículos del negocio (para matchear código y, si falla, nombre).
  const { rows: articulos } = await pool.query(
    `SELECT articulo_id, nombre FROM maxi_articles WHERE business_id = $1`,
    [businessId]
  );
  const porCodigo = new Map(articulos.map((a) => [a.articulo_id, a.nombre]));
  const porNombreNorm = new Map(articulos.map((a) => [normalizar(a.nombre), a.articulo_id]));

  const reporte = { ok: [], sinReceta: [], codigoNoEncontrado: [], nombreSospechoso: [], sinTxt: [] };

  for (const [nombreSinExt, g] of grupos) {
    if (!g.txt) { reporte.sinTxt.push({ archivo: nombreSinExt }); continue; }

    const parsed = parseNombreArchivo(nombreSinExt);
    if (!parsed) {
      reporte.codigoNoEncontrado.push({ archivo: nombreSinExt, motivo: 'nombre de archivo no tiene el formato <categoria>_<codigo>_<nombre>' });
      continue;
    }

    let articuloId = porCodigo.has(parsed.codigo) ? parsed.codigo : null;
    let viaFallbackNombre = false;
    if (articuloId == null) {
      const matchPorNombre = porNombreNorm.get(normalizar(parsed.nombre));
      if (matchPorNombre != null) { articuloId = matchPorNombre; viaFallbackNombre = true; }
    }
    if (articuloId == null) {
      reporte.codigoNoEncontrado.push({ archivo: nombreSinExt, codigo: parsed.codigo, nombreArchivo: parsed.nombre });
      continue;
    }

    const { rows: recetaRows } = await pool.query(
      `SELECT id, nombre, pasos, foto FROM recetas
        WHERE business_id = $1 AND article_id = $2 AND active = TRUE LIMIT 1`,
      [businessId, articuloId]
    );
    if (!recetaRows.length) {
      reporte.sinReceta.push({ archivo: nombreSinExt, articuloId, nombreMaxi: porCodigo.get(articuloId) });
      continue;
    }
    const receta = recetaRows[0];

    const nombreMaxi = porCodigo.get(articuloId) || '';
    const sospechoso = !viaFallbackNombre
      && normalizar(parsed.nombre) !== normalizar(nombreMaxi)
      && !normalizar(nombreMaxi).includes(normalizar(parsed.nombre))
      && !normalizar(parsed.nombre).includes(normalizar(nombreMaxi));

    const texto = decodeTxt(g.txt.getData());
    const pasos = parsePasos(texto);

    const item = {
      archivo: nombreSinExt,
      recetaId: receta.id,
      articuloId,
      nombreReceta: receta.nombre,
      nombreArchivo: parsed.nombre,
      pasosDetectados: pasos.length,
      tieneImagen: !!g.imagen,
      viaFallbackNombre,
    };
    if (sospechoso) reporte.nombreSospechoso.push(item);
    else reporte.ok.push(item);

    if (aplicar) {
      let fotoUrl = receta.foto;
      if (g.imagen) {
        try {
          fotoUrl = await subirFotoACloudinary(g.imagen.getData(), businessId, parsed.codigo);
        } catch (e) {
          item.errorFoto = e.message;
        }
      }
      await pool.query(
        `UPDATE recetas SET pasos = $1::jsonb, foto = $2, updated_at = NOW() WHERE id = $3`,
        [JSON.stringify(pasos), fotoUrl, receta.id]
      );
    }
  }

  return {
    ok: true,
    aplicar,
    totalArchivos: grupos.size,
    resumen: {
      ok: reporte.ok.length,
      nombreSospechoso: reporte.nombreSospechoso.length,
      sinReceta: reporte.sinReceta.length,
      codigoNoEncontrado: reporte.codigoNoEncontrado.length,
      sinTxt: reporte.sinTxt.length,
    },
    detalle: reporte,
  };
}

module.exports = { importarPasosDesdeZip };
