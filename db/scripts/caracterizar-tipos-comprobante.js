// db/scripts/caracterizar-tipos-comprobante.js
//
// Diagnóstico de SOLO LECTURA. factura_key arranca con el cod_cpb de MaxiRest
// (ej. "C-3-8", "Z-938-20082026", "Tic 0938-20082026"). El caso "Diseño
// Grafico" matcheado como compra de "Barril Golden" vino de un comprobante
// tipo 'C' — hay que ver si ESE tipo es sistemáticamente gasto administrativo
// (no mercadería) para poder excluirlo en la ingesta, en vez de perseguir
// casos uno por uno. cpto_caja/referencia en purchase_items ya guardan el
// cod_cga/nom_cga crudo de origen, sin necesidad de volver a tocar las
// tablas i25.
//
// Uso: node db/scripts/caracterizar-tipos-comprobante.js <business_id>
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

function tipoDeFacturaKey(key) {
  // primer token antes del primer '-', tal como lo arma facturaKeyDe()
  const idx = String(key ?? '').indexOf('-');
  return idx >= 0 ? String(key).slice(0, idx) : String(key ?? '');
}

async function main() {
  const businessId = Number(process.argv[2]);
  if (!Number.isFinite(businessId)) {
    console.log('Uso: node db/scripts/caracterizar-tipos-comprobante.js <business_id>');
    process.exit(1);
  }

  const { rows } = await pool.query(
    `SELECT p.factura_key, pi.cpto_caja, pi.referencia, pi.precio_total, pi.cantidad, i.nombre AS insumo_nombre
       FROM purchase_items pi
       JOIN purchases p ON p.id = pi.purchase_id
       LEFT JOIN insumos i ON i.id = pi.insumo_id
      WHERE pi.business_id = $1`,
    [businessId]
  );

  const porTipo = new Map();
  for (const r of rows) {
    const tipo = tipoDeFacturaKey(r.factura_key);
    if (!porTipo.has(tipo)) porTipo.set(tipo, { tipo, lineas: 0, referencias: new Map() });
    const g = porTipo.get(tipo);
    g.lineas++;
    const ref = String(r.referencia ?? '(sin referencia)');
    if (!g.referencias.has(ref)) g.referencias.set(ref, 0);
    g.referencias.set(ref, g.referencias.get(ref) + 1);
  }

  console.log(`=== Tipos de comprobante (prefijo de factura_key) — negocio ${businessId} ===\n`);
  for (const g of [...porTipo.values()].sort((a, b) => b.lineas - a.lineas)) {
    console.log(`Tipo "${g.tipo}": ${g.lineas} línea(s)`);
    const refsOrdenadas = [...g.referencias.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [ref, count] of refsOrdenadas) {
      console.log(`    ${count.toString().padStart(6)}  ${ref}`);
    }
    console.log('');
  }

  // Casos puntuales: líneas tipo 'C' que SÍ matchearon a un insumo real,
  // para ver si todas son gasto (como "Diseño Grafico") o hay mezcla.
  const casosC = rows.filter((r) => tipoDeFacturaKey(r.factura_key) === 'C' && r.insumo_nombre);
  if (casosC.length) {
    console.log(`=== Líneas tipo "C" que matchearon a un insumo (${casosC.length}) ===`);
    console.table(casosC.slice(0, 30).map((r) => ({
      factura_key: r.factura_key, referencia: r.referencia, insumo: r.insumo_nombre,
      cantidad: r.cantidad, precio_total: r.precio_total,
    })));
  }

  await pool.end();
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
