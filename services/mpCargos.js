// services/mpCargos.js
// Lo que descuenta Mercado Pago, al tablero solo (Diego 15/11/2026).
//
// - Cada cobro trae sus cargos (charges_details) y quién los cobra (accounts.to): la comisión de Mercado
//   Pago, los cargos de Mercado Libre y envíos, el pago a la app de un tercero y los impuestos que retiene
//   Mercado Pago. Lo que paga el COMPRADOR (procesamiento, recargo por cuotas) o pone ML (cupones) no es
//   costo del negocio: no se carga.
// - Fecha real: la del cargo; una devolución resta el día que se devolvió (así un día ya cargado no cambia).
// - Cada tipo de cargo va a un proveedor (de la organización) con su concepto de caja, elegido una vez.
// - Se carga como gasto vario PAGADO: un ticket del proveedor (9998-NNNNNNNN) por día, cuenta y tipo, con
//   un pago con la forma de pago del proveedor. Entra al Económico por su fecha y al Financiero por su pago.
// - Cuando llega la factura del proveedor (la carga MaxiRest o Lazarillo), los pagos de los tickets
//   anteriores a su fecha se le aplican (de a uno, el más viejo primero, hasta su saldo) y el ticket se
//   saca: el gasto queda en la factura y el pago en su fecha. Nunca se cuenta dos veces.
// - Apagado por defecto: hasta que la organización lo enciende, solo se muestra.
'use strict';

const { sql, db } = require('./gestion/db');

const ZONA = 'America/Argentina/Buenos_Aires';
const PREFIJO = '9998';
const USUARIO = 'Lazarillo · Mercado Pago';

// Tipos de cargo, en el orden en que se muestran.
const GRUPOS = [
  { grupo: 'comision_mp', nombre: 'Comisión de Mercado Pago', facturable: true, de: 'cuenta' },
  { grupo: 'cargos_ml', nombre: 'Cargos de Mercado Libre', facturable: true, de: 'ml' },
  { grupo: 'envios_ml', nombre: 'Envíos de Mercado Libre', facturable: true, de: 'ml' },
  { grupo: 'terceros', nombre: 'Pago a la app que trae la venta', facturable: true, de: null },
  { grupo: 'imp_debcred', nombre: 'Impuesto a los débitos y créditos', facturable: false, de: 'cuenta' },
  { grupo: 'imp_iibb', nombre: 'Retenciones de Ingresos Brutos', facturable: false, de: 'cuenta' },
  { grupo: 'imp_iget', nombre: 'Retención IGET', facturable: false, de: 'cuenta' },
];
const GRUPO = Object.fromEntries(GRUPOS.map((g) => [g.grupo, g]));

// Clasificación de un cargo (alias ch). NULL = no es costo del negocio.
const CASE_GRUPO = `CASE
  WHEN COALESCE(ch->'accounts'->>'from', '') NOT IN ('collector', 'application_owner') THEN NULL
  WHEN ch->>'name' LIKE 'tax%' AND ch->>'name' LIKE '%debitos_creditos%' THEN 'imp_debcred'
  WHEN ch->>'name' LIKE 'tax%' AND ch->>'name' LIKE '%iget%' THEN 'imp_iget'
  WHEN ch->>'name' LIKE 'tax%' THEN 'imp_iibb'
  WHEN ch->'accounts'->>'to' = 'mp' THEN 'comision_mp'
  WHEN ch->'accounts'->>'to' = 'ml' THEN 'cargos_ml'
  WHEN ch->>'name' LIKE 'shp%' THEN 'envios_ml'
  ELSE 'terceros' END`;

// Movimientos de cargos por día (local), cuenta y tipo, de un negocio, en [desde, hasta].
// Los cargos de un cobro viejo pueden devolverse mucho después: se miran cobros de hasta 180 días antes.
// Devuelto sin detalle de la devolución (sin refund_charges): resta el día de la última actualización del cargo.
function sqlDiario(businessId, desde, hasta) {
  return sql`
    WITH c AS (
      SELECT p.business_id, p.sucursal, p.cuenta, ch, ${sql.raw(CASE_GRUPO)} AS grupo
        FROM mp_pagos p, jsonb_array_elements(COALESCE(p.raw->'charges_details', '[]'::jsonb)) ch
       WHERE p.business_id = ${businessId} AND p.rol = 'cobro' AND p.cuenta IS NOT NULL
         AND p.fecha >= ${desde}::date - 180 AND p.fecha <= ${hasta}::date + 1
    ), mov AS (
      SELECT business_id, sucursal, cuenta, grupo,
             ((ch->>'date_created')::timestamptz AT TIME ZONE ${ZONA})::date AS fecha,
             COALESCE((ch->'amounts'->>'original')::numeric, 0) AS importe
        FROM c WHERE grupo IS NOT NULL
      UNION ALL
      SELECT business_id, sucursal, cuenta, grupo, ((r->>'date_created')::timestamptz AT TIME ZONE ${ZONA})::date, -COALESCE((r->>'amount')::numeric, 0)
        FROM c, jsonb_array_elements(COALESCE(ch->'refund_charges', '[]'::jsonb)) r WHERE grupo IS NOT NULL
      UNION ALL
      SELECT business_id, sucursal, cuenta, grupo, ((COALESCE(ch->>'last_updated', ch->>'date_created'))::timestamptz AT TIME ZONE ${ZONA})::date,
             -(ch->'amounts'->>'refunded')::numeric
        FROM c WHERE grupo IS NOT NULL AND COALESCE((ch->'amounts'->>'refunded')::numeric, 0) <> 0
         AND jsonb_array_length(COALESCE(ch->'refund_charges', '[]'::jsonb)) = 0
    )
    SELECT sucursal, cuenta::text AS cuenta, grupo, to_char(fecha, 'YYYY-MM-DD') AS fecha, ROUND(SUM(importe), 2)::float8 AS importe
      FROM mov WHERE fecha BETWEEN ${desde}::date AND ${hasta}::date
     GROUP BY 1, 2, 3, 4 HAVING ROUND(SUM(importe), 2) <> 0
     ORDER BY 4, 1, 2, 3`;
}

// Sin JIT: el planner estima 100 cargos por cobro y compila la consulta (1,2 s de los 1,5 s que tardaba un
// mes del Bar en la base real); sin él tarda ~0,3 s.
const diario = (businessId, desde, hasta) => db.transaction(async (tx) => {
  await tx.execute(sql`SET LOCAL jit = off`);
  return tx.many(sqlDiario(businessId, desde, hasta));
});

const hoyAR = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const masDias = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;

async function orgDe(businessId) {
  const r = await db.one(sql`SELECT organization_id FROM app_businesses WHERE id = ${businessId}`);
  return r ? Number(r.organization_id) : null;
}

/** Proveedor y concepto de cada tipo: lo elegido, o el sugerido (la cuenta / «Mercado Libre»). */
async function configDe(organizationId, businessId) {
  const [org, filas, ml, cuentas, conceptos] = await Promise.all([
    db.one(sql`SELECT activo, to_char(desde, 'YYYY-MM-DD') AS desde FROM mp_cargos_org WHERE organization_id = ${organizationId}`),
    db.many(sql`SELECT grupo, proveedor_cod, concepto_codigo FROM mp_cargos_config WHERE organization_id = ${organizationId}`),
    db.one(sql`SELECT codigo FROM gestion_proveedores WHERE organization_id = ${organizationId} AND LOWER(TRIM(nombre)) = 'mercado libre' ORDER BY id LIMIT 1`),
    db.many(sql`SELECT sucursal, mp_user_id::text AS cuenta, proveedor_cod, COALESCE(mp_nickname, mp_email, mp_user_id::text) AS nombre FROM integraciones_mercadopago WHERE business_id = ${businessId}`),
    db.many(sql`SELECT codigo, nombre FROM gestion_conceptos_caja WHERE organization_id = ${organizationId}`),
  ]);
  const elegido = Object.fromEntries(filas.map((f) => [f.grupo, f]));
  const nombreConcepto = new Map(conceptos.map((c) => [String(c.codigo).trim(), String(c.nombre).trim()]));
  const deCuenta = cuentas.find((c) => c.proveedor_cod)?.proveedor_cod || null;
  const grupos = GRUPOS.map((g) => {
    const e = elegido[g.grupo] || {};
    const sugerido = g.de === 'cuenta' ? deCuenta : g.de === 'ml' ? ml?.codigo || null : null;
    const concepto = e.concepto_codigo && nombreConcepto.has(e.concepto_codigo) ? e.concepto_codigo : null;
    return { ...g, proveedorElegido: e.proveedor_cod || null, proveedorSugerido: sugerido, proveedor: e.proveedor_cod || sugerido, concepto, conceptoNombre: concepto ? nombreConcepto.get(concepto) : null };
  });
  return { activo: !!org?.activo, desde: org?.desde || null, grupos, cuentas };
}

/** Pantalla: los tipos de cargo del mes con su total, proveedor, concepto y lo cargado. */
async function resumen(businessId, mes) {
  const organizationId = await orgDe(businessId);
  if (!organizationId) return { error: 'negocio_inexistente' };
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(mes || '') ? mes : hoyAR().slice(0, 7);
  const desde = `${m}-01`;
  const hasta = masDias(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 10), -1);
  const [cfg, dias, cargados, proveedores, noCosto, avisos] = await Promise.all([
    configDe(organizationId, businessId),
    diario(businessId, desde, hasta),
    db.many(sql`SELECT grupo, COUNT(*) FILTER (WHERE comprobante IS NOT NULL)::int AS n, COALESCE(SUM(importe) FILTER (WHERE comprobante IS NOT NULL), 0)::float8 AS cargado,
                       COALESCE(SUM(importe) FILTER (WHERE absorbido_en IS NOT NULL), 0)::float8 AS facturado
                  FROM mp_cargos_cargados WHERE business_id = ${businessId} AND fecha BETWEEN ${desde}::date AND ${hasta}::date GROUP BY 1`),
    db.many(sql`SELECT codigo, nombre, "medioPago" FROM gestion_proveedores WHERE organization_id = ${organizationId} ORDER BY nombre`),
    db.one(sql`
      SELECT COALESCE(SUM(((ch->'amounts'->>'original')::numeric - COALESCE((ch->'amounts'->>'refunded')::numeric, 0))), 0)::float8 AS t
        FROM mp_pagos p, jsonb_array_elements(COALESCE(p.raw->'charges_details', '[]'::jsonb)) ch
       WHERE p.business_id = ${businessId} AND p.rol = 'cobro' AND p.fecha BETWEEN ${desde}::date AND ${hasta}::date
         AND COALESCE(ch->'accounts'->>'from', '') NOT IN ('collector', 'application_owner')`),
    db.one(sql`SELECT COUNT(*)::int AS dias_negativos FROM mp_cargos_cargados WHERE business_id = ${businessId} AND comprobante IS NULL AND fecha BETWEEN ${desde}::date AND ${hasta}::date`),
  ]);
  const nombreProv = new Map(proveedores.map((p) => [p.codigo, p]));
  const total = {};
  for (const d of dias) total[d.grupo] = r2((total[d.grupo] || 0) + d.importe);
  const hechos = Object.fromEntries(cargados.map((c) => [c.grupo, c]));
  const grupos = cfg.grupos.map((g) => ({
    grupo: g.grupo, nombre: g.nombre, facturable: g.facturable,
    total: total[g.grupo] || 0,
    proveedor: g.proveedor ? { codigo: g.proveedor, nombre: nombreProv.get(g.proveedor)?.nombre?.trim() || g.proveedor, medioPago: nombreProv.get(g.proveedor)?.medioPago || null } : null,
    proveedorSugerido: !g.proveedorElegido && !!g.proveedor,
    concepto: g.concepto ? { codigo: g.concepto, nombre: g.conceptoNombre } : null,
    cargado: hechos[g.grupo]?.cargado || 0, tickets: hechos[g.grupo]?.n || 0, facturado: hechos[g.grupo]?.facturado || 0,
  }));
  return { mes: m, activo: cfg.activo, desde: cfg.desde, grupos, noEsCosto: r2(noCosto?.t || 0), cuentas: cfg.cuentas.length, diasNegativos: avisos?.dias_negativos || 0 };
}

/** Elegir proveedor y/o concepto de un tipo de cargo (vale para toda la organización). */
async function configurar(businessId, { grupo, proveedor, concepto } = {}) {
  if (!GRUPO[grupo]) return { error: 'grupo_invalido' };
  const organizationId = await orgDe(businessId);
  if (proveedor) {
    const p = await db.one(sql`SELECT codigo, nombre FROM gestion_proveedores WHERE organization_id = ${organizationId} AND codigo = ${String(proveedor)}`);
    if (!p) return { error: 'proveedor_inexistente' };
  }
  if (concepto) {
    const c = await db.one(sql`SELECT codigo FROM gestion_conceptos_caja WHERE organization_id = ${organizationId} AND codigo = ${String(concepto)}`);
    if (!c) return { error: 'concepto_inexistente' };
  }
  const antes = await db.one(sql`SELECT proveedor_cod, concepto_codigo FROM mp_cargos_config WHERE organization_id = ${organizationId} AND grupo = ${grupo}`);
  const prov = proveedor === undefined ? antes?.proveedor_cod ?? null : proveedor || null;
  const conc = concepto === undefined ? antes?.concepto_codigo ?? null : concepto || null;
  await db.execute(sql`
    INSERT INTO mp_cargos_config (organization_id, grupo, proveedor_cod, concepto_codigo) VALUES (${organizationId}, ${grupo}, ${prov}, ${conc})
    ON CONFLICT (organization_id, grupo) DO UPDATE SET proveedor_cod = EXCLUDED.proveedor_cod, concepto_codigo = EXCLUDED.concepto_codigo, actualizado_at = now()`);
  return { ok: true, grupo, nombre: GRUPO[grupo].nombre, antes: antes || null, proveedor: prov, concepto: conc };
}

/** Encender / apagar la carga para la organización. Al encender, «desde» es el primer día que se carga. */
async function activar(businessId, { activo, desde } = {}, usuario = null) {
  const organizationId = await orgDe(businessId);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(desde || '') ? desde : `${hoyAR().slice(0, 7)}-01`;
  await db.execute(sql`
    INSERT INTO mp_cargos_org (organization_id, activo, desde, actualizado_por) VALUES (${organizationId}, ${!!activo}, ${d}::date, ${usuario})
    ON CONFLICT (organization_id) DO UPDATE SET activo = EXCLUDED.activo,
      desde = CASE WHEN EXCLUDED.activo THEN COALESCE(mp_cargos_org.desde, EXCLUDED.desde) ELSE mp_cargos_org.desde END,
      actualizado_at = now(), actualizado_por = EXCLUDED.actualizado_por`);
  const r = await db.one(sql`SELECT activo, to_char(desde, 'YYYY-MM-DD') AS desde FROM mp_cargos_org WHERE organization_id = ${organizationId}`);
  return { ok: true, ...r };
}

// La forma de pago del proveedor (o «Mercado Pago»), creada en el negocio si no existe.
async function medioDe(tx, businessId, proveedorCod, organizationId) {
  const p = await tx.one(sql`SELECT "medioPago" FROM gestion_proveedores WHERE organization_id = ${organizationId} AND codigo = ${proveedorCod}`);
  const nombre = p?.medioPago?.trim() || 'Mercado Pago';
  const m = await tx.one(sql`SELECT nombre, activo FROM gestion_medios_pago WHERE business_id = ${businessId} AND LOWER(nombre) = LOWER(${nombre})`);
  if (m) {
    if (!m.activo) await tx.execute(sql`UPDATE gestion_medios_pago SET activo = true WHERE business_id = ${businessId} AND nombre = ${m.nombre}`);
    return m.nombre;
  }
  await tx.execute(sql`INSERT INTO gestion_medios_pago (business_id, nombre, tipo) VALUES (${businessId}, ${nombre}, 'banco') ON CONFLICT DO NOTHING`);
  return nombre;
}

/**
 * Carga lo que falta de un negocio (si la organización lo encendió): días completos desde «desde» hasta ayer,
 * y solo los ya traídos de cada cuenta. Después pasa a las facturas lo que ya se facturó.
 */
async function cargarNegocio(businessId) {
  const organizationId = await orgDe(businessId);
  if (!organizationId) return { cargados: 0 };
  const cfg = await configDe(organizationId, businessId);
  if (!cfg.activo || !cfg.desde) return { cargados: 0, apagado: true };
  const carga = require('./gestion/carga-api');
  const ayer = masDias(hoyAR(), -1);
  if (ayer < cfg.desde) return { cargados: 0 };
  const hastaCuenta = new Map((await db.many(sql`
    SELECT sucursal, mp_user_id::text AS cuenta, to_char(ultimo_sync_hasta, 'YYYY-MM-DD') AS hasta FROM integraciones_mercadopago WHERE business_id = ${businessId}`))
    .map((c) => [`${c.sucursal}|${c.cuenta}`, c.hasta]));
  const nombreCuenta = new Map(cfg.cuentas.map((c) => [`${c.sucursal}|${c.cuenta}`, c.nombre]));
  const porGrupo = Object.fromEntries(cfg.grupos.map((g) => [g.grupo, g]));
  const hechos = new Set((await db.many(sql`
    SELECT sucursal, cuenta::text AS cuenta, grupo, to_char(fecha, 'YYYY-MM-DD') AS fecha FROM mp_cargos_cargados
     WHERE business_id = ${businessId} AND fecha >= ${cfg.desde}::date`)).map((x) => `${x.sucursal}|${x.cuenta}|${x.grupo}|${x.fecha}`));
  const dias = await diario(businessId, cfg.desde, ayer);
  let cargados = 0, total = 0;
  const errores = [];
  for (const d of dias) {
    const clave = `${d.sucursal}|${d.cuenta}|${d.grupo}|${d.fecha}`;
    if (hechos.has(clave)) continue;
    const hasta = hastaCuenta.get(`${d.sucursal}|${d.cuenta}`);
    if (!hasta || d.fecha > hasta) continue; // ese día todavía no se trajo entero
    const g = porGrupo[d.grupo];
    if (!g?.proveedor || !g.concepto) continue; // falta elegir proveedor o concepto: se carga cuando estén
    if (d.importe < 0) {
      // un día con más devoluciones que cargos: queda anotado (se ve en la pantalla), sin ticket
      await db.execute(sql`
        INSERT INTO mp_cargos_cargados (business_id, sucursal, cuenta, fecha, grupo, importe, proveedor_cod)
        VALUES (${businessId}, ${d.sucursal}, ${d.cuenta}::bigint, ${d.fecha}::date, ${d.grupo}, ${d.importe}::numeric, ${g.proveedor}) ON CONFLICT DO NOTHING`);
      continue;
    }
    try {
      await cargarDia(carga, { organizationId, businessId, dia: d, grupo: g, cuentaNombre: nombreCuenta.get(`${d.sucursal}|${d.cuenta}`) || d.cuenta });
      cargados += 1; total = r2(total + d.importe);
    } catch (e) {
      errores.push(`${d.fecha} ${d.grupo}: ${e.message}`);
      if (errores.length > 5) break;
    }
  }
  if (errores.length) console.error('[mp-cargos] negocio', businessId, errores);
  const abs = await absorberNegocio(businessId, organizationId).catch((e) => { console.error('[mp-cargos] absorber', businessId, e.message); return { pasados: 0 }; });
  if (cargados || abs.pasados) {
    const { avisarAlEquipo } = require('./notificationService');
    const partes = [];
    if (cargados) partes.push(`${cargados} gasto${cargados === 1 ? '' : 's'} de Mercado Pago cargado${cargados === 1 ? '' : 's'} ($ ${total.toLocaleString('es-AR')})`);
    if (abs.pasados) partes.push(`${abs.pasados} pago${abs.pasados === 1 ? '' : 's'} aplicado${abs.pasados === 1 ? '' : 's'} a ${abs.facturas} factura${abs.facturas === 1 ? '' : 's'}`);
    await avisarAlEquipo({ businessId, type: 'mp_cargos', title: `Mercado Pago: ${partes.join(' · ')}`, metadata: { link: '/movimientos-bancarios?tab=descuentos' }, clave: `mp_cargos:${businessId}`, agruparMin: 720 }).catch(() => {});
  }
  return { cargados, total, errores, ...abs };
}

// Un día de un tipo de cargo: ticket del proveedor con su concepto + pago, en una transacción.
async function cargarDia(carga, { organizationId, businessId, dia, grupo, cuentaNombre }) {
  const ctx = { organizationId, businessId };
  return carga.conReparto(ctx, async (tx, ids) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`mp-cargos:${businessId}`}))`);
    const ya = await tx.one(sql`SELECT 1 AS si FROM mp_cargos_cargados WHERE business_id = ${businessId} AND sucursal = ${dia.sucursal} AND cuenta = ${dia.cuenta}::bigint AND fecha = ${dia.fecha}::date AND grupo = ${grupo.grupo}`);
    if (ya) return null;
    const prov = await tx.one(sql`SELECT id, codigo FROM gestion_proveedores WHERE organization_id = ${organizationId} AND codigo = ${grupo.proveedor}`);
    if (!prov) throw new Error('proveedor inexistente');
    const lugares = await carga.obtenerLugares(tx, businessId);
    const lugar = lugares.find((l) => l.branchId === Number(dia.sucursal)) || lugares[0];
    const mayor = await tx.one(sql`
      SELECT MAX(comprobante) AS m FROM gestion_compras WHERE business_id = ${businessId} AND codigo = ${prov.codigo} AND comprobante ~ ${`^Z${PREFIJO}[0-9]{8}$`}`);
    const numero = String((mayor?.m ? Number(mayor.m.slice(-8)) : 0) + 1);
    const medio = await medioDe(tx, businessId, prov.codigo, organizationId);
    const p = await carga.prepararFactura(tx, ctx, {
      proveedorId: prov.id, tipo: 'Ticket', prefijo: PREFIJO, numero, fecha: dia.fecha,
      observacion: `Mercado Pago · ${cuentaNombre} · ${grupo.nombre}`.slice(0, 200),
      registros: [{ tipo: 'concepto', conceptoCodigo: grupo.concepto, nombre: grupo.conceptoNombre, neto: dia.importe, alicuota: 0, impInt: 0, puntoDeVentaId: lugar.id, reparto: null }],
      percepciones: [], impIntGeneral: 0,
    });
    const pago = await carga.altaEnTx(tx, ctx, p, { fecha: dia.fecha, medio, referencia: null }, USUARIO,
      (nombre) => `${p.nombreProv}\n${[grupo.nombre, cuentaNombre, nombre, `$ ${dia.importe.toLocaleString('es-AR')}`].filter(Boolean).join(' · ')}`);
    ids.push(...p.armado.filas.map((x) => x.rowId));
    await tx.execute(sql`
      INSERT INTO mp_cargos_cargados (business_id, sucursal, cuenta, fecha, grupo, importe, proveedor_cod, comprobante, pago_id)
      VALUES (${businessId}, ${dia.sucursal}, ${dia.cuenta}::bigint, ${dia.fecha}::date, ${grupo.grupo}, ${dia.importe}::numeric, ${prov.codigo},
              ${p.armado.filas[0].comprobante}, ${pago?.id ?? null})`);
    return { comprobante: p.armado.filas[0].comprobante, pago: pago?.id };
  });
}

/**
 * Llegó la factura del proveedor: los pagos de los tickets (de cargos que se facturan) de fecha anterior o
 * igual a la factura se le aplican, el más viejo primero, mientras entren en su saldo; el ticket se saca.
 * Solo facturas desde «desde» y sin pagos de MaxiRest (esas ya están pagas).
 */
async function absorberNegocio(businessId, organizationId) {
  const facturables = GRUPOS.filter((g) => g.facturable).map((g) => g.grupo);
  const pendientes = await db.many(sql`
    SELECT k.sucursal, k.cuenta::text AS cuenta, k.grupo, to_char(k.fecha, 'YYYY-MM-DD') AS fecha, k.importe::float8 AS importe, k.proveedor_cod, k.comprobante, k.pago_id
      FROM mp_cargos_cargados k
     WHERE k.business_id = ${businessId} AND k.absorbido_en IS NULL AND k.comprobante IS NOT NULL AND k.pago_id IS NOT NULL
       AND k.grupo = ANY(${facturables}::text[])
     ORDER BY k.fecha, k.sucursal, k.cuenta, k.grupo`);
  if (!pendientes.length) return { pasados: 0, facturas: 0 };
  const org = await db.one(sql`SELECT to_char(desde, 'YYYY-MM-DD') AS desde FROM mp_cargos_org WHERE organization_id = ${organizationId}`);
  let pasados = 0;
  const usadas = new Set();
  for (const prov of [...new Set(pendientes.map((x) => x.proveedor_cod))]) {
    const cola = pendientes.filter((x) => x.proveedor_cod === prov);
    // Facturas del proveedor (no tickets ni NC), con su saldo según lo aplicado en Lazarillo.
    const facturas = await db.many(sql`
      SELECT c.branch_id::text AS branch_id, c.comprobante, to_char(MIN(c.fecha), 'YYYY-MM-DD') AS fecha,
             SUM(COALESCE(c."importeManual", c.importe))::float8
             - COALESCE((SELECT SUM(a.importe) FROM gestion_aplicaciones_pago_proveedor a JOIN gestion_pagos_proveedor pp ON pp.id = a."pagoId" AND pp."anuladoEn" IS NULL
                          WHERE a.business_id = ${businessId} AND a.branch_id IS NOT DISTINCT FROM c.branch_id AND a.comprobante = c.comprobante AND a."codPro" = ${prov}), 0)::float8 AS saldo
        FROM gestion_compras c
       WHERE c.business_id = ${businessId} AND c.codigo = ${prov} AND c.comprobante IS NOT NULL
         AND UPPER(LEFT(c.comprobante, 1)) NOT IN ('Z', 'N', 'E', 'G')
         AND c.fecha >= ${org?.desde || '2999-01-01'}::date
         AND NOT EXISTS (SELECT 1 FROM gestion_pagos pg WHERE pg.business_id = c.business_id AND pg.branch_id IS NOT DISTINCT FROM c.branch_id
                           AND pg.comprobante = c.comprobante AND pg."codPro" = c.codigo AND pg.importe IS NOT NULL)
       GROUP BY c.branch_id, c.comprobante
      HAVING SUM(COALESCE(c."importeManual", c.importe)) > 0
       ORDER BY MIN(c.fecha), c.comprobante`);
    for (const f of facturas) {
      let saldo = r2(f.saldo);
      while (cola.length && cola[0].fecha <= f.fecha && cola[0].importe <= saldo + 0.01) {
        const t = cola.shift();
        await pasarAFactura(businessId, t, f);
        saldo = r2(saldo - t.importe);
        pasados += 1;
        usadas.add(`${f.branch_id}|${f.comprobante}`);
      }
    }
  }
  return { pasados, facturas: usadas.size };
}

// El pago del ticket pasa a la factura y el ticket se saca (el gasto queda en la factura).
async function pasarAFactura(businessId, t, f) {
  await db.transaction(async (tx) => {
    const ya = await tx.one(sql`SELECT absorbido_en FROM mp_cargos_cargados WHERE business_id = ${businessId} AND sucursal = ${t.sucursal} AND cuenta = ${t.cuenta}::bigint AND fecha = ${t.fecha}::date AND grupo = ${t.grupo} FOR UPDATE`);
    if (!ya || ya.absorbido_en) return;
    await tx.execute(sql`
      UPDATE gestion_aplicaciones_pago_proveedor SET business_id = ${businessId}, branch_id = ${f.branch_id}::bigint, comprobante = ${f.comprobante}
       WHERE "pagoId" = ${t.pago_id} AND comprobante = ${t.comprobante}`);
    await tx.execute(sql`
      INSERT INTO gestion_eventos_pago_proveedor ("pagoId", tipo, detalle, importe, usuario)
      VALUES (${t.pago_id}, 'reimputado', ${`De ${t.comprobante} a la factura ${f.comprobante}`}, ${t.importe}::numeric, ${USUARIO})`);
    const filtro = sql`business_id = ${businessId} AND comprobante = ${t.comprobante} AND codigo = ${t.proveedor_cod} AND fecha::date = ${t.fecha}::date`;
    await tx.execute(sql`DELETE FROM gestion_detalle_compras WHERE business_id = ${businessId} AND comprobante = ${t.comprobante} AND "codPro" = ${t.proveedor_cod} AND fecha::date = ${t.fecha}::date`);
    await tx.execute(sql`DELETE FROM gestion_compras WHERE ${filtro}`);
    await tx.execute(sql`DELETE FROM gestion_facturas_movil WHERE ${filtro}`);
    await tx.execute(sql`
      UPDATE mp_cargos_cargados SET absorbido_en = ${f.comprobante}, absorbido_at = now()
       WHERE business_id = ${businessId} AND sucursal = ${t.sucursal} AND cuenta = ${t.cuenta}::bigint AND fecha = ${t.fecha}::date AND grupo = ${t.grupo}`);
  });
}

module.exports = { GRUPOS, CASE_GRUPO, sqlDiario, resumen, configurar, activar, cargarNegocio, absorberNegocio };
