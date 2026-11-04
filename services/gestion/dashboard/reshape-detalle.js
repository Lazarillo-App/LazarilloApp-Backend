// Portado de lazarillo_gestion/lib/dashboard/reshape-detalle.ts (TypeScript → JavaScript, misma lógica).
'use strict';



function reshapeDetalle(r) {
  return {
    rowId: r.rowId,
    // distribucionId: null cuando la compra no está distribuida (100% de los
    // casos hasta que exista una regla activa — Fase B no la puede crear sin
    // pasar por la API, ver Task 9). rowId se mantiene SIEMPRE como el de la
    // compra original (no un compuesto) — compra-lineas/[compraId] y el
    // endpoint puntual de compras/[rowId] siguen necesitando el rowId real
    // para funcionar. Fase C es quien debe usar `distribucionId ?? rowId`
    // como key de UI una vez que existan filas distribuidas (riesgo anotado
    // en la sección 4 del diseño, "Riesgo para Fase C").
    distribucionId: r.distribucionId,
    esDistribuido: r.esDistribuido,
    fecha: r.fecha,
    importe: r.importe,
    importeBase: r.importeBase,
    importeManual: r.importeManual,
    fechaManual: r.fechaManual,
    fechaVista: r.fechaVista,
    importeVista: r.importeVista,
    pagoRef: r.pagoRef,
    fechaGasto: r.fechaGasto,
    fechaPago: r.fechaPago,
    cajaPago: r.cajaPago,
    conceptoCodigoManual: r.conceptoCodigoManual,
    concepto: r.concepto,
    detalle: r.detalle,
    observac: r.observac,
    observacManual: r.observacManual,
    obsInsumos: r.obsInsumos ?? null,
    proveedor: r.proveedorTexto,
    proveedorRef: r.proveedorId != null ? { id: r.proveedorId, nombre: r.proveedorNombre, razon: r.proveedorRazon } : null,
    local: r.localNombre != null ? { nombre: r.localNombre } : null,
    puntoDeVenta: r.pdvNombre != null ? { nombre: r.pdvNombre } : null,
    comprobante: r.comprobante,
    codigoProveedor: r.codigoProveedor,
    pdvCompraId: r.pdvCompraId,
    localIdOrigen: r.localIdOrigen,
    puntoDeVentaIdOrigen: r.puntoDeVentaIdOrigen,
    conceptoCaja:
      r.conceptoCajaCodigo != null
        ? { codigo: r.conceptoCajaCodigo, nombre: r.conceptoCajaNombre, rubro: r.conceptoCajaRubroNombre != null ? { nombre: r.conceptoCajaRubroNombre } : null }
        : null,
    conceptoCajaManual:
      r.conceptoCajaManualCodigo != null
        ? {
            codigo: r.conceptoCajaManualCodigo,
            nombre: r.conceptoCajaManualNombre,
            rubro: r.conceptoCajaManualRubroNombre != null ? { nombre: r.conceptoCajaManualRubroNombre } : null,
          }
        : null,
  };
}

module.exports = { reshapeDetalle };
