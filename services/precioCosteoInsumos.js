// services/precioCosteoInsumos.js
//
// Qué precio de compra se usa para actualizar insumos.precio_ref cuando entran
// compras nuevas (sync de Maxi o import de CSV). El negocio elige el modo en
// Configuración > Insumos ("Precio de costeo"); hasta acá ese valor se guardaba
// pero nada lo leía — las dos vías de importación de compras siempre pisaban
// precio_ref con el precio de la última compra, sin importar el modo elegido.
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
    const { rows } = await runner.query(
      `SELECT insumo_id, AVG(precio)::numeric(14,4) AS precio
         FROM purchase_items
        WHERE business_id = $1
          AND insumo_id = ANY($2::int[])
          AND precio > 0
          AND fecha >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY insumo_id`,
      [businessId, insumoIds]
    );
    return new Map(rows.map((r) => [Number(r.insumo_id), Number(r.precio)]));
  }

  // 'ultima_compra'
  const { rows } = await runner.query(
    `SELECT DISTINCT ON (insumo_id) insumo_id, precio
       FROM purchase_items
      WHERE business_id = $1
        AND insumo_id = ANY($2::int[])
        AND precio > 0
      ORDER BY insumo_id, fecha DESC, id DESC`,
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
