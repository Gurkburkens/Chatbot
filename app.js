// ────────────────────────────────────────
//   CRYPTOBOT PRO – app.js
//   API: CoinGecko (ingen CORS, ingen geo-blockering)
// ────────────────────────────────────────

const USD_SEK   = 10.5;
const RSI_KÖP   = 38;
const RSI_SÄLJ  = 63;
const ADX_GRÄNS = 25;
const TRAILING  = 0.15;
const MIN_VINST = 0.03;
const MAX_PTS   = 80;

const COINGECKO = 'https://api.coingecko.com/api/v3';
const COIN_IDS  = { BTCUSDT: 'bitcoin', ETHUSDT: 'ethereum' };

let liveSymbol  = 'BTCUSDT';
let liveHistory = [];
let killSwitch  = false;
let bigChart    = null;
let calcChart   = null;

// ── Indikatorer ────────────────────────────────────────

function beräknaRSI(p, n = 14) {
  if (p.length < n + 1) return 50;
  const d = p.slice(-(n + 1)).map((v, i, a) => i === 0 ? 0 : v - a[i - 1]).slice(1);
  const g = d.map(x => x > 0 ? x : 0);
  const l = d.map(x => x < 0 ? -x : 0);
  const ag = g.reduce((a, b) => a + b, 0) / n;
  const al = l.reduce((a, b) => a + b, 0) / n;
  if (al === 0) return 100;
  return parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

function beräknaEMA(p, n) {
  if (p.length < n) return p[p.length - 1];
  let e = p.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const k = 2 / (n + 1);
  for (let i = n; i < p.length; i++) e = p[i] * k + e * (1 - k);
  return e;
}

function beräknaMA(p, n) {
  if (p.length < n) return p[p.length - 1];
  return p.slice(-n).reduce((a, b) => a + b, 0) / n;
}

function beräknaADX(p, n = 14) {
  if (p.length < n * 2) return 20;
  const hi = p.map(x => x * 1.002);
  const lo = p.map(x => x * 0.998);
  const tr = [], dmp = [], dmn = [];
  for (let i = 1; i < p.length; i++) {
    tr.push(Math.max(hi[i] - lo[i], Math.abs(hi[i] - p[i - 1]), Math.abs(lo[i] - p[i - 1])));
    const pd = hi[i] - hi[i - 1];
    const nd = lo[i - 1] - lo[i];
    dmp.push(pd > nd && pd > 0 ? pd : 0);
    dmn.push(nd > pd && nd > 0 ? nd : 0);
  }
  const atr = tr.slice(-n).reduce((a, b) => a + b, 0) / n || 1;
  const dip = 100 * dmp.slice(-n).reduce((a, b) => a + b, 0) / n / atr;
  const din = 100 * dmn.slice(-n).reduce((a, b) => a + b, 0) / n / atr;
  return parseFloat((100 * Math.abs(dip - din) / (dip + din || 1)).toFixed(1));
}

// ── CoinGecko API ──────────────────────────────────────

async function hämtaPrisOchHistorik(coinId) {
  const [priceRes, histRes] = await Promise.all([
    fetch(`${COINGECKO}/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`),
    fetch(`${COINGECKO}/coins/${coinId}/market_chart?vs_currency=usd&days=5&interval=hourly`),
  ]);
  if (!priceRes.ok || !histRes.ok) throw new Error('CoinGecko svarade inte');
  const priceData = await priceRes.json();
  const histData  = await histRes.json();
  return {
    pris:   priceData[coinId].usd,
    ch24:   priceData[coinId].usd_24h_change,
    closes: histData.prices.map(p => p[1]),
  };
}

async function hämtaHistorikDaglig(coinId, dagar) {
  const res = await fetch(`${COINGECKO}/coins/${coinId}/market_chart?vs_currency=usd&days=${dagar}&interval=daily`);
  if (!res.ok) throw new Error('Kunde inte hämta historik');
  const data = await res.json();
  return data.prices.map(p => ({
    datum: new Date(p[0]).toISOString().slice(0, 10),
    close: p[1],
  }));
}

// ── Live Chart ─────────────────────────────────────────

function initBigChart() {
  bigChart = new Chart(document.getElementById('bigChart'), {
    type: 'line',
    data: {
      labels: Array(MAX_PTS).fill(''),
      datasets: [
        { label:'Pris', data:Array(MAX_PTS).fill(null), borderColor:'#f59e0b', borderWidth:2, pointRadius:0, tension:0.3, fill:true, backgroundColor:'rgba(245,158,11,0.05)' },
        { label:'MA20', data:Array(MAX_PTS).fill(null), borderColor:'#4444aa', borderWidth:1, pointRadius:0, tension:0.3, fill:false, borderDash:[5,4] },
        { label:'KÖP',  data:Array(MAX_PTS).fill(null), type:'scatter', backgroundColor:'#22c55e', pointRadius:7, pointStyle:'triangle', showLine:false },
        { label:'SÄLJ', data:Array(MAX_PTS).fill(null), type:'scatter', backgroundColor:'#ef4444', pointRadius:7, pointStyle:'triangle', rotation:180, showLine:false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor:'#13131a', borderColor:'#22222e', borderWidth:1,
          titleColor:'#6b6b88', bodyColor:'#f0f0f8',
          callbacks: { label: ctx => `${ctx.dataset.label}: $${Math.round(ctx.parsed.y).toLocaleString('sv-SE')}` },
        },
      },
      scales: {
        x: { ticks:{ color:'#3a3a50', font:{size:10}, maxTicksLimit:8 }, grid:{ color:'#1a1a24' } },
        y: { ticks:{ color:'#3a3a50', font:{size:10}, callback: v => '$' + Math.round(v).toLocaleString('sv-SE') }, grid:{ color:'#1a1a24' } },
      },
    },
  });
}

function pushLive(pris, ma20Val, signal, tid) {
  if (bigChart.data.labels.length >= MAX_PTS) {
    bigChart.data.labels.shift();
    bigChart.data.datasets.forEach(d => d.data.shift());
  }
  bigChart.data.labels.push(tid);
  bigChart.data.datasets[0].data.push(pris);
  bigChart.data.datasets[1].data.push(ma20Val);
  bigChart.data.datasets[2].data.push(signal === 'KÖP'  ? pris : null);
  bigChart.data.datasets[3].data.push(signal === 'SÄLJ' ? pris : null);
  bigChart.update('none');
}

// ── UI helpers ─────────────────────────────────────────

function setMetric(id, value, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.className   = 'metric-tile-value ' + cls;
}

function setBadge(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = 'ind-badge ' + cls;
}

function uppdateraIndKort(rsiVal, adxVal, avvPct) {
  document.getElementById('rsi-big').textContent      = rsiVal.toFixed(1);
  document.getElementById('rsi-fill').style.width     = rsiVal + '%';
  document.getElementById('rsi-fill').style.background = rsiVal < RSI_KÖP ? '#22c55e' : rsiVal > RSI_SÄLJ ? '#ef4444' : '#6b6b88';
  setBadge('rsi-badge', rsiVal < RSI_KÖP ? 'KÖPZON' : rsiVal > RSI_SÄLJ ? 'SÄLJZON' : 'NEUTRALT', rsiVal < RSI_KÖP ? 'ibuy' : rsiVal > RSI_SÄLJ ? 'isell' : 'ihold');

  document.getElementById('adx-big').textContent      = adxVal.toFixed(1);
  document.getElementById('adx-fill').style.width     = Math.min(adxVal, 100) + '%';
  document.getElementById('adx-fill').style.background = adxVal > ADX_GRÄNS ? '#60a5fa' : '#6b6b88';
  setBadge('adx-badge', adxVal > ADX_GRÄNS ? 'STARK TREND' : 'SVAG TREND', adxVal > ADX_GRÄNS ? 'istrong' : 'iweak');

  document.getElementById('ma-big').textContent       = (avvPct >= 0 ? '+' : '') + avvPct.toFixed(2) + '%';
  const maPct = Math.min(Math.max((avvPct + 15) / 30 * 100, 0), 100);
  document.getElementById('ma-fill').style.width      = maPct + '%';
  document.getElementById('ma-fill').style.background  = avvPct <= -5 ? '#22c55e' : avvPct > 5 ? '#ef4444' : '#6b6b88';
  setBadge('ma-badge', avvPct <= -5 ? 'DIPP' : avvPct > 5 ? 'ÖVERKÖPT' : 'NORMALT', avvPct <= -5 ? 'ibuy' : avvPct > 5 ? 'isell' : 'ihold');
}

// ── Live uppdatering ───────────────────────────────────

async function uppdateraLive() {
  try {
    const coinId = COIN_IDS[liveSymbol];
    const { pris, ch24, closes } = await hämtaPrisOchHistorik(coinId);
    liveHistory = closes;

    const rsiVal  = beräknaRSI(liveHistory);
    const adxVal  = beräknaADX(liveHistory);
    const ma20Val = beräknaMA(liveHistory, 20);
    const avv     = (pris - ma20Val) / ma20Val * 100;
    const ema20   = beräknaEMA(liveHistory, 20);
    const ema50   = beräknaEMA(liveHistory, 50);
    const emaCross = liveHistory.length > 52 &&
      beräknaEMA(liveHistory.slice(0, -1), 20) <= beräknaEMA(liveHistory.slice(0, -1), 50) &&
      ema20 > ema50;

    if (liveHistory.length >= 168) {
      const vf = (pris - liveHistory[liveHistory.length - 169]) / liveHistory[liveHistory.length - 169];
      if (vf <= -0.25) killSwitch = true;
      if (killSwitch && vf > -0.10 && rsiVal > 35 && rsiVal < 60) killSwitch = false;
    }

    let signal = 'AVVAKTAR';
    if (killSwitch)                                                  signal = 'KILL SWITCH';
    else if (rsiVal > RSI_SÄLJ)                                      signal = 'SÄLJSIGNAL';
    else if (avv <= -5 && rsiVal < RSI_KÖP)                         signal = 'KÖPSIGNAL (dipp)';
    else if (emaCross && adxVal > ADX_GRÄNS && rsiVal < RSI_SÄLJ)   signal = 'KÖPSIGNAL (EMA)';

    const tid         = new Date().toLocaleTimeString('sv-SE');
    const chartSignal = signal.includes('KÖP') ? 'KÖP' : signal.includes('SÄLJ') ? 'SÄLJ' : null;
    pushLive(pris, ma20Val, chartSignal, tid);

    document.getElementById('live-price').textContent   = '$' + pris.toLocaleString('sv-SE', { maximumFractionDigits: 0 });
    document.getElementById('live-updated').textContent = 'Uppdaterad ' + tid;
    const chEl = document.getElementById('live-change');
    chEl.textContent = (ch24 >= 0 ? '+' : '') + ch24.toFixed(2) + '% (24h)';
    chEl.className   = 'price-change ' + (ch24 >= 0 ? 'pos' : 'neg');

    const sigColors = { 'KÖPSIGNAL (dipp)':'#22c55e', 'KÖPSIGNAL (EMA)':'#22c55e', 'SÄLJSIGNAL':'#ef4444', 'KILL SWITCH':'#ef4444', 'AVVAKTAR':'#6b6b88' };
    const sigEl = document.getElementById('live-signal-box');
    sigEl.textContent = signal;
    sigEl.style.color = sigColors[signal] || '#6b6b88';

    document.getElementById('hero-rsi').textContent    = rsiVal.toFixed(1);
    document.getElementById('hero-rsi').style.color    = rsiVal < RSI_KÖP ? '#22c55e' : rsiVal > RSI_SÄLJ ? '#ef4444' : '#22c55e';
    document.getElementById('hero-signal').textContent = signal;
    document.getElementById('hero-signal').style.color = sigColors[signal] || '#6b6b88';

    setMetric('m-rsi',  rsiVal.toFixed(1),  rsiVal < RSI_KÖP ? 'pos' : rsiVal > RSI_SÄLJ ? 'neg' : 'gold');
    setMetric('m-adx',  adxVal.toFixed(1),  adxVal > ADX_GRÄNS ? 'pos' : 'gold');
    setMetric('m-ma',   (avv >= 0 ? '+' : '') + avv.toFixed(2) + '%', avv <= -5 ? 'pos' : avv > 5 ? 'neg' : 'gold');
    setMetric('m-kill', killSwitch ? 'AKTIV' : 'Inaktiv', killSwitch ? 'neg' : 'pos');
    setMetric('m-ema',  emaCross ? 'Korsning!' : 'Ingen', emaCross ? 'pos' : 'gold');
    uppdateraIndKort(rsiVal, adxVal, avv);

  } catch (e) {
    console.error('Live-fel:', e);
    document.getElementById('live-updated').textContent = 'Uppdateringsfel – försöker igen om 60s...';
  }
}

async function uppdateraHeroPriser() {
  try {
    const res  = await fetch(`${COINGECKO}/simple/price?ids=bitcoin,ethereum&vs_currencies=usd`);
    const data = await res.json();
    document.getElementById('hero-btc').textContent = '$' + Math.round(data.bitcoin.usd).toLocaleString('sv-SE');
    document.getElementById('hero-eth').textContent = '$' + Math.round(data.ethereum.usd).toLocaleString('sv-SE');
  } catch (e) { console.error('Hero-prisfel:', e); }
}

function byttSymbol(sym, btn) {
  liveSymbol  = sym;
  liveHistory = [];
  document.querySelectorAll('.sym-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (bigChart) {
    bigChart.data.labels.fill('');
    bigChart.data.datasets.forEach(d => d.data.fill(null));
    bigChart.update('none');
  }
  uppdateraLive();
}

// ── Kalkylator ─────────────────────────────────────────

async function körKalkylator() {
  const kapSEK = parseFloat(document.getElementById('c-kapital').value) || 1000;
  const manSEK = parseFloat(document.getElementById('c-manad').value)   || 0;
  const symbol = document.getElementById('c-symbol').value;
  const dagar  = parseInt(document.getElementById('c-period').value);
  const kapUSD = kapSEK / USD_SEK;
  const manUSD = manSEK / USD_SEK;
  const coinId = COIN_IDS[symbol];

  const btn = document.getElementById('calc-btn');
  btn.textContent = 'Hämtar data från CoinGecko...';
  btn.disabled    = true;

  try {
    const rawData = await hämtaHistorikDaglig(coinId, dagar);
    const data    = rawData.slice(-dagar);
    const priser  = data.map(d => d.close);

    let cash = kapUSD, coin = 0, entry = 0, topp = 0;
    let totInsatt = kapUSD, totInsattSEK = kapSEK;
    const trades = [], botVals = [], hodlVals = [], insattVals = [];
    const hodlCoin = kapUSD / priser[0];
    let dcaDag = 0, manadDag = 0;

    for (let i = 20; i < priser.length; i++) {
      const p = priser[i], hist = priser.slice(0, i + 1);
      const r = beräknaRSI(hist), ma20 = beräknaMA(hist, 20), avv = (p - ma20) / ma20;

      manadDag++;
      if (manadDag >= 30 && manUSD > 0) { cash += manUSD; totInsatt += manUSD; totInsattSEK += manSEK; manadDag = 0; }

      if (coin > 0) {
        if (p > topp) topp = p;
        if (p <= topp * (1 - TRAILING)) {
          const vp = (p - entry) / entry * 100;
          trades.push({ datum: data[i].datum, typ: 'SÄLJ', pris: p, vp, orsak: `Trailing stop (${vp >= 0 ? '+' : ''}${vp.toFixed(1)}%)` });
          cash = coin * p; coin = 0; entry = 0; topp = 0;
        }
      }

      if (coin > 0 && r > RSI_SÄLJ) {
        const vp = (p - entry) / entry * 100;
        if (vp >= MIN_VINST * 100) {
          trades.push({ datum: data[i].datum, typ: 'SÄLJ', pris: p, vp, orsak: `RSI ${r.toFixed(0)}` });
          cash = coin * p; coin = 0; entry = 0; topp = 0;
        }
      }

      dcaDag++;
      if (dcaDag >= 7) {
        const bel = Math.min(cash * 0.25, kapUSD * 0.3);
        if (bel > 3 && r <= RSI_SÄLJ) {
          const m = bel / p;
          entry = coin === 0 ? p : (entry * coin + p * m) / (coin + m);
          if (coin === 0 || p > topp) topp = p;
          coin += m; cash -= bel;
          trades.push({ datum: data[i].datum, typ: 'DCA', pris: p, vp: null, orsak: `DCA (RSI ${r.toFixed(0)})` });
          dcaDag = 0;
        }
      }

      if (avv <= -0.05 && r < RSI_KÖP && cash > 5) {
        const bel = cash * 0.5, m = bel / p;
        entry = coin === 0 ? p : (entry * coin + p * m) / (coin + m);
        if (coin === 0 || p > topp) topp = p;
        coin += m; cash -= bel;
        trades.push({ datum: data[i].datum, typ: 'KÖP', pris: p, vp: null, orsak: `Dipp ${(avv * 100).toFixed(1)}%` });
      }

      botVals.push(Math.round((cash + coin * p) * USD_SEK));
      hodlVals.push(Math.round((hodlCoin * p + manUSD * Math.floor(i / 30)) * USD_SEK));
      insattVals.push(Math.round(totInsattSEK));
    }

    const labels   = data.slice(20).map(d => d.datum);
    const slutBot  = botVals[botVals.length - 1];
    const slutHodl = hodlVals[hodlVals.length - 1];
    const botPnl   = slutBot - totInsattSEK;
    const botPct   = botPnl / totInsattSEK * 100;
    const hodlPct  = (slutHodl - totInsattSEK) / totInsattSEK * 100;
    const bankPct  = dagar / 365 * 2.5;

    document.getElementById('result-big').innerHTML = `
      <div class="result-card highlight"><div class="result-label">SLUTVÄRDE (BOT)</div><div class="result-value gold">${Math.round(slutBot).toLocaleString('sv-SE')} kr</div><div class="result-sub">Insatt: ${Math.round(totInsattSEK).toLocaleString('sv-SE')} kr</div></div>
      <div class="result-card ${botPct >= 0 ? 'green-bg' : 'red-bg'}"><div class="result-label">BOTENS AVKASTNING</div><div class="result-value ${botPct >= 0 ? 'green' : 'red'}">${botPct >= 0 ? '+' : ''}${botPct.toFixed(1)}%</div><div class="result-sub">${botPnl >= 0 ? '+' : ''}${Math.round(botPnl).toLocaleString('sv-SE')} kr</div></div>
      <div class="result-card blue-bg"><div class="result-label">HODL HADE GETT</div><div class="result-value blue">${hodlPct >= 0 ? '+' : ''}${hodlPct.toFixed(1)}%</div><div class="result-sub">${Math.round(slutHodl).toLocaleString('sv-SE')} kr</div></div>
      <div class="result-card"><div class="result-label">SPARKONTO (2.5%/år)</div><div class="result-value" style="color:var(--muted)">+${bankPct.toFixed(2)}%</div><div class="result-sub">Bot: ${botPct >= bankPct ? '+' : ''}${(botPct - bankPct).toFixed(1)}%</div></div>
      <div class="result-card"><div class="result-label">ANTAL AFFÄRER</div><div class="result-value gold">${trades.length}</div><div class="result-sub">${trades.filter(t => t.typ === 'SÄLJ').length} sälj · ${trades.filter(t => t.typ !== 'SÄLJ').length} köp</div></div>
      <div class="result-card"><div class="result-label">INSATT TOTALT</div><div class="result-value" style="color:var(--text)">${Math.round(totInsattSEK).toLocaleString('sv-SE')} kr</div><div class="result-sub">${kapSEK.toLocaleString('sv-SE')} kr start${manSEK > 0 ? ' + ' + manSEK.toLocaleString('sv-SE') + ' kr/mån' : ''}</div></div>`;

    if (calcChart) calcChart.destroy();
    calcChart = new Chart(document.getElementById('calcChart'), {
      type: 'line',
      data: { labels, datasets: [
        { label:'Bot', data:botVals, borderColor:'#f59e0b', borderWidth:2, pointRadius:0, tension:0.3, fill:true, backgroundColor:'rgba(245,158,11,0.06)' },
        { label:'HODL', data:hodlVals, borderColor:'#60a5fa', borderWidth:1.5, borderDash:[5,4], pointRadius:0, tension:0.3, fill:false },
        { label:'Insatt', data:insattVals, borderColor:'#3a3a50', borderWidth:1, borderDash:[2,3], pointRadius:0, fill:false },
      ]},
      options: { responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{ backgroundColor:'#13131a', borderColor:'#22222e', borderWidth:1, titleColor:'#6b6b88', bodyColor:'#f0f0f8', callbacks:{ label: ctx => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString('sv-SE')} kr` }}},
        scales:{ x:{ticks:{color:'#3a3a50',font:{size:10},maxTicksLimit:8},grid:{color:'#1a1a24'}}, y:{ticks:{color:'#3a3a50',font:{size:10},callback:v=>Math.round(v).toLocaleString('sv-SE')+' kr'},grid:{color:'#1a1a24'}} }
      },
    });

    document.getElementById('trades-count-label').textContent = `${trades.length} affärer totalt`;
    document.getElementById('trades-mini').innerHTML =
      '<div class="trade-row-mini" style="color:var(--muted);font-size:10px;"><span>DATUM</span><span>TYP</span><span>PRIS</span><span>VINST</span><span>ORSAK</span></div>' +
      trades.slice(-40).reverse().map(t => `
        <div class="trade-row-mini">
          <span>${t.datum}</span>
          <span><span class="trade-tag ${t.typ === 'SÄLJ' ? 'tag-sell' : t.typ === 'DCA' ? 'tag-dca' : 'tag-buy'}">${t.typ}</span></span>
          <span>$${Math.round(t.pris).toLocaleString()}</span>
          <span style="color:${t.vp === null ? 'var(--muted)' : t.vp >= 0 ? 'var(--green)' : 'var(--red)'}">${t.vp === null ? '–' : (t.vp >= 0 ? '+' : '') + t.vp.toFixed(1) + '%'}</span>
          <span style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.orsak}</span>
        </div>`).join('');

    const res = document.getElementById('calc-results');
    res.style.display = 'block';
    res.classList.add('fade-in');
    res.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  } catch (e) {
    console.error('Kalkylatorn kraschade:', e);
    document.getElementById('calc-btn').textContent = 'Fel – försök igen om en stund';
  } finally {
    btn.textContent = 'Beräkna vad boten hade genererat';
    btn.disabled    = false;
  }
}

// ── Start ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initBigChart();
  uppdateraHeroPriser();
  uppdateraLive();

  // CoinGecko gratis-tier: ~30 req/min
  // Uppdaterar var 60:e sekund för att hålla oss under gränsen
  setInterval(uppdateraLive, 60_000);
  setInterval(uppdateraHeroPriser, 90_000);

  setTimeout(körKalkylator, 1000);
});
