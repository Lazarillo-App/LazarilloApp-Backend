// Fudo → artículos, insumos, recetas y compras (17/11/2026): lo puro, con datos iguales a los de la
// cuenta demo (verificados por la API ese día).
const test = require('node:test');
const assert = require('node:assert');
const M = require('./fudoMaestros');
const { _normalizarTraer } = require('./fudoService');

const pagina = (data, included = []) => [{ data, included }];

test('rubro y subrubro de las categorías de producto (con y sin categoría padre)', () => {
  const r = M._rubrosDeCategorias([
    { id: '5', attributes: { name: 'Cafetería' }, relationships: { parentCategory: { data: null } } },
    { id: '9', attributes: { name: 'Espresso' }, relationships: { parentCategory: { data: { type: 'ProductCategory', id: '5' } } } },
  ]);
  assert.deepStrictEqual(r.get('5'), { rubro: 'Cafetería', subrubro: null });
  assert.deepStrictEqual(r.get('9'), { rubro: 'Cafetería', subrubro: 'Espresso' });
});

test('producto → artículo: el número de Fudo es el código; sin categoría queda «Sin categoría»', () => {
  const rub = new Map([['5', { rubro: 'Cafetería', subrubro: null }]]);
  const a = M._articuloDeProducto({ id: '12', attributes: { name: ' Café doble ', price: 5000, active: true, code: null },
    relationships: { productCategory: { data: { type: 'ProductCategory', id: '5' } } } }, rub);
  assert.deepStrictEqual(a, { fudo_id: '12', articulo_id: 12, nombre: 'Café doble', categoria: 'Cafetería', subrubro: 'Sin subrubro', precio: 5000, activo: true, codigo: null });
  assert.strictEqual(M._articuloDeProducto({ id: '13', attributes: { name: 'X' }, relationships: {} }, rub).categoria, 'Sin categoría');
  assert.strictEqual(M._articuloDeProducto({ id: 'abc', attributes: { name: 'X' } }, rub), null);
});

test('ingrediente → insumo con rubro, unidad y costo; receta de un producto', () => {
  const pags = pagina(
    [{ type: 'Ingredient', id: '5', attributes: { name: 'Lechuga', cost: 3000 },
      relationships: { ingredientCategory: { data: { type: 'IngredientCategory', id: '3' } }, unit: { data: { type: 'Unit', id: '2' } } } }],
    [{ type: 'IngredientCategory', id: '3', attributes: { name: 'Verduleria' } }, { type: 'Unit', id: '2', attributes: { name: 'kg' } }]
  );
  const buscar = M._indice(pags);
  assert.deepStrictEqual(M._insumoDeIngrediente(pags[0].data[0], buscar), { fudo_id: '5', nombre: 'Lechuga', categoria: 'Verduleria', unidad: 'kg', costo: 3000 });

  const prod = pagina(
    [{ type: 'Product', id: '70', attributes: { name: 'Caesar' }, relationships: { proportions: { data: [{ type: 'Proportion', id: '5' }, { type: 'Proportion', id: '6' }] } } }],
    [
      { type: 'Proportion', id: '5', attributes: { amount: 0.2 }, relationships: { ingredient: { data: { type: 'Ingredient', id: '5' } } } },
      { type: 'Proportion', id: '6', attributes: { amount: 0 }, relationships: { ingredient: { data: { type: 'Ingredient', id: '4' } } } },
      { type: 'Ingredient', id: '5', attributes: { name: 'Lechuga' }, relationships: { unit: { data: { type: 'Unit', id: '2' } } } },
      { type: 'Unit', id: '2', attributes: { name: 'kg' } },
    ]
  );
  const r = M._recetaDeProducto(prod[0].data[0], M._indice(prod));
  assert.deepStrictEqual(r, { items: [{ fudo_ingrediente: '5', nombre: 'Lechuga', cantidad: 0.2, unidad: 'kg' }], hash: '5:0.2:kg' });
});

test('gasto → compra: renglón de mercadería con precio unitario, gasto suelto sin insumo, impuestos aparte', () => {
  const inc = [
    { type: 'ExpenseItem', id: '1', attributes: { detail: 'Lechuga', price: 75000, quantity: 25 }, relationships: { ingredient: { data: { type: 'Ingredient', id: '5' } } } },
    { type: 'Provider', id: '3', attributes: { name: 'Verduleria PRUEBA' } },
    { type: 'Provider', id: '4', attributes: { name: 'ALQUILER ' } },
    { type: 'ExpenseCategory', id: '19', attributes: { name: 'Alquiler' } },
    { type: 'CommercialDocument', id: '1', attributes: { seller: { taxIdNumber: '30-71234567-8' } } },
  ];
  const b = M._indice(pagina([], inc));
  const lechuga = M._facturaDeGasto({ id: '1', attributes: { amount: 80000, date: '2026-11-17', receiptNumber: '0' },
    relationships: { provider: { data: { type: 'Provider', id: '3' } }, commercialDocument: { data: { type: 'CommercialDocument', id: '1' } },
      expenseItems: { data: [{ type: 'ExpenseItem', id: '1' }] } } }, b);
  assert.strictEqual(lechuga.numero, 'FUDO-1');
  assert.strictEqual(lechuga.proveedor, M.PROVEEDOR_BASE + 3);
  assert.strictEqual(lechuga.cuit, '30712345678');
  assert.strictEqual(lechuga.comprobante, null);
  assert.deepStrictEqual(lechuga.items[0], { insumo: 5, fecha: '2026-11-17', cantidad: 25, neto: 3000, precio: 3000, preciotot: 75000, referencia: 'Lechuga' });
  assert.strictEqual(lechuga.items[1].preciotot, 5000); // impuestos: el total cuadra con Fudo
  assert.strictEqual(lechuga.items[1].insumo, null);

  const alquiler = M._facturaDeGasto({ id: '2', attributes: { amount: 250000, date: '2026-11-17' },
    relationships: { provider: { data: { type: 'Provider', id: '4' } }, expenseCategory: { data: { type: 'ExpenseCategory', id: '19' } }, expenseItems: { data: [] } } }, b);
  assert.deepStrictEqual(alquiler.items, [{ insumo: null, fecha: '2026-11-17', cantidad: 1, neto: 250000, precio: 250000, preciotot: 250000, referencia: 'Alquiler' }]);
  assert.strictEqual(alquiler.proveedorNombre, 'ALQUILER');

  assert.strictEqual(M._facturaDeGasto({ id: '3', attributes: { amount: 100, date: '2026-11-17', canceled: true }, relationships: {} }, b), null);
});

test('compra ya cargada en Lazarillo: mismo proveedor (CUIT o nombre) y fecha', () => {
  const f = { fecha: '2026-11-17', cuit: '30712345678', proveedorNombre: 'Verdulería Prueba' };
  assert.ok(M._yaCargada(f, [{ fecha: '2026-11-17', cuit: '30-71234567-8', nombre: 'Otro nombre' }]));
  assert.ok(M._yaCargada({ ...f, cuit: null }, [{ fecha: '2026-11-17', cuit: null, nombre: 'VERDULERIA PRUEBA' }]));
  assert.ok(!M._yaCargada(f, [{ fecha: '2026-11-16', cuit: '30712345678', nombre: 'Verdulería Prueba' }]));
  assert.ok(!M._yaCargada({ ...f, cuit: null }, [{ fecha: '2026-11-17', cuit: null, nombre: 'Carnicería' }]));
});

test('qué traer: las ventas no se pueden apagar; lo demás arranca prendido', () => {
  assert.deepStrictEqual(_normalizarTraer(null), { ventas: true, articulos: true, insumos: true, compras: true });
  assert.deepStrictEqual(_normalizarTraer({ ventas: false, compras: false, otra: 1 }), { ventas: true, articulos: true, insumos: true, compras: false });
});
