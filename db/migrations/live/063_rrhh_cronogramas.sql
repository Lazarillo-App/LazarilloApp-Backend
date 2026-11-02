-- RRHH · Etapa 1 (Cronogramas). Tablas propias del módulo, por negocio.
-- Los empleados son de Lazarillo: de MaxiRest (réplica container/comercio.i000_nomina)
-- solo se importa la semilla inicial; después viven acá.
-- Idempotente: corre en cada boot (CREATE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS rrhh_empleados (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  codigo_maxi  TEXT,                                -- código en MaxiRest (NULL si es alta manual)
  nombre       TEXT NOT NULL,
  apellido     TEXT,
  sector       TEXT,                                -- Salón / Cocina / NULL (la réplica lo trae vacío)
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  origen       TEXT NOT NULL DEFAULT 'manual',      -- 'maxirest' | 'manual'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, codigo_maxi)                 -- varios NULL permitidos (manuales)
);
CREATE INDEX IF NOT EXISTS ix_rrhh_empleados_biz ON rrhh_empleados(business_id);

-- Referencias de puestos (1 = Plaza 1, Ba = Barista, …), gestionables.
CREATE TABLE IF NOT EXISTS rrhh_puestos (
  id           BIGSERIAL PRIMARY KEY,
  business_id  BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  codigo       TEXT NOT NULL,
  nombre       TEXT NOT NULL,
  UNIQUE (business_id, codigo)
);

-- Catálogo de fechas especiales. `fijo` = feriado inamovible: cada año cae la
-- misma fecha y se renueva solo (las móviles se re-fechan a mano).
-- `suma_promedio` = si la fecha entra al promedio de demanda (default NO).
CREATE TABLE IF NOT EXISTS rrhh_fechas (
  id             BIGSERIAL PRIMARY KEY,
  business_id    BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  fecha          DATE NOT NULL,
  tipo           TEXT NOT NULL DEFAULT 'feriado',   -- feriado | prefer | cerrado | evento
  nombre         TEXT,
  suma_promedio  BOOLEAN NOT NULL DEFAULT FALSE,
  fijo           BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (business_id, fecha)
);

-- Espacios (Salón, Cocina, …) y sus turnos (Día 10:00 / Noche 19:00 / …).
CREATE TABLE IF NOT EXISTS rrhh_espacios (
  id             BIGSERIAL PRIMARY KEY,
  business_id    BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  nombre         TEXT NOT NULL,
  sector_nomina  TEXT,                              -- Salón | Cocina | NULL (sin filtro)
  orden          INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_rrhh_espacios_biz ON rrhh_espacios(business_id);

CREATE TABLE IF NOT EXISTS rrhh_turnos (
  id          BIGSERIAL PRIMARY KEY,
  espacio_id  BIGINT NOT NULL REFERENCES rrhh_espacios(id) ON DELETE CASCADE,
  nombre      TEXT NOT NULL,
  entrada     TEXT,                                 -- "10:00"
  orden       INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_rrhh_turnos_esp ON rrhh_turnos(espacio_id);

-- Una semana de cronograma por espacio. `semana` en formato AAASS (202644),
-- `fecha_inicio` = el domingo con que arranca.
CREATE TABLE IF NOT EXISTS rrhh_semanas (
  id            BIGSERIAL PRIMARY KEY,
  business_id   BIGINT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  espacio_id    BIGINT NOT NULL REFERENCES rrhh_espacios(id) ON DELETE CASCADE,
  semana        INT NOT NULL,
  fecha_inicio  DATE NOT NULL,
  UNIQUE (business_id, espacio_id, semana)
);
CREATE INDEX IF NOT EXISTS ix_rrhh_semanas_biz ON rrhh_semanas(business_id, espacio_id);

-- Una fila = un empleado dentro de un turno (regla del módulo). `owner` queda
-- cuando se copia "solo estructura": la fila está reservada aunque no tenga días.
-- RESTRICT en turno: no se puede borrar un turno con filas cargadas.
CREATE TABLE IF NOT EXISTS rrhh_filas (
  id                 BIGSERIAL PRIMARY KEY,
  semana_id          BIGINT NOT NULL REFERENCES rrhh_semanas(id) ON DELETE CASCADE,
  turno_id           BIGINT NOT NULL REFERENCES rrhh_turnos(id) ON DELETE RESTRICT,
  orden              INT NOT NULL DEFAULT 0,
  owner_empleado_id  BIGINT REFERENCES rrhh_empleados(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_rrhh_filas_sem ON rrhh_filas(semana_id);

-- Una celda = un día (0=Do … 6=Sa) de una fila: empleado + puesto + horas.
-- RESTRICT en empleado: los empleados se desactivan, no se borran con historia.
CREATE TABLE IF NOT EXISTS rrhh_celdas (
  id           BIGSERIAL PRIMARY KEY,
  fila_id      BIGINT NOT NULL REFERENCES rrhh_filas(id) ON DELETE CASCADE,
  dia          SMALLINT NOT NULL CHECK (dia BETWEEN 0 AND 6),
  empleado_id  BIGINT NOT NULL REFERENCES rrhh_empleados(id) ON DELETE RESTRICT,
  puesto       TEXT,                                -- código de rrhh_puestos (texto: tolera tags viejos)
  horas        NUMERIC(5,2) NOT NULL DEFAULT 8,
  UNIQUE (fila_id, dia)
);
CREATE INDEX IF NOT EXISTS ix_rrhh_celdas_fila ON rrhh_celdas(fila_id);
CREATE INDEX IF NOT EXISTS ix_rrhh_celdas_emp ON rrhh_celdas(empleado_id);
