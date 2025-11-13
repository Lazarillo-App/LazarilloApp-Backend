// src/db/ventas.queries.js
const pool = require('../config/db'); // tu pool pg

async function ventasSummaryDB({ businessId, from, to }) {
  const q = `
    SELECT
      fecha::date AS dia,
      SUM(total_neto)  AS neto,
      SUM(total_bruto) AS bruto,
      COUNT(*)         AS tickets
    FROM maxi_sales_daily
    WHERE business_id = $1
      AND fecha::date BETWEEN $2::date AND $3::date
    GROUP BY 1
    ORDER BY 1;
  `;
  const { rows } = await pool.query(q, [businessId, from, to]);
  return {
    ok: true,
    business_id: businessId,
    rango: { from, to },
    count: rows.length,
    items: rows,
  };
}

async function rangoDisponiblePorNegocio(businessId) {
  const { rows } = await pool.query(
    `SELECT MIN(fecha::date) AS min, MAX(fecha::date) AS max
     FROM maxi_sales_daily WHERE business_id = $1`, [businessId]
  );
  return rows?.[0] ?? { min: null, max: null };
}

module.exports = { ventasSummaryDB, rangoDisponiblePorNegocio };
