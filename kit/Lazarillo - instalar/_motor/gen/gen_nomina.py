# -*- coding: utf-8 -*-
"""
000 - nomina : el listado de empleados tal cual lo exporta MaxiRest.

Es el volcado de la tabla mxemp con una sola columna agregada al final,
"sector", que es el nombre del sector (mxsec) que corresponde a cod_sec.
No lleva id, ni las columnas grandes (dig_id, foto, observac, fotoblob): asi
lo deja MaxiRest y asi lo esperan las planillas de Diego.

Detalles de formato copiados del archivo real (26/08/2026, 59 filas):
  - las fechas vacias NO van en blanco: van como "  -   -", que es como el
    FoxPro de MaxiRest escribe una fecha nula.
  - los campos de texto vacios si van en blanco (celda vacia).
  - los si/no van como True / False.

OJO: este archivo lleva datos personales del personal (documento, domicilio,
telefono, sueldo) y ademas la columna "clave", que es la contraseña de MaxiRest
de cada uno. Va a las mismas carpetas donde ya estaba el archivo que bajaba
Diego a mano, no se publica en ningun lado nuevo.
"""
import os, pandas as pd, openpyxl
from openpyxl.utils.dataframe import dataframe_to_rows

# como escribe MaxiRest una fecha vacia
FECHA_VACIA = '  -   -'

FECHAS = ['fecha_nac', 'fecha_ing', 'ultperliq', 'fecultliq', 'vto_libsan',
          'fecha_baja', 'horfec']
NUMEROS = {'nivel': int, 'valor_comi': float, 'sueldo': float, 'max_adel': float,
           'max_vale': float, 'aguinaldo': float, 'nro_recibo': int,
           'hordem': int, 'emailpred': int}
SINO = ['adicpda', 'rinde', 'yarindio', 'activaweb', 'admines', 'bloqueado', 'inc_age']


def generar_nomina(B, salida):
    if not B.endswith(os.sep) and not B.endswith('/'):
        B += '/'
    d = pd.read_csv(B + "43_nomina.tsv", sep="\t", dtype=str, keep_default_na=False)
    try:
        sec = pd.read_csv(B + "44_sectores.tsv", sep="\t", dtype=str, keep_default_na=False)
        nom_sec = dict(zip(sec['codigo'], sec['nombre']))
    except Exception:
        nom_sec = {}

    out = pd.DataFrame(index=d.index)
    for col in d.columns:
        s = d[col]
        if col in FECHAS:
            f = pd.to_datetime(s.replace('0000-00-00', ''), errors='coerce')
            # la fecha vacia se escribe con el cartel de MaxiRest, no en blanco
            out[col] = [x if pd.notna(x) else FECHA_VACIA for x in f]
        elif col in SINO:
            # en la base vienen como 1/0 (o \x01/\0); en el archivo van True/False
            out[col] = [bool(x) and x not in ('0', '', '\x00') for x in s]
        elif col in NUMEROS:
            v = pd.to_numeric(s, errors='coerce').fillna(0)
            out[col] = v.astype(int) if NUMEROS[col] is int else v
        else:
            out[col] = s.replace('', None)

    # la unica columna que no esta en mxemp: el nombre del sector
    out['sector'] = [nom_sec.get(c) if c else None for c in d.get('cod_sec', pd.Series([''] * len(d)))]

    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
    for fila in dataframe_to_rows(out, index=False, header=True):
        ws.append(fila)
    for col in FECHAS:
        letra = openpyxl.utils.get_column_letter(list(out.columns).index(col) + 1)
        for c in ws[letra][1:]:
            if not isinstance(c.value, str):
                c.number_format = 'yyyy-mm-dd'
    wb.save(salida)
    return out


if __name__ == '__main__':
    import sys
    o = generar_nomina(sys.argv[1], sys.argv[2])
    print('nomina: %d empleados, %d columnas' % (len(o), len(o.columns)))
