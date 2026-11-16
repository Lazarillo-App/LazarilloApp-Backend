// services/nombresDesdePos.js
//
// Nombre de los clientes de Mercado Pago desde el POS (tablero #57, Diego 14/11/2026: «MP no manda
// el nombre casi nunca»). En la venta detallada de MaxiRest (informe 22, lo sube el kit a Render)
// el CUPON de un cobro con Mercado Pago es el número de operación de MP, y CLINOMBRE es el cliente
// que cargó la caja. Si el cobro guardado (mp_pagos) no tiene nombre, se completa con ese.
//
// Se guarda en mp_pagos.extra.nombre (con extra.nombre_fuente = 'pos'): la columna calculada
// payer_nombre lo toma primero, así Clientes y la conciliación lo muestran sin cambiar nada más.
// Solo toca cobros SIN nombre: nunca pisa lo que mandó MP ni el reporte de liberaciones.
// Corre después de traer Mercado Pago (services/mercadopagoDiario.js), todos los días.
'use strict';

const pool = require('../config/db');
const { pdvsDeNegocio, refrescarPdvMap } = require('./maxiPdvMap');

const RE_IDENT = /^[a-z_][a-z0-9_]*$/;
const LOTE = 5000;

/** El cupón como lo guarda Render (número, a veces con ".0") → solo dígitos; '' si no sirve. */
function limpiarCupon(x) {
  const d = String(x == null ? '' : x).trim().replace(/\.0+$/, '').replace(/\D/g, '');
  return d.length >= 8 && !/^0+$/.test(d) ? d : '';
}

/** CLINOMBRE que sirve como nombre: no vacío ni genérico (consumidor final, varios, mostrador…). */
function nombreValido(x) {
  const s = String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
  if (s.length < 3 || !/[a-záéíóúñ]/i.test(s)) return '';
  if (/^(consumidor\s*final|cons\.?\s*final|c\.?\s*f\.?|varios|mostrador|cliente|clientes|sin\s*nombre|general|-+)$/i.test(s)) return '';
  return s.slice(0, 120);
}

/** Cobros de MP del negocio todavía sin nombre (sus números de operación). */
async function cobrosSinNombre(businessId) {
  const { rows } = await pool.query(
    `SELECT mp_id::text AS id FROM mp_pagos WHERE business_id = $1 AND rol = 'cobro' AND payer_nombre IS NULL`, [businessId]);
  return rows.map((r) => r.id);
}

/** cupón → nombre, buscando en todas las tablas del 22 de cada punto de venta del negocio. */
async function nombresDelPos(businessId, ids) {
  const out = new Map();
  for (const p of pdvsDeNegocio(businessId)) {
    if (!RE_IDENT.test(p.schema || '')) continue;
    const { rows: tablas } = await pool.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name ~ '^i22_ventas_detalladas_[0-9]{4}$' AND column_name IN ('pdv', 'cupon', 'clinombre')
        GROUP BY table_name HAVING count(*) = 3 ORDER BY table_name DESC`, [p.schema]);
    for (const { table_name: tabla } of tablas) {
      for (let i = 0; i < ids.length; i += LOTE) {
        const { rows } = await pool.query(
          `SELECT DISTINCT ON (c) c AS cupon, nombre FROM (
             SELECT regexp_replace(split_part(cupon::text, '.', 1), '[^0-9]', '', 'g') AS c, btrim(clinombre::text) AS nombre
               FROM "${p.schema}"."${tabla}"
              WHERE pdv = $1 AND cupon IS NOT NULL AND btrim(coalesce(clinombre::text, '')) <> '') x
            WHERE c = ANY($2::text[])`, [p.pdv, ids.slice(i, i + LOTE)]);
        for (const r of rows) {
          const nombre = nombreValido(r.nombre);
          const cupon = limpiarCupon(r.cupon);
          if (nombre && cupon && !out.has(cupon)) out.set(cupon, nombre);
        }
      }
    }
  }
  return out;
}

/** Completa los nombres que faltan. Devuelve { buscados, completados }. */
async function completar(businessId) {
  await refrescarPdvMap();
  if (!pdvsDeNegocio(businessId).length) return { buscados: 0, completados: 0 };
  const ids = (await cobrosSinNombre(businessId)).map(limpiarCupon).filter(Boolean);
  if (!ids.length) return { buscados: 0, completados: 0 };
  const nombres = await nombresDelPos(businessId, ids);
  if (!nombres.size) return { buscados: ids.length, completados: 0 };
  const lista = [...nombres].map(([cupon, nombre]) => ({ cupon, nombre }));
  const { rowCount } = await pool.query(
    `UPDATE mp_pagos m
        SET extra = COALESCE(m.extra, '{}'::jsonb) || jsonb_build_object('nombre', x->>'nombre', 'nombre_fuente', 'pos')
       FROM jsonb_array_elements($2::jsonb) x
      WHERE m.business_id = $1 AND m.rol = 'cobro' AND m.payer_nombre IS NULL AND m.mp_id = (x->>'cupon')::bigint`,
    [businessId, JSON.stringify(lista)]);
  return { buscados: ids.length, completados: rowCount };
}

module.exports = { completar, limpiarCupon, nombreValido };
