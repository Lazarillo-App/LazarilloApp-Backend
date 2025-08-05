const db = require('../config/db');

// 🔹 Crear una nueva agrupación con artículos asociados
exports.crearAgrupacion = async (req, res) => {
  const { nombre, articulos } = req.body;

  if (!nombre || !Array.isArray(articulos) || articulos.length === 0) {
    return res.status(400).json({ error: 'Nombre y lista de artículos son requeridos' });
  }

  try {
    // Insertar agrupación
    const insertAgrupacionQuery = 'INSERT INTO agrupaciones (nombre) VALUES (?)';
    const [agrupacionResult] = await db.promise().query(insertAgrupacionQuery, [nombre]);
    const agrupacionId = agrupacionResult.insertId;

    // Insertar artículos asociados
    const insertArticuloQuery = 'INSERT INTO agrupacion_articulos (agrupacion_id, articulo_id, articulo_nombre, categoria, subrubro) VALUES ?';
    const values = articulos.map(a => [agrupacionId, a.id, a.nombre, a.categoria, a.subrubro]);

    await db.promise().query(insertArticuloQuery, [values]);

    res.status(201).json({ mensaje: 'Agrupación creada con éxito', agrupacionId });
  } catch (error) {
    console.error('❌ Error al crear agrupación:', error);
    res.status(500).json({ error: 'Error al crear la agrupación' });
  }
};

// 🔹 Obtener todas las agrupaciones con sus artículos
exports.obtenerAgrupaciones = async (req, res) => {
  try {
    const [agrupaciones] = await db.promise().query('SELECT * FROM agrupaciones');

    const agrupacionesConArticulos = await Promise.all(
      agrupaciones.map(async (agrupacion) => {
        const [articulos] = await db.promise().query(
          'SELECT articulo_id AS id, articulo_nombre AS nombre, categoria, subrubro FROM agrupacion_articulos WHERE agrupacion_id = ?',
          [agrupacion.id]
        );
        return { ...agrupacion, articulos };
      })
    );

    res.status(200).json(agrupacionesConArticulos);
  } catch (error) {
    console.error('❌ Error al obtener agrupaciones:', error);
    res.status(500).json({ error: 'Error al obtener las agrupaciones' });
  }
};

// 🔹 Editar el nombre de una agrupación
exports.editarAgrupacion = async (req, res) => {
  const { id } = req.params;
  const { nombre } = req.body;

  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }

  try {
    await db.promise().query('UPDATE agrupaciones SET nombre = ? WHERE id = ?', [nombre, id]);
    res.status(200).json({ mensaje: 'Agrupación actualizada correctamente' });
  } catch (error) {
    console.error('❌ Error al actualizar agrupación:', error);
    res.status(500).json({ error: 'Error al actualizar la agrupación' });
  }
};

// 🔹 Eliminar agrupación y sus artículos
exports.eliminarAgrupacion = async (req, res) => {
  const { id } = req.params;

  try {
    await db.promise().query('DELETE FROM agrupacion_articulos WHERE agrupacion_id = ?', [id]);
    await db.promise().query('DELETE FROM agrupaciones WHERE id = ?', [id]);

    res.status(200).json({ mensaje: 'Agrupación eliminada correctamente' });
  } catch (error) {
    console.error('❌ Error al eliminar agrupación:', error);
    res.status(500).json({ error: 'Error al eliminar la agrupación' });
  }
};

// 🔹 Agregar nuevos artículos a una agrupación existente
exports.agregarArticulosAgrupacion = async (req, res) => {
  const { id } = req.params; // agrupacion_id
  const { articulos } = req.body;

  if (!Array.isArray(articulos) || articulos.length === 0) {
    return res.status(400).json({ error: 'Debe proporcionar una lista de artículos' });
  }

  try {
    const values = articulos.map(a => [id, a.id, a.nombre, a.categoria, a.subrubro]);

    const insertQuery = `
      INSERT INTO agrupacion_articulos 
      (agrupacion_id, articulo_id, articulo_nombre, categoria, subrubro) 
      VALUES ?
    `;

    await db.promise().query(insertQuery, [values]);

    res.status(200).json({ mensaje: 'Artículos agregados correctamente a la agrupación' });
  } catch (error) {
    console.error('❌ Error al agregar artículos a la agrupación:', error);
    res.status(500).json({ error: 'Error al agregar artículos a la agrupación' });
  }
};

// 🔹 Eliminar un artículo de una agrupación
exports.eliminarArticuloDeAgrupacion = async (req, res) => {
  const { id, articuloId } = req.params;

  try {
    const deleteQuery = `
      DELETE FROM agrupacion_articulos 
      WHERE agrupacion_id = ? AND articulo_id = ?
    `;

    await db.promise().query(deleteQuery, [id, articuloId]);

    res.status(200).json({ mensaje: 'Artículo eliminado de la agrupación' });
  } catch (error) {
    console.error('❌ Error al eliminar artículo de la agrupación:', error);
    res.status(500).json({ error: 'Error al eliminar el artículo de la agrupación' });
  }
};
