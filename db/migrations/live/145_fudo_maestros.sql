-- 145: Fudo trae también artículos, insumos, recetas y compras (usuaria 17/11/2026). Las ventas
-- siempre vienen del POS; lo demás se crea en Lazarillo, pero si el cliente sigue usando Fudo para
-- eso, Lazarillo trae lo nuevo y los cambios (sin pisar lo editado en Lazarillo). Las compras se
-- traen salvo que ya estén cargadas en Lazarillo (mismo proveedor —CUIT o nombre— y fecha).
-- El cliente elige qué traer (integraciones_fudo.traer). Ver services/fudoMaestros.js. Idempotente.

ALTER TABLE integraciones_fudo
  ADD COLUMN IF NOT EXISTS traer jsonb NOT NULL
    DEFAULT '{"ventas": true, "articulos": true, "insumos": true, "compras": true}'::jsonb,
  ADD COLUMN IF NOT EXISTS maestros_at timestamptz,
  ADD COLUMN IF NOT EXISTS maestros_resumen jsonb,
  ADD COLUMN IF NOT EXISTS compras_hasta date;

-- Lo último que se aplicó de cada producto (para no pisar una receta editada en Lazarillo).
ALTER TABLE fudo_productos ADD COLUMN IF NOT EXISTS receta_hash text;

-- Ingredientes de Fudo y el insumo de Lazarillo que les corresponde. `aplicado` guarda lo último que
-- Lazarillo escribió en el insumo: si el insumo todavía tiene ese valor, el cliente no lo tocó y se
-- puede actualizar; si lo cambió en Lazarillo, se respeta.
CREATE TABLE IF NOT EXISTS fudo_insumos (
  business_id  integer     NOT NULL REFERENCES public.app_businesses(id) ON DELETE CASCADE,
  fudo_id      text        NOT NULL,
  nombre       text,
  categoria    text,
  unidad       text,
  costo        numeric(14,4),
  insumo_id    integer,
  aplicado     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  visto_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, fudo_id)
);
