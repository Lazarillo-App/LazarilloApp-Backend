// services/precioCosteoInsumos.js
//
// Qué precio de compra se usa para actualizar insumos.precio_ref cuando entran
// compras nuevas (sync de Maxi o import de CSV). El negocio elige el modo en
// Configuración > Insumos ("Precio de costeo"); hasta acá ese valor se guardaba
// pero nada lo leía — las dos vías de importación de compras siempre pisaban
// precio_ref con el precio de la última compra, sin importar el modo elegido.
//
// Bonificaciones: ambos modos calculan el costo real por COMPROBANTE (importe
// total ÷ unidades recibidas, facturadas + bonificadas en $0), nunca por línea
// suelta — antes el filtro `precio > 0` descartaba las líneas bonificadas y
// una promo 2+1 dejaba precio_ref en el precio de lista completo, inflado,
// hasta que alguien abría el insumo a mano y confirmaba la bonificación
// (bonif_aceptada). Mismo criterio que ya usaba recalcularBonificaciones
// (bonificacionesService.js) solo para los insumos ya confirmados — ahora es
// el cálculo de base para todos, confirmados o no.
'use strict';

const pool = require('../config/db');

const MODOS_VALIDOS = ['ultima_compra', 'promedio_30', 'precio_db'];
const MODO_DEFAULT = 'ultima_compra';

// Lee el modo configurado para el negocio (app_businesses.props.precio_costeo_insumos).
// `runner` puede ser el pool o un client de una transacción en curso.
async function getModoCosteo(businessId, runner = pool) {
  const { rows } = await runner.query(
    `SELECT props->>'precio_costeo_insumos' AS modo FROM app_businesses WHERE id = $1`,
    [businessId]
  );
  const modo = rows[0]?.modo;
  return MODOS_VALIDOS.includes(modo) ? modo : MODO_DEFAULT;
}

// Para un conjunto de insumos con compras recién cargadas, calcula el precio
// que corresponde asignarles a precio_ref según el modo de costeo del negocio:
//   - 'ultima_compra' (default): precio de la compra más reciente.
//   - 'promedio_30': promedio de precios pagados en los últimos 30 días.
//   - 'precio_db': no se toca — el precio de referencia queda como un valor
//     fijo del sistema, ajeno a lo que entra por compras (devuelve null).
// `runner` puede ser el pool o un client de una transacción en curso.
async function calcularPreciosPorModo(runner, businessId, insumoIds, modo) {
  if (modo === 'precio_db') return null;
  if (!insumoIds?.length) return new Map();

  if (modo === 'promedio_30') {
    // Promedio ponderado por cantidad (importe total ÷ unidades totales) de
    // TODAS las líneas de los últimos 30 días, bonificadas incluidas — no un
    // promedio por fila, que pesaría igual una compra de 2 unidades que una
    // de 200 y seguiría ignorando las líneas en $0.
    const { rows } = await runner.query(
      `SELECT insumo_id, ROUND((SUM(precio_total) / NULLIF(SUM(cantidad), 0))::numeric, 4) AS precio
         FROM purchase_items pi
        WHERE business_id = $1
          AND insumo_id = ANY($2::int[])
          AND fecha >= CURRENT_DATE - INTERVAL '30 days'
          -- Un elaborado (receta propia activa) nunca saca precio_ref de una
          -- compra, aunque tenga líneas reales: su costo sale de la receta
          -- (propagarCostoInsumo). Sin este filtro, cualquier compra pegada a
          -- su codigo_maxi (real o por colisión de código) le pisa el costo
          -- calculado con un número que no tiene que ver con su receta.
          AND NOT EXISTS (
            SELECT 1 FROM recetas r
             WHERE r.insumo_id = pi.insumo_id AND r.business_id = pi.business_id AND r.active = TRUE
          )
        GROUP BY insumo_id
        HAVING SUM(precio_total) > 0`,
      [businessId, insumoIds]
    );
    return new Map(rows.map((r) => [Number(r.insumo_id), Number(r.precio)]));
  }

  // 'ultima_compra' — costo real del último COMPROBANTE (factura_key +
  // proveedor), no de la última línea: con una promo 2+1, la última línea
  // bonificada en $0 o la última facturada por separado dan un precio que no
  // es ni el de lista ni el real pagado por lo recibido.
  const { rows } = await runner.query(
    `WITH comp AS (
       SELECT pi.insumo_id, p.factura_key, p.proveedor_id,
              MAX(p.fecha) AS fecha, MAX(p.id) AS pid,
              SUM(pi.precio_total) AS importe, SUM(pi.cantidad) AS unidades
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
        WHERE pi.business_id = $1 AND pi.insumo_id = ANY($2::int[])
          -- Ver comentario equivalente en la rama 'promedio_30': un elaborado
          -- nunca saca precio_ref de una compra, sale de su receta.
          AND NOT EXISTS (
            SELECT 1 FROM recetas r
             WHERE r.insumo_id = pi.insumo_id AND r.business_id = pi.business_id AND r.active = TRUE
          )
        GROUP BY pi.insumo_id, p.factura_key, p.proveedor_id
     ),
     ultimo AS (
       SELECT DISTINCT ON (insumo_id) insumo_id, importe, unidades
         FROM comp
        WHERE unidades > 0
        ORDER BY insumo_id, fecha DESC, pid DESC
     )
     SELECT insumo_id, ROUND((importe / unidades)::numeric, 4) AS precio
       FROM ultimo
      WHERE importe > 0`,
    [businessId, insumoIds]
  );
  return new Map(rows.map((r) => [Number(r.insumo_id), Number(r.precio)]));
}

// Aplica el Map de precios (insumo_id → precio) a insumos.precio_ref de una,
// respetando bonif_aceptada (precio blindado a mano). Devuelve los ids
// efectivamente actualizados, para que el caller propague el costo en cascada.
async function aplicarPreciosCosteo(client, businessId, precios) {
  if (!precios || !precios.size) return [];
  const ids = [...precios.keys()];
  const valores = ids.map((id) => precios.get(id));
  const { rows } = await client.query(
    `UPDATE insumos i
        SET precio_ref = v.precio, updated_at = NOW()
       FROM UNNEST($1::int[], $2::numeric[]) AS v(insumo_id, precio)
      WHERE i.id = v.insumo_id
        AND i.business_id = $3
        AND i.bonif_aceptada IS NOT TRUE
      RETURNING i.id`,
    [ids, valores, businessId]
  );
  return rows.map((r) => Number(r.id));
}

module.exports = { MODOS_VALIDOS, MODO_DEFAULT, getModoCosteo, calcularPreciosPorModo, aplicarPreciosCosteo };
