// services/arcaConexion.js
//
// ARCA automático desde la PC del cliente (usuaria 18/11/2026, opción C: robot propio). Ver migración 147.
//  - El negocio elige en Configuración › Conexiones › ARCA cada cuánto (diaria / semanal / mensual) o
//    pide «Traer ahora» con un rango.
//  - La PC vinculada del kit (misma llave que usa para MaxiRest) pregunta qué hacer (tareaPara), entra a
//    ARCA con la CUIT y clave del cliente —guardadas cifradas SOLO en esa PC—, baja Mis Comprobantes ›
//    Recibidos y lo sube (subir). También sube el .zip de ARCA que el cliente baje a mano (origen
//    'descargas', lo detecta el vigilante del kit).
//  - Lo subido entra por el importador del Panel (gestion/arca/api.importarArca): el cruce «qué falta
//    cargar» y las correcciones son los de siempre.
// Lazarillo nunca recibe ni guarda la clave fiscal.
'use strict';

const pool = require('../config/db');

const FRECUENCIAS = ['diaria', 'semanal', 'mensual', 'apagada'];
const DIAS_PRIMERA_VEZ = 90;   // la primera vez: los últimos 3 meses
const DIAS_REPASO = 7;         // cada vez se repasa una semana para atrás (ARCA a veces informa tarde)
const MAX_DIAS = 365;          // tope de Mis Comprobantes por consulta

// ───────────────────────── fechas (puras) ─────────────────────────
const hoyAr = (d = new Date()) => new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
const sumarDias = (dia, n) => new Date(new Date(`${dia}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const diaDe = (v) => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};
const diasEntre = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * ¿Qué tiene que hacer la PC ahora? (pura, testeada). c = fila de arca_conexion. Devuelve
 * { desde, hasta, motivo } o null. ARCA tiene la información «hasta el día de ayer inclusive».
 */
function tareaDe(c, ahora = new Date()) {
  if (!c) return null;
  const hoy = hoyAr(ahora);
  const ayer = sumarDias(hoy, -1);
  if (c.pedido_at && c.pedido_desde && c.pedido_hasta) {
    return { desde: diaDe(c.pedido_desde), hasta: diaDe(c.pedido_hasta), motivo: 'pedido' };
  }
  if (!FRECUENCIAS.includes(c.frecuencia) || c.frecuencia === 'apagada') return null;
  const ultima = c.ultima_corrida_at ? hoyAr(new Date(c.ultima_corrida_at)) : null;
  let toca = !ultima;
  if (ultima) {
    if (c.frecuencia === 'diaria') toca = ultima < hoy;
    else if (c.frecuencia === 'semanal') toca = diasEntre(ultima, hoy) >= 7;
    else if (c.frecuencia === 'mensual') toca = ultima.slice(0, 7) < hoy.slice(0, 7);
  }
  if (!toca) return null;
  const hasta = diaDe(c.recibidos_hasta);
  let desde = hasta ? sumarDias(hasta, -DIAS_REPASO) : sumarDias(ayer, -DIAS_PRIMERA_VEZ);
  if (diasEntre(desde, ayer) > MAX_DIAS) desde = sumarDias(ayer, -MAX_DIAS);
  return { desde, hasta: ayer, motivo: c.frecuencia };
}

/** Rango pedido a mano (puro, testeado): fechas válidas, hasta ayer como mucho, hasta 365 días. */
function validarRango(desde, hasta, ahora = new Date()) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(String(desde)) || !re.test(String(hasta))) return { error: 'fechas_invalidas' };
  const ayer = sumarDias(hoyAr(ahora), -1);
  const h = hasta > ayer ? ayer : hasta;
  if (desde > h) return { error: 'rango_invertido' };
  if (diasEntre(desde, h) > MAX_DIAS) return { error: 'rango_largo' };
  return { desde, hasta: h };
}

// ───────────────────────── base ─────────────────────────

const leer = async (bid) => (await pool.query('SELECT * FROM arca_conexion WHERE business_id = $1', [bid])).rows[0] || null;
async function asegurar(bid) {
  await pool.query('INSERT INTO arca_conexion (business_id) VALUES ($1) ON CONFLICT DO NOTHING', [bid]);
  return leer(bid);
}

function avisar(businessId, args) {
  const { avisarAlEquipo } = require('./notificationService');
  return avisarAlEquipo({ businessId, ...args }).catch((e) => console.error('[arca] aviso', businessId, e.message));
}

/** Lo que muestra Configuración › Conexiones › ARCA. */
async function estado(businessId) {
  const bid = Number(businessId);
  const c = await asegurar(bid);
  const [{ rows: pcs }, { rows: subidas }, { rows: org }] = await Promise.all([
    pool.query(`SELECT id, pc_nombre, ultimo_contacto FROM kit_pcs WHERE business_id = $1 AND revocado_en IS NULL ORDER BY ultimo_contacto DESC NULLS LAST`, [bid]),
    pool.query(`SELECT origen, to_char(desde, 'YYYY-MM-DD') AS desde, to_char(hasta, 'YYYY-MM-DD') AS hasta, comprobantes, nuevos, error, creado_at
                  FROM arca_subidas WHERE business_id = $1 ORDER BY creado_at DESC LIMIT 6`, [bid]),
    pool.query(`SELECT COUNT(a.*)::int AS comprobantes FROM app_businesses b
                  LEFT JOIN gestion_arca_comprobantes a ON a.organization_id = b.organization_id WHERE b.id = $1`, [bid]),
  ]);
  const pc = c.pc_id ? pcs.find((p) => Number(p.id) === Number(c.pc_id)) || null : null;
  return {
    frecuencia: c.frecuencia,
    vinculada: !!(pc && c.vinculada_at),
    cuit: c.cuit,
    pc: pc ? { nombre: pc.pc_nombre, ultimo_contacto: pc.ultimo_contacto } : null,
    hayPc: pcs.length > 0,
    pedido: c.pedido_at ? { desde: diaDe(c.pedido_desde), hasta: diaDe(c.pedido_hasta), at: c.pedido_at } : null,
    recibidos_hasta: diaDe(c.recibidos_hasta),
    ultima_corrida_at: c.ultima_corrida_at,
    ultimo_error: c.ultimo_error, ultimo_error_at: c.ultimo_error_at,
    proxima: tareaDe({ ...c, pedido_at: null }) ? 'en la próxima pasada de la PC' : null,
    subidas,
    comprobantes: org[0]?.comprobantes || 0,
  };
}

async function cambiarFrecuencia(businessId, userId, frecuencia) {
  if (!FRECUENCIAS.includes(frecuencia)) return { error: 'frecuencia_invalida' };
  await asegurar(Number(businessId));
  await pool.query('UPDATE arca_conexion SET frecuencia = $2, updated_at = now() WHERE business_id = $1', [businessId, frecuencia]);
  const texto = { diaria: 'todos los días', semanal: 'una vez por semana', mensual: 'una vez por mes', apagada: 'solo cuando se pida' }[frecuencia];
  await avisar(businessId, {
    actorUserId: userId, type: 'arca_frecuencia', title: 'Cambió cada cuánto se trae ARCA',
    message: `Los comprobantes recibidos de ARCA se traen ${texto}.`, metadata: { frecuencia },
  });
  return { ok: true, frecuencia };
}

async function pedirAhora(businessId, userId, { desde, hasta } = {}) {
  const r = validarRango(desde, hasta);
  if (r.error) return r;
  await asegurar(Number(businessId));
  await pool.query(
    `UPDATE arca_conexion SET pedido_desde = $2, pedido_hasta = $3, pedido_at = now(), pedido_por = $4, updated_at = now() WHERE business_id = $1`,
    [businessId, r.desde, r.hasta, userId || null]);
  return { ok: true, ...r };
}

async function cancelarPedido(businessId) {
  await pool.query('UPDATE arca_conexion SET pedido_desde = NULL, pedido_hasta = NULL, pedido_at = NULL, updated_at = now() WHERE business_id = $1', [businessId]);
  return { ok: true };
}

// ───────────────────────── lo que usa la PC (llave del kit) ─────────────────────────

/** La PC guardó CUIT y clave (solo en ella) y avisa que quedó lista. Solo viaja la CUIT. */
async function vincularPc(pc, { cuit } = {}) {
  const c = String(cuit || '').replace(/\D/g, '');
  if (c.length !== 11) return { error: 'cuit_invalida' };
  await asegurar(Number(pc.business_id));
  await pool.query(
    `UPDATE arca_conexion SET pc_id = $2, cuit = $3, vinculada_at = now(), ultimo_error = NULL, updated_at = now() WHERE business_id = $1`,
    [pc.business_id, pc.id, c]);
  await avisar(pc.business_id, {
    type: 'arca_vinculado', title: 'ARCA quedó conectado',
    message: `La PC «${pc.pc_nombre}» va a traer los comprobantes recibidos de la CUIT ${c}. La clave fiscal queda guardada solo en esa PC.`,
  });
  return { ok: true };
}

async function desvincularPc(pc) {
  await pool.query(`UPDATE arca_conexion SET pc_id = NULL, vinculada_at = NULL, updated_at = now() WHERE business_id = $1 AND pc_id = $2`, [pc.business_id, pc.id]);
  return { ok: true };
}

/** ¿Qué hago? Solo la PC que tiene la clave recibe tareas. */
async function tareaPara(pc) {
  const c = await leer(Number(pc.business_id));
  if (!c || Number(c.pc_id) !== Number(pc.id) || !c.vinculada_at) return { tarea: null };
  return { tarea: tareaDe(c) };
}

/** La PC sube el CSV (texto) de Mis Comprobantes › Recibidos. origen: robot | descargas. */
async function subir(pc, { texto, desde = null, hasta = null, origen = 'robot' } = {}) {
  const bid = Number(pc.business_id);
  const org = origen === 'descargas' ? 'descargas' : 'robot';
  const t = typeof texto === 'string' ? texto : '';
  const { leerCsvArca } = require('./gestion/arca/csv');
  const { comprobantes, errores } = leerCsvArca(t);
  let r = { nuevos: 0, actualizados: 0 };
  let error = null;
  if (comprobantes.length) {
    try {
      const organizationId = Number(await require('./gestion/organizacion-auto').asegurarOrganizacion(bid, null));
      r = await require('./gestion/arca/api').importarArca({ organizationId, usuario: `ARCA · ${pc.pc_nombre}`, body: { texto: t } });
    } catch (e) { error = String(e.message || e).slice(0, 300); }
  } else if (errores.length && t.trim()) {
    error = String(errores[0]).slice(0, 300); // no es el archivo de ARCA (o cambió el formato)
  }
  // Rango que cubrió: el que pidió la PC, o el de los comprobantes que vinieron.
  const fechas = comprobantes.map((x) => x.fecha).filter(Boolean).sort();
  const d = desde || fechas[0] || null;
  const h = hasta || fechas[fechas.length - 1] || null;
  await pool.query(
    `INSERT INTO arca_subidas (business_id, pc_id, origen, desde, hasta, comprobantes, nuevos, actualizados, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [bid, pc.id, org, d, h, comprobantes.length, r.nuevos || 0, r.actualizados || 0, error]);
  await asegurar(bid);
  if (!error) {
    await pool.query(
      `UPDATE arca_conexion SET ultima_corrida_at = CASE WHEN $2 = 'robot' THEN now() ELSE ultima_corrida_at END,
              recibidos_hasta = CASE WHEN $3::date IS NULL THEN recibidos_hasta ELSE GREATEST(COALESCE(recibidos_hasta, $3::date), $3::date) END,
              pedido_desde = CASE WHEN $2 = 'robot' THEN NULL ELSE pedido_desde END,
              pedido_hasta = CASE WHEN $2 = 'robot' THEN NULL ELSE pedido_hasta END,
              pedido_at    = CASE WHEN $2 = 'robot' THEN NULL ELSE pedido_at END,
              ultimo_error = NULL, updated_at = now()
        WHERE business_id = $1`, [bid, org, org === 'robot' ? h : null]);
    if (r.nuevos) {
      await avisar(bid, {
        type: 'arca_recibidos',
        title: r.nuevos === 1 ? 'ARCA: 1 comprobante recibido nuevo' : `ARCA: ${r.nuevos} comprobantes recibidos nuevos`,
        message: 'Mirá en el Panel › Sin carga › ARCA cuáles todavía no están cargados.',
        metadata: { nuevos: r.nuevos, desde: d, hasta: h, origen: org },
        clave: `arca_recibidos:${bid}`, agruparMin: 12 * 60,
      });
    }
  } else {
    await pool.query('UPDATE arca_conexion SET ultimo_error = $2, ultimo_error_at = now(), updated_at = now() WHERE business_id = $1', [bid, error]);
  }
  return { ok: !error, comprobantes: comprobantes.length, nuevos: r.nuevos || 0, actualizados: r.actualizados || 0, error };
}

/** La PC no pudo (clave rechazada, ARCA caído, cambió la pantalla…). */
async function informarError(pc, { mensaje, tipo = 'otro' } = {}) {
  const bid = Number(pc.business_id);
  const m = String(mensaje || 'Error sin detalle').slice(0, 300);
  await asegurar(bid);
  await pool.query('UPDATE arca_conexion SET ultimo_error = $2, ultimo_error_at = now(), updated_at = now() WHERE business_id = $1', [bid, m]);
  if (tipo === 'clave') {
    await avisar(bid, {
      type: 'arca_clave', title: 'ARCA no aceptó la clave fiscal',
      message: `La PC «${pc.pc_nombre}» no pudo entrar a ARCA. Si cambiaste la clave fiscal, volvé a conectarla en esa PC (VINCULAR ARCA).`,
      clave: `arca_clave:${bid}`, agruparMin: 24 * 60,
    });
  }
  return { ok: true };
}

module.exports = {
  estado, cambiarFrecuencia, pedirAhora, cancelarPedido,
  vincularPc, desvincularPc, tareaPara, subir, informarError,
  _tareaDe: tareaDe, _validarRango: validarRango, FRECUENCIAS,
};
