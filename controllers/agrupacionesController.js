const Rubro = require('../models/Rubro');
const Subrubro = require('../models/Subrubro');

exports.crearRubro = (req, res) => {
  const { nombre, descripcion } = req.body;

  if (!nombre) {
    return res.status(400).json({ error: 'El nombre del rubro es obligatorio' });
  }

  Rubro.crear(nombre, descripcion, (err, resultado) => {
    if (err) {
      console.error('❌ Error al crear rubro:', err);
      return res.status(500).json({ error: 'Error al guardar el rubro' });
    }

    res.status(201).json({ mensaje: 'Rubro creado exitosamente', id: resultado.insertId });
  });
};

exports.obtenerRubros = (req, res) => {
  Rubro.obtenerTodos((err, rubros) => {
    if (err) {
      console.error('❌ Error al obtener rubros:', err);
      return res.status(500).json({ error: 'Error al obtener rubros' });
    }

    res.status(200).json(rubros);
  });
};

exports.actualizarRubro = (req, res) => {
  const { id } = req.params;
  const { nombre, descripcion } = req.body;

  Rubro.actualizar(id, nombre, descripcion, (err, result) => {
    if (err) {
      console.error('❌ Error al actualizar rubro:', err);
      return res.status(500).json({ error: 'Error al actualizar rubro' });
    }

    res.status(200).json({ mensaje: 'Rubro actualizado correctamente' });
  });
};

exports.eliminarRubro = (req, res) => {
  const { id } = req.params;

  Rubro.eliminar(id, (err, result) => {
    if (err) {
      console.error('❌ Error al eliminar rubro:', err);
      return res.status(500).json({ error: 'Error al eliminar rubro' });
    }

    res.status(200).json({ mensaje: 'Rubro eliminado correctamente' });
  });
};

exports.crearSubrubro = async (req, res) => {
  try {
    const nuevoSubrubro = await Subrubro.crear(req.body);
    res.status(201).json(nuevoSubrubro);
  } catch (error) {
    console.error('❌ Error al crear subrubro:', error);
    res.status(500).json({ error: 'Error al crear subrubro' });
  }
};

exports.eliminarSubrubro = (req, res) => {
  const { id } = req.params;

  Subrubro.eliminar(id, (err, result) => {
    if (err) {
      console.error('❌ Error al eliminar subrubro:', err);
      return res.status(500).json({ error: 'Error al eliminar subrubro' });
    }

    res.status(200).json({ mensaje: 'Subrubro eliminado correctamente' });
  });
};

exports.obtenerSubrubrosPorRubro = (req, res) => {
  const { rubroId } = req.params;

  Subrubro.obtenerPorRubro(rubroId, (err, subrubros) => {
    if (err) {
      console.error('❌ Error al obtener subrubros:', err);
      return res.status(500).json({ error: 'Error al obtener subrubros' });
    }

    res.status(200).json(subrubros);
  });
};

exports.obtenerSubrubroPorId = (req, res) => {
  const { id } = req.params;
  Subrubro.obtenerPorId(id, (err, subrubro) => {
    if (err) {
      console.error('❌ Error al obtener subrubro:', err);
      return res.status(500).json({ error: 'Error al obtener subrubro' });
    }
    res.status(200).json(subrubro);
  });
};

exports.obtenerSubrubros = (req, res) => {
  Subrubro.obtenerTodos((err, subrubros) => {
    if (err) {
      console.error('❌ Error al obtener subrubros:', err);
      return res.status(500).json({ error: 'Error al obtener subrubros' });
    }
    res.status(200).json(subrubros);
  });
};
