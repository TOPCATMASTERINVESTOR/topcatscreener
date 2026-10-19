/* TopCat Screener — análise de tendência (intervalos "d")
 *
 * Um intervalo d começa num máximo local (o fecho a partir do qual o preço desce) e acaba no
 * primeiro dia em que o fecho volta a ficar ACIMA desse máximo. Os intervalos seguem-se uns aos
 * outros a partir do ATL; só contam os que têm entre dMin e dMax dias.
 *
 *  Tipo 1:  ATH → queda até ao ATL → recuperação até hoje.   L = ATH→hoje · L1 = ATH→ATL · L2 = ATL→hoje
 *  Tipo 2:  tendência de subida a partir do ATL (ATH depois do ATL).   L = ATL→hoje
 *
 * Funciona no navegador (window.TrendCore) e no Node (module.exports), para os testes.
 */
(function (root) {
  'use strict';
  const DAY = 86400;

  // c: fechos diários; procura intervalos d entre os índices a e b (inclusive)
  function dIntervals(c, a, b) {
    const out = []; let i = a; let open = null;
    const val = (k) => (c[k] == null ? -Infinity : c[k]);
    while (i < b) {
      let p = i; while (p + 1 <= b && val(p + 1) >= val(p)) p++;   // sobe até ao máximo local
      if (p >= b) break;                                           // ainda a subir até hoje: sem recuo
      let j = p + 1; while (j <= b && !(val(j) > val(p))) j++;     // primeiro fecho acima desse máximo
      if (j > b) { open = { from: p, len: b - p, level: c[p] }; break; }   // ainda não regressou ao máximo
      out.push({ from: p, to: j, len: j - p, level: c[p] });
      i = j;
    }
    return { all: out, open };
  }

  const inR = (v, r) => v != null && v >= r[0] && (r[1] == null || v <= r[1]);

  // row: linha dos resultados (com hist {d0, c}, athDate, atlDate); P: { type, L, L1, L2, d } com [mín, máx] em dias
  function analyze(row, P, now) {
    const h = row.hist; if (!h || !h.c || h.c.length < 3) return { ok: false, why: 'nohist' };
    const today = now != null ? now : h.d0 + (h.c.length - 1) * DAY;
    const idxOf = (t) => Math.round((t - h.d0) / DAY);
    const last = h.c.length - 1;
    const athT = row.athDate, atlT = row.atlDate;
    if (atlT == null) return { ok: false, why: 'noatl' };
    const days = (a, b) => Math.max(0, Math.round((b - a) / DAY));
    let L, L1 = null, L2 = null, start, chartFrom;
    if (P.type === 1) {
      if (athT == null || !(athT < atlT)) return { ok: false, why: 'shape' };     // ATH tem de vir antes do ATL
      L = days(athT, today); L1 = days(athT, atlT); L2 = days(atlT, today);
      if (!inR(L, P.L) || !inR(L1, P.L1) || !inR(L2, P.L2)) return { ok: false, why: 'range', L, L1, L2 };
      chartFrom = Math.max(0, idxOf(athT));
    } else {
      if (athT != null && athT < atlT) return { ok: false, why: 'shape' };         // tipo 2: o ATH vem depois do ATL
      L = days(atlT, today);
      if (!inR(L, P.L)) return { ok: false, why: 'range', L };
      chartFrom = Math.max(0, idxOf(atlT));
    }
    start = Math.max(0, Math.min(last, idxOf(atlT)));
    const r = dIntervals(h.c, start, last);
    const counted = r.all.filter((x) => inR(x.len, P.d));
    const n = counted.length;
    const avg = n ? counted.reduce((s, x) => s + x.len, 0) / n : null;
    const lastBreak = r.all.length ? last - r.all[r.all.length - 1].to : null;   // dias desde o último regresso ao máximo
    return { ok: true, n, avg, L, L1, L2, counted, all: r.all, open: r.open, chartFrom, start, last, lastBreak };
  }

  const api = { dIntervals, analyze, DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TrendCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
