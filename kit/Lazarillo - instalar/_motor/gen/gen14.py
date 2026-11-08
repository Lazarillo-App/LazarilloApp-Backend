import pandas as pd, numpy as np, warnings, openpyxl
from openpyxl.utils.dataframe import dataframe_to_rows
warnings.filterwarnings('ignore')

def _fecha_segura(s):
    # Fechas con año fuera de rango (typos de carga en MaxiRest: 0222-12-27,
    # 2921-12-17...) pasan el errors='coerce' y revientan despues en el concat
    # (OutOfBoundsDatetime, Comercio 25/10/2026). Se blanquean ANTES de parsear.
    s=s.astype(str)
    a=pd.to_numeric(s.str[:4],errors='coerce')
    return pd.to_datetime(s.where(a.between(1700,2200),''),errors='coerce')

def generar_14(base_dir, anio, salida):
    B=base_dir
    det=pd.read_csv(B+"23_compras_detalle.tsv",sep="\t",dtype=str,keep_default_na=False)
    cab=pd.read_csv(B+"24_compras_cab.tsv",sep="\t",dtype=str,keep_default_na=False)
    prov=pd.read_csv(B+"13_proveedores.tsv",sep="\t",dtype=str,keep_default_na=False)
    emp=pd.read_csv(B+"04_empleados.tsv",sep="\t",dtype=str,keep_default_na=False)
    con=pd.read_csv(B+"12_conceptos_caja.tsv",sep="\t",dtype=str,keep_default_na=False)

    for c in ['preciotot','ivatot','imp_inttot']: det[c]=pd.to_numeric(det[c],errors='coerce').fillna(0)
    cab['total']=pd.to_numeric(cab['total'],errors='coerce').fillna(0)
    cab['imp_int']=pd.to_numeric(cab['imp_int'],errors='coerce').fillna(0)
    cab['f']=_fecha_segura(cab['fecha'])
    cab['fi']=_fecha_segura(cab['fecha_ing'])
    K=['cod_pro','cod_suc','cod_cpb','numero1','numero2']

    # (a) detalle agrupado por comprobante + concepto
    det['imp']=det['preciotot']+det['ivatot']+det['imp_inttot']   # incluye impuestos internos
    A=det.groupby(K+['cod_cga'],as_index=False).agg(imp=('imp','sum'), imp_int=('imp_inttot','sum'))
    A=A.merge(cab[K+['f','fi','observac']],on=K,how='left')
    A.loc[A['cod_cpb']=='+','imp']*=-1            # NC: el detalle viene positivo

    # (b) cabeceras SIN detalle: el concepto va en la cabecera
    condet=set(map(tuple,det[K].values.tolist()))
    cab['tiene']=[tuple(r) in condet for r in cab[K].values.tolist()]
    Bc=cab[~cab['tiene']][K+['cod_cga','total','imp_int','f','fi','observac']].rename(columns={'total':'imp'})

    G=pd.concat([A,Bc],ignore_index=True)

    # periodo: por fecha de comprobante, salvo liquidaciones (E) que van por periodo (fecha_ing)
    ini,fin=f"{anio}-01-01",f"{anio+1}-01-01"
    en=lambda s:(s>=ini)&(s<fin)
    G=G[np.asarray(np.where(G['cod_cpb']=='E', en(G['fi']), en(G['f'])))]
    G=G[~G['cod_cga'].isin(['0',''])]             # el informe es POR concepto

    # ------------------------------------------------------------------
    #  FECHA_PAGO / CAJA_PAGO (Diego, 24/10/2026) - dos columnas al FINAL,
    #  solo para lo que no tiene comprobante de proveedor: gastos varios (G)
    #  y sueldos/adelantos (E). Las facturas se siguen pagando por el 80.
    #  Salen de mxpag (38_compras_pagos.tsv) por la clave del comprobante:
    #  tipo 1 = CAJA (la del turno), 2 = CAJA MAYOR, 3 = BANCOS, vacio = CONTADO.
    #  Medido el 24/10: casi siempre se pagan el mismo dia del gasto; lo que
    #  cambia es de que caja sale la plata.
    #  PERIODO (Diego, 24/10): en los sueldos (E) FECHA es el dia en que se
    #  pagaron (ej. 14/05) y el mes que liquidan es fecha_ing (ej. 01/04).
    #  Cada concepto (sueldo, SAC, vacaciones, presentismo...) trae su periodo.
    # ------------------------------------------------------------------
    CAJAS={'1':'CAJA','2':'CAJA MAYOR','3':'BANCOS','':'CONTADO'}
    G['fp']=pd.NaT; G['cp']=''
    try:
        pag=pd.read_csv(B+"38_compras_pagos.tsv",sep="\t",dtype=str,keep_default_na=False)
        pag=pag[pag['cod_cpb'].isin(['G','E']) & pag['tipo'].isin(list(CAJAS))].copy()
        pag['f']=_fecha_segura(pag['fecha'])
        pag['c']=pag['tipo'].map(CAJAS)
        agg=pag.groupby(K,as_index=False).agg(fp=('f','max'),cp=('c',lambda v:' + '.join(sorted(set(v)))))
        G=G.drop(columns=['fp','cp']).merge(agg,on=K,how='left')
        G['cp']=G['cp'].fillna('')
    except FileNotFoundError:
        pass
    sinprov=G['cod_cpb'].isin(['G','E']).values
    G.loc[~sinprov,'fp']=pd.NaT; G.loc[~sinprov,'cp']=''

    # nombres
    nom_con=dict(zip(con['codigo'],con['nombre']))
    nom_pro=dict(zip(prov['codigo'],prov['nombre']))
    nom_emp=dict(zip(emp['codigo'],emp['nombre']))
    def quien(cp):
        n=int(cp)
        return nom_emp.get(str(abs(n)),'') if n<0 else nom_pro.get(cp,'')
    ETQ={'A':'A  ','Z':'Tic ','C':'C  ','+':'NC  ','E':'','G':''}
    def detalle(r):
        e=ETQ.get(r['cod_cpb'],'')
        if not e: return ''
        return f"{e}{int(r['numero1']):04d}-{int(r['numero2']):08d}"

    # Sin proveedor (cod_pro = 0): el informe repite el codigo del concepto
    # y rotula "GASTOS VARIOS".
    cp=G['cod_pro'].astype(int)
    codigo=np.where(cp==0, G['cod_cga'].astype(int), cp.abs())
    quienes=[('GASTOS VARIOS' if int(c)==0 else quien(c)) for c in G['cod_pro']]

    out=pd.DataFrame({
        'COD_CGA' : G['cod_cga'].astype(int),
        'CONCEPTO': G['cod_cga'].map(lambda c: nom_con.get(c,'')[:25].ljust(25)),
        'FECHA'   : G['f'],
        'CODIGO'  : codigo,
        'PROVEEDOR': pd.Series(quienes,index=G.index).fillna('').str[:30].str.ljust(30),
        'DETALLE' : G.apply(detalle,axis=1).str[:30].str.ljust(30),
        'OBSERVAC': G['observac'].fillna('').str[:40].str.ljust(40),
        'IMPORTE' : G['imp'].round(2),
        'IMP_INT' : G['imp_int'].round(2),
        'IMPUTAC' : '        ',
        'PER1':0.0,'PER2':0.0,'PER3':0,
        'FECHA_PAGO': G['fp'].values,
        'CAJA_PAGO' : G['cp'].values,
        'PERIODO'   : np.where(G['cod_cpb'].values=='E', G['fi'].values, np.datetime64('NaT')),
    })
    # -------------------------------------------------------------
    #  FILAS SIN NUMERO DE COMPROBANTE (gastos de caja 'G' y adelantos /
    #  liquidaciones 'E'): MaxiRest deja DETALLE en blanco. Si dos de esas filas
    #  coinciden en concepto + fecha + quien + importe + observacion, el importador del Panel
    #  las toma como "fila repetida" y descarta la segunda (caso real: dos
    #  adelantos de $100.000 a Sebastian el 14/10/2025, comprobantes 9 y 11).
    #  Para no perder gastos, a la 2da ocurrencia en adelante se le escribe en
    #  DETALLE el numero interno real (ej. "E 0011-20251014"). La primera queda
    #  en blanco como siempre, asi las filas ya importadas no cambian de clave.
    #  (Diego, 21/10/2026)
    # -------------------------------------------------------------
    out['_cpb']=G['cod_cpb'].values; out['_n1']=G['numero1'].values; out['_n2']=G['numero2'].values
    sinnum=out['DETALLE'].str.strip()==''
    import unicodedata as _ud
    _norm=lambda t: _ud.normalize('NFKD',str(t)).encode('ascii','ignore').decode().strip().lower()
    out['_obs']=out['OBSERVAC'].map(_norm)   # el importador compara la observacion normalizada (sin mayusculas ni acentos)
    clave=['COD_CGA','FECHA','CODIGO','PROVEEDOR','IMPORTE','_obs']
    rep=sinnum & out.duplicated(clave,keep='first')
    def numint(r):
        try: return f"{r['_cpb']} {int(r['_n1']):04d}-{int(r['_n2']):08d}"[:30].ljust(30)
        except Exception: return r['DETALLE']
    out.loc[rep,'DETALLE']=out[rep].apply(numint,axis=1)
    out=out.drop(columns=['_cpb','_n1','_n2','_obs'])
    out=out.sort_values(['COD_CGA','FECHA'],kind='stable').reset_index(drop=True)

    # -------------------------------------------------------------
    #  PERCEPCIONES, UNA FILA POR COMPROBANTE (Diego, 21/10/2026).
    #  Historia: MaxiRest pone UNA sola fila "TOTAL PERCEPCIONES" al final del
    #  año. Del 24/09 al 21/10 este generador emitía 3 filas resumen por mes
    #  (IVA / ING.B. / GANANCIAS, fecha 1 del mes, sin proveedor). Eso rompió
    #  la importación en el Panel de Gestión: el resumen del mes en curso
    #  cambia todos los días y, al no tener proveedor ni comprobante, el
    #  importador no lo reconocía y acumulaba una fila nueva por importación.
    #  Ahora cada percepción sale como una fila mas del comprobante que la
    #  trae, con su proveedor, su comprobante y el concepto de percepcion:
    #    cod_ins -1 -> 133 Percepcion IVA        (columna PER1)
    #    cod_ins -2 -> 899 IB PERCEPCION          (columna PER2)
    #    cod_ins -3 -> 137 percepcion ganancias   (columna PER3)
    #  El -7 NO es percepcion (MaxiRest no lo cuenta). El importe de la fila
    #  va tambien en su columna PERn para no romper el formato de MaxiRest.
    #  Misma clave que el resto del informe (proveedor + comprobante +
    #  concepto), misma fecha (cabecera; liquidaciones E por fecha_ing) y
    #  en las NC la percepcion ya viene negativa en la base. La suma por mes es identica a las
    #  filas resumen anteriores (verificado contra el 14 del Bar 2026).
    # -------------------------------------------------------------
    PER={'-1':('PER1',133,'Percepcion IVA'),
         '-2':('PER2',899,'IB PERCEPCION'),
         '-3':('PER3',137,'percepcion ganancias')}
    per=det[det['cod_ins'].isin(list(PER))].copy()
    if len(per):
        per['pt']=pd.to_numeric(per['preciotot'],errors='coerce').fillna(0)
        P=per.groupby(K+['cod_ins'],as_index=False).agg(pt=('pt','sum'))
        P=P.merge(cab[K+['f','fi','observac']],on=K,how='left')
        # OJO: a diferencia de las lineas de mercaderia, las de percepcion de una NC
        # YA vienen en negativo en mxitc -> no se invierte el signo (verificado abril 2026)
        P=P[np.asarray(np.where(P['cod_cpb']=='E', en(P['fi']), en(P['f'])))]
        P=P[P['pt'].round(2)!=0]
    if len(per) and len(P):
        cpp=P['cod_pro'].astype(int)
        cga=P['cod_ins'].map(lambda c: PER[c][1])
        quienes_p=[('GASTOS VARIOS' if int(c)==0 else quien(c)) for c in P['cod_pro']]
        outp=pd.DataFrame({
            'COD_CGA' : cga.astype(int),
            'CONCEPTO': P['cod_ins'].map(lambda c: PER[c][2][:25].ljust(25)),
            'FECHA'   : P['f'],
            'CODIGO'  : np.where(cpp==0, cga.astype(int), cpp.abs()),
            'PROVEEDOR': pd.Series(quienes_p,index=P.index).fillna('').str[:30].str.ljust(30),
            'DETALLE' : P.apply(detalle,axis=1).str[:30].str.ljust(30),
            'OBSERVAC': P['observac'].fillna('').str[:40].str.ljust(40),
            'IMPORTE' : P['pt'].round(2),
            'IMP_INT' : 0.0,
            'IMPUTAC' : '        ',
            'PER1':0.0,'PER2':0.0,'PER3':0.0,
            'FECHA_PAGO': pd.NaT,
            'CAJA_PAGO' : '',
            'PERIODO'   : pd.NaT,
        })
        for c,(col,_,_) in PER.items():
            m=(P['cod_ins']==c).values
            outp.loc[m,col]=outp.loc[m,'IMPORTE']
        outp=outp.sort_values(['COD_CGA','FECHA'],kind='stable')
        out=pd.concat([out,outp],ignore_index=True)

    wb=openpyxl.Workbook(); ws=wb.active; ws.title='Hoja1'
    for fila in dataframe_to_rows(out,index=False,header=True): ws.append(fila)
    for c in ws['C'][1:]: c.number_format='mm-dd-yy'
    for c in ws['N'][1:]: c.number_format='mm-dd-yy'     # FECHA_PAGO
    for c in ws['P'][1:]: c.number_format='mm-dd-yy'     # PERIODO
    wb.save(salida)
    return out

if __name__=='__main__':
    import sys
    B=sys.argv[1] if len(sys.argv)>1 else "/mnt/user-data/uploads/Informes ERP/_DATOS/mx_14536 - SERVIDOR-RAMOS/"
    o=generar_14(B,2026,sys.argv[2] if len(sys.argv)>2 else "/mnt/user-data/outputs/14 - GASTOS COMPRAS DETALLADO_2026 V7.XLSX")
    print("filas: {}  total: {:,.2f}".format(len(o), o['IMPORTE'].sum()))
    print(o.head(4).to_string(index=False,max_colwidth=32))
