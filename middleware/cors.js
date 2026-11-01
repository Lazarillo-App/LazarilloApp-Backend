// middleware/cors.js
const cors = require('cors');

const corsWithCache = cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:5180',
    'http://127.0.0.1:5180',
    'https://lazarillo.com.ar',
    'http://lazarillo.com.ar',
    'https://www.lazarillo.com.ar',
    'https://lazarillo-app.github.io',
    // Sitio de pruebas (rama testing publicada en Vercel)
    'https://lazarillo-testing.vercel.app',
    // Otros orígenes por variable, separados por coma (sin tocar código)
    ...String(process.env.CORS_EXTRA_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Business-Id',
    'X-Division-Id',
    'X-Maxi-Token',
    'X-Cron-Secret',
  ],
  credentials: false,
  optionsSuccessStatus: 204,
  preflightContinue: false,
  maxAge: 86400,
});

module.exports = corsWithCache;