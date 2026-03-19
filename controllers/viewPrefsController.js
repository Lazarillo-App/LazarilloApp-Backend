
// ── POST /businesses/:id/view-prefs ──
// Body: { agrupacionId, viewMode, divisionId?, scope? }
exports.saveViewPref = async (req, res) => {
  try {
    const businessId = Number(req.params.id);
    const agrupacionId = Number(req.body?.agrupacionId);
    const viewMode = String(req.body?.viewMode || '').trim();
    const divisionId = req.body?.divisionId ? Number(req.body.divisionId) : null;
    const scope = req.body?.scope || 'articulo'; // default 'articulo' para compatibilidad
 
    if (!Number.isFinite(businessId) || !Number.isFinite(agrupacionId) || !viewMode) {
      return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
    }
 
    const divVal = Number.isFinite(divisionId) ? divisionId : null;
 
    await pool.query(
      `INSERT INTO business_view_prefs (business_id, agrupacion_id, view_mode, division_id, scope)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, agrupacion_id, COALESCE(division_id, 0), COALESCE(scope, 'articulo'))
       DO UPDATE SET view_mode = EXCLUDED.view_mode, updated_at = NOW()`,
      [businessId, agrupacionId, viewMode, divVal, scope]
    );
 
    return res.json({ ok: true });
  } catch (e) {
    // Si falla el ON CONFLICT (constraint no existe), intentar upsert manual
    if (e.code === '42P10' || e.code === '23505') {
      try {
        const divVal = Number.isFinite(Number(req.body?.divisionId)) ? Number(req.body.divisionId) : null;
        const scope = req.body?.scope || 'articulo';
        const businessId = Number(req.params.id);
        const agrupacionId = Number(req.body?.agrupacionId);
        const viewMode = String(req.body?.viewMode || '');
 
        // Intentar UPDATE primero, luego INSERT
        const upd = await pool.query(
          `UPDATE business_view_prefs
             SET view_mode = $1, updated_at = NOW()
           WHERE business_id = $2 AND agrupacion_id = $3
             AND (division_id = $4 OR (division_id IS NULL AND $4 IS NULL))
             AND (scope = $5 OR (scope IS NULL AND $5 = 'articulo'))`,
          [viewMode, businessId, agrupacionId, divVal, scope]
        );
        if (!upd.rowCount) {
          await pool.query(
            `INSERT INTO business_view_prefs (business_id, agrupacion_id, view_mode, division_id, scope)
             VALUES ($1, $2, $3, $4, $5)`,
            [businessId, agrupacionId, viewMode, divVal, scope]
          );
        }
        return res.json({ ok: true });
      } catch (e2) {
        console.error('saveViewPref fallback error:', e2.message);
      }
    }
    console.error('saveViewPref error:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
