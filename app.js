require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// CORS (frontend local y tu dominio en Wiroos)
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://lazarillo.com.ar',
    'http://lazarillo.com.ar'
  ],
  methods: ['GET','POST','PUT','DELETE','OPTIONS']
}));

app.use(express.json());

// Rutas
const authRoutes = require('./routes/authRoutes');
app.use('/api/auth', authRoutes);

const insumosRoutes = require('./routes/insumosRoutes');
app.use('/api/insumos', insumosRoutes);

const agrupacionesRoutes = require('./routes/agrupacionesRoutes');
app.use('/api', agrupacionesRoutes);

// Log correcto para PG
console.log('📂 Usando base de datos PG:', process.env.PGDATABASE);

// (opcional) healthcheck de DB
const pool = require('./config/db');
app.get('/health/db', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    res.json(rows[0]); // { ok: 1 }
  } catch (e) {
    console.error('DB health error:', e);
    res.status(500).json({ error: 'db down' });
  }
});

// Puerto API (evitamos 5000 porque lo usa tu PG)
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});