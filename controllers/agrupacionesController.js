// controllers/agrupacionesController.js
const pool = require('../config/db');

// helper para inserts masivos
function buildBulkInsertPlaceholders(rowCount, colCount, startIndex = 1) {
  // Devuelve: "($1,$2,...),($n,...)" y el último índice usado
  const groups = [];
  let i = startIndex;
  for (let r = 0; r < rowCount; r++) {
    const placeholders = [];
    for (let c = 0; c < colCount; c++) {
      placeholders.push(`$${i++}`);
    }
    groups.push(`(${placeholders.join(',')})`);
  }
  return { text: groups.join(','), lastIndex: i - 1 };
}

// 🔹 Crear una nueva agrupación con artículos asociados
exports.crearAgrupacion = async (req, res) => {
  const { nombre, articulos } = req.body;

  if (!nombre || !Array.isArray(articulos) || articulos.length === 0) {
    return res.status(400).json({ error: 'Nombre y lista de artículos son requeridos' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert agrupación y obtener id
    const insertAgr = 'INSERT INTO agrupaciones (nombre) VALUES ($1) RETURNING id';
    const { rows: agrRows } = await client.query(insertAgr, [nombre]);
    const agrupacionId = agrRows[0].id;

    // Insert masivo de artículos
    const cols = ['agrupacion_id','articulo_id','articulo_nombre','categoria','subrubro','precio'];
    const values = [];
    for (const a of articulos) {
      values.push(
        agrupacionId,
        a.id,
        a.nombre,
        a.categoria || 'Sin categoría',
        a.subrubro || 'Sin subrubro',
        a.precio ?? 0
      );
    }
    const { text: placeholders } = buildBulkInsertPlaceholders(articulos.length, cols.length, 1);
    const insertArt = `
      INSERT INTO agrupacion_articulos (${cols.join(',')})
      VALUES ${placeholders}
    `;
    await client.query(insertArt, values);

    await client.query('COMMIT');
    res.status(201).json({ mensaje: 'Agrupación creada con éxito', agrupacionId });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error al crear agrupación:', error);
    res.status(500).json({ error: 'Error al crear la agrupación' });
  } finally {
    client.release();
  }
};

// 🔹 Obtener todas las agrupaciones con sus artículos
exports.obtenerAgrupaciones = async (_req, res) => {
  try {
    const { rows: agrupaciones } = await pool.query('SELECT * FROM agrupaciones ORDER BY id DESC');

    // Traer artículos por cada agrupación (simple y claro)
    const resultado = [];
    for (const agr of agrupaciones) {
      const { rows: articulos } = await pool.query(
        `SELECT 
           articulo_id AS id, 
           articulo_nombre AS nombre, 
           categoria, 
           subrubro, 
           precio
         FROM agrupacion_articulos
         WHERE agrupacion_id = $1
         ORDER BY id ASC`,
        [agr.id]
      );
      resultado.push({ ...agr, articulos });
    }

    res.status(200).json(resultado);
  } catch (error) {
    console.error('❌ Error al obtener agrupaciones:', error);
    res.status(500).json({ error: 'Error al obtener las agrupaciones' });
  }
};

// 🔹 Editar solo el nombre de una agrupación
exports.actualizarAgrupacion = async (req, res) => {
  const { id } = req.params;
  const { nombre } = req.body;

  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }

  try {
    await pool.query('UPDATE agrupaciones SET nombre = $1 WHERE id = $2', [nombre.trim(), id]);
    res.status(200).json({ mensaje: 'Nombre actualizado con éxito' });
  } catch (error) {
    console.error('❌ Error al actualizar nombre de agrupación:', error);
    res.status(500).json({ error: 'Error al actualizar el nombre de la agrupación' });
  }
};

// 🔹 Eliminar agrupación y sus artículos (ON DELETE CASCADE ya ayuda)
exports.eliminarAgrupacion = async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query('DELETE FROM agrupaciones WHERE id = $1', [id]);
    res.status(200).json({ mensaje: 'Agrupación eliminada correctamente' });
  } catch (error) {
    console.error('❌ Error al eliminar agrupación:', error);
    res.status(500).json({ error: 'Error al eliminar la agrupación' });
  }
};

// 🔹 Agregar nuevos artículos a una agrupación existente
exports.agregarArticulosAgrupacion = async (req, res) => {
  const { id } = req.params;
  const { articulos } = req.body;

  if (!Array.isArray(articulos) || articulos.length === 0) {
    return res.status(400).json({ error: 'Debe proporcionar una lista de artículos' });
  }

  try {
    const cols = ['agrupacion_id','articulo_id','articulo_nombre','categoria','subrubro','precio'];
    const values = [];
    for (const a of articulos) {
      values.push(
        id,
        a.id,
        a.nombre,
        a.categoria || 'Sin categoría',
        a.subrubro || 'Sin subrubro',
        a.precio ?? 0
      );
    }
    const { text: placeholders } = buildBulkInsertPlaceholders(articulos.length, cols.length, 1);
    const insertArt = `
      INSERT INTO agrupacion_articulos (${cols.join(',')})
      VALUES ${placeholders}
      ON CONFLICT (agrupacion_id, articulo_id) DO NOTHING
    `;
    await pool.query(insertArt, values);

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
    await pool.query(
      'DELETE FROM agrupacion_articulos WHERE agrupacion_id = $1 AND articulo_id = $2',
      [id, articuloId]
    );
    res.status(200).json({ mensaje: 'Artículo eliminado de la agrupación' });
  } catch (error) {
    console.error('❌ Error al eliminar artículo de la agrupación:', error);
    res.status(500).json({ error: 'Error al eliminar el artículo de la agrupación' });
  }
};

// === NUEVO: sincronizar insumos desde /estadisticas/compras ===
exports.syncDesdeCompras = async (req, res) => {
  try {
    const token = await obtenerTokenMaxi();

    // rango por defecto: últimos 7 días
    const hoy = new Date();
    const to = (req.body?.to) || hoy.toISOString().slice(0,10);
    const from = (req.body?.from) || new Date(hoy.getTime() - 6*86400000).toISOString().slice(0,10);

    // llamada a compras
    const { data } = await axios.post(
      `${BASE}/estadisticas/compras`,
      { from, to },  // ¡RAW JSON! solo fechas al principio
      {
        headers: { Authorization: token, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    // validación de respuesta
    if (data?.resultCode !== 'SUCCESS') {
      return res.status(502).json({ ok:false, error: data?.resultDescription || 'Fallo compras' });
    }

    // lista de comprobantes
    const docs = data?.content?.content || [];
    // recolectamos insumos de todos los items
    const map = new Map();
    for (const doc of docs) {
      const items = Array.isArray(doc?.items) ? doc.items : [];
      for (const it of items) {
        const codigo = it?.insumo;              // viene como número
        if (!codigo || Number(codigo) === 0) continue; // descartamos 0/undefined
        const precio = Number(it?.precio) || 0;

        // si ya lo vimos, podemos actualizar el precio_ref con el último encontrado
        map.set(String(codigo), { codigo_maxi: String(codigo), precio_ref: precio });
      }
    }

    if (map.size === 0) {
      return res.json({ ok:true, total:0, from, to, note: 'No se hallaron insumos en el rango' });
    }

    // UPSERT en transacción
    const client = await pool.connect();
    let count = 0;
    try {
      await client.query('BEGIN');
      for (const { codigo_maxi, precio_ref } of map.values()) {
        await client.query(
          `INSERT INTO insumos (codigo_maxi, nombre, rubro, unidad_med, precio_ref, origen, activo)
           VALUES ($1, $2, $3, $4, $5, 'compras', TRUE)
           ON CONFLICT (codigo_maxi) DO UPDATE SET
             precio_ref = EXCLUDED.precio_ref,
             origen = 'compras',
             activo = TRUE,
             updated_at = NOW()`,
          [codigo_maxi, '', null, null, precio_ref]
        );
        count++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ ok:true, total: count, from, to });
  } catch (e) {
    console.error('syncDesdeCompras error:', e?.response?.data || e.message);
    res.status(500).json({ ok:false, error: e?.message || 'error' });
  }
};