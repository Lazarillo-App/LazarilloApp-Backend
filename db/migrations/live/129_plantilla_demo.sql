-- 129 · Plantilla de Lazarillo en el Negocio DEMO (Diego 14/11/2026).
-- Diego depura la plantilla en la app, con las pantallas de siempre, mirando el Negocio DEMO
-- (organización 25, negocio 225): lo que quede ahí es lo que va a ver un negocio nuevo.
-- Sale de lo que se repite entre Container, Comercio y Palermo (12/11), sin lo propio de cada uno.
-- Se carga UNA sola vez: la marca de gestion_plantilla_aplicada evita que se vuelva a cargar
-- (las migraciones corren en cada arranque) y así no revive lo que Diego borre al depurar.
-- Códigos desde 1001 (propios de Lazarillo; MaxiRest llega al 999).
CREATE TABLE IF NOT EXISTS gestion_plantilla_aplicada (
  organization_id BIGINT PRIMARY KEY,
  aplicada_en     TIMESTAMPTZ NOT NULL DEFAULT now(),
  origen          TEXT
);

DO $$
DECLARE
  org CONSTANT BIGINT := 25;
  biz CONSTANT INT := 225;
  prox INT;
BEGIN
  IF EXISTS (SELECT 1 FROM gestion_plantilla_aplicada WHERE organization_id = org) THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM app_businesses WHERE id = biz AND organization_id = org) THEN RETURN; END IF;

  -- Rubros de caja
  INSERT INTO gestion_rubros_concepto_caja (organization_id, codigo, nombre, "calcRent")
  SELECT org, v.codigo::text, v.nombre, v.calc FROM (VALUES
      (1001,'Mercaderías','true'),
      (1002,'Gastos en personal','true'),
      (1003,'Servicios','true'),
      (1004,'Delivery','true'),
      (1005,'Impuestos','true'),
      (1006,'Alquiler','true'),
      (1007,'Mantenimiento','true'),
      (1008,'Vajilla y mantelería','true'),
      (1009,'Otros gastos','true'),
      (1010,'Publicidad','true'),
      (1011,'Inversiones','false'),
      (1012,'Intereses','true'),
      (1013,'Mov. societarios','false'),
      (1014,'Ingresos varios','true'),
      (1015,'Consumos internos','true')
    ) AS v(codigo, nombre, calc)
  WHERE NOT EXISTS (SELECT 1 FROM gestion_rubros_concepto_caja r WHERE r.organization_id = org AND r.codigo = v.codigo::text);

  -- Conceptos de caja
  INSERT INTO gestion_conceptos_caja (organization_id, codigo, nombre, tipo, "codRga")
  SELECT org, v.codigo::text, v.nombre, v.tipo, v.rubro::text FROM (VALUES
      (1001,'Almacén','-',1001),
      (1002,'Aceites','-',1001),
      (1003,'Alimentos envasados','-',1001),
      (1004,'Bebidas con alcohol','-',1001),
      (1005,'Bebidas sin alcohol','-',1001),
      (1006,'Vinos / champagnes','-',1001),
      (1007,'Carnes','-',1001),
      (1008,'Verdulería','-',1001),
      (1009,'Frutas','-',1001),
      (1010,'Lácteos','-',1001),
      (1011,'Quesos y fiambres','-',1001),
      (1012,'Panadería','-',1001),
      (1013,'Pescadería','-',1001),
      (1014,'Especias','-',1001),
      (1015,'Cafetería / pastelería','-',1001),
      (1016,'Helados','-',1001),
      (1017,'Hielo','-',1001),
      (1018,'Bonificación','+',1001),
      (1019,'Liquidación sueldo','-',1002),
      (1020,'Adelanto sueldo','-',1002),
      (1021,'SAC I','-',1002),
      (1022,'SAC II','-',1002),
      (1023,'Liquidación final','-',1002),
      (1024,'Vacaciones','-',1002),
      (1025,'Horas extra','-',1002),
      (1026,'Presentismo','-',1002),
      (1027,'Feriados','-',1002),
      (1028,'Aportes SS / OS','-',1002),
      (1029,'Contribuciones SS / OS','-',1002),
      (1030,'ART','-',1002),
      (1031,'Sindicato','-',1002),
      (1032,'Seguro colectivo de vida','-',1002),
      (1033,'Uniforme','-',1002),
      (1034,'Comida personal','-',1002),
      (1035,'Capacitaciones','-',1002),
      (1036,'Preocupacional','-',1002),
      (1037,'Viáticos','-',1002),
      (1038,'Energía eléctrica','-',1003),
      (1039,'Gas','-',1003),
      (1040,'Agua','-',1003),
      (1041,'Internet','-',1003),
      (1042,'Telefonía','-',1003),
      (1043,'Cable','-',1003),
      (1044,'Sistema POS','-',1003),
      (1045,'Contador','-',1003),
      (1046,'Abogacía','-',1003),
      (1047,'Fumigación','-',1003),
      (1048,'Alarma','-',1003),
      (1049,'Arancel tarjeta crédito','-',1003),
      (1050,'Arancel tarjeta débito','-',1003),
      (1051,'Comisiones bancarias','-',1003),
      (1052,'MercadoPago','-',1003),
      (1053,'Hosting','-',1003),
      (1054,'Música (Spotify)','-',1003),
      (1055,'Comisión PedidosYa','-',1004),
      (1056,'Rappi','-',1004),
      (1057,'Uber Eats','-',1004),
      (1058,'Reclamos delivery','-',1004),
      (1059,'IVA','-',1005),
      (1060,'Ingresos brutos','-',1005),
      (1061,'Ganancias','-',1005),
      (1062,'Percepción IVA','-',1005),
      (1063,'Percepción IIBB','-',1005),
      (1064,'Percepción Ganancias','-',1005),
      (1065,'Imp. débitos y créditos','-',1005),
      (1066,'Seguridad e higiene','-',1005),
      (1067,'SADAIC / AADI-CAPIF','-',1005),
      (1068,'Monotributo','-',1005),
      (1069,'Autónomos','-',1005),
      (1070,'Plan de pago IVA','-',1005),
      (1071,'Plan de pago IIBB','-',1005),
      (1072,'Alquiler','-',1006),
      (1073,'Impuesto inmobiliario','-',1006),
      (1074,'Impuesto municipal','-',1006),
      (1075,'Mantenimiento general','-',1007),
      (1076,'Electricista','-',1007),
      (1077,'Plomería','-',1007),
      (1078,'Reparación maquinarias','-',1007),
      (1079,'Ferretería','-',1007),
      (1080,'Lavadero','-',1007),
      (1081,'Limpieza de campana','-',1007),
      (1082,'Vidrios','-',1007),
      (1083,'PC','-',1007),
      (1084,'Vajilla','-',1008),
      (1085,'Cristalería','-',1008),
      (1086,'Cubiertos','-',1008),
      (1087,'Mantelería','-',1008),
      (1088,'Art. de limpieza','-',1009),
      (1089,'Papelera','-',1009),
      (1090,'Librería','-',1009),
      (1091,'Imprenta','-',1009),
      (1092,'Flete','-',1009),
      (1093,'Garrafa','-',1009),
      (1094,'Roturas / desperdicio','-',1009),
      (1095,'Redes sociales','-',1010),
      (1096,'Fotógrafo','-',1010),
      (1097,'Influencers','-',1010),
      (1098,'Publicidad varios','-',1010),
      (1099,'Remodelaciones','-',1011),
      (1100,'Muebles','-',1011),
      (1101,'Maquinaria / equipamiento','-',1011),
      (1102,'Vajilla (inversión)','-',1011),
      (1103,'Intereses de financiación','-',1012),
      (1104,'Intereses de descubierto','-',1012),
      (1105,'Aporte de socio','+',1013),
      (1106,'Retiro de socio','-',1013),
      (1107,'Saldo inicial caja','+',1013),
      (1108,'Venta de aceite usado','+',1014),
      (1109,'Venta de equipamiento','+',1014),
      (1110,'Invitaciones','-',1015)
    ) AS v(codigo, nombre, tipo, rubro)
  WHERE NOT EXISTS (SELECT 1 FROM gestion_conceptos_caja c WHERE c.organization_id = org AND c.codigo = v.codigo::text);

  -- Variables del punto de equilibrio (criterio de Diego 30/10): Mercaderías, Otros gastos, Impuestos y Feriados.
  INSERT INTO gestion_equilibrio_variables (business_id, tipo, codigo, pct)
  SELECT biz, v.tipo, v.codigo, 100 FROM (VALUES ('rubro','1001'),('rubro','1005'),('rubro','1009'),('concepto','1027')) AS v(tipo, codigo)
  WHERE NOT EXISTS (SELECT 1 FROM gestion_equilibrio_variables e WHERE e.business_id = biz AND e.tipo = v.tipo AND e.codigo = v.codigo);

  -- Rubros de insumo: los que DEMO ya tenía con otro nombre se quedan y toman el concepto de su equivalente.
  WITH plant(nombre, cpto, elab) AS (VALUES
      ('Almacén',1001,false),
      ('Aceites',1002,false),
      ('Envasados',1003,false),
      ('Bebidas con alcohol',1004,false),
      ('Bebidas sin alcohol',1005,false),
      ('Barriles y cervezas',1004,false),
      ('Vinos / champagnes',1006,false),
      ('Carnes',1007,false),
      ('Verdulería',1008,false),
      ('Frutas',1009,false),
      ('Lácteos',1010,false),
      ('Quesos y fiambres',1011,false),
      ('Panadería',1012,false),
      ('Pescadería',1013,false),
      ('Especias',1014,false),
      ('Cafetería',1015,false),
      ('Pastelería',1015,false),
      ('Hielo',1017,false),
      ('Packaging',1089,false),
      ('Art. de limpieza',1088,false),
      ('Papelera',1089,false),
      ('Librería',1090,false),
      ('Imprenta',1091,false),
      ('Botiquín',1088,false),
      ('Vajilla',1084,false),
      ('Cristalería',1085,false),
      ('Cubiertos',1086,false),
      ('Mantelería',1087,false),
      ('Mantenimiento',1075,false),
      ('Maquinaria cocina',1078,false),
      ('Ropa de trabajo',1033,false),
      ('Elaborados cocina',NULL,true),
      ('Elaborados salsas',NULL,true),
      ('Elaborados postres',NULL,true),
      ('Elaborados panadería',NULL,true),
      ('Elaborados barra',NULL,true),
      ('Herramientas cocina',NULL,false),
      ('Herramientas barra',NULL,false),
      ('Herramientas salón',NULL,false)
    ), sin(viejo, nuevo) AS (VALUES ('Verduras','Verdulería'),('Panificados','Panadería'),('Fiambres','Quesos y fiambres'),('Elaborados','Elaborados cocina')),
  norm AS (SELECT r.id, lower(translate(trim(r.nombre), 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) AS n FROM insumo_rubros r WHERE r.business_id = biz)
  UPDATE insumo_rubros r SET cpto_caja_lazarillo = p.cpto, es_elaborador = p.elab, updated_at = now()
    FROM norm, plant p
   WHERE r.id = norm.id AND r.cpto_caja_lazarillo IS NULL
     AND lower(translate(p.nombre, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) = COALESCE(
           (SELECT lower(translate(s.nuevo, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) FROM sin s WHERE lower(translate(s.viejo, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) = norm.n), norm.n);

  SELECT GREATEST(COALESCE(MAX(codigo_maxi), 0) + 1, 9000) INTO prox FROM insumo_rubros WHERE business_id = biz;
  WITH plant(nombre, cpto, elab) AS (VALUES
      ('Almacén',1001,false),
      ('Aceites',1002,false),
      ('Envasados',1003,false),
      ('Bebidas con alcohol',1004,false),
      ('Bebidas sin alcohol',1005,false),
      ('Barriles y cervezas',1004,false),
      ('Vinos / champagnes',1006,false),
      ('Carnes',1007,false),
      ('Verdulería',1008,false),
      ('Frutas',1009,false),
      ('Lácteos',1010,false),
      ('Quesos y fiambres',1011,false),
      ('Panadería',1012,false),
      ('Pescadería',1013,false),
      ('Especias',1014,false),
      ('Cafetería',1015,false),
      ('Pastelería',1015,false),
      ('Hielo',1017,false),
      ('Packaging',1089,false),
      ('Art. de limpieza',1088,false),
      ('Papelera',1089,false),
      ('Librería',1090,false),
      ('Imprenta',1091,false),
      ('Botiquín',1088,false),
      ('Vajilla',1084,false),
      ('Cristalería',1085,false),
      ('Cubiertos',1086,false),
      ('Mantelería',1087,false),
      ('Mantenimiento',1075,false),
      ('Maquinaria cocina',1078,false),
      ('Ropa de trabajo',1033,false),
      ('Elaborados cocina',NULL,true),
      ('Elaborados salsas',NULL,true),
      ('Elaborados postres',NULL,true),
      ('Elaborados panadería',NULL,true),
      ('Elaborados barra',NULL,true),
      ('Herramientas cocina',NULL,false),
      ('Herramientas barra',NULL,false),
      ('Herramientas salón',NULL,false)
    ), sin(viejo, nuevo) AS (VALUES ('Verduras','Verdulería'),('Panificados','Panadería'),('Fiambres','Quesos y fiambres'),('Elaborados','Elaborados cocina')),
  ya AS (
    SELECT lower(translate(trim(r.nombre), 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) AS n FROM insumo_rubros r WHERE r.business_id = biz
    UNION SELECT lower(translate(s.nuevo, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) FROM sin s
      JOIN insumo_rubros r ON r.business_id = biz AND lower(translate(trim(r.nombre), 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) = lower(translate(s.viejo, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU'))),
  nuevos AS (
    SELECT p.*, row_number() OVER () - 1 AS k FROM plant p
     WHERE lower(translate(p.nombre, 'áéíóúÁÉÍÓÚ', 'aeiouAEIOU')) NOT IN (SELECT n FROM ya))
  INSERT INTO insumo_rubros (business_id, codigo, codigo_maxi, nombre, cpto_caja_lazarillo, es_elaborador, activo)
  SELECT biz, prox + k, prox + k, nombre, cpto, elab, true FROM nuevos;

  INSERT INTO gestion_plantilla_aplicada (organization_id, origen) VALUES (org, 'plantilla 14/11/2026 (129)');
END $$;
