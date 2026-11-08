-- 076 · Kit vinculado sin Drive (Diego, 07-08/11/2026).
-- Cada PC donde corre el kit (MaxiRest) se vincula UNA vez con usuario y contraseña de un
-- dueño/admin del negocio. La PC recibe su propia llave: solo sirve para subir los datos de
-- SU local (negocio + sucursal), se puede cortar desde la app y la contraseña no se guarda.
-- Acá se guarda solo el HASH de la llave (sha256), nunca la llave.
-- Regla de Diego: un local tiene UNA sola PC activa (el índice único lo asegura aunque
-- corran dos instaladores a la vez). Tomar un local ocupado = "Reemplazar esa PC" (corta la
-- llave de la vieja). Una sola PC arma los maestros de cada esquema.
-- Solo agrega una tabla nueva; no toca datos existentes.
CREATE TABLE IF NOT EXISTS kit_pcs (
  id               SERIAL PRIMARY KEY,
  business_id      BIGINT NOT NULL REFERENCES app_businesses(id),
  branch_id        BIGINT REFERENCES app_branches(id),
  origen_id        INTEGER REFERENCES gestion_render_origenes(id),
  esquema          TEXT NOT NULL,
  pdv              TEXT NOT NULL,
  pos              TEXT NOT NULL DEFAULT 'maxirest',
  pc_nombre        TEXT NOT NULL,
  pc_huella        TEXT,
  maestros         BOOLEAN NOT NULL DEFAULT false,
  llave_hash       TEXT NOT NULL UNIQUE,
  llave_pista      TEXT,
  creado_por       BIGINT,
  creado_en        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_contacto  TIMESTAMPTZ,
  ultima_carga     TIMESTAMPTZ,
  ultima_carga_detalle TEXT,
  motor_ver        TEXT,
  revocado_en      TIMESTAMPTZ,
  revocado_por     BIGINT,
  revocado_motivo  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS kit_pcs_un_local_activo
  ON kit_pcs (business_id, (COALESCE(branch_id, 0))) WHERE revocado_en IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS kit_pcs_un_maestros_por_esquema
  ON kit_pcs (esquema) WHERE revocado_en IS NULL AND maestros;

CREATE INDEX IF NOT EXISTS kit_pcs_business_idx ON kit_pcs (business_id);
