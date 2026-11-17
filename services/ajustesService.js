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
    descripcion: 'Áreas o funciones que no se muestran (menú de módulos, Inicio y la ruta). Áreas: operacion, rentabilidad, administracion. Funciones: tableros, rrhh, resultados, recetas, stock, compras, conciliacion, movimientos-bancarios, clientes. Se gestiona en «Funciones por negocio». Los negocios cuyo dueño es super usuario ven todo.',
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
  let duenoSuper = false;
  if (businessId) {
    const { rows } = await pool.query(
      `SELECT b.organization_id, COALESCE(u.es_superusuario, false) AS dueno_super
         FROM app_businesses b LEFT JOIN app_users u ON u.id = b.owner_id WHERE b.id = $1`, [businessId]);
    orgId = rows[0]?.organization_id ?? null;
    duenoSuper = rows[0]?.dueno_super === true;
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
  // Los negocios cuyo dueño es super usuario (Lazarillo) ven todas las funciones (Diego 17/11/2026).
  if (duenoSuper) delete out.modulos_ocultos;
  return out;
}

// ── Funciones por negocio (Diego 17/11/2026) ──
// Qué áreas y funciones ve cada negocio: la clave modulos_ocultos (lista de ids) a nivel global
// (el default de todos) o por negocio (pisa el default entero).
const IDS_FUNCIONES = ['operacion', 'rentabilidad', 'administracion', 'tableros', 'rrhh', 'resultados',
  'recetas', 'stock', 'compras', 'conciliacion', 'movimientos-bancarios', 'clientes'];

async function funciones() {
  const { rows: negocios } = await pool.query(
    `SELECT b.id, b.name, b.organization_id, COALESCE(NULLIF(u.display_name, ''), NULLIF(u.name, ''), u.email) AS dueno,
            COALESCE(u.es_superusuario, false) AS dueno_super, a.valor AS ocultos
       FROM app_businesses b
       LEFT JOIN app_users u ON u.id = b.owner_id
       LEFT JOIN ajustes_alcance a ON a.clave = 'modulos_ocultos' AND a.alcance = 'negocio' AND a.scope_id = b.id AND a.activo
      ORDER BY COALESCE(u.es_superusuario, false), lower(b.name)`);
  const { rows: g } = await pool.query(
    `SELECT valor FROM ajustes_alcance WHERE clave = 'modulos_ocultos' AND alcance = 'global' AND activo LIMIT 1`);
  return { global: Array.isArray(g[0]?.valor) ? g[0].valor : [], negocios, ids: IDS_FUNCIONES };
}

/** businessId null = el default de todos. ocultos null = el negocio vuelve al default. */
async function guardarFunciones(businessId, ocultos, userId) {
  const bid = businessId == null || businessId === '' ? null : Number(businessId);
  if (bid !== null && !(Number.isInteger(bid) && bid > 0)) return { error: 'negocio_invalido' };
  if (ocultos === null && bid !== null) {
    await pool.query(`DELETE FROM ajustes_alcance WHERE clave = 'modulos_ocultos' AND alcance = 'negocio' AND scope_id = $1`, [bid]);
    return { ok: true, ocultos: null };
  }
  if (!Array.isArray(ocultos) || ocultos.some((x) => !IDS_FUNCIONES.includes(x))) return { error: 'funciones_invalidas' };
  const lista = [...new Set(ocultos)];
  const out = await guardar({ clave: 'modulos_ocultos', alcance: bid ? 'negocio' : 'global', scope_id: bid, valor: lista,
    nota: 'Funciones por negocio' }, userId);
  if (out.error) return out;
  return { ok: true, ocultos: lista };
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

module.exports = { CATALOGO, ALCANCES, IDS_FUNCIONES, efectivos, listar, validar, guardar, borrar, funciones, guardarFunciones };
