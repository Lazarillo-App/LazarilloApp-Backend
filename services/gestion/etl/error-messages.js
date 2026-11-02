// Portado de lazarillo_gestion/lib/etl/error-messages.ts (TypeScript → JavaScript, misma lógica).
'use strict';

function translateError(raw) {
  if (/unique constraint/i.test(raw))
    return "Ya existe un registro con este código. El sistema lo omitió.";
  if (/foreign key constraint/i.test(raw))
    return "Hace referencia a un dato que no existe. Verificá que los maestros estén importados correctamente.";
  if (/no se pudo identificar el tipo/i.test(raw))
    return "El archivo no tiene el formato esperado. Verificá que sea un archivo exportado del sistema correcto.";
  if (/columnas encontradas/i.test(raw))
    return "El archivo no tiene las columnas requeridas. Puede estar mal exportado o ser de otro sistema.";
  if (/sin token de drive/i.test(raw))
    return "Tu sesión de Google Drive expiró. Cerrá sesión y volvé a conectar Drive.";
  if (/error de red/i.test(raw))
    return "No se pudo conectar al servidor. Verificá tu conexión a internet e intentá de nuevo.";
  if (/\$connect|\$transaction|prisma/i.test(raw))
    return "Error interno al guardar los datos. Intentá de nuevo o contactá soporte.";
  return raw;
}

module.exports = { translateError };
