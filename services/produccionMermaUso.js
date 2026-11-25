// services/produccionMermaUso.js — «Usar esta merma» desde Producción (usuaria 25/11/2026).
// El jefe de cocina, el dueño o el admin guardan la merma medida en la cocina (bruto → limpio) como merma
// de limpieza del insumo. Se aplica en el momento, sin aprobación; dueño y admin reciben aviso y pueden
// DESHACER: cada uso guarda cómo estaba la merma antes (produccion_mermas_uso.antes) y se vuelve exacto.
// Las recetas que usan esa merma se recalculan igual que al editarla desde la ficha del insumo.
'use strict';

const pool = require('../config/db');
const { _ctx } = require('./produccion');
const { propagarCostoInsumo } = require('./costoRecetaService');

const { contextoDe, fallar, exigir, bizInsumos } = _ctx;
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pctDe = (pi, pf) => (pi > 0 ? Math.round(((pi - pf) / pi) * 1000) / 10 : null);
const factorDe = (pi, pf) => (pf > 0 ? pi / pf : 1);

/**
 * El circuito completo (igual que editar o borrar una merma en la ficha del insumo): cada renglón de receta
 * que usa el insumo se recalcula con los valores actuales de sus mermas (también si tiene varias), sus
 * recetas se recalculan y, si alguna es de un elaborado, su costo sube a las recetas que lo usan.
 */
const recalcularCircuito = (client, insumoId, bizDelInsumo) => propagarCostoInsumo(insumoId, bizDelInsumo, client);

// Sube por la cadena (jefe → dueño/admin; dueño → el resto de dueños/admins). Ver produccion.avisarCadena.
const avisar = (c, args) => _ctx.avisarCadenaSinEsperar(c, args);

/** POST /produccion/mermas/usar { insumo_id, bruto, neto, registro_id? } — jefe, dueño o admin. */
async function usarMerma(req) {
  const c = await contextoDe(req); exigir(c.planifica);
  const b = req.body || {};
  const insumoId = Number(b.insumo_id);
  const pi = num(b.bruto), pf = num(b.neto);
  if (!insumoId) fallar(400, 'insumo_requerido');
  if (!(pi > 0) || !(pf > 0) || pf > pi) fallar(400, 'pesos_invalidos', 'El peso limpio tiene que ser mayor a 0 y no más que el bruto');
  const bizDelInsumo = await bizInsumos(c.bizId);
  const { rows: ins } = await pool.query('SELECT id, nombre FROM insumos WHERE id = $1 AND business_id = $2', [insumoId, bizDelInsumo]);
  if (!ins[0]) fallar(404, 'insumo_no_encontrado');
  const registroId = Number(b.registro_id) || null;
  if (registroId) {
    const { rows } = await pool.query('SELECT 1 FROM produccion_mermas WHERE id = $1 AND business_id = $2 AND deleted_at IS NULL', [registroId, c.bizId]);
    if (!rows[0]) fallar(404, 'registro_no_encontrado');
  }
  const client = await pool.connect();
  let uso;
  try {
    await client.query('BEGIN');
    // La merma de limpieza del insumo: la marcada por defecto, si no la primera; si no hay, se crea «Limpieza».
    const { rows: m } = await client.query(
      `SELECT * FROM insumo_mermas WHERE insumo_id = $1 ORDER BY es_default DESC NULLS LAST, id LIMIT 1 FOR UPDATE`, [insumoId]);
    let mermaId;
    let antes;
    if (m[0]) {
      const vpi = Number(m[0].peso_inicial), vpf = Number(m[0].peso_final);
      antes = { existia: true, nombre: m[0].nombre, peso_inicial: vpi, peso_final: vpf, es_default: !!m[0].es_default, pct: pctDe(vpi, vpf) };
      mermaId = Number(m[0].id);
      await client.query(`UPDATE insumo_mermas SET peso_inicial = $2, peso_final = $3, es_default = TRUE, updated_at = NOW() WHERE id = $1`, [mermaId, pi, pf]);
      if (factorDe(vpi, vpf) !== factorDe(pi, pf)) await recalcularCircuito(client, insumoId, bizDelInsumo);
    } else {
      antes = { existia: false, pct: null };
      const { rows } = await client.query(
        `INSERT INTO insumo_mermas (insumo_id, nombre, peso_inicial, peso_final, es_default) VALUES ($1, 'Limpieza', $2, $3, TRUE) RETURNING id`,
        [insumoId, pi, pf]);
      mermaId = Number(rows[0].id);
    }
    const despues = { nombre: m[0]?.nombre || 'Limpieza', peso_inicial: pi, peso_final: pf, pct: pctDe(pi, pf) };
    const { rows: u } = await client.query(
      `INSERT INTO produccion_mermas_uso (business_id, insumo_id, insumo_merma_id, registro_id, antes, despues, user_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) RETURNING id`,
      [c.bizId, insumoId, mermaId, registroId, JSON.stringify(antes), JSON.stringify(despues), c.uid]);
    uso = { id: Number(u[0].id), antes, despues };
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const txtAntes = uso.antes.pct != null ? `${String(uso.antes.pct).replace('.', ',')} %` : 'sin merma';
  avisar(c, {
    type: 'produccion_cambio',
    title: `Merma de ${ins[0].nombre}: ${txtAntes} → ${String(uso.despues.pct).replace('.', ',')} %`,
    message: 'Se usó la merma medida en la cocina. Dueño o admin lo pueden deshacer en Producción › Mermas y desperdicios.',
    metadata: { kind: 'produccion_merma_uso', uso_id: uso.id, insumo_id: insumoId },
  });
  return { ok: true, uso };
}

/** POST /produccion/mermas/usos/:usoId/deshacer — solo dueño o admin. Vuelve la merma del insumo a como estaba. */
async function deshacerUso(req) {
  const c = await contextoDe(req); exigir(c.decide);
  const id = Number(req.params.usoId);
  const bizDelInsumo = await bizInsumos(c.bizId);
  const client = await pool.connect();
  let u;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT x.*, i.nombre AS insumo FROM produccion_mermas_uso x LEFT JOIN insumos i ON i.id = x.insumo_id
        WHERE x.id = $1 AND x.business_id = $2 FOR UPDATE OF x`, [id, c.bizId]);
    u = rows[0];
    if (!u) fallar(404, 'no_encontrado');
    if (u.deshecho_at) fallar(409, 'ya_deshecho', 'Ya estaba deshecho');
    // Solo el último uso de ese insumo se deshace (si hubo otro después, deshacer este pisaría el nuevo).
    const { rows: posterior } = await client.query(
      `SELECT 1 FROM produccion_mermas_uso WHERE insumo_id = $1 AND business_id = $2 AND id > $3 AND deshecho_at IS NULL LIMIT 1`, [u.insumo_id, c.bizId, id]);
    if (posterior[0]) fallar(409, 'hay_uno_posterior', 'Después se usó otra merma para este insumo: deshacé primero la más nueva');
    const a = u.antes || {};
    const { rows: actual } = await client.query('SELECT * FROM insumo_mermas WHERE id = $1 FOR UPDATE', [u.insumo_merma_id]);
    if (actual[0]) {
      if (a.existia) {
        await client.query(`UPDATE insumo_mermas SET peso_inicial = $2, peso_final = $3, es_default = $4, updated_at = NOW() WHERE id = $1`,
          [u.insumo_merma_id, a.peso_inicial, a.peso_final, !!a.es_default]);
      } else {
        // No había merma: se saca la creada, salvo que ya la use alguna receta (ahí queda sin merma: 1 → 1).
        const { rows: usa } = await client.query('SELECT 1 FROM receta_items WHERE merma_id = $1 LIMIT 1', [u.insumo_merma_id]);
        if (usa[0]) {
          await client.query(`UPDATE insumo_mermas SET peso_inicial = 1, peso_final = 1, updated_at = NOW() WHERE id = $1`, [u.insumo_merma_id]);
        } else {
          await client.query('DELETE FROM insumo_mermas WHERE id = $1', [u.insumo_merma_id]);
        }
      }
      await recalcularCircuito(client, Number(u.insumo_id), bizDelInsumo);
    }
    await client.query('UPDATE produccion_mermas_uso SET deshecho_at = NOW(), deshecho_por = $2 WHERE id = $1', [id, c.uid]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const a = u.antes || {};
  avisar(c, {
    type: 'produccion_cambio',
    title: `Se deshizo el cambio de merma de ${u.insumo || 'un insumo'}`,
    message: a.pct != null ? `Volvió a ${String(a.pct).replace('.', ',')} %.` : 'Volvió a no tener merma cargada.',
    metadata: { kind: 'produccion_merma_uso', uso_id: id, insumo_id: Number(u.insumo_id) },
    extra: [Number(u.user_id)],
  });
  return { ok: true };
}

/** Últimos usos (60 días) para la lista de Mermas: quién, cuándo, antes → después y si se deshizo. */
async function usosRecientes(c) {
  const { rows } = await pool.query(
    `SELECT x.*, i.nombre AS insumo, COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), split_part(u.email, '@', 1)) AS usuario,
            COALESCE(NULLIF(d.display_name, ''), NULLIF(d.name, ''), split_part(d.email, '@', 1)) AS deshizo
       FROM produccion_mermas_uso x LEFT JOIN insumos i ON i.id = x.insumo_id
       LEFT JOIN app_users u ON u.id = x.user_id LEFT JOIN app_users d ON d.id = x.deshecho_por
      WHERE x.business_id = $1 AND x.created_at > NOW() - INTERVAL '60 days'
      ORDER BY x.created_at DESC LIMIT 50`, [c.bizId]);
  const ultimoPorInsumo = new Map();
  for (const r of rows) if (!r.deshecho_at && !ultimoPorInsumo.has(Number(r.insumo_id))) ultimoPorInsumo.set(Number(r.insumo_id), Number(r.id));
  return rows.map((r) => ({
    id: Number(r.id), insumo_id: Number(r.insumo_id), insumo: r.insumo, registro_id: r.registro_id ? Number(r.registro_id) : null,
    antes: r.antes, despues: r.despues, usuario: r.usuario, created_at: r.created_at,
    deshecho_at: r.deshecho_at, deshizo: r.deshizo,
    puede_deshacer: !!c.decide && !r.deshecho_at && ultimoPorInsumo.get(Number(r.insumo_id)) === Number(r.id),
  }));
}

module.exports = { usarMerma, deshacerUso, usosRecientes, _puros: { pctDe, factorDe } };
