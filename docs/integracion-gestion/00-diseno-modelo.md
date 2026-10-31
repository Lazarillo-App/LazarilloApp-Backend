# Integración de lazarillo_gestion — Fase 0: modelo de datos

> Estado: **BORRADOR para aprobar** (2026-10-30). Ninguna migración creada todavía.

## Objetivo

lazarillo_gestion (Next + Supabase, hecho por otro grupo) se da de baja. Su panel
financiero pasa a ser parte de Lazarillo: datos en la base única de Render, API en
este Backend y UI en agrupaciones-front (MUI). Acceso: owner/admin.

## Principio

| Tipo de dato | Ejemplos | Qué hacemos |
|---|---|---|
| **Derivado de Maxi** | compras/gastos, detalle, pagos, ventas, cta cte, nómina, maestros | **No se migra.** Se materializa desde `container`/`comercio` con el pipeline diario. |
| **Historial viejo** | gastos/ventas 2016–2024 (Ramos), 2021–2024 (Comercio) | Del kit si los informes lo traen; si no, import único desde gestion (`origen='gestion'`). Mismas tablas. |
| **Cargado a mano** | reglas de apertura, ajustes, pagos, ARCA, etc. | Se migra desde Supabase reenganchando por clave natural de Maxi. |
| **Calculado** | distribuciones de apertura, aumentos de precio, compras huérfanas | Se recalcula con el motor, no se migra. |

## Mapeo PDV → negocio / sucursal

| gestion (instancia / local / pdv) | Maxi `pdv` | Lazarillo |
|---|---|---|
| Ramos / Ramos Mejía / Bar | `BAR` | business 147 |
| Ramos / Ramos Mejía / Canchas | `FCRAMOS` | business 204, sucursal Ramos |
| Ramos / San Justo / Canchas | `FCSANJUSTO` | business 204, sucursal San Justo |
| Comercio / Nuñez / Comercio | `COMERCIO` | business 210 |

- Sucursales = `app_branches` (ya existe: mismos artículos/insumos, ventas y compras
  separadas por `branch_id`). Hay que confirmar en prod que 204 tenga sus 2 branches.
- `services/maxiPdvMap.js` pasa a `{ schema, businessId, branchId }` y suma `FCSANJUSTO`.
  **Ojo:** hoy San Justo ya sube datos y los pipelines existentes (compras i25, ventas i12)
  todavía lo ignoran.

Todas las tablas nuevas llevan `business_id` y, donde gestion usaba `puntoDeVentaId`,
`branch_id` (NULL = negocio sin sucursales).

## A. Tablas derivadas (pipeline diario)

Cada una: `business_id`, `branch_id`, `row_key` (identidad estable), columnas del informe,
`origen` (`'maxi'` | `'gestion'`), `synced_at`. Único `(business_id, row_key)`.

| Tabla | Fuente | Notas |
|---|---|---|
| `gestion_gastos` | `i14_gastos_compras_detallado_YYYY` | Base del Panel. Incluye gastos que no son insumos (por eso no alcanza `purchases`). `row_key` = mismo algoritmo que `compra-identity.ts` de gestion, para reenganchar ajustes. |
| `gestion_ventas_cobros` | `i22_ventas_detalladas_YYYY` | Ventas por comprobante y forma de cobro (distinto de `sales_daily_items`, que es por artículo/día). |
| `gestion_pagos` | `i80_compras_detalle_de_pagos_YYYY` | Estado de pago de facturas (impagas, cta cte proveedor). |
| `gestion_cta_cte_clientes` | `i71_cta_por_comprobante_YYYY` | |
| detalle de compras | `i25` | **Reusar `purchases`/`purchase_items`**; validar que no excluyan líneas que el modal de gestion muestra. |
| empleados | `i000_nomina` | Se lee directo (snapshot diario), sin tabla. |
| proveedores / conceptos / artículos | `m00` / `m17` / `m6` | Se leen directo del schema; solo las ediciones locales van a tablas (sección B). |

## B. Tablas manuales (se migran)

| Tabla nueva | Desde gestion | Filas (Ramos / Comercio) | Clave de reenganche |
|---|---|---|---|
| `gestion_gastos_ajustes` | campos `*Manual`, `esBloqueado` de `compras` | ~1.300 / ~2.810 | `row_key` |
| `gestion_conceptos_caja_ajustes` | `conceptos_caja` con `editadoEnLazarillo` | ? / ? | código de concepto |
| `gestion_rubros_caja_config` | `rubros_concepto_caja` (visibilidad) + `sin_rubro_config` | 26 / 21 | código de rubro |
| `gestion_proveedores_config` | `proveedores.pagoAutomatico` | ? | código proveedor |
| `gestion_apertura_reglas` + `gestion_apertura_destinos` | `reglas_apertura`, `destinos_regla` | 559+755 / 0 | código concepto, pdv → branch |
| `gestion_apertura_distribuciones` | — (se recalcula) | 22.544 / 0 | |
| `gestion_impagas_forzadas` | `impagas_forzadas` | 6 / 0 | comprobante + cod_pro |
| `gestion_pagos_proveedor` (+ `_aplicaciones`, `_eventos`) | `pagos_proveedor`… | 2 / 0 | comprobante + cod_pro |
| `gestion_pagos_internos` (+ `_aplicaciones`, `_eventos`) | `pagos_internos`… | 5 (+13) / 0 | row_key |
| `gestion_medios_pago` | `medios_pago` | 4 / 3 | nombre |
| `gestion_flujo_caja_manual` | `flujo_caja_manual` | 21 / 0 | año/mes/branch |
| `gestion_proyecciones_ingresos` | `proyecciones_ingresos` | 55 / 15 | ámbito → business/branch |
| `gestion_equilibrio_variables` | `equilibrio_variables` | 4 / 3 | |
| `gestion_arca_comprobantes` | `arca_comprobantes` | 4.676 / 0 | cuit emisor + tipo + pv + nro |
| `gestion_sin_carga_descartes` | `sin_carga_descartes` | 74 / 2 | clave |
| `gestion_facturas_movil` | `facturas_lazarillo` | 2 / 0 | comprobante + código |
| `gestion_liquidaciones_empleado`, `gestion_reglas_concepto_empleado` | ídem | 0 / 2 | código empleado |
| notas por usuario | `notas_usuario` | 1 / 0 | email → user_id |
| actividad | `actividad` | 4 / 0 | → nuestro audit log existente |

No se migran: `import_logs`, `render_*`, `user_drive_config` (se reconecta),
`aumentos_precio` y `compras_huerfanas` (se recalculan), `_respaldo_*`, `_prisma_migrations`.

Prefijo `gestion_` para no chocar con tablas existentes (`purchases`, `suppliers`, `sales_*`).

## C. Migración de lo manual

Script re-ejecutable `db/scripts/migrar-gestion.js <ramos|comercio> [--aplicar]`
(dry-run por defecto): lee Supabase en solo lectura, traduce local/pdv → business/branch,
reengancha por clave natural, hace upsert, y reporta **cada fila que no matchea**
(nada se descarta en silencio). Se corre hasta el corte final.

## D. Validación (antes del corte)

Para cada mes cerrado y cada business/branch: total por rubro de caja en nuestro Panel
== total en gestion. Pendiente explicar: en 2026 `i22` tiene exactamente 1.198 filas más
que gestion en cada uno de los 3 pdv de container.

## Pendientes

1. Historial 2016–2024: ¿está en informes del kit todavía en revisión? Si no → import desde gestion.
2. Conexión a Supabase para el script (contraseña de la base; no resetear mientras gestion esté en uso).
3. Confirmar `app_branches` de 204 (Ramos / San Justo) en prod.
