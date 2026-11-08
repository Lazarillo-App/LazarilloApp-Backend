import pandas as pd, numpy as np, warnings, openpyxl, re
from openpyxl.utils.dataframe import dataframe_to_rows
warnings.filterwarnings('ignore')

ESNUM=re.compile(r'^[+-]?\d+(\.\d+)?$')   # acepta ceros adelante y el signo +
ILEGAL=re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
def desescapar(x):
    # mysql --batch escapa: \n \t \r \0 y \\ . Hay que devolverlos a su valor real.
    if not isinstance(x,str) or '\\' not in x: return x
    out=[]; i=0
    while i < len(x):
        if x[i]=='\\' and i+1 < len(x):
            c=x[i+1]
            out.append({'n':'\n','t':'\t','r':'\r','0':'\x00','\\':'\\'}.get(c, '\\'+c)); i+=2
        else:
            out.append(x[i]); i+=1
    return ''.join(out)

def escapar(x):
    # Excel no admite caracteres de control: MaxiRest los guarda escapados _x00NN_
    return ILEGAL.sub(lambda m: '_x%04X_' % ord(m.group()), x) if isinstance(x,str) else x
BOOLS={'excluyeinf','deliact','discont','calc_rent','iva','iva_dif','receta'}
FECHAS={'fecha_update','fecultipp','ult_compra'}

def anchos_de(h):
    """ancho de relleno de cada columna de texto, medido en el archivo humano"""
    w={}
    for c in h.columns:
        s=h[c]
        if s.dtype==object or str(s.dtype)=='str':
            # OJO: el Excel de MaxiRest guarda NUMERO cuando el valor parece
            # numero y TEXTO RELLENADO cuando no. Los numericos pierden el
            # relleno, asi que el ancho se mide solo en las celdas de texto.
            L=s[s.map(lambda x: isinstance(x,str))].str.len()
            if len(L): w[c]=int(L.mode()[0])
    return w

def leer_tsv(tsv):
    # 15/10 (Comercio, 6 - listado de articulos con renglones de recetas): el
    # .tsv corta cada fila con CR+LF, pero los textos largos de MaxiRest (la
    # receta del articulo/insumo) traen un CR SUELTO adentro. pandas, por
    # defecto, toma ese CR suelto como fin de fila y parte el registro en
    # pedazos ("Detalle de subrecetas de...", "0.500 K Salsa Filetto...").
    # Se lee cortando SOLO en LF y se le saca el CR final a la ultima columna.
    t=pd.read_csv(tsv,sep="\t",dtype=str,keep_default_na=False,lineterminator='\n')
    t.columns=[c.rstrip('\r') for c in t.columns]
    if len(t.columns): t[t.columns[-1]]=t[t.columns[-1]].str.rstrip('\r')
    # red de seguridad: un registro de maestro siempre tiene codigo numerico
    if 'codigo' in t.columns:
        t=t[pd.to_numeric(t['codigo'],errors='coerce').notna()].reset_index(drop=True)
    return t

def armar(tsv, cols_salida, renombres, anchos, salida, orden=None):
    t=leer_tsv(tsv)
    for c_ in t.columns: t[c_]=t[c_].map(desescapar)
    out=pd.DataFrame()
    for c in cols_salida:
        col=renombres.get(c,c)          # nombre en la tabla
        s=t[col] if col in t.columns else pd.Series(['']*len(t))
        if col in BOOLS:
            # MaxiRest guarda los booleanos como byte \x01 (si) / \0 (no);
            # mysql --batch escapa el NUL como la cadena "\\0".
            out[c]=s.isin(['\x01','1','true','True','T','.T.'])
        elif col in FECHAS:
            out[c]=pd.to_datetime(s.replace({'0000-00-00':'','0000-00-00 00:00:00':''}),errors='coerce')
        else:
            if c not in anchos and (s.str.strip()=='').all():
                out[c]=None; continue          # columna vacia y sin ancho -> vacia, no cero
            num=pd.to_numeric(s,errors='coerce')
            if num.notna().all() and c not in anchos:
                out[c]=num if (num%1!=0).any() else num.astype('int64')
            else:
                a=anchos.get(c)
                if a:
                    def celda(v):
                        v=v if isinstance(v,str) else ''
                        t=v.strip()
                        if ESNUM.match(t): return float(t) if '.' in t else int(t)
                        # se rellena con el texto CRUDO y recien despues se escapan
                        # los caracteres de control, para no comerse el ancho
                        return escapar(v[:a].ljust(a))
                    out[c]=s.map(celda)
                else:
                    out[c]=s.map(escapar)
    if orden: out=out.sort_values(orden,kind='stable').reset_index(drop=True)
    wb=openpyxl.Workbook(); ws=wb.active; ws.title='Hoja1'
    for f in dataframe_to_rows(out,index=False,header=True): ws.append(f)
    for c in out.columns:
        if c.lower() in {x.upper().lower() for x in FECHAS} or c in ('FECHA_UPDA','FECULTIPP','ULT_COMPRA'):
            i=list(out.columns).index(c)+1
            for cell in ws[openpyxl.utils.get_column_letter(i)][1:]: cell.number_format='mm-dd-yy'
    wb.save(salida)
    return out
