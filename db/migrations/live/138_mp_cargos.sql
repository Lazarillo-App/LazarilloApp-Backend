-- 138: lo que descuenta Mercado Pago entra solo al tablero (Diego 15/11/2026).
-- Cada cargo de un cobro (charges_details) trae quién lo cobra: la comisión va al proveedor de la cuenta
-- (Mercado Pago), los cargos de Mercado Libre a Mercado Libre, los impuestos retenidos al de la cuenta.
-- Lo que paga el comprador no se carga. Cada tipo de cargo lleva su concepto de caja, elegido una vez
-- por organización. Se carga como gasto vario PAGADO, uno por día, cuenta y tipo, con la fecha real;
-- cuando llega la factura del proveedor, sus pagos se le aplican y el gasto vario se saca.
-- Idempotente (corre en cada arranque). Para volver atrás: activo = false en mp_cargos_org.

-- Forma de pago habitual del proveedor (Diego: «el proveedor también tiene que tener una forma de pago asociada»).
ALTER TABLE gestion_proveedores ADD COLUMN IF NOT EXISTS "medioPago" text;

-- Encendido por organización y desde qué día se carga (nunca para atrás de eso).
CREATE TABLE IF NOT EXISTS mp_cargos_org (
  organization_id bigint PRIMARY KEY,
  activo          boolean NOT NULL DEFAULT false,
  desde           date,
  actualizado_at  timestamptz NOT NULL DEFAULT now(),
  actualizado_por text
);

-- Proveedor y concepto de caja de cada tipo de cargo (null = el sugerido / sin elegir).
CREATE TABLE IF NOT EXISTS mp_cargos_config (
  organization_id bigint NOT NULL,
  grupo           text NOT NULL,
  proveedor_cod   text,
  concepto_codigo text,
  actualizado_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, grupo)
);

-- Lo ya cargado: una fila por día, cuenta y tipo. Es lo que impide cargar dos veces.
CREATE TABLE IF NOT EXISTS mp_cargos_cargados (
  business_id    bigint NOT NULL,
  sucursal       integer NOT NULL,
  cuenta         bigint NOT NULL,
  fecha          date NOT NULL,
  grupo          text NOT NULL,
  importe        numeric(14,2) NOT NULL,
  proveedor_cod  text,
  comprobante    text,          -- el ticket (gasto vario) que se cargó; null si el día dio negativo
  pago_id        integer,
  absorbido_en   text,          -- comprobante de la factura a la que se pasó el pago
  absorbido_at   timestamptz,
  creado_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, sucursal, cuenta, fecha, grupo)
);
CREATE INDEX IF NOT EXISTS mp_cargos_cargados_pend_idx ON mp_cargos_cargados (business_id, proveedor_cod) WHERE absorbido_en IS NULL AND comprobante IS NOT NULL;
