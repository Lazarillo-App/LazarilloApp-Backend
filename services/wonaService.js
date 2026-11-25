// services/wonaService.js
//
// Wona Sports (usuaria 25/11/2026): clubes con canchas y buffet (app.wonasports.com). Wona no publica
// una API; Lazarillo usa la misma que usa su página, con el usuario y la clave que el cliente carga en
// Configuración › Conexiones (el cliente lo autoriza). Reglas:
//  - SOLO lectura: login + pedidos GET. Nada sale de Lazarillo hacia Wona.
//  - Se presenta honestamente como «Lazarillo-conector» (User-Agent). No se disfraza de navegador.
//  - Un negocio de Lazarillo = una sede de Wona (tenant, header `tenant_uuid`).
//
// Qué se trae (relevado el 25/11 con la cuenta del cliente: Unifutbol, Unipadel, Zona Fútbol):
//  - Ventas al Panel de Resultados (gestion_ventas): el reporte /purchase/reports/sells por día y origen
//    (BUFFET, BOOKING = turnos, BOOKING_DEPOSIT = señas). Una fila por día y origen.
//  - Artículos (maxi_articles, origen 'wona'): los productos del buffet (nombre, grupo, costo, precio) y
//    un artículo por tipo de cancha («Turno Fútbol 5», «Turno Padel»).
//  - Ventas por artículo (sales_daily_items, source 'wona'): turnos válidos por día y tipo de cancha
//    (cantidad y precio) y unidades vendidas del buffet por día (inventario × precio).
//  - Compras: las cargas de stock (proveedor, factura, total; Wona no da el detalle) por el camino común
//    de compras de cualquier sistema (services/comprasExternas.js).
'use strict';

const pool = require('../config/db');
const { encryptSecret, decryptSecretCompat } = require('../utils/cryptoField');
const { rebuildSalesDailyRange } = require('./salesDailyRebuildService');

const API = 'https://api.wonasports.com';
const UA = 'Lazarillo-conector/1.0 (+https://lazarillo.com.ar)';
const SOURCE = 'wona';
const DIAS_HISTORIAL = 365;      // primera vez: un año de ventas al Panel y de turnos
const DIAS_DETALLE_BUFFET = 120; // primera vez: unidades del buffet por día (un pedido por día)
const DIAS_REPASO = 3;
const DIAS_COMPRAS = 365;
const DIAS_REPASO_COMPRAS = 30;
const ART_BASE = 800000000;      // números de artículo de Wona: fuera de MaxiRest y de Fudo
const TZ = 'America/Buenos_Aires';

const ORIGENES = {
  BUFFET: 'Buffet',
  BOOKING: 'Turnos',
  BOOKING_DEPOSIT: 'Señas de turnos',
  MEMBERSHIP: 'Cuotas',
  ENROLLMENT: 'Inscripciones',
  OTHER: 'Otros',
};
// Estados de reserva que no son un turno jugado/vendido.
const RESERVA_NO_VALIDA = /CANCEL|REMOVED|REJECT|EXPIRED/i;

const txt = (v) => (v == null ? '' : String(v).trim());
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
// El precio (numeric de Postgres) llega como texto «1500.00»: se compara como número, el resto como texto.
const mismoValor = (campo, a, b) => (campo === 'precio_ref' ? Math.abs(num(a) - num(b)) < 0.005 : txt(a) === txt(b));

// ───────────────────────── fechas (puras) ─────────────────────────

function sumarDias(dia, n) {
  return new Date(new Date(`${dia}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}
/** Hoy en Argentina (UTC-3, sin horario de verano). */
function hoyAr() {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}
/** Día YYYY-MM-DD de una columna DATE (node-pg la da como Date local). */
function diaDe(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}
/** Tramos de hasta `largo` días entre desde y hasta (inclusive). */
function tramos(desde, hasta, largo = 31) {
  const out = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, largo)) {
    const h = sumarDias(d, largo - 1);
    out.push([d, h < hasta ? h : hasta]);
  }
  return out;
}
/** Día local de un ISO en UTC (createdAt de Wona viene con Z). */
function diaLocalDeIso(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t - 3 * 3600_000).toISOString().slice(0, 10);
}

// ───────────────────────── traducciones (puras, testeadas) ─────────────────────────

/** Reporte de ventas por día y origen → filas de gestion_ventas (una por día y origen). */
function filasPanel(byTimeAndOrigin, tenantUuid) {
  const t8 = txt(tenantUuid).slice(0, 8);
  const filas = [];
  for (const p of byTimeAndOrigin || []) {
    const dia = txt(p.period).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;
    for (const o of p.byOrigin || []) {
      const total = Math.round(num(o.total) * 100) / 100;
      if (!total) continue;
      const origen = txt(o.origin).toUpperCase() || 'OTHER';
      const nombre = ORIGENES[origen] || origen;
      filas.push({
        rowId: `wona-${t8}-${dia}-${origen}`,
        comprobant: `Wona · ${nombre}`,
        hora: '12:00',
        tipo: nombre,
        cub: o.count == null ? null : String(o.count),
        cobro: null,
        codCobro: null,
        importe: total,
        total,
        descuento: 0,
        cliNombre: null,
        fecha: `${dia} 12:00:00`,
      });
    }
  }
  return filas;
}

/** Reservas → turnos válidos por día y tipo de cancha: Map 'día|cancha:<tipo>' → {qty, amount}. */
function turnosPorDia(reservas, tipoDeCancha) {
  const out = new Map();
  for (const r of reservas || []) {
    if (RESERVA_NO_VALIDA.test(txt(r.status))) continue;
    const dia = txt(r.reservationDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;
    const tipo = tipoDeCancha.get(r.installationUuid) || 'Cancha';
    const k = `${dia}|cancha:${tipo}`;
    const x = out.get(k) || { qty: 0, amount: 0 };
    x.qty += 1;
    x.amount += num(r.price);
    out.set(k, x);
  }
  return out;
}

/** Carga de stock de Wona → compra para comprasExternas.importarCompras. */
function compraDeCarga(c) {
  const total = Math.round(num(c.total) * 100) / 100;
  const fecha = diaLocalDeIso(c.createdAt);
  if (!fecha || !(total > 0) || c.deletedAt) return null;
  return {
    externoId: String(c.id),
    fecha,
    total,
    categoria: 'Mercadería buffet',
    comprobante: c.invoiceNumber != null ? String(c.invoiceNumber) : null,
    proveedor: { nombre: txt(c.providerName) || 'Proveedor de Wona' },
    renglones: [{ insumoId: null, nombre: 'Mercadería (carga de stock de Wona)', cantidad: 1, neto: total }],
  };
}

// ───────────────────────── cliente de la API ─────────────────────────

function expDeToken(token) {
  try {
    const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
    return p.exp ? new Date(p.exp * 1000) : null;
  } catch { return null; }
}

async function login(usuario, clave) {
  const r = await fetch(`${API}/manager/auth/login`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ user: usuario, password: clave, loginAdmin: true, deviceUuid: 'lazarillo-conector' }),
  });
  let j = null;
  try { j = await r.json(); } catch { /* respuesta no JSON (bloqueo o caída) */ }
  if (!j) { const e = new Error(`Wona no respondió (HTTP ${r.status})`); e.code = 'wona_caido'; throw e; }
  if (!j.success || !j.data?.token) { const e = new Error('Wona no aceptó el usuario o la clave'); e.code = 'wona_claves_invalidas'; throw e; }
  return { token: j.data.token, exp: expDeToken(j.data.token) };
}

/** Cliente de solo lectura para una sede. Renueva el token solo (login) si venció o Wona lo rechaza. */
function cliente({ usuario, clave, tenant, token = null, exp = null, alRenovar = null }) {
  let tok = token;
  let vence = exp ? new Date(exp) : null;
  const renovar = async () => {
    const t = await login(usuario, clave);
    tok = t.token; vence = t.exp;
    if (alRenovar) await alRenovar(t).catch(() => {});
  };
  const pedir = async (ruta, reintento = true) => {
    if (!tok || (vence && vence.getTime() - Date.now() < 5 * 60_000)) await renovar();
    const r = await fetch(API + ruta, {
      headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: `Bearer ${tok}`, tenant_uuid: tenant || '', 'x-timezone': TZ },
    });
    if ((r.status === 401 || r.status === 403) && reintento) { await renovar(); return pedir(ruta, false); }
    let j = null;
    try { j = await r.json(); } catch { /* nada */ }
    if (!r.ok || !j) { const e = new Error(`Wona ${r.status} en ${ruta.split('?')[0]}`); e.code = 'wona_error'; throw e; }
    return j;
  };
  return { get: pedir };
}

async function leerConexion(businessId) {
  const { rows } = await pool.query('SELECT * FROM integraciones_wona WHERE business_id = $1', [businessId]);
  return rows[0] || null;
}

function clienteDe(con) {
  return cliente({
    usuario: decryptSecretCompat(con.usuario),
    clave: decryptSecretCompat(con.clave),
    tenant: con.tenant_uuid,
    token: con.token ? decryptSecretCompat(con.token) : null,
    exp: con.token_exp,
    alRenovar: (t) => pool.query('UPDATE integraciones_wona SET token = $2, token_exp = $3, updated_at = now() WHERE business_id = $1',
      [con.business_id, encryptSecret(t.token), t.exp]),
  });
}

// ───────────────────────── productos y artículos ─────────────────────────

async function traerProductos(con, api) {
  const bid = con.business_id;
  const pr = await api.get('/products/reduced/presentations?type=ALL&PRODUCT=&page=1&qty=5000&orderBy=name&desc=false');
  const productos = (pr.data || []).filter((p) => p.presentationUuid && txt(p.presentationName));
  // Tipos de cancha (actividades) desde la grilla de hoy: uuid de cancha → tipo.
  const grid = await api.get(`/manager/grid?date=${hoyAr()}`);
  const canchas = grid.data?.installations || [];
  const tipoDeCancha = new Map(canchas.map((c) => [c.uuid, txt(c.type) || 'Cancha']));
  const tipos = [...new Set(canchas.map((c) => txt(c.type) || 'Cancha'))];

  const filas = [
    ...productos.map((p) => ({
      wona_id: p.presentationUuid, tipo: 'buffet', nombre: txt(p.presentationName).slice(0, 200),
      grupo: txt(p.groupName) || 'Buffet', subgrupo: txt(p.subGroupName) || null,
      costo: num(p.presentationCost), precio: num(p.presentationPrice),
      proveedor: (txt(p.providerName) || '').slice(0, 200), // '' = sin proveedor (se prepara): solo artículo
    })),
    ...tipos.map((t) => ({ wona_id: `cancha:${t}`, tipo: 'cancha', nombre: `Turno ${t}`, grupo: 'Canchas', subgrupo: t, costo: 0, precio: null, proveedor: null })),
  ];
  if (filas.length) {
    await pool.query(
      `INSERT INTO wona_productos AS w (business_id, wona_id, tipo, nombre, grupo, subgrupo, costo, precio, proveedor, visto_at)
       SELECT $1, * , now() FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::text[])
       ON CONFLICT (business_id, wona_id) DO UPDATE SET tipo = EXCLUDED.tipo, nombre = EXCLUDED.nombre, grupo = EXCLUDED.grupo,
         subgrupo = EXCLUDED.subgrupo, costo = EXCLUDED.costo, precio = COALESCE(EXCLUDED.precio, w.precio),
         proveedor = EXCLUDED.proveedor, visto_at = now()`,
      [bid, filas.map((f) => f.wona_id), filas.map((f) => f.tipo), filas.map((f) => f.nombre), filas.map((f) => f.grupo),
        filas.map((f) => f.subgrupo), filas.map((f) => f.costo), filas.map((f) => f.precio), filas.map((f) => f.proveedor)]);
  }
  return { productos: productos.length, canchas: canchas.length, tipos, tipoDeCancha };
}

/** Da número de artículo a lo que no tiene y crea/actualiza los artículos (mismas reglas que Fudo). */
async function aplicarArticulos(bid) {
  const { rows: sinNumero } = await pool.query('SELECT wona_id FROM wona_productos WHERE business_id = $1 AND articulo_id IS NULL ORDER BY tipo, nombre', [bid]);
  if (sinNumero.length) {
    const { rows: mx } = await pool.query(
      `SELECT GREATEST(COALESCE((SELECT MAX(articulo_id) FROM wona_productos WHERE business_id = $1), 0),
                       COALESCE((SELECT MAX(articulo_id) FROM maxi_articles WHERE business_id = $1 AND articulo_id >= $2), 0), $2) AS m`,
      [bid, ART_BASE]);
    let n = Number(mx[0].m);
    await pool.query(
      `UPDATE wona_productos w SET articulo_id = t.a FROM UNNEST($2::text[], $3::int[]) AS t(id, a)
        WHERE w.business_id = $1 AND w.wona_id = t.id`,
      [bid, sinNumero.map((r) => r.wona_id), sinNumero.map(() => { n += 1; return n; })]);
  }
  const { rows: prods } = await pool.query('SELECT * FROM wona_productos WHERE business_id = $1 AND articulo_id IS NOT NULL', [bid]);
  const { rows: existentes } = await pool.query('SELECT articulo_id FROM maxi_articles WHERE business_id = $1 AND articulo_id = ANY($2::int[])',
    [bid, prods.map((p) => p.articulo_id)]);
  const yaEstaban = new Set(existentes.map((e) => Number(e.articulo_id)));
  const nuevos = prods.filter((p) => !yaEstaban.has(Number(p.articulo_id)));
  const client = await pool.connect();
  let actualizados = 0;
  try {
    await client.query('BEGIN');
    if (prods.length) {
      const r = await client.query(
        `WITH d AS (
           SELECT * FROM UNNEST($2::bigint[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::numeric[], $8::jsonb[])
             AS t(articulo_id, nombre, categoria, subrubro, precio, costo, raw)
         )
         INSERT INTO maxi_articles (business_id, articulo_id, nombre, categoria, subrubro, precio, costo, raw, origen,
                                    nombre_maxi, categoria_maxi, subrubro_maxi, precio_maxi, updated_at)
         SELECT $1, articulo_id, nombre, categoria, subrubro, precio, costo, raw, 'wona', nombre, categoria, subrubro, precio, NOW() FROM d
         ON CONFLICT (business_id, articulo_id) DO UPDATE SET
           precio = CASE WHEN maxi_articles.precio IS DISTINCT FROM maxi_articles.precio_maxi THEN maxi_articles.precio ELSE EXCLUDED.precio END,
           nombre = CASE WHEN maxi_articles.nombre IS DISTINCT FROM maxi_articles.nombre_maxi THEN maxi_articles.nombre ELSE EXCLUDED.nombre END,
           categoria = CASE WHEN maxi_articles.categoria IS DISTINCT FROM maxi_articles.categoria_maxi THEN maxi_articles.categoria ELSE EXCLUDED.categoria END,
           subrubro = CASE WHEN maxi_articles.subrubro IS DISTINCT FROM maxi_articles.subrubro_maxi THEN maxi_articles.subrubro ELSE EXCLUDED.subrubro END,
           costo = EXCLUDED.costo,
           precio_maxi = EXCLUDED.precio, nombre_maxi = EXCLUDED.nombre,
           categoria_maxi = EXCLUDED.categoria, subrubro_maxi = EXCLUDED.subrubro, updated_at = NOW()
         WHERE maxi_articles.origen = 'wona'
           AND (maxi_articles.nombre_maxi, maxi_articles.precio_maxi, maxi_articles.categoria_maxi, maxi_articles.subrubro_maxi, maxi_articles.costo)
               IS DISTINCT FROM (EXCLUDED.nombre, EXCLUDED.precio, EXCLUDED.categoria, EXCLUDED.subrubro, EXCLUDED.costo)
           AND NOT EXISTS (SELECT 1 FROM article_price_config apc
                            WHERE apc.business_id = maxi_articles.business_id AND apc.scope = 'articulo'
                              AND apc.scope_id = maxi_articles.articulo_id::text AND apc.precio_manual IS NOT NULL)
         RETURNING (xmax = 0) AS nuevo`,
        [bid, prods.map((p) => p.articulo_id), prods.map((p) => p.nombre), prods.map((p) => p.grupo || 'Sin rubro'),
          prods.map((p) => p.subgrupo || 'Sin subrubro'), prods.map((p) => num(p.precio)), prods.map((p) => num(p.costo)),
          prods.map((p) => JSON.stringify({ wona_id: p.wona_id, tipo: p.tipo, _source: 'wona' }))]);
      actualizados = r.rows.filter((x) => !x.nuevo).length;
    }
    if (nuevos.length) {
      await client.query(
        `INSERT INTO maxi_article_map (business_id, articulo_id, categoria, subrubro, updated_at)
         SELECT $1, t.id, t.cat, t.sub, now() FROM UNNEST($2::int[], $3::text[], $4::text[]) AS t(id, cat, sub)
         ON CONFLICT (business_id, articulo_id) DO NOTHING`,
        [bid, nuevos.map((p) => p.articulo_id), nuevos.map((p) => p.grupo || 'Sin rubro'), nuevos.map((p) => p.subgrupo || 'Sin subrubro')]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (nuevos.length) {
    const { applyArticuloGroupRules, autoAssignNewArticles } = require('./autoGroupAssignment');
    for (const [n, fn] of [['reglas de rubro', applyArticuloGroupRules], ['auto-asignar', autoAssignNewArticles]]) {
      try { await fn(bid); } catch (e) { console.warn(`[wona] ${bid} ${n}:`, e.message); }
    }
  }
  return { nuevos: nuevos.length, actualizados };
}

// ───────────────────────── insumos y recetas del buffet ─────────────────────────

const normalizar = (x) => txt(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Código del rubro de insumo con ese nombre (lo crea si falta). */
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

/**
 * Un insumo por producto del buffet (lo que se revende es artículo e insumo a la vez): unidad «u», rubro =
 * grupo de Wona, precio = costo de Wona. Si ya hay un insumo con el mismo nombre en Lazarillo, se usa ese.
 * Cambios posteriores de Wona pasan campo por campo solo si nadie lo editó en Lazarillo (insumo_aplicado);
 * el precio también: si llega una compra que lo cambia, Wona deja de tocarlo.
 */
async function aplicarInsumos(bid) {
  const { rows: prods } = await pool.query(
    `SELECT * FROM wona_productos WHERE business_id = $1 AND tipo = 'buffet' AND articulo_id IS NOT NULL
        AND COALESCE(proveedor, '') <> '' ORDER BY nombre`, [bid]); // solo lo que se compra y se revende (25/11/2026)
  if (!prods.length) return { nuevos: 0, vinculados: 0, actualizados: 0, tocados: [] };
  const client = await pool.connect();
  let nuevos = 0, vinculados = 0, actualizados = 0;
  const tocados = new Set();
  const rubros = new Map();
  try {
    await client.query('BEGIN');
    const { rows: existentes } = await client.query(
      "SELECT id, nombre, codigo_maxi, unidad_med, rubro, precio_ref FROM insumos WHERE business_id = $1 AND estado = 'activo'", [bid]);
    const porId = new Map(existentes.map((e) => [Number(e.id), e]));
    const porNombre = new Map();
    for (const e of existentes) {
      const k = normalizar(e.nombre);
      if (k) porNombre.set(k, porNombre.has(k) ? null : Number(e.id));
    }
    const { rows: usados } = await client.query('SELECT codigo_maxi FROM insumos WHERE business_id = $1 AND codigo_maxi IS NOT NULL', [bid]);
    const codigos = new Set(usados.map((e) => txt(e.codigo_maxi)).filter(Boolean));
    const tomados = new Set(prods.filter((p) => p.insumo_id != null).map((p) => Number(p.insumo_id)));

    for (const p of prods) {
      const rubro = String(await codigoDeRubro(client, bid, p.grupo || 'Buffet', rubros));
      const costo = num(p.costo) > 0 ? num(p.costo) : null;
      const quiere = { nombre: p.nombre, unidad_med: 'u', rubro, precio_ref: costo };
      let insumoId = p.insumo_id != null ? Number(p.insumo_id) : null;
      const aplicado = p.insumo_aplicado || {};
      if (insumoId != null && porId.has(insumoId)) {
        const actual = porId.get(insumoId);
        const sets = [];
        const vals = [];
        for (const [campo, valor] of Object.entries(quiere)) {
          if (valor == null || mismoValor(campo, actual[campo], valor)) continue;
          if (aplicado[campo] !== undefined && !mismoValor(campo, actual[campo], aplicado[campo])) continue; // editado en Lazarillo
          vals.push(valor);
          sets.push(`${campo} = $${vals.length + 2}`);
        }
        if (sets.length) {
          await client.query(`UPDATE insumos SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1 AND business_id = $2`, [insumoId, bid, ...vals]);
          actualizados++;
          if (sets.some((x) => x.startsWith('precio_ref'))) tocados.add(insumoId);
        }
      } else {
        const igual = porNombre.get(normalizar(p.nombre));
        if (igual != null && !tomados.has(igual)) {
          insumoId = igual; // ya existía en Lazarillo: lo de Lazarillo gana
          vinculados++;
        } else {
          const codigo = codigos.has(String(p.articulo_id)) ? null : String(p.articulo_id);
          const { rows } = await client.query(
            `INSERT INTO insumos (business_id, codigo_maxi, nombre, unidad_med, precio_ref, rubro, origen, estado, sin_equivalencia)
             VALUES ($1, $2, $3, 'u', $4, $5, 'wona', 'activo', false) RETURNING id`,
            [bid, codigo, p.nombre, costo, rubro]);
          insumoId = Number(rows[0].id);
          if (codigo) codigos.add(codigo);
          nuevos++;
          tocados.add(insumoId);
        }
        tomados.add(insumoId);
      }
      await client.query('UPDATE wona_productos SET insumo_id = $3, insumo_aplicado = $4 WHERE business_id = $1 AND wona_id = $2',
        [bid, p.wona_id, insumoId, JSON.stringify(quiere)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (nuevos) {
    try { await require('./autoAssignNewInsumos').autoAssignNewInsumos(bid); } catch (e) { console.warn(`[wona] ${bid} auto-asignar insumos:`, e.message); }
  }
  return { nuevos, vinculados, actualizados, tocados: [...tocados] };
}

/**
 * Productos del buffet SIN proveedor en Wona (se preparan: WRAPS, tostados) que ya tenían insumo y receta automáticos
 * de antes de la regla del 25/11/2026:
 * - la receta automática (origen 'wona', un único renglón = 1 u de ese insumo) se borra;
 * - el insumo, si lo creó Wona, nadie lo editó en Lazarillo y ninguna otra receta lo usa, queda discontinuado
 *   (igual que «Eliminar» en Insumos); si no, queda como está y solo se desvincula del producto.
 * Si la receta del artículo se editó en Lazarillo (más renglones u otro insumo), no se toca nada.
 */
async function quitarInsumosSinProveedor(bid) {
  const { rows: prods } = await pool.query(
    `SELECT w.wona_id, w.articulo_id, w.insumo_id, w.insumo_aplicado, i.origen, i.estado, i.nombre, i.unidad_med, i.rubro, i.precio_ref
       FROM wona_productos w JOIN insumos i ON i.id = w.insumo_id
      WHERE w.business_id = $1 AND w.tipo = 'buffet' AND w.proveedor = '' AND w.insumo_id IS NOT NULL`, [bid]);
  const r = { recetasBorradas: 0, insumosBaja: 0, desvinculados: 0, conservados: 0 };
  if (!prods.length) return r;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of prods) {
      const insumoId = Number(p.insumo_id);
      const { rows: rec } = await client.query(
        `SELECT r.id, r.origen, COUNT(ri.id)::int AS n, BOOL_AND(ri.insumo_id = $3 AND ri.cantidad = 1) AS es_auto
           FROM recetas r LEFT JOIN receta_items ri ON ri.receta_id = r.id
          WHERE r.business_id = $1 AND r.article_id = $2
          GROUP BY r.id, r.origen`, [bid, Number(p.articulo_id), insumoId]);
      const receta = rec[0];
      const recetaAuto = receta && receta.origen === 'wona' && receta.n === 1 && receta.es_auto;
      if (receta && !recetaAuto && receta.origen === 'wona') { r.conservados++; continue; } // editada en Lazarillo
      if (recetaAuto) {
        await client.query('DELETE FROM receta_items WHERE receta_id = $1', [receta.id]);
        await client.query('DELETE FROM recetas WHERE id = $1 AND business_id = $2', [receta.id, bid]);
        r.recetasBorradas++;
      }
      const { rows: otras } = await client.query('SELECT 1 FROM receta_items WHERE insumo_id = $1 LIMIT 1', [insumoId]);
      const aplicado = p.insumo_aplicado || {};
      const editado = ['nombre', 'unidad_med', 'rubro', 'precio_ref']
        .some((c) => aplicado[c] !== undefined && !mismoValor(c, p[c], aplicado[c]));
      if (p.origen === 'wona' && p.estado === 'activo' && !editado && !otras.length) {
        await client.query(`UPDATE insumos SET estado = 'discontinuado', updated_at = NOW() WHERE id = $1 AND business_id = $2`, [insumoId, bid]);
        r.insumosBaja++;
      } else {
        r.desvinculados++;
      }
      await client.query(`UPDATE wona_productos SET insumo_id = NULL, insumo_aplicado = '{}'::jsonb WHERE business_id = $1 AND wona_id = $2`,
        [bid, p.wona_id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return r;
}

/** Receta de cada artículo del buffet = 1 u de su insumo. Solo si el artículo no tiene receta. */
async function aplicarRecetas(bid, tocados = []) {
  const { rows: prods } = await pool.query(
    `SELECT w.articulo_id, w.insumo_id, w.nombre, i.codigo_maxi
       FROM wona_productos w JOIN insumos i ON i.id = w.insumo_id
      WHERE w.business_id = $1 AND w.tipo = 'buffet' AND w.articulo_id IS NOT NULL AND w.insumo_id IS NOT NULL
        AND COALESCE(w.proveedor, '') <> ''`, [bid]);
  const { propagarCostoInsumo } = require('./costoRecetaService');
  let nuevas = 0;
  const recalcular = new Set(tocados.map(Number));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of prods) {
      const { rows } = await client.query(
        `INSERT INTO recetas (article_id, business_id, nombre, descripcion, porciones, porcentaje_venta, costo_total, active, origen, created_at, updated_at)
         SELECT $1, $2, nombre, '', 1, 0, 0, TRUE, 'wona', NOW(), NOW() FROM maxi_articles WHERE business_id = $2 AND articulo_id = $1
         ON CONFLICT (article_id, business_id) DO NOTHING RETURNING id`, [Number(p.articulo_id), bid]);
      if (!rows[0]) continue; // ya tenía receta (de Wona o hecha en Lazarillo): no se toca
      await client.query(
        `INSERT INTO receta_items (receta_id, insumo_id, codigo_maxi_insumo, nombre_insumo_maxi, cantidad, unidad, costo_unitario, orden, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 1, 'u', 0, 0, NOW(), NOW())`,
        [rows[0].id, Number(p.insumo_id), p.codigo_maxi || null, p.nombre]);
      recalcular.add(Number(p.insumo_id));
      nuevas++;
    }
    // Costo de cada renglón desde el precio del insumo y recálculo de las recetas que lo usan.
    for (const id of recalcular) await propagarCostoInsumo(id, bid, client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { nuevas, recalculadas: recalcular.size };
}

// ───────────────────────── ventas ─────────────────────────

/** Ventas por día y origen al Panel de Resultados (gestion_ventas). */
async function traerVentasPanel(con, api, desde, hasta) {
  const bid = con.business_id;
  let filasTot = 0;
  let total = 0;
  for (const [d, h] of tramos(desde, hasta, 31)) {
    const j = await api.get(`/purchase/reports/sells?startDate=${d}&endDate=${encodeURIComponent(`${h} 23:59:59`)}&range=days`);
    const filas = filasPanel(j.data?.byTimeAndOrigin, con.tenant_uuid);
    filasTot += filas.length;
    total += filas.reduce((s, f) => s + f.importe, 0);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM gestion_ventas WHERE business_id = $1 AND "rowId" LIKE 'wona-%'
           AND fecha >= $2::date AND fecha < $3::date + 1 AND NOT ("rowId" = ANY($4::text[]))`,
        [bid, d, h, filas.map((f) => f.rowId)]);
      if (filas.length) {
        await client.query(
          `INSERT INTO gestion_ventas (business_id, branch_id, "rowId", comprobant, hora, tipo, cub, cobro, "codCobro",
                                      importe, "importeTrabajado", total, descuento, "cliNombre", fecha)
           SELECT $1, $2::bigint, t."rowId", t.comprobant, t.hora, t.tipo, t.cub, t.cobro, t."codCobro",
                  t.importe, t.importe, t.total, t.descuento, t."cliNombre", t.fecha
             FROM UNNEST($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                         $10::numeric[], $11::numeric[], $12::numeric[], $13::text[], $14::timestamp[])
               AS t("rowId", comprobant, hora, tipo, cub, cobro, "codCobro", importe, total, descuento, "cliNombre", fecha)
           ON CONFLICT (business_id, "rowId") DO UPDATE SET
             comprobant = EXCLUDED.comprobant, hora = EXCLUDED.hora, tipo = EXCLUDED.tipo, cub = EXCLUDED.cub,
             importe = EXCLUDED.importe, total = EXCLUDED.total, fecha = EXCLUDED.fecha`,
          [bid, con.branch_id ?? null, filas.map((f) => f.rowId), filas.map((f) => f.comprobant), filas.map((f) => f.hora),
            filas.map((f) => f.tipo), filas.map((f) => f.cub), filas.map((f) => f.cobro), filas.map((f) => f.codCobro),
            filas.map((f) => f.importe), filas.map((f) => f.total), filas.map((f) => f.descuento), filas.map((f) => f.cliNombre),
            filas.map((f) => f.fecha)]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return { filas: filasTot, total: Math.round(total) };
}

/** Guarda en wona_ventas_dia (reemplaza lo de esos días y ese tipo). filas: [{day, wona_id, qty, amount}] */
async function guardarVentasDia(bid, dias, prefijo, filas) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM wona_ventas_dia WHERE business_id = $1 AND day = ANY($2::date[])
         AND (($3::text = 'cancha' AND wona_id LIKE 'cancha:%') OR ($3::text = 'buffet' AND wona_id NOT LIKE 'cancha:%'))`,
      [bid, dias, prefijo]);
    if (filas.length) {
      await client.query(
        `INSERT INTO wona_ventas_dia (business_id, day, wona_id, qty, amount)
         SELECT $1, * FROM UNNEST($2::date[], $3::text[], $4::numeric[], $5::numeric[])
         ON CONFLICT (business_id, day, wona_id) DO UPDATE SET qty = EXCLUDED.qty, amount = EXCLUDED.amount, traida_at = now()`,
        [bid, filas.map((f) => f.day), filas.map((f) => f.wona_id), filas.map((f) => f.qty), filas.map((f) => f.amount)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Turnos válidos por día y tipo de cancha. */
async function traerTurnos(con, api, desde, hasta, tipoDeCancha) {
  const bid = con.business_id;
  let turnos = 0;
  for (const [d, h] of tramos(desde, hasta, 31)) {
    const j = await api.get(`/reservations/filtered?startDate=${d}&endDate=${h}&fixedCache=1&fields=dashboard`);
    const mapa = turnosPorDia(j.data?.reservations, tipoDeCancha);
    const filas = [...mapa].map(([k, v]) => { const [day, wona_id] = k.split('|'); return { day, wona_id, qty: v.qty, amount: Math.round(v.amount * 100) / 100 }; });
    turnos += filas.reduce((s, f) => s + f.qty, 0);
    await guardarVentasDia(bid, tramos(d, h, 1).map(([x]) => x), 'cancha', filas);
  }
  return { turnos };
}

/** Unidades del buffet por día (inventario de un día = lo vendido ese día). */
async function traerBuffet(con, api, desde, hasta) {
  const bid = con.business_id;
  const { rows } = await pool.query("SELECT wona_id, precio FROM wona_productos WHERE business_id = $1 AND tipo = 'buffet'", [bid]);
  if (!rows.length) return { dias: 0, unidades: 0 };
  const precio = new Map(rows.map((r) => [r.wona_id, num(r.precio)]));
  let unidades = 0;
  let dias = 0;
  for (const [dia] of tramos(desde, hasta, 1)) {
    // La fecha de fin va con la hora: con solo el día, Wona devuelve 0 vendidos (verificado 25/11).
    const j = await api.get(`/products/inventory?startDate=${dia}&endDate=${encodeURIComponent(`${dia} 23:59:59`)}&type=PRODUCT&search=&page=1&qty=5000`);
    const filas = (j.data || []).filter((x) => num(x.sells) > 0 && precio.has(x.itemUuid))
      .map((x) => ({ day: dia, wona_id: x.itemUuid, qty: num(x.sells), amount: Math.round(num(x.sells) * precio.get(x.itemUuid) * 100) / 100 }));
    unidades += filas.reduce((s, f) => s + f.qty, 0);
    dias += 1;
    await guardarVentasDia(bid, [dia], 'buffet', filas);
  }
  return { dias, unidades };
}

/** wona_ventas_dia → sales_daily_items (source 'wona'); Wona manda sobre csv/maxi/fudo esos días. */
async function volcar(con, dias) {
  if (!dias?.length) return { filas: 0 };
  const bid = con.business_id;
  const branchId = con.branch_id ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT v.day::text AS day, p.articulo_id, MAX(COALESCE(ma.nombre, p.nombre)) AS nombre, SUM(v.qty) AS qty, SUM(v.amount) AS amount
         FROM wona_ventas_dia v
         JOIN wona_productos p ON p.business_id = v.business_id AND p.wona_id = v.wona_id AND p.articulo_id IS NOT NULL
         LEFT JOIN maxi_articles ma ON ma.business_id = v.business_id AND ma.articulo_id = p.articulo_id
        WHERE v.business_id = $1 AND v.day = ANY($2::date[])
        GROUP BY v.day, p.articulo_id`,
      [bid, dias]);
    const conVentas = [...new Set(rows.map((r) => r.day))];
    await client.query(
      `DELETE FROM sales_daily_items
        WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $3::bigint
          AND (source IN ('csv','maxi','fudo','wona') AND day = ANY($2::date[]) OR source = 'wona' AND day = ANY($4::date[]))`,
      [bid, conVentas, branchId, dias]);
    if (rows.length) {
      await client.query(
        `INSERT INTO sales_daily_items (business_id, branch_id, day, article_id, article_name, qty, amount, source)
         SELECT $1, $2::bigint, day, article_id, article_name, qty, amount, '${SOURCE}'
           FROM UNNEST($3::date[], $4::int[], $5::text[], $6::numeric[], $7::numeric[])
             AS t(day, article_id, article_name, qty, amount)`,
        [bid, branchId, rows.map((r) => r.day), rows.map((r) => r.articulo_id), rows.map((r) => r.nombre),
          rows.map((r) => r.qty), rows.map((r) => r.amount)]);
    }
    const orden = [...dias].sort();
    await rebuildSalesDailyRange({ businessId: bid, from: orden[0], to: orden[orden.length - 1], client });
    await client.query('COMMIT');
    return { filas: rows.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Precio de lista de los turnos: el promedio de los últimos 30 días de turnos válidos. */
async function precioDeTurnos(bid) {
  await pool.query(
    `UPDATE wona_productos p SET precio = s.prom
       FROM (SELECT wona_id, ROUND(SUM(amount) / NULLIF(SUM(qty), 0), 2) AS prom
               FROM wona_ventas_dia WHERE business_id = $1 AND wona_id LIKE 'cancha:%' AND day >= CURRENT_DATE - 30
              GROUP BY wona_id) s
      WHERE p.business_id = $1 AND p.wona_id = s.wona_id AND s.prom > 0`, [bid]);
}

// ───────────────────────── compras ─────────────────────────

async function traerCompras(con, api, hoy) {
  const bid = con.business_id;
  const guardado = diaDe(con.compras_hasta);
  const desde = guardado ? sumarDias(guardado, -DIAS_REPASO_COMPRAS) : sumarDias(hoy, -DIAS_COMPRAS);
  const j = await api.get(`/products/tenant/tenantUuid/stock-loads?deleted=false&startDate=${desde}&endDate=${hoy}`);
  const compras = (j.data || []).map(compraDeCarga).filter(Boolean);
  const r = await require('./comprasExternas').importarCompras({ businessId: bid, branchId: con.branch_id ?? null, origen: 'wona', compras });
  await pool.query('UPDATE integraciones_wona SET compras_hasta = $2 WHERE business_id = $1', [bid, hoy]);
  return { traidas: compras.length, nuevas: r.nuevas, salteadas: r.repetidas, errores: r.errores, sinConcepto: r.sinConcepto };
}

// ───────────────────────── avisos ─────────────────────────

function avisar(businessId, args) {
  const { avisarAlEquipo } = require('./notificationService');
  return avisarAlEquipo({ businessId, ...args }).catch((e) => console.error('[wona] aviso', businessId, e.message));
}

// ───────────────────────── sincronizar ─────────────────────────

const enCurso = new Set();
const TRAER_DEFAULT = { ventas: true, articulos: true, insumos: true, compras: true };
function normalizarTraer(t) {
  const o = { ...TRAER_DEFAULT };
  if (t && typeof t === 'object') for (const k of ['articulos', 'insumos', 'compras']) if (k in t) o[k] = !!t[k];
  o.ventas = true;
  return o;
}

async function sincronizar(businessId, { desde = null, hasta = null, origen = 'manual' } = {}) {
  const bid = Number(businessId);
  if (enCurso.has(bid)) return { ok: false, error: 'wona_en_curso' };
  const con = await leerConexion(bid);
  if (!con) return { ok: false, error: 'wona_no_conectado' };
  enCurso.add(bid);
  try {
    const api = clienteDe(con);
    const traer = normalizarTraer(con.traer);
    const hoy = hoyAr();
    const ayer = sumarDias(hoy, -1);
    const h = hasta || (origen === 'cron' ? ayer : hoy);
    const guardado = diaDe(con.ventas_hasta);
    const d = desde || (guardado ? sumarDias(guardado, -DIAS_REPASO) : sumarDias(ayer, -DIAS_HISTORIAL));
    const dBuffet = desde || (guardado ? d : sumarDias(h, -DIAS_DETALLE_BUFFET));

    const productos = await traerProductos(con, api);
    const articulos = traer.articulos ? await aplicarArticulos(bid) : null;
    const panel = await traerVentasPanel(con, api, d, h);
    const turnos = await traerTurnos(con, api, d, h, productos.tipoDeCancha);
    const buffet = await traerBuffet(con, api, dBuffet < d ? d : dBuffet, h);
    await precioDeTurnos(bid);
    if (traer.articulos) await aplicarArticulos(bid); // con el precio de los turnos ya calculado
    let insumos = null;
    let recetas = null;
    if (traer.articulos && traer.insumos) {
      try {
        const sinProveedor = await quitarInsumosSinProveedor(bid);
        insumos = await aplicarInsumos(bid);
        recetas = await aplicarRecetas(bid, insumos.tocados);
        delete insumos.tocados;
        insumos.sinProveedor = sinProveedor;
      } catch (e) { console.error(`[wona] negocio ${bid} insumos/recetas:`, e.message); insumos = { error: e.message }; }
    }
    const volcado = await volcar(con, tramos(d, h, 1).map(([x]) => x));
    let compras = null;
    if (traer.compras) {
      try { compras = await traerCompras(con, api, hoy); } catch (e) { console.error(`[wona] negocio ${bid} compras:`, e.message); compras = { error: e.message }; }
    }
    const resumen = { desde: d, hasta: h, productos: productos.productos, canchas: productos.canchas, articulos, insumos, recetas, panel, turnos, buffet, compras, filas: volcado.filas };
    await pool.query(
      `UPDATE integraciones_wona SET ultimo_sync_at = now(), ultimo_sync_error = NULL, ultimo_resumen = $3,
              ventas_hasta = GREATEST(COALESCE(ventas_hasta, $2::date), $2::date), updated_at = now()
        WHERE business_id = $1`,
      [bid, h < ayer ? h : ayer, JSON.stringify(resumen)]);
    if (origen !== 'cron' || articulos?.nuevos || compras?.nuevas) {
      const partes = [];
      if (articulos?.nuevos) partes.push(`${articulos.nuevos} artículo${articulos.nuevos === 1 ? '' : 's'} nuevo${articulos.nuevos === 1 ? '' : 's'}`);
      if (turnos.turnos) partes.push(`${turnos.turnos} turnos`);
      if (insumos?.nuevos) partes.push(`${insumos.nuevos} insumo${insumos.nuevos === 1 ? '' : 's'} del buffet con su receta`);
      if (compras?.nuevas) partes.push(`${compras.nuevas} compra${compras.nuevas === 1 ? '' : 's'} nueva${compras.nuevas === 1 ? '' : 's'}`);
      await avisar(bid, {
        type: 'wona_sincronizado',
        title: `Llegaron datos de Wona (${con.tenant_nombre || 'sede'})`,
        message: `Ventas del ${d.split('-').reverse().join('/')} al ${h.split('-').reverse().join('/')}${partes.length ? `: ${partes.join(', ')}` : ''}.`,
        metadata: { resumen },
        clave: `wona_sync:${bid}`,
        agruparMin: 60,
      });
    }
    console.log(`[wona] negocio ${bid} (${origen}): ${d}..${h} panel=${panel.filas} turnos=${turnos.turnos} buffet=${buffet.unidades}u filas=${volcado.filas}`);
    return { ok: true, ...resumen };
  } catch (e) {
    await pool.query('UPDATE integraciones_wona SET ultimo_sync_at = now(), ultimo_sync_error = $2, updated_at = now() WHERE business_id = $1',
      [bid, String(e.message).slice(0, 500)]).catch(() => {});
    if (e.code === 'wona_claves_invalidas') {
      await avisar(bid, {
        type: 'wona_vencido',
        title: 'La conexión con Wona dejó de funcionar',
        message: 'Wona no acepta el usuario o la clave guardados (¿se cambió la clave?). Volvé a conectarla en Configuración › Conexiones.',
        clave: `wona_vencido:${bid}`,
        agruparMin: 24 * 60,
      });
      return { ok: false, error: 'wona_vencido' };
    }
    throw e;
  } finally {
    enCurso.delete(bid);
  }
}

// ───────────────────────── lo que usan las rutas ─────────────────────────

/** Con usuario y clave: las sedes de esa cuenta (para elegir cuál va a este negocio). No guarda nada. */
async function sedes({ usuario, clave }) {
  const u = txt(usuario);
  const c = String(clave || '');
  if (!u || !c) return { error: 'faltan_datos' };
  let t;
  try { t = await login(u, c); } catch (e) {
    return e.code === 'wona_claves_invalidas'
      ? { error: 'wona_claves_invalidas', message: 'Wona no aceptó ese usuario o clave.' }
      : { error: 'wona_caido', message: 'No pude hablar con Wona. Probá de nuevo en unos minutos.' };
  }
  const api = cliente({ usuario: u, clave: c, tenant: '', token: t.token, exp: t.exp });
  const j = await api.get('/manager/my-tenants');
  return { ok: true, sedes: (j.data?.tenants || []).map((x) => ({ uuid: x.uuid, nombre: txt(x.name), razon: txt(x.businessName) })) };
}

async function estado(businessId) {
  const con = await leerConexion(businessId);
  if (!con) return { conectado: false };
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE tipo = 'buffet')::int AS productos, COUNT(*) FILTER (WHERE tipo = 'cancha')::int AS tipos_cancha
       FROM wona_productos WHERE business_id = $1`, [businessId]);
  return {
    conectado: true,
    sede: con.tenant_nombre,
    branch_id: con.branch_id,
    conectado_at: con.conectado_at,
    ventas_hasta: diaDe(con.ventas_hasta),
    ultimo_sync_at: con.ultimo_sync_at,
    ultimo_sync_error: con.ultimo_sync_error,
    ultimo_resumen: con.ultimo_resumen,
    sincronizando: enCurso.has(Number(businessId)),
    traer: normalizarTraer(con.traer),
    ...rows[0],
  };
}

async function conectar(businessId, userId, { usuario, clave, tenantUuid, branchId = null, traer = null } = {}) {
  const u = txt(usuario);
  const c = String(clave || '');
  const tenant = txt(tenantUuid);
  if (!u || !c || !tenant) return { error: 'faltan_datos' };
  if (u.length > 200 || c.length > 200) return { error: 'datos_invalidos' };
  const lista = await sedes({ usuario: u, clave: c });
  if (lista.error) return lista;
  const sede = lista.sedes.find((s) => s.uuid === tenant);
  if (!sede) return { error: 'sede_invalida', message: 'Esa sede no es de esta cuenta de Wona.' };
  const branch = branchId == null || branchId === '' ? null : Number(branchId);
  if (branch != null) {
    const { rows } = await pool.query('SELECT 1 FROM app_branches WHERE id = $1 AND business_id = $2', [branch, businessId]);
    if (!rows[0]) return { error: 'sucursal_invalida' };
  }
  const { rows: previa } = await pool.query('SELECT 1 FROM integraciones_wona WHERE business_id = $1', [businessId]);
  await pool.query(
    `INSERT INTO integraciones_wona (business_id, branch_id, usuario, clave, tenant_uuid, tenant_nombre, token, token_exp,
                                     traer, conectado_por, conectado_at, ultimo_sync_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, $8, now(), NULL, now())
     ON CONFLICT (business_id) DO UPDATE SET
       branch_id = EXCLUDED.branch_id, usuario = EXCLUDED.usuario, clave = EXCLUDED.clave, tenant_uuid = EXCLUDED.tenant_uuid,
       tenant_nombre = EXCLUDED.tenant_nombre, token = NULL, token_exp = NULL, traer = EXCLUDED.traer,
       conectado_por = EXCLUDED.conectado_por, conectado_at = now(), ultimo_sync_error = NULL, updated_at = now()`,
    [businessId, branch, encryptSecret(u), encryptSecret(c), tenant, sede.nombre, JSON.stringify(normalizarTraer(traer)), userId || null]);
  await avisar(businessId, {
    actorUserId: userId,
    type: 'wona_conectado',
    title: previa[0] ? `Se volvió a conectar Wona (${sede.nombre})` : `Se conectó Wona (${sede.nombre})`,
    message: 'Lazarillo trae de Wona las ventas, los turnos, los productos del buffet y las compras todas las noches. La primera vez trae el último año.',
  });
  setImmediate(() => {
    sincronizar(businessId, { origen: 'conexion' }).catch((e) => console.error('[wona] primera carga', businessId, e.message));
  });
  return { ok: true, conectado: true, sede: sede.nombre };
}

async function desconectar(businessId, userId) {
  const { rows } = await pool.query('DELETE FROM integraciones_wona WHERE business_id = $1 RETURNING tenant_nombre', [businessId]);
  if (!rows[0]) return { error: 'wona_no_conectado' };
  await avisar(businessId, {
    actorUserId: userId,
    type: 'wona_desconectado',
    title: 'Se desconectó Wona',
    message: 'Lazarillo dejó de traer los datos de Wona. Lo que ya estaba cargado queda.',
  });
  return { ok: true };
}

/** Cron: todas las conexiones, una por una. */
async function corridaDiaria() {
  const { rows } = await pool.query('SELECT business_id FROM integraciones_wona ORDER BY business_id');
  for (const r of rows) {
    try { await sincronizar(r.business_id, { origen: 'cron' }); } catch (e) { console.error('[wona] corrida diaria', r.business_id, e.message); }
  }
  return { negocios: rows.length };
}

module.exports = {
  sedes, estado, conectar, desconectar, sincronizar, corridaDiaria,
  // para tests y scripts
  _filasPanel: filasPanel, _turnosPorDia: turnosPorDia, _compraDeCarga: compraDeCarga, _tramos: tramos,
  _sumarDias: sumarDias, _diaLocalDeIso: diaLocalDeIso, _normalizarTraer: normalizarTraer, _cliente: cliente, _login: login,
};
