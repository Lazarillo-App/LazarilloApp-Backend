# -*- coding: utf-8 -*-
"""
Informe 70 - DETALLE DE PAGOS SALDOS.

Es la cuenta corriente de EMPLEADOS: cada liquidacion de sueldo cargada como
comprobante de compra a un empleado. En MaxiRest los sueldos se cargan con
cod_pro NEGATIVO (el codigo de empleado) y cod_cpb 'E'; el informe los muestra
en positivo con el nombre del empleado.

Deducido y verificado contra el 70 real de San Justo (122 filas, $53.182.824):
el CONTENIDO sale identico (mismas 122 filas, mismos importes). El unico matiz
es el orden entre dos liquidaciones del MISMO empleado el MISMO dia: MaxiRest
las intercala por como toco el ultimo pago (no reproducible por columna); aca
van por id de carga. Son 6 pares (12 filas) de orden cosmetico.

    CODIGO  ... abs(mxgas.cod_pro)          (codigo de empleado)
    EMPLEADO... mxemp.apellido + ' ' + mxemp.nombre
    FECHA  .... mxgas.fecha                 (fecha del comprobante/liquidacion)
    DETALLE... mxgas.observac[:30]          ("Liquidacion", "Diferencia...", etc.)
    PERIODO... mxgas.fecha_ing              (mes liquidado, dia 1)
    IMPORTE... mxgas.total

Filtro: cod_pro < 0  y  cod_cpb = 'E'  y  total > 0 (las de total 0 no van).
Es acumulativo (todas las liquidaciones, sin corte por anio).
Orden: cod_pro asc (empleado 674 primero, o sea codigo DESC) -> fecha asc -> id asc.
"""
import pandas as pd, openpyxl
from openpyxl.utils.dataframe import dataframe_to_rows


def _des(s):
    if not isinstance(s, str):
        return s
    return (s.replace('\\t', '\t').replace('\\n', '\n').replace('\\r', '\r')
             .replace('\\0', '\x00').replace('\\\\', '\\'))


def generar_70(B, salida, cod_suc=None):
    cab = pd.read_csv(B + "24_compras_cab.tsv", sep="\t", dtype=str, keep_default_na=False)
    emp = pd.read_csv(B + "04_empleados.tsv",   sep="\t", dtype=str, keep_default_na=False)

    cab['cp']  = pd.to_numeric(cab['cod_pro'], errors='coerce').fillna(0).astype(int)
    cab['tot'] = pd.to_numeric(cab['total'],   errors='coerce').fillna(0)
    cab['f']   = pd.to_datetime(cab['fecha'].replace('0000-00-00', ''),     errors='coerce')
    cab['fi']  = pd.to_datetime(cab['fecha_ing'].replace('0000-00-00', ''), errors='coerce')
    cab['idi'] = pd.to_numeric(cab['id'], errors='coerce')

    nm = {}
    for r in emp.itertuples():
        try:
            c = int(r.codigo)
        except Exception:
            continue
        nm[c] = (str(r.apellido).strip() + ' ' + str(r.nombre).strip()).strip()

    e = cab[(cab['cp'] < 0) & (cab['cod_cpb'] == 'E') & (cab['tot'] > 0.005)].copy()
    if cod_suc is not None:
        e = e[e['cod_suc'] == str(cod_suc)]
    e = e.sort_values(['cp', 'f', 'idi'], kind='stable')

    out = pd.DataFrame({
        'CODIGO'  : e['cp'].abs().astype(int),
        'EMPLEADO': [nm.get(abs(c), '')[:30].ljust(30) for c in e['cp']],
        'FECHA'   : e['f'],
        'DETALLE' : [_des(o)[:30].ljust(30) for o in e['observac']],
        'PERIODO' : e['fi'],
        'IMPORTE' : e['tot'].round(2),
    })

    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
    for fila in dataframe_to_rows(out, index=False, header=True):
        ws.append(fila)
    for c in ws['C'][1:]:
        c.number_format = 'mm-dd-yy'   # FECHA
    for c in ws['E'][1:]:
        c.number_format = 'mm-dd-yy'   # PERIODO
    wb.save(salida)
    return out


if __name__ == '__main__':
    import sys
    B   = sys.argv[1]
    suc = sys.argv[2] if len(sys.argv) > 2 else None
    o = generar_70(B, "/mnt/user-data/outputs/70 - DETALLE DE PAGOS SALDOS SJ.XLSX", suc)
    print("filas: {}   IMPORTE {:,.2f}".format(len(o), o['IMPORTE'].sum()))
