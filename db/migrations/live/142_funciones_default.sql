-- 142: Funciones por negocio (Diego 17/11/2026). Por defecto, el área Administración (Conciliación,
-- Movimientos bancarios, Clientes) queda oculta para todos: todavía no está terminada. Los negocios
-- cuyo dueño es super usuario ven todo (lo resuelve ajustesService.efectivos).
-- Se inserta solo si no existe el default global: para mostrarla a todos se guarda la lista vacía
-- desde el panel (no borrar la fila, porque volvería en el próximo arranque).
INSERT INTO ajustes_alcance (clave, alcance, scope_id, valor, activo, nota)
SELECT 'modulos_ocultos', 'global', NULL, '["administracion"]'::jsonb, true, 'Funciones por negocio: default'
 WHERE NOT EXISTS (SELECT 1 FROM ajustes_alcance WHERE clave = 'modulos_ocultos' AND alcance = 'global');
