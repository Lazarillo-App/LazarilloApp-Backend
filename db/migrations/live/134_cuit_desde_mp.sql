-- 134: CUIT de las sucursales desde su cuenta de Mercado Pago (Diego 15/11/2026: «¿por qué al abrir
-- Clientes? cuando se vincula»). Desde ahora se completa al vincular la cuenta; esto completa una
-- vez las cuentas que ya estaban vinculadas. Solo donde el CUIT está vacío (nunca pisa uno cargado
-- a mano) y deja marcado el origen. Idempotente.
UPDATE app_businesses b
   SET props = COALESCE(b.props, '{}'::jsonb) || jsonb_build_object(
         'tax_id', substr(i.mp_doc, 1, 2) || '-' || substr(i.mp_doc, 3, 8) || '-' || substr(i.mp_doc, 11, 1),
         'tax_id_origen', 'mercadopago')
  FROM integraciones_mercadopago i
 WHERE i.business_id = b.id AND i.sucursal = 0 AND length(COALESCE(i.mp_doc, '')) = 11
   AND COALESCE(b.props->>'tax_id', '') = '';

UPDATE app_branches s
   SET props = COALESCE(s.props, '{}'::jsonb) || jsonb_build_object(
         'cuit', substr(i.mp_doc, 1, 2) || '-' || substr(i.mp_doc, 3, 8) || '-' || substr(i.mp_doc, 11, 1),
         'cuit_origen', 'mercadopago'),
       updated_at = NOW()
  FROM integraciones_mercadopago i
 WHERE i.business_id = s.business_id AND length(COALESCE(i.mp_doc, '')) = 11
   AND ((i.sucursal = 0 AND COALESCE((s.props->>'is_main')::boolean, false)) OR i.sucursal = s.id)
   AND COALESCE(s.props->>'cuit', '') = '';
