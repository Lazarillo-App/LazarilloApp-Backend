// servicios/apiBranches.js
// Espejo del patrón de BusinessesAPI que ya existe en la app

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "https://lazarilloapp-backend.onrender.com";

async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const BranchesAPI = {
  // Lista todas las sucursales de un negocio
  list: (bizId) =>
    apiFetch(`/api/businesses/${bizId}/branches`),

  // Devuelve { hasBranches: bool, count: number }
  hasBranches: (bizId) =>
    apiFetch(`/api/businesses/${bizId}/branches/has-branches`),

  // Obtiene una sucursal por ID
  get: (bizId, branchId) =>
    apiFetch(`/api/businesses/${bizId}/branches/${branchId}`),

  // Crea una nueva sucursal
  // payload: { name, color?, logo_url?, address?, contacts?, props? }
  create: (bizId, payload) =>
    apiFetch(`/api/businesses/${bizId}/branches`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // Actualización parcial (PATCH)
  update: (bizId, branchId, payload) =>
    apiFetch(`/api/businesses/${bizId}/branches/${branchId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  // Eliminar (solo si no tiene ventas)
  delete: (bizId, branchId) =>
    apiFetch(`/api/businesses/${bizId}/branches/${branchId}`, {
      method: "DELETE",
    }),
};