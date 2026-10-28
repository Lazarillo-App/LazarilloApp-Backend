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

// Un mismo comprobante de MaxiRest puede entrar DOS veces a precios muy
// distintos — por caja/bulto (ej. 8 cajas a $4.982/caja) y por unidad suelta
// (ej. 120 botellas a $1.055/botella) — y la versión "por unidad" suele
// cargarse en el origen más tarde que la de "por caja". "Última compra" no
// puede confiar ciegamente en la fecha más reciente: mientras no llegue la
// gemela por unidad, el precio por caja (10-15x más alto) queda vigente. Un
// salto de esta magnitud contra lo que ya se pagaba ANTES de esa fecha nunca
// es una suba de precio real — se seguís mirando hacia atrás en el tiempo
// hasta encontrar un precio consistente con su propia historia.
const RATIO_PRECIO_SOSPECHOSO = 15;

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
          -- Un elaborado de verdad (receta propia activa CON ingredientes)
          -- nunca saca precio_ref de una compra, aunque tenga líneas reales:
          -- su costo sale de la receta (propagarCostoInsumo). El filtro exige
          -- ingredientes porque un insumo comprado directo puede tener una
          -- receta propia VACÍA (ej. de rendimiento/equivalencias, como
          -- "GINPAFF BOTELLA") — sin esa condición, un insumo real quedaría
          -- con precio_ref=0 apenas corriera el backfill de elaborados.
          AND NOT EXISTS (
            SELECT 1 FROM recetas r
             WHERE r.insumo_id = pi.insumo_id AND r.business_id = pi.business_id AND r.active = TRUE
               AND EXISTS (SELECT 1 FROM receta_items ri WHERE ri.receta_id = r.id)
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
  //
  // La base solo agrupa (igual de barato que antes); caminar hacia atrás
  // buscando un precio "razonable" se hace en Node, no en SQL — una función
  // de ventana calculando una mediana por cada fila, para insumos con 100+
  // compras históricas, es demasiado para una base con 0.1 CPU. En Node es
  // trivial incluso con cientos de filas por insumo.
  const { rows } = await runner.query(
    `SELECT pi.insumo_id, p.factura_key, p.proveedor_id,
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
             AND EXISTS (SELECT 1 FROM receta_items ri WHERE ri.receta_id = r.id)
        )
      GROUP BY pi.insumo_id, p.factura_key, p.proveedor_id`,
    [businessId, insumoIds]
  );

  const porInsumo = new Map();
  for (const r of rows) {
    const unidades = Number(r.unidades);
    const importe = Number(r.importe);
    if (!(unidades > 0) || !(importe > 0)) continue;
    const insumoId = Number(r.insumo_id);
    if (!porInsumo.has(insumoId)) porInsumo.set(insumoId, []);
    porInsumo.get(insumoId).push({
      fecha: r.fecha,
      diaKey: `${r.proveedor_id ?? ''}|${new Date(r.fecha).toISOString().slice(0, 10)}`,
      pid: Number(r.pid),
      precio: importe / unidades,
    });
  }

  const resultado = new Map();
  for (const [insumoId, gruposCrudos] of porInsumo) {
    // Mismo proveedor + mismo día a precios muy distintos = la misma factura
    // de MaxiRest entrando dos veces (por caja y por unidad suelta) — nunca
    // un proveedor cobra MÁS por unidad un día que compraste "al por mayor"
    // que lo que termina costando por unidad suelta. Nos quedamos con la más
    // barata de cada (proveedor, día) antes de elegir cuál es "la última
    // compra" — estructural, no depende de ajustar ningún umbral.
    const porDia = new Map();
    for (const g of gruposCrudos) {
      const actual = porDia.get(g.diaKey);
      if (!actual || g.precio < actual.precio) porDia.set(g.diaKey, g);
    }
    const grupos = [...porDia.values()];

    // Orden cronológico real (fecha asc, desempate por id de compra).
    grupos.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.pid - b.pid));
    // Caminando de más viejo a más nuevo: cada uno se mide contra la
    // mediana de SOLO lo que se pagó antes (nunca incluye la compra en sí
    // ni nada posterior) — esto todavía protege contra un gasto administrativo
    // mal matcheado que no comparte día con ninguna otra compra real.
    const previos = [];
    for (const g of grupos) {
      const medianaPrevia = previos.length ? mediana(previos) : null;
      g.esOutlier = medianaPrevia != null
        && Math.max(g.precio / medianaPrevia, medianaPrevia / g.precio) >= RATIO_PRECIO_SOSPECHOSO;
      previos.push(g.precio);
    }
    // El elegido: el más reciente que no haya quedado marcado como outlier.
    for (let i = grupos.length - 1; i >= 0; i--) {
      if (!grupos[i].esOutlier) {
        resultado.set(insumoId, Math.round(grupos[i].precio * 10000) / 10000);
        break;
      }
    }
  }
  return resultado;
}

function mediana(valores) {
  const ordenados = [...valores].sort((a, b) => a - b);
  const mid = Math.floor(ordenados.length / 2);
  return ordenados.length % 2 ? ordenados[mid] : (ordenados[mid - 1] + ordenados[mid]) / 2;
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

module.exports = {
  MODOS_VALIDOS, MODO_DEFAULT, getModoCosteo, calcularPreciosPorModo, aplicarPreciosCosteo,
  RATIO_PRECIO_SOSPECHOSO,
};
