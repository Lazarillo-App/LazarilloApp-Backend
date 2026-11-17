-- 141: Soporte Lazarillo (Diego 16/11/2026). Toda cuenta (organización) nueva nace con soporte activo:
-- mientras esté activo, los super usuarios entran a sus negocios con rol de dueño, sin sumarse al
-- equipo del cliente. Las organizaciones que ya existían quedan sin soporte, salvo la de Renato
-- (negocio 231, primer cliente de testing). Idempotente: el UPDATE corre solo al crear la columna,
-- así un «soltar» posterior no se pisa en el próximo arranque.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'organizations' AND column_name = 'soporte_activo') THEN
    ALTER TABLE organizations ADD COLUMN soporte_activo BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE organizations ALTER COLUMN soporte_activo SET DEFAULT true;
    UPDATE organizations SET soporte_activo = true
     WHERE id IN (SELECT organization_id FROM app_businesses WHERE id = 231 AND organization_id IS NOT NULL);
  END IF;
END $$;
