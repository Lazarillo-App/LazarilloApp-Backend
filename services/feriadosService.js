// services/feriadosService.js
// Calendario de feriados ÚNICO de Lazarillo (Diego 20/11/2026). Una sola fuente (lz_feriados, por
// zona) que heredan todos los negocios: nacional ('AR') + la de su provincia
// (app_businesses.zona_feriados). Lo propio del negocio sigue en rrhh_fechas (eventos, cerrados,
// vísperas) y manda sobre lo heredado; tipo 'no_aplica' = «este feriado abrimos igual».
// La usan: Cronogramas (config.feriados), la proyección de ventas y «Sin carga» de sueldos.
const pool = require('../config/db');

const ZONAS = [
  ['AR', 'Nacional'], ['AR-B', 'Provincia de Buenos Aires'], ['AR-C', 'Ciudad de Buenos Aires'],
  ['AR-X', 'Córdoba'], ['AR-S', 'Santa Fe'], ['AR-M', 'Mendoza'], ['AR-T', 'Tucumán'],
  ['AR-A', 'Salta'], ['AR-Q', 'Neuquén'], ['AR-U', 'Chubut'], ['AR-E', 'Entre Ríos'],
  ['AR-H', 'Chaco'], ['AR-N', 'Misiones'], ['AR-W', 'Corrientes'], ['AR-G', 'Santiago del Estero'],
  ['AR-J', 'San Juan'], ['AR-D', 'San Luis'], ['AR-F', 'La Rioja'], ['AR-K', 'Catamarca'],
  ['AR-Y', 'Jujuy'], ['AR-P', 'Formosa'], ['AR-L', 'La Pampa'], ['AR-R', 'Río Negro'],
  ['AR-Z', 'Santa Cruz'], ['AR-V', 'Tierra del Fuego'],
];
const TIPOS = ['inamovible', 'trasladable', 'no_laborable', 'extraordinario'];
const zonaValida = (z) => ZONAS.some(([k]) => k === z);

/** Feriados heredados de una zona (nacional + provincia), entre dos fechas ISO (incluidas). */
async function heredados(zona, desde, hasta, db = pool) {
  const zonas = zona && zona !== 'AR' ? ['AR', zona] : ['AR'];
  const { rows } = await db.query(
    `SELECT to_char(fecha,'YYYY-MM-DD') AS fecha, string_agg(DISTINCT nombre, ' · ') AS nombre,
            min(tipo) AS subtipo, string_agg(DISTINCT zona, ',') AS zona
       FROM lz_feriados
      WHERE zona = ANY($1::text[])
        AND ($2::date IS NULL OR fecha >= $2::date) AND ($3::date IS NULL OR fecha <= $3::date)
      GROUP BY fecha ORDER BY fecha`, [zonas, desde || null, hasta || null]
  );
  return rows.map((r) => ({ ...r, tipo: 'feriado', heredado: true }));
}

/** Zona de un negocio (null = solo nacional). */
async function zonaDe(businessId, db = pool) {
  const { rows } = await db.query('SELECT zona_feriados FROM app_businesses WHERE id = $1', [businessId]);
  return rows[0]?.zona_feriados || null;
}

/**
 * Calendario completo de un negocio: heredados + propios (rrhh_fechas). Lo propio manda; un
 * propio 'no_aplica' saca el heredado de ese día. `sucursal`: undefined = solo lo compartido;
 * número/null = también los eventos y cerrados de esa sucursal (null = principal).
 */
async function feriadosDe(businessId, { desde = null, hasta = null, sucursal } = {}, db = pool) {
  const zona = await zonaDe(businessId, db);
  const [her, { rows: prop }] = await Promise.all([
    heredados(zona, desde, hasta, db),
    db.query(
      `SELECT to_char(fecha,'YYYY-MM-DD') AS fecha, tipo, nombre, fijo
         FROM rrhh_fechas
        WHERE business_id = $1
          AND ($2::date IS NULL OR fecha >= $2::date) AND ($3::date IS NULL OR fecha <= $3::date)
          AND (compartida OR ($4::boolean AND branch_id IS NOT DISTINCT FROM $5::bigint))`,
      [businessId, desde, hasta, sucursal !== undefined, typeof sucursal === 'number' ? sucursal : null]
    ),
  ]);
  const porFecha = new Map(her.map((h) => [h.fecha, h]));
  const heredadas = new Set(porFecha.keys());
  // Un feriado propio en un día que ya trae el calendario (los que se sembraban antes del
  // 20/11/2026) no cuenta dos veces: manda el heredado. Eventos, cerrados y vísperas sí pisan.
  for (const p of prop) {
    if (p.tipo === 'no_aplica' || (p.tipo === 'feriado' && heredadas.has(p.fecha))) continue;
    porFecha.set(p.fecha, { fecha: p.fecha, tipo: p.tipo, nombre: p.nombre, fijo: !!p.fijo, heredado: false });
  }
  for (const p of prop) if (p.tipo === 'no_aplica') porFecha.delete(p.fecha);
  return [...porFecha.values()].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

/* ── caché de los NACIONALES por año, para el código sincrónico («Sin carga» de sueldos) ── */
const cacheNacional = new Map(); // año → [fechas]
async function refrescarNacionales() {
  try {
    const { rows } = await pool.query(
      `SELECT to_char(fecha,'YYYY-MM-DD') AS f FROM lz_feriados WHERE zona = 'AR' ORDER BY fecha`
    );
    const nuevo = new Map();
    for (const { f } of rows) { const y = Number(f.slice(0, 4)); if (!nuevo.has(y)) nuevo.set(y, []); nuevo.get(y).push(f); }
    cacheNacional.clear(); for (const [y, l] of nuevo) cacheNacional.set(y, l);
  } catch (e) { /* tabla todavía no creada: queda la lista fija de feriados.js */ }
}
function nacionalesDelAnio(anio) { return cacheNacional.get(Number(anio)) || null; }

/* ── ABM desde Panel super ── */
async function listar({ anio, zona } = {}) {
  const { rows } = await pool.query(
    `SELECT id, to_char(fecha,'YYYY-MM-DD') AS fecha, nombre, tipo, zona, fuente, updated_at
       FROM lz_feriados
      WHERE ($1::int IS NULL OR EXTRACT(YEAR FROM fecha) = $1::int)
        AND ($2::text IS NULL OR zona = $2::text)
      ORDER BY fecha, zona`, [anio ? Number(anio) : null, zona || null]
  );
  return { feriados: rows, zonas: ZONAS.map(([k, n]) => ({ zona: k, nombre: n })), tipos: TIPOS };
}
function limpiar(b) {
  const fecha = String(b.fecha || '').slice(0, 10);
  const nombre = String(b.nombre || '').trim().slice(0, 120);
  const tipo = TIPOS.includes(b.tipo) ? b.tipo : 'inamovible';
  const zona = zonaValida(b.zona) ? b.zona : 'AR';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !nombre) return null;
  return { fecha, nombre, tipo, zona, fuente: String(b.fuente || '').trim().slice(0, 200) || null };
}
async function guardar(id, body, userId) {
  const f = limpiar(body || {});
  if (!f) return { error: 'datos_invalidos', status: 400 };
  try {
    const { rows } = id
      ? await pool.query(
        `UPDATE lz_feriados SET fecha=$2, nombre=$3, tipo=$4, zona=$5, fuente=$6, updated_by=$7, updated_at=now()
          WHERE id=$1 RETURNING id`, [id, f.fecha, f.nombre, f.tipo, f.zona, f.fuente, userId])
      : await pool.query(
        `INSERT INTO lz_feriados (fecha, nombre, tipo, zona, fuente, updated_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [f.fecha, f.nombre, f.tipo, f.zona, f.fuente, userId]);
    if (!rows.length) return { error: 'no_encontrado', status: 404 };
    refrescarNacionales();
    return { id: rows[0].id, feriado: f };
  } catch (e) {
    if (e.code === '23505') return { error: 'ya_existe', status: 409 };
    throw e;
  }
}
async function borrar(id) {
  const { rows } = await pool.query(
    `DELETE FROM lz_feriados WHERE id=$1 RETURNING to_char(fecha,'YYYY-MM-DD') AS fecha, nombre, zona`, [id]);
  if (!rows.length) return { error: 'no_encontrado', status: 404 };
  refrescarNacionales();
  return { feriado: rows[0] };
}

module.exports = {
  ZONAS, TIPOS, zonaValida, heredados, zonaDe, feriadosDe, refrescarNacionales, nacionalesDelAnio,
  listar, guardar, borrar,
};
