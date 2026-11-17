// services/gestion/conceptos/plantilla.js
//
// Plantilla Lazarillo para negocios nuevos (tablero #7, Diego 14/11/2026). La plantilla vive en el
// Negocio DEMO (organización 25, negocio 225) y Diego la depura ahí con las pantallas de siempre
// (migración 129): lo que haya en DEMO en el momento es lo que recibe un negocio nuevo.
//
// Qué se copia:
//   - de la organización: rubros de caja y conceptos de caja (solo si la organización no tiene NI UN
//     concepto, así nunca se mezclan con los de MaxiRest ni con lo que el negocio ya armó);
//   - de cada negocio de esa organización, si todavía no los tiene: visibilidad de rubros en el Panel,
//     variables del punto de equilibrio y rubros de insumo con su concepto. Si el negocio ya tiene
//     rubros de insumo (p. ej. los trajo de Fudo), solo se les pone el concepto de la plantilla a los
//     que se llaman igual y no tienen ninguno.
//
// No se copia a organizaciones con MaxiRest (el maestro de Maxi trae sus conceptos). Si DEMO no está
// (base local, tests), quedan los conceptos básicos de base.js.
//
// Cuándo: al entrar al Panel (gestionRoutes) y cuando llegan compras de otro sistema (comprasExternas).
// No en el alta del negocio: ahí todavía no se sabe si va a usar MaxiRest.
'use strict';

const { armarBase } = require('./base');

const DEMO_ORG = 25;
const DEMO_BIZ = 225;
const MARCA = 'copia de DEMO';
const sinAcento = (col) => `lower(translate(trim(${col}), 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU'))`;

/** ¿Algún negocio de la organización usa MaxiRest? (credenciales, POS elegido en el alta, kit vinculado). */
async function usaMaxi(client, organizationId) {
  const { rows } = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM app_businesses b
        WHERE b.organization_id = $1
          AND (COALESCE(b.props->'maxi'->>'email', '') <> ''
               OR lower(COALESCE(b.props->'onboarding'->>'pos', '')) = 'maxirest'
               OR EXISTS (SELECT 1 FROM kit_pcs k WHERE k.business_id = b.id AND k.revocado_en IS NULL)
               OR EXISTS (SELECT 1 FROM gestion_render_origenes o WHERE o.business_id = b.id))) AS si`,
    [organizationId]);
  return !!rows[0]?.si;
}

async function copiarOrganizacion(client, organizationId) {
  const { rowCount: rubros } = await client.query(
    `INSERT INTO gestion_rubros_concepto_caja (organization_id, codigo, nombre, "calcRent")
     SELECT $1, codigo, nombre, "calcRent" FROM gestion_rubros_concepto_caja WHERE organization_id = $2
     ON CONFLICT (organization_id, codigo) DO NOTHING`, [organizationId, DEMO_ORG]);
  const { rowCount: conceptos } = await client.query(
    `INSERT INTO gestion_conceptos_caja (organization_id, codigo, nombre, tipo, "codImp", "codRga")
     SELECT $1, codigo, nombre, tipo, "codImp", "codRga" FROM gestion_conceptos_caja WHERE organization_id = $2
     ON CONFLICT (organization_id, codigo) DO NOTHING`, [organizationId, DEMO_ORG]);
  if (conceptos > 0) return { rubros, conceptos, origen: MARCA };

  // Sin DEMO: los básicos.
  const base = armarBase();
  await client.query(
    `INSERT INTO gestion_rubros_concepto_caja (organization_id, codigo, nombre)
     SELECT $1, * FROM UNNEST($2::text[], $3::text[]) ON CONFLICT (organization_id, codigo) DO NOTHING`,
    [organizationId, base.rubros.map((r) => r.codigo), base.rubros.map((r) => r.nombre)]);
  await client.query(
    `INSERT INTO gestion_conceptos_caja (organization_id, codigo, nombre, tipo, "codRga")
     SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[]) ON CONFLICT (organization_id, codigo) DO NOTHING`,
    [organizationId, base.conceptos.map((c) => c.codigo), base.conceptos.map((c) => c.nombre),
      base.conceptos.map((c) => c.tipo), base.conceptos.map((c) => c.codRga)]);
  return { rubros: base.rubros.length, conceptos: base.conceptos.length, origen: 'básicos' };
}

async function copiarNegocio(client, businessId) {
  const out = {};
  const vacio = async (tabla) => !(await client.query(`SELECT 1 FROM ${tabla} WHERE business_id = $1 LIMIT 1`, [businessId])).rows.length;

  if (await vacio('gestion_rubros_visibilidad')) {
    out.visibilidad = (await client.query(
      `INSERT INTO gestion_rubros_visibilidad (business_id, codigo, "visibleEnDashboard", "visibleEnResultados")
       SELECT $1, codigo, "visibleEnDashboard", "visibleEnResultados" FROM gestion_rubros_visibilidad WHERE business_id = $2
       ON CONFLICT DO NOTHING`, [businessId, DEMO_BIZ])).rowCount;
  }
  if (await vacio('gestion_equilibrio_variables')) {
    out.equilibrio = (await client.query(
      `INSERT INTO gestion_equilibrio_variables (business_id, tipo, codigo, pct)
       SELECT $1, tipo, codigo, pct FROM gestion_equilibrio_variables WHERE business_id = $2
       ON CONFLICT DO NOTHING`, [businessId, DEMO_BIZ])).rowCount;
  }
  if (await vacio('insumo_rubros')) {
    out.rubrosInsumo = (await client.query(
      `INSERT INTO insumo_rubros (business_id, codigo, codigo_maxi, nombre, cpto_caja_lazarillo, es_elaborador, activo)
       SELECT $1, codigo, codigo_maxi, nombre, cpto_caja_lazarillo, es_elaborador, activo
         FROM insumo_rubros WHERE business_id = $2 AND COALESCE(activo, true)
       ON CONFLICT (business_id, codigo) DO NOTHING`, [businessId, DEMO_BIZ])).rowCount;
  } else {
    // Rubros que ya tenía (de Fudo, cargados a mano): el concepto de la plantilla al que se llama igual.
    out.rubrosConConcepto = (await client.query(
      `UPDATE insumo_rubros r SET cpto_caja_lazarillo = d.cpto_caja_lazarillo, updated_at = now()
         FROM insumo_rubros d
        WHERE r.business_id = $1 AND d.business_id = $2 AND d.cpto_caja_lazarillo IS NOT NULL
          AND r.cpto_caja_lazarillo IS NULL AND NULLIF(NULLIF(r.cpto_caja::text, ''), '0') IS NULL
          AND ${sinAcento('r.nombre')} = ${sinAcento('d.nombre')}`, [businessId, DEMO_BIZ])).rowCount;
  }
  return out;
}

/**
 * Deja la plantilla en la organización y en el negocio si corresponde. Va en la transacción que le
 * pasen (client de pg). Devuelve { creados, ... } — creados = conceptos copiados (0 si ya tenía).
 */
async function asegurarPlantilla(client, { organizationId, businessId = null }) {
  const org = Number(organizationId);
  if (!org || org === DEMO_ORG) return { creados: 0 };
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`plantilla:${org}`]);
  if (await usaMaxi(client, org)) return { creados: 0, maxi: true };

  const out = { creados: 0 };
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM gestion_conceptos_caja WHERE organization_id = $1', [org]);
  if (rows[0].n === 0) {
    const r = await copiarOrganizacion(client, org);
    out.creados = r.conceptos;
    out.origen = r.origen;
    await client.query(
      `INSERT INTO gestion_plantilla_aplicada (organization_id, origen) VALUES ($1, $2) ON CONFLICT (organization_id) DO NOTHING`,
      [org, r.origen]);
  }
  // Lo del negocio, solo en organizaciones que recibieron la plantilla (no en las que ya tenían lo suyo).
  const { rows: marca } = await client.query('SELECT origen FROM gestion_plantilla_aplicada WHERE organization_id = $1', [org]);
  if (businessId && marca[0]?.origen === MARCA) Object.assign(out, await copiarNegocio(client, Number(businessId)));
  return out;
}

/** Igual que asegurarPlantilla pero con su propia transacción (para usar fuera de una). */
async function asegurarPlantillaSola(pool, args) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await asegurarPlantilla(client, args);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

module.exports = { asegurarPlantilla, asegurarPlantillaSola, DEMO_ORG, DEMO_BIZ };
