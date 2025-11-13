// utils/range.js
function toISO(d){ return new Date(d).toISOString().slice(0,10); }
function addDaysISO(dateLike, n){
  const d = new Date(dateLike);
  d.setDate(d.getDate() + n);
  return toISO(d);
}
function diffDays(a,b){ return Math.floor((new Date(b) - new Date(a)) / 86400000); }

function defaultRange(){
  const to = toISO(new Date());
  const from = addDaysISO(to, -13);
  return { from, to };
}

function validateClampRange({ from, to }, maxDays = 31){
  if (!from || !to) return defaultRange();
  const span = diffDays(from, to);
  if (span < 0) throw new Error('Rango inválido: from > to');
  if (span > maxDays) {
    const to2 = to;
    const from2 = addDaysISO(to2, -(maxDays - 1));
    return { from: from2, to: to2 };
  }
  return { from, to };
}

module.exports = { validateClampRange };
