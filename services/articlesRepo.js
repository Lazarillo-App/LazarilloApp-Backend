// services/articlesRepo.js
const pool = require('../config/db');

// Devuelve filas normalizadas (ya usando la taxonomía)
async function fetchArticlesFlat(businessId) {
  const sql = `
    SELECT
      s.nombre AS subrubro,
      c.nombre AS categoria,
      a.id, a.name AS nombre,
      a.price AS precio,
      COALESCE(a.costo, 0) AS costo
    FROM app_articles a
    JOIN categorias c ON c.id = a.categoria_id
    JOIN subrubros s ON s.id = a.subrubro_id
    WHERE a.business_id = $1
  `;
  const { rows } = await pool.query(sql, [businessId]);
  return rows;
}

// Agrupa a -> [{ subrubro, categorias: [{ categoria, articulos: [...] }] }]
function buildTree(rows) {
  const bySub = new Map();
  for (const r of rows) {
    if (!bySub.has(r.subrubro)) bySub.set(r.subrubro, new Map());
    const byCat = bySub.get(r.subrubro);
    if (!byCat.has(r.categoria)) byCat.set(r.categoria, []);
    byCat.get(r.categoria).push({
      id: Number(r.id),
      nombre: r.nombre,
      precio: Number(r.precio || 0),
      costo: Number(r.costo || 0),
    });
  }
  return Array.from(bySub, ([subrubro, byCat]) => ({
    subrubro,
    categorias: Array.from(byCat, ([categoria, articulos]) => ({ categoria, articulos })),
  }));
}

async function fetchArticlesTree(businessId) {
  const flat = await fetchArticlesFlat(businessId);
  return buildTree(flat);
}

module.exports = { fetchArticlesFlat, fetchArticlesTree };
