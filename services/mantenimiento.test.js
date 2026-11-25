'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { _puros: m } = require('./mantenimiento');

test('siguienteFecha: días, semanas y meses', () => {
  assert.equal(m.siguienteFecha('2026-11-21', 3, 'dias'), '2026-11-24');
  assert.equal(m.siguienteFecha('2026-11-21', 2, 'semanas'), '2026-12-05');
  assert.equal(m.siguienteFecha('2026-11-21', 1, 'meses'), '2026-12-21');
  assert.equal(m.siguienteFecha('2026-01-31', 1, 'meses'), '2026-02-28'); // no salta a marzo
  assert.equal(m.siguienteFecha('2026-12-15', 3, 'meses'), '2027-03-15');
});

test('ajustarDia: corre al primer día permitido (lunes a viernes)', () => {
  const habiles = [1, 2, 3, 4, 5];
  assert.equal(m.ajustarDia('2026-11-21', habiles), '2026-11-23'); // sábado → lunes
  assert.equal(m.ajustarDia('2026-11-24', habiles), '2026-11-24'); // martes queda
  assert.equal(m.ajustarDia('2026-11-21', null), '2026-11-21');
  assert.equal(m.siguienteFecha('2026-11-20', 1, 'semanas', habiles), '2026-11-27'); // viernes → viernes
  assert.equal(m.siguienteFecha('2026-11-20', 1, 'dias', habiles), '2026-11-23');    // viernes + 1 = sábado → lunes
});

test('textoFrecuencia', () => {
  assert.equal(m.textoFrecuencia(1, 'meses'), 'Cada mes');
  assert.equal(m.textoFrecuencia(3, 'semanas'), 'Cada 3 semanas');
});

test('cambiosEquipo: detecta antes -> después y marca precio como esPlata', () => {
  const antes = { nombre: 'Heladera 3p', rubro: 'heladera', estado: 'activo', ubicacion: 'Cocina', precio: 500000 };
  const despues = { nombre: 'Heladera mostrador 3p', rubro: 'heladera', estado: 'en_reparacion', ubicacion: 'Línea fría', precio: 550000 };
  const cambios = m.cambiosEquipo(antes, despues);
  assert.equal(cambios.length, 4);
  assert.deepEqual(cambios.find((x) => x.campo === 'nombre'), {
    campo: 'nombre', label: 'Nombre', antes: 'Heladera 3p', despues: 'Heladera mostrador 3p',
  });
  assert.deepEqual(cambios.find((x) => x.campo === 'estado'), {
    campo: 'estado', label: 'Estado', antes: 'Activo', despues: 'En reparación',
  });
  assert.equal(cambios.find((x) => x.campo === 'precio')?.esPlata, true);
});

test('calcularResumenGasto: suma compra + arreglos hechos y últimos 12 meses', () => {
  const ahora = new Date('2026-11-25T12:00:00Z');
  const equipo = { precio: 1000000, fecha_compra: '2025-01-10' }; // compra hace > 12 meses
  const ordenes = [
    { estado: 'hecha', costo: 45000, hecha_at: '2026-11-10T10:00:00Z' },
    { estado: 'hecha', costo: 30000, hecha_at: '2025-05-01T10:00:00Z' }, // > 12 meses
    { estado: 'pendiente', costo: 90000, fecha: '2026-11-20' }, // pendiente no suma
  ];
  const r = m.calcularResumenGasto(equipo, ordenes, ahora);
  assert.equal(r.precio_compra, 1000000);
  assert.equal(r.arreglos_total, 75000);
  assert.equal(r.total_gastado, 1075000);
  assert.equal(r.ultimos_12_meses, 45000);
  assert.equal(r.ordenes_con_costo, 2);
});

test('formatoEquipo, formatoOrden y formatoEvento: sin costo ni precio para jefe o cocinero', () => {
  const eq = m.formatoEquipo({ id: 1, nombre: 'Freidora', rubro: 'freidora', estado: 'activo', precio: 800000 }, { gestor: false });
  assert.equal('precio' in eq, false);
  const eqDueno = m.formatoEquipo({ id: 1, nombre: 'Freidora', rubro: 'freidora', estado: 'activo', precio: 800000 }, { gestor: true });
  assert.equal(eqDueno.precio, 800000);

  const ordJefe = m.formatoOrden({ id: 2, equipo_id: 1, estado: 'hecha', costo: 25000, proveedor: 'Técnico' }, { gestor: false, planifica: true, uid: 10 });
  assert.equal('costo' in ordJefe, false);
  const ordDueno = m.formatoOrden({ id: 2, equipo_id: 1, estado: 'hecha', costo: 25000, proveedor: 'Técnico' }, { gestor: true, planifica: true, uid: 10 });
  assert.equal(ordDueno.costo, 25000);

  // Un evento que solo cambió el precio no aparece para el jefe
  const evSoloPrecio = m.formatoEvento({
    id: 3, equipo_id: 1, tipo: 'equipo_edit',
    detalle: { cambios: [{ campo: 'precio', label: 'Precio de compra', antes: '100', despues: '200', esPlata: true }] },
  }, { gestor: false });
  assert.equal(evSoloPrecio, null);
});
