-- 128 · Pantallas de TV para las plazas de despacho (Diego 14/11/2026: «quiero que cargue solo el
-- tablero, todos los días, simple»).
-- La TV abre /pantalla, pide un código de 6 dígitos y lo muestra; desde la PC se escribe ese código en
-- el tablero («Vincular TV») y la pantalla queda atada a esa plaza, solo para ver.
--   token_hash: sha256 del token que guarda la TV (el token en sí nunca se guarda).
--   codigo / codigo_vence: solo mientras espera que la vinculen (15 min).
--   business_id / plaza_id: NULL hasta que la vinculan.
--   deleted_at: desvinculada (la TV pide un código nuevo).
CREATE TABLE IF NOT EXISTS pantallas (
  id            SERIAL PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  codigo        TEXT,
  codigo_vence  TIMESTAMPTZ,
  business_id   INT,
  plaza_id      INT,
  nombre        TEXT,
  vinculada_por INT,
  vinculada_at  TIMESTAMPTZ,
  ultima_vez    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pantallas_codigo_idx ON pantallas (codigo) WHERE plaza_id IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS pantallas_plaza_idx ON pantallas (business_id, plaza_id) WHERE deleted_at IS NULL;
