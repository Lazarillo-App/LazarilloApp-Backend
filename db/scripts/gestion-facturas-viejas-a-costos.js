// db/scripts/gestion-facturas-viejas-a-costos.js
//
// Facturas cargadas a mano en el Panel ANTES del puente a costos (05/11/2026): las que se cargaron en
// lazarillo_gestion y llegaron con la migración (gestion_compras.origen = 'lazarillo'). Están en el
// Panel pero no en purchases, así que el costo de las recetas no las ve.
//
// La factura se arma desde sus filas guardadas (gestion_compras + gestion_detalle_compras), no desde
// lo que se tipeó: entra a costos lo mismo que muestra el Panel, con las ediciones. Pasa por la MISMA
// función que una factura nueva (services/gestion/facturas/puente-costos.js): no duplica lo que
// MaxiRest ya trajo, respeta envases, bonificaciones y el modo de costeo, y recalcula las recetas.
//
//   node db/scripts/gestion-facturas-viejas-a-costos.js [--negocio=147]
//       PRUEBA (solo lee): cuántas facturas entrarían, cuántas ya están (por MaxiRest o por el Panel),
//       renglones de insumo sin vincular, y qué insumos cambiarían su última compra (su precio).
//   node db/scripts/gestion-facturas-viejas-a-costos.js --aplicar --confirmo-host=<host de DATABASE_URL> [--negocio=147]
//       Escribe. Una transacción por factura, de la más vieja a la más nueva. Se puede volver a correr:
//       la que ya está en costos se saltea.
'use strict';

require('dotenv').config({ quiet: true });
const pool = require('../../config/db');
const { pasarFacturaACostos, claveDesdeComprobante, proveedorNumerico, resolverBizInsumos, mapaInsumos, facturaAplica } = require('../../services/gestion/facturas/puente-costos');

const APLICAR = process.argv.includes('--aplicar');
const argValor = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const HOST = argValor('confirmo-host');
const NEGOCIO = argValor('negocio') ? Number(argValor('negocio')) : null;
const iso = (f) => (f == null ? null : (typeof f === 'string' ? f : f.toISOString()).slice(0, 10));
const num = (v) => (v == null ? 0 : Number(v));

// Facturas del Panel: una por negocio + comprobante + proveedor (+ fecha, por los tickets Z).
async function leerFacturas(c) {
  const { rows } = await c.query(
    `SELECT c.business_id, b.organization_id, c.comprobante, c.codigo, min(c.fecha)::date::text AS fecha,
            json_agg(json_build_object('rowId', c."rowId", 'branch_id', c.branch_id, 'per1', c.per1, 'per2', c.per2,
                                       'per3', c.per3, 'impInt', c."impInt", 'importe', c.importe)) AS filas
       FROM gestion_compras c JOIN app_businesses b ON b.id = c.business_id
      WHERE c.origen = 'lazarillo' AND c.comprobante IS NOT NULL AND c.codigo IS NOT NULL
        AND ($1::bigint IS NULL OR c.business_id = $1)
      GROUP BY c.business_id, b.organization_id, c.comprobante, c.codigo,
               CASE WHEN c.comprobante ILIKE 'Z%' THEN c.fecha::date END
      ORDER BY min(c.fecha), c.business_id, c.comprobante`, [NEGOCIO]);
  return rows.filter((f) => facturaAplica(f.codigo));
}

async function leerLineas(c, f) {
  const { rows } = await c.query(
    `SELECT branch_id, codigo, nombre, medida, cantidad, "totalIns", "ivaTot", "impNtTot", tasa, "codCga", "nomCga", fecha
       FROM gestion_detalle_compras
      WHERE business_id = $1 AND comprobante = $2 AND "codPro" = $3
        AND (origen = 'lazarillo' OR "rowId" LIKE 'lz-%')
        AND ($4::boolean OR fecha::date = $5::date)
      ORDER BY "rowId"`,
    [f.business_id, f.comprobante, f.codigo, !/^Z/i.test(f.comprobante), f.fecha]);
  return rows;
}

// Lo que espera pasarFacturaACostos, a partir de lo guardado. El "lugar" de cada fila/renglón es su sucursal.
function armadoDesdeGuardado(f, lineas) {
  const lugar = (branchId) => (branchId == null ? 'principal' : String(branchId));
  const branchDe = new Map();
  for (const x of [...f.filas, ...lineas]) branchDe.set(lugar(x.branch_id), x.branch_id == null ? null : Number(x.branch_id));
  return {
    proveedorCodigo: f.codigo,
    f: { fecha: f.fecha },
    branchDe,
    armado: {
      filas: f.filas.map((x) => ({ comprobante: f.comprobante, puntoDeVentaId: lugar(x.branch_id), per1: num(x.per1), per2: num(x.per2), per3: num(x.per3), impInt: num(x.impInt) })),
      lineas: lineas.map((l) => ({
        puntoDeVentaId: lugar(l.branch_id), esInsumo: !!String(l.medida ?? '').trim(), codigo: l.codigo, nombre: l.nombre, medida: l.medida,
        cantidad: num(l.cantidad), totalIns: num(l.totalIns), ivaTot: num(l.ivaTot), impNtTot: num(l.impNtTot), tasa: num(l.tasa),
        codCga: l.codCga, nomCga: l.nomCga, fecha: iso(l.fecha) ?? f.fecha,
      })),
    },
  };
}

// ¿Ya está en costos? Por el Panel (misma clave) o por MaxiRest (misma consulta que el puente).
async function yaEsta(c, f, clave) {
  const { rows: panel } = await c.query(`SELECT 1 FROM purchases WHERE business_id = $1 AND factura_key = $2 AND source = 'lazarillo' LIMIT 1`, [f.business_id, clave]);
  if (panel.length) return 'panel';
  const proveedorId = proveedorNumerico(f.codigo);
  if (proveedorId == null) return null;
  const base = clave.split('~')[0];
  const { rows: maxi } = await c.query(
    `SELECT 1 FROM purchases
      WHERE business_id = $1 AND source IS DISTINCT FROM 'lazarillo' AND proveedor_id = $2
        AND regexp_replace(regexp_replace(UPPER(factura_key), '^NC[ABC]?', 'NC'), '-0+(?=[0-9])', '-', 'g') = $3
        AND ($4::boolean OR fecha::date = $5::date)
      LIMIT 1`,
    [f.business_id, proveedorId, base, !/^Z/.test(base), f.fecha]);
  return maxi.length ? 'maxirest' : null;
}

async function prueba(c, facturas) {
  const resumen = new Map(); // negocio → contadores
  const sinVincular = new Map();
  const cambianPrecio = new Map(); // insumo_id → { nombre, ultimaCompra, nuevaFecha }
  const cacheBiz = new Map();
  for (const f of facturas) {
    const r = resumen.get(f.business_id) ?? { facturas: 0, entran: 0, yaPanel: 0, yaMaxi: 0, sinClave: 0, sinRenglones: 0, renglonesInsumo: 0, insumosSinVincular: 0, desde: f.fecha, hasta: f.fecha };
    resumen.set(f.business_id, r);
    r.facturas += 1; r.hasta = f.fecha;
    const clave = claveDesdeComprobante(f.comprobante, f.codigo, f.fecha);
    if (!clave) { r.sinClave += 1; continue; }
    const ya = await yaEsta(c, f, clave);
    if (ya === 'panel') { r.yaPanel += 1; continue; }
    if (ya === 'maxirest') { r.yaMaxi += 1; continue; }
    const lineas = await leerLineas(c, f);
    if (!lineas.length) { r.sinRenglones += 1; continue; }
    r.entran += 1;
    if (!cacheBiz.has(f.business_id)) {
      const bizInsumos = await resolverBizInsumos(c, f.business_id);
      cacheBiz.set(f.business_id, { bizInsumos, mapa: await mapaInsumos(c, bizInsumos) });
    }
    const { mapa } = cacheBiz.get(f.business_id);
    for (const l of lineas.filter((x) => String(x.medida ?? '').trim())) {
      r.renglonesInsumo += 1;
      const cod = String(l.codigo ?? '').trim();
      const id = /^\d+$/.test(cod) ? mapa.get(Number(cod)) : undefined;
      if (id == null) { r.insumosSinVincular += 1; sinVincular.set(`${f.business_id}|${cod}|${l.nombre}`, (sinVincular.get(`${f.business_id}|${cod}|${l.nombre}`) ?? 0) + 1); continue; }
      const k = `${f.business_id}|${id}`;
      const prev = cambianPrecio.get(k);
      if (!prev || prev.nuevaFecha < f.fecha) cambianPrecio.set(k, { businessId: f.business_id, insumoId: id, nombre: l.nombre, nuevaFecha: f.fecha });
    }
  }
  console.log('\nPor negocio:');
  console.table([...resumen.entries()].map(([b, r]) => ({ negocio: b, ...r })));

  // Un insumo cambia de precio si la factura vieja es más nueva que su última compra en costos.
  const lista = [...cambianPrecio.values()];
  const cambian = [];
  for (const x of lista) {
    const { rows } = await c.query(
      `SELECT max(p.fecha)::date::text AS ultima FROM purchase_items pi JOIN purchases p ON p.id = pi.purchase_id
        WHERE p.business_id = $1 AND pi.insumo_id = $2`, [x.businessId, x.insumoId]);
    const ultima = rows[0]?.ultima ?? null;
    if (!ultima || ultima < x.nuevaFecha) cambian.push({ negocio: x.businessId, insumo: x.insumoId, nombre: x.nombre, ultimaCompraHoy: ultima ?? '(ninguna)', facturaPanel: x.nuevaFecha });
  }
  console.log(`\nInsumos que tocan las facturas: ${lista.length}. Cambiarían su última compra (y su precio): ${cambian.length}`);
  if (cambian.length) console.table(cambian.slice(0, 60));
  if (cambian.length > 60) console.log(`  … y ${cambian.length - 60} más`);
  if (sinVincular.size) {
    console.log(`\nRenglones de insumo sin vincular (no tienen insumo en Lazarillo con ese código): ${sinVincular.size} distintos`);
    console.table([...sinVincular.entries()].slice(0, 40).map(([k, n]) => { const [negocio, codigo, nombre] = k.split('|'); return { negocio, codigo, nombre, renglones: n }; }));
  }
}

async function aplicar(facturas) {
  let entraron = 0, salteadas = 0, fallaron = 0, precios = 0;
  for (const f of facturas) {
    const clave = claveDesdeComprobante(f.comprobante, f.codigo, f.fecha);
    if (!clave) { salteadas += 1; continue; }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      if (await yaEsta(c, f, clave)) { await c.query('ROLLBACK'); salteadas += 1; continue; }
      const lineas = await leerLineas(c, f);
      if (!lineas.length) { await c.query('ROLLBACK'); salteadas += 1; continue; }
      const r = await pasarFacturaACostos({ cliente: c }, { businessId: Number(f.business_id), organizationId: Number(f.organization_id) }, armadoDesdeGuardado(f, lineas));
      await c.query('COMMIT');
      if (r.aplicada) { entraron += 1; precios += r.precios ?? 0; } else salteadas += 1;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      fallaron += 1;
      console.log(`  FALLÓ ${f.business_id} ${f.comprobante} ${f.codigo} ${f.fecha}: ${e.message}`);
    } finally {
      c.release();
    }
    if ((entraron + salteadas + fallaron) % 50 === 0) console.log(`  … ${entraron + salteadas + fallaron}/${facturas.length}`);
  }
  console.log(`\nListo: ${entraron} facturas entraron a costos, ${salteadas} salteadas (ya estaban o sin renglones), ${fallaron} fallaron. Precios actualizados: ${precios}.`);
}

(async () => {
  const host = new URL(process.env.DATABASE_URL).hostname;
  if (APLICAR && HOST !== host) throw new Error(`para aplicar, confirmá el destino: --confirmo-host=${host}`);
  console.log(`${APLICAR ? 'APLICAR' : 'PRUEBA (solo lee)'} → ${host}${NEGOCIO ? ` · negocio ${NEGOCIO}` : ''}`);
  if (APLICAR) {
    const facturas = await leerFacturas(pool);
    console.log(`${facturas.length} facturas del Panel (origen lazarillo)`);
    await aplicar(facturas);
  } else {
    const c = await pool.connect();
    try {
      await c.query('BEGIN READ ONLY');
      const facturas = await leerFacturas(c);
      console.log(`${facturas.length} facturas del Panel (origen lazarillo)`);
      await prueba(c, facturas);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
  await pool.end();
})().catch(async (e) => { console.error('FALLA:', e.message); await pool.end().catch(() => {}); process.exit(1); });
