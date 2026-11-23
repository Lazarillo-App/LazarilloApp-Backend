-- 159 · Provincia (para los feriados) de los negocios existentes — Diego 20/11/2026:
-- Palermo suites, LLEVALO LISTO y los demás = CABA. Los negocios de Container (Ramos Mejía) =
-- provincia de Buenos Aires, como Bar y FC. Negocio DEMO queda solo con nacionales (pruebas).
-- Solo los que todavía no tienen zona: lo que se elija después en la app no se pisa.
UPDATE app_businesses SET zona_feriados = 'AR-B'
 WHERE zona_feriados IS NULL AND id IN (208, 220);
UPDATE app_businesses SET zona_feriados = 'AR-C'
 WHERE zona_feriados IS NULL AND id IN (190, 206, 213, 214, 219, 224, 226, 227, 230, 231);
