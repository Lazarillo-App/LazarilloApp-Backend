-- Descripción propia de Lazarillo para artículos de MaxiRest (la que se edita
-- desde el modal del artículo en la Vista Tabla). NULL = usar la de MaxiRest.
-- El sync de artículos no toca esta columna, así que lo editado no se pisa.
ALTER TABLE maxi_articles ADD COLUMN IF NOT EXISTS descripcion TEXT;
