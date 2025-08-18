// app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pool = require('./config/db');
const { runMigrations } = require('./db/migrations');

// ==== Inicialización ====
const app = express();

// ==== Middlewares globales (antes de rutas) ====
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://lazarillo.com.ar',
    'http://lazarillo.com.ar'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.use(express.json());

// ==== Rutas ====
app.use('/api/agrupaciones-insumos', require('./routes/agrupacionesInsumosRoutes'));
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/insumos', require('./routes/insumosRoutes'));
app.use('/api', require('./routes/agrupacionesRoutes')); // contiene /agrupaciones, /agrupaciones/todo, etc.

// ==== Healthchecks ====
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/health/db', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    res.json(rows[0]); // { ok: 1 }
  } catch (e) {
    console.error('DB health error:', e);
    res.status(500).json({ error: 'db down' });
  }
});

// ==== Logs útiles ====
console.log('📂 Usando base de datos PG:', process.env.PGDATABASE);

// ==== Arranque con migraciones ====
const PORT = process.env.PORT || 4000;
(async () => {
  try {
    await runMigrations();
    console.log('✅ Migraciones ejecutadas');
    app.listen(PORT, () => {
      console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Error ejecutando migraciones:', err);
    process.exit(1);
  }
})();
