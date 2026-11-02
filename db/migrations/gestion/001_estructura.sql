-- db/migrations/gestion/001_estructura.sql
--
-- Tablas de lazarillo_gestion dentro de la base de Lazarillo, multi-cliente.
-- Diseño: docs/integracion-gestion/00-diseno-modelo.md
--
-- Origen: estructura REAL de la base de gestion (Supabase, instancia Ramos,
-- leída de pg_catalog el 2026-11-02), no reconstruida desde sus migraciones.
--
-- Qué cambia respecto de gestion (y nada más):
--   * prefijo gestion_ en todas las tablas
--   * locales / puntos_de_venta desaparecen: localId / puntoDeVentaId / pdvId
--     pasan a business_id (app_businesses) + branch_id (app_branches, NULL = principal)
--   * maestros (rubros, conceptos, artículos, proveedores, ARCA) son una lista por
--     organización (organization_id); los datos son por negocio
--   * filas que cruzan negocios de la misma organización (reglas de apertura,
--     pagos internos, pagos a proveedor) llevan organization_id + cada negocio
--   * claves únicas por organización / negocio en vez de globales
--   * las columnas propias de gestion conservan su nombre exacto (camelCase entre
--     comillas) para que su SQL se traslade casi sin cambios; las columnas de
--     tenencia usan el estilo de esta base (snake_case)
--
-- NO se aplica sola al arrancar (no está en migrations/live): la corre
-- db/scripts/crear-tablas-gestion.js, con dry-run por defecto.
-- Requiere Postgres 15+ (NULLS NOT DISTINCT, ON DELETE SET NULL (columna)).

-- ===================== MAESTROS (por organización) =====================

CREATE TABLE gestion_rubros_concepto_caja (
  id              SERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  codigo          TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  "calcRent"      TEXT,
  CONSTRAINT gestion_rubros_concepto_caja_org_codigo_key UNIQUE (organization_id, codigo)
);

-- Qué rubros muestra el Panel de cada negocio (en gestion vivía dentro del maestro).
CREATE TABLE gestion_rubros_visibilidad (
  business_id           BIGINT NOT NULL REFERENCES app_businesses(id),
  codigo                TEXT NOT NULL,
  "visibleEnDashboard"  BOOLEAN NOT NULL DEFAULT true,
  "visibleEnResultados" BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (business_id, codigo)
);

CREATE TABLE gestion_sin_rubro_config (
  business_id           BIGINT PRIMARY KEY REFERENCES app_businesses(id),
  "visibleEnDashboard"  BOOLEAN NOT NULL DEFAULT true,
  "visibleEnResultados" BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE gestion_conceptos_caja (
  id                   SERIAL PRIMARY KEY,
  organization_id      BIGINT NOT NULL REFERENCES organizations(id),
  codigo               TEXT NOT NULL,
  nombre               TEXT NOT NULL,
  tipo                 TEXT,
  "codImp"             TEXT,
  "codRga"             TEXT,
  "nombreMaxirest"     TEXT,
  "tipoMaxirest"       TEXT,
  "codRgaMaxirest"     TEXT,
  "editadoEnLazarillo" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT gestion_conceptos_caja_org_codigo_key UNIQUE (organization_id, codigo),
  CONSTRAINT gestion_conceptos_caja_codRga_fkey FOREIGN KEY (organization_id, "codRga")
    REFERENCES gestion_rubros_concepto_caja(organization_id, codigo)
    ON UPDATE CASCADE ON DELETE SET NULL ("codRga")
);

CREATE TABLE gestion_rubros_articulo (
  id              SERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  codigo          TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  color           TEXT,
  "grupoNro"      TEXT,
  "grupoCol"      TEXT,
  "grupoFot"      TEXT,
  "excluyeInf"    BOOLEAN,
  evento          TEXT,
  "deliAct"       BOOLEAN,
  "eveFor"        TEXT,
  "eveForm"       TEXT,
  "eveFormH"      TEXT,
  discont         NUMERIC(65,30),
  "fechaUpda"     TIMESTAMP(3),
  "modoVista"     TEXT,
  CONSTRAINT gestion_rubros_articulo_org_codigo_key UNIQUE (organization_id, codigo)
);

CREATE TABLE gestion_subrubros_articulo (
  id              SERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  codigo          TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  "deliAct"       BOOLEAN,
  "eveFor"        TEXT,
  "eveForm"       TEXT,
  "eveFormH"      TEXT,
  "fechaUpda"     TIMESTAMP(3),
  "codRua"        TEXT,
  CONSTRAINT gestion_subrubros_articulo_org_codigo_key UNIQUE (organization_id, codigo),
  CONSTRAINT gestion_subrubros_articulo_codRua_fkey FOREIGN KEY (organization_id, "codRua")
    REFERENCES gestion_rubros_articulo(organization_id, codigo)
    ON UPDATE CASCADE ON DELETE SET NULL ("codRua")
);

CREATE TABLE gestion_articulos (
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  codigo          TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  precio1         NUMERIC(65,30),
  precio2         NUMERIC(65,30),
  precio3         NUMERIC(65,30),
  precio4         NUMERIC(65,30),
  "codRua"        TEXT,
  "codSua"        TEXT,
  PRIMARY KEY (organization_id, codigo),
  CONSTRAINT gestion_articulos_codRua_fkey FOREIGN KEY (organization_id, "codRua")
    REFERENCES gestion_rubros_articulo(organization_id, codigo)
    ON UPDATE CASCADE ON DELETE SET NULL ("codRua"),
  CONSTRAINT gestion_articulos_codSua_fkey FOREIGN KEY (organization_id, "codSua")
    REFERENCES gestion_subrubros_articulo(organization_id, codigo)
    ON UPDATE CASCADE ON DELETE SET NULL ("codSua")
);

CREATE TABLE gestion_proveedores (
  id               SERIAL PRIMARY KEY,
  organization_id  BIGINT NOT NULL REFERENCES organizations(id),
  codigo           TEXT NOT NULL,
  nombre           TEXT,
  razon            TEXT,
  direccion        TEXT,
  localidad        TEXT,
  contacto         TEXT,
  telefono         TEXT,
  fax              TEXT,
  celular          TEXT,
  "tipoIva"        TEXT,
  cuit             TEXT,
  cbu              TEXT,
  "aliasCbu"       TEXT,
  "diasVenc"       INTEGER,
  iva              NUMERIC(65,30),
  "ivaDif"         NUMERIC(65,30),
  email            TEXT,
  observac         TEXT,
  "fecUltipp"      TIMESTAMP(3),
  "detPerc"        TEXT,
  "pagoAutomatico" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT gestion_proveedores_org_codigo_key UNIQUE (organization_id, codigo)
);

CREATE TABLE gestion_empleados (
  id              SERIAL PRIMARY KEY,
  business_id     BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id       BIGINT REFERENCES app_branches(id),
  codigo          TEXT NOT NULL,
  nombre          TEXT,
  apellido        TEXT,
  "fechaBaja"     DATE,
  "actualizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX gestion_empleados_biz_branch_codigo_key
  ON gestion_empleados (business_id, branch_id, codigo) NULLS NOT DISTINCT;

-- ===================== MOVIMIENTOS (por negocio + sucursal) =====================

CREATE TABLE gestion_compras (
  business_id                 BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id                   BIGINT REFERENCES app_branches(id),
  "rowId"                     TEXT NOT NULL,
  comprobante                 TEXT,
  "codCga"                    TEXT,
  concepto                    TEXT,
  fecha                       TIMESTAMP(3),
  codigo                      TEXT,
  proveedor                   TEXT,
  detalle                     TEXT,
  observac                    TEXT,
  importe                     NUMERIC(65,30),
  "importeTrabajado"          NUMERIC(65,30),
  "impInt"                    NUMERIC(65,30),
  imputac                     TEXT,
  per1                        NUMERIC(65,30),
  per2                        NUMERIC(65,30),
  per3                        NUMERIC(65,30),
  "conceptoCodigo"            TEXT,
  "proveedorId"               INTEGER REFERENCES gestion_proveedores(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "importeManual"             NUMERIC,
  "fechaManual"               TIMESTAMP(3),
  "conceptoCodigoManual"      TEXT,
  "observacManual"            TEXT,
  "distribuidoEn"             TIMESTAMP(3),
  "esBloqueado"               BOOLEAN NOT NULL DEFAULT false,
  "esDistribuido"             BOOLEAN NOT NULL DEFAULT false,
  "proveedorTextoNormalizado" TEXT,
  "fechaPago"                 TIMESTAMP(3),
  "cajaPago"                  TEXT,
  periodo                     TIMESTAMP(3),
  origen                      TEXT,
  "conceptoPorRegla"          INTEGER,
  PRIMARY KEY (business_id, "rowId")
);
CREATE INDEX gestion_compras_biz_branch_comprobante_codigo_idx ON gestion_compras (business_id, branch_id, comprobante, codigo);
CREATE INDEX gestion_compras_biz_fecha_idx ON gestion_compras (business_id, fecha);
CREATE INDEX gestion_compras_biz_comprobante_idx ON gestion_compras (business_id, comprobante);
CREATE INDEX gestion_compras_origen_biz_comprobante_codigo_idx ON gestion_compras (origen, business_id, comprobante, codigo);
CREATE INDEX gestion_compras_proveedor_biz_idx ON gestion_compras ("proveedorId", business_id);
CREATE INDEX gestion_compras_conceptoPorRegla_idx ON gestion_compras ("conceptoPorRegla") WHERE "conceptoPorRegla" IS NOT NULL;
CREATE INDEX gestion_compras_biz_fecha_efectiva_idx ON gestion_compras (business_id, COALESCE("fechaManual", fecha));
CREATE INDEX gestion_compras_biz_branch_fecha_efectiva_idx ON gestion_compras (business_id, branch_id, COALESCE("fechaManual", fecha));
CREATE INDEX gestion_compras_fechaManual_idx ON gestion_compras ("fechaManual") WHERE "fechaManual" IS NOT NULL;

CREATE TABLE gestion_detalle_compras (
  business_id      BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id        BIGINT REFERENCES app_branches(id),
  "rowId"          TEXT NOT NULL,
  "codPro"         TEXT,
  "codCpb"         TEXT,
  numero1          TEXT,
  numero2          TEXT,
  comprobante      TEXT,
  fecha            TIMESTAMP(3),
  codigo           TEXT,
  nombre           TEXT,
  medida           TEXT,
  cantidad         NUMERIC(65,30),
  neto             NUMERIC(65,30),
  "totalIns"       NUMERIC(65,30),
  "ivaTot"         NUMERIC(65,30),
  "impNtTot"       NUMERIC(65,30),
  tasa             NUMERIC(65,30),
  iva              NUMERIC(65,30),
  "impInt"         NUMERIC(65,30),
  percep           NUMERIC(65,30),
  observac         TEXT,
  "compraId"       TEXT,
  "articuloCodigo" TEXT,
  "proveedorId"    INTEGER REFERENCES gestion_proveedores(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "codCga"         TEXT,
  "nomCga"         TEXT,
  origen           TEXT,
  PRIMARY KEY (business_id, "rowId"),
  CONSTRAINT gestion_detalle_compras_compra_fkey FOREIGN KEY (business_id, "compraId")
    REFERENCES gestion_compras(business_id, "rowId")
    ON UPDATE CASCADE ON DELETE SET NULL ("compraId")
);
CREATE INDEX gestion_detalle_compras_biz_branch_idx ON gestion_detalle_compras (business_id, branch_id);
CREATE INDEX gestion_detalle_compras_biz_comprobante_idx ON gestion_detalle_compras (business_id, comprobante);
CREATE INDEX gestion_detalle_compras_unlinked_idx ON gestion_detalle_compras (business_id, comprobante) WHERE "compraId" IS NULL;
CREATE INDEX gestion_detalle_compras_compra_idx ON gestion_detalle_compras (business_id, "compraId");
CREATE INDEX gestion_detalle_compras_origen_biz_comprobante_codPro_idx ON gestion_detalle_compras (origen, business_id, comprobante, "codPro");
CREATE INDEX gestion_detalle_compras_codCga_idx ON gestion_detalle_compras (business_id, "codCga");

CREATE TABLE gestion_pagos (
  business_id   BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id     BIGINT REFERENCES app_branches(id),
  "rowId"       TEXT NOT NULL,
  fecha         TIMESTAMP(3),
  "codCpb"      TEXT,
  prefijo       TEXT,
  numero        TEXT,
  comprobante   TEXT,
  "codPro"      TEXT,
  proveedor     TEXT,
  total         NUMERIC(65,30),
  "codCga"      TEXT,
  concepto      TEXT,
  medio         TEXT,
  importe       NUMERIC(65,30),
  "fechaPago"   TIMESTAMP(3),
  orden         TEXT,
  secuencia     INTEGER NOT NULL DEFAULT 1,
  "fechaVal"    TIMESTAMP(3),
  "numeroVal"   TEXT,
  "codBan"      TEXT,
  banco         TEXT,
  "impVal"      NUMERIC(65,30),
  "proveedorId" INTEGER REFERENCES gestion_proveedores(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "creadoEn"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, "rowId")
);
CREATE INDEX gestion_pagos_biz_fechaPago_idx ON gestion_pagos (business_id, "fechaPago");
CREATE INDEX gestion_pagos_proveedor_idx ON gestion_pagos ("proveedorId");
CREATE INDEX gestion_pagos_biz_branch_comprobante_codPro_idx ON gestion_pagos (business_id, branch_id, comprobante, "codPro");

CREATE TABLE gestion_ventas (
  business_id        BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id          BIGINT REFERENCES app_branches(id),
  "rowId"            TEXT NOT NULL,
  turno              TEXT,
  comprobant         TEXT,
  hora               TEXT,
  tipo               TEXT,
  mesa               TEXT,
  mozo               TEXT,
  cub                TEXT,
  cobro              TEXT,
  "codCobro"         TEXT,
  importe            NUMERIC(65,30),
  "importeTrabajado" NUMERIC(65,30),
  total              NUMERIC(65,30),
  descuento          NUMERIC(65,30),
  "cliNombre"        TEXT,
  "cliRazon"         TEXT,
  "cliCut"           TEXT,
  fecha              TIMESTAMP(3),
  "codSuc"           TEXT,
  "nombreSuc"        TEXT,
  cupon              TEXT,
  "importeManual"    NUMERIC,
  PRIMARY KEY (business_id, "rowId")
);
CREATE INDEX gestion_ventas_biz_branch_fecha_idx ON gestion_ventas (business_id, branch_id, fecha);
CREATE INDEX gestion_ventas_biz_fecha_idx ON gestion_ventas (business_id, fecha);

CREATE TABLE gestion_compras_huerfanas (
  business_id           BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id             BIGINT REFERENCES app_branches(id),
  "rowId"               TEXT NOT NULL,
  fecha                 DATE,
  comprobante           TEXT,
  codigo                TEXT,
  proveedor             TEXT,
  concepto              TEXT,
  importe               NUMERIC(18,2),
  "importeManualAntes"  NUMERIC(18,2),
  "observacManualAntes" TEXT,
  motivo                TEXT NOT NULL,
  estado                TEXT NOT NULL,
  "detectadaEn"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actualizadaEn"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, "rowId")
);
CREATE INDEX gestion_compras_huerfanas_biz_branch_estado_idx ON gestion_compras_huerfanas (business_id, branch_id, estado);

-- ===================== CARGADO A MANO (por negocio + sucursal) =====================

CREATE TABLE gestion_impagas_forzadas (
  id          SERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id   BIGINT REFERENCES app_branches(id),
  comprobante TEXT NOT NULL,
  "codPro"    TEXT NOT NULL,
  "creadoEn"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX gestion_impagas_forzadas_key
  ON gestion_impagas_forzadas (business_id, branch_id, comprobante, "codPro") NULLS NOT DISTINCT;

CREATE TABLE gestion_medios_pago (
  id          SERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  nombre      TEXT NOT NULL,
  tipo        TEXT NOT NULL DEFAULT 'otro',
  "pideId"    BOOLEAN NOT NULL DEFAULT false,
  activo      BOOLEAN NOT NULL DEFAULT true,
  orden       INTEGER NOT NULL DEFAULT 0,
  "creadoEn"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT gestion_medios_pago_biz_nombre_key UNIQUE (business_id, nombre)
);

CREATE TABLE gestion_flujo_caja_manual (
  id          SERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id   BIGINT REFERENCES app_branches(id),
  anio        INTEGER NOT NULL,
  mes         INTEGER NOT NULL,
  monto       NUMERIC(65,30) NOT NULL
);
CREATE UNIQUE INDEX gestion_flujo_caja_manual_key
  ON gestion_flujo_caja_manual (business_id, branch_id, anio, mes) NULLS NOT DISTINCT;

-- branch_id NULL = todo el negocio (en gestion: ámbito "<local>/*").
CREATE TABLE gestion_proyecciones_ingresos (
  id          SERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id   BIGINT REFERENCES app_branches(id),
  anio        INTEGER NOT NULL,
  mes         INTEGER NOT NULL,
  corte       DATE NOT NULL,
  metodo      TEXT NOT NULL,
  facturado   NUMERIC(16,2) NOT NULL,
  proyeccion  NUMERIC(16,2) NOT NULL,
  "creadoEn"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX gestion_proyecciones_ingresos_key
  ON gestion_proyecciones_ingresos (business_id, branch_id, anio, mes, corte, metodo) NULLS NOT DISTINCT;

CREATE TABLE gestion_equilibrio_variables (
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  tipo        TEXT NOT NULL CHECK (tipo IN ('rubro', 'concepto')),
  codigo      TEXT NOT NULL,
  pct         NUMERIC(5,2) NOT NULL CHECK (pct >= 0 AND pct <= 100),
  "creadoEn"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, tipo, codigo)
);

CREATE TABLE gestion_aumentos_precio (
  id          SERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id   BIGINT REFERENCES app_branches(id),
  fecha       DATE NOT NULL,
  origen      TEXT NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual', 'detectado')),
  "creadoEn"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  pct         NUMERIC(7,4),
  provisorio  BOOLEAN NOT NULL DEFAULT false,
  descartado  BOOLEAN NOT NULL DEFAULT false,
  detalle     JSONB
);
CREATE UNIQUE INDEX gestion_aumentos_precio_key
  ON gestion_aumentos_precio (business_id, branch_id, fecha) NULLS NOT DISTINCT;

CREATE TABLE gestion_sin_carga_descartes (
  id          SERIAL PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id   BIGINT REFERENCES app_branches(id),
  clave       TEXT NOT NULL,
  nombre      TEXT,
  "creadoEn"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "creadoPor" TEXT
);
CREATE UNIQUE INDEX gestion_sin_carga_descartes_key
  ON gestion_sin_carga_descartes (business_id, branch_id, clave) NULLS NOT DISTINCT;

-- En gestion se llamaba facturas_lazarillo (facturas cargadas desde el celular).
CREATE TABLE gestion_facturas_movil (
  id               SERIAL PRIMARY KEY,
  business_id      BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id        BIGINT REFERENCES app_branches(id),
  comprobante      TEXT NOT NULL,
  codigo           TEXT NOT NULL,
  "proveedorId"    INTEGER NOT NULL REFERENCES gestion_proveedores(id),
  fecha            DATE NOT NULL,
  total            NUMERIC(16,2) NOT NULL,
  payload          JSONB NOT NULL,
  "creadoPor"      TEXT,
  "creadoEn"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actualizadoPor" TEXT,
  "actualizadoEn"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT gestion_facturas_movil_key UNIQUE (business_id, comprobante, codigo)
);

CREATE TABLE gestion_liquidaciones_empleado (
  id               SERIAL PRIMARY KEY,
  business_id      BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id        BIGINT REFERENCES app_branches(id),
  tipo             TEXT NOT NULL,
  "empleadoCodigo" TEXT NOT NULL,
  "empleadoNombre" TEXT NOT NULL,
  periodo          DATE NOT NULL,
  "fechaPago"      DATE NOT NULL,
  total            NUMERIC(14,2) NOT NULL,
  adelantos        NUMERIC(14,2) NOT NULL DEFAULT 0,
  payload          JSONB NOT NULL,
  "creadoPor"      TEXT,
  "creadoEn"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "anuladoEn"      TIMESTAMP(3),
  "anuladoPor"     TEXT
);
CREATE INDEX gestion_liquidaciones_empleado_biz_empleado_periodo_idx
  ON gestion_liquidaciones_empleado (business_id, branch_id, "empleadoCodigo", periodo);

CREATE TABLE gestion_reglas_concepto_empleado (
  id                   SERIAL PRIMARY KEY,
  business_id          BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id            BIGINT REFERENCES app_branches(id),
  "entidadId"          TEXT NOT NULL,
  nombre               TEXT,
  "conceptoCodigo"     TEXT NOT NULL,
  modo                 TEXT NOT NULL,
  "fechaDesde"         TIMESTAMP(3),
  "fechaHasta"         TIMESTAMP(3),
  "extremosInclusivos" BOOLEAN NOT NULL DEFAULT true,
  estado               TEXT NOT NULL DEFAULT 'activa',
  "creadoPor"          TEXT,
  "creadoEn"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gestion_reglas_concepto_empleado_biz_idx ON gestion_reglas_concepto_empleado (business_id, branch_id, estado);

-- ===================== CRUZAN NEGOCIOS DE UNA ORGANIZACIÓN =====================

CREATE TABLE gestion_reglas_apertura (
  id                   SERIAL PRIMARY KEY,
  organization_id      BIGINT NOT NULL REFERENCES organizations(id),
  business_id          BIGINT NOT NULL REFERENCES app_businesses(id),   -- origen
  branch_id            BIGINT REFERENCES app_branches(id),              -- origen
  nivel                TEXT NOT NULL,
  "entidadId"          TEXT NOT NULL,
  modo                 TEXT NOT NULL,
  "fechaDesde"         TIMESTAMP(3),
  "fechaHasta"         TIMESTAMP(3),
  "extremosInclusivos" BOOLEAN NOT NULL DEFAULT true,
  estado               TEXT NOT NULL DEFAULT 'activa',
  "creadoPor"          TEXT,
  "creadoEn"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gestion_reglas_apertura_entidad_idx
  ON gestion_reglas_apertura (organization_id, "entidadId", nivel, business_id, branch_id);

CREATE TABLE gestion_destinos_regla (
  id          SERIAL PRIMARY KEY,
  "reglaId"   INTEGER NOT NULL REFERENCES gestion_reglas_apertura(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id   BIGINT REFERENCES app_branches(id),
  porcentaje  NUMERIC(5,2) NOT NULL
);
CREATE INDEX gestion_destinos_regla_regla_idx ON gestion_destinos_regla ("reglaId");

CREATE TABLE gestion_distribuciones_apertura (
  id                 SERIAL PRIMARY KEY,
  compra_business_id BIGINT NOT NULL,
  "compraRowId"      TEXT NOT NULL,
  "reglaId"          INTEGER NOT NULL REFERENCES gestion_reglas_apertura(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "destinoId"        INTEGER NOT NULL REFERENCES gestion_destinos_regla(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  "importeOriginal"  NUMERIC(14,2) NOT NULL,
  porcentaje         NUMERIC(5,2) NOT NULL,
  "importeCalculado" NUMERIC(14,2) NOT NULL,
  "procesadoEn"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT gestion_distribuciones_apertura_compra_fkey FOREIGN KEY (compra_business_id, "compraRowId")
    REFERENCES gestion_compras(business_id, "rowId") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX gestion_distribuciones_apertura_regla_idx ON gestion_distribuciones_apertura ("reglaId");
CREATE INDEX gestion_distribuciones_apertura_compra_idx ON gestion_distribuciones_apertura (compra_business_id, "compraRowId");
CREATE INDEX gestion_distribuciones_apertura_destino_idx ON gestion_distribuciones_apertura ("destinoId");

-- origen = quien cobra, destino = quien paga (en gestion: pdvOrigenId / pdvDestinoId)
CREATE TABLE gestion_pagos_internos (
  id                  SERIAL PRIMARY KEY,
  organization_id     BIGINT NOT NULL REFERENCES organizations(id),
  origen_business_id  BIGINT NOT NULL REFERENCES app_businesses(id),
  origen_branch_id    BIGINT REFERENCES app_branches(id),
  destino_business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  destino_branch_id   BIGINT REFERENCES app_branches(id),
  fecha               DATE NOT NULL,
  importe             NUMERIC(14,2) NOT NULL,
  medio               TEXT NOT NULL,
  referencia          TEXT,
  "creadoEn"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "anuladoEn"         TIMESTAMP(3),
  "creadoPor"         TEXT,
  CONSTRAINT gestion_pagos_internos_org_referencia_key UNIQUE (organization_id, referencia)
);
CREATE INDEX gestion_pagos_internos_destino_origen_idx
  ON gestion_pagos_internos (destino_business_id, destino_branch_id, origen_business_id, origen_branch_id);

CREATE TABLE gestion_eventos_pago_interno (
  id         SERIAL PRIMARY KEY,
  "pagoId"   INTEGER NOT NULL REFERENCES gestion_pagos_internos(id) ON UPDATE CASCADE ON DELETE CASCADE,
  tipo       TEXT NOT NULL,
  detalle    TEXT,
  importe    NUMERIC(14,2),
  usuario    TEXT,
  "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gestion_eventos_pago_interno_pago_idx ON gestion_eventos_pago_interno ("pagoId");

CREATE TABLE gestion_aplicaciones_pago_interno (
  id                 SERIAL PRIMARY KEY,
  "pagoId"           INTEGER NOT NULL REFERENCES gestion_pagos_internos(id) ON UPDATE CASCADE ON DELETE CASCADE,
  compra_business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  "compraRowId"      TEXT NOT NULL,
  importe            NUMERIC(14,2) NOT NULL
);
CREATE INDEX gestion_aplicaciones_pago_interno_pago_idx ON gestion_aplicaciones_pago_interno ("pagoId");
CREATE INDEX gestion_aplicaciones_pago_interno_compra_idx ON gestion_aplicaciones_pago_interno (compra_business_id, "compraRowId");

-- business_id/branch_id = quien paga (en gestion: pdvPagaId); puede imputar
-- facturas de otro negocio de la organización (aplicaciones).
CREATE TABLE gestion_pagos_proveedor (
  id              SERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  business_id     BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id       BIGINT REFERENCES app_branches(id),
  "codPro"        TEXT NOT NULL,
  fecha           DATE NOT NULL,
  importe         NUMERIC(14,2) NOT NULL,
  medio           TEXT NOT NULL,
  referencia      TEXT,
  "creadoEn"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "creadoPor"     TEXT,
  "anuladoEn"     TIMESTAMP(3),
  "anuladoPor"    TEXT
);
CREATE INDEX gestion_pagos_proveedor_org_codPro_idx ON gestion_pagos_proveedor (organization_id, "codPro");

CREATE TABLE gestion_aplicaciones_pago_proveedor (
  id          SERIAL PRIMARY KEY,
  "pagoId"    INTEGER NOT NULL REFERENCES gestion_pagos_proveedor(id) ON UPDATE CASCADE ON DELETE CASCADE,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),   -- negocio de la factura (en gestion: pdvId)
  branch_id   BIGINT REFERENCES app_branches(id),
  comprobante TEXT NOT NULL,
  "codPro"    TEXT NOT NULL,
  importe     NUMERIC(14,2) NOT NULL
);
CREATE INDEX gestion_aplicaciones_pago_proveedor_pago_idx ON gestion_aplicaciones_pago_proveedor ("pagoId");
CREATE INDEX gestion_aplicaciones_pago_proveedor_factura_idx
  ON gestion_aplicaciones_pago_proveedor (business_id, branch_id, comprobante, "codPro");

CREATE TABLE gestion_eventos_pago_proveedor (
  id         SERIAL PRIMARY KEY,
  "pagoId"   INTEGER NOT NULL REFERENCES gestion_pagos_proveedor(id) ON UPDATE CASCADE ON DELETE CASCADE,
  tipo       TEXT NOT NULL,
  detalle    TEXT,
  importe    NUMERIC(14,2),
  usuario    TEXT,
  "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gestion_eventos_pago_proveedor_pago_idx ON gestion_eventos_pago_proveedor ("pagoId");

-- Comprobantes recibidos según ARCA: van por CUIT receptor, que es de la
-- razón social (en Ramos, Bar y Canchas comparten uno) → por organización.
CREATE TABLE gestion_arca_comprobantes (
  id              SERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  "cuitReceptor"  TEXT NOT NULL,
  "cuitEmisor"    TEXT NOT NULL,
  emisor          TEXT,
  tipo            INTEGER NOT NULL,
  "puntoVenta"    INTEGER NOT NULL,
  numero          BIGINT NOT NULL,
  fecha           DATE NOT NULL,
  cae             TEXT,
  moneda          TEXT,
  "tipoCambio"    NUMERIC(18,6),
  neto            NUMERIC(18,2) NOT NULL DEFAULT 0,
  "noGravado"     NUMERIC(18,2) NOT NULL DEFAULT 0,
  exento          NUMERIC(18,2) NOT NULL DEFAULT 0,
  "otrosTributos" NUMERIC(18,2) NOT NULL DEFAULT 0,
  iva             NUMERIC(18,2) NOT NULL DEFAULT 0,
  total           NUMERIC(18,2) NOT NULL,
  "importadoEn"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "importadoPor"  TEXT,
  CONSTRAINT gestion_arca_comprobantes_key UNIQUE (organization_id, "cuitEmisor", tipo, "puntoVenta", numero)
);
CREATE INDEX gestion_arca_comprobantes_org_fecha_idx ON gestion_arca_comprobantes (organization_id, fecha);

-- ===================== POR USUARIO =====================

CREATE TABLE gestion_notas_usuario (
  user_id         BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  business_id     BIGINT NOT NULL REFERENCES app_businesses(id),
  texto           TEXT NOT NULL DEFAULT '',
  "actualizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, business_id)
);

CREATE TABLE gestion_drive_config (
  user_id       BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  business_id   BIGINT NOT NULL REFERENCES app_businesses(id),
  folder_id     TEXT,
  folder_name   TEXT,
  refresh_token TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, business_id)
);

-- ===================== OPERACIÓN (historial, imports, lectura de Maxi) =====================

-- Historial de gestion (tiene "restaurar"); business_id NULL = acción de la organización.
CREATE TABLE gestion_actividad (
  id              SERIAL PRIMARY KEY,
  organization_id BIGINT NOT NULL REFERENCES organizations(id),
  business_id     BIGINT REFERENCES app_businesses(id),
  tipo            TEXT NOT NULL,
  accion          TEXT NOT NULL,
  descripcion     TEXT NOT NULL,
  "refId"         TEXT,
  usuario         TEXT,
  datos           JSONB,
  "creadoEn"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gestion_actividad_org_creadoEn_idx ON gestion_actividad (organization_id, "creadoEn");

CREATE TABLE gestion_import_logs (
  id             SERIAL PRIMARY KEY,
  business_id    BIGINT REFERENCES app_businesses(id),
  branch_id      BIGINT REFERENCES app_branches(id),
  "batchId"      TEXT NOT NULL,
  "fileType"     TEXT,
  "fileName"     TEXT NOT NULL,
  "storagePath"  TEXT,
  estado         TEXT NOT NULL,
  "totalRows"    INTEGER,
  created        INTEGER,
  updated        INTEGER,
  skipped        INTEGER,
  errors         JSONB,
  "skippedRows"  JSONB,
  "errorMessage" TEXT,
  "durationMs"   INTEGER,
  "triggeredBy"  TEXT NOT NULL,
  "creadoEn"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "driveFileId"  TEXT,
  "driveHuella"  TEXT
);
CREATE INDEX gestion_import_logs_biz_creadoEn_idx ON gestion_import_logs (business_id, "creadoEn");
CREATE INDEX gestion_import_logs_batch_idx ON gestion_import_logs ("batchId");
CREATE INDEX gestion_import_logs_driveFile_idx ON gestion_import_logs ("driveFileId", "creadoEn");

-- Qué (esquema del kit, pdv) alimenta a qué negocio/sucursal. Es la versión en
-- tabla de services/maxiPdvMap.js: un cliente nuevo se suma con filas, sin código.
CREATE TABLE gestion_render_origenes (
  id          SERIAL PRIMARY KEY,
  esquema     TEXT NOT NULL,
  pdv         TEXT NOT NULL,
  business_id BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id   BIGINT REFERENCES app_branches(id),
  activo      BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT gestion_render_origenes_esquema_pdv_key UNIQUE (esquema, pdv)
);

CREATE TABLE gestion_render_corridas (
  id              SERIAL PRIMARY KEY,
  organization_id BIGINT REFERENCES organizations(id),
  inicio          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fin             TIMESTAMP(3),
  estado          TEXT NOT NULL,
  origen          TEXT NOT NULL,
  total           INTEGER NOT NULL DEFAULT 0,
  hechos          INTEGER NOT NULL DEFAULT 0,
  actual          TEXT,
  resumen         JSONB
);
CREATE INDEX gestion_render_corridas_inicio_idx ON gestion_render_corridas (organization_id, inicio);
