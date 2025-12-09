// routes/diagnosticRoutes.js
const express = require('express');
const router = express.Router();
const { fetchSalesRanged } = require('../services/maxiSalesService');

router.get('/sales/raw/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { from, to } = req.query;

    console.log('=== DIAGNÓSTICO INICIADO ===');
    console.log('businessId:', businessId);
    console.log('from:', from);
    console.log('to:', to);

    const raw = await fetchSalesRanged({ 
      businessId, 
      from: from || '2025-12-01', 
      to: to || '2025-12-02', 
      req 
    });

    console.log('\n=== CANTIDAD DE ITEMS ===');
    console.log('Total facturas/ordenes:', raw.length);

    console.log('\n=== PRIMERA FACTURA/ORDEN (estructura) ===');
    console.log(JSON.stringify(raw[0], null, 2));

    console.log('\n=== SEGUNDA (si existe) ===');
    if (raw[1]) console.log(JSON.stringify(raw[1], null, 2));

    // También devolver por HTTP para ver en el navegador/Postman
    res.json({
      total: raw.length,
      primera: raw[0],
      segunda: raw[1] || null,
      sample_5: raw.slice(0, 5)
    });

  } catch (error) {
    console.error('Error en diagnóstico:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

module.exports = router;