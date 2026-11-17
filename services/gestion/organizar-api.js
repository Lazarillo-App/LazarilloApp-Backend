// services/gestion/organizar-api.js
//
// «Organizá tus gastos» (usuaria + Diego, 17/11/2026): una sola pantalla para que el Panel quede armado
// de una vez. Cada gasto entra al Panel por su concepto de caja, y el concepto sale de:
//   - el RUBRO DEL INSUMO (para lo que tiene insumo: «esto es carne»), y
//   - el PROVEEDOR (para lo que no tiene insumo: alquiler, luz, contador).
// Acá se listan los rubros de insumo y los proveedores que todavía no tienen concepto, con una
// sugerencia (por nombre y por palabras conocidas) y ejemplos, para confirmar todo de un clic. No importa
// de qué sistema vengan las compras (cargadas a mano, MaxiRest, Fudo…).
//  - Rubro → concepto: lo guarda el endpoint de Sin rubro de siempre (sin-rubro-api.editarRubroInsumo),
//    que además corrige las facturas que habían quedado sin concepto.
//  - Proveedor → concepto: gestion_proveedores."conceptoCodigo" (migración 146) + corrige sus facturas
//    de Lazarillo sin concepto que no tienen insumos.
'use strict';

const { sql, db } = require('./db');
const { ORIGEN_LAZARILLO } = require('./facturas/armar');
const { ErrorDatos } = require('./dashboard/resultados-api');

const rechazo = (mensaje, status = 400) => { const e = new ErrorDatos(mensaje); e.status = status; return e; };
const txt = (v) => (v == null ? '' : String(v).trim());
const normalizar = (s) => txt(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Palabras → concepto (por nombre del concepto, normalizado). Sirve con los conceptos básicos
// (conceptos/base.js) y con cualquier concepto que se llame parecido.
const PISTAS = [
  [/carne|carnic|pollo|cerdo|vacun|frigor/, ['carnes', 'carniceria']],
  [/verdu|fruta|hortal/, ['verduleria y frutas', 'verduleria', 'frutas y verduras']],
  [/bebida|gaseos|cerveza|vino|aguas? mineral|licor/, ['bebidas']],
  [/lacteo|leche|queso|fiambre|chacinad/, ['lacteos y fiambres', 'lacteos', 'fiambres']],
  [/pan(aderia)?\b|harina|facturas? de pan/, ['panaderia']],
  [/descart|limpieza|envase|packag/, ['descartables y limpieza', 'limpieza', 'descartables']],
  [/almacen|seco|abarrot|aceite|condiment|especia/, ['almacen']],
  [/alquiler|inmobil/, ['alquiler', 'alquileres']],
  [/edenor|edesur|luz|electric|energia/, ['luz', 'energia electrica']],
  [/metrogas|naturgy|gas\b/, ['gas']],
  [/aysa|agua\b/, ['agua']],
  [/telecom|personal|movistar|claro|fibertel|internet|telefon/, ['internet y telefono', 'telefono e internet']],
  [/contador|estudio|honorar|abogad/, ['honorarios']],
  [/afip|arca|arba|agip|municip|impuesto|tasa/, ['impuestos y tasas', 'impuestos']],
  [/manten|reparac|plomer|electricista|tecnico/, ['mantenimiento y reparaciones', 'mantenimiento']],
];

/**
 * Concepto sugerido para un nombre (rubro de insumo o proveedor). conceptos: [{codigo, nombre}].
 * 1) mismo nombre; 2) pistas por palabras; 3) un concepto cuyo nombre contenga la palabra principal.
 */
function sugerirConcepto(nombre, conceptos) {
  const n = normalizar(nombre);
  if (!n) return null;
  const porNombre = new Map(conceptos.map((c) => [normalizar(c.nombre), c.codigo]));
  if (porNombre.has(n)) return porNombre.get(n);
  for (const [re, nombres] of PISTAS) {
    if (!re.test(n)) continue;
    for (const x of nombres) if (porNombre.has(x)) return porNombre.get(x);
  }
  const palabra = n.split(' ').find((w) => w.length >= 4);
  if (palabra) {
    const c = conceptos.find((k) => normalizar(k.nombre).split(' ').some((w) => w.length >= 4 && (w.startsWith(palabra) || palabra.startsWith(w))));
    if (c) return c.codigo;
  }
  return null;
}

const enOrg = (organizationId, alias = '') => sql`${sql.raw(alias ? `${alias}.` : '')}business_id IN (SELECT id FROM app_businesses WHERE organization_id = ${organizationId})`;

async function obtenerOrganizar({ organizationId }) {
  const [conceptos, rubros, proveedores] = await Promise.all([
    db.many(sql`
      SELECT c.codigo, TRIM(c.nombre) AS nombre, TRIM(r.nombre) AS rubro
        FROM gestion_conceptos_caja c
        LEFT JOIN gestion_rubros_concepto_caja r ON r.organization_id = c.organization_id AND r.codigo = c."codRga"
       WHERE c.organization_id = ${organizationId} AND COALESCE(c.tipo, '-') <> '+'
       ORDER BY r.nombre NULLS LAST, c.nombre`),
    // Rubros de insumo con insumos, su concepto actual y 3 ejemplos.
    db.many(sql`
      SELECT lr.codigo_maxi::text AS codigo, MAX(TRIM(lr.nombre)) AS nombre,
             MAX(COALESCE(lr.cpto_caja_lazarillo::text, NULLIF(NULLIF(lr.cpto_caja::text, ''), '0'))) AS concepto,
             EXISTS (SELECT 1 FROM insumo_rubro_conceptos a WHERE a.organization_id = ${organizationId} AND a.rubro_codigo = lr.codigo_maxi::text) AS varios,
             (SELECT COUNT(*)::int FROM insumos i WHERE ${enOrg(organizationId, 'i')} AND TRIM(i.rubro) = lr.codigo_maxi::text AND i.estado = 'activo') AS insumos,
             (SELECT array_agg(x.nombre) FROM (SELECT i.nombre FROM insumos i WHERE ${enOrg(organizationId, 'i')} AND TRIM(i.rubro) = lr.codigo_maxi::text
                AND i.estado = 'activo' ORDER BY i.nombre LIMIT 3) x) AS ejemplos
        FROM insumo_rubros lr
       WHERE ${enOrg(organizationId, 'lr')}
       GROUP BY lr.codigo_maxi`),
    // Proveedores con compras (o con concepto ya puesto), cuántas sin concepto y por cuánto.
    db.many(sql`
      SELECT p.id, TRIM(p.nombre) AS nombre, p."conceptoCodigo" AS concepto,
             COUNT(c."rowId")::int AS compras,
             COUNT(c."rowId") FILTER (WHERE COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") IS NULL)::int AS sin_concepto,
             COALESCE(SUM(COALESCE(c."importeManual", c.importe)) FILTER (WHERE COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") IS NULL), 0)::float8 AS importe_sin_concepto
        FROM gestion_proveedores p
        LEFT JOIN gestion_compras c ON c.codigo = p.codigo AND ${enOrg(organizationId, 'c')}
       WHERE p.organization_id = ${organizationId}
       GROUP BY p.id
      HAVING COUNT(c."rowId") > 0 OR p."conceptoCodigo" IS NOT NULL
       ORDER BY 5 DESC, p.nombre`),
  ]);
  const validos = new Set(conceptos.map((c) => c.codigo));
  return {
    conceptos,
    rubros: rubros.filter((r) => r.insumos > 0).map((r) => ({
      ...r, ejemplos: r.ejemplos || [],
      concepto: r.concepto && validos.has(r.concepto) ? r.concepto : null,
      sugerido: r.concepto && validos.has(r.concepto) ? null : sugerirConcepto(r.nombre, conceptos),
    })),
    proveedores: proveedores.map((p) => ({
      ...p,
      concepto: p.concepto && validos.has(p.concepto) ? p.concepto : null,
      sugerido: p.concepto && validos.has(p.concepto) ? null : sugerirConcepto(p.nombre, conceptos),
    })),
  };
}

/** Proveedor → concepto de caja (o null para sacarlo). Corrige sus facturas de Lazarillo sin concepto y sin insumos. */
async function editarProveedorConcepto({ organizationId, id, body }) {
  const pid = Number(id);
  if (!Number.isInteger(pid) || pid <= 0) throw rechazo('Proveedor inválido');
  let concepto = null;
  if (body?.concepto != null && body.concepto !== '') {
    concepto = String(Number(body.concepto));
    const c = await db.one(sql`SELECT 1 AS ok FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ${concepto}`);
    if (!c) throw rechazo('Ese concepto no está en el Panel', 404);
  }
  return db.transaction(async (tx) => {
    const p = await tx.one(sql`UPDATE gestion_proveedores SET "conceptoCodigo" = ${concepto}
                                WHERE organization_id = ${organizationId} AND id = ${pid} RETURNING codigo`);
    if (!p) throw rechazo('No existe ese proveedor', 404);
    let corregidas = 0;
    if (concepto) {
      // Sus facturas de Lazarillo sin concepto cuyos renglones no son insumos (los insumos van por su rubro).
      corregidas = await tx.execute(sql`
        UPDATE gestion_compras c SET "conceptoCodigoManual" = ${concepto}
         WHERE ${enOrg(organizationId, 'c')} AND c.codigo = ${p.codigo} AND c.origen = ${ORIGEN_LAZARILLO}
           AND COALESCE(c."conceptoCodigoManual", c."conceptoCodigo") IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM gestion_detalle_compras d
              WHERE d.business_id = c.business_id AND d."compraId" = c."rowId"
                AND EXISTS (SELECT 1 FROM insumos i WHERE ${enOrg(organizationId, 'i')}
                              AND regexp_replace(TRIM(i.codigo_maxi::text), '\\.0+$', '') = regexp_replace(TRIM(d.codigo::text), '\\.0+$', '')))`);
    }
    return { ok: true, corregidas };
  });
}

module.exports = { obtenerOrganizar, editarProveedorConcepto, sugerirConcepto };
