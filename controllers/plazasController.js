// controllers/plazasController.js
//
// Plazas de despacho (Diego 11/11/2026): subsectores de Cocina/Barra (Ensaladas, Freidora…) con sus
// productos. La vista de la plaza muestra cada producto con su receta TAL CUAL, en el orden que se
// arma (drag and drop), sin los ingredientes ocultos (ojito) y con renglones extra (notas, vajilla).
// El color es por insumo y vale en todas las plazas del negocio.
//   Ver: dueño/admin todas; Staff las de sus sectores.
//   Armar la ficha (orden, ojito, extras, colores): dueño/admin y el jefe del sector.
//   Crear/editar/borrar plazas y sus productos: dueño/admin.
'use strict';

const pool = require('../config/db');
const { sectoresQueConduce } = require('../services/jefeCocina');

const PALETA_N = 13; // colores de la paleta del front (VistaPlaza.PALETA)
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const esGestor = (req) => req.businessRole === 'owner' || req.businessRole === 'admin';

async function sectoresDelStaff(uid, bizId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(sector_ids, '{}'::int[]) AS s FROM user_assignments
      WHERE user_id = $1 AND scope_type = 'business' AND scope_id = $2 AND role = 'staff' AND revoked_at IS NULL LIMIT 1`,
    [uid, bizId]);
  return (rows[0]?.s || []).map(Number);
}

async function cargarPlaza(id, bizId) {
  const { rows } = await pool.query(
    `SELECT p.*, s.nombre AS sector_nombre FROM plazas p LEFT JOIN sectores s ON s.id = p.sector_id
      WHERE p.id = $1 AND p.business_id = $2 AND p.deleted_at IS NULL`, [id, bizId]);
  return rows[0] || null;
}
async function puedeVer(req, plaza) {
  if (esGestor(req)) return true;
  if (req.businessRole !== 'staff') return false;
  return (await sectoresDelStaff(req.user?.id, plaza.business_id)).includes(Number(plaza.sector_id));
}
async function puedeArmar(req, plaza) {
  if (esGestor(req)) return true;
  if (req.businessRole !== 'staff') return false;
  return (await sectoresQueConduce(req.user?.id, plaza.business_id)).includes(Number(plaza.sector_id));
}

// Color sugerido: por el nombre cuando se reconoce (verdes en verde, salsas en amarillo…); si no,
// estable por ingrediente (mismo insumo = mismo color en todas las tarjetas). Índices de VistaPlaza.PALETA.
const COLOR_POR_PALABRA = [
  [/verde|lechuga|r[uú]cula|espinaca|albahaca|pesto|perejil|ciboulette/i, 5],
  [/salsa|dip|mostaza|mayonesa|cheddar|aderezo/i, 2],
  [/tomate|frutilla|frutos rojos|ketchup|morr[oó]n/i, 0],
  [/queso|provoleta|parmesano|danbo|muzzarella|mozzarella|sardo/i, 10],
  [/pan\b|pan de|tortilla|chipa|cuenco|papel|tabla|plato/i, 11],
  [/pollo|jam[oó]n|lomo|suprema|pavita/i, 7],
  [/crout|crut|galleta|brownie|nuez|nueces|almendra|man[ií]/i, 6],
  [/nugget|milanesa|panceta|bacon|carne|medall[oó]n|pulled|hamburguesa|bondiola/i, 3],
  [/huevo|banana|naranja|zanahoria|calabaza/i, 12],
  [/chocolate|oreo|ddl|dulce de leche|caramelo|caf[eé]/i, 9],
];
function colorPorDefecto(ref, nombre = '') {
  for (const [re, c] of COLOR_POR_PALABRA) if (re.test(nombre)) return c;
  let h = 0;
  for (const c of String(ref)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % PALETA_N;
}

/** GET /businesses/:businessId/plazas */
exports.list = async (req, res, next) => {
  try {
    const bizId = num(req.businessId);
    let filtro = '';
    const params = [bizId];
    if (!esGestor(req)) {
      if (req.businessRole !== 'staff') return res.status(403).json({ ok: false, error: 'forbidden' });
      params.push(await sectoresDelStaff(req.user?.id, bizId));
      filtro = 'AND p.sector_id = ANY($2::int[])';
    }
    const { rows } = await pool.query(
      `SELECT p.id, p.nombre, p.sector_id, s.nombre AS sector_nombre,
              COALESCE(json_agg(json_build_object('articleId', pp.article_id,
                'nombre', (SELECT ma.nombre FROM maxi_articles ma WHERE ma.articulo_id = pp.article_id AND ma.business_id = p.business_id LIMIT 1))
                ORDER BY pp.orden, pp.article_id) FILTER (WHERE pp.article_id IS NOT NULL), '[]') AS productos
         FROM plazas p
         LEFT JOIN sectores s ON s.id = p.sector_id
         LEFT JOIN plaza_productos pp ON pp.plaza_id = p.id
        WHERE p.business_id = $1 AND p.deleted_at IS NULL ${filtro}
        GROUP BY p.id, s.nombre
        ORDER BY s.nombre, p.orden, p.nombre`, params);
    res.json({ ok: true, plazas: rows.map((r) => ({ id: r.id, nombre: r.nombre, sectorId: r.sector_id, sectorNombre: r.sector_nombre, productos: r.productos })) });
  } catch (e) { next(e); }
};

/** GET /businesses/:businessId/plazas/articulos?q= — artículos con receta para elegir. */
exports.articulos = async (req, res, next) => {
  try {
    if (!esGestor(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const bizId = num(req.businessId);
    const q = String(req.query.q || '').trim();
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (r.article_id) r.article_id AS id, COALESCE(ma.nombre, r.nombre) AS nombre
         FROM recetas r LEFT JOIN maxi_articles ma ON ma.articulo_id = r.article_id AND ma.business_id = r.business_id
        WHERE r.business_id = $1 AND r.article_id IS NOT NULL AND COALESCE(r.active, TRUE)
          AND ($2 = '' OR COALESCE(ma.nombre, r.nombre) ILIKE '%' || $2 || '%')
        ORDER BY r.article_id LIMIT 400`, [bizId, q]);
    rows.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    res.json({ ok: true, articulos: rows });
  } catch (e) { next(e); }
};

async function guardarProductos(plazaId, articleIds) {
  await pool.query('DELETE FROM plaza_productos WHERE plaza_id = $1', [plazaId]);
  const ids = [...new Set((articleIds || []).map(Number).filter(Number.isFinite))];
  if (ids.length) {
    await pool.query(
      `INSERT INTO plaza_productos (plaza_id, article_id, orden) SELECT $1, x.id, x.ord FROM unnest($2::int[]) WITH ORDINALITY AS x(id, ord)`,
      [plazaId, ids]);
  }
}

/** POST /businesses/:businessId/plazas  { sectorId, nombre, articleIds } */
exports.create = async (req, res, next) => {
  try {
    if (!esGestor(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const bizId = num(req.businessId);
    const sectorId = num(req.body?.sectorId);
    const nombre = String(req.body?.nombre || '').trim().slice(0, 60);
    if (!sectorId || !nombre) return res.status(400).json({ ok: false, error: 'datos_incompletos' });
    const { rows: sec } = await pool.query('SELECT 1 FROM sectores WHERE id = $1 AND business_id = $2', [sectorId, bizId]);
    if (!sec.length) return res.status(400).json({ ok: false, error: 'sector_invalido' });
    const { rows } = await pool.query(
      `INSERT INTO plazas (business_id, sector_id, nombre) VALUES ($1, $2, $3) RETURNING id`, [bizId, sectorId, nombre]);
    await guardarProductos(rows[0].id, req.body?.articleIds);
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
};

/** PUT /businesses/:businessId/plazas/:id  { nombre, articleIds } */
exports.update = async (req, res, next) => {
  try {
    if (!esGestor(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const bizId = num(req.businessId);
    const plaza = await cargarPlaza(num(req.params.id), bizId);
    if (!plaza) return res.status(404).json({ ok: false, error: 'not_found' });
    const nombre = String(req.body?.nombre || plaza.nombre).trim().slice(0, 60);
    await pool.query('UPDATE plazas SET nombre = $1, updated_at = NOW() WHERE id = $2', [nombre, plaza.id]);
    if (Array.isArray(req.body?.articleIds)) await guardarProductos(plaza.id, req.body.articleIds);
    res.json({ ok: true });
  } catch (e) { next(e); }
};

/** DELETE /businesses/:businessId/plazas/:id */
exports.remove = async (req, res, next) => {
  try {
    if (!esGestor(req)) return res.status(403).json({ ok: false, error: 'forbidden' });
    const { rowCount } = await pool.query(
      'UPDATE plazas SET deleted_at = NOW() WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL',
      [num(req.params.id), num(req.businessId)]);
    if (!rowCount) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
};

/** GET /businesses/:businessId/plazas/:id/vista[?articleId=] — tarjetas armadas (o solo la de ese producto,
 *  para refrescar una tarjeta después de editar su receta sin recargar la plaza). */
exports.vista = async (req, res, next) => {
  try {
    const bizId = num(req.businessId);
    const plaza = await cargarPlaza(num(req.params.id), bizId);
    if (!plaza) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!(await puedeVer(req, plaza))) return res.status(403).json({ ok: false, error: 'forbidden' });

    const { rows: prods } = await pool.query(
      `SELECT pp.article_id, COALESCE(ma.nombre, '#' || pp.article_id) AS nombre, f.layout
         FROM plaza_productos pp
         LEFT JOIN maxi_articles ma ON ma.articulo_id = pp.article_id AND ma.business_id = $2
         LEFT JOIN plaza_fichas f ON f.plaza_id = pp.plaza_id AND f.article_id = pp.article_id
        WHERE pp.plaza_id = $1 AND ($3::int IS NULL OR pp.article_id = $3)
        ORDER BY pp.orden, pp.article_id`, [plaza.id, bizId, num(req.query.articleId) || null]);
    const ids = prods.map((p) => p.article_id);
    const { rows: items } = ids.length ? await pool.query(
      `SELECT r.article_id, ri.id AS item_id, ri.cantidad, ri.unidad, ri.insumo_id, ri.article_ref_id, ri.observaciones,
              COALESCE(i.nombre, ri.nombre_insumo_maxi, ma2.nombre, 'Ingrediente') AS nombre
         FROM recetas r
         JOIN receta_items ri ON ri.receta_id = r.id
         LEFT JOIN insumos i ON i.id = ri.insumo_id
         LEFT JOIN maxi_articles ma2 ON ma2.articulo_id = ri.article_ref_id AND ma2.business_id = r.business_id
        WHERE r.business_id = $1 AND r.article_id = ANY($2::int[]) AND COALESCE(r.active, TRUE)
        ORDER BY ri.orden, ri.id`, [bizId, ids]) : { rows: [] };
    const { rows: cols } = await pool.query('SELECT ref, color, mostrar, alias FROM despacho_colores WHERE business_id = $1', [bizId]);
    const colorDe = new Map(cols.filter((c) => c.color != null).map((c) => [c.ref, Number(c.color)]));
    const mostrarDe = new Map(cols.filter((c) => c.mostrar).map((c) => [c.ref, c.mostrar]));
    const aliasDe = new Map(cols.filter((c) => c.alias).map((c) => [c.ref, c.alias]));

    const productos = prods.map((p) => {
      const layout = p.layout || {};
      const ocultos = new Set(Array.isArray(layout.ocultos) ? layout.ocultos : []);
      const base = items.filter((it) => it.article_id === p.article_id).map((it) => {
        const ref = it.insumo_id ? `i:${it.insumo_id}` : it.article_ref_id ? `a:${it.article_ref_id}` : `n:${String(it.nombre).toLowerCase()}`;
        return {
          key: `r:${it.item_id}`, ref, nombre: it.nombre,
          cantidad: it.cantidad != null ? Number(it.cantidad) : null, unidad: it.unidad || '',
          color: colorDe.has(ref) ? colorDe.get(ref) : colorPorDefecto(ref, it.nombre),
          obs: it.observaciones ? String(it.observaciones).trim() : '',
          mostrar: mostrarDe.get(ref) || 'peso',
          alias: aliasDe.get(ref) || '',
          oculto: ocultos.has(`r:${it.item_id}`), extra: false,
        };
      });
      const extras = (Array.isArray(layout.extras) ? layout.extras : []).map((x) => ({
        key: String(x.id), ref: null, nombre: String(x.texto || ''), cantidad: null, unidad: '', obs: '', mostrar: 'peso', alias: '',
        color: Number.isFinite(Number(x.color)) ? Number(x.color) : 12, oculto: false, extra: true,
      }));
      const todos = [...base, ...extras];
      const orden = Array.isArray(layout.orden) ? layout.orden.map(String) : [];
      const pos = new Map(orden.map((k, i) => [k, i]));
      todos.sort((a, b) => (pos.has(a.key) ? pos.get(a.key) : 1e6 + todos.indexOf(a)) - (pos.has(b.key) ? pos.get(b.key) : 1e6 + todos.indexOf(b)));
      return { articleId: p.article_id, nombre: p.nombre, renglones: todos };
    });
    res.json({ ok: true, plaza: { id: plaza.id, nombre: plaza.nombre, sectorId: plaza.sector_id, sectorNombre: plaza.sector_nombre },
      puedeArmar: await puedeArmar(req, plaza), productos });
  } catch (e) { next(e); }
};

/** PUT /businesses/:businessId/plazas/:id/fichas/:articleId  { orden, ocultos, extras } */
exports.guardarFicha = async (req, res, next) => {
  try {
    const bizId = num(req.businessId);
    const plaza = await cargarPlaza(num(req.params.id), bizId);
    if (!plaza) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!(await puedeArmar(req, plaza))) return res.status(403).json({ ok: false, error: 'forbidden' });
    const articleId = num(req.params.articleId);
    const str = (a) => (Array.isArray(a) ? a.map(String).filter((x) => x.length <= 40).slice(0, 200) : []);
    const extras = (Array.isArray(req.body?.extras) ? req.body.extras : []).slice(0, 30).map((x) => ({
      id: String(x.id || '').slice(0, 40), texto: String(x.texto || '').slice(0, 60), color: Math.max(0, Math.min(PALETA_N - 1, Number(x.color) || 0)),
    })).filter((x) => x.id.startsWith('x:'));
    const layout = { orden: str(req.body?.orden), ocultos: str(req.body?.ocultos), extras };
    await pool.query(
      `INSERT INTO plaza_fichas (plaza_id, article_id, layout, updated_by, updated_at) VALUES ($1, $2, $3::jsonb, $4, NOW())
       ON CONFLICT (plaza_id, article_id) DO UPDATE SET layout = EXCLUDED.layout, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [plaza.id, articleId, JSON.stringify(layout), req.user?.id ?? null]);
    res.json({ ok: true });
  } catch (e) { next(e); }
};

/** PUT /businesses/:businessId/plazas/colores  { ref, color?, mostrar?, alias? } — color, qué mostrar (peso | obs) y alias de un ingrediente, en todas las plazas. */
exports.guardarColor = async (req, res, next) => {
  try {
    const bizId = num(req.businessId);
    const ref = String(req.body?.ref || '').slice(0, 80);
    // Se puede mandar el color, qué mostrar ('peso' | 'obs'), o los dos; lo que no viene se conserva.
    const color = req.body?.color == null ? null : num(req.body.color);
    const mostrar = req.body?.mostrar == null ? null : String(req.body.mostrar);
    // alias: no viene → se conserva; '' → se borra (vuelve el nombre real).
    const tocaAlias = req.body?.alias !== undefined && req.body?.alias !== null;
    const alias = tocaAlias ? String(req.body.alias).trim().slice(0, 60) : null;
    const colorOk = color == null || (color >= 0 && color < PALETA_N);
    const mostrarOk = mostrar == null || ['peso', 'obs'].includes(mostrar);
    if (!ref || (color == null && mostrar == null && !tocaAlias) || !colorOk || !mostrarOk) return res.status(400).json({ ok: false, error: 'datos_invalidos' });
    if (!esGestor(req)) {
      const conduce = await sectoresQueConduce(req.user?.id, bizId);
      if (!conduce.length) return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    await pool.query(
      `INSERT INTO despacho_colores (business_id, ref, color, mostrar, alias) VALUES ($1, $2, $3, $4, NULLIF($6, ''))
       ON CONFLICT (business_id, ref) DO UPDATE SET color = COALESCE(EXCLUDED.color, despacho_colores.color),
                                                    mostrar = COALESCE(EXCLUDED.mostrar, despacho_colores.mostrar),
                                                    alias = CASE WHEN $5::boolean THEN NULLIF($6, '') ELSE despacho_colores.alias END`,
      [bizId, ref, color, mostrar, tocaAlias, alias || '']);
    res.json({ ok: true });
  } catch (e) { next(e); }
};
