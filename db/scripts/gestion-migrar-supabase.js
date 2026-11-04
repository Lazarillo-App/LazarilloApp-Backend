// db/scripts/gestion-migrar-supabase.js
// Trae a la base de Lazarillo la historia y lo cargado a mano en los dos Supabase de lazarillo_gestion.
//
// Corre en la PC de la usuaria: lee de Supabase (GESTION_RAMOS_DATABASE_URL, GESTION_COMERCIO_DATABASE_URL,
// solo lectura y solo en su .env local) y escribe en DATABASE_URL.
//
//   node db/scripts/gestion-migrar-supabase.js
//       PRUEBA: en destino solo lee. Muestra qué entraría, qué se saltea y qué no se pudo ubicar.
//   node db/scripts/gestion-migrar-supabase.js --aplicar --confirmo-host=<host de DATABASE_URL>
//       Escribe. Se puede volver a correr: no duplica (sirve para traer lo último antes de apagar gestion).
//   --arqueo-ramos=147|204   a qué negocio van los arqueos de la caja de Ramos Mejía (compartida por
//                            Bar y Canchas). Sin esta opción no se migran y se informa.
//
// Reglas de lo que entra:
// - Compras, detalle, pagos y ventas: por lugar y tabla, solo lo ANTERIOR al primer dato que ya había
//   en destino, porque de ahí en adelante manda la lectura del kit. Copiar todo traería errores que
//   gestion arregló solo hacia adelante (ventas de San Justo jun-oct 2025 duplicadas) y filas con otro
//   rowId. La fecha de corte se guarda en la primera corrida para que reanudar no la mueva.
// - De lo posterior al corte solo se traen las correcciones a mano sobre filas que ya existen. Lo que
//   no encuentre su fila se informa, no se inventa.
// - Lo cargado en gestion (origen lazarillo o arca) entra siempre: el kit no lo tiene.
// - Maestros: se agregan los que faltan. En la PRIMERA corrida, lo editado en gestion (conceptos, rubros
//   visibles) pisa lo que había; al volver a correr se respeta lo que se haya cambiado acá.
// - Al volver a correr: una regla borrada en gestion NO se borra acá, se avisa para revisarla.
// - No se migra: articulos y sus rubros (los trae el kit), logs de importación, corridas, orígenes,
//   Drive, respaldos, y proyecciones de ámbitos que no existen acá (todos los locales, "local entero").
'use strict';

require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const pool = require('../../config/db');

const APLICAR = process.argv.includes('--aplicar');
const argValor = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const ARQUEO_RAMOS = argValor('arqueo-ramos') ? Number(argValor('arqueo-ramos')) : null;
const SOLO = argValor('solo'); // ramos | comercio
const CHUNK = 1000;
const PAUSA_MS = APLICAR ? 40 : 0; // la base de producción es chica: no saturarla

const FUENTES = [
  {
    nombre: 'ramos', url: process.env.GESTION_RAMOS_DATABASE_URL, organizationId: 9, negocios: [147, 204], negocioNotas: 147,
    pdv: { 1: { businessId: 147, branchId: null }, 2: { businessId: 204, branchId: null }, 3: { businessId: 204, branchId: 15 } },
    // Un "local" de gestion: el 2 (San Justo) es una sucursal; el 1 (Ramos Mejía) junta dos negocios.
    local: { 1: { businessId: 147, branchId: null }, 2: { businessId: 204, branchId: 15 } },
    // ~40.000 renglones viejos sin compra: decisión de la usuaria (2026-11-02), van a Bar.
    pdvDetalleSinCompra: 1,
    ambito: { '1/1': { businessId: 147, ambito: 'principal' }, '1/2': { businessId: 204, ambito: 'principal' }, '2/3': { businessId: 204, ambito: '15', branchId: 15 } },
  },
  {
    nombre: 'comercio', url: process.env.GESTION_COMERCIO_DATABASE_URL, organizationId: 20, negocios: [210], negocioNotas: 210,
    pdv: { 1: { businessId: 210, branchId: null } },
    local: { 1: { businessId: 210, branchId: null } },
    pdvDetalleSinCompra: 1,
    ambito: { '1/1': { businessId: 210, ambito: 'principal' } },
  },
];

const idLugar = (l) => (l.branchId != null ? l.branchId : -l.businessId);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (c) => `"${c}"`;
const reporte = [];
const anotar = (fuente, tabla, datos) => {
  reporte.push({ fuente, tabla, ...datos });
  console.log(`  ${tabla.padEnd(30)} ${Object.entries(datos).map(([k, v]) => `${k}=${v}`).join('  ')}`);
};

// ── Lectura de Supabase: todo como texto, para no tocar fechas ni decimales ──
const tiposCrudos = { getTypeParser: () => (v) => v };
// El pooler de Supabase corta conexiones largas: cada lectura reintenta con una conexión nueva.
function conectarFuente(url) {
  let cliente = null;
  const abrir = async () => {
    const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false }, types: tiposCrudos });
    c.on('error', () => { if (cliente === c) cliente = null; }); // se reabre en la próxima lectura
    await c.connect();
    await c.query('SET default_transaction_read_only = on');
    cliente = c;
    return c;
  };
  return {
    async query(texto, params) {
      for (let intento = 1; ; intento += 1) {
        try {
          return await (cliente ?? await abrir()).query(texto, params);
        } catch (e) {
          // Un error de la consulta (tiene código de Postgres) no se arregla reintentando.
          if (e.code && !/^(08|57P)/.test(e.code)) throw e;
          cliente = null;
          if (intento >= 5) throw e;
          console.log(`    (lectura cortada: reintento ${intento})`);
          await dormir(2000 * intento);
        }
      }
    },
    async end() { const c = cliente; cliente = null; if (c) await c.end().catch(() => {}); },
  };
}
const columnas = async (cliente, tabla) => (await cliente.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [tabla])).rows.map((r) => r.column_name);

// Recorre una tabla grande de a tandas, por su clave primaria (usa el índice: sin cargarla en memoria).
async function* tandas(fuente, tabla, clave) {
  let ultimo = null;
  for (;;) {
    const { rows } = await fuente.query(
      `SELECT * FROM ${tabla} WHERE ($1::text IS NULL OR ${q(clave)} > $1) ORDER BY ${q(clave)} LIMIT ${CHUNK * 2}`, [ultimo]);
    if (!rows.length) return;
    yield rows;
    ultimo = rows[rows.length - 1][clave];
  }
}
// El lugar de cada compra de una tanda.
async function pdvDeCompras(fuente, ids) {
  if (!ids.length) return new Map();
  const { rows } = await fuente.query('SELECT "rowId", "puntoDeVentaId" FROM compras WHERE "rowId" = ANY($1::text[])', [ids]);
  return new Map(rows.map((r) => [r.rowId, r.puntoDeVentaId]));
}

// ── Escritura ──
async function insertar(tabla, cols, filas, cola = '') {
  if (!filas.length) return 0;
  if (!APLICAR) return filas.length;
  let n = 0;
  const lista = cols.map(q).join(', ');
  for (let i = 0; i < filas.length; i += CHUNK) {
    const r = await pool.query(
      `INSERT INTO ${tabla} (${lista}) SELECT ${lista} FROM jsonb_populate_recordset(NULL::${tabla}, $1::jsonb) ${cola}`,
      [JSON.stringify(filas.slice(i, i + CHUNK))]);
    n += r.rowCount;
    if (PAUSA_MS) await dormir(PAUSA_MS);
  }
  return n;
}

const yaExisten = async (tabla, businessId, ids, col = 'rowId') => {
  if (!ids.length) return new Set();
  const { rows } = await pool.query(`SELECT ${q(col)} AS x FROM ${tabla} WHERE business_id = $1 AND ${q(col)} = ANY($2::text[])`, [businessId, ids]);
  return new Set(rows.map((r) => r.x));
};

async function prepararDestino() {
  if (!APLICAR) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gestion_migracion_ids (fuente TEXT NOT NULL, tabla TEXT NOT NULL, id_origen TEXT NOT NULL, id_destino INTEGER NOT NULL, PRIMARY KEY (fuente, tabla, id_origen));
    CREATE TABLE IF NOT EXISTS gestion_migracion_cortes (fuente TEXT NOT NULL, tabla TEXT NOT NULL, lugar TEXT NOT NULL, corte DATE, PRIMARY KEY (fuente, tabla, lugar));`);
}
const existeTabla = async (t) => !!(await pool.query('SELECT to_regclass($1) AS r', [t])).rows[0].r;

async function mapaIds(fuente, tabla) {
  if (!(await existeTabla('gestion_migracion_ids'))) return new Map();
  const { rows } = await pool.query('SELECT id_origen, id_destino FROM gestion_migracion_ids WHERE fuente = $1 AND tabla = $2', [fuente, tabla]);
  return new Map(rows.map((r) => [r.id_origen, r.id_destino]));
}
const guardarId = (fuente, tabla, origen, destino) => pool.query(
  `INSERT INTO gestion_migracion_ids (fuente, tabla, id_origen, id_destino) VALUES ($1, $2, $3, $4)
   ON CONFLICT (fuente, tabla, id_origen) DO UPDATE SET id_destino = EXCLUDED.id_destino`, [fuente, tabla, String(origen), destino]);

// Por lugar: la fecha desde la que manda el kit. Se fija en la primera corrida.
async function cortes(f, tabla, destino) {
  const out = new Map();
  const guardados = (await existeTabla('gestion_migracion_cortes'))
    ? (await pool.query('SELECT lugar, corte::text AS corte FROM gestion_migracion_cortes WHERE fuente = $1 AND tabla = $2', [f.nombre, tabla])).rows : [];
  for (const g of guardados) out.set(g.lugar, g.corte);
  for (const l of Object.values(f.pdv)) {
    const k = String(idLugar(l));
    if (out.has(k)) continue;
    const { rows } = await pool.query(
      `SELECT MIN(fecha)::date::text AS corte FROM ${destino} WHERE business_id = $1 AND branch_id IS NOT DISTINCT FROM $2::bigint`, [l.businessId, l.branchId]);
    const corte = rows[0].corte;
    out.set(k, corte);
    if (APLICAR) {
      await pool.query(`INSERT INTO gestion_migracion_cortes (fuente, tabla, lugar, corte) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [f.nombre, tabla, k, corte]);
    }
  }
  return out;
}
const esHistoria = (corte, fecha) => !corte || (fecha != null && String(fecha).slice(0, 10) < corte);
const mapaLugar = (l) => ({ business_id: l.businessId, branch_id: l.branchId });
const sin = (o, ...fuera) => { const c = { ...o }; for (const k of fuera) delete c[k]; return c; };

// ── Maestros ──
async function esPrimeraCorrida(f) {
  if (!(await existeTabla('gestion_migracion_cortes'))) return true;
  const { rows } = await pool.query('SELECT 1 FROM gestion_migracion_cortes WHERE fuente = $1 LIMIT 1', [f.nombre]);
  return !rows.length;
}

async function migrarMaestros(f, src, ctx) {
  const org = f.organizationId;
  const primera = await esPrimeraCorrida(f);
  console.log(primera ? '  primera corrida de esta fuente' : '  ya se había corrido: se respeta lo cambiado acá en rubros visibles y conceptos');
  const rubros = (await src.query('SELECT * FROM rubros_concepto_caja')).rows;
  let n = await insertar('gestion_rubros_concepto_caja', ['organization_id', 'codigo', 'nombre', 'calcRent'],
    rubros.map((r) => ({ organization_id: org, codigo: r.codigo, nombre: r.nombre, calcRent: r.calcRent })),
    'ON CONFLICT (organization_id, codigo) DO UPDATE SET "calcRent" = COALESCE(gestion_rubros_concepto_caja."calcRent", EXCLUDED."calcRent")');
  anotar(f.nombre, 'rubros_concepto_caja', { leidas: rubros.length, entran: n });

  const vis = f.negocios.flatMap((b) => rubros.map((r) => ({ business_id: b, codigo: r.codigo, visibleEnDashboard: r.visibleEnDashboard, visibleEnResultados: r.visibleEnResultados })));
  n = await insertar('gestion_rubros_visibilidad', ['business_id', 'codigo', 'visibleEnDashboard', 'visibleEnResultados'], vis,
    primera
      ? 'ON CONFLICT (business_id, codigo) DO UPDATE SET "visibleEnDashboard" = EXCLUDED."visibleEnDashboard", "visibleEnResultados" = EXCLUDED."visibleEnResultados"'
      : 'ON CONFLICT (business_id, codigo) DO NOTHING');
  anotar(f.nombre, 'rubros_visibilidad', { entran: n });

  const sr = (await src.query('SELECT * FROM sin_rubro_config LIMIT 1')).rows[0];
  if (sr) {
    n = await insertar('gestion_sin_rubro_config', ['business_id', 'visibleEnDashboard', 'visibleEnResultados'],
      f.negocios.map((b) => ({ business_id: b, visibleEnDashboard: sr.visibleEnDashboard, visibleEnResultados: sr.visibleEnResultados })),
      primera
        ? 'ON CONFLICT (business_id) DO UPDATE SET "visibleEnDashboard" = EXCLUDED."visibleEnDashboard", "visibleEnResultados" = EXCLUDED."visibleEnResultados"'
        : 'ON CONFLICT (business_id) DO NOTHING');
    anotar(f.nombre, 'sin_rubro_config', { entran: n });
  }

  const cc = await columnas(pool, 'gestion_conceptos_caja');
  const cs = await columnas(src, 'conceptos_caja');
  const colsC = ['organization_id', ...cs.filter((c) => cc.includes(c) && c !== 'id')];
  const conceptos = (await src.query('SELECT * FROM conceptos_caja')).rows;
  // Lo editado en gestion pisa al kit; el resto, si ya está, se respeta.
  const sets = colsC.filter((c) => !['organization_id', 'codigo'].includes(c)).map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ');
  const editados = conceptos.filter((c) => c.editadoEnLazarillo === 't');
  const resto = conceptos.filter((c) => c.editadoEnLazarillo !== 't');
  n = await insertar('gestion_conceptos_caja', colsC, resto.map((c) => ({ ...c, organization_id: org })), 'ON CONFLICT (organization_id, codigo) DO NOTHING');
  const m = await insertar('gestion_conceptos_caja', colsC, editados.map((c) => ({ ...c, organization_id: org })), primera ? `ON CONFLICT (organization_id, codigo) DO UPDATE SET ${sets}` : 'ON CONFLICT (organization_id, codigo) DO NOTHING');
  anotar(f.nombre, 'conceptos_caja', { leidas: conceptos.length, nuevos: n, editados: m });

  const cp = await columnas(pool, 'gestion_proveedores');
  const ps = await columnas(src, 'proveedores');
  const colsP = ['organization_id', ...ps.filter((c) => cp.includes(c) && c !== 'id')];
  const provs = (await src.query('SELECT * FROM proveedores')).rows;
  n = await insertar('gestion_proveedores', colsP, provs.map((p) => ({ ...p, organization_id: org })),
    `ON CONFLICT (organization_id, codigo) DO UPDATE SET "pagoAutomatico" = gestion_proveedores."pagoAutomatico" OR EXCLUDED."pagoAutomatico",
       cuit = COALESCE(gestion_proveedores.cuit, EXCLUDED.cuit), razon = COALESCE(gestion_proveedores.razon, EXCLUDED.razon)`);
  anotar(f.nombre, 'proveedores', { leidas: provs.length, entran: n });
  // Los ids cambian: se cruzan por código.
  const destinoP = (await pool.query('SELECT id, codigo FROM gestion_proveedores WHERE organization_id = $1', [org])).rows;
  const idPorCodigo = new Map(destinoP.map((p) => [p.codigo, p.id]));
  ctx.proveedor = new Map(provs.map((p) => [String(p.id), idPorCodigo.get(p.codigo) ?? null]));
  ctx.proveedorSinCruce = APLICAR ? provs.filter((p) => !idPorCodigo.has(p.codigo)).length : 0;

  const medios = (await src.query('SELECT * FROM medios_pago')).rows;
  n = await insertar('gestion_medios_pago', ['business_id', 'nombre', 'tipo', 'pideId', 'activo', 'orden', 'creadoEn'],
    f.negocios.flatMap((b) => medios.map((x) => ({ ...x, business_id: b }))), 'ON CONFLICT (business_id, nombre) DO NOTHING');
  anotar(f.nombre, 'medios_pago', { leidas: medios.length, entran: n });

  const eq = (await src.query('SELECT * FROM equilibrio_variables')).rows;
  const colsE = (await columnas(src, 'equilibrio_variables')).filter((c) => c !== 'id');
  n = await insertar('gestion_equilibrio_variables', ['business_id', ...colsE], f.negocios.flatMap((b) => eq.map((x) => ({ ...x, business_id: b }))),
    'ON CONFLICT (business_id, tipo, codigo) DO NOTHING');
  anotar(f.nombre, 'equilibrio_variables', { leidas: eq.length, entran: n });
}

// ── Concepto fijo: antes que las compras, que guardan el id de la regla ──
async function migrarConceptoFijo(f, src, ctx) {
  const reglas = (await src.query('SELECT * FROM reglas_concepto_empleado ORDER BY id')).rows;
  const mapa = await mapaIds(f.nombre, 'reglas_concepto_empleado');
  let nuevas = 0;
  if (APLICAR) {
    for (const r of reglas) {
      if (mapa.has(String(r.id))) continue;
      const l = f.pdv[r.origenPuntoDeVentaId];
      const { rows } = await pool.query(
        `INSERT INTO gestion_reglas_concepto_empleado (business_id, branch_id, "entidadId", nombre, "conceptoCodigo", modo, "fechaDesde", "fechaHasta", "extremosInclusivos", estado, "creadoPor", "creadoEn")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [l.businessId, l.branchId, r.entidadId, r.nombre, r.conceptoCodigo, r.modo, r.fechaDesde, r.fechaHasta, r.extremosInclusivos, r.estado, r.creadoPor, r.creadoEn]);
      await guardarId(f.nombre, 'reglas_concepto_empleado', r.id, rows[0].id);
      mapa.set(String(r.id), rows[0].id);
      nuevas += 1;
    }
  }
  ctx.reglaFija = mapa;
  anotar(f.nombre, 'reglas_concepto_empleado', { leidas: reglas.length, nuevas: APLICAR ? nuevas : reglas.length });
}

// ── Compras ──
const CAMPOS_MANUALES = ['importeManual', 'fechaManual', 'observacManual', 'conceptoCodigoManual', 'conceptoPorRegla', 'esBloqueado'];
async function migrarCompras(f, src, ctx) {
  const cd = await columnas(pool, 'gestion_compras');
  const cs = await columnas(src, 'compras');
  const cols = ['business_id', 'branch_id', ...cs.filter((c) => cd.includes(c))];
  const corte = await cortes(f, 'compras', 'gestion_compras');
  console.log(`  cortes de compras:`, Object.fromEntries(corte));
  const setManual = CAMPOS_MANUALES.map((c) => `${q(c)} = EXCLUDED.${q(c)}`).join(', ');
  const cuenta = { leidas: 0, historia: 0, propias: 0, correcciones: 0, correccionesSinFila: 0, salteadas: 0, sinLugar: 0 };
  const huerfanasCorreccion = [];
  for await (const filas of tandas(src, 'compras', 'rowId')) {
    cuenta.leidas += filas.length;
    const entran = [];
    const porNegocio = new Map();
    for (const r of filas) {
      const l = f.pdv[r.puntoDeVentaId];
      if (!l) { cuenta.sinLugar += 1; continue; }
      const fila = {
        ...sin(r, 'localId', 'puntoDeVentaId'), ...mapaLugar(l),
        proveedorId: r.proveedorId != null ? (ctx.proveedor.get(String(r.proveedorId)) ?? null) : null,
        conceptoPorRegla: r.conceptoPorRegla != null ? (ctx.reglaFija.get(String(r.conceptoPorRegla)) ?? null) : null,
        // Lo reparte quien corresponda más abajo: una fila solo queda "repartida" si tiene distribuciones.
        esDistribuido: false, distribuidoEn: null,
      };
      const propia = ['lazarillo', 'arca'].includes(r.origen);
      if (propia) { entran.push(fila); cuenta.propias += 1; continue; }
      if (esHistoria(corte.get(String(idLugar(l))), r.fecha)) { entran.push(fila); cuenta.historia += 1; continue; }
      const manual = r.importeManual != null || r.fechaManual != null || r.observacManual != null || r.conceptoCodigoManual != null || r.esBloqueado === 't';
      if (!manual) { cuenta.salteadas += 1; continue; }
      if (!porNegocio.has(l.businessId)) porNegocio.set(l.businessId, []);
      porNegocio.get(l.businessId).push(fila);
    }
    await insertar('gestion_compras', cols, entran, `ON CONFLICT (business_id, "rowId") DO UPDATE SET ${setManual}`);
    // Correcciones a mano sobre lo que ya trajo el kit.
    for (const [biz, corr] of porNegocio) {
      const hay = await yaExisten('gestion_compras', biz, corr.map((x) => x.rowId));
      const conFila = corr.filter((x) => hay.has(x.rowId));
      for (const x of corr) if (!hay.has(x.rowId)) huerfanasCorreccion.push(`${biz}:${x.rowId}`);
      cuenta.correcciones += conFila.length;
      cuenta.correccionesSinFila += corr.length - conFila.length;
      await insertar('gestion_compras', cols, conFila, `ON CONFLICT (business_id, "rowId") DO UPDATE SET ${setManual}`);
    }
  }
  anotar(f.nombre, 'compras', cuenta);
  if (huerfanasCorreccion.length) console.log(`    correcciones sin fila en destino (primeras): ${huerfanasCorreccion.slice(0, 8).join(' ')}`);
}

// ── Detalle, pagos y ventas ──
async function migrarDetalle(f, src, ctx) {
  const cd = await columnas(pool, 'gestion_detalle_compras');
  const cs = await columnas(src, 'detalle_compras');
  const cols = ['business_id', 'branch_id', ...cs.filter((c) => cd.includes(c))];
  const corte = await cortes(f, 'detalle', 'gestion_detalle_compras');
  const cuenta = { leidas: 0, entran: 0, salteadas: 0, sinCompra: 0, sinLugar: 0 };
  for await (const crudas of tandas(src, 'detalle_compras', 'rowId')) {
    cuenta.leidas += crudas.length;
    const pdvDe = await pdvDeCompras(src, [...new Set(crudas.map((r) => r.compraId).filter(Boolean))]);
    const filas = crudas.map((r) => ({ ...r, _pdv: r.compraId ? pdvDe.get(r.compraId) ?? null : null }));
    const porNegocio = new Map();
    for (const r of filas) {
      const l = f.pdv[r._pdv ?? f.pdvDetalleSinCompra];
      if (!l) { cuenta.sinLugar += 1; continue; }
      if (!r._pdv) cuenta.sinCompra += 1;
      if (!esHistoria(corte.get(String(idLugar(l))), r.fecha)) { cuenta.salteadas += 1; continue; }
      const fila = { ...sin(r, '_pdv', 'localId'), ...mapaLugar(l), proveedorId: r.proveedorId != null ? (ctx.proveedor.get(String(r.proveedorId)) ?? null) : null };
      if (!porNegocio.has(l.businessId)) porNegocio.set(l.businessId, []);
      porNegocio.get(l.businessId).push(fila);
    }
    for (const [biz, lista] of porNegocio) {
      const ids = [...new Set(lista.map((x) => x.compraId).filter(Boolean))];
      const hay = await yaExisten('gestion_compras', biz, ids);
      // Si la compra no está (quedó después del corte con otro rowId), el renglón queda sin vincular.
      const listas = lista.map((x) => (x.compraId && !hay.has(x.compraId) && APLICAR ? { ...x, compraId: null } : x));
      cuenta.entran += await insertar('gestion_detalle_compras', cols, listas, 'ON CONFLICT (business_id, "rowId") DO NOTHING');
    }
  }
  anotar(f.nombre, 'detalle_compras', cuenta);
}

async function migrarPorFecha(f, src, ctx, tablaOrigen, tablaDestino, siempre) {
  const cd = await columnas(pool, tablaDestino);
  const cs = await columnas(src, tablaOrigen);
  const cols = ['business_id', 'branch_id', ...cs.filter((c) => cd.includes(c))];
  const corte = await cortes(f, tablaOrigen, tablaDestino);
  console.log(`  cortes de ${tablaOrigen}:`, Object.fromEntries(corte));
  const cuenta = { leidas: 0, entran: 0, salteadas: 0, sinLugar: 0 };
  for await (const filas of tandas(src, tablaOrigen, 'rowId')) {
    cuenta.leidas += filas.length;
    const entran = [];
    for (const r of filas) {
      const l = f.pdv[r.puntoDeVentaId];
      if (!l) { cuenta.sinLugar += 1; continue; }
      if (!(siempre?.(r)) && !esHistoria(corte.get(String(idLugar(l))), r.fecha)) { cuenta.salteadas += 1; continue; }
      entran.push({
        ...sin(r, 'localId', 'puntoDeVentaId'), ...mapaLugar(l),
        ...('proveedorId' in r ? { proveedorId: r.proveedorId != null ? (ctx.proveedor.get(String(r.proveedorId)) ?? null) : null } : {}),
      });
    }
    cuenta.entran += await insertar(tablaDestino, cols, entran, 'ON CONFLICT (business_id, "rowId") DO NOTHING');
  }
  anotar(f.nombre, tablaOrigen, cuenta);
}

// ── Tablas chicas por lugar ──
async function migrarChicas(f, src, ctx) {
  const porPdv = async (origen, destino, conflicto, columnaPdv = 'puntoDeVentaId') => {
    const cd = await columnas(pool, destino);
    const cs = await columnas(src, origen);
    const cols = ['business_id', 'branch_id', ...cs.filter((c) => cd.includes(c) && c !== 'id')];
    const filas = (await src.query(`SELECT * FROM ${origen}`)).rows;
    const entran = [];
    let sinLugar = 0;
    for (const r of filas) {
      const l = f.pdv[r[columnaPdv]];
      if (!l) { sinLugar += 1; continue; }
      entran.push({ ...r, ...mapaLugar(l) });
    }
    anotar(f.nombre, origen, { leidas: filas.length, entran: await insertar(destino, cols, entran, conflicto), sinLugar });
  };
  await porPdv('empleados', 'gestion_empleados', 'ON CONFLICT (business_id, branch_id, codigo) DO NOTHING');
  await porPdv('impagas_forzadas', 'gestion_impagas_forzadas', 'ON CONFLICT (business_id, branch_id, comprobante, "codPro") DO NOTHING');
  await porPdv('aumentos_precio', 'gestion_aumentos_precio', 'ON CONFLICT (business_id, branch_id, fecha) DO NOTHING');
  await porPdv('compras_huerfanas', 'gestion_compras_huerfanas', 'ON CONFLICT (business_id, "rowId") DO NOTHING');

  // Descartes de Sin carga; los de ARCA (pdvId 0) son de la empresa y van al primer negocio.
  const descartes = (await src.query('SELECT * FROM sin_carga_descartes')).rows;
  const filasD = descartes.map((d) => ({
    ...(d.pdvId === '0' ? { business_id: f.negocios[0], branch_id: null } : mapaLugar(f.pdv[d.pdvId])),
    clave: d.clave, nombre: d.nombre, creadoEn: d.creadoEn, creadoPor: d.creadoPor,
  }));
  anotar(f.nombre, 'sin_carga_descartes', {
    leidas: descartes.length,
    entran: await insertar('gestion_sin_carga_descartes', ['business_id', 'branch_id', 'clave', 'nombre', 'creadoEn', 'creadoPor'], filasD, 'ON CONFLICT (business_id, branch_id, clave) DO NOTHING'),
  });

  // Arqueos: el de San Justo es de su sucursal; el de Ramos Mejía, de la caja compartida, según la opción.
  const flujo = (await src.query('SELECT * FROM flujo_caja_manual')).rows;
  const colsF = ['business_id', 'branch_id', ...(await columnas(src, 'flujo_caja_manual')).filter((c) => !['id', 'localId', 'puntoDeVentaId'].includes(c))];
  const entranF = [];
  let compartidos = 0;
  for (const r of flujo) {
    const compartida = f.nombre === 'ramos' && r.localId === '1' && r.puntoDeVentaId == null;
    if (compartida && !ARQUEO_RAMOS) { compartidos += 1; continue; }
    const l = compartida ? { businessId: ARQUEO_RAMOS, branchId: null } : (r.puntoDeVentaId ? f.pdv[r.puntoDeVentaId] : f.local[r.localId]);
    entranF.push({ ...r, ...mapaLugar(l) });
  }
  anotar(f.nombre, 'flujo_caja_manual', {
    leidas: flujo.length,
    entran: await insertar('gestion_flujo_caja_manual', colsF, entranF, 'ON CONFLICT (business_id, branch_id, anio, mes) DO NOTHING'),
    cajaCompartidaSinDecidir: compartidos,
  });

  const proy = (await src.query('SELECT * FROM proyecciones_ingresos')).rows;
  const colsY = ['business_id', 'branch_id', ...(await columnas(src, 'proyecciones_ingresos')).filter((c) => c !== 'id')];
  const entranY = [];
  let sinAmbito = 0;
  for (const r of proy) {
    const a = f.ambito[r.ambito];
    if (!a) { sinAmbito += 1; continue; }
    entranY.push({ ...r, business_id: a.businessId, branch_id: a.branchId ?? null, ambito: a.ambito });
  }
  anotar(f.nombre, 'proyecciones_ingresos', {
    leidas: proy.length,
    entran: await insertar('gestion_proyecciones_ingresos', colsY, entranY, 'ON CONFLICT (business_id, ambito, anio, mes, corte, metodo) DO NOTHING'),
    sinAmbitoEquivalente: sinAmbito,
  });

  const arca = (await src.query('SELECT * FROM arca_comprobantes')).rows;
  const colsA = ['organization_id', ...(await columnas(src, 'arca_comprobantes')).filter((c) => c !== 'id')];
  anotar(f.nombre, 'arca_comprobantes', {
    leidas: arca.length,
    entran: await insertar('gestion_arca_comprobantes', colsA, arca.map((a) => ({ ...a, organization_id: f.organizationId })),
      'ON CONFLICT (organization_id, "cuitEmisor", tipo, "puntoVenta", numero) DO NOTHING'),
  });

  // Notas: de cada usuario, por email.
  const notas = (await src.query('SELECT * FROM notas_usuario')).rows;
  let sinUsuario = 0;
  let notasN = 0;
  for (const n of notas) {
    const u = (await pool.query('SELECT id FROM app_users WHERE LOWER(email) = LOWER($1) LIMIT 1', [n.email])).rows[0];
    if (!u) { sinUsuario += 1; continue; }
    notasN += 1;
    if (APLICAR) {
      await pool.query(`INSERT INTO gestion_notas_usuario (user_id, business_id, texto, "actualizadoEn") VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, business_id) DO NOTHING`,
        [u.id, f.negocioNotas, n.texto, n.actualizadoEn]);
    }
  }
  anotar(f.nombre, 'notas_usuario', { leidas: notas.length, entran: notasN, sinUsuario });

  // Lo cargado en gestion: el payload nombra PDV y proveedor con los ids de allá.
  const payloadNuevo = (p) => {
    if (!p) return p;
    const lugar = (id) => { const l = f.pdv[id]; return l ? idLugar(l) : id; };
    return {
      ...p,
      proveedorId: p.proveedorId != null ? (ctx.proveedor.get(String(p.proveedorId)) ?? p.proveedorId) : p.proveedorId,
      registros: (p.registros ?? []).map((r) => ({
        ...r, puntoDeVentaId: lugar(r.puntoDeVentaId),
        ...(r.reparto ? { reparto: r.reparto.map((x) => ({ ...x, puntoDeVentaId: lugar(x.puntoDeVentaId) })) } : {}),
      })),
    };
  };
  const cargadas = (await src.query('SELECT * FROM facturas_lazarillo')).rows;
  let facN = 0;
  for (const a of cargadas) {
    const p = payloadNuevo(JSON.parse(a.payload));
    const primero = f.pdv[(JSON.parse(a.payload).registros ?? [])[0]?.puntoDeVentaId] ?? f.local[a.localId];
    facN += 1;
    if (!APLICAR) continue;
    await pool.query(
      `INSERT INTO gestion_facturas_movil (business_id, branch_id, comprobante, codigo, "proveedorId", fecha, total, payload, "creadoPor", "actualizadoPor", "creadoEn")
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11
       WHERE NOT EXISTS (SELECT 1 FROM gestion_facturas_movil WHERE business_id = $1 AND comprobante = $3 AND codigo = $4)`,
      [primero.businessId, primero.branchId, a.comprobante, a.codigo, ctx.proveedor.get(String(a.proveedorId)) ?? null, a.fecha, a.total, JSON.stringify(p), a.creadoPor, a.actualizadoPor, a.creadoEn]);
  }
  anotar(f.nombre, 'facturas_lazarillo', { leidas: cargadas.length, entran: facN });

  const actividad = (await src.query('SELECT * FROM actividad ORDER BY id')).rows;
  const mapaA = await mapaIds(f.nombre, 'actividad');
  let actN = 0;
  for (const a of actividad) {
    if (mapaA.has(String(a.id))) continue;
    actN += 1;
    if (!APLICAR) continue;
    const l = f.local[a.localId] ?? { businessId: f.negocios[0] };
    const datos = a.datos ? JSON.parse(a.datos) : null;
    if (datos?.payload) datos.payload = payloadNuevo(datos.payload);
    const { rows } = await pool.query(
      `INSERT INTO gestion_actividad (organization_id, business_id, tipo, accion, descripcion, "refId", usuario, datos, "creadoEn") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id`,
      [f.organizationId, l.businessId, a.tipo, a.accion, a.descripcion, a.refId, a.usuario, datos ? JSON.stringify(datos) : null, a.creadoEn]);
    await guardarId(f.nombre, 'actividad', a.id, rows[0].id);
  }
  anotar(f.nombre, 'actividad', { leidas: actividad.length, entran: actN });
}

// ── Reglas de apertura y lo repartido ──
async function migrarAperturas(f, src, ctx) {
  const reglas = (await src.query('SELECT * FROM reglas_apertura ORDER BY id')).rows;
  const destinos = (await src.query('SELECT * FROM destinos_regla ORDER BY id')).rows;
  if (!reglas.length) { anotar(f.nombre, 'reglas_apertura', { leidas: 0 }); return; }
  const mapaR = await mapaIds(f.nombre, 'reglas_apertura');
  // Reglas creadas a mano acá podrían competir por las mismas compras: se avisa.
  const ajenas = (await pool.query(
    `SELECT COUNT(*)::int n FROM gestion_reglas_apertura WHERE organization_id = $1 AND estado = 'activa' AND NOT (id = ANY($2::int[]))`,
    [f.organizationId, [...mapaR.values()]])).rows[0].n;
  if (ajenas) console.log(`  ⚠ ${ajenas} regla(s) activas creadas a mano en destino: pueden superponerse con las migradas.`);

  const enOrigen = new Set(reglas.map((r) => String(r.id)));
  const borradas = [...mapaR.entries()].filter(([o]) => !enOrigen.has(o)).map(([, d]) => d);
  if (borradas.length) console.log(`  ⚠ ${borradas.length} regla(s) ya migradas fueron borradas en gestion y siguen activas acá: ${borradas.slice(0, 20).join(', ')}`);

  const sinLugar = reglas.filter((r) => !f.pdv[r.origenPuntoDeVentaId]).length + destinos.filter((d) => !f.pdv[d.puntoDeVentaId]).length;
  const mapaD = new Map();
  let nuevas = 0;
  if (APLICAR) {
    for (const r of reglas) {
      const l = f.pdv[r.origenPuntoDeVentaId];
      if (!l) continue;
      // Una regla por proveedor apunta al id de allá; las de texto y los otros niveles no cambian.
      const entidad = r.nivel === 'proveedor' && /^\d+$/.test(r.entidadId) ? String(ctx.proveedor.get(r.entidadId) ?? r.entidadId) : r.entidadId;
      const previa = mapaR.get(String(r.id));
      let id = previa;
      if (previa) {
        await pool.query('DELETE FROM gestion_distribuciones_apertura WHERE "reglaId" = $1', [previa]);
        await pool.query('DELETE FROM gestion_destinos_regla WHERE "reglaId" = $1', [previa]);
        await pool.query(`UPDATE gestion_reglas_apertura SET modo=$2, "fechaDesde"=$3, "fechaHasta"=$4, "extremosInclusivos"=$5, estado=$6 WHERE id=$1`,
          [previa, r.modo, r.fechaDesde, r.fechaHasta, r.extremosInclusivos, r.estado]);
      } else {
        const { rows } = await pool.query(
          `INSERT INTO gestion_reglas_apertura (organization_id, business_id, branch_id, nivel, "entidadId", modo, "fechaDesde", "fechaHasta", "extremosInclusivos", estado, "creadoPor", "creadoEn")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [f.organizationId, l.businessId, l.branchId, r.nivel, entidad, r.modo, r.fechaDesde, r.fechaHasta, r.extremosInclusivos, r.estado, r.creadoPor, r.creadoEn]);
        id = rows[0].id;
        await guardarId(f.nombre, 'reglas_apertura', r.id, id);
        mapaR.set(String(r.id), id);
        nuevas += 1;
      }
      for (const d of destinos.filter((x) => x.reglaId === r.id)) {
        const ld = f.pdv[d.puntoDeVentaId];
        if (!ld) continue;
        const { rows } = await pool.query(
          `INSERT INTO gestion_destinos_regla ("reglaId", business_id, branch_id, porcentaje) VALUES ($1,$2,$3,$4) RETURNING id`, [id, ld.businessId, ld.branchId, d.porcentaje]);
        mapaD.set(String(d.id), rows[0].id);
      }
      if (PAUSA_MS) await dormir(5);
    }
  }
  anotar(f.nombre, 'reglas_apertura', { leidas: reglas.length, destinos: destinos.length, nuevas: APLICAR ? nuevas : reglas.length, sinLugar, ajenas });

  // Lo repartido, solo para compras que existen en destino. Cada fila suma exacto: se copia tal cual.
  const cuenta = { leidas: 0, entran: 0, compraSinFila: 0, sinRegla: 0 };
  const tocadas = new Map();
  for (let ultimo = 0; ;) {
    const { rows: crudas } = await src.query(`SELECT * FROM distribuciones_apertura WHERE id > $1 ORDER BY id LIMIT ${CHUNK * 2}`, [ultimo]);
    if (!crudas.length) break;
    ultimo = Number(crudas[crudas.length - 1].id);
    cuenta.leidas += crudas.length;
    const pdvDe = await pdvDeCompras(src, [...new Set(crudas.map((d) => d.compraRowId))]);
    const filas = crudas.map((d) => ({ ...d, _pdv: pdvDe.get(d.compraRowId) }));
    const porNegocio = new Map();
    for (const d of filas) {
      const l = f.pdv[d._pdv];
      if (!l) { cuenta.sinRegla += 1; continue; }
      if (!porNegocio.has(l.businessId)) porNegocio.set(l.businessId, []);
      porNegocio.get(l.businessId).push(d);
    }
    for (const [biz, lista] of porNegocio) {
      const hay = await yaExisten('gestion_compras', biz, [...new Set(lista.map((d) => d.compraRowId))]);
      const entran = [];
      for (const d of lista) {
        if (!hay.has(d.compraRowId)) { cuenta.compraSinFila += 1; continue; }
        const reglaId = mapaR.get(String(d.reglaId));
        const destinoId = mapaD.get(String(d.destinoId));
        if (APLICAR && (!reglaId || !destinoId)) { cuenta.sinRegla += 1; continue; }
        entran.push({ compra_business_id: biz, compraRowId: d.compraRowId, reglaId, destinoId, importeOriginal: d.importeOriginal, porcentaje: d.porcentaje, importeCalculado: d.importeCalculado, procesadoEn: d.procesadoEn });
        if (!tocadas.has(biz)) tocadas.set(biz, new Set());
        tocadas.get(biz).add(d.compraRowId);
      }
      cuenta.entran += await insertar('gestion_distribuciones_apertura',
        ['compra_business_id', 'compraRowId', 'reglaId', 'destinoId', 'importeOriginal', 'porcentaje', 'importeCalculado', 'procesadoEn'], entran);
    }
  }
  anotar(f.nombre, 'distribuciones_apertura', cuenta);
  if (APLICAR) {
    for (const [biz, ids] of tocadas) {
      const lista = [...ids];
      for (let i = 0; i < lista.length; i += CHUNK) {
        await pool.query(`UPDATE gestion_compras SET "esDistribuido" = true, "distribuidoEn" = COALESCE("distribuidoEn", CURRENT_TIMESTAMP) WHERE business_id = $1 AND "rowId" = ANY($2::text[])`,
          [biz, lista.slice(i, i + CHUNK)]);
      }
    }
  }
}

// ── Pagos cargados en gestion ──
async function migrarPagos(f, src, ctx) {
  const pp = (await src.query('SELECT * FROM pagos_proveedor ORDER BY id')).rows;
  const ap = (await src.query('SELECT * FROM aplicaciones_pago_proveedor ORDER BY id')).rows;
  const ev = (await src.query('SELECT * FROM eventos_pago_proveedor ORDER BY id')).rows;
  const mapaP = await mapaIds(f.nombre, 'pagos_proveedor');
  if (APLICAR) {
    for (const p of pp) {
      const l = f.pdv[p.pdvPagaId];
      if (!l) continue;
      let id = mapaP.get(String(p.id));
      if (id) {
        await pool.query('DELETE FROM gestion_aplicaciones_pago_proveedor WHERE "pagoId" = $1', [id]);
        await pool.query('DELETE FROM gestion_eventos_pago_proveedor WHERE "pagoId" = $1', [id]);
        await pool.query(`UPDATE gestion_pagos_proveedor SET fecha=$2, importe=$3, medio=$4, referencia=$5, "anuladoEn"=$6, "anuladoPor"=$7 WHERE id=$1`,
          [id, p.fecha, p.importe, p.medio, p.referencia, p.anuladoEn, p.anuladoPor]);
      } else {
        const { rows } = await pool.query(
          `INSERT INTO gestion_pagos_proveedor (organization_id, business_id, branch_id, "codPro", fecha, importe, medio, referencia, "creadoEn", "creadoPor", "anuladoEn", "anuladoPor")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [f.organizationId, l.businessId, l.branchId, p.codPro, p.fecha, p.importe, p.medio, p.referencia, p.creadoEn, p.creadoPor, p.anuladoEn, p.anuladoPor]);
        id = rows[0].id;
        await guardarId(f.nombre, 'pagos_proveedor', p.id, id);
        mapaP.set(String(p.id), id);
      }
      for (const a of ap.filter((x) => x.pagoId === p.id)) {
        const la = f.pdv[a.pdvId];
        if (!la) continue;
        await pool.query(`INSERT INTO gestion_aplicaciones_pago_proveedor ("pagoId", business_id, branch_id, comprobante, "codPro", importe) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, la.businessId, la.branchId, a.comprobante, a.codPro, a.importe]);
      }
      for (const e of ev.filter((x) => x.pagoId === p.id)) {
        await pool.query(`INSERT INTO gestion_eventos_pago_proveedor ("pagoId", tipo, detalle, importe, usuario, "creadoEn") VALUES ($1,$2,$3,$4,$5,$6)`, [id, e.tipo, e.detalle, e.importe, e.usuario, e.creadoEn]);
      }
    }
  }
  anotar(f.nombre, 'pagos_proveedor', { leidas: pp.length, aplicaciones: ap.length, eventos: ev.length });

  const pi = (await src.query('SELECT * FROM pagos_internos ORDER BY id')).rows;
  const ai = (await src.query('SELECT * FROM aplicaciones_pago_interno ORDER BY id')).rows;
  const ei = (await src.query('SELECT * FROM eventos_pago_interno ORDER BY id')).rows;
  const mapaI = await mapaIds(f.nombre, 'pagos_internos');
  if (APLICAR) {
    for (const p of pi) {
      const o = f.pdv[p.pdvOrigenId];
      const d = f.pdv[p.pdvDestinoId];
      if (!o || !d) continue;
      let id = mapaI.get(String(p.id));
      if (id) {
        await pool.query('DELETE FROM gestion_aplicaciones_pago_interno WHERE "pagoId" = $1', [id]);
        await pool.query('DELETE FROM gestion_eventos_pago_interno WHERE "pagoId" = $1', [id]);
        await pool.query(`UPDATE gestion_pagos_internos SET fecha=$2, importe=$3, medio=$4, referencia=$5, "anuladoEn"=$6 WHERE id=$1`, [id, p.fecha, p.importe, p.medio, p.referencia, p.anuladoEn]);
      } else {
        const { rows } = await pool.query(
          `INSERT INTO gestion_pagos_internos (organization_id, origen_business_id, origen_branch_id, destino_business_id, destino_branch_id, fecha, importe, medio, referencia, "creadoEn", "anuladoEn", "creadoPor")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [f.organizationId, o.businessId, o.branchId, d.businessId, d.branchId, p.fecha, p.importe, p.medio, p.referencia, p.creadoEn, p.anuladoEn, p.creadoPor]);
        id = rows[0].id;
        await guardarId(f.nombre, 'pagos_internos', p.id, id);
        mapaI.set(String(p.id), id);
      }
      for (const a of ai.filter((x) => x.pagoId === p.id)) {
        await pool.query(`INSERT INTO gestion_aplicaciones_pago_interno ("pagoId", compra_business_id, "compraRowId", importe) VALUES ($1,$2,$3,$4)`, [id, o.businessId, a.compraRowId, a.importe]);
      }
      for (const e of ei.filter((x) => x.pagoId === p.id)) {
        await pool.query(`INSERT INTO gestion_eventos_pago_interno ("pagoId", tipo, detalle, importe, usuario, "creadoEn") VALUES ($1,$2,$3,$4,$5,$6)`, [id, e.tipo, e.detalle, e.importe, e.usuario, e.creadoEn]);
      }
    }
  }
  anotar(f.nombre, 'pagos_internos', { leidas: pi.length, aplicaciones: ai.length, eventos: ei.length });
}

// Lo que entró por el kit después del corte y le toca una regla o un concepto fijo.
async function reaplicar(f) {
  if (!APLICAR) return;
  const { sincronizarTrasImport } = require('../../services/gestion/apertura/motor');
  const { aplicarConceptosEmpleado } = require('../../services/gestion/empleados/api');
  for (const businessId of f.negocios) {
    const ctx = { organizationId: f.organizationId, businessId };
    const cf = await aplicarConceptosEmpleado(ctx);
    const ap = await sincronizarTrasImport(ctx, []);
    console.log(`  negocio ${businessId}: concepto fijo cambió ${cf.cambiados}, reglas reaplicadas ${ap.reglasReaplicadas}`);
    for (const e of [...cf.errores, ...ap.errores].slice(0, 5)) console.log('   ⚠', e);
  }
}

// Totales por lugar y año: origen contra destino. Lo posterior al corte es lo del kit, así que acá
// una diferencia no siempre es un error: hay que mirarla. "repartido" es lo que muestra el Panel.
async function comparar(f, src) {
  const negocios = `'{${f.negocios.join(',')}}'::bigint[]`;
  const grupo = `business_id::text || '/' || COALESCE(branch_id::text, '')`;
  const consulta = (cliente, t, g, filtro) => cliente.query(`
    SELECT ${g} AS lugar, COALESCE(EXTRACT(YEAR FROM fecha)::int::text, 'sin fecha') AS anio, COUNT(*)::int AS n, ROUND(SUM(COALESCE("importeManual", importe))::numeric, 0)::text AS total
    FROM ${t} ${filtro} GROUP BY 1, 2`).then((r) => r.rows);
  for (const [o, d] of [['compras', 'gestion_compras'], ['v_compras_distribuidas', 'gestion_v_compras_distribuidas'], ['ventas', 'gestion_ventas']]) {
    const a = await consulta(src, o, '"puntoDeVentaId"::text', '');
    const b = await consulta(pool, d, grupo, `WHERE business_id = ANY(${negocios})`);
    const clave = (l) => `${l.businessId}/${l.branchId ?? ''}`;
    const distintos = [];
    for (const x of a) {
      const l = f.pdv[x.lugar];
      if (!l) continue;
      const y = b.find((z) => z.lugar === clave(l) && String(z.anio) === String(x.anio));
      if (!y || Math.abs(Number(y.total) - Number(x.total)) > 1) distintos.push(`${clave(l)} ${x.anio}: gestion ${x.total} (${x.n}) / acá ${y?.total ?? '—'} (${y?.n ?? 0})`);
    }
    console.log(`  ${o}: ${a.length} lugar-año, ${distintos.length} con diferencia`);
    for (const t of distintos.slice(0, 30)) console.log('    ', t);
  }
}

(async () => {
  const host = new URL(process.env.DATABASE_URL).hostname;
  console.log(APLICAR ? 'APLICANDO' : 'PRUEBA (en destino solo lee)', '· destino:', host);
  if (APLICAR && argValor('confirmo-host') !== host) {
    console.error(`Para escribir hay que confirmar el destino: --confirmo-host=${host}`);
    process.exit(1);
  }
  await prepararDestino();
  for (const f of FUENTES) {
    if (SOLO && SOLO !== f.nombre) continue;
    if (!f.url) { console.log(`Sin URL para ${f.nombre}: se saltea`); continue; }
    console.log(`\n═══ ${f.nombre} → organización ${f.organizationId}`);
    const negocios = (await pool.query('SELECT id FROM app_businesses WHERE organization_id = $1 AND id = ANY($2::bigint[])', [f.organizationId, f.negocios])).rows;
    if (negocios.length !== f.negocios.length) throw new Error(`Los negocios ${f.negocios} no están todos en la organización ${f.organizationId}`);
    const src = await conectarFuente(f.url);
    const ctx = {};
    try {
      await migrarMaestros(f, src, ctx);
      await migrarConceptoFijo(f, src, ctx);
      await migrarCompras(f, src, ctx);
      await migrarDetalle(f, src, ctx);
      await migrarPorFecha(f, src, ctx, 'pagos', 'gestion_pagos');
      await migrarPorFecha(f, src, ctx, 'ventas', 'gestion_ventas', (r) => /^man/i.test(r.rowId));
      await migrarChicas(f, src, ctx);
      await migrarAperturas(f, src, ctx);
      await migrarPagos(f, src, ctx);
      await reaplicar(f);
      console.log(`\n── ${f.nombre}: gestion contra acá`);
      await comparar(f, src);
    } finally {
      await src.end();
    }
  }
  console.log(APLICAR ? '\nListo.' : '\nPrueba terminada: no se escribió nada.');
  await pool.end();
})().catch((e) => {
  console.error('FALLA:', String(e.message).replace(/postgres(ql)?:\/\/\S+/g, '[url]'));
  console.error(String(e.stack ?? '').split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
