// db/migrations.js
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

// JS migrations que SÍ corren (solo las que mantenés en live)
const m004 = require('./migrations/live/004_auth');
const m005 = require('./migrations/live/005_business_branding');

// 008 puede estar archivada; lo cargamos en try opcional
let m008 = null;
try { m008 = require('./migrations/live/008_agrupaciones_multitenant'); } catch { /* opcional */ }

async function runMigrations() {
  const exec = (sql, params = []) => pool.query(sql, params);
  const execSafe = async (sql, params = []) => {
    try { await exec(sql, params); }
    catch (e) {
      // Errores “inofensivos” para idempotencia
      if (['42710','42701','23505','42P07','23503'].includes(e.code)) return;
      throw e;
    }
  };

  console.log('📂 Usando base de datos PG:', process.env.PGDATABASE || '(desconocido)');

  /* ===== Extensiones necesarias ===== */
  await execSafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  await execSafe(`CREATE EXTENSION IF NOT EXISTS citext;`);
  await execSafe(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  /* ===== Núcleo JS (orden fijo) ===== */
  await m004.up(pool);               // auth/base
  await m005.up(pool);               // branding / bits de business
  if (m008 && typeof m008.up === 'function') {
    await m008.up(pool);             // agrupaciones multitenant (si se mantiene en live)
  }

  /* ===== Parches rápidos no versionados (si los necesitás en runtime) =====
     Mantengo acá SOLO lógica indispensable; todo lo demás debe estar en archivos .sql con prefijo numérico dentro de live/.
     Si ya lo movimos a .sql, podés borrar esta sección. */
  // (vacío a propósito)

  /* ===== Ejecutar archivos .sql de migrations/live (solo live) ===== */
  const liveDir = path.join(__dirname, 'migrations', 'live');
  const sqlFiles = fs.readdirSync(liveDir)
    .filter(f => f.toLowerCase().endsWith('.sql'))
    .sort(); // respeta 004_, 005_, 014_, 015_, 016_, 022_, 025_, etc.

  for (const f of sqlFiles) {
    const full = path.join(liveDir, f);
    const sql = fs.readFileSync(full, 'utf8');
    try {
      console.log('➡️ Ejecutando', f, '...');
      await pool.query(sql);
      console.log('✅', f, 'OK');
    } catch (e) {
      if (['42710','42701','23505','42P07','23503'].includes(e.code)) {
        console.log('⚠️', f, 'omitido por idempotencia:', e.code);
        continue;
      }
      console.error('❌ [db] query error:', {
        code: e.code, message: e.message, text: String(sql).slice(0, 200)
      });
      throw e; // detenemos para no dejar el esquema a medias
    }
  }
}

module.exports = { runMigrations };
