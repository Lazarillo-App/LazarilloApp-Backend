// db/scripts/diag-articulo-agrupacion.js
//
// Diagnóstico: para un artículo (por nombre o código) y un negocio, muestra en
// qué agrupación(es) de la organización está asignado hoy, y si el filtro de
// "artículos permitidos" de listArticlesFromDB (usado por Crear Agrupación,
// Tabla, etc.) lo dejaría pasar como visible desde ese negocio — para
// encontrar por qué un artículo de OTRO subnegocio se está colando.
//
// Uso:
//   node db/scripts/diag-articulo-agrupacion.js --business=147 --nombre="Isotonica 500ml manzana"
//   node db/scripts/diag-articulo-agrupacion.js --business=147 --articulo=12345
//
'use strict';
require('dotenv').config();
const pool = require('../../config/db');

const bizArg = process.argv.find(a => a.startsWith('--business='));
const nombreArg = process.argv.find(a => a.startsWith('--nombre='));
const artArg = process.argv.find(a => a.startsWith('--articulo='));
const bizId = bizArg ? Number(bizArg.split('=')[1]) : null;
const nombreBuscado = nombreArg ? nombreArg.split('=').slice(1).join('=') : null;
const articuloIdArg = artArg ? Number(artArg.split('=')[1]) : null;

async function main() {
  if (!bizId || (!nombreBuscado && !articuloIdArg)) {
    console.error('Uso: node db/scripts/diag-articulo-agrupacion.js --business=ID (--nombre="..." | --articulo=ID)');
    process.exit(1);
  }

  const { rows: bizRows } = await pool.query(
    `SELECT id, name, organization_id, created_from FROM app_businesses WHERE id = $1`, [bizId]
  );
  if (!bizRows.length) { console.log(`No existe business_id=${bizId}`); await pool.end(); return; }
  const biz = bizRows[0];
  console.log('── NEGOCIO CONSULTADO ──');
  console.log(biz);

  const { rows: principalRows } = await pool.query(
    `SELECT id, name FROM app_businesses
      WHERE organization_id = $1 AND created_from != 'from_group'
      ORDER BY created_at ASC LIMIT 1`,
    [biz.organization_id]
  );
  const principal = principalRows[0];
  console.log('\n── PRINCIPAL DE LA ORG ──');
  console.log(principal);
  const isSubBusiness = principal && Number(biz.id) !== Number(principal.id);
  console.log(`¿Este negocio es subnegocio? ${isSubBusiness ? 'SÍ' : 'NO'}`);

  // Resolver el/los articulo_id candidatos por nombre (en maxi_articles del principal)
  let articuloIds = [];
  if (articuloIdArg) {
    articuloIds = [articuloIdArg];
  } else {
    const { rows } = await pool.query(
      `SELECT articulo_id, nombre FROM public.maxi_articles
        WHERE business_id = $1 AND nombre ILIKE $2
        ORDER BY nombre LIMIT 20`,
      [principal.id, `%${nombreBuscado}%`]
    );
    console.log(`\n── COINCIDENCIAS POR NOMBRE "${nombreBuscado}" (en maxi_articles del principal) ──`);
    console.log(rows);
    articuloIds = rows.map(r => Number(r.articulo_id));
  }

  if (!articuloIds.length) { console.log('\nNo se encontró ningún artículo con ese criterio.'); await pool.end(); return; }

  // Todas las agrupaciones de la org (mismo criterio que getOrgArticleContext)
  const { rows: agRows } = await pool.query(
    `SELECT ag.id, ag.nombre, ag.business_id, b.name AS business_name,
            ag.articulos, ag.app_articles_ids, ag.moved_to_business_id
       FROM agrupaciones ag
       JOIN app_businesses b ON b.id = ag.business_id
      WHERE b.organization_id = $1`,
    [biz.organization_id]
  );

  for (const artId of articuloIds) {
    console.log(`\n══ artículo_id=${artId} ══`);
    const contieneA = [];
    const contieneATodas = []; // incluye Sin Agrupación/Discontinuados para contexto
    for (const ag of agRows) {
      const arts = Array.isArray(ag.articulos) ? ag.articulos
        : (typeof ag.articulos === 'string' ? JSON.parse(ag.articulos || '[]') : []);
      const appIds = Array.isArray(ag.app_articles_ids) ? ag.app_articles_ids
        : (typeof ag.app_articles_ids === 'string' ? JSON.parse(ag.app_articles_ids || '[]') : []);
      const enArticulos = arts.some(a => Number(a?.id ?? a?.articulo_id ?? a) === artId);
      const enAppIds = appIds.some(id => Number(id) === artId);
      if (enArticulos || enAppIds) {
        const esFlotante = /^Sin Agrupac|^Sin Agrupar|^Discontinuados|^Descontinuados/i.test(ag.nombre || '');
        const entry = {
          agrupacion: ag.nombre, agrupacion_id: ag.id,
          business: ag.business_name, business_id: ag.business_id,
          moved_to_business_id: ag.moved_to_business_id,
          via: enArticulos ? 'articulos(json)' : 'app_articles_ids',
          cuenta_para_assignedIds: !esFlotante && ag.moved_to_business_id == null,
        };
        contieneATodas.push(entry);
        if (entry.cuenta_para_assignedIds) contieneA.push(entry);
      }
    }
    console.log('Agrupaciones que lo contienen (todas, incl. Sin Agrupación/Discontinuados):');
    console.log(contieneATodas);
    console.log(`¿Cuenta como "assignedIds" (org-wide, el que usa listArticlesFromDB)? ${contieneA.length > 0 ? 'SÍ — ' + contieneA.map(e => `${e.business} / ${e.agrupacion}`).join(', ') : 'NO — quedaría como "libre" y visible desde cualquier subnegocio'}`);
  }

  await pool.end();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
