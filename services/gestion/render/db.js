// Portado de lazarillo_gestion/lib/render/db.ts (TypeScript → JavaScript, misma lógica).
'use strict';

const { types } = require('pg');
const pool = require('../../../config/db');
const { tipoDeOid } = require('./filas');

// Lectura de los esquemas que el kit sube todos los días (container / comercio /
// migago). En gestion era otra base (RENDER_DATABASE_URL desde Vercel); en
// Lazarillo es la MISMA base: se usa el pool del Backend, en una transacción de
// solo lectura.
function renderConfigurado() {
  return true;
}

// Fechas, numeric y bigint llegan como texto: filaDeRender los convierte igual
// que los lee el import del Excel (serial de Excel / número).
const COMO_TEXTO = new Set([20, 1082, 1114, 1184, 1700]);
const parsers = {
  getTypeParser: ((oid, format) =>
    COMO_TEXTO.has(oid) ? (v) => v : types.getTypeParser(oid, format)),
};

const IDENT = /^[a-z0-9_]+$/;
function ident(nombre) {
  if (!IDENT.test(nombre)) throw new Error(`Nombre inválido en Render: ${nombre}`);
  return `"${nombre}"`;
}

async function conRender (fn) {
  const cliente = await pool.connect();
  const alCaer = (err) => console.error('[render/db] se cayó la conexión', err.message);
  cliente.on('error', alCaer);
  // Mismo cliente, pero cada consulta con los parsers de arriba (sin tocar los
  // globales de pg que usa el resto del Backend).
  const c = { query: (text, values) => cliente.query({ text, values, types: parsers }) };
  try {
    await cliente.query("BEGIN READ ONLY");
    await cliente.query("SET LOCAL statement_timeout = 60000");
    const r = await fn(c);
    await cliente.query("COMMIT");
    return r;
  } catch (e) {
    await cliente.query("ROLLBACK").catch((err) => console.error("[render] rollback", err));
    throw e;
  } finally {
    cliente.removeListener('error', alCaer);
    cliente.release();
  }
}

/** Consulta de solo lectura con parámetros (los nombres de tabla se validan con identRender). */
async function consultaRender (sql, params = []) {
  return conRender(async (c) => (await c.query(sql, params)).rows);
}
function identRender(nombre) {
  return ident(nombre);
}

// Así anota el kit en _cargas las tablas de maestros (una por organización, sin pdv).
const PDV_MAESTROS = "(maestros)";

// Última carga del kit por PDV y tabla (tabla _cargas de cada esquema), y si la
// tabla ya trae la columna `fila` (orden de las filas del informe).
async function leerCargas(esquema, pdvs) {
  return conRender(async (c) => {
    const { rows } = await c.query (
      `SELECT DISTINCT ON (pdv, tabla) pdv, tabla, filas,
              to_char(cargado AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cargado
         FROM ${ident(esquema)}._cargas WHERE pdv = ANY($1) ORDER BY pdv, tabla, cargado DESC`,
      [pdvs]
    );
    const conFila = await c.query (
      `SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'fila'`,
      [esquema]
    );
    const tablasConFila = new Set(conFila.rows.map((r) => r.table_name));
    // La columna es de la tabla, pero cada PDV la llena recién cuando SU PC corre
    // con el kit nuevo (Canchas Ramos a veces tarda en tomarlo): hasta que todas
    // sus filas tengan número, ese PDV sigue sin orden.
    const out = [];
    for (const r of rows) {
      let tieneFila = false;
      if (tablasConFila.has(r.tabla)) {
        const q = await c.query (
          `SELECT EXISTS (SELECT 1 FROM ${ident(esquema)}.${ident(r.tabla)} WHERE pdv = $1 AND fila IS NULL) AS sin`,
          [r.pdv]
        );
        tieneFila = !q.rows[0]?.sin;
      }
      out.push({ pdv: r.pdv, tabla: r.tabla, filas: Number(r.filas), cargado: r.cargado, tieneFila });
    }
    return out;
  });
}

// Huella del CONTENIDO de esa tabla para ese PDV: el kit recarga todo cada día,
// así que la fecha de carga cambia aunque los datos sean los mismos.
async function huellaTabla(esquema, tabla, pdv) {
  return conRender(async (c) => {
    const { rows } = await c.query (
      `SELECT count(*) AS n, md5(string_agg(md5(t::text), '' ORDER BY md5(t::text))) AS h
         FROM ${ident(esquema)}.${ident(tabla)} t${pdv === PDV_MAESTROS ? "" : " WHERE pdv = $1"}`,
      pdv === PDV_MAESTROS ? [] : [pdv]
    );
    return `${rows[0]?.n ?? 0}|${rows[0]?.h ?? ""}`;
  });
}

async function leerTabla(
  esquema,
  tabla,
  pdv,
  ordenarPorFila
) {
  return conRender(async (c) => {
    const r = await c.query(
      `SELECT * FROM ${ident(esquema)}.${ident(tabla)}${pdv === PDV_MAESTROS ? "" : " WHERE pdv = $1"}${ordenarPorFila ? " ORDER BY fila" : ""}`,
      pdv === PDV_MAESTROS ? [] : [pdv]
    );
    const tipos = {};
    for (const f of r.fields) tipos[f.name] = tipoDeOid(f.dataTypeID);
    return { filas: r.rows, tipos };
  });
}

// Maestro 17 (conceptos de caja) tal como lo sube el kit cada día desde MaxiRest.
async function leerConceptos(esquema) {
  return conRender(async (c) => {
    const { rows } = await c.query (
      `SELECT codigo, nombre, tipo, cod_rga, rubro FROM ${ident(esquema)}.m17_conceptos_de_caja ORDER BY codigo`
    );
    return rows.map((r) => ({
      codigo: Number(r.codigo),
      nombre: (r.nombre ?? "").trim(),
      tipo: r.tipo,
      codRubro: r.cod_rga != null ? Number(r.cod_rga) : null,
      rubro: r.rubro?.trim() ?? null,
    }));
  });
}

// Maestro de insumos de MaxiRest (m0): cada insumo con su rubro y el concepto de
// caja de ese rubro (en MaxiRest cada rubro de insumo tiene uno; 0 = sin concepto).
/** Envase de compra de un insumo (X8, X6, Pack…) y cuántas unidades base trae. */

async function leerInsumos(esquema) {
  return conRender(async (c) => {

    const { rows } = await c.query (
      `SELECT codigo, nombre, unidad_med, rubro, cod_cga, precio, discontinuado, envase1, neto1, envase2, neto2, envase3, neto3
       FROM ${ident(esquema)}.m0_listado_de_insumos_con_discontinuados`
    );
    return rows.flatMap((r) => {
      const cod = Number(r.codigo);
      const nombre = (r.nombre ?? "").trim();
      if (!Number.isFinite(cod) || !nombre) return [];
      const cga = Number(r.cod_cga);
      const precio = Number(r.precio);
      const disc = String(r.discontinuado ?? "").trim().toUpperCase();
      // En MaxiRest la compra se carga en el envase (X8, Pack…) y el 25 trae esa medida con el
      // precio POR ENVASE (igual que el informe original): el factor está en el maestro.
      const envases = ([[r.envase1, r.neto1], [r.envase2, r.neto2], [r.envase3, r.neto3]]).flatMap(([e, n]) => {
        const envase = (e ?? "").trim();
        const factor = Number(n);
        return envase && Number.isFinite(factor) && factor > 0 ? [{ envase, factor }] : [];
      });
      return [{
        codigo: String(cod),
        nombre,
        medida: r.unidad_med?.trim() || null,
        rubro: r.rubro?.trim() || null,
        codCga: Number.isFinite(cga) && cga > 0 ? String(cga) : null,
        precio: Number.isFinite(precio) && precio > 0 ? precio : null,
        discontinuado: disc === "S" || disc === "SI" || disc === "1" || disc === "TRUE",
        envases,
      }];
    });
  });
}

module.exports = { renderConfigurado, consultaRender, identRender, PDV_MAESTROS, leerCargas, huellaTabla, leerTabla, leerConceptos, leerInsumos };
