-- 172: Producción · Novedades de cocina — etapa 1 (pedido de Mairene 24/11/2026).
-- Avisos operativos entre el equipo de cocina por sucursal (algo dañado, algo sucio, se hizo
-- limpieza, cómo quedó algo, otro) con foto opcional en Cloudinary.
-- Solo dueño y admin pueden marcar una novedad como vista o eliminarla (borrado lógico).
-- Idempotente: solo CREATE TABLE / INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS produccion_novedades (
  id             BIGSERIAL PRIMARY KEY,
  business_id    BIGINT       NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  branch_id      BIGINT       REFERENCES app_branches(id) ON DELETE SET NULL,
  tipo           TEXT         NOT NULL DEFAULT 'otro',
  texto          TEXT         NOT NULL,
  foto_url       TEXT,
  foto_public_id TEXT,
  user_id        BIGINT       REFERENCES app_users(id) ON DELETE SET NULL,
  vista_at       TIMESTAMPTZ,
  vista_por      BIGINT       REFERENCES app_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ,
  deleted_by     BIGINT       REFERENCES app_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS ix_produccion_novedades_biz
  ON produccion_novedades (business_id, branch_id, created_at DESC)
  WHERE deleted_at IS NULL;
