import pandas as pd, numpy as np, warnings, openpyxl
from openpyxl.utils.dataframe import dataframe_to_rows
warnings.filterwarnings('ignore')

def generar_25(B, anio, salida):
    det=pd.read_csv(B+"23_compras_detalle.tsv",sep="\t",dtype=str,keep_default_na=False)
    cab=pd.read_csv(B+"24_compras_cab.tsv",sep="\t",dtype=str,keep_default_na=False)
    ins=pd.read_csv(B+"10_insumos.tsv",sep="\t",dtype=str,keep_default_na=False)
    con=pd.read_csv(B+"12_conceptos_caja.tsv",sep="\t",dtype=str,keep_default_na=False)
    num=['cantidad','neto','precio','preciotot','tasa','iva','ivatot','imp_int','imp_inttot']
    for c in num: det[c]=pd.to_numeric(det[c],errors='coerce').fillna(0)
    det['insn']=pd.to_numeric(det['cod_ins'],errors='coerce').fillna(0)
    det['idn']=pd.to_numeric(det['id'],errors='coerce').fillna(0)
    det['f']=pd.to_datetime(det['fecha'],errors='coerce')
    K=['cod_pro','cod_suc','cod_cpb','numero1','numero2']

    # PERCEP: las lineas de cod_ins negativo son percepciones; no son filas del
    # informe, se suman en la ULTIMA linea del comprobante.
    neg=det[det['insn']<0].groupby(K)['preciotot'].sum().rename('percep')
    d=det[det['insn']>=0].copy()
    d=d.merge(cab[K+['observac']],on=K,how='left')
    d=d[(d['f']>=f"{anio}-01-01")&(d['f']<f"{anio+1}-01-01")]
    d=d.sort_values(K+['idn'],kind='stable')
    d=d.merge(neg,on=K,how='left')
    ultima=~d.duplicated(subset=K,keep='last')
    d['PERCEP']=np.where(ultima, d['percep'].fillna(0), 0.0)

    nom_ins=dict(zip(ins['codigo'],ins['nombre'])); med=dict(zip(ins['codigo'],ins['unidad_med']))
    nom_con=dict(zip(con['codigo'],con['nombre']))
    # MEDIDA: el detalle guarda en 'neto' el contenido de la presentacion con la
    # que se compro. Si coincide con neto1/2/3 del insumo, la medida es ese
    # envase (CAJA, Pack, Bido...); si no, es la unidad de stock del insumo.
    for c in ['neto1','neto2','neto3']: ins[c]=pd.to_numeric(ins[c],errors='coerce').fillna(0)
    env={r['codigo']:[(r['neto1'],r['envase1']),(r['neto2'],r['envase2']),(r['neto3'],r['envase3'])]
         for _,r in ins.iterrows()}
    d['neton']=pd.to_numeric(d['neto'],errors='coerce').fillna(0)
    def medida_de(i,n):
        if i<=0: return ''
        k=str(int(i))
        if abs(n-1)<1e-9: return med.get(k,'')      # sin presentacion: unidad del insumo
        for netox,envx in env.get(k,[]):            # el envase puede tener nombre vacio
            if netox and abs(netox-n)<1e-4: return envx
        return ''                                   # neto que ya no corresponde a ningun envase
    esins=d['insn']>0
    codigo=np.where(esins, d['insn'].astype(int), pd.to_numeric(d['cod_cga'],errors='coerce').fillna(0).astype(int))
    nombre=[ (nom_ins.get(str(int(i)),'') if i>0 else nom_con.get(c,'')) for i,c in zip(d['insn'],d['cod_cga']) ]
    medida=[ medida_de(i,n) for i,n in zip(d['insn'],d['neton']) ]

    # COD_CGA/NOM_CGA (Diego, 11/10): el concepto de caja de la linea, SIEMPRE,
    # sea la fila un insumo (CODIGO/NOMBRE = insumo) o ya un concepto de gasto
    # (CODIGO/NOMBRE = ese mismo concepto). mxitc trae cod_cga en las dos filas;
    # antes se descartaba cuando CODIGO/NOMBRE mostraban el insumo. Con esto,
    # cada compra de insumo queda asociada a que concepto de caja corresponde.
    cod_cga_n=pd.to_numeric(d['cod_cga'],errors='coerce').fillna(0).astype(int)
    nom_cga=[ nom_con.get(c,'') for c in d['cod_cga'] ]

    out=pd.DataFrame({
        'COD_PRO' : d['cod_pro'].astype(int),
        'COD_CPB' : d['cod_cpb'],
        'NUMERO1' : d['numero1'].astype(int),
        'NUMERO2' : d['numero2'].astype(int),
        'FECHA'   : d['f'],
        'CODIGO'  : codigo,
        'NOMBRE'  : pd.Series(nombre,index=d.index).fillna('').str[:30].str.ljust(30),
        'MEDIDA'  : pd.Series(medida,index=d.index).fillna('').str[:5].str.ljust(5),
        # OJO: la CANTIDAD lleva TRES decimales, no dos. Con dos, una compra de
        # 2,096 kg de remolacha sale 2,1 (se vio comparando el 2025 del bar).
        # Los importes si van con dos.
        'CANTIDAD': d['cantidad'].round(3),
        'NETO'    : d['precio'].round(2),
        'TOTALINS': d['preciotot'].round(2),
        'IVATOT'  : d['ivatot'].round(2),
        'IMPINTTOT': d['imp_inttot'].round(2),
        'TASA'    : d['tasa'].round(2),
        'IVA'     : d['iva'].round(2),
        'IMP_INT' : d['imp_int'].round(2),
        'PERCEP'  : d['PERCEP'].round(2),
        'OBSERVAC': d['observac'].fillna('').str[:40].str.ljust(40),
        'COD_CGA' : cod_cga_n,
        'NOM_CGA' : pd.Series(nom_cga,index=d.index).fillna('').str[:30].str.ljust(30),
    })
    out=out.sort_values(['COD_PRO','COD_CPB','NUMERO1','NUMERO2'],kind='stable').reset_index(drop=True)
    wb=openpyxl.Workbook(); ws=wb.active; ws.title='Hoja1'
    for fila in dataframe_to_rows(out,index=False,header=True): ws.append(fila)
    for c in ws['E'][1:]: c.number_format='mm-dd-yy'
    wb.save(salida)
    return out

if __name__=='__main__':
    B="/mnt/user-data/uploads/Informes ERP/_DATOS/mx_14536 - SERVIDOR-RAMOS/"
    o=generar_25(B,2026,"/mnt/user-data/outputs/25 - compras detalle de compras_2026 V7.XLSX")
    print("filas: {}   TOTALINS {:,.2f}   PERCEP {:,.2f}".format(len(o), o['TOTALINS'].sum(), o['PERCEP'].sum()))
