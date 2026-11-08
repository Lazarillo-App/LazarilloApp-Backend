# kit/ — el kit Lazarillo para descargar desde la app

El kit vive en el servidor (Diego, 08/11/2026: "no quiero que se publique desde usuario,
esto tiene que estar en el servidor de lazarillo actualizado").

- `instalar-1.b64` … `instalar-N.b64`: el zip "Lazarillo - instalar" en base64, partido en
  pedazos (se unen en orden numérico). Así viaja byte por byte igual (BOM de los .ps1, CRLF
  de los .bat).
- Al arrancar, el servidor (`services/kit/versiones.js` → `sincronizarDesdeRepo`) calcula la
  huella del zip y, si no está en `kit_versiones`, lo publica. Nunca vuelve a una versión más
  vieja ($MOTOR_VER menor que la vigente), porque testing y producción comparten la base.
- ⚙ Configuración › Conexiones › "Descargar instalador" entrega la última, con
  `_motor/lz_api.txt` apuntando al servidor que la sirve.
- El zip NUNCA lleva credenciales: se rechaza si trae lz_vinculo.txt, lz_coneccion_render.txt,
  lz_conexion.txt o destinos.txt.

Para actualizar: armar el zip nuevo desde `_KIT Lazarillo` (mismo contenido que el Drive),
reemplazar los .b64 y mergear a testing. El deploy lo publica solo.
