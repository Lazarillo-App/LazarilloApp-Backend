// services/kit/maestrosDesdeKit.js
// Artículos (m6_listado_de_articulos) e insumos (m0_listado_de_insumos_con_discontinuados) que
// sube el kit, pasados a Lazarillo (maxi_articles / insumos) con las MISMAS reglas que la sync
// de la API de MaxiRest — así un negocio que solo tiene el kit vinculado recibe su carta y sus
// insumos sin cargar nada a mano, y las ventas/compras del kit encuentran con qué cruzarse.
//
// Reglas (08/11/2026, chequeado contra producción: precio1 del kit = precio de la API en 147,
// 210 y 190; columnas iguales en los 4 esquemas):
//  - Los maestros son por esquema (organización). Van al negocio "raíz" de cada negocio mapeado
//    (resolveCredsBizId: un from_group usa los de su raíz, igual que compras e insumos).
//  - Artículos nuevos (no discontinuados): se crean como origen 'maxi', con las columnas espejo
//    (*_maxi) igual que la API.
//  - Artículos existentes: SOLO si el negocio no tiene la API de MaxiRest configurada (si la
//    tiene, manda la API: el kit pondría los nombres con acentos y la API sin, y se pisarían
//    cada hora). Mismas reglas que la API: lo editado en Lazarillo (valor ≠ espejo), los
//    artículos manuales/promo y los de precio manual no se tocan; el costo nunca (el kit no lo
//    trae).
//  - Rubro/subrubro van INTERCAMBIADOS a propósito (categoria = subrubro de MaxiRest, subrubro =
//    rubro; confirmado por la usuaria y por los datos: 1011 contra 14 en el Bar). Se usa el orden
//    que ya tienen los artículos del negocio; sin artículos, el intercambiado (o el directo si el
//    negocio tiene invertir_jerarquia_articulos, como el botón de sincronizar).
//  - Insumos: la sync aditiva de siempre (repos/insumosRepo.upsertFromMaxi): crea los que faltan
//    y no toca los existentes.
'use strict';

const pool = require('../../config/db');
const { PDV_MAP, refrescarPdvMap } = require('../maxiPdvMap');

const M6 = 'm6_listado_de_articulos';
const M0 = 'm0_listado_de_insumos_con_discontinuados';
const RE_ESQUEMA = /^[a-z_][a-z0-9_]*$/;

const txt = (v) => (v == null ? '' : String(v).trim());
const numero = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const entero = (v) => { const n = numero(v); return n == null ? null : Math.trunc(n); };
const verdadero = (v) => v === true || ['true', 't', '1'].includes(txt(v).toLowerCase());

// ---------------------------------------------------------------- funciones puras

// Fila de m6 → artículo con la forma de maxi_articles. orden: 'rubro_categoria' (API de menú:
// categoria = rubro) | 'rubro_subrubro' (botón manual: subrubro = rubro).
function articuloDesdeM6(f, orden = 'rubro_categoria') {
  const id = entero(f.codigo);
  if (!id || id <= 0) return null;
  const nombre = txt(f.nombre).slice(0, 200);
  if (!nombre) return null;
  const rubro = txt(f.rubro) || null;
  const subrubro = txt(f.subrubro) || null;
  // categoria/subrubro no admiten null en maxi_articles: mismo relleno que la sync manual.
  const categoria = (orden === 'rubro_subrubro' ? subrubro : rubro) || 'Sin categoría';
  const sub = (orden === 'rubro_subrubro' ? rubro : subrubro) || 'Sin subrubro';
  return {
    articulo_id: id,
    nombre,
    categoria,
    subrubro: sub,
    precio: numero(f.precio1) ?? 0,
    cod_rua: entero(f.cod_rua),
    cod_sua: entero(f.cod_sua),
    discontinuado: verdadero(f.discontinuado),
    raw: {
      codigo: id, nombre, descripc: txt(f.descripcion) || null, cod_rua: entero(f.cod_rua), cod_sua: entero(f.cod_sua),
      precio1: numero(f.precio1), precio2: numero(f.precio2), precio3: numero(f.precio3), precio4: numero(f.precio4),
      _source: 'kit',
    },
  };
}

// Fila de m0 → insumo con la forma que espera upsertFromMaxi (igual que normalizarInsumosMaxi).
function insumoDesdeM0(f) {
  const codigo = entero(f.codigo);
  if (!codigo || codigo <= 0) return null;
  const nombre = txt(f.nombre);
  if (!nombre) return null;
  const precio = numero(f.precio);
  return {
    codigo_maxi: String(codigo),
    nombre,
    rubro: entero(f.cod_rui) == null ? null : String(entero(f.cod_rui)),
    unidad_med: txt(f.unidad_med) || null,
    precio_ref: precio != null && precio > 0 ? precio : null,
    maxi_discontinuado: verdadero(f.discontinuado),
  };
}

// ¿En qué orden guarda rubro/subrubro este negocio? existentes: [{articulo_id, categoria_maxi,
// subrubro_maxi}] — cuenta coincidencias de cada orden contra m6.
// Sin artículos para comparar: el criterio de Lazarillo (confirmado por la usuaria 08/11:
// rubro y subrubro van intercambiados) — categoria = subrubro de MaxiRest, subrubro = rubro;
// con invertir_jerarquia_articulos, al revés (igual que el botón de sincronizar).
function elegirOrden(existentes, filasM6, { invertirJerarquia = false } = {}) {
  const porId = new Map(filasM6.map((f) => [entero(f.codigo), f]));
  let directo = 0; let invertido = 0;
  for (const e of existentes) {
    const f = porId.get(Number(e.articulo_id));
    if (!f) continue;
    const cat = txt(e.categoria_maxi).toLowerCase();
    if (!cat) continue;
    if (cat === txt(f.rubro).toLowerCase()) directo++;
    else if (cat === txt(f.subrubro).toLowerCase()) invertido++;
  }
  let orden;
  if (invertido > directo) orden = 'rubro_subrubro';
  else if (directo > invertido) orden = 'rubro_categoria';
  else orden = invertirJerarquia ? 'rubro_categoria' : 'rubro_subrubro';
  return { orden, directo, invertido };
}

// ---------------------------------------------------------------- base

async function tieneApiMaxi(db, businessId) {
  const { rows } = await db.query(
    `SELECT 1 FROM app_businesses
      WHERE id = $1 AND (props->'maxi'->>'email') IS NOT NULL
        AND ((props->'maxi'->>'codcli') IS NOT NULL OR (props->'maxi'->>'cod_cli') IS NOT NULL)
        AND (props->'maxi' ? 'pass_enc' OR props->'maxi' ? 'pass' OR props->'maxi' ? 'password')`,
    [businessId]);
  return rows.length > 0;
}

// Negocios raíz que reciben los maestros de un esquema.
async function destinosDeEsquema(esquema) {
  const { resolveCredsBizId } = require('../../controllers/purchasesController');
  const ids = new Set();
  for (const v of Object.values(PDV_MAP)) {
    if (v.schema === esquema) ids.add(Number(await resolveCredsBizId(v.businessId)));
  }
  return [...ids];
}

async function existeTabla(db, esquema, tabla) {
  const { rows } = await db.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [esquema, tabla]);
  return rows.length > 0;
}

async function aplicarArticulos(businessId, filasM6, { dryRun, actualizar }) {
  const { rows: existentes } = await pool.query(
    `SELECT articulo_id, nombre, nombre_maxi, precio, precio_maxi, categoria_maxi, subrubro_maxi, origen
       FROM maxi_articles WHERE business_id = $1`, [businessId]);
  const { rows: fl } = await pool.query(
    `SELECT COALESCE((props->>'invertir_jerarquia_articulos')::boolean, false) AS inv FROM app_businesses WHERE id = $1`,
    [businessId]).catch(() => ({ rows: [] }));
  const { orden, directo, invertido } = elegirOrden(existentes, filasM6, { invertirJerarquia: !!fl[0]?.inv });
  const porId = new Map(existentes.map((e) => [Number(e.articulo_id), e]));
  const articulos = filasM6.map((f) => articuloDesdeM6(f, orden)).filter(Boolean);

  // Defensa (igual que la API con 0 artículos): un maestro vacío o recortado no toca nada.
  if (!articulos.length || (existentes.length >= 20 && articulos.length < existentes.length * 0.5)) {
    return { orden, saltado: `m6 trae ${articulos.length} artículos y el negocio tiene ${existentes.length}` };
  }

  const nuevos = articulos.filter((a) => !a.discontinuado && !porId.has(a.articulo_id));
  const cambian = !actualizar ? [] : articulos.filter((a) => {
    const e = porId.get(a.articulo_id);
    if (!e || e.origen !== 'maxi') return false;
    return txt(e.nombre_maxi) !== a.nombre
      || Math.abs(Number(e.precio_maxi ?? 0) - a.precio) > 0.005
      || (a.categoria != null && txt(e.categoria_maxi) !== a.categoria)
      || (a.subrubro != null && txt(e.subrubro_maxi) !== a.subrubro);
  });
  const resumen = {
    orden, coincidencias: { rubro_categoria: directo, rubro_subrubro: invertido },
    nuevos: nuevos.length, ejemplosNuevos: nuevos.slice(0, 10).map((a) => `${a.articulo_id} ${a.nombre}`),
    actualizar, cambian: cambian.length,
    ejemplosCambian: cambian.slice(0, 5).map((a) => {
      const e = porId.get(a.articulo_id);
      return { id: a.articulo_id, nombre: [e.nombre_maxi, a.nombre], precio: [Number(e.precio_maxi), a.precio], categoria: [e.categoria_maxi, a.categoria], subrubro: [e.subrubro_maxi, a.subrubro] };
    }),
  };
  if (dryRun || (!nuevos.length && !cambian.length)) return resumen;

  const lote = [...nuevos, ...cambian];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `WITH d AS (
         SELECT * FROM UNNEST($2::bigint[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::int[], $8::int[], $9::jsonb[])
           AS t(articulo_id, nombre, categoria, subrubro, precio, cod_rua, cod_sua, raw)
       )
       INSERT INTO maxi_articles (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw,
                                  cod_rua, cod_sua, nombre_maxi, categoria_maxi, subrubro_maxi, precio_maxi, updated_at)
       SELECT $1, articulo_id, nombre, categoria, subrubro, precio, 0, raw, cod_rua, cod_sua,
              nombre, categoria, subrubro, precio, NOW() FROM d
       ON CONFLICT (business_id, articulo_id) DO UPDATE SET
         precio = CASE WHEN maxi_articles.precio IS DISTINCT FROM maxi_articles.precio_maxi
                       THEN maxi_articles.precio ELSE EXCLUDED.precio END,
         precio_maxi = EXCLUDED.precio,
         nombre = CASE WHEN maxi_articles.nombre IS DISTINCT FROM maxi_articles.nombre_maxi
                       THEN maxi_articles.nombre ELSE EXCLUDED.nombre END,
         nombre_maxi = EXCLUDED.nombre,
         categoria = CASE WHEN maxi_articles.categoria IS DISTINCT FROM maxi_articles.categoria_maxi
                          THEN maxi_articles.categoria ELSE COALESCE(EXCLUDED.categoria, maxi_articles.categoria) END,
         subrubro = CASE WHEN maxi_articles.subrubro IS DISTINCT FROM maxi_articles.subrubro_maxi
                         THEN maxi_articles.subrubro ELSE COALESCE(EXCLUDED.subrubro, maxi_articles.subrubro) END,
         categoria_maxi = COALESCE(EXCLUDED.categoria, maxi_articles.categoria_maxi),
         subrubro_maxi = COALESCE(EXCLUDED.subrubro, maxi_articles.subrubro_maxi),
         cod_rua = COALESCE(EXCLUDED.cod_rua, maxi_articles.cod_rua),
         cod_sua = COALESCE(EXCLUDED.cod_sua, maxi_articles.cod_sua),
         updated_at = NOW()
       WHERE maxi_articles.origen = 'maxi'
         AND NOT EXISTS (
           SELECT 1 FROM article_price_config apc
            WHERE apc.business_id = maxi_articles.business_id AND apc.scope = 'articulo'
              AND apc.scope_id = maxi_articles.articulo_id::text AND apc.precio_manual IS NOT NULL)`,
      [businessId, lote.map((a) => a.articulo_id), lote.map((a) => a.nombre), lote.map((a) => a.categoria),
        lote.map((a) => a.subrubro), lote.map((a) => a.precio), lote.map((a) => a.cod_rua), lote.map((a) => a.cod_sua),
        lote.map((a) => JSON.stringify(a.raw))]);
    if (nuevos.length) {
      await client.query(
        // Solo las columnas del DDL canónico (010_maxi_article_map.sql), como el botón manual.
        `INSERT INTO maxi_article_map (business_id, articulo_id, categoria, subrubro, updated_at)
         SELECT $1, t.id, t.cat, t.sub, now()
           FROM UNNEST($2::int[], $3::text[], $4::text[]) AS t(id, cat, sub)
         ON CONFLICT (business_id, articulo_id) DO NOTHING`,
        [businessId, nuevos.map((a) => a.articulo_id), nuevos.map((a) => a.categoria), nuevos.map((a) => a.subrubro)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  if (nuevos.length) {
    // Lo mismo que hace la API después de traer artículos nuevos. Ninguno corta la pasada.
    const { reconcileManualsAfterSync } = require('../manualReconciliation');
    const { applyArticuloGroupRules, autoAssignNewArticles } = require('../autoGroupAssignment');
    for (const [nombre, fn] of [['conciliar manuales', reconcileManualsAfterSync], ['reglas de rubro', applyArticuloGroupRules], ['auto-asignar', autoAssignNewArticles]]) {
      try { await fn(businessId); } catch (e) { console.warn(`[kit-maestros] ${businessId} ${nombre}:`, e.message); }
    }
  }
  return resumen;
}

async function aplicarInsumos(businessId, filasM0, { dryRun }) {
  const items = filasM0.map(insumoDesdeM0).filter(Boolean);
  const { rows } = await pool.query(
    `SELECT codigo_maxi FROM insumos WHERE business_id = $1 AND codigo_maxi IS NOT NULL`, [businessId]);
  const ya = new Set(rows.map((r) => String(r.codigo_maxi).trim()));
  const nuevos = items.filter((i) => !ya.has(i.codigo_maxi));
  const resumen = { nuevos: nuevos.length, ejemplosNuevos: nuevos.slice(0, 10).map((i) => `${i.codigo_maxi} ${i.nombre}`) };
  if (dryRun || !nuevos.length) return resumen;

  const { upsertFromMaxi } = require('../../repos/insumosRepo');
  const r = await upsertFromMaxi(businessId, nuevos);
  resumen.insertados = r.inserted;
  resumen.fusionados = r.reconciled;
  if (r.inserted > 0) {
    try {
      const { autoAssignNewInsumos } = require('../autoAssignNewInsumos');
      await autoAssignNewInsumos(businessId);
    } catch (e) { console.warn(`[kit-maestros] ${businessId} auto-asignar insumos:`, e.message); }
  }
  return resumen;
}

// ---------------------------------------------------------------- entrada

// Pasa los maestros de un esquema a cada negocio raíz que lo usa. dryRun: solo cuenta.
async function maestrosDeEsquema(esquema, { dryRun = false } = {}) {
  if (!RE_ESQUEMA.test(esquema)) throw new Error(`esquema inválido: ${esquema}`);
  const hay6 = await existeTabla(pool, esquema, M6);
  const hay0 = await existeTabla(pool, esquema, M0);
  const filasM6 = hay6 ? (await pool.query(`SELECT * FROM "${esquema}".${M6}`)).rows : [];
  const filasM0 = hay0 ? (await pool.query(`SELECT * FROM "${esquema}".${M0}`)).rows : [];
  const out = { esquema, dryRun, negocios: [] };
  for (const businessId of await destinosDeEsquema(esquema)) {
    const api = await tieneApiMaxi(pool, businessId);
    const r = { businessId, apiMaxi: api };
    try {
      if (hay6) r.articulos = await aplicarArticulos(businessId, filasM6, { dryRun, actualizar: !api });
      if (hay0) r.insumos = await aplicarInsumos(businessId, filasM0, { dryRun });
    } catch (e) {
      r.error = e.message;
      console.error(`[kit-maestros] ${esquema} → ${businessId}:`, e.message);
    }
    out.negocios.push(r);
  }
  return out;
}

// La pasada del reloj: solo los esquemas cuyo kit subió maestros después de la última aplicada.
async function maestrosDelReloj({ dryRun = false } = {}) {
  await refrescarPdvMap({ forzar: true });
  const esquemas = [...new Set(Object.values(PDV_MAP).map((v) => v.schema))].filter((e) => RE_ESQUEMA.test(e));
  const resultados = [];
  for (const esquema of esquemas) {
    const client = await pool.connect();
    let tomado = false;
    try {
      const { rows: l } = await client.query(`SELECT pg_try_advisory_lock(hashtext('kit-maestros:' || $1)) AS ok`, [esquema]);
      tomado = !!l[0]?.ok;
      if (!tomado) continue;
      const { rows: c } = await client.query(
        `SELECT MAX(cargado) AS c FROM "${esquema}"._cargas WHERE tabla IN ($1, $2)`, [M6, M0]).catch(() => ({ rows: [] }));
      const cargado = c[0]?.c || null;
      if (!cargado) continue;
      const { rows: a } = await client.query('SELECT cargado FROM kit_maestros_aplicados WHERE esquema = $1', [esquema]);
      if (!dryRun && a[0]?.cargado && new Date(a[0].cargado) >= new Date(cargado)) continue;
      const r = await maestrosDeEsquema(esquema, { dryRun });
      resultados.push(r);
      console.log(`[kit-maestros] ${esquema}${dryRun ? ' (prueba)' : ''}`, JSON.stringify(r.negocios.map((n) => ({
        negocio: n.businessId, api: n.apiMaxi, error: n.error,
        articulos: n.articulos && { nuevos: n.articulos.nuevos, cambian: n.articulos.cambian, saltado: n.articulos.saltado },
        insumos: n.insumos && { nuevos: n.insumos.nuevos },
      }))));
      if (!dryRun && !r.negocios.some((n) => n.error)) {
        await client.query(
          `INSERT INTO kit_maestros_aplicados (esquema, cargado, aplicado_en, resumen) VALUES ($1, $2, now(), $3)
           ON CONFLICT (esquema) DO UPDATE SET cargado = EXCLUDED.cargado, aplicado_en = now(), resumen = EXCLUDED.resumen`,
          [esquema, cargado, JSON.stringify(r)]);
      }
    } catch (e) {
      console.error(`[kit-maestros] ${esquema}:`, e?.message || e);
    } finally {
      if (tomado) await client.query(`SELECT pg_advisory_unlock(hashtext('kit-maestros:' || $1))`, [esquema]).catch(() => {});
      client.release();
    }
  }
  return resultados;
}

module.exports = { maestrosDelReloj, maestrosDeEsquema, articuloDesdeM6, insumoDesdeM0, elegirOrden };
