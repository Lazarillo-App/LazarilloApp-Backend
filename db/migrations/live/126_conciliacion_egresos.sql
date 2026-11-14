-- 126: egresos de Mercado Pago en la conciliación (usuaria 14/11/2026). Además de los cobros
-- ("banco"), se guarda lo que sale de la cuenta: pagos hechos, retiros, comisiones, impuestos
-- retenidos, devoluciones. Va como otra fuente: tipo 'egresos'.
-- Idempotente: solo cambia el CHECK si todavía no admite 'egresos'.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.conciliacion_fuentes'::regclass
       AND conname = 'conciliacion_fuentes_tipo_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%egresos%'
  ) THEN
    ALTER TABLE public.conciliacion_fuentes DROP CONSTRAINT conciliacion_fuentes_tipo_check;
    ALTER TABLE public.conciliacion_fuentes ADD CONSTRAINT conciliacion_fuentes_tipo_check
      CHECK (tipo IN ('ventas', 'pagos', 'banco', 'facturas_cc', 'egresos'));
  END IF;
END $$;
