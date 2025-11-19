// repos/maxiSuppliesRepo.js
/* eslint-disable no-console */
'use strict';

const pool = require('../config/db');

async function upsertMany(businessId, items = []) {
  if (!businessId) throw new Error('businessId requerido en upsertMany(maxi_supplies)');
  if (!Array.isArray(items) || !items.length) return 0;

  const values = [];
  const params = [];
  let i = 1;

  for (const it of items) {
    values.push(
      `($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`
    );

    params.push(
      Number(businessId),
      it.codigo ?? null,
      it.nombre ?? '',
      it.rubro ?? null,
      it.medida ?? null,
      it.precio ?? null,
      it.iva ?? '',
      it.imp_int ?? null,
      it.discontinuado ? true : false,
      JSON.stringify(it.raw || it)
    );
  }

  const sql = `
    INSERT INTO maxi_supplies
      (business_id, codigo, nombre, rubro, medida, precio, iva, imp_int, discontinuado, raw)
    VALUES
      ${values.join(',\n')}
    ON CONFLICT (business_id, codigo) DO UPDATE SET
      nombre        = EXCLUDED.nombre,
      rubro         = EXCLUDED.rubro,
      medida        = EXCLUDED.medida,
      precio        = EXCLUDED.precio,
      iva           = EXCLUDED.iva,
      imp_int       = EXCLUDED.imp_int,
      discontinuado = EXCLUDED.discontinuado,
      raw           = EXCLUDED.raw,
      updated_at    = NOW()
  `;

  await pool.query(sql, params);
  return items.length;
}

async function listForBusiness(businessId) {
  if (!businessId) throw new Error('businessId requerido en listForBusiness(maxi_supplies)');

  const { rows } = await pool.query(
    `
    SELECT
      codigo              AS codigo,
      nombre              AS nombre,
      rubro               AS rubro,
      medida              AS medida,
      precio              AS precio,
      iva                 AS iva,
      imp_int             AS imp_int,
      discontinuado       AS discontinuado,
      updated_at
    FROM maxi_supplies
    WHERE business_id = $1
    ORDER BY rubro NULLS LAST, nombre NULLS LAST, codigo
    `,
    [businessId]
  );

  return rows;
}

module.exports = {
  upsertMany,
  listForBusiness,
};
