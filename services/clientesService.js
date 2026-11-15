// services/clientesService.js
// Clientes (Diego 14/11/2026: «una base de datos de clientes con lo que traigo de Mercado Pago,
// lista para exportar, en un sector Clientes dentro de Administración, orientada a marketing»).
// Sale de los cobros de Mercado Pago guardados enteros (mp_pagos), de TODAS las sucursales del
// negocio. Un cliente = una cuenta de Mercado Pago que le pagó al negocio (payer.id): junta
// email, CUIT/DNI y nombre (lo que haya), cuántas veces compró, cuánto, primera y última compra,
// medio que más usa y en qué sucursales. Lo que se paga la cuenta a sí misma no cuenta.
'use strict';

const pool = require('../config/db');

const MEDIO = {
  account_money: 'Dinero en cuenta', credit_card: 'Tarjeta de crédito', debit_card: 'Tarjeta de débito',
  prepaid_card: 'Tarjeta prepaga', bank_transfer: 'Transferencia', ticket: 'Efectivo (cupón)',
  digital_currency: 'Moneda digital', digital_wallet: 'Billetera digital',
};

/**
 * Documentos propios del negocio (14/11, Diego: «estás poniendo a un cliente del mismo CUIT del
 * negocio»): el CUIT/DNI de cada cuenta de Mercado Pago conectada (se pide a MP una vez y queda
 * guardado), el CUIT de cada sucursal y el del negocio, si hay. Lo que pagan esas cuentas no es un cliente.
 */
async function docsPropios(businessId) {
  const soloDigitos = (x) => String(x || '').replace(/\D/g, '');
  const docs = new Set();
  const neg = await pool.query(`SELECT props->>'tax_id' AS cuit FROM app_businesses WHERE id = $1`, [businessId]);
  if (soloDigitos(neg.rows[0]?.cuit)) docs.add(soloDigitos(neg.rows[0].cuit));
  // CUIT de cada sucursal (Diego 14/11: «el perfil de cada sucursal tiene su CUIT, que puede o no ser
  // el de la organización u otra sucursal»): se carga en Editar sucursal (props.cuit).
  const sucs = await pool.query(`SELECT props->>'cuit' AS cuit FROM app_branches WHERE business_id = $1`, [businessId]);
  sucs.rows.forEach((r) => { if (soloDigitos(r.cuit)) docs.add(soloDigitos(r.cuit)); });
  const { rows } = await pool.query(
    'SELECT sucursal, mp_doc FROM integraciones_mercadopago WHERE business_id = $1', [businessId]);
  for (const r of rows) {
    let doc = soloDigitos(r.mp_doc);
    if (!doc) {
      try {
        const mp = require('./mercadopagoService');
        const t = await mp.tokenVigente(businessId, r.sucursal);
        if (!t.error) {
          const res = await fetch('https://api.mercadopago.com/users/me', { headers: { Authorization: `Bearer ${t.token}` } });
          const yo = res.ok ? await res.json() : null;
          doc = soloDigitos(yo?.identification?.number);
          if (doc) {
            await pool.query('UPDATE integraciones_mercadopago SET mp_doc = $3 WHERE business_id = $1 AND sucursal = $2',
              [businessId, r.sucursal, doc]);
          }
        }
      } catch (e) {
        console.warn('[clientes] doc propio:', e.message);
      }
    }
    if (doc) docs.add(doc);
  }
  await completarCuits(businessId, rows.map((r) => ({ ...r, mp_doc: r.mp_doc || null }))).catch((e) => console.warn('[clientes] completar CUIT:', e.message));
  return [...docs];
}

/**
 * Completa solo el CUIT del local y de la sucursal con el de su cuenta de Mercado Pago, si estaba
 * vacío (Diego 15/11: «¿no debería estar cargado ahí?»). Sucursal 0 = el negocio y su sucursal
 * principal; > 0 = esa sucursal. Nunca pisa un CUIT cargado a mano. Deja marcado el origen para
 * que el formulario diga de dónde salió, y un aviso en la campana si completó algo.
 */
async function completarCuits(businessId, filas) {
  const { rows } = await pool.query(
    'SELECT sucursal, mp_doc FROM integraciones_mercadopago WHERE business_id = $1 AND mp_doc IS NOT NULL', [businessId]);
  const fmt = (d) => `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
  const completados = [];
  for (const r of rows) {
    const d = String(r.mp_doc || '').replace(/\D/g, '');
    if (d.length !== 11) continue;
    const extra = JSON.stringify({ cuit: fmt(d), cuit_origen: 'mercadopago' });
    if (Number(r.sucursal) === 0) {
      const n = await pool.query(
        `UPDATE app_businesses SET props = COALESCE(props, '{}'::jsonb) || jsonb_build_object('tax_id', $2::text, 'tax_id_origen', 'mercadopago')
          WHERE id = $1 AND COALESCE(props->>'tax_id', '') = '' RETURNING name`, [businessId, fmt(d)]);
      const b = await pool.query(
        `UPDATE app_branches SET props = COALESCE(props, '{}'::jsonb) || $2::jsonb, updated_at = NOW()
          WHERE business_id = $1 AND COALESCE((props->>'is_main')::boolean, false) AND COALESCE(props->>'cuit', '') = '' RETURNING name`,
        [businessId, extra]);
      [...n.rows, ...b.rows].forEach((x) => completados.push(x.name));
    } else {
      const b = await pool.query(
        `UPDATE app_branches SET props = COALESCE(props, '{}'::jsonb) || $3::jsonb, updated_at = NOW()
          WHERE id = $2 AND business_id = $1 AND COALESCE(props->>'cuit', '') = '' RETURNING name`,
        [businessId, r.sucursal, extra]);
      b.rows.forEach((x) => completados.push(x.name));
    }
  }
  if (completados.length) {
    const { avisarAlEquipoSinEsperar } = require('./notificationService');
    const nombres = [...new Set(completados)];
    avisarAlEquipoSinEsperar({
      businessId, type: 'cuit_desde_mercadopago',
      title: `CUIT completado desde Mercado Pago: ${nombres.join(', ')}`,
      message: 'Se tomó el CUIT de la cuenta de Mercado Pago conectada. Se puede cambiar en Editar sucursal.',
      metadata: { link: '/configuracion?tab=3' },
    });
  }
  return completados;
}

async function clientes(businessId) {
  const propios = await docsPropios(businessId);
  const { rows } = await pool.query(
    `SELECT m.payer_id AS id,
            max(m.payer_email) AS email,
            max(m.payer_doc) AS doc,
            max(m.payer_doc_tipo) AS doc_tipo,
            max(m.payer_nombre) AS nombre,
            count(*)::int AS compras,
            round(sum(m.importe))::bigint AS total,
            min(m.fecha)::text AS primera,
            max(m.fecha)::text AS ultima,
            mode() WITHIN GROUP (ORDER BY m.medio) AS medio,
            array_agg(DISTINCT m.sucursal) AS sucursales
       FROM mp_pagos m
       LEFT JOIN integraciones_mercadopago i ON i.business_id = m.business_id AND i.sucursal = m.sucursal
      WHERE m.business_id = $1 AND m.rol = 'cobro' AND m.estado = 'approved'
        AND m.payer_id IS NOT NULL AND m.payer_id IS DISTINCT FROM i.mp_user_id::text
        AND (m.payer_doc IS NULL OR NOT (regexp_replace(m.payer_doc, '\\D', '', 'g') = ANY($2::text[])))
      GROUP BY m.payer_id`, [businessId, propios]);
  const rango = await pool.query(
    `SELECT min(fecha)::text AS desde, max(fecha)::text AS hasta FROM mp_pagos WHERE business_id = $1 AND rol = 'cobro'`, [businessId]);
  // Cuentas de MP vinculadas: si alguna todavía no terminó de traer su historial, la pantalla lo dice.
  // Si hay alguna sin terminar y nadie la está trayendo, arranca acá (una sola instancia, ver asegurarHistorial).
  await require('./mercadopagoDiario').asegurarHistorial(businessId).catch((e) => console.warn('[clientes] historial:', e.message));
  const cuentas = await pool.query(
    `SELECT sucursal, mp_nickname AS nombre, historial_completo AS completo, historial_hasta::text AS hasta,
            (NOT coalesce(historial_completo, false) AND historial_intento_at > now() - interval '15 minutes') AS trayendo,
            ultimo_sync_error AS error
       FROM integraciones_mercadopago WHERE business_id = $1 ORDER BY sucursal`, [businessId]);
  return {
    cuentas: cuentas.rows,
    propios, // CUIT/DNI de las cuentas propias, que no cuentan como clientes
    desde: rango.rows[0]?.desde || null,
    hasta: rango.rows[0]?.hasta || null,
    clientes: rows.map((r) => ({ ...r, total: Number(r.total) || 0, medio: MEDIO[r.medio] || r.medio || '' })),
  };
}

module.exports = { clientes, docsPropios };
