# -*- coding: utf-8 -*-
"""
Lazarillo - genera los 9 maestros y los deja listos para copiar.

    python lz_maestros.py <carpeta out con los .tsv> <carpeta de salida>

Deja una subcarpeta por destino, porque el MISMO maestro se llama distinto en
cada lugar (asi lo nombra MaxiRest y asi los consumen las planillas de Diego):

    <salida>/drive/          -> Drive, "Informes ERP\\Maestros"     (sufijo V7)
    <salida>/mega_maestros/  -> MEGA,  "- MAESTROS"
    <salida>/mega_informes/  -> MEGA,  "...\\Informes del Sistema"  (sin el 0)

Quien copia cada una a su carpeta final es lz_lazarillo.ps1, segun lo que diga
destinos.txt. Los que no tengan carpeta configurada, no se copian.
"""
import sys, os, shutil, traceback, datetime as dt

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)


# 07/11/2026 (Diego: "un caracter no puede jugarnos en contra"). MaxiRest a veces
# guarda caracteres de control en textos libres (un telefono de Canchas Ramos
# traia un 0x02) y openpyxl, en vez de escribir la celda, corta el informe
# entero (IllegalCharacterError). Red para TODOS los generadores de este
# proceso: el caracter se saca y el informe sale igual.
def _texto_seguro():
    try:
        from openpyxl.cell import cell as _celda
        if getattr(_celda.Cell, '_lz_seguro', False):
            return
        _orig = _celda.Cell.check_string
        _ilegal = _celda.ILLEGAL_CHARACTERS_RE

        def check_string(self, value):
            if isinstance(value, str):
                value = _ilegal.sub('', value)
            return _orig(self, value)
        _celda.Cell.check_string = check_string
        _celda.Cell._lz_seguro = True
    except Exception:
        pass


_texto_seguro()

import maestros_todos

# numero de maestro -> nombre del archivo en cada destino.
# Un destino que no lista un maestro, no lo lleva (el "0" solo va a dos).
NOMBRES = {
    'drive': {
        '0' : '0 - LISTADO DE INSUMOS CON DISCONTINUADOS V7.XLSX',
        '00': '00 - listado de proovedores V7.XLSX',
        '1' : '1 - LISTADO DE INSUMOS V7.XLSX',
        '11': '11 - rubros conceptos de caja V7.XLSX',
        '17': '17 - conceptos de caja V7.XLSX',
        '2' : '2 - Listado de rubro de insumos V7.XLSX',
        '6' : '6 - listado de articulos V7.XLSX',
        '7' : '7 - rubros de articulos V7.XLSX',
        '8' : '8 - subrubro de articulos V7.XLSX',
    },
    'mega_maestros': {
        '0' : '0 - LISTADO DE INSUMOS CON DISCONTINUADOS.XLSX',
        '00': '00 - listado de proovedores.xls',
        '1' : '1 - LISTADO DE INSUMOS.XLSX',
        '11': '11 - RUBROS CONCEPTOS DE CAJA.XLSX',
        '17': '17 - conceptos de caja.xls',
        '2' : '2 - Listado de rubro de insumos.xls',
        '6' : '6 - LISTADO DE ARTICULOS.XLSX',
        '7' : '7 - rubros de articulos.xls',
        '8' : '8 - subrubro de articulos.xls',
    },
    'mega_informes': {
        '00': '00 - listado de proovedores.xls',
        '1' : '1 - LISTADO DE INSUMOS.XLSX',
        '11': '11 - RUBROS CONCEPTOS DE CAJA.XLSX',
        '17': '17 - conceptos de caja.xls',
        '2' : '2 - Listado de rubro de insumos.xls',
        '6' : '6 - listado de articulos.xls',
        '7' : '7 - rubros de articulos.xls',
        '8' : '8 - subrubro de articulos.xls',
    },
}

# ------------------------------------------------------------
#  CONTROL (Diego, 15/10: "sumas algo que controle eso?"). Despues de armar
#  los maestros se verifica que cada uno tenga EXACTAMENTE tantas filas como
#  registros hay en la base (el 1, los insumos activos) y que todas las filas
#  tengan un CODIGO valido. Paso en Comercio: el 6 salio con 50 renglones de
#  recetas partidas (880 filas para 830 articulos) y nadie se entero. Si algo
#  no cuadra, queda una linea "ALERTA maestro ..." en el log de la corrida
#  (que sube al Drive) para que el control diario la vea.
#  Los registros se cuentan cortando SOLO en LF: un CR suelto adentro de un
#  texto (las recetas) no es un registro nuevo.
# ------------------------------------------------------------
def _registros(ruta):
    with open(ruta, 'rb') as f:
        b = f.read()
    lineas = [l.rstrip(b'\r').decode('utf-8', 'replace') for l in b.split(b'\n')]
    lineas = [l for l in lineas if l.strip()]
    if not lineas: return [], []
    return lineas[0].split('\t'), [l.split('\t') for l in lineas[1:]]

def controlar(A, hechos):
    import pandas as pd
    alertas = []
    for n, df in hechos.items():
        c = maestros_todos.CFG.get(n, {})
        tsv = c.get('tsv') or '10_insumos.tsv'
        ruta = os.path.join(A, tsv)
        if not os.path.exists(ruta): continue
        hdr, regs = _registros(ruta)
        esperado = len(regs)
        if n == '1' and 'discont' in hdr:
            i = hdr.index('discont')
            esperado = sum(1 for r in regs if not (len(r) > i and r[i] == '\x01'))
        if len(df) != esperado:
            alertas.append('ALERTA maestro %-3s %d filas, pero la base tiene %d registros' % (n, len(df), esperado))
        if 'CODIGO' in df.columns:
            malos = int(pd.to_numeric(df['CODIGO'], errors='coerce').isna().sum())
            if malos:
                alertas.append('ALERTA maestro %-3s %d filas sin CODIGO valido (renglones sueltos)' % (n, malos))
    return alertas

def avisar_drive(alertas):
    """Deja el resultado del control en la carpeta _estado del Drive (la misma
    de los <PC>.txt), asi el control diario lo ve sin bajar logs:
        _LOGS Y CONTROLES\\_estado\\<PC> - control maestros.txt
    Primera linea: fecha + OK/ALERTA. La ruta sale de kit_drive (destinos.txt)."""
    try:
        motor = os.path.dirname(AQUI)
        kit = None
        with open(os.path.join(motor, 'destinos.txt'), encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                if '=' in l:
                    k, v = l.split('=', 1)
                    if k.strip() == 'kit_drive': kit = v.strip().rstrip('\\/')
        if not kit: return
        carpeta = os.path.join(os.path.dirname(kit), '_LOGS Y CONTROLES', '_estado')
        if not os.path.isdir(carpeta): return
        pc = os.environ.get('COMPUTERNAME', 'PC')
        txt = ['%s  %s  maestros %s' % (dt.datetime.now().strftime('%Y-%m-%d %H:%M'),
                                         'ALERTA' if alertas else 'OK', pc)] + list(alertas)
        with open(os.path.join(carpeta, pc + ' - control maestros.txt'), 'w', encoding='utf-8') as f:
            f.write('\n'.join(txt) + '\n')
    except Exception:
        pass

def main(A, OUT):
    log = ['LAZARILLO - maestros generados ' + dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
           'datos : ' + A, '']
    crudo = os.path.join(OUT, '_crudo')
    try:
        hechos = maestros_todos.generar_maestros(A, crudo)
    except Exception as e:
        log.append('ERROR generando los maestros: %s' % e)
        log.append(traceback.format_exc())
        os.makedirs(OUT, exist_ok=True)
        open(os.path.join(OUT, '_maestros.txt'), 'w', encoding='utf-8').write('\n'.join(log))
        print('\n'.join(log)); return 1

    for n in sorted(hechos, key=lambda x: (len(x), x)):
        log.append('OK    %-3s %6d filas' % (n, len(hechos[n])))
    log.append('')
    try:
        alertas = controlar(A, hechos)
        log.extend(alertas or ['CONTROL OK: cada maestro tiene tantas filas como registros en la base'])
        avisar_drive(alertas)
    except Exception as e:
        log.append('AVISO: no pude correr el control de maestros: %s' % e)
    # RENDER (Diego, 20/10/2026): los maestros de la organizacion a la base de
    # Render (articulos con rubro/subrubro, insumos con rubro, conceptos con rubro,
    # rubros, subrubros y proveedores). Si falla, no cambia nada del resto.
    try:
        import lz_render
        lr, okr = lz_render.subir_maestros(A, hechos)
        log.extend(lr)
        lz_render.avisar_drive('maestros', lr, okr)
    except Exception as e:
        log.append('AVISO RENDER no pude correr la subida a Render: %s' % e)
    log.append('')

    for destino, mapa in NOMBRES.items():
        d = os.path.join(OUT, destino)
        shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
        for n, nombre in mapa.items():
            shutil.copy(os.path.join(crudo, n + '.xlsx'), os.path.join(d, nombre))
        log.append('%-14s %d archivos' % (destino, len(mapa)))

    log.append(''); log.append('%d maestros OK' % len(hechos))
    open(os.path.join(OUT, '_maestros.txt'), 'w', encoding='utf-8').write('\n'.join(log))
    print('\n'.join(log))
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
