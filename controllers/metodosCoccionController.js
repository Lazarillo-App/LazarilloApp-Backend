// controllers/metodosCoccionController.js
//
// Catálogo simple por negocio de "métodos de cocción/servicio" (lista fija
// editable): arranca con valores típicos y el usuario puede agregar más
// desde el mismo selector, en vez de texto libre sin consistencia.
'use strict';

const pool = require('../config/db');

const DEFAULTS = ['Horno', 'Plancha', 'Freír', 'Vapor', 'Salteado', 'Sin cocción'];

exports.list = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });

    let { rows } = await pool.query(
      `SELECT id, nombre FROM metodos_coccion WHERE business_id = $1 ORDER BY nombre ASC`,
      [bizId]
    );

    if (!rows.length) {
      await pool.query(
        `INSERT INTO metodos_coccion (business_id, nombre)
         SELECT $1, unnest($2::text[])
         ON CONFLICT (business_id, nombre) DO NOTHING`,
        [bizId, DEFAULTS]
      );
      const seeded = await pool.query(
        `SELECT id, nombre FROM metodos_coccion WHERE business_id = $1 ORDER BY nombre ASC`,
        [bizId]
      );
      rows = seeded.rows;
    }

    return res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[metodosCoccion.list]', e);
    next(e);
  }
};

exports.create = async (req, res, next) => {
  try {
    const bizId = Number(req.params.businessId);
    if (!bizId) return res.status(400).json({ ok: false, error: 'invalid_business_id' });
    const nombre = String(req.body?.nombre || '').trim();
    if (!nombre) return res.status(400).json({ ok: false, error: 'nombre_requerido' });

    const { rows } = await pool.query(
      `INSERT INTO metodos_coccion (business_id, nombre)
       VALUES ($1, $2)
       ON CONFLICT (business_id, nombre) DO UPDATE SET nombre = EXCLUDED.nombre
       RETURNING id, nombre`,
      [bizId, nombre]
    );
    return res.status(201).json({ ok: true, data: rows[0] });
  } catch (e) {
    console.error('[metodosCoccion.create]', e);
    next(e);
  }
};
