SELECT 'ventas' AS q, cod_suc, YEAR(fecha) AS anio, COUNT(*) AS filas, MIN(fecha) AS desde, MAX(fecha) AS hasta
FROM mxfac GROUP BY cod_suc, YEAR(fecha)
UNION ALL
SELECT 'compras', cod_suc, YEAR(fecha), COUNT(*), MIN(fecha), MAX(fecha) FROM mxitc GROUP BY cod_suc, YEAR(fecha)
UNION ALL
SELECT 'gastos', cod_suc, YEAR(fecha), COUNT(*), MIN(fecha), MAX(fecha) FROM mxgas GROUP BY cod_suc, YEAR(fecha)
ORDER BY 1,2,3;
