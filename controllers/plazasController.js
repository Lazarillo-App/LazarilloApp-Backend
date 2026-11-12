// controllers/plazasController.js
//
// Plazas de despacho (Diego 11/11/2026): subsectores de Cocina/Barra (Ensaladas, Freidora…) con sus
// productos. La vista de la plaza muestra cada producto con su receta TAL CUAL, en el orden que se
// arma (drag and drop), sin los ingredientes ocultos (ojito) y con renglones extra (notas, vajilla).
// El color es por insumo y vale en todas las plazas del negocio.
//   Ver: dueño/admin todas; Staff las de sus sectores.
//   Armar la ficha (orden, ojito, extras, colores): dueño/admin y el jefe del sector.
//   Crear/editar/borrar plazas y sus productos: dueño/admin en todos los sectores; el jefe en los que conduce.
'use strict';

const pool = require('../config/db');
const { sectoresQueConduce } = require('../services/jefeCocina');
const { recalcularCostoRecetas } = require('../services/costoRecetaService');
const { createOrUpdateProposal, snapshotReceta } = require('../services/recetaProposals');
const { normalizarCantidadUnidad, canonicalUnit } = require('../services/unidades');
const { logAudit } = require('../services/audit/auditLog');

// ── Unidades de un ingrediente (panel «En esta receta» de la plaza, Diego 11/11/2026) ──
// Cada unidad se mide en su familia (peso en gr, volumen en ml, unidades en u) para poder pasar
// la cantidad de una a otra (75 g → 1,5 dip si el dip es 50 g) y el costo unitario en proporción.
const FAMILIA = { gr: ['peso', 1], kg: ['peso', 1000], lb: ['peso', 453.59], ml: ['vol', 1], lt: ['vol', 1000], oz: ['vol', 30], u: ['u', 1] };
function tamanoUnidad(unidad, equivalencias) {
  const raw = String(unidad || '').trim().toLowerCase();
  const eq = (equivalencias || []).find((e) => String(e.nombre || '').trim().toLowerCase() === raw);
  if (eq) {
    const base = FAMILIA[canonicalUnit(eq.unidad)];
    return base ? { familia: base[0], valor: (Number(eq.contenido) || 0) * base[1] } : null;
  }
  const base = FAMILIA[canonicalUnit(raw)];
  return base ? { familia: base[0], valor: base[1] } : null;
}
function unidadesDe(unidadActual, equivalencias) {
  const t = tamanoUnidad(unidadActual, equivalencias);
  const fisicas = !t ? [] : t.familia === 'peso' ? ['gr', 'kg'] : t.familia === 'vol' ? ['ml', 'lt'] : ['u'];
  const lista = fisicas.map((n) => ({ nombre: n, familia: t.familia, valor: FAMILIA[n][1] }));
  for (const e of equivalencias || []) {
    const te = tamanoUnidad(e.nombre, equivalencias);
    lista.push({ nombre: e.nombre, detalle: `${Number(e.contenido).toLocaleString('es-AR', { maximumFractionDigits: 2 })} ${e.unidad}`,
      familia: te?.familia || null, valor: te?.valor || null });
  }
  if (unidadActual && !lista.some((u) => u.nombre.toLowerCase() === String(unidadActual).toLowerCase())) {
    lista.unshift({ nombre: unidadActual, familia: t?.familia || null, valor: t?.valor || null });
  }
  return lista;
}

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
// Sectores donde se pueden crear / editar / borrar plazas (Diego 12/11/2026: «del jefe de cocina
// para arriba»): dueño/admin todos los del negocio; el jefe, los sectores que conduce.
async function sectoresGestionables(req, bizId) {
  if (esGestor(req)) {
    const { rows } = await pool.query('SELECT id FROM sectores WHERE business_id = $1', [bizId]);
    return rows.map((r) => Number(r.id));
  }
  if (req.businessRole !== 'staff') return [];
  return sectoresQueConduce(req.user?.id, bizId);
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
    const gestionables = await sectoresGestionables(req, bizId);
    const { rows: secs } = gestionables.length ? await pool.query(
      'SELECT id, nombre FROM sectores WHERE business_id = $1 AND id = ANY($2::int[]) ORDER BY nombre', [bizId, gestionables]) : { rows: [] };
    res.json({ ok: true,
      plazas: rows.map((r) => ({ id: r.id, nombre: r.nombre, sectorId: r.sector_id, sectorNombre: r.sector_nombre, productos: r.productos,
        puedeEditar: gestionables.includes(Number(r.sector_id)) })),
      puedeCrear: secs.length > 0, sectores: secs.map((x) => ({ id: x.id, nombre: x.nombre })) });
  } catch (e) { next(e); }
};

/** GET /businesses/:businessId/plazas/articulos?q= — artículos con receta para elegir.
 * Diego 12/11/2026: ordenados por ventas (últimos 90 días, de mayor a menor), con su rubro y subrubro
 * (para agruparlos) y las agrupaciones donde están (para filtrar). Los discontinuados no se ofrecen.
 * Una sola consulta: ~11 ms con 597 artículos (EXPLAIN ANALYZE, negocio 147). */
const NO_FILTRO = ['todo', 'sin agrupacion', 'sin agrupación', 'sin agrupar', 'sin grupo', 'discontinuados', 'descontinuados', 'top 20'];
exports.articulos = async (req, res, next) => {
  try {
    const bizId = num(req.businessId);
    if (!(await sectoresGestionables(req, bizId)).length) return res.status(403).json({ ok: false, error: 'forbidden' });
    const q = String(req.query.q || '').trim();
    const { rows } = await pool.query(
      `WITH base AS (
         SELECT DISTINCT ON (r.article_id) r.article_id AS id, COALESCE(ma.nombre, r.nombre) AS nombre,
                NULLIF(TRIM(ma.subrubro), '') AS rubro, NULLIF(TRIM(ma.categoria), '') AS subrubro
           FROM recetas r LEFT JOIN maxi_articles ma ON ma.articulo_id = r.article_id AND ma.business_id = r.business_id
          WHERE r.business_id = $1 AND r.article_id IS NOT NULL AND COALESCE(r.active, TRUE)
            AND ($2 = '' OR COALESCE(ma.nombre, r.nombre) ILIKE '%' || $2 || '%')
          ORDER BY r.article_id),
       v AS (SELECT s.article_id, SUM(s.qty)::float8 AS qty FROM sales_daily_items s
              WHERE s.business_id = $1 AND s.day >= CURRENT_DATE - 90 GROUP BY s.article_id),
       g AS (SELECT (e->>'id')::int AS articulo_id, array_agg(DISTINCT a.id) AS agrup,
                    bool_or(LOWER(TRIM(a.nombre)) IN ('discontinuados', 'descontinuados')) AS disc
               FROM agrupaciones a
               CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.articulos) = 'array' THEN a.articulos ELSE '[]'::jsonb END) e
              WHERE a.business_id = $1 AND NOT COALESCE(a.is_temporary, FALSE) AND (e->>'id') ~ '^-?[0-9]+$'
              GROUP BY 1)
       SELECT b.id, b.nombre, b.rubro, b.subrubro, COALESCE(v.qty, 0) AS ventas, COALESCE(g.agrup, '{}') AS agrupaciones
         FROM base b LEFT JOIN v ON v.article_id = b.id LEFT JOIN g ON g.articulo_id = b.id
        WHERE NOT COALESCE(g.disc, FALSE)
        ORDER BY ventas DESC, b.nombre`, [bizId, q]);
    const { rows: grupos } = await pool.query(
      `SELECT id, nombre FROM agrupaciones
        WHERE business_id = $1 AND NOT COALESCE(is_temporary, FALSE)
          AND jsonb_typeof(articulos) = 'array' AND jsonb_array_length(articulos) > 0
          AND LOWER(TRIM(nombre)) <> ALL($2::text[])
        ORDER BY nombre`, [bizId, NO_FILTRO]);
    res.json({ ok: true, articulos: rows.map((r) => ({ ...r, ventas: Number(r.ventas) || 0 })), agrupaciones: grupos });
  } catch (e) { next(e); }
};

async function guardarProductos(plazaId, articleIds) {
  await pool.query('DELETE FROM plaza_productos WHERE plaza_id = $1', [plazaId]);
  const ids = [...new Set((articleIds || []).map(Number).filter(Number.isFinite))];
  if (ids.length) {
    await pool.query(
      `INSERT INTO plaza_productos (plaza_id, article_id, orden) SELECT $1, x.id, x.ord FROM unnest($2::int[]) WITH ORDINALITY AS x(id, ord)`,
      [plazaId, ids]);
    await congelarOrden(plazaId);
  }
}

// El orden de armado es propio de la plaza (Diego 11/11/2026): al sumar un producto se copia el
// orden que tiene hoy su receta y desde ahí la receta (que se ordena por costo) ya no lo mueve.
// Los productos que ya tenían ficha no se tocan.
async function congelarOrden(plazaId) {
  await pool.query(
    `INSERT INTO plaza_fichas (plaza_id, article_id, layout, updated_at)
     SELECT pp.plaza_id, pp.article_id,
            jsonb_build_object(
              'orden', COALESCE((
                SELECT jsonb_agg(CASE WHEN ri.insumo_id IS NOT NULL THEN 'i:' || ri.insumo_id
                                      WHEN ri.article_ref_id IS NOT NULL THEN 'a:' || ri.article_ref_id
                                      ELSE 'n:' || lower(COALESCE(ri.nombre_insumo_maxi, 'Ingrediente')) END
                                 ORDER BY ri.orden, ri.id)
                  FROM recetas r JOIN receta_items ri ON ri.receta_id = r.id
                 WHERE r.business_id = p.business_id AND r.article_id = pp.article_id AND COALESCE(r.active, TRUE)), '[]'::jsonb),
              'ocultos', '[]'::jsonb, 'extras', '[]'::jsonb),
            NOW()
       FROM plaza_productos pp JOIN plazas p ON p.id = pp.plaza_id
      WHERE pp.plaza_id = $1
     ON CONFLICT (plaza_id, article_id) DO NOTHING`, [plazaId]);
}

/** POST /businesses/:businessId/plazas  { sectorId, nombre, articleIds } */
exports.create = async (req, res, next) => {
  try {
    const bizId = num(req.businessId);
    const sectorId = num(req.body?.sectorId);
    if (!(await sectoresGestionables(req, bizId)).includes(sectorId)) return res.status(403).json({ ok: false, error: 'forbidden' });
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
    const bizId = num(req.businessId);
    const plaza = await cargarPlaza(num(req.params.id), bizId);
    if (!plaza) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!(await sectoresGestionables(req, bizId)).includes(Number(plaza.sector_id))) return res.status(403).json({ ok: false, error: 'forbidden' });
    const nombre = String(req.body?.nombre || plaza.nombre).trim().slice(0, 60);
    await pool.query('UPDATE plazas SET nombre = $1, updated_at = NOW() WHERE id = $2', [nombre, plaza.id]);
    if (Array.isArray(req.body?.articleIds)) await guardarProductos(plaza.id, req.body.articleIds);
    res.json({ ok: true });
  } catch (e) { next(e); }
};

/** DELETE /businesses/:businessId/plazas/:id */
exports.remove = async (req, res, next) => {
  try {
    const bizId = num(req.businessId);
    const plaza = await cargarPlaza(num(req.params.id), bizId);
    if (!plaza) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!(await sectoresGestionables(req, bizId)).includes(Number(plaza.sector_id))) return res.status(403).json({ ok: false, error: 'forbidden' });
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
    const insIds = [...new Set(items.map((it) => it.insumo_id).filter(Boolean))];
    const { rows: eqRows } = insIds.length ? await pool.query(
      'SELECT insumo_id, nombre, contenido, unidad FROM insumo_equivalencias WHERE insumo_id = ANY($1::int[]) ORDER BY nombre', [insIds]) : { rows: [] };
    const eqsDe = new Map();
    for (const e of eqRows) { if (!eqsDe.has(e.insumo_id)) eqsDe.set(e.insumo_id, []); eqsDe.get(e.insumo_id).push(e); }
    const { rows: cols } = await pool.query('SELECT ref, color, mostrar, alias FROM despacho_colores WHERE business_id = $1', [bizId]);
    const colorDe = new Map(cols.filter((c) => c.color != null).map((c) => [c.ref, Number(c.color)]));
    const mostrarDe = new Map(cols.filter((c) => c.mostrar).map((c) => [c.ref, c.mostrar]));
    const aliasDe = new Map(cols.filter((c) => c.alias).map((c) => [c.ref, c.alias]));

    const productos = prods.map((p) => {
      const layout = p.layout || {};
      const propios = items.filter((it) => it.article_id === p.article_id);
      // El renglón se identifica por el INGREDIENTE, no por el id del renglón de la receta (que
      // cambia cada vez que se guarda la receta). Las claves viejas r:<id> se traducen.
      const refDe = (it) => (it.insumo_id ? `i:${it.insumo_id}` : it.article_ref_id ? `a:${it.article_ref_id}` : `n:${String(it.nombre).toLowerCase()}`);
      const viejas = new Map(propios.map((it) => [`r:${it.item_id}`, refDe(it)]));
      const traducir = (lista) => (Array.isArray(lista) ? lista.map((k) => viejas.get(String(k)) || String(k)) : []);
      const ocultos = new Set(traducir(layout.ocultos));
      const usadas = new Map();
      const base = propios.map((it) => {
        const ref = refDe(it);
        const n = (usadas.get(ref) || 0) + 1;   // mismo ingrediente dos veces en la receta
        usadas.set(ref, n);
        const key = n === 1 ? ref : `${ref}#${n}`;
        return {
          key, ref, nombre: it.nombre,
          cantidad: it.cantidad != null ? Number(it.cantidad) : null, unidad: it.unidad || '',
          color: colorDe.has(ref) ? colorDe.get(ref) : colorPorDefecto(ref, it.nombre),
          obs: it.observaciones ? String(it.observaciones).trim() : '',
          mostrar: mostrarDe.get(ref) || 'peso',
          alias: aliasDe.get(ref) || '',
          editable: !!it.insumo_id,
          unidades: it.insumo_id ? unidadesDe(it.unidad, eqsDe.get(it.insumo_id)) : [],
          oculto: ocultos.has(key), extra: false,
        };
      });
      const extras = (Array.isArray(layout.extras) ? layout.extras : []).map((x) => ({
        key: String(x.id), ref: null, nombre: String(x.texto || ''), cantidad: null, unidad: '', obs: '', mostrar: 'peso', alias: '',
        color: Number.isFinite(Number(x.color)) ? Number(x.color) : 12, oculto: false, extra: true,
      }));
      const todos = [...base, ...extras];
      const orden = traducir(layout.orden);
      const pos = new Map(orden.map((k, i) => [k, i]));
      // Lo que no está en el orden guardado (ingrediente nuevo en la receta) va al final, en el orden de la receta.
      const lugar = new Map(todos.map((r, i) => [r.key, pos.has(r.key) ? pos.get(r.key) : 1e6 + i]));
      todos.sort((a, b) => lugar.get(a.key) - lugar.get(b.key));
      return { articleId: p.article_id, nombre: p.nombre, renglones: todos };
    });
    res.json({ ok: true, plaza: { id: plaza.id, nombre: plaza.nombre, sectorId: plaza.sector_id, sectorNombre: plaza.sector_nombre },
      puedeArmar: await puedeArmar(req, plaza), productos });
  } catch (e) { next(e); }
};

/** PUT /businesses/:businessId/plazas/:id/fichas/:articleId/item  { key, cantidad, unidad, observaciones }
 *  Edita UN ingrediente de la receta desde la plaza (Diego 11/11/2026).
 *  Dueño/admin: se guarda directo (UPDATE puntual del renglón + recálculo de costo, mismo patrón que
 *  usoInsumoCambiarCantidad). Staff (cocinero/jefe del sector): queda como PROPUESTA en el circuito
 *  de aprobación existente (receta completa con ese cambio, mismo formato que el modal de receta).
 *  Cambio de unidad: el costo unitario se pasa en proporción (75 g → 1,5 dip de 50 g cuesta lo mismo);
 *  entre familias distintas (g ↔ u) no se puede: hay que hacerlo desde el modal de receta. */
exports.editarItem = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const bizId = num(req.businessId);
    const plaza = await cargarPlaza(num(req.params.id), bizId);
    if (!plaza) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!(await puedeVer(req, plaza))) return res.status(403).json({ ok: false, error: 'forbidden' });
    const articleId = num(req.params.articleId);
    const { rowCount: enPlaza } = await client.query('SELECT 1 FROM plaza_productos WHERE plaza_id = $1 AND article_id = $2', [plaza.id, articleId]);
    if (!enPlaza) return res.status(404).json({ ok: false, error: 'producto_no_esta_en_la_plaza' });
    const { rows: rec } = await client.query(
      'SELECT id FROM recetas WHERE business_id = $1 AND article_id = $2 AND active = TRUE LIMIT 1', [bizId, articleId]);
    if (!rec.length) return res.status(404).json({ ok: false, error: 'sin_receta' });
    const recetaId = rec[0].id;

    // Mismo armado de claves que la vista (por ingrediente; #2 si se repite).
    const { rows: items } = await client.query(
      `SELECT ri.*, COALESCE(i.nombre, ri.nombre_insumo_maxi, ma2.nombre, 'Ingrediente') AS nombre_vista
         FROM receta_items ri
         JOIN recetas r ON r.id = ri.receta_id
         LEFT JOIN insumos i ON i.id = ri.insumo_id
         LEFT JOIN maxi_articles ma2 ON ma2.articulo_id = ri.article_ref_id AND ma2.business_id = r.business_id
        WHERE ri.receta_id = $1 ORDER BY ri.orden, ri.id`, [recetaId]);
    const usadas = new Map();
    const conClave = items.map((it) => {
      const ref = it.insumo_id ? `i:${it.insumo_id}` : it.article_ref_id ? `a:${it.article_ref_id}` : `n:${String(it.nombre_vista).toLowerCase()}`;
      const n = (usadas.get(ref) || 0) + 1; usadas.set(ref, n);
      return { it, key: n === 1 ? ref : `${ref}#${n}` };
    });
    const objetivo = conClave.find((x) => x.key === String(req.body?.key || ''));
    if (!objetivo) return res.status(404).json({ ok: false, error: 'ingrediente_no_encontrado' });
    const it = objetivo.it;
    if (!it.insumo_id) return res.status(400).json({ ok: false, error: 'solo_insumos' });

    const cantidad = req.body?.cantidad != null ? Number(req.body.cantidad) : Number(it.cantidad);
    if (!Number.isFinite(cantidad) || cantidad <= 0) return res.status(400).json({ ok: false, error: 'cantidad_invalida' });
    const unidad = String(req.body?.unidad || it.unidad || '').trim().slice(0, 40);
    const observaciones = req.body?.observaciones != null ? (String(req.body.observaciones).trim().slice(0, 500) || null) : it.observaciones;

    let costoUnitario = Number(it.costo_unitario) || 0;
    if (unidad.toLowerCase() !== String(it.unidad || '').toLowerCase()) {
      const { rows: eqs } = await client.query('SELECT nombre, contenido, unidad FROM insumo_equivalencias WHERE insumo_id = $1', [it.insumo_id]);
      const antes = tamanoUnidad(it.unidad, eqs);
      const despues = tamanoUnidad(unidad, eqs);
      if (!antes || !despues || antes.familia !== despues.familia || !(antes.valor > 0) || !(despues.valor > 0)) {
        // El texto va en `error` porque es lo que el front muestra (http() de apiBusinesses).
        return res.status(400).json({ ok: false, code: 'unidad_incompatible',
          error: `No se puede pasar de ${it.unidad} a ${unidad} desde acá: cambiala desde el modal de receta.` });
      }
      costoUnitario = costoUnitario * (despues.valor / antes.valor);
    }
    const norm = normalizarCantidadUnidad(cantidad, unidad, costoUnitario);

    // ── Staff: propuesta (la receta real no cambia hasta que se apruebe) ──
    if (req.businessRole === 'staff') {
      const before = await snapshotReceta(articleId, bizId);
      const { rows: recFull } = await client.query('SELECT * FROM recetas WHERE id = $1', [recetaId]);
      const r = recFull[0];
      const body = {
        nombre: r.nombre, descripcion: r.descripcion, porciones: r.porciones, porcentajeVenta: r.porcentaje_venta,
        rendimientoUnidad: r.rendimiento_unidad, rendimientoPeso: r.rendimiento_peso, unidadPeso: r.unidad_peso,
        notas: r.notas, foto: r.foto, fotos: r.fotos, notasUpdatedAt: r.notas_updated_at,
        metodoCoccion: r.metodo_coccion, temperatura: r.temperatura, tiempoMin: r.tiempo_min, pasos: r.pasos,
        almacenamientoFreezer: r.almacenamiento_freezer, almacenamientoHeladera: r.almacenamiento_heladera,
        items: items.map((x) => {
          const esEste = x.id === it.id;
          return {
            supplyId: x.article_ref_id ? null : (x.insumo_id || x.supply_id || null),
            articleRefId: x.article_ref_id || null,
            cantidad: esEste ? norm.cantidad : Number(x.cantidad),
            unidad: esEste ? norm.unidad : x.unidad,
            costoUnitario: esEste ? norm.costoUnitario : Number(x.costo_unitario) || 0,
            notas: x.notas, observaciones: esEste ? observaciones : x.observaciones,
            merma: x.merma, pedido: x.pedido, tipoCosto: x.tipo_costo, orden: x.orden,
            mermaIds: Array.isArray(x.merma_ids) && x.merma_ids.length ? x.merma_ids : (x.merma_id != null ? [x.merma_id] : []),
            secreto: x.secreto === true, fotosUrls: Array.isArray(x.fotos_urls) ? x.fotos_urls : [],
          };
        }),
      };
      const proposal = await createOrUpdateProposal({
        bizId, articleId, uid: req.user?.id, body, snapshotBefore: before,
        nombreParaAviso: req.user?.name || req.user?.email,
      });
      return res.json({ ok: true, pending: true, proposalId: proposal?.id || null });
    }

    // ── Dueño/admin: directo ──
    await client.query('BEGIN');
    await client.query(
      `UPDATE receta_items SET cantidad = $1, unidad = $2, costo_unitario = $3, observaciones = $4, updated_at = NOW() WHERE id = $5`,
      [norm.cantidad, norm.unidad || null, Number(norm.costoUnitario.toFixed(6)), observaciones, it.id]);
    await recalcularCostoRecetas([recetaId], client);
    await logAudit(client, {
      userId: req.user?.id || null, businessId: bizId, entityType: 'receta_item_plaza', entityId: it.id, action: 'update',
      diff: { before: { cantidad: Number(it.cantidad), unidad: it.unidad, observaciones: it.observaciones },
              after: { cantidad: norm.cantidad, unidad: norm.unidad, observaciones } },
      metadata: { plazaId: plaza.id, articleId, recetaId },
    });
    await client.query('COMMIT');
    res.json({ ok: true, pending: false });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* sin transacción abierta */ }
    next(e);
  } finally {
    client.release();
  }
};

/** PUT /businesses/:businessId/plazas/:id/fichas/:articleId  { orden, ocultos, extras } */
exports.guardarFicha = async (req, res, next) => {
  try {
    const bizId = num(req.businessId);
    const plaza = await cargarPlaza(num(req.params.id), bizId);
    if (!plaza) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!(await puedeArmar(req, plaza))) return res.status(403).json({ ok: false, error: 'forbidden' });
    const articleId = num(req.params.articleId);
    const str = (a) => (Array.isArray(a) ? a.map(String).filter((x) => x.length <= 120).slice(0, 200) : []);
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
