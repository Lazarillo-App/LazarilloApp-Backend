// services/avisosABM.js
//
// Tablero #51 (17/11/2026): todo alta, baja y modificación deja un aviso en la campanita del equipo
// (regla de la Guía: «ABM → avisos»; un lote = un aviso con la cantidad). En vez de tocar cada
// controlador, un middleware mira los pedidos que terminan bien (2xx) y los cruza con REGLAS: área +
// qué se hizo. Lo que una misma persona hace en la misma área en 30 minutos se junta en UN aviso que se
// va actualizando: «Mairene · Artículos: 3 artículos editados, 1 rubro renombrado».
//
// Lo que ya avisaba por su cuenta (alta/baja de artículo, clasificación, insumos manuales, equipo,
// datos del negocio, Fudo…) no está en REGLAS, así no hay avisos repetidos. Lo automático (asegurar
// grupos especiales, sincronizaciones, previsualizaciones) tampoco.
// Discontinuar insumos (mover al grupo «Discontinuados») avisa aparte, con los nombres.
'use strict';

const pool = require('../config/db');
const getBusinessId = require('../utils/getBusinessId');

const B = '^/api/businesses/(\\d+)';
const G = `${B}/gestion`;
const r = (metodo, ruta, area, uno, varios, n = null) => ({ metodo, re: new RegExp(`${ruta}/?$`), area, uno, varios: varios || uno, n });
const largo = (...ks) => (req) => { for (const k of ks) if (Array.isArray(req.body?.[k]) && req.body[k].length) return req.body[k].length; return 1; };

const REGLAS = [
  // ── Agrupaciones de artículos ──
  r('POST', `${B}/agrupaciones`, 'Agrupaciones', 'agrupación creada', 'agrupaciones creadas'),
  r('POST', `${B}/agrupaciones/create-or-move`, 'Agrupaciones', 'agrupación armada con artículos', 'agrupaciones armadas con artículos'),
  r('PUT', `${B}/agrupaciones/\\d+`, 'Agrupaciones', 'agrupación editada', 'agrupaciones editadas'),
  r('DELETE', `${B}/agrupaciones/\\d+`, 'Agrupaciones', 'agrupación borrada', 'agrupaciones borradas'),
  r('PUT', `${B}/agrupaciones/\\d+/articulos`, 'Agrupaciones', 'artículo sumado a una agrupación', 'artículos sumados a agrupaciones', largo('articulos', 'ids')),
  r('DELETE', `${B}/agrupaciones/\\d+/articulos(/\\d+)?`, 'Agrupaciones', 'artículo sacado de una agrupación', 'artículos sacados de agrupaciones', largo('ids')),
  r('POST', `${B}/agrupaciones/\\d+/exclusiones`, 'Agrupaciones', 'exclusión cambiada', 'exclusiones cambiadas'),
  r('POST', `${B}/agrupaciones/(\\d+/move-items|move-cross-biz)`, 'Agrupaciones', 'artículo movido de agrupación', 'artículos movidos de agrupación', largo('ids')),
  r('POST', `${B}/agrupaciones/group-rules`, 'Agrupaciones', 'regla de agrupación cambiada', 'reglas de agrupación cambiadas'),

  // ── Artículos, precios y listas ──
  r('PATCH', `${B}/articles/\\d+`, 'Artículos', 'artículo editado', 'artículos editados'),
  r('POST', `${B}/articles/normalizar-nombres`, 'Artículos', 'normalización de nombres de artículos', 'normalizaciones de nombres de artículos'),
  r('PUT', `${B}/articles/(sub)?rubros/rename`, 'Artículos', 'rubro renombrado', 'rubros renombrados'),
  r('DELETE', `${B}/articles/batches/[^/]+`, 'Artículos', 'importación de artículos borrada', 'importaciones de artículos borradas'),
  r('POST', `${B}/article-price-config`, 'Precios', 'precio nuevo cargado', 'precios nuevos cargados'),
  r('POST', `${B}/article-price-config/bulk`, 'Precios', 'precio nuevo cargado', 'precios nuevos cargados', largo('updates', 'deletes')),
  r('DELETE', `${B}/article-price-config`, 'Precios', 'precio nuevo quitado', 'precios nuevos quitados'),
  r('POST', `${B}/article-lists`, 'Listas', 'lista creada', 'listas creadas'),
  r('PUT', `${B}/article-lists/\\d+`, 'Listas', 'lista editada', 'listas editadas'),
  r('DELETE', `${B}/article-lists/\\d+`, 'Listas', 'lista borrada', 'listas borradas'),
  r('PUT', `${B}/article-lists/\\d+/items`, 'Listas', 'cambio de artículos en una lista', 'cambios de artículos en listas'),
  r('DELETE', `${B}/article-lists/\\d+/items/\\d+`, 'Listas', 'artículo sacado de una lista', 'artículos sacados de listas'),
  r('POST', `${B}/article-links(/\\d+/members)?`, 'Artículos', 'vínculo entre artículos cambiado', 'vínculos entre artículos cambiados'),
  r('(DELETE|PATCH)', `${B}/article-links/\\d+(/members/\\d+)?`, 'Artículos', 'vínculo entre artículos cambiado', 'vínculos entre artículos cambiados'),
  r('POST', `${B}/insumo-lists`, 'Listas', 'lista de insumos creada', 'listas de insumos creadas'),
  r('DELETE', `${B}/insumo-lists/\\d+`, 'Listas', 'lista de insumos borrada', 'listas de insumos borradas'),
  r('PUT', `${B}/insumo-lists/\\d+/items`, 'Listas', 'cambio de insumos en una lista', 'cambios de insumos en listas'),

  // ── Insumos (lo que no avisaba) ──
  r('PUT', '^/api/insumos/\\d+', 'Insumos', 'insumo editado', 'insumos editados'),
  r('DELETE', '^/api/insumos/\\d+', 'Insumos', 'insumo borrado', 'insumos borrados'),
  r('PUT', '^/api/insumos/rubros/rename', 'Insumos', 'rubro de insumos renombrado', 'rubros de insumos renombrados'),
  r('POST', '^/api/insumos/normalizar-nombres', 'Insumos', 'normalización de nombres de insumos', 'normalizaciones de nombres de insumos'),
  r('DELETE', '^/api/insumos/batches/[^/]+', 'Insumos', 'importación de insumos borrada', 'importaciones de insumos borradas'),
  r('POST', '^/api/insumos/(bulk|bulk-csv|import-csv-paired)', 'Insumos', 'importación de insumos', 'importaciones de insumos'),
  r('POST', '^/api/insumos/groups(/create-or-move)?', 'Insumos', 'grupo de insumos creado', 'grupos de insumos creados'),
  r('PUT', '^/api/insumos/groups/\\d+', 'Insumos', 'grupo de insumos editado', 'grupos de insumos editados'),
  r('DELETE', '^/api/insumos/groups/\\d+', 'Insumos', 'grupo de insumos borrado', 'grupos de insumos borrados'),
  r('(POST|PUT)', '^/api/insumos/groups/\\d+/items(/bulk)?', 'Insumos', 'insumo sumado a un grupo', 'insumos sumados a grupos', largo('insumoIds')),
  r('DELETE', '^/api/insumos/groups/\\d+/items/\\d+', 'Insumos', 'insumo sacado de un grupo', 'insumos sacados de grupos'),
  r('(POST|DELETE)', '^/api/insumos/groups/\\d+/exclusions', 'Insumos', 'exclusión cambiada', 'exclusiones cambiadas'),
  r('POST', '^/api/insumos/\\d+/reemplazar', 'Insumos', 'insumo reemplazado en recetas', 'insumos reemplazados en recetas'),
  r('(POST|PUT)', '^/api/insumos/\\d+/(mermas|equivalencias)(/\\d+)?(/aplicar)?', 'Insumos', 'merma o equivalencia cambiada', 'mermas o equivalencias cambiadas'),
  r('DELETE', '^/api/insumos/\\d+/equivalencias/\\d+', 'Insumos', 'merma o equivalencia cambiada', 'mermas o equivalencias cambiadas'), // borrar merma ya avisa
  r('PUT', '^/api/insumos/\\d+/desperdicio-override', 'Insumos', 'desperdicio cambiado', 'desperdicios cambiados'),

  // ── Gestión: facturas, pagos, gastos ──
  r('POST', `${G}/facturas`, 'Gestión', 'factura cargada', 'facturas cargadas'),
  r('PUT', `${G}/facturas/[^/]+`, 'Gestión', 'factura editada', 'facturas editadas'),
  r('DELETE', `${G}/facturas/[^/]+`, 'Gestión', 'factura borrada', 'facturas borradas'),
  r('POST', `${G}/gastos-varios`, 'Gestión', 'gasto cargado', 'gastos cargados'),
  r('(POST|DELETE)', `${G}/ventas-manuales`, 'Gestión', 'venta manual cambiada', 'ventas manuales cambiadas'),
  r('PATCH', `${G}/dashboard/(compras|pagos|ventas)/[^/]+`, 'Gestión', 'importe del panel corregido', 'importes del panel corregidos'),
  r('POST', `${G}/pagos-proveedor`, 'Gestión', 'pago a proveedor cargado', 'pagos a proveedores cargados'),
  r('PATCH', `${G}/pagos-proveedor/\\d+`, 'Gestión', 'pago a proveedor editado', 'pagos a proveedores editados'),
  r('DELETE', `${G}/pagos-proveedor/\\d+(/aplicaciones)?`, 'Gestión', 'pago a proveedor borrado', 'pagos a proveedores borrados'),
  r('(POST|PATCH|DELETE)', `${G}/impagas/(pagos-internos|forzadas)(/\\d+)?(/desimputar)?`, 'Gestión', 'pago interno cambiado', 'pagos internos cambiados'),
  r('POST', `${G}/facturas/proveedores`, 'Gestión', 'proveedor creado', 'proveedores creados'),
  r('PATCH', `${G}/facturas/proveedores/\\d+`, 'Gestión', 'proveedor editado', 'proveedores editados'),
  r('POST', `${G}/conceptos`, 'Gestión', 'concepto de caja creado', 'conceptos de caja creados'),
  r('POST', `${G}/rubros-caja`, 'Gestión', 'rubro de caja creado', 'rubros de caja creados'),
  r('PATCH', `${G}/conceptos/[^/]+`, 'Gestión', 'concepto de caja editado', 'conceptos de caja editados'),
  r('DELETE', `${G}/conceptos/[^/]+`, 'Gestión', 'concepto de caja borrado', 'conceptos de caja borrados'),
  r('PUT', `${G}/(sin-rubro/(rubro-insumo|insumo|compra)|organizar/proveedor)/[^/]+`, 'Gestión', 'gasto organizado en su concepto', 'gastos organizados en su concepto'),
  r('(POST|PUT|DELETE)', `${G}/medios-pago(/\\d+)?`, 'Gestión', 'medio de pago cambiado', 'medios de pago cambiados'),
  r('(POST|PATCH|DELETE)', `${G}/apertura/reglas(/\\d+)?`, 'Gestión', 'regla de reparto cambiada', 'reglas de reparto cambiadas'),
  r('(POST|DELETE)', `${G}/empleados(/\\d+)?`, 'Gestión', 'empleado cambiado', 'empleados cambiados'),
  r('POST', `${G}/arca/(importar|corregir)`, 'Gestión', 'importación de ARCA', 'importaciones de ARCA'),

  // ── Configuración ──
  r('PATCH', `${G}/config/rubros-dashboard`, 'Configuración', 'rubro visible del panel cambiado', 'rubros visibles del panel cambiados'),
  r('PUT', `${G}/dashboard/equilibrio/variables`, 'Configuración', 'variable del punto de equilibrio cambiada', 'variables del punto de equilibrio cambiadas'),
  r('PATCH', `${B}/config-costeo`, 'Configuración', 'configuración de costeo cambiada', 'configuraciones de costeo cambiadas'),
  r('(POST|PATCH)', `${B}/(logo|branding-url)`, 'Configuración', 'logo del negocio cambiado', 'logos del negocio cambiados'),
  r('POST', `${B}/maxi-credentials`, 'Configuración', 'credenciales de MaxiRest guardadas', 'credenciales de MaxiRest guardadas'),
  r('POST', '^/api/divisions(/create-from-group)?', 'Configuración', 'división creada', 'divisiones creadas'),
  r('PUT', '^/api/divisions/\\d+', 'Configuración', 'división editada', 'divisiones editadas'),
  r('DELETE', '^/api/divisions/\\d+', 'Configuración', 'división borrada', 'divisiones borradas'),
];

/** Regla que corresponde a un pedido (pura, testeada). */
function reglaDe(metodo, ruta) {
  const path = String(ruta || '').split('?')[0];
  return REGLAS.find((x) => new RegExp(`^(${x.metodo})$`).test(metodo) && x.re.test(path)) || null;
}

/** Texto del aviso con lo acumulado (pura): { 'artículo editado': {n, uno, varios} } → «3 artículos editados, …». */
function textoConteo(conteo) {
  return Object.values(conteo || {})
    .sort((a, b) => b.n - a.n)
    .map((c) => `${c.n} ${c.n === 1 ? c.uno : c.varios}`)
    .join(', ');
}

const AGRUPAR_MIN = 30;

async function anotar({ businessId, actorUserId, regla, n }) {
  const { avisarAlEquipo } = require('./notificationService');
  const clave = `abm:${regla.area}:${actorUserId || 0}`;
  const { rows } = await pool.query(
    `SELECT metadata->'conteo' AS conteo FROM sync_notifications
      WHERE business_id = $1 AND metadata->>'clave' = $2 AND created_at > NOW() - ($3::int * INTERVAL '1 minute')
      ORDER BY created_at DESC LIMIT 1`, [businessId, clave, AGRUPAR_MIN]);
  const conteo = rows[0]?.conteo || {};
  const k = regla.uno;
  conteo[k] = { n: (Number(conteo[k]?.n) || 0) + n, uno: regla.uno, varios: regla.varios };
  const total = Object.values(conteo).reduce((s, c) => s + c.n, 0);
  await avisarAlEquipo({
    businessId, actorUserId, type: 'abm',
    title: total === 1 ? `${regla.area}: ${regla.uno}` : `${regla.area}: ${total} cambios`,
    message: textoConteo(conteo),
    metadata: { kind: 'abm', area: regla.area, conteo },
    clave, agruparMin: AGRUPAR_MIN,
  });
}

/** Insumos movidos al grupo «Discontinuados»: aviso propio con los nombres (como en artículos). */
async function discontinuados({ businessId, actorUserId, req }) {
  const grupo = Number(String(req.originalUrl).match(/groups\/(\d+)/)?.[1]);
  if (!grupo) return false;
  const { rows: g } = await pool.query('SELECT nombre FROM insumo_groups WHERE id = $1', [grupo]);
  if (!/^\s*(dis|des)continuad/i.test(g[0]?.nombre || '')) return false;
  const ids = (Array.isArray(req.body?.insumoIds) ? req.body.insumoIds : [req.body?.insumoId]).map(Number).filter((x) => x > 0);
  if (!ids.length) return true;
  const { rows } = await pool.query('SELECT nombre FROM insumos WHERE id = ANY($1::int[])', [ids]);
  const nombres = rows.map((x) => String(x.nombre || '').trim()).filter(Boolean);
  const { avisarAlEquipo } = require('./notificationService');
  await avisarAlEquipo({
    businessId, actorUserId, type: 'discontinue',
    title: ids.length === 1 ? `${nombres[0] || `Insumo #${ids[0]}`} discontinuado` : `${ids.length} insumos discontinuados`,
    message: ids.length > 1 && nombres.length ? nombres.slice(0, 5).join(', ') + (nombres.length > 5 ? '…' : '') : null,
    metadata: { kind: 'discontinue', scope: 'insumo', ids },
  });
  return true;
}

/** Middleware para app.js: va antes de las rutas; actúa cuando la respuesta ya salió bien. */
function avisosABM(req, res, next) {
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') return next();
  const regla = reglaDe(req.method, req.originalUrl);
  if (!regla) return next();
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    if (res.locals?.avisado) return; // el controlador ya dejó su propio aviso (p. ej. discontinuar)
    const desdeUrl = Number(String(req.originalUrl).match(/^\/api\/businesses\/(\d+)/)?.[1]);
    let businessId = desdeUrl || Number(req.business?.id) || Number(req.businessId) || null;
    if (!businessId) { try { businessId = Number(getBusinessId(req)) || null; } catch { businessId = null; } }
    const actorUserId = Number(req.user?.id) || null;
    if (!businessId) return;
    (async () => {
      if (regla.area === 'Insumos' && /\/groups\/\d+\/items/.test(req.originalUrl) && req.method !== 'DELETE'
        && await discontinuados({ businessId, actorUserId, req })) return;
      const n = Math.max(1, Number(regla.n ? regla.n(req) : 1) || 1);
      await anotar({ businessId, actorUserId, regla, n });
    })().catch((e) => console.error('[avisos-abm]', req.method, req.originalUrl, e?.message || e));
  });
  next();
}

module.exports = { avisosABM, _reglaDe: reglaDe, _textoConteo: textoConteo, REGLAS };
