// config/demoDestinos.js
// A quiénes les llega cada pedido de demo de la landing (Diego 13/11/2026).
// La variable DEMO_EMAILS (separados por coma) los reemplaza sin tocar el código.
'use strict';

const PREDETERMINADOS = ['diegosebastianalbo@gmail.com', 'mgilherrera84@gmail.com'];

module.exports = (process.env.DEMO_EMAILS ? process.env.DEMO_EMAILS.split(',') : PREDETERMINADOS)
  .map((s) => s.trim())
  .filter(Boolean);
