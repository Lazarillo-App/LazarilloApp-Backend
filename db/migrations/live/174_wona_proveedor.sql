-- 174: Wona guarda el proveedor de cada producto del buffet (usuaria 25/11/2026: «los artículos se subieron como
-- insumos también»). Solo los productos CON proveedor se revenden y son artículo + insumo con receta de 1 u; los
-- que no tienen (WRAPS, tostados: se preparan) quedan solo como artículo. '' = leído sin proveedor; NULL = aún no
-- leído (no se toca). Ver services/wonaService.js (aplicarInsumos / quitarInsumosSinProveedor). Idempotente.
ALTER TABLE wona_productos ADD COLUMN IF NOT EXISTS proveedor text;
