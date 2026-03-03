-- 043_purchases.sql
-- Tablas transaccionales de compras (sync desde MaxiRest)
-- Regla: upsert por (business_id, factura_key) — siempre reemplaza con el último valor
-- Los items se eliminan y reinsertan (DELETE explícito antes de reinsertar)

-- ===================== PROVEEDORES =====================
CREATE TABLE IF NOT EXISTS suppliers (
  id            BIGINT        PRIMARY KEY,   -- "codigo" de MaxiRest
  business_id   BIGINT        NOT NULL,
  nombre        TEXT,
  razon_social  TEXT,
  cuit          TEXT,
  synced_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_business
  ON suppliers (business_id);

-- ===================== CABECERA DE FACTURA =====================
-- factura_key = campo "numero" de MaxiRest (ej: "A-2-69930")
-- Siempre toma el último valor sincronizado, sin importar si es mayor o menor
CREATE TABLE IF NOT EXISTS purchases (
  id              BIGSERIAL     PRIMARY KEY,
  business_id     BIGINT        NOT NULL,
  factura_key     TEXT          NOT NULL,
  proveedor_id    BIGINT,
  fecha           DATE,
  neto_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  imp_int_total   NUMERIC(14,2) NOT NULL DEFAULT 0,
  total           NUMERIC(14,2) NOT NULL DEFAULT 0,
  synced_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT purchases_biz_factura_uq UNIQUE (business_id, factura_key)
);

CREATE INDEX IF NOT EXISTS idx_purchases_business_fecha
  ON purchases (business_id, fecha);

CREATE INDEX IF NOT EXISTS idx_purchases_proveedor
  ON purchases (proveedor_id);

-- ===================== ÍTEMS DE COMPRA =====================
-- ON DELETE CASCADE: si se borra la cabecera, los items desaparecen solos
CREATE TABLE IF NOT EXISTS purchase_items (
  id              BIGSERIAL     PRIMARY KEY,
  purchase_id     BIGINT        NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  business_id     BIGINT        NOT NULL,
  insumo_id       BIGINT,                     -- cruzado con insumos.id por codigo_maxi
  fecha           DATE,
  sucursal        INT           NOT NULL DEFAULT 0,
  cantidad        NUMERIC(14,4),
  neto            NUMERIC(14,4),
  precio          NUMERIC(14,4),
  precio_total    NUMERIC(14,2),
  iva_tasa        NUMERIC(6,2),
  iva             NUMERIC(14,4),
  iva_total_item  NUMERIC(14,2),
  imp_int         NUMERIC(14,4) NOT NULL DEFAULT 0,
  imp_int_total   NUMERIC(14,2) NOT NULL DEFAULT 0,
  orden_compra    INT           NOT NULL DEFAULT 0,
  cpto_caja       INT           NOT NULL DEFAULT 0,
  referencia      TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase
  ON purchase_items (purchase_id);

CREATE INDEX IF NOT EXISTS idx_purchase_items_business_fecha
  ON purchase_items (business_id, fecha);

CREATE INDEX IF NOT EXISTS idx_purchase_items_insumo
  ON purchase_items (insumo_id);