// Portado de lazarillo_gestion/lib/arca/clasificar.ts (TypeScript → JavaScript, misma lógica).
'use strict';

// Cruce ARCA × Panel (Diego 28/10/2026). Puro: recibe los comprobantes de ARCA con lo que hay
// cargado con el mismo CUIT + punto de venta + número, y las compras de esos proveedores que
// no coinciden con ningún comprobante de ARCA; devuelve lo que falta cargar y lo que hay que
// corregir. Validado contra el CSV real de 2025 (ver scratchpad del 28/10).

/** ARCA es de la empresa, no de un PDV: sus descartes ("no va", "está bien") van con pdvId 0. */
const PDV_ARCA = 0;

const dias = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
const $ = (n) => "$ " + Math.round(n).toLocaleString("es-AR");
// El total del Panel puede no traer la percepción (el 14 de 2025 no la tenía): vale igual.
const igual = (panel, a, tol = 2) => Math.abs(Math.abs(panel) - a.total) <= tol || Math.abs(Math.abs(panel) - (a.total - a.otros)) <= tol;

function clasificar(arca, sinPar) {
  const faltan = [];
  const corregir = [];
  let ok = 0;
  const usados = new Set ();
  for (const a of arca) {
    if (!a.cargados.length) { faltan.push(a); continue; }
    const porLocal = new Map ();
    for (const c of a.cargados) porLocal.set(c.localId, [...(porLocal.get(c.localId) ?? []), c]);
    let problema = null;
    for (const cs of porLocal.values()) {
      const nombres = new Set(cs.map((c) => c.comprobante));
      const suma = cs.reduce((s, c) => s + c.total, 0);
      // El mismo número cargado dos veces en el mismo local ("A…" y "FCA…"): duplicado.
      if (nombres.size > 1 && igual(suma / 2, a)) {
        problema = { motivo: "duplicado", arca: a, panel: cs[0], detalle: `cargada 2 veces: ${[...nombres].join(" y ")}` };
        break;
      }
    }
    if (!problema) {
      const totales = [...porLocal.values()].map((cs) => cs.reduce((s, c) => s + c.total, 0));
      // Repartida en 2 locales (IVA compensación) vale si alguno coincide.
      if (!totales.some((t) => igual(t, a)) && a.total > 0) {
        const t = totales[0];
        if (Math.abs(Math.abs(t) - a.total) > Math.max(2, a.total * 0.01)) {
          problema = { motivo: "importe", arca: a, panel: a.cargados[0], detalle: `ARCA ${$(a.total)} · cargada ${$(Math.abs(t))}` };
        }
      }
    }
    if (!problema) {
      const c = a.cargados[0];
      if (dias(c.fecha, a.fecha) > 3) problema = { motivo: "fecha", arca: a, panel: c, detalle: `ARCA ${a.fecha.split("-").reverse().join("/")} · cargada ${c.fecha.split("-").reverse().join("/")}` };
    }
    if (problema) corregir.push(problema); else ok++;
  }
  // Faltantes que parecen cargados con OTRO número: mismo proveedor, mismo importe, fecha cerca.
  const quedan = [];
  for (const a of faltan) {
    const par = sinPar.find((s) => s.cuit === a.cuit && !usados.has(s.rowId) && igual(s.total, a) && dias(s.fecha, a.fecha) <= 20);
    if (par) {
      usados.add(par.rowId);
      corregir.push({ motivo: "numero", arca: a, panel: par, detalle: `en ARCA Nº ${a.puntoVenta}-${a.numero} · cargada como ${par.comprobante}` });
    } else quedan.push(a);
  }
  // Factura + nota de crédito del mismo proveedor por el mismo importe, ninguna cargada: se anulan
  // entre sí y no se muestran para cargar (Diego 28/10: "mismo importe, no cuentan").
  const sinAnuladas = sacarAnuladas(quedan);
  return { ok, faltan: sinAnuladas.faltan, corregir, anuladasEntreSi: sinAnuladas.anuladas };
}

/** Empareja FC con NC sin cargar: mismo CUIT, mismo total (±$1) y a 60 días o menos. */
function sacarAnuladas(lista) {
  const ncs = lista.filter((a) => a.nc);
  const usadas = new Set ();
  const anuladas = [];
  for (const nc of ncs) {
    const fc = lista
      .filter((a) => !a.nc && !usadas.has(a.key) && a.cuit === nc.cuit && Math.abs(a.total - nc.total) <= 1 && dias(a.fecha, nc.fecha) <= 60)
      .sort((x, y) => dias(x.fecha, nc.fecha) - dias(y.fecha, nc.fecha))[0];
    if (!fc) continue;
    usadas.add(fc.key); usadas.add(nc.key);
    anuladas.push([fc, nc]);
  }
  return { faltan: lista.filter((a) => !usadas.has(a.key)), anuladas };
}

module.exports = { PDV_ARCA, clasificar, sacarAnuladas };
