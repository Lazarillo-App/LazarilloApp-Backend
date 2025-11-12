// src/componentes/BusinessSyncPanel.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useState } from "react";
import { BusinessesAPI } from "@/servicios/apiBusinesses";

// MUI (usa el bundle que ya venís usando)
import {
  Box, Button, CircularProgress, IconButton, Paper, Stack, TextField, Typography,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, TablePagination,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import CloudSyncIcon from "@mui/icons-material/CloudSync";
import InventoryIcon from "@mui/icons-material/Inventory";
import DateRangeIcon from "@mui/icons-material/DateRange";

// Helpers fecha
const pad2 = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
};
const last7dUntilYesterday = () => {
  const y = yesterday();
  const from = new Date(y);
  from.setDate(from.getDate() - 6);
  return { from: toISO(from), to: toISO(y) };
};

export default function BusinessSyncPanel({ businessId: propBizId }) {
  const [bizId, setBizId] = useState(() => propBizId || Number(localStorage.getItem("activeBusinessId") || "0"));
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRpp] = useState(25);

  const def = last7dUntilYesterday();
  const [from, setFrom] = useState(def.from);
  const [to, setTo] = useState(def.to);

  // ========= Carga de artículos =========
  async function loadArticles(id = bizId) {
    if (!Number.isFinite(id) || id <= 0) return;
    setLoading(true);
    setError("");
    try {
      const data = await BusinessesAPI.articlesFromDB(id);
      const items = data?.items ?? [];
      setRows(items);
    } catch (e) {
      console.error("articlesFromDB error:", e);
      setError(e?.message || "Error cargando artículos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!bizId) {
      const stored = Number(localStorage.getItem("activeBusinessId") || "0");
      if (stored) setBizId(stored);
    }
  }, [bizId]);

  useEffect(() => {
    if (bizId) loadArticles(bizId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bizId]);

  // ========= Acciones de Sync =========
  const syncCatalog = async () => {
    if (!bizId) return;
    setSyncing(true);
    setError("");
    try {
      const res = await BusinessesAPI.syncNow(bizId, { scope: "articles" });
      console.log("sync catalog:", res);
      await loadArticles(bizId);
    } catch (e) {
      console.error("sync catalog error:", e);
      setError(e?.message || "Falló la sincronización de catálogo");
    } finally {
      setSyncing(false);
    }
  };

  const syncSalesAuto = async () => {
    if (!bizId) return;
    setSyncing(true);
    setError("");
    try {
      const res = await BusinessesAPI.syncSales(bizId, { mode: "auto" });
      console.log("sync sales auto:", res);
    } catch (e) {
      console.error("sync sales auto error:", e);
      setError(e?.message || "Falló la sincronización de ventas (auto)");
    } finally {
      setSyncing(false);
    }
  };

  const syncSalesLast7 = async () => {
    if (!bizId) return;
    setSyncing(true);
    setError("");
    try {
      const res = await BusinessesAPI.syncSalesLast7d(bizId);
      console.log("sync sales last7d:", res);
    } catch (e) {
      console.error("sync sales last7d error:", e);
      setError(e?.message || "Falló la sincronización de ventas (7 días)");
    } finally {
      setSyncing(false);
    }
  };

  const syncSalesRange = async () => {
    if (!bizId) return;
    if (!from || !to) {
      setError("Seleccioná un rango válido (from/to).");
      return;
    }
    setSyncing(true);
    setError("");
    try {
      const res = await BusinessesAPI.syncSales(bizId, { mode: "range", from, to });
      console.log("sync sales range:", res);
    } catch (e) {
      console.error("sync sales range error:", e);
      setError(e?.message || "Falló la sincronización de ventas (rango)");
    } finally {
      setSyncing(false);
    }
  };

  // ========= Filtro local =========
  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) =>
      (r?.nombre || "").toLowerCase().includes(q) ||
      (r?.categoria || "").toLowerCase().includes(q) ||
      (r?.subrubro || "").toLowerCase().includes(q) ||
      String(r?.articulo_id || "").includes(q)
    );
  }, [rows, search]);

  const paged = useMemo(() => {
    const start = page * rowsPerPage;
    return filtered.slice(start, start + rowsPerPage);
  }, [filtered, page, rowsPerPage]);

  // ========= UI =========
  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={2} flexWrap="wrap">
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          Catálogo & Ventas — Negocio #{bizId || "—"}
        </Typography>

        <Stack direction="row" gap={1} flexWrap="wrap">
          <TextField
            size="small"
            placeholder="Buscar (nombre, categoría, subrubro, ID)"
            value={search}
            onChange={(e) => { setPage(0); setSearch(e.target.value); }}
          />

          <IconButton aria-label="Refrescar" onClick={() => loadArticles()} disabled={loading || syncing}>
            {loading ? <CircularProgress size={22} /> : <RefreshIcon />}
          </IconButton>
        </Stack>
      </Stack>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
          <Button
            variant="contained"
            startIcon={<InventoryIcon />}
            onClick={syncCatalog}
            disabled={syncing || loading || !bizId}
          >
            Sync Catálogo
          </Button>

          <Button
            variant="outlined"
            startIcon={<CloudSyncIcon />}
            onClick={syncSalesAuto}
            disabled={syncing || loading || !bizId}
          >
            Ventas (auto)
          </Button>

          <Button
            variant="outlined"
            startIcon={<CloudSyncIcon />}
            onClick={syncSalesLast7}
            disabled={syncing || loading || !bizId}
          >
            Ventas (últ. 7 días)
          </Button>

          <Stack direction="row" gap={1} alignItems="center" sx={{ ml: { xs: 0, sm: 2 } }} flexWrap="wrap">
            <DateRangeIcon fontSize="small" />
            <TextField
              type="date"
              size="small"
              label="Desde"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              type="date"
              size="small"
              label="Hasta"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
            <Button
              variant="outlined"
              startIcon={<CloudSyncIcon />}
              onClick={syncSalesRange}
              disabled={syncing || loading || !bizId}
            >
              Ventas (rango)
            </Button>
          </Stack>

          {(loading || syncing) && (
            <Stack direction="row" alignItems="center" gap={1} sx={{ ml: "auto" }}>
              <CircularProgress size={18} />
              <Typography variant="body2" color="text.secondary">
                {loading ? "Cargando artículos…" : "Sincronizando…"}
              </Typography>
            </Stack>
          )}
        </Stack>

        {error && (
          <Typography sx={{ mt: 2 }} color="error">
            {error}
          </Typography>
        )}
      </Paper>

      <Paper variant="outlined">
        <TableContainer sx={{ maxHeight: 560 }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow>
                <TableCell width={110}>ID</TableCell>
                <TableCell>Nombre</TableCell>
                <TableCell width={220}>Categoría</TableCell>
                <TableCell width={220}>Subrubro</TableCell>
                <TableCell align="right" width={120}>Precio</TableCell>
                <TableCell align="right" width={120}>Costo</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {paged.map((r) => (
                <TableRow key={`${r.articulo_id}`} hover>
                  <TableCell>{r.articulo_id}</TableCell>
                  <TableCell>{r.nombre}</TableCell>
                  <TableCell>{r.categoria}</TableCell>
                  <TableCell>{r.subrubro}</TableCell>
                  <TableCell align="right">{Number(r.precio ?? 0).toFixed(2)}</TableCell>
                  <TableCell align="right">{Number(r.costo ?? 0).toFixed(2)}</TableCell>
                </TableRow>
              ))}
              {paged.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 6, color: "text.secondary" }}>
                    Sin datos para mostrar. Probá **Sync Catálogo** 😉
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>

        <TablePagination
          component="div"
          count={filtered.length}
          page={page}
          onPageChange={(_e, p) => setPage(p)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(e) => { setRpp(parseInt(e.target.value, 10)); setPage(0); }}
          rowsPerPageOptions={[10, 25, 50, 100]}
        />
      </Paper>
    </Stack>
  );
}
