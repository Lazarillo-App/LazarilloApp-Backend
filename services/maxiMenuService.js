// services/maxiMenuService.js
const fetch = require('node-fetch');
const { getBearer } = require('./maxiSalesService');

const MAXI_BASE = process.env.MAXI_BASE_URL || 'https://api-mconn.maxisistemas.com.ar';

function buildMenuUrl({ listmode, list, id_tienda }) {
  const u = new URL(`${MAXI_BASE.replace(/\/+$/,'')}/menuweb/menuextendido`);
  if (listmode)  u.searchParams.set('listmode', listmode);   // ONLY | ATOM
  if (list)      u.searchParams.set('list', String(list));   // "3" o "1,2,3,4"
  if (id_tienda) u.searchParams.set('id_tienda', String(id_tienda));
  return u.toString();
}

async function fetchMenu({ businessId, req, listmode, list, id_tienda }) {
  const bearer = await getBearer(businessId, req); // respeta X-Maxi-Token o credenciales guardadas
  const url = buildMenuUrl({ listmode, list, id_tienda });

  const r = await fetch(url, { headers: {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json'
  }});
  const txt = await r.text().catch(()=> '');
  let j; try { j = JSON.parse(txt); } catch {}
  if (!r.ok || j?.resultCode !== 'SUCCESS') {
    const e = new Error(j?.resultDescription || r.statusText || 'menu fetch failed');
    e.status = r.status || 502;
    e._body = txt.slice(0, 400);
    throw e;
  }
  // Devuelve array de rubros (estructura del doc)
  return j?.content || [];
}

module.exports = { fetchMenu };
