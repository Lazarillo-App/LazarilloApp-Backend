// db/scripts/inspect-maxirest-schema.js
//
// Diagnóstico de SOLO LECTURA — no modifica nada. Lista las tablas del
// schema `maxirest_14536_ramos` (la copia cruda de MaxiRest que carga el
// script Python del colega) con su cantidad de filas y columnas, para
// identificar cuáles son las de comprobantes/compras/ventas/artículos y
// diseñar el pipeline de ingesta automática normalizada.
//
// Uso: node db/scripts/inspect-maxirest-schema.js [filtro]
//   filtro opcional: substring para limitar qué tablas listar en detalle
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const SCHEMA = 'maxirest_14536_ramos';
const filtro = process.argv[2] || null;

// Los nombres de tabla de MaxiRest son códigos cortos (mxcpb, mxren, etc.),
// no dicen nada por sí solos. En vez de adivinar la abreviatura, se buscan
// las tablas por las COLUMNAS que tendría un comprobante/renglón de compra:
// importe, cantidad, proveedor, número de comprobante, fecha, código.
const PISTAS_COLUMNAS = [
  'importe', 'cant', 'preciounit', 'precio', 'proveedor', 'prov',
  'comprobante', 'cpb', 'factura', 'numero', 'nrocomp', 'fecha',
  'codigo', 'cod_art', 'idart', 'rubro', 'medida', 'iva',
  // ronda 2: maestro de proveedores (cuit/razón social/domicilio) y
  // catálogo de artículos para la venta (precio de venta)
  'cuit', 'razon', 'domicilio', 'telefono', 'localidad', 'vta', 'pvta',
];

async function main() {
  const { rows: tablas } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 ORDER BY table_name`,
    [SCHEMA]
  );
  console.log(`Schema ${SCHEMA}: ${tablas.length} tablas\n`);

  if (filtro === '--pistas') {
    // Modo búsqueda: qué tablas tienen columnas que suenan a comprobante/compra
    const { rows: cols } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = $1`,
      [SCHEMA]
    );
    const porTabla = new Map();
    for (const c of cols) {
      const colLow = c.column_name.toLowerCase();
      if (PISTAS_COLUMNAS.some((p) => colLow.includes(p))) {
        if (!porTabla.has(c.table_name)) porTabla.set(c.table_name, []);
        porTabla.get(c.table_name).push(c.column_name);
      }
    }
    const ordenado = [...porTabla.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log(`\n${ordenado.length} tablas con columnas sospechosas de compra/comprobante:\n`);
    for (const [tabla, columnas] of ordenado) {
      console.log(`${tabla} (${columnas.length}): ${columnas.join(', ')}`);
    }
    await pool.end();
    return;
  }

  console.log(tablas.map(t => t.table_name).join(', '));

  // --tablas=mxcpb,mxren,...  → columnas completas + 3 filas de muestra de
  // cada una. Para confirmar qué significa cada tabla candidata una vez
  // acotada la lista por --pistas.
  if (filtro && filtro.startsWith('--tablas=')) {
    const nombres = filtro.replace('--tablas=', '').split(',').map((s) => s.trim());
    for (const table_name of nombres) {
      const cols = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [SCHEMA, table_name]
      );
      console.log(`\n══ ${table_name} — columnas (${cols.rows.length}) ══`);
      console.table(cols.rows);
      try {
        const sample = await pool.query(`SELECT * FROM "${SCHEMA}"."${table_name}" LIMIT 3`);
        console.log(`── ${table_name} — muestra de filas ──`);
        console.table(sample.rows);
      } catch (e) {
        console.log(`(no se pudo leer muestra: ${e.message})`);
      }
    }
    await pool.end();
    return;
  }

  const objetivo = filtro
    ? tablas.filter(t => t.table_name.toLowerCase().includes(filtro.toLowerCase()))
    : tablas;

  for (const { table_name } of objetivo) {
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [SCHEMA, table_name]
    );
    let count = null;
    try {
      const c = await pool.query(`SELECT COUNT(*)::int AS n FROM "${SCHEMA}"."${table_name}"`);
      count = c.rows[0].n;
    } catch (e) { count = `error: ${e.message}`; }
    console.log(`\n── ${table_name} (${count} filas) ──`);
    console.table(cols.rows);
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
