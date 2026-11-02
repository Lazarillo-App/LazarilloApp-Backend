// controllers/rrhhController.js
// RRHH · Etapa 1 (Cronogramas).
// El businessId ya viene resuelto y validado por loadActiveBusiness
// (req.businessId), igual que el resto de rutas /api/businesses/:bizId/...
//
// Modelo (ver db/migrations/live/063_rrhh_cronogramas.sql):
//   config  = empleados + puestos + fechas especiales + espacios (con turnos)
//   semana  = filas por turno, cada fila de UN empleado, celdas por día (0=Do…6=Sa)
//
// Los empleados son de Lazarillo: POST /empleados/importar trae la semilla de
// la réplica de MaxiRest (container/comercio.i000_nomina) una sola vez; las
// altas siguientes son propias.
'use strict';

const pool = require('../config/db');
const { PDV_MAP } = require('../services/maxiPdvMap');

/* ───────────────────────── helpers ───────────────────────── */

// businessId → { schema, pdv } en la réplica (derivado de PDV_MAP, que mapea
// pdv → negocio; acá hace falta la inversa para leer i000_nomina).
function replicaDeNegocio(businessId) {
  for (const [pdv, v] of Object.entries(PDV_MAP)) {
    if (v.businessId === Number(businessId)) return { schema: v.schema, pdv };
  }
  return null;
}

// "CANCINO" → "Cancino" (la réplica trae mayormente mayúsculas; es semilla editable)
function titulo(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/(^|[\s.'-])([a-záéíóúüñ])/g, (m, sep, ch) => sep + ch.toUpperCase())
    .trim();
}

const asInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/* ───────────────────────── seed de defaults ─────────────────────────
 * Primera vez que un negocio abre el módulo: espacios Salón/Cocina con turnos
 * Día/Noche, referencias estándar y feriados nacionales AR (los `fijo` se
 * renuevan solos al año vigente). Todo editable después desde ⚙ Configuración.
 */
const PUESTOS_DEF = [
  ['1', 'Plaza 1'], ['2', 'Plaza 2'], ['K', 'Caja'], ['Ba', 'Barista'],
  ['B', 'Bartender'], ['Co', 'Cocinero'], ['E', 'Encargado'], ['Ru', 'Runner'],
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

async function ensureSeed(client, bizId) {
  const { rows } = await client.query(
    'SELECT 1 FROM rrhh_espacios WHERE business_id=$1 LIMIT 1', [bizId]
  );
  if (!rows.length) {
    for (const [i, [nombre, sector]] of [['Salón', 'Salón'], ['Cocina', 'Cocina']].entries()) {
      const esp = await client.query(
        `INSERT INTO rrhh_espacios (business_id, nombre, sector_nomina, orden)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [bizId, nombre, sector, i]
      );
      await client.query(
        `INSERT INTO rrhh_turnos (espacio_id, nombre, entrada, orden)
         VALUES ($1,'Día','10:00',0), ($1,'Noche','19:00',1)`,
        [esp.rows[0].id]
      );
    }
  }

  await client.query(
    `INSERT INTO rrhh_puestos (business_id, codigo, nombre)
     SELECT $1, d.codigo, d.nombre
     FROM unnest($2::text[], $3::text[]) AS d(codigo, nombre)
     ON CONFLICT (business_id, codigo) DO NOTHING`,
    [bizId, PUESTOS_DEF.map((p) => p[0]), PUESTOS_DEF.map((p) => p[1])]
  );

  const anio = new Date().getUTCFullYear();
  const { rows: hayFechas } = await client.query(
    'SELECT 1 FROM rrhh_fechas WHERE business_id=$1 LIMIT 1', [bizId]
  );
  if (!hayFechas.length) {
    for (const [mm, dd, tipo, nombre, fijo] of FECHAS_DEF) {
      await client.query(
        `INSERT INTO rrhh_fechas (business_id, fecha, tipo, nombre, suma_promedio, fijo)
         VALUES ($1, make_date($2,$3,$4), $5, $6, FALSE, $7)
         ON CONFLICT (business_id, fecha) DO NOTHING`,
        [bizId, anio, mm, dd, tipo, nombre, fijo]
      );
    }
  }

  // Feriados inamovibles: cada año cae la misma fecha → se renuevan solos al
  // año vigente (las fechas móviles se re-fechan a mano desde ⚙ Fechas).
  await client.query(
    `INSERT INTO rrhh_fechas (business_id, fecha, tipo, nombre, suma_promedio, fijo)
     SELECT DISTINCT ON (EXTRACT(MONTH FROM fecha), EXTRACT(DAY FROM fecha))
            business_id,
            make_date($2, EXTRACT(MONTH FROM fecha)::int, EXTRACT(DAY FROM fecha)::int),
            tipo, nombre, suma_promedio, TRUE
     FROM rrhh_fechas
     WHERE business_id=$1 AND fijo = TRUE
     ORDER BY EXTRACT(MONTH FROM fecha), EXTRACT(DAY FROM fecha), fecha DESC
     ON CONFLICT (business_id, fecha) DO NOTHING`,
    [bizId, anio]
  );
}

/* ───────────────────────── config ───────────────────────── */

async function leerConfig(bizId) {
  const [empleados, puestos, fechas, espacios, turnos] = await Promise.all([
    pool.query(
      `SELECT id, codigo_maxi AS "codigoMaxi", nombre, apellido, sector, activo, origen
       FROM rrhh_empleados WHERE business_id=$1 ORDER BY nombre, apellido`, [bizId]
    ),
    pool.query(
      `SELECT id, codigo, nombre FROM rrhh_puestos WHERE business_id=$1 ORDER BY id`, [bizId]
    ),
    pool.query(
      `SELECT id, to_char(fecha,'YYYY-MM-DD') AS fecha, tipo, nombre,
              suma_promedio AS "sumaPromedio", fijo
       FROM rrhh_fechas WHERE business_id=$1 ORDER BY fecha`, [bizId]
    ),
    pool.query(
      `SELECT id, nombre, sector_nomina AS "sectorNomina", orden
       FROM rrhh_espacios WHERE business_id=$1 ORDER BY orden, id`, [bizId]
    ),
    pool.query(
      `SELECT t.id, t.espacio_id AS "espacioId", t.nombre, t.entrada, t.orden
       FROM rrhh_turnos t JOIN rrhh_espacios e ON e.id = t.espacio_id
       WHERE e.business_id=$1 ORDER BY t.orden, t.id`, [bizId]
    ),
  ]);
  const turnosPorEspacio = new Map();
  for (const t of turnos.rows) {
    if (!turnosPorEspacio.has(t.espacioId)) turnosPorEspacio.set(t.espacioId, []);
    turnosPorEspacio.get(t.espacioId).push(t);
  }
  return {
    empleados: empleados.rows,
    puestos: puestos.rows,
    fechas: fechas.rows,
    espacios: espacios.rows.map((e) => ({ ...e, turnos: turnosPorEspacio.get(e.id) || [] })),
  };
}

// GET /api/businesses/:bizId/rrhh/config
async function getConfig(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSeed(client, req.businessId);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[rrhh.getConfig seed]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
  client.release();
  try {
    return res.json({ ok: true, config: await leerConfig(req.businessId) });
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
  const { puestos, fechas, espacios } = req.body || {};
  const avisos = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
      const dias = [];
      for (const f of fechas) {
        const fecha = String(f.fecha || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
        dias.push(fecha);
        await client.query(
          `INSERT INTO rrhh_fechas (business_id, fecha, tipo, nombre, suma_promedio, fijo)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (business_id, fecha) DO UPDATE
             SET tipo=EXCLUDED.tipo, nombre=EXCLUDED.nombre,
                 suma_promedio=EXCLUDED.suma_promedio, fijo=EXCLUDED.fijo`,
          [bizId, fecha, String(f.tipo || 'feriado'), f.nombre || null,
            !!f.sumaPromedio, !!f.fijo]
        );
      }
      await client.query(
        `DELETE FROM rrhh_fechas WHERE business_id=$1 AND NOT (fecha = ANY($2::date[]))`,
        [bizId, dias]
      );
    }

    if (Array.isArray(espacios)) {
      const idsEspacios = [];
      for (const [i, e] of espacios.entries()) {
        const nombre = String(e.nombre || '').trim();
        if (!nombre) continue;
        let espId = asInt(e.id);
        if (espId) {
          await client.query(
            `UPDATE rrhh_espacios SET nombre=$3, sector_nomina=$4, orden=$5
             WHERE id=$1 AND business_id=$2`,
            [espId, bizId, nombre, e.sectorNomina || null, i]
          );
        } else {
          const r = await client.query(
            `INSERT INTO rrhh_espacios (business_id, nombre, sector_nomina, orden)
             VALUES ($1,$2,$3,$4) RETURNING id`,
            [bizId, nombre, e.sectorNomina || null, i]
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
         WHERE business_id=$1 AND NOT (id = ANY($2::bigint[]))`, [bizId, idsEspacios]
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
  try {
    return res.json({ ok: true, avisos, config: await leerConfig(bizId) });
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
      message: 'Este negocio no tiene nómina de MaxiRest en la réplica.',
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
      message: 'Este negocio no tiene nómina de MaxiRest en la réplica.',
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
    const { rows } = await pool.query(
      `INSERT INTO rrhh_empleados (business_id, nombre, apellido, sector, activo, origen)
       VALUES ($1,$2,$3,$4,TRUE,'manual')
       RETURNING id, codigo_maxi AS "codigoMaxi", nombre, apellido, sector, activo, origen`,
      [req.businessId, nombre, String(req.body?.apellido || '').trim() || null,
        req.body?.sector || null]
    );
    return res.json({ ok: true, empleado: rows[0] });
  } catch (e) {
    console.error('[rrhh.crearEmpleado]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

// PATCH /api/businesses/:bizId/rrhh/empleados/:id
async function editarEmpleado(req, res) {
  const id = asInt(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: 'id_required' });
  const b = req.body || {};
  try {
    const { rows } = await pool.query(
      `UPDATE rrhh_empleados SET
         nombre   = COALESCE($3, nombre),
         apellido = CASE WHEN $4::text IS NOT NULL THEN NULLIF($4,'') ELSE apellido END,
         sector   = CASE WHEN $5::text IS NOT NULL THEN NULLIF($5,'') ELSE sector END,
         activo   = COALESCE($6, activo)
       WHERE id=$1 AND business_id=$2
       RETURNING id, codigo_maxi AS "codigoMaxi", nombre, apellido, sector, activo, origen`,
      [id, req.businessId,
        typeof b.nombre === 'string' && b.nombre.trim() ? b.nombre.trim() : null,
        typeof b.apellido === 'string' ? b.apellido.trim() : null,
        typeof b.sector === 'string' ? b.sector : null,
        typeof b.activo === 'boolean' ? b.activo : null]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'not_found' });
    return res.json({ ok: true, empleado: rows[0] });
  } catch (e) {
    console.error('[rrhh.editarEmpleado]', e);
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
    `SELECT c.fila_id AS "filaId", c.dia, c.empleado_id AS "empleadoId", c.puesto, c.horas
     FROM rrhh_celdas c JOIN rrhh_filas f ON f.id = c.fila_id
     WHERE f.semana_id=$1 ORDER BY c.fila_id, c.dia`,
    [semanaId]
  );
  const celdasPorFila = new Map();
  for (const c of celdas.rows) {
    if (!celdasPorFila.has(c.filaId)) celdasPorFila.set(c.filaId, []);
    celdasPorFila.get(c.filaId).push({
      dia: c.dia, empleadoId: c.empleadoId, puesto: c.puesto, horas: Number(c.horas),
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
      'SELECT 1 FROM rrhh_espacios WHERE id=$1 AND business_id=$2', [espacioId, bizId]
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
       RETURNING id`,
      [bizId, espacioId, semana, fechaInicio]
    );
    const semanaId = up.rows[0].id;

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
          [semanaId, turnoId, i, asInt(fila.ownerEmpleadoId)]
        );
        const filaId = f.rows[0].id;
        for (const c of (Array.isArray(fila.celdas) ? fila.celdas : [])) {
          const dia = asInt(c.dia);
          const empleadoId = asInt(c.empleadoId);
          if (dia == null || dia < 0 || dia > 6 || !empleadoId) continue;
          const horas = Number(c.horas);
          await client.query(
            `INSERT INTO rrhh_celdas (fila_id, dia, empleado_id, puesto, horas)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (fila_id, dia) DO UPDATE
               SET empleado_id=EXCLUDED.empleado_id, puesto=EXCLUDED.puesto, horas=EXCLUDED.horas`,
            [filaId, dia, empleadoId, c.puesto || null,
              Number.isFinite(horas) && horas > 0 ? horas : 8]
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
    const { rowCount } = await pool.query(
      'DELETE FROM rrhh_semanas WHERE business_id=$1 AND espacio_id=$2 AND semana=$3',
      [req.businessId, espacioId, semana]
    );
    return res.json({ ok: true, deleted: rowCount > 0 });
  } catch (e) {
    console.error('[rrhh.borrarSemana]', e);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
}

module.exports = {
  getConfig, putConfig,
  listarNominaMaxirest, importarNomina, crearEmpleado, editarEmpleado,
  listarSemanas, getSemana, putSemana, borrarSemana,
};
