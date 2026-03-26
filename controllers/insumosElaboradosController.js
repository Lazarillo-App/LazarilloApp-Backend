// backend/controllers/insumosElaboradosController.js
/**
 * Controlador para gestionar insumos elaborados
 * Endpoints para marcar insumos como elaborados y gestionar sus recetas
 */

const db = require('../config/db');

/**
 * PATCH /api/insumos/:id/elaborado
 * Marca o desmarca un insumo individual como elaborado
 */
async function toggleInsumoElaborado(req, res) {
  const { id } = req.params;
  const { es_elaborado } = req.body;
  const businessId = req.businessId || req.headers['x-business-id'];

  if (!businessId) {
    return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  }

  if (typeof es_elaborado !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'es_elaborado debe ser boolean' });
  }

  try {
    const result = await db.query(
      `UPDATE insumos 
       SET es_elaborado = $1, updated_at = NOW()
       WHERE id = $2 AND business_id = $3
       RETURNING *`,
      [es_elaborado, id, businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }

    res.json({
      ok: true,
      data: result.rows[0],
      message: es_elaborado ? 'Insumo marcado como elaborado' : 'Insumo marcado como no elaborado'
    });
  } catch (error) {
    console.error('Error en toggleInsumoElaborado:', error);
    res.status(500).json({ ok: false, error: 'Error al actualizar insumo' });
  }
}

/**
 * POST /api/insumos/elaborado/bulk
 * Marca múltiples insumos como elaborados de una vez
 */
async function toggleInsumosElaboradosBulk(req, res) {
  const { insumo_ids, es_elaborado } = req.body;
  const businessId = req.businessId || req.headers['x-business-id'];

  if (!businessId) {
    return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  }

  if (!Array.isArray(insumo_ids) || insumo_ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'insumo_ids debe ser un array no vacío' });
  }

  if (typeof es_elaborado !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'es_elaborado debe ser boolean' });
  }

  try {
    const result = await db.query(
      `UPDATE insumos 
       SET es_elaborado = $1, updated_at = NOW()
       WHERE id = ANY($2) AND business_id = $3
       RETURNING id`,
      [es_elaborado, insumo_ids, businessId]
    );

    res.json({
      ok: true,
      updated: result.rowCount,
      message: `${result.rowCount} insumo(s) actualizado(s)`
    });
  } catch (error) {
    console.error('Error en toggleInsumosElaboradosBulk:', error);
    res.status(500).json({ ok: false, error: 'Error al actualizar insumos' });
  }
}

/**
 * GET /api/insumos/elaborados
 * Lista todos los insumos marcados como elaborados
 */
async function listInsumosElaborados(req, res) {
  const businessId = req.businessId || req.headers['x-business-id'];
  const { sin_receta, con_receta, group_id } = req.query;

  if (!businessId) {
    return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  }

  try {
    let query = `
      SELECT 
        i.*,
        ir.id as receta_id,
        ir.costo_total as receta_costo_total,
        (SELECT COUNT(*) FROM insumos_recetas_items WHERE receta_id = ir.id) as receta_items_count
      FROM insumos i
      LEFT JOIN insumos_recetas ir ON ir.insumo_id = i.id AND ir.business_id = i.business_id
      WHERE i.business_id = $1 AND i.es_elaborado = TRUE
    `;

    const params = [businessId];
    let paramIndex = 2;

    // Filtros opcionales
    if (sin_receta === 'true') {
      query += ` AND i.tiene_receta = FALSE`;
    } else if (con_receta === 'true') {
      query += ` AND i.tiene_receta = TRUE`;
    }

    if (group_id) {
      query += ` AND EXISTS (
        SELECT 1 FROM insumo_group_items igi 
        WHERE igi.insumo_id = i.id AND igi.group_id = $${paramIndex}
      )`;
      params.push(group_id);
      paramIndex++;
    }

    query += ` ORDER BY i.nombre`;

    const result = await db.query(query, params);

    res.json({
      ok: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error en listInsumosElaborados:', error);
    res.status(500).json({ ok: false, error: 'Error al listar insumos elaborados' });
  }
}

/**
 * GET /api/insumos/elaborados/stats
 * Obtiene estadísticas de insumos elaborados
 */
async function getElaboradosStats(req, res) {
  const businessId = req.businessId || req.headers['x-business-id'];

  if (!businessId) {
    return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  }

  try {
    const result = await db.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN tiene_receta THEN 1 END) as con_receta,
        COUNT(CASE WHEN NOT tiene_receta THEN 1 END) as sin_receta,
        COALESCE(SUM(costo_receta), 0) as costo_total_recetas
       FROM insumos
       WHERE business_id = $1 AND es_elaborado = TRUE`,
      [businessId]
    );

    res.json({
      ok: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error en getElaboradosStats:', error);
    res.status(500).json({ ok: false, error: 'Error al obtener estadísticas' });
  }
}

/**
 * GET /api/insumos/:id/receta
 * Obtiene la receta de un insumo elaborado
 */
async function getInsumoReceta(req, res) {
  const { id } = req.params;
  const businessId = req.businessId || req.headers['x-business-id'];

  if (!businessId) {
    return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  }

  try {
    // Obtener la receta
    const recetaResult = await db.query(
      `SELECT * FROM insumos_recetas 
       WHERE insumo_id = $1 AND business_id = $2`,
      [id, businessId]
    );

    if (recetaResult.rows.length === 0) {
      return res.json({ ok: true, data: null }); // No tiene receta
    }

    const receta = recetaResult.rows[0];

    // Obtener los items de la receta
    const itemsResult = await db.query(
      `SELECT 
        iri.*,
        i.nombre as supply_nombre_actual,
        i.precio_ref as supply_precio_actual,
        i.unidad_med as supply_unidad_actual
       FROM insumos_recetas_items iri
       LEFT JOIN insumos i ON i.id = iri.supply_id
       WHERE iri.receta_id = $1
       ORDER BY iri.orden, iri.id`,
      [receta.id]
    );

    res.json({
      ok: true,
      data: {
        ...receta,
        items: itemsResult.rows
      }
    });
  } catch (error) {
    console.error('Error en getInsumoReceta:', error);
    res.status(500).json({ ok: false, error: 'Error al obtener receta' });
  }
}

/**
 * POST /api/insumos/:id/receta
 * Crea o actualiza la receta de un insumo elaborado
 */
async function saveInsumoReceta(req, res) {
  const { id } = req.params;
  const { nombre, porciones, porcentaje_venta, items } = req.body;
  const businessId = req.businessId || req.headers['x-business-id'];

  if (!businessId) {
    return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Verificar que el insumo existe y es elaborado
    const insumoCheck = await client.query(
      `SELECT es_elaborado FROM insumos WHERE id = $1 AND business_id = $2`,
      [id, businessId]
    );

    if (insumoCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    }

    if (!insumoCheck.rows[0].es_elaborado) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        ok: false, 
        error: 'El insumo debe estar marcado como elaborado para tener receta' 
      });
    }

    // Verificar si ya existe una receta
    const existingReceta = await client.query(
      `SELECT id FROM insumos_recetas WHERE insumo_id = $1 AND business_id = $2`,
      [id, businessId]
    );

    let recetaId;

    if (existingReceta.rows.length > 0) {
      // Actualizar receta existente
      recetaId = existingReceta.rows[0].id;
      
      await client.query(
        `UPDATE insumos_recetas 
         SET nombre = $1, porciones = $2, porcentaje_venta = $3, updated_at = NOW()
         WHERE id = $4`,
        [nombre, porciones || 1, porcentaje_venta || 30, recetaId]
      );

      // Eliminar items anteriores
      await client.query(
        `DELETE FROM insumos_recetas_items WHERE receta_id = $1`,
        [recetaId]
      );
    } else {
      // Crear nueva receta
      const newReceta = await client.query(
        `INSERT INTO insumos_recetas (business_id, insumo_id, nombre, porciones, porcentaje_venta)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [businessId, id, nombre, porciones || 1, porcentaje_venta || 30]
      );
      
      recetaId = newReceta.rows[0].id;
    }

    // Insertar items de la receta
    let costoTotal = 0;
    
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        
        const itemCostoTotal = item.tipo_costo === 'nulo' ? 0 : (item.costo_total || 0);
        costoTotal += itemCostoTotal;

        await client.query(
          `INSERT INTO insumos_recetas_items (
            receta_id, supply_id, supply_nombre, supply_medida, precio_ref_db,
            codigo_maxi, cantidad, unidad, costo_unitario, costo_total,
            merma, pedido, tipo_costo, observaciones, orden
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            recetaId,
            item.supplyId,
            item.supplyNombre,
            item.supplyMedida || 'u',
            item.precioRefDB || 0,
            item.codigoMaxi || null,
            item.cantidad || 0,
            item.unidad || 'u',
            item.costo_unitario || 0,
            itemCostoTotal,
            item.merma !== false,
            item.pedido !== false,
            item.tipoCosto || 'total',
            item.observaciones || null,
            i
          ]
        );
      }
    }

    // Actualizar costo total de la receta
    await client.query(
      `UPDATE insumos_recetas SET costo_total = $1 WHERE id = $2`,
      [costoTotal, recetaId]
    );

    // El trigger ya actualizará tiene_receta y costo_receta en la tabla insumos

    await client.query('COMMIT');

    res.json({
      ok: true,
      data: { receta_id: recetaId, costo_total: costoTotal },
      message: 'Receta guardada correctamente'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en saveInsumoReceta:', error);
    res.status(500).json({ ok: false, error: 'Error al guardar receta' });
  } finally {
    client.release();
  }
}

/**
 * DELETE /api/insumos/:id/receta
 * Elimina la receta de un insumo elaborado
 */
async function deleteInsumoReceta(req, res) {
  const { id } = req.params;
  const businessId = req.businessId || req.headers['x-business-id'];

  if (!businessId) {
    return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  }

  try {
    const result = await db.query(
      `DELETE FROM insumos_recetas 
       WHERE insumo_id = $1 AND business_id = $2
       RETURNING id`,
      [id, businessId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Receta no encontrada' });
    }

    // El trigger ya actualizará tiene_receta = false en la tabla insumos

    res.json({
      ok: true,
      message: 'Receta eliminada correctamente'
    });
  } catch (error) {
    console.error('Error en deleteInsumoReceta:', error);
    res.status(500).json({ ok: false, error: 'Error al eliminar receta' });
  }
}

/**
 * POST /api/insumos/elaborados/mover-a-grupo
 * Mueve todos los insumos elaborados a un grupo específico
 */
async function moverElaboradosAGrupo(req, res) {
  const { group_id } = req.body;
  const businessId = req.businessId || req.headers['x-business-id'];

  if (!businessId) {
    return res.status(400).json({ ok: false, error: 'Business ID requerido' });
  }

  if (!group_id) {
    return res.status(400).json({ ok: false, error: 'group_id requerido' });
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');

    // Verificar que el grupo existe
    const groupCheck = await client.query(
      `SELECT id FROM insumo_groups WHERE id = $1 AND business_id = $2`,
      [group_id, businessId]
    );

    if (groupCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });
    }

    // Obtener todos los insumos elaborados
    const elaborados = await client.query(
      `SELECT id FROM insumos WHERE business_id = $1 AND es_elaborado = TRUE`,
      [businessId]
    );

    if (elaborados.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, moved: 0, message: 'No hay insumos elaborados' });
    }

    const insumoIds = elaborados.rows.map(row => row.id);

    // Eliminar de otros grupos (excepto "Todo" y "Discontinuados")
    await client.query(
      `DELETE FROM insumo_group_items 
       WHERE insumo_id = ANY($1)
       AND group_id NOT IN (
         SELECT id FROM insumo_groups 
         WHERE business_id = $2 
         AND (LOWER(nombre) IN ('todo', 'sin agrupacion', 'sin agrupación', 'discontinuados'))
       )`,
      [insumoIds, businessId]
    );

    // Agregar al grupo seleccionado
    for (const insumoId of insumoIds) {
      await client.query(
        `INSERT INTO insumo_group_items (group_id, insumo_id)
         VALUES ($1, $2)
         ON CONFLICT (group_id, insumo_id) DO NOTHING`,
        [group_id, insumoId]
      );
    }

    await client.query('COMMIT');

    res.json({
      ok: true,
      moved: insumoIds.length,
      message: `${insumoIds.length} insumo(s) elaborado(s) movido(s) al grupo`
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en moverElaboradosAGrupo:', error);
    res.status(500).json({ ok: false, error: 'Error al mover insumos' });
  } finally {
    client.release();
  }
}

module.exports = {
  toggleInsumoElaborado,
  toggleInsumosElaboradosBulk,
  listInsumosElaborados,
  getElaboradosStats,
  getInsumoReceta,
  saveInsumoReceta,
  deleteInsumoReceta,
  moverElaboradosAGrupo,
};