// routes/branches.js
const express = require("express");
const router = express.Router({ mergeParams: true }); // mergeParams para acceder a :bizId del padre
const {
  listBranches,
  getBranch,
  createBranch,
  updateBranch,
  deleteBranch,
  hasBranches,
} = require("../controllers/branchesController");

// Verificar si el negocio tiene sucursales (va antes del /:branchId para no colisionar)
router.get("/has-branches", hasBranches);

// CRUD principal
router.get("/",              listBranches);
router.get("/:branchId",    getBranch);
router.post("/",            createBranch);
router.patch("/:branchId",  updateBranch);
router.delete("/:branchId", deleteBranch);

module.exports = router;

// ─────────────────────────────────────────────────────────────
// REGISTRO EN app.js / index.js (agregar estas líneas):
// ─────────────────────────────────────────────────────────────
//
//   const branchesRouter = require("./routes/branches");
//   app.use("/api/businesses/:bizId/branches", branchesRouter);
//
// ─────────────────────────────────────────────────────────────
// ENDPOINTS RESULTANTES:
//
//   GET    /api/businesses/:bizId/branches              → lista sucursales
//   GET    /api/businesses/:bizId/branches/has-branches → booleano rápido
//   GET    /api/businesses/:bizId/branches/:branchId    → una sucursal
//   POST   /api/businesses/:bizId/branches              → crear sucursal
//   PATCH  /api/businesses/:bizId/branches/:branchId    → editar sucursal
//   DELETE /api/businesses/:bizId/branches/:branchId    → eliminar sucursal
// ─────────────────────────────────────────────────────────────