// controllers/rrhhController.js
// RRHH · Etapa 1 (Cronogramas).
// El businessId ya viene resuelto y validado por loadActiveBusiness
// (req.businessId), igual que el resto de rutas /api/businesses/:bizId/...
//
// Modelo (ver db/migrations/live/063_rrhh_cronogramas.sql):
//   config  = empleados + puestos + fechas especiales + espacios (con turnos)
//   semana  = filas por turno, cada fila de UN empleado, celdas por día (0=Do…6=Sa)
//
// Los empleados son de Lazarillo. Cada GET /config sincroniza con la réplica
// de MaxiRest (container/comercio.i000_nomina, se actualiza cada noche): los
// códigos nuevos entran solos y los dados de baja en MaxiRest se desactivan
// (nunca se borran ni se pisan datos editados en Lazarillo). Las altas
// manuales (sin código de MaxiRest) son propias y la sync no las toca.
//
// Sucursales (migración 074): la nómina y las referencias son del negocio;
// los espacios (y sus semanas) son de cada sucursal — branch_id NULL es la
// principal. Las fechas especiales son compartidas (feriados y pre feriados)
// o de la sucursal (eventos y cierres). La sucursal llega en ?branchId=.
//
// Nómina compartida (migración 075): un negocio sin nómina propia puede usar
// la de otro de su cartera (vinculada). nominaDe(biz) da el negocio cuyos
// empleados se usan: config, altas/ediciones y la sync van contra ese.
'use strict';

const pool = require('../config/db');
const { avisarAlEquipoSinEsperar } = require('../services/notificationService');

/* ── Avisos (regla «todo ABM queda en Notificaciones», Diego 12/11/2026) ──
   Los graba el servidor en el mismo endpoint que hace el cambio; le llegan al equipo de
   gestión del negocio y a quien lo hizo (ya leído, en «Mías»). */
const nombreEmp = (e) => [e?.nombre, e?.apellido].filter(Boolean).join(' ').trim() || 'Empleado';
const ddmmaaaa = (iso) => (iso ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}/${String(iso).slice(0, 4)}` : '');
function avisarRrhh(req, type, title, message = null, metadata = {}, extra = {}) {
  avisarAlEquipoSinEsperar({
    businessId: req.businessId, actorUserId: req.user?.id || null, type, title, message,
    metadata: { kind: type, scope: 'rrhh', ...metadata }, incluirActor: !!req.user?.id, ...extra,
  });
}
const { PDV_MAP } = require('../services/maxiPdvMap');
const { getEffectiveRole, listAccessibleBusinesses } = require('../services/auth/accessControl');

/* ───────────────────────── helpers ───────────────────────── */

// businessId → { schema, pdv } en la réplica (derivado de PDV_MAP, que mapea
// pdv → negocio; acá hace falta la inversa para leer i000_nomina).
function replicaDeNegocio(businessId) {
  for (const [pdv, v] of Object.entries(PDV_MAP)) {
    if (v.businessId === Number(businessId)) return { schema: v.schema, pdv };
  }
  return null;
}

// ?branchId= → id de sucursal para RRHH (null = principal). La sucursal is_main
// también es la principal (sus datos viven con branch_id NULL). Una sucursal
// que no es del negocio → error 400.
async function resolverSucursal(bizId, raw) {
  if (raw == null || raw === '' || raw === 'main' || raw === 'null') return null;
  const id = asInt(raw);
  if (!id) { const e = new Error('sucursal_invalida'); e.status = 400; throw e; }
  const { rows } = await pool.query(
    `SELECT id, COALESCE((props->>'is_main')::boolean, FALSE) AS principal
     FROM app_branches WHERE id=$1 AND business_id=$2`, [id, bizId]
  );
  if (!rows[0]) { const e = new Error('sucursal_invalida'); e.status = 400; throw e; }
  return rows[0].principal ? null : Number(rows[0].id);
}
// Negocio dueño de la nómina que usa bizId (él mismo, o el de origen si comparte).
async function nominaDe(bizId) {
  const { rows } = await pool.query(
    'SELECT origen_business_id FROM rrhh_nomina_vinculo WHERE business_id=$1', [bizId]
  );
  return rows[0] ? Number(rows[0].origen_business_id) : Number(bizId);
}
const nombreNegocio = async (id) => {
  const { rows } = await pool.query('SELECT name FROM app_businesses WHERE id=$1', [id]);
  return rows[0]?.name || `#${id}`;
};

// Feriados y pre feriados valen para todas las sucursales; eventos y cierres
// son de la sucursal donde se cargan.
const esCompartida = (tipo) => ['feriado', 'prefer'].includes(String(tipo || '').toLowerCase());

// "CANCINO" → "Cancino" (la réplica trae mayormente mayúsculas; es semilla editable)
function titulo(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-záéíóúüñ])/g, (m, sep, ch) => sep + ch.toUpperCase())
    .trim();
}

const asInt = (v) => {
  // null/undefined/'' son "sin valor", nunca 0: Number(null) da 0 y eso
  // metía owner_empleado_id=0 en filas sin dueño, rompiendo la FK.
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/* ───────────────────────── seed de defaults ─────────────────────────
 * Primera vez que un negocio abre el módulo: espacios Salón/Cocina con turnos
 * Día/Noche, referencias estándar y feriados nacionales AR (los `fijo` se
 * renuevan solos al año vigente). Todo editable después desde ⚙ Configuración.
 */
const PUESTOS_DEF = [
  // Diego 13/11/2026: los puestos de un negocio nuevo, sin abreviaturas (el código es el nombre)
  ...['Cocinero', 'Camarero', 'Mozo', 'Bartender', 'Barista', 'Encargado', 'Caja', 'Recepción', 'Runner'].map((n) => [n, n]),
];

// [mm, dd, tipo, nombre, fijo]  (móviles con la fecha 2026 del catálogo aprobado)
const FECHAS_DEF = [
  [1, 1, 'feriado', 'Año Nuevo', true],
  [2, 16, 'feriado', 'Carnaval', false],
  [2, 17, 'feriado', 'Carnaval', false],
  [3, 24, 'feriado', 'Día de la Memoria', true],
  [4, 2, 'feriado', 'Malvinas', true],
  [4, 3, 'feriado', 'Viernes Santo', false],
  [5, 1, 'feriado', 'Día del Trabajador', true],
  [5, 25, 'feriado', 'Revolución de Mayo', true],
  [6, 20, 'feriado', 'Gral. Belgrano', true],
  [7, 9, 'feriado', 'Independencia', true],
  [8, 17, 'feriado', 'Gral. San Martín', false],
  [10, 12, 'feriado', 'Diversidad Cultural', false],
  [11, 20, 'feriado', 'Soberanía Nacional', false],
  [12, 8, 'feriado', 'Inmaculada Concepción', true],
  [12, 24, 'prefer', 'Nochebuena', true],
  [12, 25, 'feriado', 'Navidad', true],
  [12, 31, 'prefer', 'Fin de Año', true],
];

async function ensureSeed(client, bizId, branchId = null) {
  const { rows } = await client.query(
    'SELECT 1 FROM rrhh_espacios WHERE business_id=$1 AND branch_id IS NOT DISTINCT FROM $2 LIMIT 1',
    [bizId, branchId]
  );
  if (!rows.length) {
    for (const [i, [nombre, sector]] of [['Salón', 'Salón'], ['Cocina', 'Cocina']].entries()) {
      const esp = await client.query(
        `INSERT INTO rrhh_espacios (business_id, nombre, sector_nomina, orden, branch_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [bizId, nombre, sector, i, branchId]
      );
      await client.query(
        `INSERT INTO rrhh_turnos (espacio_id, nombre, entrada, orden)
         VALUES ($1,'Día','10:00',0), ($1,'Noche','19:00',1)`,
        [esp.rows[0].id]
      );
    }
  }

  // solo si el negocio no tiene ninguno: si no, un puesto quitado desde el modal volvía a aparecer
  // y los defaults nuevos se sumaban a negocios que ya tienen los suyos
  await client.query(
    `INSERT INTO rrhh_puestos (business_id, codigo, nombre)
     SELECT $1, d.codigo, d.nombre
     FROM unnest($2::text[], $3::text[]) AS d(codigo, nombre)
     WHERE NOT EXISTS (SELECT 1 FROM rrhh_puestos WHERE business_id = $1)
     ON CONFLICT (business_id, codigo) DO NOTHING`,
    [bizId, PUESTOS_DEF.map((p) => p[0]), PUESTOS_DEF.map((p) => p[1])]
  );

  const anio = new Date().getUTCFullYear();
  const { rows: hayFechas } = await client.query(
    'SELECT 1 FROM rrhh_fechas WHERE business_id=$1 AND compartida LIMIT 1', [bizId]
  );
  if (!hayFechas.length) {
    for (const [mm, dd, tipo, nombre, fijo] of FECHAS_DEF) {
      await client.query(
        `INSERT INTO rrhh_fechas (business_id, fecha, tipo, nombre, suma_promedio, fijo, compartida, branch_id)
         VALUES ($1, make_date($2,$3,$4), $5, $6, FALSE, $7, TRUE, NULL)
         ON CONFLICT (business_id, compartida, (COALESCE(branch_id, 0)), fecha) DO NOTHING`,
        [bizId, anio, mm, dd, tipo, nombre, fijo]
      );
    }
  }

  // Feriados inamovibles: cada año cae la misma fecha → se renuevan solos al
  // año vigente (las fechas móviles se re-fechan a mano desde ⚙ Fechas).
  await client.query(
    `INSERT INTO rrhh_fechas (business_id, fecha, tipo, nombre, suma_promedio, fijo, compartida, branch_id)
     SELECT DISTINCT ON (compartida, COALESCE(branch_id, 0), EXTRACT(MONTH FROM fecha), EXTRACT(DAY FROM fecha))
            business_id,
            make_date($2, EXTRACT(MONTH FROM fecha)::int, EXTRACT(DAY FROM fecha)::int),
            tipo, nombre, suma_promedio, TRUE, compartida, branch_id
     FROM rrhh_fechas
     WHERE business_id=$1 AND fijo = TRUE
     ORDER BY compartida, COALESCE(branch_id, 0), EXTRACT(MONTH FROM fecha), EXTRACT(DAY FROM fecha), fecha DESC
     ON CONFLICT (business_id, compartida, (COALESCE(branch_id, 0)), fecha) DO NOTHING`,
    [bizId, anio]
  );
}

/* ───────────────────────── sync de nómina ─────────────────────────
 * Altas: código activo en la réplica que no está en RRHH → se inserta.
 * Bajas: código con fecha_baja en la réplica → se desactiva y se anota la
 *   fecha en baja_maxi. Si después lo reactivan a mano, no se vuelve a bajar
 *   salvo que MaxiRest cargue una baja con OTRA fecha. Nunca reactiva sola.
 * Devuelve { altas:[nombres], bajas:[nombres] } o null si el negocio no tiene
 * réplica de MaxiRest.
 */
async function sincronizarNomina(bizId) {
  const origen = replicaDeNegocio(bizId);
  if (!origen) return null;
  const { rows: rep } = await pool.query(
    `SELECT DISTINCT ON (TRIM(codigo)) TRIM(codigo) AS codigo, nombre, apellido, sector,
            to_char(fecha_baja,'YYYY-MM-DD') AS baja
     FROM ${origen.schema}.i000_nomina
     WHERE pdv = $1 AND codigo IS NOT NULL AND TRIM(codigo) <> ''
       AND (COALESCE(TRIM(nombre),'') <> '' OR COALESCE(TRIM(apellido),'') <> '')
     ORDER BY TRIM(codigo), (fecha_baja IS NULL) DESC`,
    [origen.pdv]
  );
  const { rows: lz } = await pool.query(
    `SELECT id, codigo_maxi, nombre, apellido, activo, to_char(baja_maxi,'YYYY-MM-DD') AS baja_maxi
     FROM rrhh_empleados WHERE business_id=$1 AND codigo_maxi IS NOT NULL`, [bizId]
  );
  const porCodigo = new Map(lz.map((e) => [e.codigo_maxi, e]));
  const altas = []; const bajas = [];
  for (const r of rep) {
    const e = porCodigo.get(r.codigo);
    if (!e) {
      if (r.baja) continue; // dado de baja y nunca importado: no se trae
      const ins = await pool.query(
        `INSERT INTO rrhh_empleados (business_id, codigo_maxi, nombre, apellido, sector, activo, origen)
         VALUES ($1,$2,$3,$4,$5,TRUE,'maxirest')
         ON CONFLICT (business_id, codigo_maxi) DO NOTHING RETURNING id`,
        [bizId, r.codigo, titulo(r.nombre) || r.codigo, titulo(r.apellido) || null, r.sector || null]
      );
      if (ins.rowCount) altas.push(`${titulo(r.nombre)} ${titulo(r.apellido)}`.trim());
    } else if (r.baja && r.baja !== e.baja_maxi) {
      await pool.query(
        'UPDATE rrhh_empleados SET activo=FALSE, baja_maxi=$2 WHERE id=$1', [e.id, r.baja]
      );
      if (e.activo) bajas.push(`${e.nombre || ''} ${e.apellido || ''}`.trim());
    }
  }
  // Fecha de alta y DNI desde la réplica (fecha_ing / nro_doc), una sola consulta y sin pisar
  // lo cargado a mano (Diego 12/11/2026).
  await pool.query(
    `UPDATE rrhh_empleados e
        SET fecha_alta = COALESCE(e.fecha_alta, r.alta),
            dni = COALESCE(e.dni, r.dni)
       FROM (SELECT DISTINCT ON (TRIM(codigo)) TRIM(codigo) AS codigo, fecha_ing::date AS alta,
                    NULLIF(regexp_replace(COALESCE(nro_doc, ''), '\\D', '', 'g'), '') AS dni
               FROM ${origen.schema}.i000_nomina
              WHERE pdv = $2 AND codigo IS NOT NULL
              ORDER BY TRIM(codigo), (fecha_baja IS NULL) DESC) r
      WHERE e.business_id = $1 AND e.codigo_maxi = r.codigo
        AND ((e.fecha_alta IS NULL AND r.alta IS NOT NULL) OR (e.dni IS NULL AND r.dni IS NOT NULL))`,
    [bizId, origen.pdv]
  ).catch((e) => console.warn('[rrhh.sincronizarNomina] alta/dni:', e.message));
  return { altas, bajas };
}

// fechaAlta 'YYYY-MM-DD' → fecha; '' → borrar; otra cosa → no tocar (undefined).
const fechaAltaDe = (v) => (v === '' ? '' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
// DNI: solo dígitos (se aceptan puntos y espacios al tipear); '' → borrar; undefined → no tocar.
const dniDe = (v) => {
  if (v == null) return undefined;
  const d = String(v).replace(/\D/g, '');
  return d === '' ? '' : d;
};
// El DNI va a ser la clave de cada persona: no puede repetirse dentro de la nómina.
async function dniRepetido(nominaId, dni, exceptoId = null) {
  if (!dni) return null;
  const { rows } = await pool.query(
    `SELECT TRIM(CONCAT(nombre, ' ', COALESCE(apellido, ''))) AS nombre FROM rrhh_empleados
      WHERE business_id = $1 AND dni = $2 AND id IS DISTINCT FROM $3 LIMIT 1`,
    [nominaId, dni, exceptoId]
  );
  return rows[0]?.nombre || null;
}

/* ───────────────────────── config ───────────────────────── */

// Cuántos días mira para atrás el "espacio aprendido" y la sugerencia de baja.
const VENTANA_DIAS = 56; // 8 semanas (Diego, 12/11/2026)
// 'YYYY-MM-DD' de hace n días en hora Argentina
const haceDias = (n) => {
  const d = new Date(Date.now() - 3 * 3600e3 - n * 86400e3);
  return d.toISOString().slice(0, 10);
};

// Lo que se aprende de los cronogramas (no se carga a mano):
//  · por empleado: en qué espacios de ESTE negocio tuvo turnos en las últimas
//    8 semanas y cuál fue su último turno (en cualquier negocio que lo use);
//  · por negocio: desde cuándo hay cronogramas con turnos (historia).
// Sin historia de 8 semanas no se sugiere ninguna baja (estado sin datos).
async function leerAprendido(bizId, nominaId) {
  const [porEmpleado, historia] = await Promise.all([
    pool.query(
      `WITH hoy AS (SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS d)
       SELECT c.empleado_id AS id,
              COALESCE(json_agg(DISTINCT jsonb_build_object('id', s.espacio_id, 'nombre', es.nombre))
                FILTER (WHERE s.business_id = $1 AND s.fecha_inicio + c.dia >= (SELECT d FROM hoy) - $3::int), '[]') AS espacios,
              to_char(max(s.fecha_inicio + c.dia), 'YYYY-MM-DD') AS ultimo
       FROM rrhh_celdas c
       JOIN rrhh_filas f ON f.id = c.fila_id
       JOIN rrhh_semanas s ON s.id = f.semana_id
       JOIN rrhh_espacios es ON es.id = s.espacio_id
       JOIN rrhh_empleados e ON e.id = c.empleado_id
       WHERE e.business_id = $2
       GROUP BY c.empleado_id`, [bizId, nominaId, VENTANA_DIAS]
    ),
    pool.query(
      `SELECT to_char(min(s.fecha_inicio), 'YYYY-MM-DD') AS desde,
              count(DISTINCT s.semana)::int AS semanas,
              COALESCE(min(s.fecha_inicio) <= (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - $2::int, false) AS alcanza
       FROM rrhh_semanas s
       WHERE s.business_id = $1
         AND EXISTS (SELECT 1 FROM rrhh_filas f JOIN rrhh_celdas c ON c.fila_id = f.id WHERE f.semana_id = s.id)`,
      [bizId, VENTANA_DIAS]
    ),
  ]);
  return {
    porEmpleado: new Map(porEmpleado.rows.map((r) => [Number(r.id), r])),
    historia: historia.rows[0] || { desde: null, semanas: 0, alcanza: false },
  };
}

async function leerConfig(bizId, branchId = null) {
  const nominaId = await nominaDe(bizId);
  const [empleados, puestos, fechas, espacios, turnos, aprendido] = await Promise.all([
    pool.query(
      `SELECT id, codigo_maxi AS "codigoMaxi", nombre, apellido, sector, activo, origen,
              to_char(baja_maxi,'YYYY-MM-DD') AS "bajaMaxi", to_char(fecha_baja,'YYYY-MM-DD') AS "fechaBaja",
              to_char(fecha_alta,'YYYY-MM-DD') AS "fechaAlta", dni,
              no_aplica_crono AS "noAplica",
              COALESCE(baja_sug_silenciada > (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - $2::int, false) AS "bajaSilenciada"
       FROM rrhh_empleados WHERE business_id=$1 ORDER BY nombre, apellido`, [nominaId, VENTANA_DIAS]
    ),
    pool.query(
      `SELECT id, codigo, nombre FROM rrhh_puestos WHERE business_id=$1 ORDER BY id`, [bizId]
    ),
    pool.query(
      `SELECT id, to_char(fecha,'YYYY-MM-DD') AS fecha, tipo, nombre,
              suma_promedio AS "sumaPromedio", fijo, compartida
       FROM rrhh_fechas
       WHERE business_id=$1 AND (compartida OR branch_id IS NOT DISTINCT FROM $2)
       ORDER BY fecha, compartida`, [bizId, branchId]
    ),
    pool.query(
      `SELECT id, nombre, sector_nomina AS "sectorNomina", orden
       FROM rrhh_espacios WHERE business_id=$1 AND branch_id IS NOT DISTINCT FROM $2
       ORDER BY orden, id`, [bizId, branchId]
    ),
    pool.query(
      `SELECT t.id, t.espacio_id AS "espacioId", t.nombre, t.entrada, t.orden
       FROM rrhh_turnos t JOIN rrhh_espacios e ON e.id = t.espacio_id
       WHERE e.business_id=$1 AND e.branch_id IS NOT DISTINCT FROM $2
       ORDER BY t.orden, t.id`, [bizId, branchId]
    ),
    leerAprendido(bizId, nominaId),
  ]);
  const turnosPorEspacio = new Map();
  for (const t of turnos.rows) {
    if (!turnosPorEspacio.has(t.espacioId)) turnosPorEspacio.set(t.espacioId, []);
    turnosPorEspacio.get(t.espacioId).push(t);
  }
  return {
    branchId,
    // nómina compartida: de qué negocio vienen los empleados (null = propia)
    nomina: nominaId !== Number(bizId)
      ? { compartidaCon: { id: nominaId, nombre: await nombreNegocio(nominaId) } }
      : { compartidaCon: null },
    // historia: desde cuándo hay turnos cargados; `alcanza` = 8 semanas o más
    historia: aprendido.historia,
    empleados: empleados.rows.map(({ bajaSilenciada, ...e }) => {
      const a = aprendido.porEmpleado.get(Number(e.id));
      const ultimoTurno = a?.ultimo || null;
      return {
        ...e,
        espacios: a?.espacios || [],   // aprendidos de los cronogramas (8 semanas)
        ultimoTurno,
        // Sugerir baja: activo, va en cronogramas, el negocio tiene 8+ semanas
        // de historia y no tuvo turnos en ese lapso (ni lo silenciaron).
        sugerirBaja: !!(e.activo && !e.noAplica && aprendido.historia.alcanza && !bajaSilenciada
          && (!ultimoTurno || ultimoTurno < haceDias(VENTANA_DIAS))),
      };
    }),
    puestos: puestos.rows,
    fechas: fechas.rows,
    espacios: espacios.rows.map((e) => ({ ...e, turnos: turnosPorEspacio.get(e.id) || [] })),
  };
}

// GET /api/businesses/:bizId/rrhh/config
async function getConfig(req, res) {
  let branchId;
  try {
    branchId = await resolverSucursal(req.businessId, req.query.branchId);
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : 'internal' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSeed(client, req.businessId, branchId);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[rrhh.getConfig seed]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
  client.release();
  let sync = null;
  try {
    sync = await sincronizarNomina(await nominaDe(req.businessId));
    if (sync && (sync.altas?.length || sync.bajas?.length)) {
      const partes = [];
      if (sync.altas.length) partes.push(`${sync.altas.length} ${sync.altas.length === 1 ? 'alta' : 'altas'}`);
      if (sync.bajas.length) partes.push(`${sync.bajas.length} ${sync.bajas.length === 1 ? 'baja' : 'bajas'}`);
      const nombres = [...sync.altas.map((n) => `+ ${n}`), ...sync.bajas.map((n) => `− ${n}`)];
      // automático: sin autor, le llega a todo el equipo
      avisarAlEquipoSinEsperar({
        businessId: req.businessId, type: 'rrhh_nomina', title: `Nómina sincronizada con MaxiRest: ${partes.join(' · ')}`,
        message: nombres.slice(0, 8).join(' · ') + (nombres.length > 8 ? ` y ${nombres.length - 8} más` : ''),
        metadata: { kind: 'rrhh_nomina', scope: 'rrhh' },
      });
    }
  } catch (e) {
    console.error('[rrhh.getConfig sync nómina]', e.message);
    sync = { error: true };
  }
  try {
    return res.json({ ok: true, config: await leerConfig(req.businessId, branchId), sync });
  } catch (e) {
    console.error('[rrhh.getConfig]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

/* PUT /api/businesses/:bizId/rrhh/config
 * Body: { puestos?, fechas?, espacios? } — cada colección presente se
 * sincroniza completa (así guarda en vivo cada pestaña de ⚙ Configuración).
 * Lo que está en uso no se borra: se informa en `avisos`.
 */
async function putConfig(req, res) {
  const bizId = req.businessId;
  const { puestos, fechas, espacios, renombres } = req.body || {};
  const avisos = [];
  let branchId;
  try {
    branchId = await resolverSucursal(bizId, req.query.branchId);
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : 'internal' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cambio de código de un puesto (Diego 13/11/2026: editar puestos desde el calendario): los
    // turnos ya cargados con el código viejo pasan al nuevo, solo en las semanas de este negocio.
    if (Array.isArray(renombres)) {
      for (const r of renombres) {
        const de = String(r?.de || '').trim(); const a = String(r?.a || '').trim();
        if (!de || !a || de === a) continue;
        await client.query(
          `UPDATE rrhh_celdas c SET puesto = $3
             FROM rrhh_filas f JOIN rrhh_semanas s ON s.id = f.semana_id
            WHERE c.fila_id = f.id AND s.business_id = $1 AND c.puesto = $2`,
          [bizId, de, a]
        );
      }
    }

    if (Array.isArray(puestos)) {
      const codigos = [];
      for (const p of puestos) {
        const codigo = String(p.codigo || '').trim();
        const nombre = String(p.nombre || '').trim();
        if (!codigo || !nombre) continue;
        codigos.push(codigo);
        await client.query(
          `INSERT INTO rrhh_puestos (business_id, codigo, nombre) VALUES ($1,$2,$3)
           ON CONFLICT (business_id, codigo) DO UPDATE SET nombre = EXCLUDED.nombre`,
          [bizId, codigo, nombre]
        );
      }
      const { rows: enUso } = await client.query(
        `SELECT DISTINCT c.puesto FROM rrhh_celdas c
         JOIN rrhh_filas f ON f.id = c.fila_id
         JOIN rrhh_semanas s ON s.id = f.semana_id
         WHERE s.business_id=$1 AND c.puesto IS NOT NULL`, [bizId]
      );
      const usados = new Set(enUso.map((r) => r.puesto));
      const { rows: borrables } = await client.query(
        `SELECT codigo FROM rrhh_puestos WHERE business_id=$1 AND NOT (codigo = ANY($2::text[]))`,
        [bizId, codigos]
      );
      for (const { codigo } of borrables) {
        if (usados.has(codigo)) {
          avisos.push(`La referencia "${codigo}" está en uso en algún cronograma: no se borró.`);
        } else {
          await client.query(
            'DELETE FROM rrhh_puestos WHERE business_id=$1 AND codigo=$2', [bizId, codigo]
          );
        }
      }
    }

    if (Array.isArray(fechas)) {
      // La colección que se manda es la que ve esta sucursal: las compartidas
      // + las suyas. Solo se sincroniza ese alcance (nunca toca eventos de otra).
      const diasComp = []; const diasSuc = [];
      for (const f of fechas) {
        const fecha = String(f.fecha || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
        const tipo = String(f.tipo || 'feriado');
        const comp = esCompartida(tipo);
        (comp ? diasComp : diasSuc).push(fecha);
        await client.query(
          `INSERT INTO rrhh_fechas (business_id, fecha, tipo, nombre, suma_promedio, fijo, compartida, branch_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (business_id, compartida, (COALESCE(branch_id, 0)), fecha) DO UPDATE
             SET tipo=EXCLUDED.tipo, nombre=EXCLUDED.nombre,
                 suma_promedio=EXCLUDED.suma_promedio, fijo=EXCLUDED.fijo`,
          [bizId, fecha, tipo, f.nombre || null, !!f.sumaPromedio, !!f.fijo, comp, comp ? null : branchId]
        );
      }
      await client.query(
        `DELETE FROM rrhh_fechas WHERE business_id=$1 AND compartida AND NOT (fecha = ANY($2::date[]))`,
        [bizId, diasComp]
      );
      await client.query(
        `DELETE FROM rrhh_fechas WHERE business_id=$1 AND NOT compartida
           AND branch_id IS NOT DISTINCT FROM $2 AND NOT (fecha = ANY($3::date[]))`,
        [bizId, branchId, diasSuc]
      );
    }

    if (Array.isArray(espacios)) {
      const idsEspacios = [];
      for (const [i, e] of espacios.entries()) {
        const nombre = String(e.nombre || '').trim();
        if (!nombre) continue;
        let espId = asInt(e.id);
        if (espId) {
          const up = await client.query(
            `UPDATE rrhh_espacios SET nombre=$3, sector_nomina=$4, orden=$5
             WHERE id=$1 AND business_id=$2 AND branch_id IS NOT DISTINCT FROM $6`,
            [espId, bizId, nombre, e.sectorNomina || null, i, branchId]
          );
          if (!up.rowCount) continue; // espacio de otra sucursal: no se toca
        } else {
          const r = await client.query(
            `INSERT INTO rrhh_espacios (business_id, nombre, sector_nomina, orden, branch_id)
             VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [bizId, nombre, e.sectorNomina || null, i, branchId]
          );
          espId = r.rows[0].id;
        }
        idsEspacios.push(espId);

        const turnos = Array.isArray(e.turnos) ? e.turnos : [];
        const idsTurnos = [];
        for (const [j, t] of turnos.entries()) {
          const tNombre = String(t.nombre || '').trim();
          if (!tNombre) continue;
          let turnoId = asInt(t.id);
          if (turnoId) {
            await client.query(
              `UPDATE rrhh_turnos SET nombre=$2, entrada=$3, orden=$4
               WHERE id=$1 AND espacio_id=$5`,
              [turnoId, tNombre, t.entrada || null, j, espId]
            );
          } else {
            const r = await client.query(
              `INSERT INTO rrhh_turnos (espacio_id, nombre, entrada, orden)
               VALUES ($1,$2,$3,$4) RETURNING id`,
              [espId, tNombre, t.entrada || null, j]
            );
            turnoId = r.rows[0].id;
          }
          idsTurnos.push(turnoId);
        }
        // Un espacio nuevo nunca queda sin turnos (sería inutilizable)
        if (!idsTurnos.length) {
          const r = await client.query(
            `INSERT INTO rrhh_turnos (espacio_id, nombre, entrada, orden)
             VALUES ($1,'Día','10:00',0), ($1,'Noche','19:00',1) RETURNING id`,
            [espId]
          );
          idsTurnos.push(...r.rows.map((x) => x.id));
        }
        const { rows: turnosSobran } = await client.query(
          `SELECT id, nombre FROM rrhh_turnos
           WHERE espacio_id=$1 AND NOT (id = ANY($2::bigint[]))`, [espId, idsTurnos]
        );
        for (const t of turnosSobran) {
          const { rows: conFilas } = await client.query(
            'SELECT 1 FROM rrhh_filas WHERE turno_id=$1 LIMIT 1', [t.id]
          );
          if (conFilas.length) {
            avisos.push(`El turno "${t.nombre}" tiene cronogramas cargados: no se borró.`);
          } else {
            await client.query('DELETE FROM rrhh_turnos WHERE id=$1', [t.id]);
          }
        }
      }
      const { rows: espSobran } = await client.query(
        `SELECT id, nombre FROM rrhh_espacios
         WHERE business_id=$1 AND branch_id IS NOT DISTINCT FROM $3
           AND NOT (id = ANY($2::bigint[]))`, [bizId, idsEspacios, branchId]
      );
      for (const e of espSobran) {
        const { rows: conSemanas } = await client.query(
          'SELECT 1 FROM rrhh_semanas WHERE espacio_id=$1 LIMIT 1', [e.id]
        );
        if (conSemanas.length) {
          avisos.push(`El espacio "${e.nombre}" tiene cronogramas cargados: no se borró.`);
        } else {
          await client.query('DELETE FROM rrhh_espacios WHERE id=$1', [e.id]);
        }
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[rrhh.putConfig]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
  client.release();
  {
    const que = [Array.isArray(espacios) && 'espacios y turnos', Array.isArray(puestos) && 'referencias', Array.isArray(fechas) && 'fechas especiales'].filter(Boolean);
    if (que.length) {
      avisarRrhh(req, 'rrhh_config', `Cronogramas: cambios en ${que.join(' y ')}`, avisos.length ? avisos.join(' ') : null,
        {}, { clave: `rrhh_config:${bizId}:${branchId || 0}:${que.join(',')}:${req.user?.id || 0}` });
    }
  }
  try {
    return res.json({ ok: true, avisos, config: await leerConfig(bizId, branchId) });
  } catch (e) {
    console.error('[rrhh.putConfig leer]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

/* ───────────────────────── empleados ───────────────────────── */

// La nómina de MaxiRest mezcla empleados reales con usuarios técnicos del POS
// (RAPPI, CAJERO, Soporte…) y ningún campo los separa de forma confiable, así
// que el import es CON SELECCIÓN: GET lista la réplica para tildar, POST
// importa los elegidos (sin body importa todos los listables).
function leerNominaReplica(origen) {
  // schema/pdv salen de PDV_MAP (whitelist), nunca del request
  return pool.query(
    `SELECT codigo, nombre, apellido, sector
     FROM ${origen.schema}.i000_nomina
     WHERE pdv = $1 AND fecha_baja IS NULL AND codigo IS NOT NULL
       AND (COALESCE(TRIM(nombre),'') <> '' OR COALESCE(TRIM(apellido),'') <> '')
     ORDER BY nombre, apellido`,
    [origen.pdv]
  );
}

// GET /api/businesses/:bizId/rrhh/empleados/nomina-maxirest
async function listarNominaMaxirest(req, res) {
  const origen = replicaDeNegocio(req.businessId);
  if (!origen) {
    return res.status(400).json({
      ok: false, error: 'sin_replica',
      message: 'Este negocio no está integrado con tu PDV: su nómina no entra sola.',
    });
  }
  try {
    const { rows } = await leerNominaReplica(origen);
    const { rows: ya } = await pool.query(
      `SELECT codigo_maxi FROM rrhh_empleados
       WHERE business_id=$1 AND codigo_maxi IS NOT NULL`, [req.businessId]
    );
    const importados = new Set(ya.map((r) => r.codigo_maxi));
    return res.json({
      ok: true,
      nomina: rows.map((r) => ({
        codigo: String(r.codigo).trim(),
        nombre: titulo(r.nombre) || null,
        apellido: titulo(r.apellido) || null,
        sector: r.sector || null,
        yaImportado: importados.has(String(r.codigo).trim()),
      })),
    });
  } catch (e) {
    console.error('[rrhh.listarNominaMaxirest]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

/* POST /api/businesses/:bizId/rrhh/empleados/importar   body: { codigos?: [] }
 * Importa de la réplica los códigos elegidos (o todos los listables si no se
 * manda body). Los que ya existen (mismo codigo_maxi) se dejan como están.
 */
async function importarNomina(req, res) {
  const bizId = req.businessId;
  const origen = replicaDeNegocio(bizId);
  if (!origen) {
    return res.status(400).json({
      ok: false, error: 'sin_replica',
      message: 'Este negocio no está integrado con tu PDV: su nómina no entra sola.',
    });
  }
  const filtro = Array.isArray(req.body?.codigos)
    ? new Set(req.body.codigos.map((c) => String(c).trim()))
    : null;
  try {
    const { rows } = await leerNominaReplica(origen);
    const elegidos = rows.filter((r) => !filtro || filtro.has(String(r.codigo).trim()));
    let importados = 0;
    for (const r of elegidos) {
      const ins = await pool.query(
        `INSERT INTO rrhh_empleados (business_id, codigo_maxi, nombre, apellido, sector, activo, origen)
         VALUES ($1,$2,$3,$4,$5,TRUE,'maxirest')
         ON CONFLICT (business_id, codigo_maxi) DO NOTHING
         RETURNING id`,
        [bizId, String(r.codigo).trim(), titulo(r.nombre) || String(r.codigo).trim(),
          titulo(r.apellido) || null, r.sector || null]
      );
      importados += ins.rowCount;
    }
    if (importados) {
      avisarRrhh(req, 'rrhh_nomina', `Nómina importada: ${importados} ${importados === 1 ? 'empleado' : 'empleados'}`, 'Desde MaxiRest');
    }
    return res.json({
      ok: true, importados, elegidos: elegidos.length,
      existentes: elegidos.length - importados,
    });
  } catch (e) {
    console.error('[rrhh.importarNomina]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

// POST /api/businesses/:bizId/rrhh/empleados   body: { nombre, apellido?, sector? }
async function crearEmpleado(req, res) {
  const nombre = String(req.body?.nombre || '').trim();
  if (!nombre) return res.status(400).json({ ok: false, error: 'nombre_required' });
  try {
    const nominaId = await nominaDe(req.businessId);
    const dni = dniDe(req.body?.dni) || null;
    const fechaAlta = fechaAltaDe(req.body?.fechaAlta) || null;
    const yaLoTiene = await dniRepetido(nominaId, dni);
    if (yaLoTiene) return res.status(409).json({ ok: false, error: 'dni_repetido', message: `Ese DNI ya lo tiene ${yaLoTiene}.` });
    const { rows } = await pool.query(
      `INSERT INTO rrhh_empleados (business_id, nombre, apellido, sector, activo, origen, fecha_alta, dni)
       VALUES ($1,$2,$3,$4,TRUE,'manual',$5,$6)
       RETURNING id, codigo_maxi AS "codigoMaxi", nombre, apellido, sector, activo, origen,
                 to_char(fecha_alta,'YYYY-MM-DD') AS "fechaAlta", dni`,
      [nominaId, nombre, String(req.body?.apellido || '').trim() || null,
        req.body?.sector || null, fechaAlta, dni]
    );
    avisarRrhh(req, 'rrhh_empleado_alta', `Alta: ${nombreEmp(rows[0])}`,
      ['Nómina', rows[0].fechaAlta ? `desde ${ddmmaaaa(rows[0].fechaAlta)}` : null, rows[0].dni ? `DNI ${rows[0].dni}` : null].filter(Boolean).join(' · '),
      { ids: [rows[0].id] });
    return res.json({ ok: true, empleado: rows[0] });
  } catch (e) {
    console.error('[rrhh.crearEmpleado]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

// Un aviso por guardado: baja / reactivación / No aplica tienen título propio; el resto de
// los cambios de datos van como «Empleado editado» con el antes → después.
function avisarCambioEmpleado(req, a, d, b) {
  if (!a || !d) return;
  const quien = nombreEmp(d);
  const meta = { ids: [d.id] };
  if (a.activo && d.activo === false) {
    avisarRrhh(req, 'rrhh_empleado_baja', `Baja: ${quien}${d.fechaBaja ? ` (${ddmmaaaa(d.fechaBaja)})` : ''}`, 'Nómina', meta);
    return;
  }
  if (a.activo === false && d.activo) {
    avisarRrhh(req, 'rrhh_empleado_reactivar', `Reactivado: ${quien}`, 'Nómina', meta);
    return;
  }
  if (!!a.noAplica !== !!d.noAplica) {
    avisarRrhh(req, 'rrhh_empleado_no_aplica', d.noAplica ? `No aplica a cronogramas: ${quien}` : `Vuelve a cronogramas: ${quien}`, 'Nómina', meta);
    return;
  }
  if (b.silenciarBaja === true) {
    avisarRrhh(req, 'rrhh_empleado_edit', `Sigue activo: ${quien}`, 'No se sugiere la baja por 8 semanas', meta);
    return;
  }
  const cambios = [];
  const par = (rot, x, y) => { if ((x || '') !== (y || '')) cambios.push(`${rot}: ${x || '—'} → ${y || '—'}`); };
  par('Nombre', nombreEmp(a), quien);
  par('Sector', a.sector, d.sector);
  par('Alta', ddmmaaaa(a.fechaAlta), ddmmaaaa(d.fechaAlta));
  par('DNI', a.dni, d.dni);
  if (cambios.length) avisarRrhh(req, 'rrhh_empleado_edit', `Empleado editado: ${quien}`, cambios.join(' · '), meta);
}

// PATCH /api/businesses/:bizId/rrhh/empleados/:id
async function editarEmpleado(req, res) {
  const id = asInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'id_required' });
  const b = req.body || {};
  // Baja: fechaBaja 'YYYY-MM-DD' o vacía (= hoy en Argentina). Reactivar la borra.
  const fechaBaja = typeof b.fechaBaja === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.fechaBaja) ? b.fechaBaja : null;
  const fechaAlta = fechaAltaDe(b.fechaAlta);
  const dni = dniDe(b.dni);
  try {
    const nominaId = await nominaDe(req.businessId);
    const yaLoTiene = await dniRepetido(nominaId, dni, id);
    if (yaLoTiene) return res.status(409).json({ ok: false, error: 'dni_repetido', message: `Ese DNI ya lo tiene ${yaLoTiene}.` });
    // cómo estaba, para que el aviso diga qué cambió
    const { rows: antes } = await pool.query(
      `SELECT nombre, apellido, sector, activo, no_aplica_crono AS "noAplica",
              to_char(fecha_alta,'YYYY-MM-DD') AS "fechaAlta", dni
         FROM rrhh_empleados WHERE id=$1 AND business_id=$2`, [id, nominaId]
    );
    const { rows } = await pool.query(
      `UPDATE rrhh_empleados SET
         nombre   = COALESCE($3, nombre),
         apellido = CASE WHEN $4::text IS NOT NULL THEN NULLIF($4,'') ELSE apellido END,
         sector   = CASE WHEN $5::text IS NOT NULL THEN NULLIF($5,'') ELSE sector END,
         fecha_baja = CASE
           WHEN $6 IS TRUE THEN NULL
           WHEN $6 IS FALSE AND (activo OR $7::date IS NOT NULL)
             THEN COALESCE($7::date, (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date)
           ELSE fecha_baja END,
         activo   = COALESCE($6, activo),
         no_aplica_crono = COALESCE($8, no_aplica_crono),
         baja_sug_silenciada = CASE
           WHEN $9::boolean IS TRUE THEN (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
           ELSE baja_sug_silenciada END,
         fecha_alta = CASE WHEN $10::text IS NULL THEN fecha_alta ELSE NULLIF($10, '')::date END,
         dni        = CASE WHEN $11::text IS NULL THEN dni ELSE NULLIF($11, '') END
       WHERE id=$1 AND business_id=$2
       RETURNING id, codigo_maxi AS "codigoMaxi", nombre, apellido, sector, activo, origen,
                 to_char(baja_maxi,'YYYY-MM-DD') AS "bajaMaxi", to_char(fecha_baja,'YYYY-MM-DD') AS "fechaBaja",
                 to_char(fecha_alta,'YYYY-MM-DD') AS "fechaAlta", dni,
                 no_aplica_crono AS "noAplica"`,
      [id, nominaId,
        typeof b.nombre === 'string' && b.nombre.trim() ? b.nombre.trim() : null,
        typeof b.apellido === 'string' ? b.apellido.trim() : null,
        typeof b.sector === 'string' ? b.sector : null,
        typeof b.activo === 'boolean' ? b.activo : null,
        fechaBaja,
        typeof b.noAplica === 'boolean' ? b.noAplica : null,
        b.silenciarBaja === true,
        fechaAlta === undefined ? null : fechaAlta,
        dni === undefined ? null : dni]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'not_found' });
    avisarCambioEmpleado(req, antes[0], rows[0], b);
    return res.json({ ok: true, empleado: rows[0] });
  } catch (e) {
    console.error('[rrhh.editarEmpleado]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

/* ───────────────────────── nómina compartida ─────────────────────────
 * GET    /nomina/candidatos  → negocios de la cartera del usuario (menos este)
 *                              con cuántos empleados tiene su nómina.
 * PUT    /nomina/vinculo     body { origenBusinessId } → este negocio pasa a usar
 *                              la nómina de ese (siempre se guarda la raíz).
 * DELETE /nomina/vinculo     → deja de compartir (si no hay cronogramas cargados).
 */
async function candidatosNomina(req, res) {
  try {
    const accesibles = await listAccessibleBusinesses(req.user?.id);
    const ids = [...new Set(accesibles.map((a) => Number(a.business_id)))].filter((id) => id !== Number(req.businessId));
    if (!ids.length) return res.json({ ok: true, negocios: [] });
    const { rows } = await pool.query(
      `SELECT b.id, b.name AS nombre,
              v.origen_business_id AS "origenId", o.name AS "origenNombre",
              (SELECT count(*)::int FROM rrhh_empleados e
                WHERE e.business_id = COALESCE(v.origen_business_id, b.id) AND e.activo) AS empleados
       FROM app_businesses b
       LEFT JOIN rrhh_nomina_vinculo v ON v.business_id = b.id
       LEFT JOIN app_businesses o ON o.id = v.origen_business_id
       WHERE b.id = ANY($1::bigint[])
       ORDER BY empleados DESC, b.name`, [ids]
    );
    return res.json({ ok: true, negocios: rows });
  } catch (e) {
    console.error('[rrhh.candidatosNomina]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

async function vincularNomina(req, res) {
  const bizId = Number(req.businessId);
  const pedido = asInt(req.body?.origenBusinessId);
  if (!pedido || pedido === bizId) return res.status(400).json({ ok: false, error: 'origen_invalido' });
  try {
    if (!(await getEffectiveRole(req.user?.id, pedido))) {
      return res.status(403).json({ ok: false, error: 'sin_acceso_al_origen', message: 'Ese negocio no es de tu cartera.' });
    }
    const raiz = await nominaDe(pedido);
    if (raiz === bizId) return res.status(400).json({ ok: false, error: 'ciclo', message: 'Ese negocio ya usa la nómina de este.' });
    const { rows: propios } = await pool.query('SELECT 1 FROM rrhh_empleados WHERE business_id=$1 LIMIT 1', [bizId]);
    if (propios.length) {
      return res.status(409).json({ ok: false, error: 'tiene_nomina_propia', message: 'Este negocio ya tiene empleados propios: no se puede vincular a otra nómina.' });
    }
    const { rows: deps } = await pool.query('SELECT 1 FROM rrhh_nomina_vinculo WHERE origen_business_id=$1 LIMIT 1', [bizId]);
    if (deps.length) {
      return res.status(409).json({ ok: false, error: 'tiene_dependientes', message: 'Otros negocios usan la nómina de este: no se puede vincular.' });
    }
    await pool.query(
      `INSERT INTO rrhh_nomina_vinculo (business_id, origen_business_id) VALUES ($1,$2)
       ON CONFLICT (business_id) DO UPDATE SET origen_business_id = EXCLUDED.origen_business_id, created_at = now()`,
      [bizId, raiz]
    );
    const nombreOrigen = await nombreNegocio(raiz);
    avisarRrhh(req, 'rrhh_nomina', `Nómina compartida con ${nombreOrigen}`, 'Las altas, bajas y cambios se ven en los dos negocios');
    return res.json({ ok: true, compartidaCon: { id: raiz, nombre: nombreOrigen } });
  } catch (e) {
    console.error('[rrhh.vincularNomina]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

async function desvincularNomina(req, res) {
  const bizId = Number(req.businessId);
  try {
    const { rows: cargadas } = await pool.query(
      `SELECT 1 FROM rrhh_celdas c JOIN rrhh_filas f ON f.id = c.fila_id
       JOIN rrhh_semanas s ON s.id = f.semana_id WHERE s.business_id=$1 LIMIT 1`, [bizId]
    );
    if (cargadas.length) {
      return res.status(409).json({ ok: false, error: 'tiene_cronogramas', message: 'Este negocio ya tiene cronogramas con esa gente: no se puede dejar de compartir.' });
    }
    const { rowCount } = await pool.query('DELETE FROM rrhh_nomina_vinculo WHERE business_id=$1', [bizId]);
    if (rowCount) avisarRrhh(req, 'rrhh_nomina', 'Dejó de compartir la nómina', 'Este negocio vuelve a tener nómina propia');
    return res.json({ ok: true, eliminado: rowCount > 0 });
  } catch (e) {
    console.error('[rrhh.desvincularNomina]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

/* ───────────────────────── semanas ───────────────────────── */

// GET /api/businesses/:bizId/rrhh/semanas → lista liviana (para calendario y tabs)
async function listarSemanas(req, res) {
  try {
    const { rows } = await pool.query(
      `SELECT id, espacio_id AS "espacioId", semana,
              to_char(fecha_inicio,'YYYY-MM-DD') AS "fechaInicio"
       FROM rrhh_semanas WHERE business_id=$1 ORDER BY semana, espacio_id`,
      [req.businessId]
    );
    return res.json({ ok: true, semanas: rows });
  } catch (e) {
    console.error('[rrhh.listarSemanas]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

async function leerSemana(bizId, espacioId, semana) {
  const sem = await pool.query(
    `SELECT id, to_char(fecha_inicio,'YYYY-MM-DD') AS "fechaInicio"
     FROM rrhh_semanas WHERE business_id=$1 AND espacio_id=$2 AND semana=$3`,
    [bizId, espacioId, semana]
  );
  if (!sem.rows[0]) return null;
  const semanaId = sem.rows[0].id;
  const filas = await pool.query(
    `SELECT f.id, f.turno_id AS "turnoId", f.orden, f.owner_empleado_id AS "ownerEmpleadoId"
     FROM rrhh_filas f WHERE f.semana_id=$1 ORDER BY f.turno_id, f.orden, f.id`,
    [semanaId]
  );
  const celdas = await pool.query(
    `SELECT c.fila_id AS "filaId", c.dia, c.empleado_id AS "empleadoId", c.puesto, c.horas, c.entrada, c.salida
     FROM rrhh_celdas c JOIN rrhh_filas f ON f.id = c.fila_id
     WHERE f.semana_id=$1 ORDER BY c.fila_id, c.dia`,
    [semanaId]
  );
  const celdasPorFila = new Map();
  for (const c of celdas.rows) {
    if (!celdasPorFila.has(c.filaId)) celdasPorFila.set(c.filaId, []);
    celdasPorFila.get(c.filaId).push({
      dia: c.dia, empleadoId: c.empleadoId, puesto: c.puesto, horas: Number(c.horas), entrada: c.entrada || null, salida: c.salida || null,
    });
  }
  const porTurno = new Map();
  for (const f of filas.rows) {
    if (!porTurno.has(f.turnoId)) porTurno.set(f.turnoId, []);
    porTurno.get(f.turnoId).push({
      id: f.id,
      ownerEmpleadoId: f.ownerEmpleadoId,
      celdas: celdasPorFila.get(f.id) || [],
    });
  }
  return {
    id: semanaId,
    espacioId,
    semana,
    fechaInicio: sem.rows[0].fechaInicio,
    turnos: [...porTurno.entries()].map(([turnoId, fs]) => ({ turnoId, filas: fs })),
  };
}

// GET /api/businesses/:bizId/rrhh/semanas/:semana?espacioId=N
async function getSemana(req, res) {
  const semana = asInt(req.params.semana);
  const espacioId = asInt(req.query.espacioId);
  if (!semana || !espacioId) {
    return res.status(400).json({ ok: false, error: 'semana_y_espacioId_requeridos' });
  }
  try {
    const data = await leerSemana(req.businessId, espacioId, semana);
    if (!data) return res.json({ ok: true, found: false, semana: null });
    return res.json({ ok: true, found: true, semana: data });
  } catch (e) {
    console.error('[rrhh.getSemana]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

/* PUT /api/businesses/:bizId/rrhh/semanas/:semana
 * Body: { espacioId, fechaInicio, turnos: [{ turnoId, filas: [{ ownerEmpleadoId?,
 *         celdas: [{ dia, empleadoId, puesto?, horas? }] }] }] }
 * Reemplaza la semana completa de ese espacio en una transacción (así guarda
 * el front tras cada acción). Revalida la regla UNA FILA POR EMPLEADO POR TURNO.
 */
async function putSemana(req, res) {
  const bizId = req.businessId;
  let semanaNueva = false; let espacioNombre = '';
  const semana = asInt(req.params.semana);
  const b = req.body || {};
  const espacioId = asInt(b.espacioId);
  const fechaInicio = String(b.fechaInicio || '').slice(0, 10);
  const turnos = Array.isArray(b.turnos) ? b.turnos : [];
  if (!semana || !espacioId || !/^\d{4}-\d{2}-\d{2}$/.test(fechaInicio)) {
    return res.status(400).json({ ok: false, error: 'payload_invalido' });
  }

  // Regla del módulo: una fila por empleado por turno (repetirse, solo entre turnos)
  for (const t of turnos) {
    const duenos = new Set();
    for (const fila of (Array.isArray(t.filas) ? t.filas : [])) {
      const celdas = Array.isArray(fila.celdas) ? fila.celdas : [];
      const empleadosFila = new Set(celdas.map((c) => asInt(c.empleadoId)).filter(Boolean));
      const dueno = asInt(fila.ownerEmpleadoId)
        || (empleadosFila.size === 1 ? [...empleadosFila][0] : null);
      if (!dueno) continue;
      if (duenos.has(dueno)) {
        return res.status(409).json({
          ok: false, error: 'empleado_repetido_en_turno',
          message: 'Un empleado no puede tener dos filas en el mismo turno.',
        });
      }
      duenos.add(dueno);
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: esp } = await client.query(
      'SELECT nombre FROM rrhh_espacios WHERE id=$1 AND business_id=$2', [espacioId, bizId]
    );
    if (!esp.length) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ ok: false, error: 'espacio_not_found' });
    }

    const up = await client.query(
      `INSERT INTO rrhh_semanas (business_id, espacio_id, semana, fecha_inicio)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (business_id, espacio_id, semana)
         DO UPDATE SET fecha_inicio = EXCLUDED.fecha_inicio
       RETURNING id, (xmax = 0) AS nueva`,
      [bizId, espacioId, semana, fechaInicio]
    );
    const semanaId = up.rows[0].id;
    semanaNueva = !!up.rows[0].nueva;
    espacioNombre = esp[0]?.nombre || '';

    await client.query('DELETE FROM rrhh_filas WHERE semana_id=$1', [semanaId]);

    for (const t of turnos) {
      const turnoId = asInt(t.turnoId);
      if (!turnoId) continue;
      const { rows: tOk } = await client.query(
        'SELECT 1 FROM rrhh_turnos WHERE id=$1 AND espacio_id=$2', [turnoId, espacioId]
      );
      if (!tOk.length) throw new Error(`turno ${turnoId} no pertenece al espacio ${espacioId}`);
      const filas = Array.isArray(t.filas) ? t.filas : [];
      for (const [i, fila] of filas.entries()) {
        const f = await client.query(
          `INSERT INTO rrhh_filas (semana_id, turno_id, orden, owner_empleado_id)
           VALUES ($1,$2,$3,$4) RETURNING id`,
          [semanaId, turnoId, i, asInt(fila.ownerEmpleadoId) || null]
        );
        const filaId = f.rows[0].id;
        for (const c of (Array.isArray(fila.celdas) ? fila.celdas : [])) {
          const dia = asInt(c.dia);
          const empleadoId = asInt(c.empleadoId);
          if (dia == null || dia < 0 || dia > 6 || !empleadoId) continue;
          const horas = Number(c.horas);
          await client.query(
            `INSERT INTO rrhh_celdas (fila_id, dia, empleado_id, puesto, horas, entrada, salida)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (fila_id, dia) DO UPDATE
               SET empleado_id=EXCLUDED.empleado_id, puesto=EXCLUDED.puesto, horas=EXCLUDED.horas, entrada=EXCLUDED.entrada, salida=EXCLUDED.salida`,
            [filaId, dia, empleadoId, c.puesto || null,
              Number.isFinite(horas) && horas > 0 ? horas : 8,
              // hora de entrada propia ('HH:MM'); vacía = la del turno
              /^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.entrada || '')) ? c.entrada : null,
              // hora de salida opcional ('HH:MM')
              /^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.salida || '')) ? c.salida : null]
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[rrhh.putSemana]', e);
    const esFk = e && e.code === '23503';
    return res.status(esFk ? 400 : 500).json({
      ok: false, error: esFk ? 'referencia_invalida' : 'internal',
    });
  }
  client.release();
  {
    const nro = String(semana).slice(4);
    const totalCeldas = turnos.reduce((a, t) => a + (Array.isArray(t.filas) ? t.filas : []).reduce((x, f) => x + (Array.isArray(f.celdas) ? f.celdas.length : 0), 0), 0);
    // el autoguardado manda la semana entera cada pocos segundos: un solo aviso por persona,
    // espacio y semana cada 30 minutos (se renueva, no se repite)
    avisarRrhh(req, 'rrhh_cronograma',
      `${semanaNueva ? 'Semana creada' : 'Cronograma editado'}: ${espacioNombre} · semana ${nro}`,
      `${totalCeldas} ${totalCeldas === 1 ? 'turno cargado' : 'turnos cargados'} · desde ${ddmmaaaa(fechaInicio)}`,
      { espacioId, semana },
      { clave: `rrhh_crono:${bizId}:${espacioId}:${semana}:${req.user?.id || 0}` });
  }
  try {
    return res.json({ ok: true, semana: await leerSemana(bizId, espacioId, semana) });
  } catch (e) {
    console.error('[rrhh.putSemana leer]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

// DELETE /api/businesses/:bizId/rrhh/semanas/:semana?espacioId=N
async function borrarSemana(req, res) {
  const semana = asInt(req.params.semana);
  const espacioId = asInt(req.query.espacioId);
  if (!semana || !espacioId) {
    return res.status(400).json({ ok: false, error: 'semana_y_espacioId_requeridos' });
  }
  try {
    const { rows: espB } = await pool.query('SELECT nombre FROM rrhh_espacios WHERE id=$1 AND business_id=$2', [espacioId, req.businessId]);
    const { rowCount } = await pool.query(
      'DELETE FROM rrhh_semanas WHERE business_id=$1 AND espacio_id=$2 AND semana=$3',
      [req.businessId, espacioId, semana]
    );
    if (rowCount) avisarRrhh(req, 'rrhh_cronograma', `Semana borrada: ${espB[0]?.nombre || ''} · semana ${String(semana).slice(4)}`, null, { espacioId, semana });
    return res.json({ ok: true, deleted: rowCount > 0 });
  } catch (e) {
    console.error('[rrhh.borrarSemana]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

module.exports = {
  getConfig, putConfig,
  listarNominaMaxirest, importarNomina, crearEmpleado, editarEmpleado,
  candidatosNomina, vincularNomina, desvincularNomina,
  listarSemanas, getSemana, putSemana, borrarSemana,
};