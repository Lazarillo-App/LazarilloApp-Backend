// test-access.js
require('dotenv').config();
const { getEffectiveRole, listAccessibleBusinesses } = require('./services/auth/accessControl');

const USER_ID = 1;       // ← poné tu user_id (el del owner)
const BUSINESS_ID = 199; // ← el principal

(async () => {
  try {
    const role = await getEffectiveRole(USER_ID, BUSINESS_ID);
    console.log('Rol efectivo sobre biz', BUSINESS_ID, '→', role);

    const list = await listAccessibleBusinesses(USER_ID);
    console.log('Negocios accesibles:');
    console.table(list);
  } catch (e) {
    console.error('ERROR:', e);
  } finally {
    process.exit(0);
  }
})();