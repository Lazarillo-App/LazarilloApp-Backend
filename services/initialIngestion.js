const { ensureInitialBackfillOnce } = require('./salesSyncPolicy');

/**
 * Lanza en background la ingesta inicial de ventas (últimos 7 días hasta ayer).
 * NO bloquea la respuesta del endpoint de creación de negocio.
 */
function triggerInitialWeekOnBusinessCreate(businessId, req) {
  // pequeño delay para permitir que el INSERT y sus commits terminen
  setTimeout(async () => {
    try {
      const r = await ensureInitialBackfillOnce({ businessId, days: 7, req });
      console.log('[initial-ingestion] done', { businessId, res: r });
    } catch (e) {
      console.error('[initial-ingestion] failed', { businessId, err: e?.message });
    }
  }, 150); // 150ms suele ser suficiente; ajustable
}

module.exports = { triggerInitialWeekOnBusinessCreate };
