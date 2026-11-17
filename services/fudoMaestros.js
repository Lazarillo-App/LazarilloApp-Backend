// services/fudoMaestros.js
//
// Fudo → artículos, insumos, recetas y compras de Lazarillo (usuaria 17/11/2026). Las ventas van por
// services/fudoService.js. Regla de la usuaria: las ventas siempre vienen del POS; artículos,
// insumos y compras se cargan en Lazarillo, pero si el cliente sigue usando Fudo para eso, Lazarillo
// lo trae igual (lo nuevo y los cambios). Mejor tenerlo y descartar que no tenerlo. El cliente elige
// qué traer (integraciones_fudo.traer). Solo lectura: nada vuelve a Fudo.
//
// Mismas reglas que los maestros de MaxiRest (services/kit/maestrosDesdeKit.js), verificado con la
// cuenta demo el 17/11:
//  - Artículos: un producto de Fudo ya vinculado se actualiza solo si el artículo vino de Fudo
//    (origen 'fudo') y el campo no se editó en Lazarillo (valor = espejo *_maxi), y nunca si tiene
//    precio manual. Sin vínculo: se vincula solo con un artículo de nombre (o código) igual; si no
//    hay, se crea con el número de producto de Fudo como código (como el código de cualquier POS).
//  - Insumos: igual, con fudo_insumos.aplicado como espejo. Rubro por nombre (se crea si falta).
//    El costo de Fudo solo se usa como precio inicial: después manda la última compra.
//  - Recetas (proportions de Fudo: ingrediente + cantidad): se crean si el artículo no tiene receta;
//    una receta que vino de Fudo se actualiza mientras nadie la haya tocado en Lazarillo.
//  - Compras (gastos de Fudo): van a purchases con source 'fudo' por la misma función que MaxiRest y
//    el Panel (costeo, precios sospechosos, cascada a recetas). Los renglones con ingrediente actualizan
//    el insumo; un gasto sin mercadería (alquiler, luz) entra sin insumo, como los gastos de MaxiRest.
//    Si la compra ya está cargada en Lazarillo (mismo proveedor —CUIT o nombre— y fecha) se saltea.
'use strict';

const pool = require('../config/db');
const { canonicalUnit } = require('./unidades');

const PROVEEDOR_BASE = 8000000000; // suppliers.id de Fudo: fuera de MaxiRest (código) y del Panel (9e9)
const DIAS_COMPRAS = 90;
const DIAS_REPASO_COMPRAS = 30; // los gastos se suelen cargar tarde (factura de hace semanas); compras_externas evita repetir

const txt = (v) => (v == null ? '' : String(v).trim());
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const normalizar = (s) => txt(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const soloDigitos = (s) => txt(s).replace(/\D/g, '');

// ───────────────────────── JSON:API ─────────────────────────

/** Índice de los `included` de varias páginas y búsqueda por referencia {type, id}. */
function indice(paginas) {
  const m = new Map();
  for (const p of paginas) for (const x of p?.included || []) m.set(`${x.type}:${x.id}`, x);
  return (ref) => (ref ? m.get(`${ref.type}:${ref.id}`) || null : null);
}
const datos = (paginas) => paginas.flatMap((p) => p?.data || []);
const rel = (x, k) => x?.relationships?.[k]?.data ?? null;

// ───────────────────────── funciones puras (testeadas) ─────────────────────────

/** Categorías de producto de Fudo → {id: {rubro, subrubro}}: con categoría padre, padre = rubro. */
function rubrosDeCategorias(categorias) {
  const porId = new Map(categorias.map((c) => [String(c.id), c]));
  const out = new Map();
  for (const c of categorias) {
    const nombre = txt(c.attributes?.name) || null;
    const padreId = rel(c, 'parentCategory')?.id;
    const padre = padreId ? porId.get(String(padreId)) : null;
    out.set(String(c.id), padre
      ? { rubro: txt(padre.attributes?.name) || nombre, subrubro: nombre }
      : { rubro: nombre, subrubro: null });
  }
  return out;
}

/** Producto de Fudo → artículo con la forma de maxi_articles. */
function articuloDeProducto(p, rubros) {
  const id = Number(p.id);
  const nombre = txt(p.attributes?.name).slice(0, 200);
  if (!Number.isInteger(id) || id <= 0 || !nombre) return null;
  const cat = rubros.get(String(rel(p, 'productCategory')?.id)) || {};
  return {
    fudo_id: String(p.id),
    articulo_id: id,
    nombre,
    categoria: cat.rubro || 'Sin categoría',
    subrubro: cat.subrubro || 'Sin subrubro',
    precio: num(p.attributes?.price),
    activo: p.attributes?.active !== false,
    codigo: txt(p.attributes?.code) || null,
  };
}

/** Ingrediente de Fudo → insumo. */
function insumoDeIngrediente(i, buscar) {
  const nombre = txt(i.attributes?.name);
  if (!nombre) return null;
  const unidad = txt(buscar(rel(i, 'unit'))?.attributes?.name);
  return {
    fudo_id: String(i.id),
    nombre,
    categoria: txt(buscar(rel(i, 'ingredientCategory'))?.attributes?.name) || null,
    unidad: unidad ? canonicalUnit(unidad) || unidad : null,
    costo: num(i.attributes?.cost) > 0 ? num(i.attributes.cost) : null,
  };
}

/** Receta de un producto (proportions) → [{fudo_ingrediente, cantidad, unidad, nombre}] + hash estable. */
function recetaDeProducto(p, buscar) {
  const items = [];
  for (const ref of p.relationships?.proportions?.data || []) {
    const pr = buscar(ref);
    const ing = buscar(rel(pr, 'ingredient'));
    const cantidad = num(pr?.attributes?.amount);
    if (!ing || cantidad <= 0) continue;
    const unidad = txt(buscar(rel(ing, 'unit'))?.attributes?.name);
    items.push({ fudo_ingrediente: String(ing.id), nombre: txt(ing.attributes?.name), cantidad, unidad: unidad ? canonicalUnit(unidad) || unidad : 'u' });
  }
  const hash = items.map((i) => `${i.fudo_ingrediente}:${i.cantidad}:${i.unidad}`).sort().join('|');
  return { items, hash };
}

/**
 * Gasto de Fudo → factura con la forma que espera purchasesStore.upsertPurchasesEnCliente.
 * Renglones de mercadería: price es el total de la línea (verificado: 25 kg × $3000 = 75000). Lo que
 * el gasto tenga de más (impuestos, percepciones) va en un renglón sin insumo para que el total cuadre.
 */
function facturaDeGasto(g, buscar) {
  const a = g.attributes || {};
  if (a.canceled) return null;
  const fecha = txt(a.date).slice(0, 10);
  const total = num(a.amount);
  if (!fecha || !(total > 0)) return null;
  const prov = buscar(rel(g, 'provider'));
  const doc = buscar(rel(g, 'commercialDocument'));
  const categoria = txt(buscar(rel(g, 'expenseCategory'))?.attributes?.name) || null;
  const items = [];
  for (const ref of g.relationships?.expenseItems?.data || []) {
    const it = buscar(ref);
    const ia = it?.attributes || {};
    if (!it || ia.canceled) continue;
    const cantidad = num(ia.quantity) || 1;
    const preciotot = num(ia.price);
    const ing = rel(it, 'ingredient');
    items.push({
      insumo: ing ? Number(ing.id) : null,
      fecha, cantidad, neto: preciotot / cantidad, precio: preciotot / cantidad, preciotot,
      referencia: txt(ia.detail) || categoria || '',
    });
  }
  const suma = items.reduce((s, i) => s + i.preciotot, 0);
  if (total - suma > 0.5) {
    items.push({ insumo: null, fecha, cantidad: 1, neto: total - suma, precio: total - suma, preciotot: total - suma,
      referencia: items.length ? 'Impuestos y otros' : (txt(a.description) || categoria || 'Gasto') });
  }
  const proveedorFudo = prov ? Number(prov.id) : null;
  return {
    numero: `FUDO-${g.id}`,
    proveedor: proveedorFudo ? PROVEEDOR_BASE + proveedorFudo : null,
    proveedorNombre: txt(prov?.attributes?.name) || null,
    cuit: soloDigitos(doc?.attributes?.seller?.taxIdNumber) || null,
    comprobante: txt(a.receiptNumber) && txt(a.receiptNumber) !== '0' ? txt(a.receiptNumber) : null,
    fecha, total, categoria,
    items,
  };
}

/** ¿Ya está en Lazarillo? cargadas: [{fecha, cuit, nombre}] de compras que no vinieron de Fudo. */
function yaCargada(f, cargadas) {
  const nombre = normalizar(f.proveedorNombre);
  return cargadas.some((c) => c.fecha === f.fecha && (
    (f.cuit && c.cuit && soloDigitos(c.cuit) === f.cuit) || (nombre && normalizar(c.nombre) === nombre)));
}

// ───────────────────────── rubros de insumo ─────────────────────────

async function codigoDeRubro(client, businessId, nombre, cache) {
  if (!nombre) return null;
  const k = normalizar(nombre);
  if (cache.has(k)) return cache.get(k);
  const { rows } = await client.query('SELECT codigo, nombre FROM insumo_rubros WHERE business_id = $1', [businessId]);
  const hay = rows.find((r) => normalizar(r.nombre) === k);
  let codigo = hay ? Number(hay.codigo) : null;
  if (codigo == null) {
    codigo = rows.reduce((m, r) => Math.max(m, Number(r.codigo) || 0), 0) + 1;
    await client.query(
      `INSERT INTO insumo_rubros (business_id, codigo, codigo_maxi, nombre, activo) VALUES ($1, $2, $4, $3, true)
       ON CONFLICT (business_id, codigo) DO NOTHING`, [businessId, codigo, nombre, codigo]);
  }
  cache.set(k, codigo);
  return codigo;
}

// ───────────────────────── aplicar ─────────────────────────

async function aplicarArticulos(bid, productos, rubros) {
  const arts = productos.map((p) => articuloDeProducto(p, rubros)).filter(Boolean);
  if (!arts.length) return { nuevos: 0, vinculados: 0, actualizados: 0 };
  const { rows: existentes } = await pool.query('SELECT articulo_id, nombre, origen FROM maxi_articles WHERE business_id = $1', [bid]);
  const { rows: vinc } = await pool.query('SELECT fudo_id, articulo_id FROM fudo_productos WHERE business_id = $1', [bid]);
  const vinculo = new Map(vinc.map((v) => [v.fudo_id, v.articulo_id == null ? null : Number(v.articulo_id)]));
  const ids = new Set(existentes.map((e) => Number(e.articulo_id)));
  const porNombre = new Map();
  for (const e of existentes) {
    const k = normalizar(e.nombre);
    if (k) porNombre.set(k, porNombre.has(k) ? null : Number(e.articulo_id));
  }
  const tomados = new Set(vinc.filter((v) => v.articulo_id != null).map((v) => Number(v.articulo_id)));

  const nuevos = [];
  const vincular = [];
  const actualizar = [];
  for (const a of arts) {
    const ya = vinculo.get(a.fudo_id);
    if (ya != null) { actualizar.push({ ...a, articulo_id: ya }); continue; }
    const cod = Number(a.codigo);
    const igual = (Number.isInteger(cod) && cod > 0 && ids.has(cod) && !tomados.has(cod)) ? cod
      : (porNombre.get(normalizar(a.nombre)) ?? null);
    if (igual != null && !tomados.has(igual)) { vincular.push({ fudo_id: a.fudo_id, articulo_id: igual }); tomados.add(igual); continue; }
    if (!a.activo) continue;
    if (ids.has(a.articulo_id)) continue; // el número ya lo usa otro artículo: queda para vincular a mano
    nuevos.push(a);
    ids.add(a.articulo_id);
    vincular.push({ fudo_id: a.fudo_id, articulo_id: a.articulo_id });
  }

  const client = await pool.connect();
  let actualizados = 0;
  try {
    await client.query('BEGIN');
    const lote = [...nuevos, ...actualizar];
    if (lote.length) {
      const r = await client.query(
        `WITH d AS (
           SELECT * FROM UNNEST($2::bigint[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::jsonb[])
             AS t(articulo_id, nombre, categoria, subrubro, precio, raw)
         )
         INSERT INTO maxi_articles (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw, origen,
                                    nombre_maxi, categoria_maxi, subrubro_maxi, precio_maxi, updated_at)
         SELECT $1, articulo_id, nombre, categoria, subrubro, precio, 0, raw, 'fudo', nombre, categoria, subrubro, precio, NOW() FROM d
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           precio = CASE WHEN maxi_articles.precio IS DISTINCT FROM maxi_articles.precio_maxi THEN maxi_articles.precio ELSE EXCLUDED.precio END,
           nombre = CASE WHEN maxi_articles.nombre IS DISTINCT FROM maxi_articles.nombre_maxi THEN maxi_articles.nombre ELSE EXCLUDED.nombre END,
           categoria = CASE WHEN maxi_articles.categoria IS DISTINCT FROM maxi_articles.categoria_maxi THEN maxi_articles.categoria ELSE EXCLUDED.categoria END,
           subrubro = CASE WHEN maxi_articles.subrubro IS DISTINCT FROM maxi_articles.subrubro_maxi THEN maxi_articles.subrubro ELSE EXCLUDED.subrubro END,
           precio_maxi = EXCLUDED.precio, nombre_maxi = EXCLUDED.nombre,
           categoria_maxi = EXCLUDED.categoria, subrubro_maxi = EXCLUDED.subrubro, updated_at = NOW()
         WHERE maxi_articles.origen = 'fudo'
           AND (maxi_articles.nombre_maxi, maxi_articles.precio_maxi, maxi_articles.categoria_maxi, maxi_articles.subrubro_maxi)
               IS DISTINCT FROM (EXCLUDED.nombre, EXCLUDED.precio, EXCLUDED.categoria, EXCLUDED.subrubro)
           AND NOT EXISTS (SELECT 1 FROM article_price_config apc
                            WHERE apc.business_id = maxi_articles.business_id AND apc.scope = 'articulo'
                              AND apc.scope_id = maxi_articles.articulo_id::text AND apc.precio_manual IS NOT NULL)
         RETURNING (xmax = 0) AS nuevo`,
        [bid, lote.map((a) => a.articulo_id), lote.map((a) => a.nombre), lote.map((a) => a.categoria), lote.map((a) => a.subrubro),
          lote.map((a) => a.precio), lote.map((a) => JSON.stringify({ fudo_id: a.fudo_id, codigo: a.codigo, _source: 'fudo' }))]
      );
      actualizados = r.rows.filter((x) => !x.nuevo).length;
    }
    if (nuevos.length) {
      await client.query(
        `INSERT INTO maxi_article_map (business_id, articulo_id, categoria, subrubro, updated_at)
         SELECT $1, t.id, t.cat, t.sub, now() FROM UNNEST($2::int[], $3::text[], $4::text[]) AS t(id, cat, sub)
         ON CONFLICT (business_id, articulo_id) DO NOTHING`,
        [bid, nuevos.map((a) => a.articulo_id), nuevos.map((a) => a.categoria), nuevos.map((a) => a.subrubro)]);
    }
    if (vincular.length) {
      await client.query(
        `UPDATE fudo_productos p SET articulo_id = t.articulo_id, vinculado_at = now()
           FROM UNNEST($2::text[], $3::int[]) AS t(fudo_id, articulo_id)
          WHERE p.business_id = $1 AND p.fudo_id = t.fudo_id AND p.articulo_id IS NULL`,
        [bid, vincular.map((v) => v.fudo_id), vincular.map((v) => v.articulo_id)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  if (nuevos.length) {
    // Lo mismo que hacen MaxiRest y el kit después de crear artículos. Ninguno corta la pasada.
    const { applyArticuloGroupRules, autoAssignNewArticles } = require('./autoGroupAssignment');
    for (const [n, fn] of [['reglas de rubro', applyArticuloGroupRules], ['auto-asignar', autoAssignNewArticles]]) {
      try { await fn(bid); } catch (e) { console.warn(`[fudo-maestros] ${bid} ${n}:`, e.message); }
    }
  }
  return { nuevos: nuevos.length, vinculados: vincular.length - nuevos.length, actualizados, vinculadosIds: vincular.map((v) => v.fudo_id) };
}

async function aplicarInsumos(bid, ingredientes) {
  if (!ingredientes.length) return { nuevos: 0, vinculados: 0, actualizados: 0 };
  const client = await pool.connect();
  let nuevos = 0, vinculados = 0, actualizados = 0;
  const rubros = new Map();
  try {
    await client.query('BEGIN');
    const { rows: existentes } = await client.query(
      `SELECT id, nombre, codigo_maxi, unidad_med, rubro, precio_ref FROM insumos WHERE business_id = $1 AND estado = 'activo'`, [bid]);
    const { rows: mapa } = await client.query('SELECT fudo_id, insumo_id, aplicado FROM fudo_insumos WHERE business_id = $1', [bid]);
    const porFudo = new Map(mapa.map((m) => [m.fudo_id, m]));
    const porId = new Map(existentes.map((e) => [Number(e.id), e]));
    const porNombre = new Map();
    for (const e of existentes) {
      const k = normalizar(e.nombre);
      if (k) porNombre.set(k, porNombre.has(k) ? null : Number(e.id));
    }
    // Códigos ya usados por CUALQUIER insumo (también los dados de baja): (business_id, codigo_maxi) es único.
    const { rows: usados } = await client.query('SELECT codigo_maxi FROM insumos WHERE business_id = $1 AND codigo_maxi IS NOT NULL', [bid]);
    const codigos = new Set(usados.map((e) => txt(e.codigo_maxi)).filter(Boolean));
    const tomados = new Set(mapa.filter((m) => m.insumo_id != null).map((m) => Number(m.insumo_id)));

    for (const ing of ingredientes) {
      const rubro = ing.categoria ? String(await codigoDeRubro(client, bid, ing.categoria, rubros)) : null;
      const quiere = { nombre: ing.nombre, unidad_med: ing.unidad, rubro };
      const m = porFudo.get(ing.fudo_id);
      let insumoId = m?.insumo_id != null ? Number(m.insumo_id) : null;
      let aplicado = m?.aplicado || {};

      if (insumoId != null && porId.has(insumoId)) {
        // Cambios desde Fudo, campo por campo, solo donde el insumo sigue como lo dejó Lazarillo.
        const actual = porId.get(insumoId);
        const sets = [];
        const vals = [];
        for (const [campo, valor] of Object.entries(quiere)) {
          if (valor == null || txt(actual[campo]) === txt(valor)) continue;
          if (aplicado[campo] !== undefined && txt(actual[campo]) !== txt(aplicado[campo])) continue; // editado en Lazarillo
          vals.push(valor);
          sets.push(`${campo} = $${vals.length + 2}`);
        }
        if (sets.length) {
          await client.query(`UPDATE insumos SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND business_id = $2`, [insumoId, bid, ...vals]);
          actualizados++;
        }
        aplicado = quiere;
      } else {
        const igual = porNombre.get(normalizar(ing.nombre));
        if (igual != null && !tomados.has(igual)) {
          // Ya existía en Lazarillo: lo de Lazarillo gana. Se anota lo que Fudo dice hoy, así solo pasan
          // los cambios que se hagan en Fudo de acá en adelante (y nunca sobre un campo distinto).
          insumoId = igual;
          vinculados++;
          aplicado = quiere;
        } else {
          const codigo = codigos.has(ing.fudo_id) ? null : ing.fudo_id; // «código en tu punto de venta»
          const { rows } = await client.query(
            `INSERT INTO insumos (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, estado, sin_equivalencia)
             VALUES ($1, $2, $3, $4, $5, $6, 'fudo', 'activo', $7) RETURNING id`,
            [bid, codigo, ing.nombre, ing.unidad, ing.costo, rubro, codigo == null]);
          insumoId = Number(rows[0].id);
          if (codigo) codigos.add(codigo);
          nuevos++;
          aplicado = quiere;
        }
        tomados.add(insumoId);
      }
      await client.query(
        `INSERT INTO fudo_insumos (business_id, fudo_id, nombre, categoria, unidad, costo, insumo_id, aplicado, visto_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (business_id, fudo_id) DO UPDATE SET nombre = EXCLUDED.nombre, categoria = EXCLUDED.categoria,
           unidad = EXCLUDED.unidad, costo = EXCLUDED.costo, insumo_id = EXCLUDED.insumo_id, aplicado = EXCLUDED.aplicado, visto_at = now()`,
        [bid, ing.fudo_id, ing.nombre, ing.categoria, ing.unidad, ing.costo, insumoId, JSON.stringify(aplicado)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (nuevos) {
    try { await require('./autoAssignNewInsumos').autoAssignNewInsumos(bid); } catch (e) { console.warn(`[fudo-maestros] ${bid} auto-asignar insumos:`, e.message); }
  }
  return { nuevos, vinculados, actualizados };
}

async function aplicarRecetas(bid, recetasPorProducto) {
  if (!recetasPorProducto.length) return { nuevas: 0, actualizadas: 0, respetadas: 0 };
  const { rows: prods } = await pool.query('SELECT fudo_id, articulo_id, receta_hash FROM fudo_productos WHERE business_id = $1 AND articulo_id IS NOT NULL', [bid]);
  const prod = new Map(prods.map((p) => [p.fudo_id, p]));
  const { rows: ins } = await pool.query('SELECT fudo_id, insumo_id FROM fudo_insumos WHERE business_id = $1 AND insumo_id IS NOT NULL', [bid]);
  const insumoDe = new Map(ins.map((i) => [i.fudo_id, Number(i.insumo_id)]));
  const { propagarCostoInsumo } = require('./costoRecetaService');

  let nuevas = 0, actualizadas = 0, respetadas = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tocados = new Set();
    for (const { fudo_id, items, hash } of recetasPorProducto) {
      const p = prod.get(fudo_id);
      if (!p || !items.length) continue;
      const articleId = Number(p.articulo_id);
      const { rows: r } = await client.query('SELECT id, origen FROM recetas WHERE business_id = $1 AND article_id = $2', [bid, articleId]);
      let recetaId = r[0]?.id ?? null;
      if (recetaId != null) {
        if (r[0].origen !== 'fudo' || p.receta_hash !== await hashActual(client, recetaId)) { respetadas++; continue; } // la tocaron en Lazarillo
        if (p.receta_hash === hash) continue; // sin cambios en Fudo
        await client.query('DELETE FROM receta_items WHERE receta_id = $1', [recetaId]);
        actualizadas++;
      } else {
        const { rows } = await client.query(
          `INSERT INTO recetas (article_id, business_id, nombre, descripcion, porciones, porcentaje_venta, costo_total, active, origen, created_at, updated_at)
           SELECT $1, $2, nombre, '', 1, 0, 0, TRUE, 'fudo', NOW(), NOW() FROM maxi_articles WHERE business_id = $3 AND articulo_id = $4
           ON CONFLICT (article_id, business_id) DO NOTHING RETURNING id`, [articleId, bid, bid, articleId]);
        if (!rows[0]) continue;
        recetaId = rows[0].id;
        nuevas++;
      }
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const insumoId = insumoDe.get(it.fudo_ingrediente) ?? null;
        await client.query(
          `INSERT INTO receta_items (receta_id, insumo_id, codigo_maxi_insumo, nombre_insumo_maxi, cantidad, unidad, costo_unitario, orden, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, $7, NOW(), NOW())`,
          [recetaId, insumoId, it.fudo_ingrediente, it.nombre, it.cantidad, it.unidad, i]);
        if (insumoId) tocados.add(insumoId);
      }
      await client.query('UPDATE fudo_productos SET receta_hash = $3 WHERE business_id = $1 AND fudo_id = $2', [bid, fudo_id, await hashActual(client, recetaId)]);
    }
    // Costo de cada renglón desde el precio del insumo, y recálculo de las recetas que lo usan.
    for (const id of tocados) await propagarCostoInsumo(id, bid, client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { nuevas, actualizadas, respetadas };
}

/** Huella de los renglones de una receta tal como están en Lazarillo (para saber si alguien la tocó). */
async function hashActual(client, recetaId) {
  const { rows } = await client.query(
    `SELECT COALESCE(codigo_maxi_insumo, 'i' || insumo_id::text) AS k, cantidad::float8 AS c, unidad AS u FROM receta_items WHERE receta_id = $1`, [recetaId]);
  return rows.map((r) => `${r.k}:${r.c}:${r.u}`).sort().join('|');
}

/**
 * Gastos de Fudo → facturas de Lazarillo por el camino común de compras de cualquier sistema
 * (services/comprasExternas.js): entran al Panel editables, con concepto de caja y con sus costos.
 * Antes (17/11, primeras horas) se escribían directo en purchases con source 'fudo': esas filas se
 * quitan, porque ahora los costos salen de la factura del Panel (si no, quedarían dos veces).
 */
async function aplicarCompras(bid, branchId, facturas) {
  const { rows: ins } = await pool.query('SELECT fudo_id, insumo_id FROM fudo_insumos WHERE business_id = $1 AND insumo_id IS NOT NULL', [bid]);
  const insumoDe = new Map(ins.map((i) => [String(i.fudo_id), Number(i.insumo_id)]));
  const compras = facturas.map((f) => ({
    externoId: f.numero.replace(/^FUDO-/, ''),
    fecha: f.fecha,
    total: f.total,
    categoria: f.categoria,
    comprobante: f.comprobante,
    proveedor: { nombre: f.proveedorNombre, cuit: f.cuit },
    renglones: f.items.map((it) => ({
      insumoId: it.insumo != null ? insumoDe.get(String(it.insumo)) ?? null : null,
      nombre: it.referencia, cantidad: it.cantidad, neto: it.preciotot,
    })),
  }));
  const { rows: viejas } = await pool.query("SELECT id FROM purchases WHERE business_id = $1 AND source = 'fudo'", [bid]);
  if (viejas.length) {
    await pool.query("DELETE FROM purchases WHERE business_id = $1 AND source = 'fudo'", [bid]);
    const { rows: tocados } = await pool.query(
      'SELECT DISTINCT insumo_id FROM fudo_insumos WHERE business_id = $1 AND insumo_id IS NOT NULL', [bid]);
    const { actualizarPreciosDeInsumos } = require('./purchasesStore');
    const client = await pool.connect();
    try {
      await actualizarPreciosDeInsumos(client, { businessId: bid, insumoIds: tocados.map((t) => Number(t.insumo_id)) });
    } finally { client.release(); }
  }
  const r = await require('./comprasExternas').importarCompras({ businessId: bid, branchId, origen: 'fudo', compras });
  return { traidas: compras.length, nuevas: r.nuevas, salteadas: r.repetidas, errores: r.errores, sinConcepto: r.sinConcepto };
}

// ───────────────────────── entrada ─────────────────────────

const sumarDias = (dia, n) => new Date(new Date(`${dia}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Trae lo elegido en `traer` para un negocio conectado. api = cliente de fudoService (solo GET).
 * Orden: insumos antes que recetas y compras (las dos los usan); artículos antes que recetas.
 */
async function sincronizarMaestros(con, api, { hoy }) {
  const bid = con.business_id;
  const traer = con.traer || {};
  const out = {};
  let productos = null;
  let buscarProd = null;

  if (traer.insumos) {
    const pags = await api.todas('/ingredients?include=ingredientCategory,unit');
    const buscar = indice(pags);
    out.insumos = await aplicarInsumos(bid, datos(pags).map((i) => insumoDeIngrediente(i, buscar)).filter(Boolean));
  }
  if (traer.articulos || traer.insumos) {
    const pags = await api.todas('/products?include=proportions,proportions.ingredient,proportions.ingredient.unit&fields[proportion]=amount,ingredient,product');
    productos = datos(pags);
    buscarProd = indice(pags);
  }
  if (traer.articulos) {
    const cats = datos(await api.todas('/product-categories'));
    out.articulos = await aplicarArticulos(bid, productos, rubrosDeCategorias(cats));
  }
  if (traer.insumos && productos) {
    out.recetas = await aplicarRecetas(bid, productos.map((p) => ({ fudo_id: String(p.id), ...recetaDeProducto(p, buscarProd) })));
  }
  if (traer.compras) {
    const hasta = hoy;
    const guardado = require('./fudoService')._diaDe(con.compras_hasta);
    const desde = guardado ? sumarDias(guardado, -DIAS_REPASO_COMPRAS) : sumarDias(hoy, -DIAS_COMPRAS);
    const pags = await api.todas(`/expenses?filter[date]=${encodeURIComponent(`and(gte.${desde},lte.${hasta})`)}`
      + '&include=expenseItems,expenseItems.ingredient,provider,expenseCategory,commercialDocument'
      + '&fields[expense]=amount,canceled,commercialDocument,date,description,expenseCategory,expenseItems,provider,receiptNumber,status'
      + '&fields[expenseItem]=canceled,detail,price,ingredient,quantity&fields[expenseCategory]=name&fields[provider]=name');
    const buscar = indice(pags);
    const facturas = datos(pags).map((g) => facturaDeGasto(g, buscar)).filter(Boolean);
    out.compras = await aplicarCompras(bid, con.branch_id ?? null, facturas);
    await pool.query('UPDATE integraciones_fudo SET compras_hasta = $2 WHERE business_id = $1', [bid, hasta]);
  }
  return out;
}

module.exports = {
  sincronizarMaestros,
  // para tests
  _rubrosDeCategorias: rubrosDeCategorias, _articuloDeProducto: articuloDeProducto, _insumoDeIngrediente: insumoDeIngrediente,
  _recetaDeProducto: recetaDeProducto, _facturaDeGasto: facturaDeGasto, _yaCargada: yaCargada, _indice: indice,
  PROVEEDOR_BASE,
};
