// config/features.js

/**
 * Feature flags del sistema
 * Permite habilitar/deshabilitar funcionalidades sin borrar código
 */
module.exports = {
  // Sincronización de ventas con Maxi API
  MAXI_SALES_SYNC_ENABLED: process.env.MAXI_SALES_SYNC_ENABLED === 'true', // Default: false
  
  // Importación manual de ventas vía CSV/XLS
  CSV_SALES_IMPORT_ENABLED: process.env.CSV_SALES_IMPORT_ENABLED !== 'false', // Default: true
  
  // Log detallado de importación
  VERBOSE_IMPORT_LOGS: process.env.VERBOSE_IMPORT_LOGS === 'true', // Default: false
  
  // Límite de filas por archivo (seguridad)
  MAX_IMPORT_ROWS: parseInt(process.env.MAX_IMPORT_ROWS || '100000', 10),
  
  // Tamaño máximo de archivo (MB)
  MAX_FILE_SIZE_MB: parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10)
};