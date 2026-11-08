# -*- coding: utf-8 -*-
"""Genera los 9 maestros de MaxiRest desde los .tsv del extractor.

Antes esta funcion recibia los informes HUMANOS y les MEDIA en vivo los nombres
de columna y los anchos de relleno. Andaba, pero dependia de que esos archivos
estuvieran ahi y sin tocar: si alguien los movia o los pisaba, los maestros
salian mal y nadie se enteraba.

Ahora esa forma esta CONGELADA en maestros_cfg.json, al lado de este archivo.
El generador no depende de nada externo. Si algun dia MaxiRest cambia una
columna o un ancho, se regenera el json y listo.
"""
import pandas as pd, openpyxl, json, os, warnings
from openpyxl.utils.dataframe import dataframe_to_rows
from genmaestros import armar, escapar, desescapar, ESNUM
try:
    from genmaestros import leer_tsv
except ImportError:
    # si esta PC todavia no recibio el genmaestros.py nuevo (sync del Drive),
    # se lee como antes; el filtro de codigo numerico de abajo cubre igual.
    def leer_tsv(tsv):
        return pd.read_csv(tsv, sep="\t", dtype=str, keep_default_na=False)
warnings.filterwarnings('ignore')

AQUI = os.path.dirname(os.path.abspath(__file__))
CFG  = json.load(open(os.path.join(AQUI, "maestros_cfg.json"), encoding="utf-8"))

def generar_maestros(A, OUT):
    """A = carpeta con los .tsv del extractor. OUT = donde dejar los .xlsx,
    con el numero de maestro como nombre (7.xlsx, 00.xlsx, ...)."""
    if not A.endswith(('/', '\\')): A += os.sep
    os.makedirs(OUT, exist_ok=True)
    hechos = {}

    for n, c in CFG.items():
        if c["modo"] != "simple": continue
        hechos[n] = armar(A + c["tsv"], c["cols"], c["ren"], c["anchos"],
                          os.path.join(OUT, n + ".xlsx"))

    # Los insumos van aparte: el informe 1 son los ACTIVOS y el 0 son TODOS,
    # con las mismas columnas. ULT_COMPRA no sale del maestro sino de la fecha
    # mas reciente de ese insumo en el detalle de compras (mxitc).
    ins = leer_tsv(A + "10_insumos.tsv")   # corta solo en LF (recetas con CR suelto)
    for c_ in ins.columns: ins[c_] = ins[c_].map(desescapar)
    # Algunos insumos traen recetas multilinea (columna 'receta') cuyos saltos de
    # linea parten la fila en el TSV: quedan filas basura con el codigo vacio o no
    # numerico (fragmentos "2- Dejar reducir...", etc). No son insumos. Las columnas
    # que usa el generador (codigo..precio) van ANTES de 'receta', asi que el insumo
    # real queda intacto; solo se descartan los pedazos sueltos. En Container no habia
    # ninguno (no rompe nada alla); en Comercio son ~54.
    ins = ins[pd.to_numeric(ins['codigo'], errors='coerce').notna()].reset_index(drop=True)
    det = pd.read_csv(A + "23_compras_detalle.tsv", sep="\t", dtype=str, keep_default_na=False)
    ult = det.assign(f=pd.to_datetime(det['fecha'], errors='coerce')).groupby('cod_ins')['f'].max()

    def cel(v, a):
        t = v.strip()
        if ESNUM.match(t): return float(t) if '.' in t else int(t)
        return escapar(v[:a].ljust(a)) if a else v

    def armar_ins(df, an, salida):
        out = pd.DataFrame({
            'COD_RUI': pd.to_numeric(df['cod_rui'], errors='coerce').fillna(0).astype(int),
            'CODIGO' : pd.to_numeric(df['codigo'], errors='coerce').astype(int),
            'NOMBRE' : df['nombre'].map(lambda v: cel(v, an.get('NOMBRE'))),
            'UNIDAD_MED': df['unidad_med'].map(lambda v: cel(v, an.get('UNIDAD_MED'))),
            'PRECIO' : pd.to_numeric(df['precio'], errors='coerce').fillna(0),
            'ULT_COMPRA': df['codigo'].map(ult),
        })
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        for f in dataframe_to_rows(out, index=False, header=True): ws.append(f)
        for c in ws['F'][1:]: c.number_format = 'mm-dd-yy'
        wb.save(salida); return out

    for n in ("1", "0"):
        c = CFG[n]
        d = ins if c["discont"] else ins[~ins['discont'].isin(['\x01'])]
        hechos[n] = armar_ins(d, c["anchos"], os.path.join(OUT, n + ".xlsx"))

    return hechos
