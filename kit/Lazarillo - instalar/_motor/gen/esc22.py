import openpyxl, datetime as dt
from openpyxl.utils import get_column_letter
from openpyxl.utils.dataframe import dataframe_to_rows

COLS = ['TURNO','COMPROBANT','HORA','TIPO','MESA','MOZO','CUB','COBRO','COD_COBRO',
        'IMPORTE','TOTAL','DESCUENTO','CLINOMBRE','CLIRAZON','CLICUIT','FECHA',
        'COD_SUC','NOMBRESUC','CUPON']

def escribir(df, salida):
    df = df[COLS]
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
    for f in dataframe_to_rows(df, index=False, header=True): ws.append(f)
    ih = COLS.index('HORA') + 1; ifec = COLS.index('FECHA') + 1
    for c in ws[get_column_letter(ih)][1:]:
        if isinstance(c.value, dt.time): c.number_format = 'h:mm'
    for c in ws[get_column_letter(ifec)][1:]: c.number_format = 'mm-dd-yy'
    wb.save(salida)
    return salida
