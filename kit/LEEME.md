# kit/ — el kit Lazarillo, como código

El kit vive en el servidor y se edita como el resto del código (Diego, 08/11/2026: "no quiero
que se publique desde usuario, esto tiene que estar en el servidor de lazarillo actualizado").

- `Lazarillo - instalar/`: los archivos del kit tal cual los ve la PC (INSTALAR EN ESTA PC.bat,
  LAZARILLO.bat, VINCULAR ESTA PC.bat, LEEME.txt y `_motor/` con el motor, los generadores y las
  consultas). Para cambiar algo: editar el archivo, PR a testing, merge. Nada más.
- Un archivo grande puede ir partido en `<nombre>.parte-01`, `.parte-02`… (el motor): se unen en
  orden al armar el zip, así un cambio sube solo el pedazo tocado.
- `formato.json`: el repo guarda todo en UTF-8 sin BOM y con saltos LF; al armar el zip se le
  pone BOM a los .ps1 que lo necesitan (PowerShell 5.1) y CRLF a los .bat y .txt.
- Al arrancar, el servidor (`services/kit/versiones.js`) arma el zip y, si ese contenido no está
  en `kit_versiones`, lo publica. Nunca vuelve a una versión más vieja ($MOTOR_VER menor que la
  vigente), porque testing y producción comparten la base.
- ⚙ Configuración › Conexiones › "Descargar instalador" entrega la última, con
  `_motor/lz_api.txt` apuntando al servidor que la sirve.
- NUNCA credenciales acá (el repo es público): se rechaza el kit si trae lz_vinculo.txt,
  lz_coneccion_render.txt, lz_conexion.txt o destinos.txt.
- Las PC que todavía usan el Drive (`_KIT Lazarillo`) siguen leyendo de ahí: un cambio del
  motor se hace en los dos lados hasta que todas se actualicen desde el servidor.
