require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// Middlewares
app.use(cors());
app.use(express.json());

// Rutas
const authRoutes = require('./routes/authRoutes');
app.use('/api/auth', authRoutes);
const agrupacionesRoutes = require('./routes/agrupacionesRoutes');
app.use('/api/agrupaciones', agrupacionesRoutes);

console.log('📂 Usando base de datos:', process.env.DB_NAME);

// Puerto
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
