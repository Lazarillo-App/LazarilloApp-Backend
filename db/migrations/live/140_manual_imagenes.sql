-- 140: imágenes del Manual guardadas en la base (16/11/2026). Cloudinary no está configurado en
-- testing y la base es la misma para testing y producción: guardadas acá, una captura subida desde
-- cualquiera de los dos sirve en los dos. Son capturas livianas (JPEG, hasta 1600 px de ancho).
CREATE TABLE IF NOT EXISTS manual_imagenes (
  id          bigserial PRIMARY KEY,
  mime        text NOT NULL,
  datos       bytea NOT NULL,
  bytes       integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  bigint
);
