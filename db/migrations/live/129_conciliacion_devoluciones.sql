-- 129: devoluciones, contracargos y disputas de Mercado Pago (Diego 14/11/2026). Van como otra
-- fuente ('devoluciones') para que la conciliación siga leyendo 'banco' y 'egresos' igual que antes;
-- las muestra Administración › Movimientos bancarios.
-- Idempotente: solo cambia el CHECK si todavía no admite 'devoluciones'.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.conciliacion_fuentes'::regclass
       AND conname = 'conciliacion_fuentes_tipo_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%devoluciones%'
  ) THEN
    ALTER TABLE public.conciliacion_fuentes DROP CONSTRAINT conciliacion_fuentes_tipo_check;
    ALTER TABLE public.conciliacion_fuentes ADD CONSTRAINT conciliacion_fuentes_tipo_check
      CHECK (tipo IN ('ventas', 'pagos', 'banco', 'facturas_cc', 'egresos', 'devoluciones'));
  END IF;
END $$;
