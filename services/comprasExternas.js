// services/comprasExternas.js
//
// Compras que llegan de otro sistema (un POS: Fudo hoy, el que venga mañana) → facturas de Lazarillo
// (usuaria + Diego, 17/11/2026). No es de Fudo: cada conector traduce su formato a `compras` (abajo) y
// esto las carga por el MISMO camino que una factura cargada a mano en el Panel (carga-api.crearFactura):
//  - quedan en el Panel (Resultados, Conciliación, Sin rubro), EDITABLES como cualquier factura de
//    Lazarillo, con sus costos (puente-costos → precio de insumos → recetas);
//  - se traen una vez: lo que después se edite en Lazarillo manda (compras_externas recuerda cuáles);
//  - si ya está cargada en el Panel o vino por ARCA (mismo proveedor y fecha), no se suma.
//
// Concepto de caja de cada renglón (lo que hace que entre al Panel):
//  - con insumo: el concepto del rubro del insumo (insumo_rubros.cpto_caja_lazarillo, o el de MaxiRest);
//  - sin insumo (alquiler, luz): el concepto del proveedor (gestion_proveedores."conceptoCodigo"), y si
//    no tiene, el concepto de caja que se llame como la categoría del sistema;
//  - si no hay nada: sin concepto → «Sin rubro» del Panel, donde se asigna una vez.
//
// Forma de cada compra:
//   { externoId, fecha 'YYYY-MM-DD', total, categoria?, comprobante?,
//     proveedor: { nombre, cuit? },
//     renglones: [{ insumoId? (insumos.id de Lazarillo), nombre, cantidad?, neto }] }   // neto = total de la línea
'use strict';

const pool = require('../config/db');

const NOMBRES = { fudo: 'Fudo', wona: 'Wona' };
const txt = (v) => (v == null ? '' : String(v).trim());
const normalizar = (s) => txt(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const soloDigitos = (s) => txt(s).replace(/\D/g, '');
const r2 = (n) => Math.round(Number(n) * 100) / 100;

// ───────────────────────── puras (testeadas) ─────────────────────────

/** Número de comprobante para la factura: el del sistema si tiene dígitos, si no, el id externo. */
function numeroDeComprobante(compra) {
  const d = soloDigitos(compra.comprobante);
  if (d && Number(d) > 0) {
    const m = txt(compra.comprobante).match(/(\d{1,5})\D+(\d{1,8})\s*$/);
    if (m) return { prefijo: String(Number(m[1]) % 10000), numero: m[2] };
    return { prefijo: '0', numero: d.slice(-8) };
  }
  const id = soloDigitos(compra.externoId) || String(Math.abs([...txt(compra.externoId)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)));
  return { prefijo: '0', numero: id.slice(-8) };
}

/**
 * Registros de la factura (formato de facturas/armar.js) con su concepto de caja.
 * insumos: Map insumoId → {codigo, nombre, medida, concepto}; conceptoSinInsumo: el del proveedor/categoría.
 * Lo que la compra tenga de más sobre la suma de renglones (impuestos, percepciones) va en un renglón
 * aparte con el concepto sin insumo, así el total cuadra con el sistema.
 */
function registrosDeCompra(compra, { insumos, conceptoSinInsumo, puntoDeVentaId }) {
  const regs = [];
  const sinInsumo = (nombre, neto) => (conceptoSinInsumo
    ? { tipo: 'concepto', conceptoCodigo: conceptoSinInsumo, nombre, neto: r2(neto), alicuota: 0, puntoDeVentaId }
    : { tipo: 'insumo', conceptoCodigo: null, insumoCodigo: null, nombre, neto: r2(neto), alicuota: 0, puntoDeVentaId });
  for (const r of compra.renglones || []) {
    const neto = Number(r.neto) || 0;
    const ins = r.insumoId != null ? insumos.get(Number(r.insumoId)) : null;
    if (ins) {
      regs.push({
        tipo: 'insumo', conceptoCodigo: ins.concepto || null, insumoCodigo: ins.codigo || null,
        nombre: txt(r.nombre) || ins.nombre, medida: ins.medida || null,
        cantidad: Number(r.cantidad) > 0 ? Number(r.cantidad) : null, neto: r2(neto), alicuota: 0, puntoDeVentaId,
      });
    } else {
      regs.push(sinInsumo(txt(r.nombre) || txt(compra.categoria) || 'Gasto', neto));
    }
  }
  const suma = regs.reduce((s, r) => s + r.neto, 0);
  const resto = r2((Number(compra.total) || 0) - suma);
  if (resto > 0.5) regs.push(sinInsumo(regs.length ? 'Impuestos y otros' : (txt(compra.categoria) || 'Gasto'), resto));
  return regs.filter((r) => r.neto !== 0 || r.tipo === 'insumo');
}

// ───────────────────────── base ─────────────────────────

async function proveedorDe(organizationId, p, nombreOrigen, categoria) {
  // Sin proveedor en el sistema (pasa con alquiler, sueldos…): el proveedor se llama como la categoría,
  // así cada gasto tiene su propio concepto y no se mezclan todos en un «proveedor de Fudo».
  const nombre = (txt(p?.nombre) || txt(categoria) || `Gastos de ${nombreOrigen}`).slice(0, 120);
  const cuit = soloDigitos(p?.cuit);
  const { rows } = await pool.query(
    `SELECT id, codigo, nombre, cuit, "conceptoCodigo" FROM gestion_proveedores WHERE organization_id = $1
      ORDER BY (regexp_replace(COALESCE(cuit, ''), '\\D', '', 'g') = $2 AND $2 <> '') DESC, id`,
    [organizationId, cuit]);
  const hay = (cuit && rows.find((r) => soloDigitos(r.cuit) === cuit))
    || rows.find((r) => normalizar(r.nombre) === normalizar(nombre));
  if (hay) return hay;
  const { crearProveedor } = require('./gestion/carga-api');
  const nuevo = await crearProveedor({ organizationId, body: { nombre, cuit: cuit || null } });
  return { ...nuevo, conceptoCodigo: null };
}

/** Insumos de Lazarillo usados en las compras, con el concepto de caja de su rubro. */
async function insumosConConcepto(businessId, organizationId, ids, conceptosValidos) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT i.id, i.codigo_maxi, i.nombre, i.unidad_med,
            COALESCE(lr.cpto_caja_lazarillo::text, NULLIF(NULLIF(lr.cpto_caja::text, ''), '0')) AS concepto,
            EXISTS (SELECT 1 FROM insumo_rubro_conceptos a WHERE a.organization_id = $3 AND a.rubro_codigo = lr.codigo_maxi::text) AS varios
       FROM insumos i
       LEFT JOIN insumo_rubros lr ON lr.business_id = i.business_id AND lr.codigo_maxi::text = TRIM(i.rubro)
      WHERE i.business_id = $1 AND i.id = ANY($2::int[])`,
    [businessId, ids, organizationId]);
  return new Map(rows.map((r) => [Number(r.id), {
    codigo: /^\d+$/.test(txt(r.codigo_maxi)) ? txt(r.codigo_maxi) : null, // el puente a costos cruza por código numérico
    nombre: r.nombre, medida: r.unidad_med || null,
    // Rubro con varios conceptos posibles: se decide en Sin rubro, no se adivina.
    concepto: !r.varios && r.concepto && conceptosValidos.has(r.concepto) ? r.concepto : null,
  }]));
}

/**
 * Carga las compras de un sistema en el Panel. Devuelve { nuevas, repetidas, errores, sinConcepto }.
 * dryRun: no escribe nada, solo dice qué haría.
 */
async function importarCompras({ businessId, branchId = null, origen, compras, dryRun = false }) {
  const bid = Number(businessId);
  const nombreOrigen = NOMBRES[origen] || origen;
  const out = { nuevas: 0, repetidas: 0, errores: 0, sinConcepto: 0, detalle: [] };
  if (!compras?.length) return out;

  const { rows: b } = await pool.query('SELECT organization_id FROM app_businesses WHERE id = $1', [bid]);
  // Negocio nuevo sin organización: se le crea una, igual que al entrar al Panel (gestionRoutes).
  const organizationId = b[0]?.organization_id
    || (dryRun ? null : Number(await require('./gestion/organizacion-auto').asegurarOrganizacion(bid, null)) || null);
  if (!organizationId) return { ...out, error: 'negocio_sin_organizacion' };

  const { rows: ya } = await pool.query('SELECT externo_id FROM compras_externas WHERE business_id = $1 AND origen = $2', [bid, origen]);
  const hechas = new Set(ya.map((r) => r.externo_id));
  const pendientes = compras.filter((c) => !hechas.has(String(c.externoId)));
  if (!pendientes.length) return out;

  // Sin conceptos de caja (negocio sin MaxiRest): se copia la Plantilla Lazarillo (tablero #7) para
  // que el Panel quede armado y los rubros de insumo tengan su concepto.
  if (!dryRun) {
    const r = await require('./gestion/conceptos/plantilla').asegurarPlantillaSola(pool, { organizationId, businessId: bid });
    out.conceptosCreados = r.creados;
  }
  const { rows: cc } = await pool.query('SELECT codigo, nombre FROM gestion_conceptos_caja WHERE organization_id = $1', [organizationId]);
  const conceptosValidos = new Set(cc.map((c) => c.codigo));
  const conceptoPorNombre = new Map(cc.map((c) => [normalizar(c.nombre), c.codigo]));
  const insumoIds = [...new Set(pendientes.flatMap((c) => (c.renglones || []).map((r) => Number(r.insumoId)).filter(Number.isInteger)))];
  const insumos = await insumosConConcepto(bid, organizationId, insumoIds, conceptosValidos);
  const { idLugar, crearFactura } = require('./gestion/carga-api');
  const puntoDeVentaId = idLugar(bid, branchId);

  for (const compra of pendientes) {
    const externoId = String(compra.externoId);
    let prov = null;
    try {
      prov = dryRun ? { id: 0, codigo: '?', nombre: compra.proveedor?.nombre, conceptoCodigo: null } : await proveedorDe(organizationId, compra.proveedor, nombreOrigen, compra.categoria);
      // ¿Ya está en el Panel (cargada a mano, de MaxiRest o de ARCA)? Mismo proveedor y fecha. Se cuenta:
      // facturas de ese proveedor ese día en el Panel menos las ya emparejadas con este sistema (las que
      // cargó él y las que ya marcó repetidas). Así dos compras del mismo proveedor el mismo día entran
      // las dos, y una cargada a mano «se come» una sola.
      const { rows: rep } = dryRun ? { rows: [] } : await pool.query(
        `SELECT (SELECT COUNT(DISTINCT comprobante) FROM gestion_compras
                  WHERE business_id = $1 AND codigo = $2 AND COALESCE("fechaManual", fecha)::date = $3::date)
              - (SELECT COUNT(*) FROM compras_externas
                  WHERE business_id = $1 AND proveedor_id = $4 AND fecha = $3::date) AS libres`,
        [bid, prov.codigo, compra.fecha, prov.id]);
      if (Number(rep[0]?.libres) > 0) {
        out.repetidas++;
        await pool.query(
          `INSERT INTO compras_externas (business_id, origen, externo_id, estado, proveedor_id, fecha, total)
           VALUES ($1, $2, $3, 'repetida', $4, $5, $6) ON CONFLICT DO NOTHING`,
          [bid, origen, externoId, prov.id, compra.fecha, compra.total]);
        continue;
      }
      const conceptoSinInsumo = (prov.conceptoCodigo && conceptosValidos.has(prov.conceptoCodigo) && prov.conceptoCodigo)
        || conceptoPorNombre.get(normalizar(compra.categoria)) || null;
      const registros = registrosDeCompra(compra, { insumos, conceptoSinInsumo, puntoDeVentaId });
      if (!registros.length) continue;
      if (registros.some((r) => !r.conceptoCodigo)) out.sinConcepto++;
      const { prefijo, numero } = numeroDeComprobante(compra);
      const body = {
        proveedorId: prov.id, tipo: 'Ticket', prefijo, numero, fecha: compra.fecha,
        observacion: `Traída de ${nombreOrigen}${compra.categoria ? ` · ${txt(compra.categoria)}` : ''}`.slice(0, 200),
        registros, percepciones: [],
      };
      if (dryRun) { out.nuevas++; out.detalle.push({ externoId, proveedor: prov.nombre, body }); continue; }
      const r = await crearFactura({ organizationId, businessId: bid, usuario: nombreOrigen, body });
      await pool.query(
        `INSERT INTO compras_externas (business_id, origen, externo_id, estado, row_id, proveedor_id, fecha, total)
         VALUES ($1, $2, $3, 'cargada', $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
        [bid, origen, externoId, r?.rowId ?? null, prov.id, compra.fecha, compra.total]);
      out.nuevas++;
    } catch (e) {
      // «Esta factura ya está cargada» (409): mismo comprobante del mismo proveedor → repetida.
      if (e?.status === 409) {
        out.repetidas++;
        await pool.query(
          `INSERT INTO compras_externas (business_id, origen, externo_id, estado, proveedor_id, fecha, total) VALUES ($1, $2, $3, 'repetida', $4, $5, $6)
           ON CONFLICT DO NOTHING`, [bid, origen, externoId, prov?.id ?? null, compra.fecha, compra.total]).catch(() => {});
        continue;
      }
      out.errores++;
      out.detalle.push({ externoId, error: e?.message || String(e) });
      console.error(`[compras-externas] ${origen} ${bid} compra ${externoId}:`, e?.message || e);
    }
  }
  return out;
}

module.exports = { importarCompras, _numeroDeComprobante: numeroDeComprobante, _registrosDeCompra: registrosDeCompra };
