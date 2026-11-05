// Portado de lazarillo_gestion/lib/facturas/leer.ts (TypeScript → JavaScript, misma lógica).
'use strict';



// Ver / editar una factura (Etapa 4, punto 3): una factura —de MaxiRest o cargada
// en Lazarillo— se rearma con el MISMO formato del modal de carga a partir de sus
// filas del 14 (compras) y sus líneas del 25 (detalle_compras). Si fue cargada en
// Lazarillo y tenemos lo que se cargó (facturas_lazarillo.payload), se usa eso.

// Conceptos de caja de percepción (los mismos que usa armar.ts / gen14).
const PERCEPCION_DE = { "133": "Perc. IVA RG 3337", "899": "Perc. IIBB PBA", "137": "Perc. Ganancias" };

function tipoDeComprobante(comprobante) {
  const c = comprobante.toUpperCase();
  if (c.startsWith("NC")) return "NC-A";
  if (c.startsWith("A")) return "FcA";
  if (c.startsWith("B")) return "FcB";
  if (c.startsWith("C")) return "FcC";
  return "Ticket";
}

const r2 = (n) => Math.round(n * 100) / 100;
const iso = (f) => (f == null ? "" : typeof f === "string" ? f.slice(0, 10) : f.toISOString().slice(0, 10));

function facturaDesdeFilas(
  proveedorId,
  filas,
  lineas,
) {
  const base = filas[0];
  const digitos = base.comprobante.replace(/\D/g, "").padStart(12, "0").slice(-12);
  const filaDe = new Map(filas.map((f) => [f.rowId, f]));
  const principal = [...filas].filter((f) => !PERCEPCION_DE[f.codCga ?? ""]).sort((a, b) => Math.abs(b.importe) - Math.abs(a.importe))[0] ?? base;
  const pdvDe = (l) => (l.compraId ? filaDe.get(l.compraId)?.puntoDeVentaId : null) ?? principal.puntoDeVentaId ?? 0;

  let registros;
  let estimado = false;
  if (lineas.length) {
    registros = lineas.map((l) => {
      const esInsumo = !!l.medida?.trim();
      const concepto = l.codCga?.trim() || (l.compraId ? filaDe.get(l.compraId)?.codCga : null) || principal.codCga || "";
      return {
        tipo: esInsumo ? "insumo": "concepto",
        conceptoCodigo: concepto,
        insumoCodigo: esInsumo ? l.codigo?.trim() ?? null : null,
        nombre: (l.nombre ?? "").trim() || concepto,
        medida: esInsumo ? l.medida.trim() : null,
        cantidad: esInsumo ? Math.abs(l.cantidad ?? 0) || null : null,
        neto: r2(Math.abs(l.totalIns ?? 0)),
        alicuota: Number(l.tasa ?? 0),
        impInt: r2(Math.abs(l.impNtTot ?? 0)),
        puntoDeVentaId: pdvDe(l),
        reparto: null,
      };
    });
  } else {
    // Sin detalle del 25: una línea por concepto con el importe del 14 (IVA estimado al 21%,
    // igual que el prototipo).
    estimado = true;
    registros = filas.filter((f) => !PERCEPCION_DE[f.codCga ?? ""]).map((f) => {
      const imp = Math.abs(f.importe) - Math.abs(f.impInt);
      return {
        tipo: "concepto",
        conceptoCodigo: f.codCga ?? "",
        insumoCodigo: null,
        nombre: f.codCga ?? "",
        medida: null,
        cantidad: null,
        neto: r2(imp / 1.21),
        alicuota: 21,
        impInt: r2(Math.abs(f.impInt)),
        puntoDeVentaId: f.puntoDeVentaId ?? 0,
        reparto: null,
      };
    });
  }

  const perc = new Map ();
  for (const f of filas) {
    const t = PERCEPCION_DE[f.codCga ?? ""];
    if (t) perc.set(t, r2((perc.get(t) ?? 0) + Math.abs(f.importe)));
  }

  return {
    factura: {
      proveedorId,
      tipo: tipoDeComprobante(base.comprobante),
      prefijo: digitos.slice(0, 4),
      numero: digitos.slice(4),
      fecha: iso(base.fecha),
      observacion: base.observac?.trim() || null,
      registros,
      percepciones: [...perc.entries()].map(([tipo, importe]) => ({ tipo, importe })),
      impIntGeneral: 0,
    },
    estimado,
    totalFilas: r2(filas.reduce((a, f) => a + f.importe, 0)),
  };
}

module.exports = { tipoDeComprobante, facturaDesdeFilas };
