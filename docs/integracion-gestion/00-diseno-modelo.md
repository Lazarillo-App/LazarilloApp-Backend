# Integración de lazarillo_gestion — diseño del modelo de datos

> Estado: **BORRADOR para aprobar** (2026-11-02). No hay nada creado en la base todavía.
> Reemplaza al borrador del 2026-10-30 (tablas nuevas alimentadas por el pipeline), descartado.

## Reglas que fija este diseño

1. **Una base (Render), un servicio (este Backend), un lenguaje (JavaScript).** Supabase y Vercel se eliminan al final.
2. **La estructura de gestion se conserva:** mismas tablas, columnas, cálculos y reglas. Funciona bien; no se rediseña.
3. **Multi-cliente con el modelo actual de Lazarillo:** organización → negocios/subnegocios → sucursales.
   El dato pertenece al **negocio** (`business_id`); la **sucursal** (`branch_id`, NULL = principal) es un filtro
   dentro del negocio. Cambiar de negocio activo cambia todo lo que se ve. Muy poco es general de la organización.
4. **Aislamiento entre clientes en dos capas:** cada consulta filtra por el negocio activo (como hoy), y además
   RLS en la base, que devuelve vacío si alguna consulta se olvida el filtro.

## Qué cambia respecto de gestion (y nada más)

| En gestion | En Lazarillo |
|---|---|
| Una instalación por cliente | Un solo juego de tablas `gestion_*` para todos los clientes |
| `locales` + `puntos_de_venta` | **Desaparecen.** Se usan `app_businesses` + `app_branches` |
| `localId` / `puntoDeVentaId` / `pdvId` en cada tabla | `business_id` + `branch_id` |
| Claves únicas globales (`codigo @unique`, etc.) | Las mismas claves, **por negocio** (`UNIQUE (business_id, codigo)`) |
| `rowId` como PK | PK `(business_id, row_id)` — el hash de identidad no cambia |
| Login de Supabase + allowlist de emails | Nuestro login + `requireBusinessAccess` + owner/admin |
| Lectura nocturna de Render vía Vercel cron | Job del Backend, misma lógica |
| Vista de "Local" (Ramos Mejía = Bar + Canchas) | No existe; filtros = negocio y sucursal |

Nombres: tablas con prefijo `gestion_` (no chocan con `purchases`, `suppliers`, `sales_*`). Las columnas
propias de gestion **conservan su nombre exacto** (camelCase entre comillas: `"rowId"`, `"importeManual"`):
así sus ~160 consultas SQL se trasladan casi sin cambios, que es donde está el riesgo de la traducción.
Solo las columnas de tenencia nuevas (`organization_id`, `business_id`, `branch_id`) usan snake_case.

DDL: `db/migrations/gestion/001_estructura.sql` (sale de la estructura real de la base de gestion, no de
sus migraciones). Se aplica con `db/scripts/crear-tablas-gestion.js` (dry-run = crea todo y hace ROLLBACK).

## Tabla por tabla

**Leyenda de tenencia:** **N** = `business_id` NOT NULL · **N+S** = `business_id` + `branch_id` ·
**U** = por usuario · **G** = general de la organización (`organization_id`).

### Maestros: una sola lista por organización (decidido 2026-11-02)

Una organización nace de subdividir un negocio, así que comparte **una sola lista** de Maxi
(proveedores, conceptos, rubros, artículos): la del kit de esa organización. No se duplica por negocio.
Lo que se divide son los **datos** (compras, ventas, pagos…), que siempre se filtran por negocio y
sucursal: lo de Ramos no se ve en Canchas.

La lista es compartida, pero **cómo la ve cada negocio** sí es por negocio: qué rubros muestra el Panel
(hoy `visibleEnDashboard` / `visibleEnResultados` dentro del maestro) pasa a una tabla de visibilidad por
negocio, para que ocultar un rubro en el Bar no lo oculte en Canchas.

| gestion | Lazarillo | Ten. | Único |
|---|---|---|---|
| `rubros_concepto_caja` | `gestion_rubros_concepto_caja` | G | (organization_id, codigo) |
| ↳ columnas de visibilidad | `gestion_rubros_visibilidad` | N | (business_id, codigo) |
| `sin_rubro_config` (fila única id=1) | `gestion_sin_rubro_config` | N | (business_id) |
| `conceptos_caja` | `gestion_conceptos_caja` | G | (organization_id, codigo) |
| `rubros_articulo` | `gestion_rubros_articulo` | G | (organization_id, codigo) |
| `subrubros_articulo` | `gestion_subrubros_articulo` | G | (organization_id, codigo) |
| `articulos` (PK codigo) | `gestion_articulos` | G | PK (organization_id, codigo) |
| `proveedores` | `gestion_proveedores` | G | (organization_id, codigo) |
| `empleados` | `gestion_empleados` | N+S | (business_id, branch_id, codigo) |

Un negocio sin organización (los que no se subdividieron) usa su propia lista: el job de ingesta la carga
con la organización que le corresponda, o se le crea una al activarle el Panel (a definir en la fase de ingesta).

### Movimientos (ingesta diaria + históricos)

| gestion | Lazarillo | Ten. | Clave |
|---|---|---|---|
| `compras` | `gestion_compras` | N+S | PK (business_id, row_id) |
| `detalle_compras` (solo `localId`) | `gestion_detalle_compras` | N+S | PK (business_id, row_id) — la sucursal se toma de la compra enlazada |
| `pagos` | `gestion_pagos` | N+S | PK (business_id, row_id) |
| `ventas` | `gestion_ventas` | N+S | PK (business_id, row_id) |
| `compras_huerfanas` | `gestion_compras_huerfanas` | N+S | PK (business_id, row_id) |

### Cargado a mano

| gestion | Lazarillo | Ten. | Notas |
|---|---|---|---|
| `impagas_forzadas` | `gestion_impagas_forzadas` | N+S | único (business_id, branch_id, comprobante, cod_pro) |
| `medios_pago` | `gestion_medios_pago` | N | único (business_id, nombre) |
| `pagos_proveedor` (+ `aplicaciones_`, `eventos_`) | `gestion_pagos_proveedor`… | N+S | sucursal que paga / sucursal de la factura |
| `flujo_caja_manual` | `gestion_flujo_caja_manual` | N+S | único (business_id, branch_id, anio, mes) |
| `proyecciones_ingresos` (ámbito `"local/pdv"`) | `gestion_proyecciones_ingresos` | N+S | ámbito → business/branch; `*` = todo el negocio |
| `equilibrio_variables` | `gestion_equilibrio_variables` | N | PK (business_id, tipo, codigo) |
| `aumentos_precio` | `gestion_aumentos_precio` | N+S | PK (business_id, branch_id, fecha) |
| `sin_carga_descartes` | `gestion_sin_carga_descartes` | N+S | único (business_id, branch_id, clave) |
| `arca_comprobantes` | `gestion_arca_comprobantes` | N | único (business_id, cuit_emisor, tipo, punto_venta, numero) |
| `facturas_lazarillo` (solo `localId`) | `gestion_facturas_movil` | N+S | único (business_id, comprobante, codigo) |
| `liquidaciones_empleado` | `gestion_liquidaciones_empleado` | N+S | |
| `reglas_concepto_empleado` | `gestion_reglas_concepto_empleado` | N+S | |

### Lo que cruza negocios (lo poco que es general)

Son las únicas tablas donde una fila involucra **más de un negocio de la misma organización**.
Se guardan con `organization_id`, y cada negocio involucrado queda en su columna. Se validan en el
servidor: todos los negocios tienen que ser de la misma organización y el usuario tiene que tener acceso.

| gestion | Lazarillo | Ten. | Notas |
|---|---|---|---|
| `reglas_apertura` | `gestion_reglas_apertura` | G | origen = (business_id, branch_id) |
| `destinos_regla` | `gestion_destinos_regla` | G | cada destino = (business_id, branch_id) — puede ser otro negocio de la org |
| `distribuciones_apertura` | `gestion_distribuciones_apertura` | G | (compra_business_id, compra_row_id) + destino |
| `pagos_internos` (+ `eventos_`, `aplicaciones_`) | `gestion_pagos_internos`… | G | cobra / paga = (business_id, branch_id) cada uno |

Un usuario ve una de estas filas si tiene acceso a alguno de los negocios involucrados.

### Por usuario

| gestion | Lazarillo | Notas |
|---|---|---|
| `notas_usuario` (PK email) | `gestion_notas_usuario` | PK (user_id, business_id) |
| `user_drive_config` | `gestion_drive_config` | (user_id, business_id); se reconecta, no se migra |

### Lo que no pasa

- `locales`, `puntos_de_venta` → reemplazados por `app_businesses` / `app_branches`.
- `_prisma_migrations`, `_respaldo_*` → no son datos.

Se conservan (cambio respecto del primer borrador) porque el código de gestion depende de ellas:
`gestion_actividad` (su historial tiene "restaurar", que nuestro historial no tiene),
`gestion_import_logs`, `gestion_render_corridas`, y `gestion_render_origenes`, que pasa a ser la versión
en tabla de `services/maxiPdvMap.js`: un cliente nuevo se suma cargando filas, sin tocar código.

## RLS (segunda capa)

Cada request que toca tablas `gestion_*` corre en una transacción que fija los negocios a los que tiene
acceso el usuario (`SET LOCAL app.business_ids = '147,204'`). Cada tabla tiene una política
`business_id = ANY(current_setting('app.business_ids'))` (las tablas G, sobre las columnas de negocio
involucradas). Si una consulta se olvida el `WHERE business_id = …`, devuelve solo lo permitido, nunca
datos de otro cliente. El rol del Backend no es dueño de las tablas, así que RLS le aplica.

## Migración de Ramos y Comercio

Mapeo de PDV:

| Instancia | Local / PDV (id) | business_id | branch_id |
|---|---|---|---|
| Ramos | Ramos Mejía / Bar (1) | 147 | NULL |
| Ramos | Ramos Mejía / Canchas (2) | 204 | NULL |
| Ramos | San Justo / Canchas (3) | 204 | 15 |
| Comercio | Nuñez / Comercio (1) | 210 | NULL |

- Los maestros de la instancia Ramos se copian a **147 y a 204**; los de Comercio a 210.
- Las filas que hoy tienen `localId` sin `puntoDeVentaId` son ambiguas en Ramos Mejía (147 o 204). El
  script las resuelve por la compra enlazada y **lista las que no puede resolver**; nada se descarta en silencio.
- Script re-ejecutable, dry-run por defecto, con comparación de cantidades y sumas de importes por tabla,
  negocio y mes contra Supabase. Se corre hasta el corte final.

## Datos revisados (2026-11-02, instancia Ramos)

- `compras`, `pagos`, `ventas`: todas tienen PDV → negocio/sucursal directo, nada ambiguo.
- `detalle_compras`: 89.074 filas solo con `localId = 1` (Ramos Mejía). Se resuelven por `compraId`
  (enlace a su compra); el script lista las que no tengan enlace.
- `proyecciones_ingresos`: 17 de 64 son combinadas (`*/*` = toda la instancia, `1/*` = Bar + Canchas).
  No existe una vista que mezcle negocios → no se migran (son fotos que se recalculan). Las 47 por PDV sí.

## Pendientes

1. Organizaciones de 147/204 y 210 en `organizations` (para las tablas G).
2. Subnegocios por agrupación de artículos (ej. "agua cancha" movida a un subnegocio): las ventas de
   gestion (i22) son por comprobante/forma de cobro, sin artículo, así que no se pueden repartir así.
   Ramos/Canchas no tiene el problema (Canchas es su propio pdv en Maxi). Para clientes futuros con
   subnegocios dentro del mismo pdv, el Panel tendría que tomar ventas por artículo (i12). Definir antes
   de sumar ese tipo de cliente.
