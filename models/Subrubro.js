const db = require('../config/db');

const Subrubro = {
  crear: (datos) => {
    return new Promise((resolve, reject) => {
      const { nombre, descripcion, rubro_id } = datos;

      const sql = 'INSERT INTO subrubros (nombre, descripcion, rubro_id) VALUES (?, ?, ?)';

      db.query(sql, [nombre, descripcion, rubro_id], (err, resultado) => {
        if (err) {
          console.error('❌ Error en la consulta SQL:', err);
          return reject(err);
        }

        resolve({ id: resultado.insertId, ...datos });
      });
    });
  },

  eliminar: (id, callback) => {
    const query = 'DELETE FROM subrubros WHERE id = ?';
    db.query(query, [id], callback);
  },

  obtenerPorRubro: (rubroId, callback) => {
    const query = 'SELECT * FROM subrubros WHERE rubro_id = ?';
    db.query(query, [rubroId], callback);
  },

  obtenerPorId: (id, callback) => {
  const query = 'SELECT * FROM subrubros WHERE id = ?';
  db.query(query, [id], callback);
},

obtenerTodos: (callback) => {
  const query = 'SELECT * FROM subrubros';
  db.query(query, callback);
},

};

module.exports = Subrubro;