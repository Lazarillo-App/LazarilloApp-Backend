// scripts/runAutoGrouping.js
const fetch = require('node-fetch');

(async () => {
  const base = 'http://localhost:3000';
  const businessId = Number(process.env.BID || 1);
  const strategy = process.env.STRATEGY || 'by-categoria'; // o 'by-subrubro'

  const r = await fetch(`${base}/businesses/${businessId}/agrupaciones/auto-from-taxonomy?strategy=${encodeURIComponent(strategy)}`, {
    method: 'POST',
    headers: {
      // Authorization: `Bearer ${process.env.API_TOKEN || ''}`, // si aplica
      'Content-Type': 'application/json'
    }
  });
  const j = await r.json().catch(()=> ({}));
  console.log(r.status, j);
})();
