-- 135: cuándo se intentó traer por última vez el historial de una cuenta de Mercado Pago (Diego 15/11/2026:
-- «me dice que los está trayendo pero no estoy seguro de que lo esté haciendo»). Sirve para que una sola
-- instancia del back lo arranque, para no relanzarlo mientras corre y para que Clientes diga la verdad:
-- «trayendo» = historial incompleto e intento en los últimos 15 minutos.
ALTER TABLE integraciones_mercadopago ADD COLUMN IF NOT EXISTS historial_intento_at timestamptz;
