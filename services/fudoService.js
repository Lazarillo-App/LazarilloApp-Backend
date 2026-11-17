// services/fudoService.js
//
// Fudo por su API oficial (usuaria 17/11/2026, spec: https://api.fu.do/v1alpha1/openapi.yml).
// De Fudo se traen SOLO ventas (regla multi-POS de la Guía) y nada sale de Lazarillo: la API de Fudo
// es de solo lectura y acá solo hay pedidos GET. El apiKey/apiSecret del cliente sirve únicamente para
// pedir el token (POST https://auth.fu.do/api, dura 24 h) con el que se hacen esos pedidos.
//
// Todo pasa entre servidores (Render ↔ Fudo): no hace falta ninguna compu prendida en el local.
//
// Lo verificado contra la cuenta demo (17/11):
//  - item.price es el TOTAL de la línea (2 × Wrap = 37000), no el unitario.
//  - Ítems con canceled = true no se cobran: se descartan (la venta cuadró al peso).
//  - Los descuentos vienen aparte (percentage o amount, a la venta entera o a un ítem): se reparten
//    entre los ítems en proporción a su importe, para que las ventas por artículo sumen lo cobrado.
//  - Los productos suelen no tener código: el vínculo con el artículo es por el id interno de Fudo.
//
// Flujo: conectar → productos + 3 meses de ventas → cada noche (FUDO_CRON) los últimos días.
// Las ventas quedan en fudo_ventas_dia (con o sin vínculo) y las vinculadas se vuelcan a
// sales_daily_items con source='fudo'. Como con Maxi, el POS pisa a la carga por archivo en los días
// que cubre (nunca conviven dos fuentes el mismo día: listDailyItems las sumaría).
'use strict';

const pool = require('../config/db');
const { encryptSecret, decryptSecretCompat } = require('../utils/cryptoField');
const { rebuildSalesDailyRange } = require('./salesDailyRebuildService');

const AUTH_URL = 'https://auth.fu.do/api';
const API_URL = 'https://api.fu.do/v1alpha1';
const SOURCE = 'fudo';
const PAGINA = 500;
const DIAS_HISTORIAL = 90;
const DIAS_REPASO = 3; // cada noche se vuelven a traer los últimos días (ventas que se cierran tarde)
const OFFSET_AR = -3;  // Argentina no tiene horario de verano

// ───────────────────────── utilidades puras (testeadas) ─────────────────────────

/** Día de Argentina (YYYY-MM-DD) de un instante ISO de Fudo (viene en UTC). */
function diaLocal(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + OFFSET_AR * 3600_000).toISOString().slice(0, 10);
}

/** Rango UTC [desde 00:00, hasta+1 00:00) de días de Argentina, en el formato del filtro de Fudo. */
function filtroCierre(desde, hasta) {
  const ini = new Date(`${desde}T00:00:00Z`).getTime() - OFFSET_AR * 3600_000;
  const fin = new Date(`${hasta}T00:00:00Z`).getTime() + 86_400_000 - OFFSET_AR * 3600_000;
  const f = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
  return `and(gte.${f(ini)},lt.${f(fin)})`;
}

function sumarDias(dia, n) {
  return new Date(new Date(`${dia}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Día YYYY-MM-DD de una columna DATE. node-pg la entrega como Date a la medianoche LOCAL del servidor
 * (no hay setTypeParser en config/db.js): String(fecha).slice(0, 10) daba «Mon Nov 16» y rompía la
 * segunda pasada. Se usan los componentes locales, que son los que armó el driver.
 */
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

function hoyAr() {
  return diaLocal(new Date().toISOString());
}

/** Tramos de hasta `largo` días entre desde y hasta (inclusive), para no pedir meses enteros de una. */
function tramos(desde, hasta, largo = 7) {
  const out = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, largo)) {
    const fin = sumarDias(d, largo - 1);
    out.push([d, fin < hasta ? fin : hasta]);
  }
  return out;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Respuestas de /sales (JSON:API: data + included) → filas por día y producto
 * {day, fudo_id, qty, amount}. Solo ventas CLOSED; ítems cancelados afuera; descuentos repartidos.
 * Devuelve también cuánto difiere lo calculado del total de Fudo (propinas/envíos lo explican; sirve
 * para detectar cambios en la API).
 */
function ventasAFilas(respuestas) {
  const incluidos = new Map();
  const ventas = [];
  for (const r of respuestas) {
    for (const x of r?.included || []) incluidos.set(`${x.type}:${x.id}`, x);
    for (const v of r?.data || []) ventas.push(v);
  }
  const buscar = (ref) => (ref ? incluidos.get(`${ref.type}:${ref.id}`) : null);

  const filas = new Map();
  let ventasContadas = 0;
  let diferencia = 0;
  for (const v of ventas) {
    const a = v.attributes || {};
    if (a.saleState && a.saleState !== 'CLOSED') continue;
    const dia = diaLocal(a.closedAt || a.createdAt);
    if (!dia) continue;

    const items = (v.relationships?.items?.data || [])
      .map(buscar)
      .filter((it) => it && !it.attributes?.canceled)
      .map((it) => ({
        id: it.id,
        fudoId: it.relationships?.product?.data?.id || null,
        qty: num(it.attributes?.quantity),
        bruto: num(it.attributes?.price),
      }));
    if (!items.length) continue;
    for (const it of items) it.neto = it.bruto;

    const monto = (d, base) => {
      const da = d.attributes || {};
      let m = num(da.percentage) ? (base * num(da.percentage)) / 100 : num(da.amount);
      if (da.maxAmount != null && num(da.maxAmount) > 0) m = Math.min(m, num(da.maxAmount));
      return Math.max(0, Math.min(m, base));
    };
    for (const d of (v.relationships?.discounts?.data || []).map(buscar)) {
      if (!d || d.attributes?.canceled) continue;
      const delItem = d.relationships?.item?.data?.id;
      if (delItem) {
        const it = items.find((i) => i.id === delItem);
        if (it) it.neto -= monto(d, it.neto);
        continue;
      }
      const base = items.reduce((s, i) => s + i.neto, 0);
      if (base <= 0) continue;
      const total = monto(d, base);
      for (const it of items) it.neto -= (total * it.neto) / base;
    }

    ventasContadas++;
    const calculado = items.reduce((s, i) => s + i.neto, 0);
    if (a.total != null) diferencia += num(a.total) - calculado;

    for (const it of items) {
      if (!it.fudoId) continue;
      const k = `${dia}|${it.fudoId}`;
      const f = filas.get(k) || { day: dia, fudo_id: String(it.fudoId), qty: 0, amount: 0 };
      f.qty += it.qty;
      f.amount += it.neto;
      filas.set(k, f);
    }
  }
  const lista = [...filas.values()].map((f) => ({ ...f, amount: Math.round(f.amount * 100) / 100 }));
  return { filas: lista, ventas: ventasContadas, diferencia: Math.round(diferencia * 100) / 100 };
}

const TIPO_VENTA = { 'EAT-IN': 'Salón', TAKEAWAY: 'Para llevar', DELIVERY: 'Delivery' };

/** Instante ISO (UTC) → «YYYY-MM-DD HH:MM:SS» de Argentina, como guarda el kit las ventas del panel. */
function horaLocal(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + OFFSET_AR * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Ventas de Fudo → filas de gestion_ventas (panel de Resultados de Diego, el mismo que llena el kit de
 * MaxiRest con el informe 22): una fila por cobro (medio de pago) de cada venta cerrada, con su canal
 * (tipo), hora, personas y cliente. Sin cobros registrados: una fila por el total, sin forma de cobro.
 * rowId «fudo-<venta>-<pago>»: estable entre lecturas, así una corrección manual (importeTrabajado/
 * importeManual) no se pierde. El descuento de la venta va en su primera fila.
 */
function cobrosDeVentas(respuestas) {
  const incluidos = new Map();
  const ventas = [];
  for (const r of respuestas) {
    for (const x of r?.included || []) incluidos.set(`${x.type}:${x.id}`, x);
    for (const v of r?.data || []) ventas.push(v);
  }
  const buscar = (ref) => (ref ? incluidos.get(`${ref.type}:${ref.id}`) : null);
  const filas = [];
  for (const v of ventas) {
    const a = v.attributes || {};
    if (a.saleState && a.saleState !== 'CLOSED') continue;
    const cuando = a.closedAt || a.createdAt;
    const fecha = horaLocal(cuando);
    if (!fecha) continue;
    // Descuento = lo que suman los ítems no cancelados menos el total cobrado (si da positivo).
    const bruto = (v.relationships?.items?.data || []).map(buscar)
      .filter((it) => it && !it.attributes?.canceled).reduce((s2, it) => s2 + num(it.attributes?.price), 0);
    const descuento = Math.max(0, Math.round((bruto - num(a.total)) * 100) / 100);
    const base = {
      comprobant: `Fudo ${v.id}`,
      hora: fecha.slice(11, 16),
      tipo: TIPO_VENTA[a.saleType] || a.saleType || null,
      cub: a.people == null ? null : String(a.people),
      cliNombre: a.customerName || null,
      total: num(a.total),
      fecha,
    };
    const pagos = (v.relationships?.payments?.data || []).map(buscar).filter((p) => p && !p.attributes?.canceled);
    if (!pagos.length) {
      filas.push({ ...base, rowId: `fudo-${v.id}-0`, cobro: null, codCobro: null, importe: num(a.total), descuento });
      continue;
    }
    pagos.forEach((p, i) => {
      const pm = buscar(p.relationships?.paymentMethod?.data);
      filas.push({
        ...base,
        rowId: `fudo-${v.id}-${p.id}`,
        cobro: pm?.attributes?.name || null,
        codCobro: pm ? `FUDO-${pm.id}` : null,
        importe: num(p.attributes?.amount),
        descuento: i === 0 ? descuento : 0,
      });
    });
  }
  return filas;
}

/** Nombre comparable: minúsculas, sin acentos ni signos, espacios simples. */
function normalizar(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Sugerencia de artículo para cada producto de Fudo: primero por código (si Fudo lo tiene y es un
 * número de artículo), después por nombre igual. Sin sugerencia si el nombre se repite en artículos.
 */
function sugerir(productos, articulos) {
  const porId = new Set(articulos.map((a) => Number(a.articulo_id)));
  const porNombre = new Map();
  for (const a of articulos) {
    const k = normalizar(a.nombre);
    if (!k) continue;
    porNombre.set(k, porNombre.has(k) ? null : Number(a.articulo_id)); // null = ambiguo
  }
  const out = new Map();
  for (const p of productos) {
    const cod = Number(String(p.codigo || '').trim());
    if (Number.isInteger(cod) && cod > 0 && porId.has(cod)) { out.set(p.fudo_id, cod); continue; }
    const n = porNombre.get(normalizar(p.nombre));
    if (n) out.set(p.fudo_id, n);
  }
  return out;
}

// ───────────────────────── conexión y token ─────────────────────────

class FudoError extends Error {
  constructor(code, message, status) { super(message || code); this.code = code; this.status = status; }
}

async function pedirToken(apiKey, apiSecret) {
  const r = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ apiKey, apiSecret }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.token) throw new FudoError('fudo_claves_invalidas', `Fudo rechazó las claves (${r.status})`, r.status);
  const exp = Number(j.exp) ? new Date(Number(j.exp) * 1000) : new Date(Date.now() + 23 * 3600_000);
  return { token: j.token, exp };
}

async function leerConexion(businessId) {
  const { rows } = await pool.query('SELECT * FROM integraciones_fudo WHERE business_id = $1', [businessId]);
  return rows[0] || null;
}

/** Token vigente (lo renueva si vence en menos de una hora o si `forzar`). */
async function tokenDe(con, { forzar = false } = {}) {
  const vigente = con.token && con.token_exp && new Date(con.token_exp).getTime() - Date.now() > 3600_000;
  if (vigente && !forzar) return decryptSecretCompat(con.token);
  const { token, exp } = await pedirToken(decryptSecretCompat(con.api_key), decryptSecretCompat(con.api_secret));
  await pool.query(
    'UPDATE integraciones_fudo SET token = $2, token_exp = $3, updated_at = now() WHERE business_id = $1',
    [con.business_id, encryptSecret(token), exp]
  );
  con.token = encryptSecret(token);
  con.token_exp = exp;
  return token;
}

/** Cliente de solo lectura: GET con token, renueva una vez si Fudo lo rechaza, espera si pide calma. */
function cliente(con) {
  let token = null;
  const get = async (ruta, intento = 0) => {
    if (!token) token = await tokenDe(con);
    const r = await fetch(API_URL + ruta, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    if (r.status === 401 && intento === 0) {
      token = await tokenDe(con, { forzar: true });
      return get(ruta, 1);
    }
    if (r.status === 429 && intento < 4) {
      const espera = Math.min(60, Number(r.headers.get('retry-after')) || 5 * (intento + 1));
      await new Promise((res) => setTimeout(res, espera * 1000));
      return get(ruta, intento + 1);
    }
    if (!r.ok) throw new FudoError(r.status === 401 || r.status === 403 ? 'fudo_sin_acceso' : 'fudo_error', `Fudo respondió ${r.status} en ${ruta.split('?')[0]}`, r.status);
    return r.json();
  };
  /** Todas las páginas: Fudo no da el total, se corta cuando una página viene incompleta. */
  const todas = async (ruta) => {
    const out = [];
    for (let pagina = 1; pagina < 1000; pagina++) {
      const sep = ruta.includes('?') ? '&' : '?';
      const j = await get(`${ruta}${sep}page[size]=${PAGINA}&page[number]=${pagina}`);
      out.push(j);
      if ((j?.data?.length || 0) < PAGINA) break;
    }
    return out;
  };
  return { get, todas };
}

// ───────────────────────── productos ─────────────────────────

async function traerProductos(con) {
  const api = cliente(con);
  const paginas = await api.todas('/products?include=productCategory');
  const cats = new Map();
  const productos = [];
  for (const p of paginas) {
    for (const x of p.included || []) if (x.type === 'ProductCategory') cats.set(x.id, x.attributes?.name || null);
    for (const d of p.data || []) {
      const a = d.attributes || {};
      productos.push({
        fudo_id: String(d.id),
        nombre: a.name || null,
        codigo: a.code == null ? null : String(a.code),
        precio: a.price == null ? null : num(a.price),
        activo: a.active !== false,
        catId: d.relationships?.productCategory?.data?.id || null,
      });
    }
  }
  for (const p of productos) p.categoria = p.catId ? cats.get(p.catId) || null : null;
  if (!productos.length) return { productos: 0, nuevos: 0 };

  const bid = con.business_id;
  const { rows: articulos } = await pool.query('SELECT articulo_id, nombre FROM maxi_articles WHERE business_id = $1', [bid]);
  const sug = sugerir(productos, articulos);

  const { rows } = await pool.query(
    `WITH datos AS (
       SELECT * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::boolean[], $8::int[])
         AS t(fudo_id, nombre, categoria, codigo, precio, activo, sugerido_id)
     )
     INSERT INTO fudo_productos AS f (business_id, fudo_id, nombre, categoria, codigo, precio, activo, sugerido_id, visto_at)
     SELECT $1, fudo_id, nombre, categoria, codigo, precio, activo, sugerido_id, now() FROM datos
     ON CONFLICT (business_id, fudo_id) DO UPDATE SET
       nombre = EXCLUDED.nombre, categoria = EXCLUDED.categoria, codigo = EXCLUDED.codigo,
       precio = EXCLUDED.precio, activo = EXCLUDED.activo, sugerido_id = EXCLUDED.sugerido_id, visto_at = now()
     RETURNING (xmax = 0) AS nuevo`,
    [
      bid,
      productos.map((p) => p.fudo_id), productos.map((p) => p.nombre), productos.map((p) => p.categoria),
      productos.map((p) => p.codigo), productos.map((p) => p.precio), productos.map((p) => p.activo),
      productos.map((p) => sug.get(p.fudo_id) ?? null),
    ]
  );
  return { productos: productos.length, nuevos: rows.filter((r) => r.nuevo).length };
}

// ───────────────────────── ventas ─────────────────────────

/** Trae de Fudo las ventas de [desde, hasta] y reemplaza esos días en fudo_ventas_dia. */
async function traerVentas(con, desde, hasta) {
  const api = cliente(con);
  const bid = con.business_id;
  let ventas = 0;
  let diferencia = 0;
  const dias = new Set();
  for (const [d, h] of tramos(desde, hasta)) {
    const ruta = `/sales?filter[closedAt]=${encodeURIComponent(filtroCierre(d, h))}`
      + `&filter[saleState]=${encodeURIComponent('in.(CLOSED)')}&include=items,discounts,payments,payments.paymentMethod`;
    const paginas = await api.todas(ruta);
    const r = ventasAFilas(paginas);
    const cobros = cobrosDeVentas(paginas);
    ventas += r.ventas;
    diferencia += r.diferencia;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM fudo_ventas_dia WHERE business_id = $1 AND day BETWEEN $2::date AND $3::date', [bid, d, h]);
      if (r.filas.length) {
        await client.query(
          `INSERT INTO fudo_ventas_dia (business_id, day, fudo_id, qty, amount)
           SELECT $1, * FROM UNNEST($2::date[], $3::text[], $4::numeric[], $5::numeric[])`,
          [bid, r.filas.map((f) => f.day), r.filas.map((f) => f.fudo_id), r.filas.map((f) => f.qty), r.filas.map((f) => f.amount)]
        );
      }
      // Panel de Resultados (gestion_ventas): se van las de Fudo de estos días que ya no están (anuladas
      // en Fudo) y se escriben/actualizan las demás. importeTrabajado e importeManual no se tocan.
      await client.query(
        `DELETE FROM gestion_ventas WHERE business_id = $1 AND "rowId" LIKE 'fudo-%'
           AND fecha >= $2::date AND fecha < $3::date + 1 AND NOT ("rowId" = ANY($4::text[]))`,
        [bid, d, h, cobros.map((c) => c.rowId)]
      );
      if (cobros.length) {
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
             cobro = EXCLUDED.cobro, "codCobro" = EXCLUDED."codCobro", importe = EXCLUDED.importe, total = EXCLUDED.total,
             descuento = EXCLUDED.descuento, "cliNombre" = EXCLUDED."cliNombre", fecha = EXCLUDED.fecha`,
          [bid, con.branch_id ?? null, cobros.map((c) => c.rowId), cobros.map((c) => c.comprobant), cobros.map((c) => c.hora),
            cobros.map((c) => c.tipo), cobros.map((c) => c.cub), cobros.map((c) => c.cobro), cobros.map((c) => c.codCobro),
            cobros.map((c) => c.importe), cobros.map((c) => c.total), cobros.map((c) => c.descuento), cobros.map((c) => c.cliNombre),
            cobros.map((c) => c.fecha)]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    for (const f of r.filas) dias.add(f.day);
  }
  if (Math.abs(diferencia) > 1) console.warn(`[fudo] negocio ${bid}: lo calculado difiere ${diferencia} del total de Fudo (${desde}..${hasta})`);
  return { ventas, dias: [...dias].sort(), diferencia };
}

/**
 * Pasa a sales_daily_items las ventas vinculadas de esos días (source='fudo'). En cada día borra lo que
 * haya de csv/maxi/fudo en la sucursal de la conexión: el POS es la fuente de verdad, como con Maxi.
 * Días sin ninguna venta vinculada no se tocan (no se borra un csv por un día que Fudo no cubre).
 */
async function volcar(businessId, dias) {
  if (!dias?.length) return { filas: 0 };
  const con = await leerConexion(businessId);
  const branchId = con?.branch_id ?? null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT v.day::text AS day, p.articulo_id, MAX(ma.nombre) AS nombre, SUM(v.qty) AS qty, SUM(v.amount) AS amount
         FROM fudo_ventas_dia v
         JOIN fudo_productos p ON p.business_id = v.business_id AND p.fudo_id = v.fudo_id AND p.articulo_id IS NOT NULL
         LEFT JOIN maxi_articles ma ON ma.business_id = v.business_id AND ma.articulo_id = p.articulo_id
        WHERE v.business_id = $1 AND v.day = ANY($2::date[])
        GROUP BY v.day, p.articulo_id`,
      [businessId, dias]
    );
    const conVentas = [...new Set(rows.map((r) => r.day))];
    // Un día que tenía ventas de Fudo y ya no tiene vinculadas (desvincularon) también se limpia.
    await client.query(
      `DELETE FROM sales_daily_items
        WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $3::bigint
          AND (source IN ('csv','maxi','fudo') AND day = ANY($2::date[]) OR source = 'fudo' AND day = ANY($4::date[]))`,
      [businessId, conVentas, branchId, dias]
    );
    if (rows.length) {
      await client.query(
        `INSERT INTO sales_daily_items (business_id, branch_id, day, article_id, article_name, qty, amount, source)
         SELECT $1, $2::bigint, day, article_id, article_name, qty, amount, '${SOURCE}'
           FROM UNNEST($3::date[], $4::int[], $5::text[], $6::numeric[], $7::numeric[])
             AS t(day, article_id, article_name, qty, amount)`,
        [businessId, branchId, rows.map((r) => r.day), rows.map((r) => r.articulo_id), rows.map((r) => r.nombre),
          rows.map((r) => r.qty), rows.map((r) => r.amount)]
      );
    }
    const orden = [...dias].sort();
    await rebuildSalesDailyRange({ businessId, from: orden[0], to: orden[orden.length - 1], client });
    await client.query('COMMIT');
    return { filas: rows.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ───────────────────────── avisos ─────────────────────────

function avisar(businessId, args) {
  // require diferido: notificationService arrastra media app y los tests de lo puro no lo necesitan
  const { avisarAlEquipo } = require('./notificationService');
  return avisarAlEquipo({ businessId, ...args }).catch((e) => console.error('[fudo] aviso', businessId, e.message));
}

async function avisarSinVincular(businessId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM fudo_productos p
      WHERE p.business_id = $1 AND p.articulo_id IS NULL AND p.activo
        AND EXISTS (SELECT 1 FROM fudo_ventas_dia v WHERE v.business_id = p.business_id AND v.fudo_id = p.fudo_id)`,
    [businessId]
  );
  const n = rows[0]?.n || 0;
  if (!n) return;
  await avisar(businessId, {
    type: 'fudo_sin_vincular',
    title: n === 1 ? 'Hay 1 producto de Fudo sin vincular' : `Hay ${n} productos de Fudo sin vincular`,
    message: 'Vendieron pero no están vinculados a un artículo, así que sus ventas todavía no cuentan. Vinculalos en Configuración › Conexiones › Fudo.',
    metadata: { cantidad: n },
    clave: `fudo_sin_vincular:${businessId}`,
    agruparMin: 24 * 60,
  });
}

/** Un aviso por pasada con lo que entró de Fudo (regla de la Guía: lotes = un aviso con cantidad). */
async function avisarMaestros(businessId, m) {
  const partes = [];
  const n = (x, uno, varios) => (x ? `${x} ${x === 1 ? uno : varios}` : null);
  partes.push(n(m.articulos?.nuevos, 'artículo nuevo', 'artículos nuevos'));
  partes.push(n(m.articulos?.actualizados, 'artículo actualizado', 'artículos actualizados'));
  partes.push(n(m.insumos?.nuevos, 'insumo nuevo', 'insumos nuevos'));
  partes.push(n(m.insumos?.actualizados, 'insumo actualizado', 'insumos actualizados'));
  partes.push(n((m.recetas?.nuevas || 0) + (m.recetas?.actualizadas || 0), 'receta', 'recetas'));
  partes.push(n(m.compras?.nuevas, 'compra nueva', 'compras nuevas'));
  const texto = partes.filter(Boolean);
  if (!texto.length) return;
  await avisar(businessId, {
    type: 'fudo_maestros',
    title: 'Llegaron datos de Fudo',
    message: `${texto.join(', ')}.${m.compras?.salteadas ? ` ${m.compras.salteadas} compra${m.compras.salteadas === 1 ? '' : 's'} ya estaba${m.compras.salteadas === 1 ? '' : 'n'} cargada${m.compras.salteadas === 1 ? '' : 's'} en Lazarillo y no se repitió.` : ''}`,
    metadata: { ...m, articulos: m.articulos && { ...m.articulos, vinculadosIds: undefined } },
  });
}

// ───────────────────────── sincronizar ─────────────────────────

const enCurso = new Set();

/**
 * Productos + ventas de [desde, hasta] + volcado. Sin fechas: desde el último día completo menos unos
 * días de repaso (o 3 meses si es la primera vez) hasta ayer.
 */
async function sincronizar(businessId, { desde = null, hasta = null, origen = 'manual' } = {}) {
  const bid = Number(businessId);
  if (enCurso.has(bid)) return { ok: false, error: 'fudo_en_curso' };
  const con = await leerConexion(bid);
  if (!con) return { ok: false, error: 'fudo_no_conectado' };
  enCurso.add(bid);
  try {
    const hoy = hoyAr();
    const ayer = sumarDias(hoy, -1);
    // La pasada de la noche trae hasta ayer (día cerrado). «Traer ahora» y la primera conexión traen
    // también lo de hoy, para ver algo enseguida; la noche lo completa (repasa los últimos días).
    const h = hasta || (origen === 'cron' ? ayer : hoy);
    const desdeGuardado = diaDe(con.ventas_hasta);
    const d = desde || (desdeGuardado ? sumarDias(desdeGuardado, -DIAS_REPASO) : sumarDias(ayer, -DIAS_HISTORIAL));
    const productos = await traerProductos(con);
    // Artículos, insumos, recetas y compras (lo que el cliente eligió traer). Si falla, las ventas
    // igual se traen: el error queda anotado y se reintenta la próxima pasada.
    let maestros = null;
    let errorMaestros = null;
    try {
      maestros = await require('./fudoMaestros').sincronizarMaestros(con, cliente(con), { hoy: hoyAr() });
      await pool.query('UPDATE integraciones_fudo SET maestros_at = now(), maestros_resumen = $2 WHERE business_id = $1', [bid, JSON.stringify(maestros)]);
      await avisarMaestros(bid, maestros);
    } catch (e) {
      errorMaestros = e;
      console.error(`[fudo] negocio ${bid} maestros:`, e.message);
    }
    const ventas = await traerVentas(con, d, h);
    // Se vuelcan todos los días del rango (también los que quedaron sin ventas, para limpiar 'fudo'),
    // más los días viejos de los productos que se acaban de vincular solos.
    const dias = new Set(tramos(d, h, 1).map(([x]) => x));
    const ids = maestros?.articulos?.vinculadosIds || [];
    if (ids.length) {
      const { rows } = await pool.query('SELECT DISTINCT day::text AS day FROM fudo_ventas_dia WHERE business_id = $1 AND fudo_id = ANY($2::text[])', [bid, ids]);
      for (const r of rows) dias.add(r.day);
    }
    const volcado = await volcar(bid, [...dias].sort());
    if (errorMaestros) throw errorMaestros;
    await pool.query(
      `UPDATE integraciones_fudo SET ultimo_sync_at = now(), ultimo_sync_error = NULL,
              ventas_hasta = GREATEST(COALESCE(ventas_hasta, $2::date), $2::date), updated_at = now()
        WHERE business_id = $1`,
      [bid, h < ayer ? h : ayer] // hoy todavía no está completo
    );
    await avisarSinVincular(bid);
    console.log(`[fudo] negocio ${bid} (${origen}): ${productos.productos} productos, ${ventas.ventas} ventas ${d}..${h}, ${volcado.filas} filas`);
    return { ok: true, desde: d, hasta: h, productos, maestros, ventas: ventas.ventas, dias: ventas.dias.length, filas: volcado.filas };
  } catch (e) {
    await pool.query('UPDATE integraciones_fudo SET ultimo_sync_at = now(), ultimo_sync_error = $2, updated_at = now() WHERE business_id = $1',
      [bid, String(e.message).slice(0, 500)]).catch(() => {});
    if (e.code === 'fudo_claves_invalidas' || e.code === 'fudo_sin_acceso') {
      await avisar(bid, {
        type: 'fudo_vencido',
        title: 'La conexión con Fudo dejó de funcionar',
        message: 'Fudo no acepta las claves de Lazarillo (¿se borró el usuario o se cambió el API Secret?). Volvé a conectarla en Configuración › Conexiones › Fudo.',
        clave: `fudo_vencido:${bid}`,
        agruparMin: 24 * 60,
      });
      return { ok: false, error: 'fudo_vencido' };
    }
    throw e;
  } finally {
    enCurso.delete(bid);
  }
}

// ───────────────────────── lo que usan las rutas ─────────────────────────

async function estado(businessId) {
  const con = await leerConexion(businessId);
  if (!con) return { conectado: false };
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS productos,
            COUNT(*) FILTER (WHERE articulo_id IS NOT NULL)::int AS vinculados,
            COUNT(*) FILTER (WHERE articulo_id IS NULL AND activo
              AND EXISTS (SELECT 1 FROM fudo_ventas_dia v WHERE v.business_id = p.business_id AND v.fudo_id = p.fudo_id))::int AS sin_vincular_con_ventas
       FROM fudo_productos p WHERE business_id = $1`,
    [businessId]
  );
  return {
    conectado: true,
    branch_id: con.branch_id,
    conectado_at: con.conectado_at,
    ventas_hasta: diaDe(con.ventas_hasta),
    ultimo_sync_at: con.ultimo_sync_at,
    ultimo_sync_error: con.ultimo_sync_error,
    sincronizando: enCurso.has(Number(businessId)),
    traer: normalizarTraer(con.traer),
    maestros_at: con.maestros_at,
    maestros_resumen: con.maestros_resumen,
    ...rows[0],
  };
}

/** Valida las claves pidiendo un token y guarda la conexión. La primera carga corre en segundo plano. */
/** Qué trae el negocio de Fudo. Las ventas siempre (regla de la usuaria 17/11): no se pueden apagar. */
const TRAER_DEFAULT = { ventas: true, articulos: true, insumos: true, compras: true };
function normalizarTraer(t) {
  const o = { ...TRAER_DEFAULT };
  if (t && typeof t === 'object') for (const k of ['articulos', 'insumos', 'compras']) if (k in t) o[k] = !!t[k];
  o.ventas = true;
  return o;
}

async function cambiarTraer(businessId, userId, traer) {
  const t = normalizarTraer(traer);
  const { rows } = await pool.query('UPDATE integraciones_fudo SET traer = $2, updated_at = now() WHERE business_id = $1 RETURNING traer',
    [businessId, JSON.stringify(t)]);
  if (!rows[0]) return { error: 'fudo_no_conectado' };
  const nombres = { articulos: 'artículos', insumos: 'insumos y recetas', compras: 'compras' };
  const si = Object.keys(nombres).filter((k) => t[k]).map((k) => nombres[k]);
  await avisar(businessId, {
    actorUserId: userId,
    type: 'fudo_traer',
    title: 'Cambió lo que se trae de Fudo',
    message: `Además de las ventas, Lazarillo trae de Fudo: ${si.length ? si.join(', ') : 'nada más'}.`,
    metadata: { traer: t },
  });
  return { ok: true, traer: t };
}

async function conectar(businessId, userId, { apiKey, apiSecret, branchId = null, traer = null } = {}) {
  const key = String(apiKey || '').trim();
  const secret = String(apiSecret || '').trim();
  if (!key || !secret) return { error: 'faltan_claves' };
  if (key.length > 200 || secret.length > 500) return { error: 'claves_invalidas' };
  let tok;
  try {
    tok = await pedirToken(key, secret);
  } catch (e) {
    return { error: 'fudo_claves_invalidas', message: 'Fudo no aceptó esas claves. Revisá la API Key y el API Secret del usuario de Lazarillo en Fudo.' };
  }
  const branch = branchId == null || branchId === '' ? null : Number(branchId);
  if (branch != null) {
    const { rows } = await pool.query('SELECT 1 FROM app_branches WHERE id = $1 AND business_id = $2', [branch, businessId]);
    if (!rows[0]) return { error: 'sucursal_invalida' };
  }
  const { rows: previa } = await pool.query('SELECT 1 FROM integraciones_fudo WHERE business_id = $1', [businessId]);
  await pool.query(
    `INSERT INTO integraciones_fudo (business_id, branch_id, api_key, api_secret, token, token_exp, conectado_por, conectado_at, ultimo_sync_error, traer, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), NULL, $8, now())
     ON CONFLICT (business_id) DO UPDATE SET
       branch_id = EXCLUDED.branch_id, api_key = EXCLUDED.api_key, api_secret = EXCLUDED.api_secret,
       token = EXCLUDED.token, token_exp = EXCLUDED.token_exp, conectado_por = EXCLUDED.conectado_por,
       conectado_at = now(), ultimo_sync_error = NULL, traer = EXCLUDED.traer, updated_at = now()`,
    [businessId, branch, encryptSecret(key), encryptSecret(secret), encryptSecret(tok.token), tok.exp, userId || null, JSON.stringify(normalizarTraer(traer))]
  );
  await avisar(businessId, {
    actorUserId: userId,
    type: 'fudo_conectado',
    title: previa[0] ? 'Se volvió a conectar Fudo' : 'Se conectó Fudo',
    message: 'Lazarillo trae de Fudo las ventas (y lo que se eligió: artículos, insumos, compras) todas las noches. La primera vez trae los últimos 3 meses.',
  });
  setImmediate(() => {
    sincronizar(businessId, { origen: 'conexion' }).catch((e) => console.error('[fudo] primera carga', businessId, e.message));
  });
  return { ok: true, conectado: true };
}

/** Borra la conexión (y las claves). Las ventas ya cargadas quedan. */
async function desconectar(businessId, userId) {
  const { rowCount } = await pool.query('DELETE FROM integraciones_fudo WHERE business_id = $1', [businessId]);
  if (!rowCount) return { error: 'fudo_no_conectado' };
  await avisar(businessId, {
    actorUserId: userId,
    type: 'fudo_desconectado',
    title: 'Se desconectó Fudo',
    message: 'Lazarillo dejó de traer las ventas de Fudo. Las que ya estaban cargadas quedan.',
  });
  return { ok: true };
}

async function listarProductos(businessId) {
  const { rows } = await pool.query(
    `SELECT p.fudo_id, p.nombre, p.categoria, p.codigo, p.precio, p.activo, p.articulo_id, p.sugerido_id,
            a.nombre AS articulo_nombre, s.nombre AS sugerido_nombre,
            COALESCE(v.qty, 0)::float8 AS qty_90d, COALESCE(v.amount, 0)::float8 AS amount_90d, v.ultima_venta
       FROM fudo_productos p
       LEFT JOIN maxi_articles a ON a.business_id = p.business_id AND a.articulo_id = p.articulo_id
       LEFT JOIN maxi_articles s ON s.business_id = p.business_id AND s.articulo_id = p.sugerido_id
       LEFT JOIN (SELECT fudo_id, SUM(qty) AS qty, SUM(amount) AS amount, MAX(day) AS ultima_venta
                    FROM fudo_ventas_dia WHERE business_id = $1 AND day > current_date - 90 GROUP BY fudo_id) v
              ON v.fudo_id = p.fudo_id
      WHERE p.business_id = $1
      ORDER BY (p.articulo_id IS NULL) DESC, COALESCE(v.amount, 0) DESC, lower(p.nombre)`,
    [businessId]
  );
  // Artículos del negocio, para elegir el vínculo (los mismos que Ventas resuelve por articulo_id).
  const { rows: articulos } = await pool.query(
    'SELECT articulo_id AS id, nombre, categoria FROM maxi_articles WHERE business_id = $1 ORDER BY lower(nombre)',
    [businessId]
  );
  return { productos: rows, articulos };
}

/**
 * Vincula (o desvincula, articuloId null) productos de Fudo con artículos y vuelca sus días.
 * cambios: [{fudo_id, articulo_id}]. Un aviso por lote.
 */
async function vincular(businessId, userId, cambios) {
  if (!Array.isArray(cambios) || !cambios.length) return { error: 'sin_cambios' };
  if (cambios.length > 2000) return { error: 'demasiados_cambios' };
  const ids = [];
  const arts = [];
  for (const c of cambios) {
    const f = String(c?.fudo_id ?? '').trim();
    const a = c?.articulo_id == null || c.articulo_id === '' ? null : Number(c.articulo_id);
    if (!f || (a != null && (!Number.isInteger(a) || a <= 0))) return { error: 'cambio_invalido' };
    ids.push(f);
    arts.push(a);
  }
  const pedidos = [...new Set(arts.filter((a) => a != null))];
  if (pedidos.length) {
    const { rows } = await pool.query('SELECT articulo_id FROM maxi_articles WHERE business_id = $1 AND articulo_id = ANY($2::int[])', [businessId, pedidos]);
    if (rows.length !== pedidos.length) return { error: 'articulo_inexistente' };
  }
  const { rowCount } = await pool.query(
    `UPDATE fudo_productos p SET articulo_id = t.articulo_id, vinculado_por = $4, vinculado_at = now()
       FROM UNNEST($2::text[], $3::int[]) AS t(fudo_id, articulo_id)
      WHERE p.business_id = $1 AND p.fudo_id = t.fudo_id AND p.articulo_id IS DISTINCT FROM t.articulo_id`,
    [businessId, ids, arts, userId || null]
  );
  if (!rowCount) return { ok: true, cambiados: 0 };

  const { rows: d } = await pool.query(
    'SELECT DISTINCT day::text AS day FROM fudo_ventas_dia WHERE business_id = $1 AND fudo_id = ANY($2::text[])',
    [businessId, ids]
  );
  const volcado = await volcar(businessId, d.map((r) => r.day));
  await avisar(businessId, {
    actorUserId: userId,
    type: 'fudo_vinculos',
    title: rowCount === 1 ? 'Se vinculó 1 producto de Fudo' : `Se vincularon ${rowCount} productos de Fudo`,
    message: d.length ? `Se recalcularon las ventas de ${d.length} día${d.length === 1 ? '' : 's'}.` : null,
    metadata: { cantidad: rowCount },
  });
  return { ok: true, cambiados: rowCount, dias: d.length, filas: volcado.filas };
}

/** Cron: todas las conexiones, una por una. */
async function corridaDiaria() {
  const { rows } = await pool.query('SELECT business_id FROM integraciones_fudo ORDER BY business_id');
  for (const r of rows) {
    try {
      await sincronizar(r.business_id, { origen: 'cron' });
    } catch (e) {
      console.error('[fudo] corrida diaria', r.business_id, e.message);
    }
  }
  return { negocios: rows.length };
}

module.exports = {
  estado, conectar, desconectar, sincronizar, cambiarTraer, listarProductos, vincular, corridaDiaria,
  // para tests
  _diaLocal: diaLocal, _cobrosDeVentas: cobrosDeVentas, _filtroCierre: filtroCierre, _tramos: tramos, _ventasAFilas: ventasAFilas,
  _normalizar: normalizar, _sugerir: sugerir, _diaDe: diaDe, _normalizarTraer: normalizarTraer,
};
