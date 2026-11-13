// services/ajustesService.js
// Ajustes a medida (usuaria 13/11/2026): cuando un pedido de un cliente se resuelve solo para él
// (o para sus negocios, o para todos), se prende acá una clave con su valor. El front pregunta los
// ajustes que le tocan (GET /api/soporte/ajustes) y los lee con useAjuste(clave, porDefecto).
// Gana el más específico: usuario > negocio > organización > global.
'use strict';

const pool = require('../config/db');

// Claves conocidas: el panel las ofrece con su explicación. Se puede usar cualquier otra clave
// (para lo que se programe a medida); estas ya están conectadas en el front.
const CATALOGO = [
  {
    clave: 'aviso_cliente', tipo: 'texto',
    titulo: 'Aviso arriba de la app',
    descripcion: 'Un mensaje que el cliente ve en una franja arriba de todo (ej. "Estamos trabajando en tu pedido de cronogramas").',
  },
  {
    clave: 'modulos_ocultos', tipo: 'lista',
    titulo: 'Módulos ocultos',
    descripcion: 'Módulos que no se muestran en el menú de módulos ni en Inicio. Valores: recetas, resultados, rrhh, tableros, stock, compras, conciliacion, balance.',
  },
  {
    clave: 'logo_google_imagenes', tipo: 'bool',
    titulo: 'Alta: link a Google Imágenes para el logo',
    descripcion: 'Muestra "Buscalo en Google Imágenes" en el logo del alta (hoy apagado para todos).',
  },
];
const ALCANCES = ['global', 'organizacion', 'negocio', 'usuario'];
const PESO = { global: 0, organizacion: 1, negocio: 2, usuario: 3 };
const CLAVE_RE = /^[a-z0-9][a-z0-9_.-]{1,59}$/;

/** Ajustes que le tocan a este usuario en este negocio: { clave: valor }. */
async function efectivos(userId, businessId) {
  let orgId = null;
  if (businessId) {
    const { rows } = await pool.query('SELECT organization_id FROM app_businesses WHERE id = $1', [businessId]);
    orgId = rows[0]?.organization_id ?? null;
  }
  const { rows } = await pool.query(
    `SELECT clave, alcance, valor FROM ajustes_alcance
      WHERE activo AND (
            alcance = 'global'
         OR (alcance = 'organizacion' AND scope_id = $1)
         OR (alcance = 'negocio'      AND scope_id = $2)
         OR (alcance = 'usuario'      AND scope_id = $3))`,
    [orgId, businessId || null, userId || null]);
  const out = {};
  const peso = {};
  for (const r of rows) {
    if (peso[r.clave] === undefined || PESO[r.alcance] > peso[r.clave]) { out[r.clave] = r.valor; peso[r.clave] = PESO[r.alcance]; }
  }
  return out;
}

async function listar() {
  const { rows } = await pool.query(
    `SELECT a.*,
            CASE a.alcance
              WHEN 'negocio' THEN (SELECT name FROM app_businesses WHERE id = a.scope_id)
              WHEN 'organizacion' THEN (SELECT name FROM organizations WHERE id = a.scope_id)
              WHEN 'usuario' THEN (SELECT coalesce(display_name, name, email) || ' · ' || email FROM app_users WHERE id = a.scope_id)
            END AS scope_nombre
       FROM ajustes_alcance a
      ORDER BY a.clave, a.alcance, a.scope_id`);
  return rows;
}

function validar(d) {
  const clave = String(d?.clave || '').trim().toLowerCase();
  if (!CLAVE_RE.test(clave)) return { error: 'clave_invalida' };
  const alcance = String(d?.alcance || '');
  if (!ALCANCES.includes(alcance)) return { error: 'alcance_invalido' };
  const scopeId = alcance === 'global' ? null : Number(d?.scope_id);
  if (alcance !== 'global' && !(Number.isFinite(scopeId) && scopeId > 0)) return { error: 'falta_a_quien' };
  let valor = d?.valor;
  if (valor === undefined || valor === '') valor = true;
  if (JSON.stringify(valor).length > 4000) return { error: 'valor_muy_largo' };
  return {
    fila: {
      clave, alcance, scope_id: scopeId, valor,
      activo: d?.activo !== false,
      nota: String(d?.nota || '').trim().slice(0, 500) || null,
      solicitud_id: Number(d?.solicitud_id) || null,
    },
  };
}

/** Crea o pisa el ajuste de esa clave para ese alcance. */
async function guardar(d, userId) {
  const v = validar(d);
  if (v.error) return v;
  const f = v.fila;
  const { rows } = await pool.query(
    `INSERT INTO ajustes_alcance (clave, alcance, scope_id, valor, activo, nota, solicitud_id, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     ON CONFLICT (clave, alcance, COALESCE(scope_id, 0)) DO UPDATE SET
       valor = EXCLUDED.valor, activo = EXCLUDED.activo, nota = EXCLUDED.nota,
       solicitud_id = COALESCE(EXCLUDED.solicitud_id, ajustes_alcance.solicitud_id), updated_at = now()
     RETURNING *`,
    [f.clave, f.alcance, f.scope_id, JSON.stringify(f.valor), f.activo, f.nota, f.solicitud_id, userId || null]);
  return { ajuste: rows[0] };
}

async function borrar(id) {
  const { rowCount } = await pool.query('DELETE FROM ajustes_alcance WHERE id = $1', [Number(id)]);
  return rowCount ? { ok: true } : { error: 'no_encontrado' };
}

module.exports = { CATALOGO, ALCANCES, efectivos, listar, validar, guardar, borrar };
