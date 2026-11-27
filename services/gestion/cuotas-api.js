// services/gestion/cuotas-api.js — Pago de facturas de proveedor en cuotas (usuaria 27/11/2026).
//
// Flujo: en la barra de pago se elige «En cuotas» (cantidad libre). La 1ª cuota se registra como un pago
// normal (POST /pagos-proveedor, queda la factura «parcial») y acá se guarda el plan con las que faltan, cada
// una con su vencimiento (el mismo día de los meses siguientes). Con «recordar», el día que vence una cuota
// aparece un aviso flotante (GET /pagos-cuotas/vencidas) y «Marcar como paga» registra ese pago con el mismo
// circuito (pagos-api.registrarPago) contra las mismas facturas.
'use strict';
const { z } = require('zod');
const { sql, db } = require('./db');
const { ErrorDatos } = require('./dashboard/resultados-api');
const pagos = require('./pagos-api');

const rechazo = (m, status = 400) => { const e = new ErrorDatos(m); e.status = status; return e; };
const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hoyAr = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
const redondear = (n) => Math.round(Number(n) * 100) / 100;

const planSchema = z.object({
  codPro: z.string().trim().min(1).max(40),
  proveedor: z.string().max(200).optional().nullable(),
  facturas: z.array(z.object({ pdvId: z.number().int(), comprobante: z.string().trim().min(1).max(40) })).min(1).max(500),
  medio: z.string().trim().min(1).max(40).optional().nullable(),
  pdvPagaId: z.number().int().optional().nullable(),
  recordar: z.boolean().optional(),
  cuotas: z.array(z.object({
    importe: z.number().positive(),
    vence: fechaISO,
    pagoId: z.number().int().positive().optional().nullable(),
  })).min(2).max(120),
});

const leerPlan = (cliente, { organizationId, businessId }, id) => cliente.one(sql`
  SELECT * FROM gestion_planes_cuotas WHERE id = ${id} AND organization_id = ${organizationId} AND business_id = ${businessId}`);

const aSalida = (p) => {
  const cuotas = Array.isArray(p.cuotas) ? p.cuotas : [];
  const pagadas = cuotas.filter((c) => c.pagoId).length;
  return {
    id: Number(p.id), codPro: p.codPro, proveedor: p.proveedor, facturas: p.facturas, total: Number(p.total),
    cantidad: p.cantidad, cuotas, pagadas, medio: p.medio, pdvPagaId: p.pdvPagaId, recordar: p.recordar, estado: p.estado,
    saldo: redondear(cuotas.filter((c) => !c.pagoId).reduce((a, c) => a + Number(c.importe), 0)),
    creadoEn: p.creadoEn,
  };
};

/** POST /pagos-cuotas — guarda el plan (la 1ª cuota ya viene pagada con su pagoId). */
async function crearPlan({ organizationId, businessId, usuario, body }) {
  const parsed = planSchema.safeParse(body);
  if (!parsed.success) throw rechazo('Datos inválidos del plan de cuotas.');
  const b = parsed.data;
  const cuotas = b.cuotas.map((c, i) => ({
    n: i + 1, importe: redondear(c.importe), vence: c.vence,
    pagoId: c.pagoId || null, pagadaEn: c.pagoId ? new Date().toISOString() : null, pagadaPor: c.pagoId ? usuario : null,
  }));
  const total = redondear(cuotas.reduce((a, c) => a + c.importe, 0));
  const fila = await db.one(sql`
    INSERT INTO gestion_planes_cuotas (organization_id, business_id, "codPro", proveedor, facturas, total, cantidad, cuotas, medio, "pdvPagaId", recordar, estado, "creadoPor")
    VALUES (${organizationId}, ${businessId}, ${b.codPro}, ${b.proveedor || null}, ${JSON.stringify(b.facturas)}::jsonb, ${total}::numeric,
            ${cuotas.length}, ${JSON.stringify(cuotas)}::jsonb, ${b.medio || null}, ${b.pdvPagaId ?? null}, ${b.recordar !== false},
            ${cuotas.every((c) => c.pagoId) ? 'terminado' : 'activo'}, ${usuario})
    RETURNING *`);
  return { ok: true, plan: aSalida(fila) };
}

/** GET /pagos-cuotas?codPro= — planes activos (de un proveedor o todos). */
async function listarPlanes({ organizationId, businessId, codPro }) {
  const filas = await db.many(sql`
    SELECT * FROM gestion_planes_cuotas
     WHERE organization_id = ${organizationId} AND business_id = ${businessId} AND estado = 'activo'
       ${codPro ? sql`AND "codPro" = ${String(codPro)}` : sql``}
     ORDER BY "creadoEn" DESC`);
  return { planes: filas.map(aSalida) };
}

/** GET /pagos-cuotas/vencidas — cuotas con recordatorio que vencen hoy o antes y siguen sin pagar (para el aviso flotante). */
async function cuotasVencidas({ organizationId, businessId }) {
  const hoy = hoyAr();
  const filas = await db.many(sql`
    SELECT * FROM gestion_planes_cuotas
     WHERE organization_id = ${organizationId} AND business_id = ${businessId} AND estado = 'activo' AND recordar`);
  const out = [];
  for (const p of filas) {
    for (const c of (p.cuotas || [])) {
      if (!c.pagoId && c.vence <= hoy) {
        out.push({ planId: Number(p.id), n: c.n, cantidad: p.cantidad, importe: Number(c.importe), vence: c.vence,
          codPro: p.codPro, proveedor: p.proveedor, medio: p.medio });
      }
    }
  }
  out.sort((a, b) => a.vence.localeCompare(b.vence));
  return { hoy, cuotas: out };
}

const pagarSchema = z.object({ fecha: fechaISO.optional(), medio: z.string().trim().min(1).max(40).optional() });

/** POST /pagos-cuotas/:id/cuotas/:n/pagar — registra el pago de esa cuota contra las facturas del plan. */
async function pagarCuota({ organizationId, businessId, usuario, id, n, body }) {
  const parsed = pagarSchema.safeParse(body || {});
  if (!parsed.success) throw rechazo('Datos inválidos.');
  const plan = await leerPlan(db, { organizationId, businessId }, id);
  if (!plan) throw rechazo('Ese plan de cuotas ya no existe.', 404);
  if (plan.estado !== 'activo') throw rechazo('Ese plan de cuotas ya está cerrado.');
  const cuotas = Array.isArray(plan.cuotas) ? plan.cuotas : [];
  const c = cuotas.find((x) => Number(x.n) === Number(n));
  if (!c) throw rechazo('Esa cuota no existe.', 404);
  if (c.pagoId) throw rechazo(`La cuota ${c.n} ya está paga.`);
  const medio = parsed.data.medio || plan.medio;
  if (!medio) throw rechazo('Elegí con qué medio se pagó.');
  const r = await pagos.registrarPago({
    organizationId, businessId, usuario,
    body: {
      codPro: plan.codPro, fecha: parsed.data.fecha || hoyAr(), medio, importe: Number(c.importe),
      facturas: plan.facturas, ...(plan.pdvPagaId != null ? { pdvPagaId: Number(plan.pdvPagaId) } : {}),
    },
  });
  const nuevas = cuotas.map((x) => (Number(x.n) === Number(n)
    ? { ...x, pagoId: r.id, pagadaEn: new Date().toISOString(), pagadaPor: usuario } : x));
  const terminado = nuevas.every((x) => x.pagoId);
  const fila = await db.one(sql`
    UPDATE gestion_planes_cuotas SET cuotas = ${JSON.stringify(nuevas)}::jsonb, estado = ${terminado ? 'terminado' : 'activo'}
     WHERE id = ${id} AND business_id = ${businessId} RETURNING *`);
  return { ok: true, pagoId: r.id, plan: aSalida(fila) };
}

/** PATCH /pagos-cuotas/:id — recordar sí/no, o cancelar el plan (las cuotas pagadas quedan como pagos normales). */
async function editarPlan({ organizationId, businessId, id, body }) {
  const plan = await leerPlan(db, { organizationId, businessId }, id);
  if (!plan) throw rechazo('Ese plan de cuotas ya no existe.', 404);
  const recordar = typeof body?.recordar === 'boolean' ? body.recordar : plan.recordar;
  const estado = body?.cancelar ? 'cancelado' : plan.estado;
  const fila = await db.one(sql`
    UPDATE gestion_planes_cuotas SET recordar = ${recordar}, estado = ${estado} WHERE id = ${id} AND business_id = ${businessId} RETURNING *`);
  return { ok: true, plan: aSalida(fila) };
}

module.exports = { crearPlan, listarPlanes, cuotasVencidas, pagarCuota, editarPlan, _hoyAr: hoyAr };
