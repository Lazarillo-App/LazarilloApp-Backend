// Facturas que se repiten todos los meses (Diego 18/11/2026): en FC el colegio y la escuelita
// facturan una vez por mes $3-4 M. La proyección de ventas las proyecta aparte (no son ritmo del día)
// y las espera solo en los meses en que suelen facturar.
//
// Lazarillo los detecta solo, por PDV, con una sola regla para todos: desde que apareció (en los
// últimos 12 meses cerrados) el cliente facturó entre el 1 % y el 15 % de las ventas del mes en al
// menos 2 de cada 3 meses, y como mínimo 3 veces (facturas ≥ 0,5 % de las ventas del mes). Así entra
// el que factura casi siempre aunque saltee un mes (BigBox en Bar: 10 de 12) y también un cliente
// nuevo (3 de 3). Más del 15 % no es una factura aparte (en Palermo «palermo suites» es el 96 %).
// Probado el 18/11/2026 en todos los negocios: salen BigBox (Bar), escuelita y colegio (FC), nada más.
// Meses sugeridos: los que facturó en los últimos 12 meses cerrados; un mes en que todavía no era
// cliente se sugiere prendido. El usuario corrige meses / monto o agrega / saca clientes por PDV
// (gestion_clientes_recurrentes). Funciona igual con cualquier POS que traiga el cliente de la venta.
'use strict';

const { sql, db } = require('../db');
const { buildPivotConditions } = require('./query-builders');
const { toNumber } = require('./pivot-utils');

const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const IMP = sql`COALESCE(v."importeManual", v.importe)`;
const CLI = sql`lower(trim(COALESCE(NULLIF(v."cliRazon", ''), v."cliNombre")))`;
const RAW = sql`trim(COALESCE(NULLIF(v."cliRazon", ''), v."cliNombre"))`;
const GENERICOS = ['', 'consumidor final', 'cf'];

const normalizar = (t) => String(t ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const mesesValidos = (m) => Array.isArray(m) && m.length === 12 && m.every((x) => typeof x === 'boolean');

// "YYYY-MM-01" de hace k meses.
function mesAtras(mesActual, k) {
  const [y, m] = mesActual.split('-').map(Number);
  const t = y * 12 + (m - 1) - k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`;
}

/** Sucursal para la configuración: undefined («Todas») no se configura. */
const branchDe = (sucursal) => (sucursal === undefined ? undefined : sucursal ?? null);

/**
 * Clientes recurrentes del PDV, ya combinados con lo que corrigió el usuario.
 * @param mesActual "YYYY-MM-01" del mes que se proyecta; ultimo "YYYY-MM-DD" último día con ventas.
 */
async function clientesRecurrentes({ businessId, sucursal, mesActual, ultimo }) {
  const base = buildPivotConditions({ tableAlias: 'v', hasFechaManual: false, businessId, sucursal });
  const branch = branchDe(sucursal);
  const config = branch === undefined ? [] : await db.many(sql`
    SELECT cliente, nombre, meses, esperado, activo FROM gestion_clientes_recurrentes
    WHERE business_id = ${businessId} AND branch_id IS NOT DISTINCT FROM ${branch}::bigint
  `);
  const cfg = new Map(config.map((c) => [c.cliente, c]));
  const agregados = config.filter((c) => c.activo).map((c) => c.cliente);

  // 13 meses: los 12 de los sugeridos + uno antes, para saber si ya era cliente (15 ms en FC; con 24
  // meses eran 312 ms).
  const desde13 = mesAtras(mesActual, 13);
  const desde12 = mesAtras(mesActual, 12);
  const EN_RANGO = sql`mes >= ${desde12}::date AND imp BETWEEN 0.01 * tot AND 0.15 * tot`;
  const rango = [...base, sql`v.fecha >= ${desde13}::date`, sql`v.fecha < ${mesActual}::date`];
  const filas = await db.many(sql`
    WITH meses AS (
      SELECT date_trunc('month', v.fecha)::date AS mes, SUM(${IMP}) AS tot
      FROM gestion_ventas v WHERE ${sql.join(rango, ' AND ')} GROUP BY 1
    ),
    cm AS (
      SELECT m.mes, ${CLI} AS cliente, SUM(${IMP}) AS imp, MIN(m.tot) AS tot, MIN(${RAW}) AS nombre
      FROM gestion_ventas v JOIN meses m ON m.mes = date_trunc('month', v.fecha)::date
      WHERE ${sql.join(rango, ' AND ')} AND ${IMP} >= 0.005 * m.tot
      GROUP BY 1, 2
    )
    SELECT cliente,
           (array_agg(nombre ORDER BY mes DESC))[1] AS nombre,
           COUNT(*) FILTER (WHERE ${EN_RANGO}) AS n,
           to_char(MIN(mes) FILTER (WHERE ${EN_RANGO}), 'YYYY-MM-DD') AS desde,
           (array_agg(imp ORDER BY mes DESC) FILTER (WHERE mes >= ${desde12}::date))[1] AS esperado,
           array_agg(DISTINCT EXTRACT(MONTH FROM mes)::int) FILTER (WHERE mes >= ${desde12}::date) AS meses_con,
           json_agg(json_build_object('mes', to_char(mes, 'YYYY-MM'), 'imp', round(imp)) ORDER BY mes) FILTER (WHERE mes >= ${desde12}::date) AS historial,
           to_char(MIN(mes), 'YYYY-MM-DD') AS primer_mes
    FROM cm
    WHERE cliente IS NOT NULL AND NOT (cliente = ANY(${GENERICOS}::text[]))
    GROUP BY cliente
    HAVING COUNT(*) FILTER (WHERE ${EN_RANGO}) >= 3
        OR cliente = ANY(${agregados}::text[])
  `);

  // Meses cerrados desde que apareció (inclusive) → hay que estar en 2 de cada 3.
  const lapso = (desde) => (desde ? (Number(mesActual.slice(0, 4)) - Number(desde.slice(0, 4))) * 12 + Number(mesActual.slice(5, 7)) - Number(desde.slice(5, 7)) : 0);
  const detecta = (f) => Number(f.n) >= 3 && Number(f.n) * 3 >= 2 * lapso(f.desde);
  const agregadosSet = new Set(agregados);
  const porCliente = new Map(filas.filter((f) => detecta(f) || agregadosSet.has(f.cliente)).map((f) => [f.cliente, f]));
  // Agregados a mano que no facturaron en 13 meses: igual se listan (con su monto fijo).
  for (const c of agregados) if (!porCliente.has(c)) porCliente.set(c, { cliente: c, nombre: cfg.get(c)?.nombre, n: 0, desde: null, esperado: null, meses_con: [], primer_mes: null });

  const claves = [...porCliente.keys()];
  const ya = claves.length ? await db.many(sql`
    SELECT ${CLI} AS cliente, SUM(${IMP}) AS ya FROM gestion_ventas v
    WHERE ${sql.join([...base, sql`v.fecha >= ${mesActual}::date`, sql`v.fecha < ${ultimo}::date + 1`], ' AND ')}
      AND ${CLI} = ANY(${claves}::text[])
    GROUP BY 1
  `) : [];
  const yaDe = new Map(ya.map((r) => [r.cliente, toNumber(r.ya)]));

  const mesNum = Number(mesActual.slice(5, 7));
  const lista = [];
  for (const f of porCliente.values()) {
    const c = cfg.get(f.cliente);
    if (c && c.activo === false) continue;
    const con = new Set((f.meses_con ?? []).map(Number));
    // Mes k sugerido: facturó en su última vez (últimos 12 meses), o todavía no era cliente.
    const sugeridos = Array.from({ length: 12 }, (_, i) => {
      const k = i + 1;
      if (con.has(k)) return true;
      const vez = mesAtras(mesActual, ((mesNum - k + 12) % 12) || 12); // última vez que fue mes k
      return !f.primer_mes || vez < f.primer_mes;
    });
    const meses = c && mesesValidos(c.meses) ? c.meses : sugeridos;
    const historial = (f.historial ?? []).map((h) => ({ mes: h.mes, imp: toNumber(h.imp) }));
    const esperadoAuto = f.esperado != null ? toNumber(f.esperado) : 0;
    const esperado = c?.esperado != null ? toNumber(c.esperado) : esperadoAuto;
    lista.push({
      cliente: f.cliente,
      nombre: c?.nombre || f.nombre || f.cliente,
      detectado: detecta(f),
      configurado: !!c,
      meses,
      sugeridos,
      esperadoAuto,
      esperadoFijo: c?.esperado != null,
      esperado,
      ya: yaDe.get(f.cliente) ?? 0,
      // Lo facturado mes a mes (últimos 12 cerrados) y el promedio de los meses en que facturó.
      historial,
      promedio: historial.length ? Math.round(historial.reduce((a, h) => a + h.imp, 0) / historial.length) : 0,
      esteMes: !!meses[mesNum - 1],
    });
  }
  lista.sort((a, b) => b.esperado - a.esperado);
  return lista;
}

/** GET: para el editor (meses, montos y lo que sugiere Lazarillo). */
async function obtenerRecurrentes({ businessId, sucursal }) {
  const ult = await db.one(sql`
    SELECT to_char(MAX(v.fecha)::date, 'YYYY-MM-DD') AS ultimo FROM gestion_ventas v
    WHERE ${sql.join(buildPivotConditions({ tableAlias: 'v', hasFechaManual: false, businessId, sucursal }), ' AND ')}
  `);
  const ultimo = ult?.ultimo ?? new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
  const mesActual = `${ultimo.slice(0, 7)}-01`;
  const clientes = await clientesRecurrentes({ businessId, sucursal, mesActual, ultimo });
  return { mes: Number(mesActual.slice(5, 7)), editable: sucursal !== undefined, clientes };
}

/**
 * PUT: guarda lo que cambió el usuario. body.clientes = [{ cliente, nombre?, meses?: bool[12] | null,
 * esperado?: number | null, activo?: boolean }]. Un solo aviso en Notificaciones con lo que cambió.
 */
async function guardarRecurrentes({ businessId, sucursal, body, actorUserId = null }) {
  const branch = branchDe(sucursal);
  if (branch === undefined) throw Object.assign(new Error('Elegí una sucursal'), { status: 400, datos: true });
  const lista = Array.isArray(body?.clientes) ? body.clientes : null;
  if (!lista || !lista.length || lista.length > 50) throw Object.assign(new Error('Datos inválidos'), { status: 400, datos: true });
  const filas = lista.map((c) => ({
    cliente: normalizar(c.cliente),
    nombre: String(c.nombre ?? c.cliente ?? '').trim().slice(0, 120) || null,
    meses: c.meses == null ? null : c.meses,
    esperado: c.esperado == null || c.esperado === '' ? null : Number(c.esperado),
    activo: c.activo !== false,
  }));
  if (filas.some((f) => !f.cliente || f.cliente.length > 120 || GENERICOS.includes(f.cliente)
    || (f.meses != null && !mesesValidos(f.meses)) || (f.esperado != null && !(Number.isFinite(f.esperado) && f.esperado >= 0)))) {
    throw Object.assign(new Error('Datos inválidos'), { status: 400, datos: true });
  }
  await db.transaction(async (tx) => {
    for (const f of filas) {
      await tx.execute(sql`
        INSERT INTO gestion_clientes_recurrentes (business_id, branch_id, cliente, nombre, meses, esperado, activo, actualizado_por, actualizado_en)
        VALUES (${businessId}, ${branch}::bigint, ${f.cliente}, ${f.nombre}, ${f.meses}::boolean[], ${f.esperado}::numeric, ${f.activo}, ${actorUserId}, now())
        ON CONFLICT (business_id, COALESCE(branch_id, 0), cliente) DO UPDATE SET
          nombre = EXCLUDED.nombre, meses = EXCLUDED.meses, esperado = EXCLUDED.esperado, activo = EXCLUDED.activo,
          actualizado_por = EXCLUDED.actualizado_por, actualizado_en = now()
      `);
    }
  });
  const nombres = filas.map((f) => f.nombre || f.cliente);
  require('../../notificationService').avisarAlEquipo({
    businessId, actorUserId, type: 'clientes_recurrentes',
    title: filas.length === 1 ? `Facturas que se repiten: ${nombres[0]}` : `Facturas que se repiten: ${filas.length} clientes`,
    message: filas.map((f) => `${f.nombre || f.cliente}: ${!f.activo ? 'ya no se espera'
      : f.meses ? `meses ${f.meses.map((x, i) => (x ? NOMBRE_MES[i].slice(0, 3) : null)).filter(Boolean).join(', ') || 'ninguno'}` : 'meses sugeridos'}${f.esperado != null && f.activo ? ` · $ ${Math.round(f.esperado).toLocaleString('es-AR')}` : ''}`).join('\n'),
    metadata: { kind: 'clientes_recurrentes', sucursal: branch },
  }).catch((e) => console.error('[recurrentes] aviso', e?.message || e));
  return { ok: true, guardados: filas.length };
}

module.exports = { clientesRecurrentes, obtenerRecurrentes, guardarRecurrentes, mesAtras, NOMBRE_MES };
