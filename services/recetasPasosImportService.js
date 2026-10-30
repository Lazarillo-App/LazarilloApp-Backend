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
  // Agrupar por CÓDIGO, no por nombre de archivo completo — la categoría
  // (primera palabra) puede venir distinta entre el .txt y la imagen del
  // mismo plato (ej. imagen "Bebidas_174_Baileys Frozen.jpg" vs texto
  // "Coctelería_174_Baileys Frozen.txt", mismo código 174, visto en la
  // primera prueba real) — si agrupáramos por nombre completo, ninguno de
  // los dos lados encontraría pareja.
  const sinParsear = [];
  for (const entry of entries) {
    const base = entry.entryName.split('/').pop();
    const puntoIdx = base.lastIndexOf('.');
    if (puntoIdx < 1) continue;
    const nombreSinExt = base.slice(0, puntoIdx);
    const ext = base.slice(puntoIdx).toLowerCase();
    const parsed = parseNombreArchivo(nombreSinExt);
    if (!parsed) { sinParsear.push(nombreSinExt); continue; }

    if (!grupos.has(parsed.codigo)) grupos.set(parsed.codigo, { txt: null, imagen: null, nombreTxt: null, nombreImagen: null, archivos: [] });
    const g = grupos.get(parsed.codigo);
    g.archivos.push(nombreSinExt);
    if (ext === '.txt') { g.txt = entry; g.nombreTxt = parsed.nombre; }
    else if (EXTENSIONES_IMAGEN.has(ext)) { g.imagen = entry; g.nombreImagen = parsed.nombre; }
  }

  // Maestro de artículos del negocio (para matchear código y, si falla, nombre).
  const { rows: articulos } = await pool.query(
    `SELECT articulo_id, nombre FROM maxi_articles WHERE business_id = $1`,
    [businessId]
  );
  const porCodigo = new Map(articulos.map((a) => [a.articulo_id, a.nombre]));
  const porNombreNorm = new Map(articulos.map((a) => [normalizar(a.nombre), a.articulo_id]));

  const reporte = { ok: [], sinReceta: [], codigoNoEncontrado: [], nombreSospechoso: [], sinTxt: [] };

  for (const archivo of sinParsear) {
    reporte.codigoNoEncontrado.push({ archivo, motivo: 'nombre de archivo no tiene el formato <categoria>_<codigo>_<nombre>' });
  }

  for (const [codigo, g] of grupos) {
    const archivo = g.archivos.join(' + ');
    if (!g.txt) { reporte.sinTxt.push({ archivo }); continue; }

    const nombreArchivo = g.nombreTxt; // el texto del .txt manda sobre el método, no la foto

    let articuloId = porCodigo.has(codigo) ? codigo : null;
    let viaFallbackNombre = false;
    if (articuloId == null) {
      const matchPorNombre = porNombreNorm.get(normalizar(nombreArchivo));
      if (matchPorNombre != null) { articuloId = matchPorNombre; viaFallbackNombre = true; }
    }
    if (articuloId == null) {
      reporte.codigoNoEncontrado.push({ archivo, codigo, nombreArchivo });
      continue;
    }

    const { rows: recetaRows } = await pool.query(
      `SELECT id, nombre, pasos, foto FROM recetas
        WHERE business_id = $1 AND article_id = $2 AND active = TRUE LIMIT 1`,
      [businessId, articuloId]
    );
    if (!recetaRows.length) {
      reporte.sinReceta.push({ archivo, articuloId, nombreMaxi: porCodigo.get(articuloId) });
      continue;
    }
    const receta = recetaRows[0];

    const nombreMaxi = porCodigo.get(articuloId) || '';
    const sospechoso = !viaFallbackNombre
      && normalizar(nombreArchivo) !== normalizar(nombreMaxi)
      && !normalizar(nombreMaxi).includes(normalizar(nombreArchivo))
      && !normalizar(nombreArchivo).includes(normalizar(nombreMaxi));

    const texto = decodeTxt(g.txt.getData());
    const pasos = parsePasos(texto);

    const item = {
      archivo,
      recetaId: receta.id,
      articuloId,
      nombreReceta: receta.nombre,
      nombreArchivo,
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
          fotoUrl = await subirFotoACloudinary(g.imagen.getData(), businessId, codigo);
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
