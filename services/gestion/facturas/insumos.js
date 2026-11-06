// Portado de lazarillo_gestion/lib/facturas/insumos.ts (TypeScript → JavaScript, misma lógica).
'use strict';



const norm = (s) => (s ?? "").trim().toUpperCase();

/** Unidades base que trae una medida de compra: 1 si es la unidad del insumo, el factor si es
 *  uno de sus envases (X8 → 8), null si no se sabe. */
function factorEnvase(ins, medida) {
  if (!ins || !norm(medida)) return null;
  if (norm(medida) === norm(ins.medida)) return 1;
  const e = ins.envases.find((x) => norm(x.envase) === norm(medida));
  return e ? e.factor : null;
}

// Insumos del modal de carga. El concepto de caja sale del RUBRO del insumo en
// MaxiRest (cada rubro de insumo tiene uno, Diego 27/10/2026); si el rubro no
// tiene, el de su última compra. Precio y alícuota: los de la última compra.
// Los discontinuados de MaxiRest no se ofrecen; los que solo están en el 25 sí.
function unirInsumos(maestro, comprados) {
  const compra = new Map(comprados.map((c) => [String(c.codigo).trim(), c]));
  const out = [];
  const vistos = new Set ();
  for (const m of maestro) {
    if (m.discontinuado) { vistos.add(m.codigo); continue; }
    const c = compra.get(m.codigo);
    // El último precio puede ser por envase (15.614 el X8): se pasa a la unidad del insumo.
    const f = c ? factorEnvase({ medida: m.medida ?? "", envases: m.envases }, c.medida) : null;
    const unitC = c?.unit != null ? (f && f > 1 ? Math.round((c.unit / f) * 100) / 100 : c.unit) : null;
    // Impuesto interno por unidad de la última compra (también por envase en el 25): a la unidad del insumo.
    const iiC = c?.ii > 0 ? (f && f > 1 ? Math.round((c.ii / f) * 10000) / 10000 : c.ii) : null;
    out.push({
      codigo: m.codigo,
      nombre: m.nombre,
      medida: m.medida ?? c?.medida?.trim() ?? "",
      codCga: m.codCga ?? c?.codCga?.trim() ?? null,
      rubro: m.rubro,
      unit: unitC ?? m.precio,
      alic: c?.alic ?? null,
      ii: iiC,
      envases: m.envases,
    });
    vistos.add(m.codigo);
  }
  for (const c of comprados) {
    const cod = String(c.codigo).trim();
    if (vistos.has(cod)) continue;
    out.push({ codigo: cod, nombre: c.nombre.trim(), medida: c.medida.trim(), codCga: c.codCga?.trim() || null, rubro: null, unit: c.unit, alic: c.alic, ii: c.ii > 0 ? c.ii : null, envases: [] });
  }
  // Nombres repetidos (el modal elige por nombre): se agrega el código al segundo.
  const cuenta = new Map ();
  for (const i of out) cuenta.set(i.nombre, (cuenta.get(i.nombre) ?? 0) + 1);
  return out
    .map((i) => (cuenta.get(i.nombre) > 1 ? { ...i, nombre: `${i.nombre} (${i.codigo})` } : i))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

module.exports = { factorEnvase, unirInsumos };
