// db/scripts/diagnostico-wona.js — SOLO LECTURA (usuaria 25/11/2026: «no veo insumos en el negocio de Wona»).
// Por cada negocio conectado a Wona: sede, última lectura, error, resumen de lo que trajo, y cuántos
// insumos / recetas / productos de Wona hay y si los insumos están en alguna agrupación.
//
// Uso (Render Shell):  node db/scripts/diagnostico-wona.js
// No escribe nada: la transacción es READ ONLY y termina en ROLLBACK.
'use strict';
const pool = require('../../config/db');

(async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN READ ONLY');
    const { rows: cons } = await c.query(
      `SELECT w.business_id, b.name, w.tenant_nombre, w.traer, w.ventas_hasta, w.ultimo_sync_at, w.ultimo_sync_error, w.ultimo_resumen
         FROM integraciones_wona w JOIN app_businesses b ON b.id = w.business_id ORDER BY w.business_id`);
    if (!cons.length) console.log('No hay negocios conectados a Wona.');
    for (const w of cons) {
      const bid = w.business_id;
      const r = w.ultimo_resumen || {};
      console.log(`\n=== ${bid} · ${w.name} · sede Wona: ${w.tenant_nombre}`);
      console.log('traer:', JSON.stringify(w.traer), '| ventas hasta:', w.ventas_hasta, '| última lectura:', w.ultimo_sync_at);
      console.log('error última lectura:', w.ultimo_sync_error || '(ninguno)');
      console.log('resumen → articulos:', JSON.stringify(r.articulos), '| insumos:', JSON.stringify(r.insumos), '| recetas:', JSON.stringify(r.recetas),
        '| compras:', JSON.stringify(r.compras));
      const q = async (sql, params) => (await c.query(sql, params)).rows[0];
      const prod = await q(`SELECT COUNT(*) FILTER (WHERE tipo = 'buffet')::int AS buffet, COUNT(*) FILTER (WHERE tipo = 'buffet' AND insumo_id IS NOT NULL)::int AS con_insumo
                              FROM wona_productos WHERE business_id = $1`, [bid]);
      const ins = await q(`SELECT COUNT(*)::int AS wona, COUNT(*) FILTER (WHERE estado = 'activo')::int AS activos FROM insumos WHERE business_id = $1 AND origen = 'wona'`, [bid]);
      const todos = await q(`SELECT COUNT(*)::int AS n FROM insumos WHERE business_id = $1`, [bid]);
      const rec = await q(`SELECT COUNT(*)::int AS n FROM recetas WHERE business_id = $1 AND origen = 'wona'`, [bid]);
      let agrup = null;
      try {
        agrup = await q(
          `SELECT COUNT(DISTINCT i.id)::int AS en_agrupacion FROM insumos i
             JOIN insumo_group_items gi ON gi.insumo_id = i.id
            WHERE i.business_id = $1 AND i.origen = 'wona'`, [bid]);
      } catch (e) { agrup = { error: e.message.slice(0, 80) }; }
      const negocio = await q(`SELECT created_from, organization_id FROM app_businesses WHERE id = $1`, [bid]);
      console.log('productos buffet:', prod.buffet, '| con insumo:', prod.con_insumo, '| insumos de Wona:', ins.wona, `(activos ${ins.activos})`,
        '| insumos del negocio (todos):', todos.n, '| recetas de Wona:', rec.n, '| en alguna agrupación:', JSON.stringify(agrup),
        '| negocio:', JSON.stringify(negocio));
    }
    await c.query('ROLLBACK');
  } finally {
    c.release();
    await pool.end();
  }
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
