require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  try {
    const connection = await mysql.createConnection({
      host: process.env.MY_HOST,
      user: process.env.MY_USER,
      password: process.env.MY_PASS,
      database: process.env.MY_DB,
      port: process.env.MY_PORT
    });
    console.log('✅ Conexión exitosa a MySQL');
    await connection.end();
  } catch (err) {
    console.error('❌ Error al conectar:', err.message);
  }
})();