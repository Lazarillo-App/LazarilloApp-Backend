// db/scripts/add-precio-maxi.js
// Agrega la columna espejo `precio_maxi` a maxi_articles (mismo patrón que
// nombre_maxi/categoria_maxi/subrubro_maxi) y la backfillea con el precio actual,
// para que el sync de Maxi pueda proteger ediciones manuales de precio sin romper
// la actualización de precios de artículos nunca tocados a mano.
//
// Uso: node db/scripts/add-precio-maxi.js [--dry-run]
require('dotenv').config();
const pool = require('../../config/db');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const { rows: colCheck } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'maxi_articles' AND column_name = 'precio_maxi'`
  );
  const yaExiste = colCheck.length > 0;
  console.log(`Columna precio_maxi ${yaExiste ? 'ya existe' : 'no existe todavía'}.`);

  if (dryRun) {
    const { rows: pending } = await pool.query(
      yaExiste
        ? `SELECT COUNT(*) AS n FROM maxi_articles WHERE precio_maxi IS NULL`
        : `SELECT COUNT(*) AS n FROM maxi_articles`
    );
    console.log(`[dry-run] Filas que quedarían con precio_maxi = precio: ${pending[0].n}`);
    await pool.end();
    return;
  }

  if (!yaExiste) {
    await pool.query(`ALTER TABLE maxi_articles ADD COLUMN IF NOT EXISTS precio_maxi NUMERIC`);
    console.log('Columna precio_maxi agregada.');
  }

  const { rowCount } = await pool.query(
    `UPDATE maxi_articles SET precio_maxi = precio WHERE precio_maxi IS NULL`
  );
  console.log(`Backfill completo: ${rowCount} filas actualizadas con precio_maxi = precio.`);

  await pool.end();
}

main().catch((e) => {
  console.error('add-precio-maxi error:', e);
  process.exit(1);
});
