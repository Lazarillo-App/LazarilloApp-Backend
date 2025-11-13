// middleware/cors.js
const cors = require('cors');

const corsWithCache = cors({
  origin: [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://lazarillo.com.ar',
    'http://lazarillo.com.ar',
    'https://www.lazarillo.com.ar',
    'https://lazarillo-app.github.io',
  ],
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Business-Id','X-Maxi-Token','X-Cron-Secret'],
  credentials: false,
  optionsSuccessStatus: 204,
  preflightContinue: false,
  maxAge: 86400, 
});

module.exports = corsWithCache;
