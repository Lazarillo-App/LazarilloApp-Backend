import pandas as pd, numpy as np, warnings, openpyxl, re, datetime as dt
from decimal import Decimal
from openpyxl.utils.dataframe import dataframe_to_rows
from gen11 import r2, D
from gen03 import semana_LaD
warnings.filterwarnings('ignore')

RE_ANUL = re.compile(r'Anulaci[oó]n de factura\s+\S+\s+(\d+)-(\d+)\s+Importe:\s*(-?[\d.]+)', re.I)
SEP = 'zzz'

def _num(v):
    """MaxiRest escribe la etiqueta cruda y Excel la interpreta: '01' queda
    numero, '02-1' queda FECHA (mes 02, dia 1) y el resto queda texto."""
    t = v.strip()
    if re.fullmatch(r'\d+', t): return int(t), None
    m = re.fullmatch(r'(\d{1,2})-(\d{1,2})', t)
    if m:
        mes, dia = int(m.group(1)), int(m.group(2))
        if 1 <= mes <= 12 and 1 <= dia <= 31:
            return dt.date(dt.date.today().year, mes, dia), 'd-mmm'
    return v.ljust(7)[:7], None

def generar_04(B, desde=None, hasta=None, salida=None, anio=None):
    if desde is None: desde, hasta = semana_LaD()
    anio = anio or (desde.year if hasattr(desde, 'year') else dt.date.today().year)
    fac = pd.read_csv(B+"20_ventas_cab.tsv",    sep="\t", dtype=str, keep_default_na=False)
    ctc = pd.read_csv(B+"21_ventas_cobros.tsv", sep="\t", dtype=str, keep_default_na=False)
    fmt = pd.read_csv(B+"06_formas_cobro.tsv",  sep="\t", dtype=str, keep_default_na=False)
    ctv = pd.read_csv(B+"05_circuitos.tsv",     sep="\t", dtype=str, keep_default_na=False)
    dto = pd.read_csv(B+"19_descuentos.tsv",    sep="\t", dtype=str, keep_default_na=False)
    cli = pd.read_csv(B+"17_clientes.tsv",      sep="\t", dtype=str, keep_default_na=False)
    aud = pd.read_csv(B+"29_auditoria.tsv",     sep="\t", dtype=str, keep_default_na=False)
    for c in ['total','imp_dto','neto1','iva1','cubiertos']:
        fac[c] = pd.to_numeric(fac[c], errors='coerce').fillna(0)
    fac['f'] = pd.to_datetime(fac['fecha'], errors='coerce')
    ctc['imp'] = pd.to_numeric(ctc['importe'], errors='coerce').fillna(0)

    # Los comprobantes ANULADOS quedan con total 0 y NO entran en ningun total.
    w = fac[(fac.f >= str(desde)) & (fac.f <= str(hasta)) & (fac.total != 0)].copy()
    K = ['cod_cpb','prefijo','numero']
    # los cobros se toman por el comprobante, no por su propia fecha; 'a' son
    # las anulaciones de la venta y cuentan como operacion aunque sumen cero.
    cob = ctc.merge(w[K], on=K, how='inner')
    cob = cob[cob.pago.str.strip().isin(['', 'a'])]
    tipo = dict(zip(fmt.codigo, fmt.tipo))
    cob['tipo'] = cob.cod_for.map(tipo)

    filas = []
    def add(id_, det, imp=0, tot=0, cnt=0, pct=0):
        filas.append({'ID': id_, 'DETALLE': det.ljust(50)[:50], 'IMPORTE': imp,
                      'TOTAL': tot, 'CNTOPER': cnt, 'PORCENTAJE': pct})
    def sep(p): add(p+'-'+SEP, '')

    # --- 01  totales -------------------------------------------------------
    add('01', 'TOTAL', 0, float(r2([w.total.sum()])[0]), len(w))
    TUR = {'1':'Mañana','2':'Noche','3':'Tarde'}
    for t in sorted(w.turno.unique()):
        g = w[w.turno == t]
        add('01', 'TOTAL turno ' + TUR.get(t, t), float(r2([g.total.sum()])[0]), 0, len(g))

    # --- 02  formas de cobro agrupadas por tipo ----------------------------
    for et, lab, sel in [('1','Efectivo', lambda d: d.tipo == 'E'),
                         ('2','Cta.Cte.', lambda d: d.tipo == 'C'),
                         ('6','Otros',    lambda d: ~d.tipo.isin(['E','C']))]:
        g = cob[sel(cob)]
        add('02-'+et, lab, float(r2([g.imp.sum()])[0]), 0, len(g)); sep('02')

    # --- 03  tipos de comprobante ------------------------------------------
    CPB = {'7':('CPB1','Factura B ELECTRÓNICA'), '9':('CPB2','N.Crédito B ELECTRÓNICA'),
           'B':('z',   'Ticket'),               '6':('CPB3','Factura A ELECTRÓNICA'),
           '8':('CPB4','N.Crédito A ELECTRÓNICA')}
    for c in sorted(w.cod_cpb.unique(), key=lambda x: (x not in CPB, x)):
        et, lab = CPB.get(c, (c, c))
        g = w[w.cod_cpb == c]
        add('03-'+et, lab, float(r2([g.total.sum()])[0]), 0, len(g)); sep('03')

    # --- 04  anulaciones (salen del log de auditoria) ----------------------
    aud['f'] = pd.to_datetime(aud['fecha'], errors='coerce')
    aw = aud[(aud.f >= str(desde)) & (aud.f <= str(hasta))]
    # Solo cuentan las que NO se regeneraron: si el comprobante sigue vivo
    # (quedo con total distinto de cero) la anulacion no va al informe.
    vivos = set(zip(w.prefijo.astype(int), w.numero.astype(int)))
    an = []
    for x in aw.detalle:
        m = RE_ANUL.search(x)
        if m and (int(m.group(1)), int(m.group(2))) not in vivos:
            an.append(float(m.group(3)))
    add('04', 'Anulaciones', float(r2([sum(an)])[0]), 0, len(an)); sep('04')

    # --- 05  descuentos ----------------------------------------------------
    nom_dto = dict(zip(dto.codigo, dto.nombre))
    add('05', 'Descuentos')
    dw = w[pd.to_numeric(w.cod_dto, errors='coerce').fillna(0) != 0]
    for c in sorted(dw.cod_dto.unique(), key=lambda x: int(x or 0)):
        g = dw[dw.cod_dto == c]
        add('05-'+str(int(c)), ' %s.%s' % (int(c), nom_dto.get(c, '')),
            float(r2([g.imp_dto.sum()])[0]), 0, len(g))
    sep('05')

    # --- 07  cubiertos -----------------------------------------------------
    for t in sorted(w.turno.unique()):
        add('07', 'Cubiertos Turno ' + TUR.get(t, t), 0, int(w[w.turno == t].cubiertos.sum())); sep('07')
    nom_ctv = dict(zip(ctv.codigo, ctv.nombre))
    for c in sorted(w.cod_ctv.unique()):
        cub = int(w[w.cod_ctv == c].cubiertos.sum())
        if cub: add(c, 'Cubiertos de ' + nom_ctv.get(c, c), 0, cub); sep('07')
    cub = int(w.cubiertos.sum())
    add('07-1', 'TOTAL CUBIERTOS', 0, cub)
    # OJO: este promedio NO coincide con el de MaxiRest y no pude deducir su
    # formula; va el del salon sobre los cubiertos, que es lo que significa.
    sal = w[w.cod_ctv == '-']
    add('07-2', 'Promedio por cubierto',
        float(r2([sal.total.sum()/cub])[0]) if cub else 0)

    # --- 08  circuitos con % ----------------------------------------------
    tot = w.total.sum()
    for c in sorted(w.cod_ctv.unique()):
        g = w[w.cod_ctv == c]
        add('08-'+c, nom_ctv.get(c, c), float(r2([g.total.sum()])[0]), 0, len(g),
            float(r2([g.total.sum()/tot*100])[0]) if tot else 0)

    # --- 09  neto e IVA ----------------------------------------------------
    add('09-1211', 'Neto ACF 21.00%', float(r2([w.neto1.sum()])[0]))
    add('09-1212', 'Iva  ACF 21.00%', float(r2([w.iva1.sum()])[0]))

    # --- clientes dados de alta -------------------------------------------
    cli['fi'] = pd.to_datetime(cli.fecha_ing.replace({'0000-00-00':''}), errors='coerce')
    nue = cli[(cli.fi >= str(desde)) & (cli.fi <= str(hasta))]
    add('', ''); add('', ''); add('', 'Clientes dados de alta'); add('', '')
    for _, r in nue.iterrows():
        add('', '%s.%s' % (r.codigo, r.nombre.strip()))

    out = pd.DataFrame(filas)
    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        ws.append(list(out.columns))
        for r in out.itertuples(index=False):
            v, fm = _num(r.ID)
            ws.append([v, r.DETALLE, r.IMPORTE, r.TOTAL, r.CNTOPER, r.PORCENTAJE])
            if fm: ws.cell(row=ws.max_row, column=1).number_format = fm
        wb.save(salida)
    return out
