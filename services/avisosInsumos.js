// services/avisosInsumos.js
// Avisos de Notificaciones para cada ABM de Insumos (regla «todo ABM queda en Notificaciones»,
// Diego 12/11/2026). Se enganchan en routes/insumosRoutes.js con middleware/avisoAbm.js.
// Lecturas por id (clave primaria): solo nombres para el título, no modifican nada.
const pool = require('../config/db');
const avisoAbm = require('../middleware/avisoAbm');
const getBusinessId = require('../utils/getBusinessId');

const uno = async (sql, args) => (await pool.query(sql, args).catch(() => ({ rows: [] }))).rows[0] || null;
const nomIns = async (id) => (await uno('SELECT nombre FROM insumos WHERE id = $1', [Number(id)]))?.nombre || `Insumo ${id}`;
const nomGrupo = async (id) => (await uno('SELECT nombre FROM insumo_groups WHERE id = $1', [Number(id)]))?.nombre || `Agrupación ${id}`;
const nomMerma = async (id) => (await uno('SELECT nombre FROM insumo_mermas WHERE id = $1', [Number(id)]))?.nombre || null;
const nomEq = async (id) => (await uno('SELECT nombre FROM insumo_equivalencias WHERE id = $1', [Number(id)]))?.nombre || null;
const cant = (n, s, p) => `${n} ${n === 1 ? s : p}`;
const esDiscontinuados = (nombre) => /^discontinuad/i.test(String(nombre || '').trim());
const ids = (arr) => (Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isFinite(n) && n > 0) : []);
const fmt = (v) => (v == null || v === '' ? '—' : String(v));

const A = {};

/* ───── ABM del insumo ───── */
A.actualizar = avisoAbm({
  antes: (req) => uno(
    `SELECT nombre, unidad_med, precio_ref, rubro, estado, es_elaborado, costo_preferido,
            contenido_envase, unidad_envase
       FROM insumos WHERE id = $1`, [Number(req.params.id)]
  ),
  armar: (req, body, a) => {
    const d = body?.data;
    if (!a || !d) return null;
    const cambios = [];
    const par = (rot, x, y) => { if (fmt(x) !== fmt(y)) cambios.push(`${rot}: ${fmt(x)} → ${fmt(y)}`); };
    par('Nombre', a.nombre, d.nombre);
    par('Unidad', a.unidad_med, d.unidad_med);
    par('Precio', a.precio_ref, d.precio_ref);
    par('Rubro', a.rubro, d.rubro);
    par('Estado', a.estado, d.estado);
    par('Costo', a.costo_preferido, d.costo_preferido);
    par('Envase', [a.contenido_envase, a.unidad_envase].filter((x) => x != null).join(' '), [d.contenido_envase, d.unidad_envase].filter((x) => x != null).join(' '));
    if (!!a.es_elaborado !== !!d.es_elaborado) cambios.push(d.es_elaborado ? 'Ahora es elaborado' : 'Ya no es elaborado');
    if (!cambios.length) return null;
    return {
      type: 'insumo_edit', title: `Insumo editado: ${d.nombre || a.nombre}`, message: cambios.join(' · '),
      metadata: { ids: [Number(req.params.id)] },
      // el modal guarda campo por campo: un aviso por persona e insumo cada 30 min
      clave: `insumo_edit:${req.params.id}:${req.user?.id || 0}`,
    };
  },
});

A.darDeBaja = avisoAbm({ // DELETE /:id → queda discontinuado
  armar: async (req) => ({
    type: 'insumo_edit', title: `Insumo dado de baja: ${await nomIns(req.params.id)}`,
    message: 'Queda discontinuado', metadata: { ids: [Number(req.params.id)] },
  }),
});

A.normalizar = avisoAbm({
  armar: (req, b) => (b.cambiados ? {
    type: 'insumo_edit', title: `Nombres de insumos normalizados: ${b.cambiados}`,
    message: req.body?.formato === 'mayuscula' ? 'En mayúsculas' : 'Como título',
  } : null),
});

A.reemplazar = avisoAbm({
  armar: async (req, b) => (b.recetasAfectadas ? {
    type: 'insumo_reemplazo',
    title: `Insumo reemplazado: ${await nomIns(req.params.id)} → ${await nomIns(req.body?.nuevoInsumoId)}`,
    message: `En ${cant(b.recetasAfectadas, 'receta', 'recetas')}`,
    metadata: { ids: [Number(req.params.id), Number(req.body?.nuevoInsumoId)] },
  } : null),
});

A.desperdicio = avisoAbm({
  armar: async (req, b) => ({
    type: 'insumo_edit', title: `Desperdicio de ${await nomIns(req.params.id)}`,
    message: b.desperdicio_pct_override == null ? 'Vuelve al del rubro' : `${b.desperdicio_pct_override}% · recetas recalculadas`,
    metadata: { ids: [Number(req.params.id)] },
    clave: `insumo_desp:${req.params.id}:${req.user?.id || 0}`,
  }),
});

/* ───── carga en lote ───── */
A.bulk = avisoAbm({
  armar: (req, b) => {
    const s = b.summary || {};
    if (!s.inserted && !s.updated) return null;
    return { type: 'insumo_import', title: `Insumos cargados en lote: ${s.inserted || 0} nuevos · ${s.updated || 0} actualizados` };
  },
});
A.bulkCsv = avisoAbm({
  armar: (req, b) => {
    const n = Array.isArray(b.data) ? b.data.length : 0;
    return n ? { type: 'insumo_import', title: `Insumos cargados desde archivo: ${n}`, message: req.file?.originalname || null } : null;
  },
});
A.importPaired = avisoAbm({
  armar: (req, b) => {
    const i = b.insumos || {}; const r = b.rubros || {};
    if (!i.inserted && !i.updated && !r.inserted && !r.updated) return null;
    return {
      type: 'insumo_import', title: `Insumos importados: ${i.inserted || 0} nuevos · ${i.updated || 0} actualizados`,
      message: (r.inserted || r.updated) ? `Rubros: ${r.inserted || 0} nuevos · ${r.updated || 0} actualizados` : null,
    };
  },
});
A.borrarLote = avisoAbm({
  armar: (req, b) => (b.deleted ? { type: 'insumo_import', title: `Carga de insumos deshecha: ${cant(b.deleted, 'insumo borrado', 'insumos borrados')}` } : null),
});

/* ───── rubros ───── */
A.renombrarRubro = avisoAbm({
  armar: (req, b) => (b.rubros_updated ? {
    type: 'insumo_rubro', title: `Rubro renombrado: ${req.body?.old} → ${req.body?.new}`,
  } : null),
});

/* ───── agrupaciones de insumos ─────
   Crear, renombrar, borrar, mover y discontinuar ya dejan el aviso propio desde la pantalla
   (con su «Deshacer»): acá solo le llega al resto del equipo (conAutor: false). */
A.grupoCrear = avisoAbm({
  armar: (req, b) => ({
    type: 'insumo_group', title: `Agrupación de insumos nueva: ${b.data?.nombre || req.body?.nombre}`,
    metadata: { groupId: b.data?.id }, conAutor: false,
  }),
});
A.grupoCrearOMover = avisoAbm({
  // misma búsqueda que el controlador (negocio + nombre exacto): si ya existía, es un movimiento
  antes: (req) => uno('SELECT id FROM insumo_groups WHERE business_id = $1 AND nombre = $2 LIMIT 1',
    [getBusinessId(req), String(req.body?.nombre || '').trim()]),
  armar: (req, b, previo) => {
    const n = ids(req.body?.ids).length;
    const nombre = String(req.body?.nombre || '').trim();
    return {
      type: previo ? 'insumo_move' : 'insumo_group',
      title: previo ? `${cant(n, 'insumo movido', 'insumos movidos')} a ${nombre}` : `Agrupación de insumos nueva: ${nombre}`,
      message: previo ? null : (n ? `Con ${cant(n, 'insumo', 'insumos')}` : null),
      metadata: { ids: ids(req.body?.ids).slice(0, 200) }, conAutor: false,
    };
  },
});
A.grupoEditar = avisoAbm({
  antes: (req) => uno('SELECT nombre, es_favorita FROM insumo_groups WHERE id = $1', [Number(req.params.id)]),
  armar: (req, b, a) => {
    const d = b.data;
    if (!a || !d) return null;
    if (a.nombre !== d.nombre) return { type: 'insumo_group', title: `Agrupación renombrada: ${a.nombre} → ${d.nombre}`, metadata: { groupId: d.id }, conAutor: false };
    if (!!a.es_favorita !== !!d.es_favorita) return { type: 'insumo_group', title: `${d.es_favorita ? 'Agrupación favorita' : 'Ya no es favorita'}: ${d.nombre}`, metadata: { groupId: d.id } };
    return null;
  },
});
A.grupoBorrar = avisoAbm({
  antes: (req) => uno('SELECT nombre FROM insumo_groups WHERE id = $1', [Number(req.params.id)]),
  armar: (req, b, a) => ({ type: 'insumo_group', title: `Agrupación de insumos borrada: ${a?.nombre || req.params.id}`, conAutor: false }),
});
A.grupoAgregarUno = avisoAbm({
  armar: async (req) => {
    const g = await nomGrupo(req.params.id); const ins = await nomIns(req.body?.insumoId);
    const disc = esDiscontinuados(g);
    return {
      type: disc ? 'discontinue' : 'insumo_move',
      title: disc ? `Insumo discontinuado: ${ins}` : `Insumo movido a ${g}: ${ins}`,
      metadata: { ids: [Number(req.body?.insumoId)] }, conAutor: false,
    };
  },
});
A.grupoAgregarVarios = avisoAbm({
  armar: async (req, b) => {
    const n = b.added ?? ids(req.body?.insumoIds).length;
    if (!n) return null;
    const g = await nomGrupo(req.params.id); const disc = esDiscontinuados(g);
    return {
      type: disc ? 'discontinue' : 'insumo_move',
      title: disc ? `${cant(n, 'insumo discontinuado', 'insumos discontinuados')}` : `${cant(n, 'insumo movido', 'insumos movidos')} a ${g}`,
      metadata: { ids: ids(req.body?.insumoIds).slice(0, 200) }, conAutor: false,
    };
  },
});
A.grupoQuitarUno = avisoAbm({
  armar: async (req, b) => {
    if (b.removed === 0) return null;
    const g = await nomGrupo(req.params.id); const ins = await nomIns(req.params.insumoId);
    const disc = esDiscontinuados(g);
    return {
      type: disc ? 'discontinue' : 'insumo_move',
      title: disc ? `Insumo reactivado: ${ins}` : `Insumo sacado de ${g}: ${ins}`,
      metadata: { ids: [Number(req.params.insumoId)] }, conAutor: false,
    };
  },
});
A.grupoReemplazarItems = avisoAbm({
  armar: async (req) => ({
    type: 'insumo_group', title: `Agrupación ${await nomGrupo(req.params.id)}: insumos actualizados`,
    message: cant(ids(req.body?.insumoIds).length, 'insumo', 'insumos'),
  }),
});
A.grupoExcluir = avisoAbm({
  armar: async (req, b) => (b.count ? {
    type: 'insumo_group', title: `Agrupación ${await nomGrupo(req.params.id)}: ${cant(b.count, 'exclusión nueva', 'exclusiones nuevas')}`,
  } : null),
});
A.grupoQuitarExclusion = avisoAbm({
  armar: async (req, b) => (b.deleted ? {
    type: 'insumo_group', title: `Agrupación ${await nomGrupo(req.params.id)}: ${cant(b.deleted, 'exclusión quitada', 'exclusiones quitadas')}`,
  } : null),
});
A.grupoRegla = avisoAbm({
  armar: async (req) => ({
    type: 'insumo_group', title: `Regla: rubro ${req.body?.rubro_codigo} → ${await nomGrupo(req.body?.group_id)}`,
    message: 'Los insumos nuevos de ese rubro entran solos en la agrupación',
  }),
});

/* ───── mermas ───── */
A.mermaCrear = avisoAbm({
  armar: async (req, b) => ({
    type: 'insumo_merma', title: `Merma nueva en ${await nomIns(req.params.id)}: ${b.data?.nombre || req.body?.nombre || ''}`.trim(),
    message: req.body?.peso_inicial && req.body?.peso_final ? `${req.body.peso_inicial} → ${req.body.peso_final}` : null,
    metadata: { ids: [Number(req.params.id)] },
  }),
});
A.mermaEditar = avisoAbm({
  armar: async (req, b) => ({
    type: 'insumo_merma', title: `Merma editada en ${await nomIns(req.params.id)}: ${b.data?.nombre || (await nomMerma(req.params.mermaId)) || ''}`.trim(),
    metadata: { ids: [Number(req.params.id)] },
    clave: `insumo_merma:${req.params.mermaId}:${req.user?.id || 0}`,
  }),
});
A.mermaBorrar = avisoAbm({
  antes: (req) => nomMerma(req.params.mermaId),
  armar: async (req, b, nombre) => ({
    type: 'insumo_merma', title: `Merma borrada en ${await nomIns(req.params.id)}${nombre ? `: ${nombre}` : ''}`,
    metadata: { ids: [Number(req.params.id)] },
  }),
});
A.mermaAplicar = avisoAbm({
  armar: async (req, b) => (b.recetasAfectadas ? {
    type: 'insumo_merma', title: `Merma aplicada: ${await nomIns(req.params.id)}`,
    message: `${(await nomMerma(req.params.mermaId)) || 'Merma'} · ${cant(b.recetasAfectadas, 'receta', 'recetas')}`,
    metadata: { ids: [Number(req.params.id)] },
  } : null),
});

/* ───── equivalencias ───── */
A.eqCrear = avisoAbm({
  armar: async (req, b) => ({
    type: 'insumo_equivalencia', title: `Equivalencia nueva en ${await nomIns(req.params.id)}: ${b.data?.nombre || req.body?.nombre || ''}`.trim(),
    message: req.body?.contenido ? `${req.body.contenido} ${req.body.unidad || ''}`.trim() : null,
    metadata: { ids: [Number(req.params.id)] },
  }),
});
A.eqEditar = avisoAbm({
  armar: async (req, b) => (b.data ? {
    type: 'insumo_equivalencia', title: `Equivalencia editada en ${await nomIns(req.params.id)}: ${b.data.nombre}`,
    metadata: { ids: [Number(req.params.id)] },
    clave: `insumo_eq:${req.params.eqId}:${req.user?.id || 0}`,
  } : null),
});
A.eqAplicar = avisoAbm({
  armar: async (req, b) => (b.aplicados ? {
    type: 'insumo_equivalencia', title: `Equivalencia aplicada: ${await nomIns(req.params.id)}`,
    message: `${(await nomEq(req.params.eqId)) || 'Equivalencia'} · ${cant(b.aplicados, 'receta', 'recetas')}`,
    metadata: { ids: [Number(req.params.id)] },
  } : null),
});
A.eqBorrar = avisoAbm({
  antes: (req) => nomEq(req.params.eqId),
  armar: async (req, b, nombre) => ({
    type: 'insumo_equivalencia', title: `Equivalencia borrada en ${await nomIns(req.params.id)}${nombre ? `: ${nombre}` : ''}`,
    metadata: { ids: [Number(req.params.id)] },
  }),
});

/* ───── bonificación ───── */
A.bonifAplicar = avisoAbm({
  armar: async (req, b) => ({
    type: 'insumo_bonificacion', title: `Bonificación aplicada: ${await nomIns(req.params.id)}`,
    message: b.costo_real != null ? `Costo real ${b.costo_real}${b.facturadas && b.recibidas ? ` · ${b.facturadas} facturadas / ${b.recibidas} recibidas` : ''}` : null,
    metadata: { ids: [Number(req.params.id)] },
  }),
});
A.bonifDescartar = avisoAbm({
  armar: async (req) => ({
    type: 'insumo_bonificacion', title: `Bonificación descartada: ${await nomIns(req.params.id)}`,
    metadata: { ids: [Number(req.params.id)] },
  }),
});

/* ───── uso del insumo en recetas (desde la ficha del insumo) ───── */
A.usoMerma = avisoAbm({
  armar: async (req) => ({
    type: 'insumo_uso', title: `${await nomIns(req.params.id)}: merma cambiada en una receta`,
    metadata: { ids: [Number(req.params.id)] },
    clave: `insumo_uso:${req.params.id}:${req.user?.id || 0}`,
  }),
});
A.usoCantidad = avisoAbm({
  armar: async (req, b) => ({
    type: 'insumo_uso', title: `${await nomIns(req.params.id)}: cantidad cambiada en una receta`,
    message: b.cantidad != null ? `Ahora ${b.cantidad}` : null,
    metadata: { ids: [Number(req.params.id)] },
    clave: `insumo_uso:${req.params.id}:${req.user?.id || 0}`,
  }),
});
A.usoQuitar = avisoAbm({
  armar: async (req, b) => (b.removed ? {
    type: 'insumo_uso', title: `${await nomIns(req.params.id)} quitado de ${cant(b.recetasAfectadas || b.removed, 'receta', 'recetas')}`,
    metadata: { ids: [Number(req.params.id)] },
  } : null),
});

module.exports = A;
