const db = require('../config/db');

const Rubro = {
    crear: (nombre, descripcion, callback) => {
        const query = 'INSERT INTO rubros (nombre, descripcion) VALUES (?, ?)';
        db.query(query, [nombre, descripcion], callback);
    },

    obtenerTodos: (callback) => {
        const query = 'SELECT * FROM rubros';
        db.query(query, callback);
    },

    actualizar: (id, nombre, descripcion, callback) => {
        const sql = 'UPDATE rubros SET nombre = ?, descripcion = ? WHERE id = ?';
        db.query(sql, [nombre, descripcion, id], callback);
    },

    eliminar: (id, callback) => {
        const sql = 'DELETE FROM rubros WHERE id = ?';
        db.query(sql, [id], callback);
    },
};

module.exports = Rubro;