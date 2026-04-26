// ────────────────────────────────────────
//   CRYPTOBOT PRO – app.js
//   Live:     CoinGecko via CORS-proxy
//   Historik: Kraken (ingen proxy)
// ────────────────────────────────────────

const USD_SEK    = 10.5;
const RSI_KÖP    = 38;
const RSI_SÄLJ   = 65;
const ADX_GRÄNS  = 25;
const TRAILING   = 0.15;
const MAX_PTS    = 80;

const COINGECKO  = 'https://api.coingecko.com/api/v3';
const PROXY      = 'https://corsproxy.io/?';
const COIN_IDS   = { BTCUSDT: 'bitcoin',  ETHUSDT: 'ethereum' };
const KRAKEN_PAR = { BTCUSDT: 'XBTUSD',   ETHUSDT: 'ETHUSD'  };

let liveSymbol  = 'BTCUSDT';
let liveHistory = [];
let killSwitch  = false;
let bigChart    = null;
let calcChart   = null;

function px(url) {
  return PROXY + encodeURIComponent(url);
}

// ── Indikatorer ────────────────────────────────────────

function beräknaRSI(p, n = 14) {
  if (p.length < n + 1) return 50;
  const d  = p.slice(-(n + 1)).map((v, i, a) => i === 0 ? 0 : v - a[i - 1]).slice(1);
  const g  = d.map(x => x > 0 ? x : 0);
  const l  = d.map(x => x < 0 ? -x : 0);
  const ag = g.reduce((a, b) => a + b, 0) / n;
  const al = l.reduce((a, b) => a + b, 0) / n;
  if (al === 0) return 100;
  return parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

function beräknaEMA(p, n) {
  if (p.length < n) return p[p.length - 1];
  let e   = p.slice(0, n).reduce((a, b) => a + b, 0) / n;
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
    const pd = hi[i] - hi[i - 1], nd = lo[i - 1] - lo[i];
    dmp.push(pd > nd && pd > 0 ? pd : 0);
    dmn.push(nd > pd && nd > 0 ? nd : 0);
  }
  const atr = tr.slice(-n).reduce((a, b) => a + b, 0) / n || 1;
  const dip = 100 * dmp.slice(-n).reduce((a, b) => a + b, 0) / n / atr;
  const din = 100 * dmn.slice(-n).reduce((a, b) => a + b, 0) / n / atr;
  return parseFloat((100 * Math.abs(dip - din) / (dip + din || 1)).toFixed(1));
}

// ── API ────────────────────────────────────────────────

async function hämtaPrisOchHistorik(coinId) {
  const [priceRes, histRes] = await Promise.all([
    fetch(px(`${COINGECKO}/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`)),
    fetch(px(`${COINGECKO}/coins/${coinId}/market_chart?vs_currency=usd&days=5&interval=hourly`)),
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

async function uppdateraHeroPriser() {
  try {
    const res  = await fetch(px(`${COINGECKO}/simple/price?ids=bitcoin,ethereum&vs_currencies=usd`));
    const data = await res.json();
    document.getElementById('hero-btc').textContent = '$' + Math.round(data.bitcoin.usd).toLocaleString('sv-SE');
    document.getElementById('hero-eth').textContent = '$' + Math.round(data.ethereum.usd).toLocaleString('sv-SE');
  } catch (e) { console.error('Hero-prisfel:', e); }
}

async function hämtaHistorikDaglig(symbol, dagar) {
  const par   = KRAKEN_PAR[symbol];
  const sedan = Math.floor((Date.now() - (dagar + 10) * 86400000) / 1000);
  const url   = `https://api.kraken.com/0/public/OHLC?pair=${par}&interval=1440&since=${sedan}`;
  const res   = await fetch(url);
  if (!res.ok) throw new Error(`Kraken HTTP-fel: ${res.status}`);
  const json  = await res.json();
  if (json.error && json.error.length > 0) throw new Error(`Kraken: ${json.error[0]}`);
  const nyckel = Object.keys(json.result).find(k => k !== 'last');
  return json.result[nyckel].slice(-dagar).map(r => ({
    datum: new Date(r[0] * 1000).toISOString().slice(0, 10),
    close: parseFloat(r[4]),
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
      plugins: { legend:{display:false}, tooltip:{ backgroundColor:'#13131a', borderColor:'#22222e', borderWidth:1, titleColor:'#6b6b88', bodyColor:'#f0f0f8', callbacks:{ label: ctx => `${ctx.dataset.label}: $${Math.round(ctx.parsed.y).toLocaleString('sv-SE')}` }}},
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
  document.getElementById('rsi-big').textContent       = rsiVal.toFixed(1);
  document.getElementById('rsi-fill').style.width      = rsiVal + '%';
  document.getElementById('rsi-fill').style.background = rsiVal < RSI_KÖP ? '#22c55e' : rsiVal > RSI_SÄLJ ? '#ef4444' : '#6b6b88';
  setBadge('rsi-badge', rsiVal < RSI_KÖP ? 'KÖPZON' : rsiVal > RSI_SÄLJ ? 'SÄLJZON' : 'NEUTRALT', rsiVal < RSI_KÖP ? 'ibuy' : rsiVal > RSI_SÄLJ ? 'isell' : 'ihold');
  document.getElementById('adx-big').textContent       = adxVal.toFixed(1);
  document.getElementById('adx-fill').style.width      = Math.min(adxVal, 100) + '%';
  document.getElementById('adx-fill').style.background = adxVal > ADX_GRÄNS ? '#60a5fa' : '#6b6b88';
  setBadge('adx-badge', adxVal > ADX_GRÄNS ? 'STARK TREND' : 'SVAG TREND', adxVal > ADX_GRÄNS ? 'istrong' : 'iweak');
  document.getElementById('ma-big').textContent        = (avvPct >= 0 ? '+' : '') + avvPct.toFixed(2) + '%';
  const maPct = Math.min(Math.max((avvPct + 15) / 30 * 100, 0), 100);
  document.getElementById('ma-fill').style.width       = maPct + '%';
  document.getElementById('ma-fill').style.background  = avvPct <= -5 ? '#22c55e' : avvPct > 5 ? '#ef4444' : '#6b6b88';
  setBadge('ma-badge', avvPct <= -5 ? 'DIPP' : avvPct > 5 ? 'ÖVERKÖPT' : 'NORMALT', avvPct <= -5 ? 'ibuy' : avvPct > 5 ? 'isell' : 'ihold');
}

// ── Live uppdatering ───────────────────────────────────

async function uppdateraLive() {
  try {
    const coinId = COIN_IDS[liveSymbol];
    const { pris, ch24, closes } = await hämtaPrisOchHistorik(coinId);
    liveHistory = closes;

    const rsiVal   = beräknaRSI(liveHistory);
    const adxVal   = beräknaADX(liveHistory);
    const ma20Val  = beräknaMA(liveHistory, 20);
    const avv      = (pris - ma20Val) / ma20Val * 100;
    const ema20    = beräknaEMA(liveHistory, 20);
    const ema50    = beräknaEMA(liveHistory, 50);
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
    document.getElementById('live-updated').textContent = 'Uppdateringsfel – försöker igen...';
  }
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

// ── KORREKT SIMULERING ─────────────────────────────────
//
//  Matematisk modell:
//
//  totInsattSEK = ALLT du betalat (start + DCA + dipp)
//  coin         = ALLT BTC du äger
//  slutVärde    = coin × slutpris × USD_SEK
//  avkastning   = (slutVärde - totInsattSEK) / totInsattSEK
//
//  Varje krona som spenderas läggs till totInsattSEK.
//  Inga pengar "försvinner" – antingen är de cash eller BTC.
//
//  Strategin:
//  - Köp hela startkapitalet dag 1
//  - Köp månadsinsättningen 1 gång/månad
//  - Köp EXTRA vid dipp >5% under MA20 + RSI<38
//    (finansieras ur månadsinsättningen, max 50% extra)
//  - SÄLJ ALDRIG i simuleringen
//    (DCA är en långsiktig strategi)

async function körKalkylator() {
  const kapSEK = parseFloat(document.getElementById('c-kapital').value) || 1000;
  const manSEK = parseFloat(document.getElementById('c-manad').value)   || 0;
  const symbol = document.getElementById('c-symbol').value;
  const dagar  = parseInt(document.getElementById('c-period').value);
  const kapUSD = kapSEK / USD_SEK;
  const manUSD = manSEK / USD_SEK;

  const btn = document.getElementById('calc-btn');
  btn.textContent = 'Hämtar data från Kraken...';
  btn.disabled    = true;

  try {
    const data   = await hämtaHistorikDaglig(symbol, dagar);
    const priser = data.map(d => d.close);
    if (priser.length < 10) throw new Error('För lite data');

    // ── Portföljstate ─────────────────────────────────
    let coin         = 0;       // Antal BTC/ETH vi äger
    let totInsattSEK = 0;       // Totalt insatt i SEK (ökar vid varje köp)
    let manadDag     = 0;       // Räknare för månadsinsättning
    let månadsbudget = 0;       // Kvarvarande månadsbudget att använda
    const trades     = [];
    const botVals    = [];      // Portföljvärde i SEK per dag
    const hodlVals   = [];      // HODL-värde per dag
    const insattVals = [];      // Ackumulerat insatt per dag

    // HODL-referens: köp för startkapitalet dag 1
    const hodlCoin = kapUSD / priser[0];

    // ── Dag 0: Köp hela startkapitalet ───────────────
    const startKöp = kapUSD / priser[0];
    coin         += startKöp;
    totInsattSEK += kapSEK;    // ← startkapitalet räknas som insatt
    trades.push({
      datum: data[0].datum,
      typ:   'KÖP',
      pris:  priser[0],
      köptFör: kapSEK,
      orsak: `Startinvestering ${kapSEK.toLocaleString('sv-SE')} kr`,
    });

    // ── Daglig loop ───────────────────────────────────
    for (let i = 0; i < priser.length; i++) {
      const p    = priser[i];
      const hist = priser.slice(0, i + 1);
      const rsi  = hist.length >= 15 ? beräknaRSI(hist) : 50;
      const ma20 = hist.length >= 20 ? beräknaMA(hist, 20) : p;
      const avv  = (p - ma20) / ma20;  // Avvikelse från MA20

      // ── Månadsinsättning (en gång per 30 dagar) ──
      manadDag++;
      if (manadDag >= 30 && manUSD > 0) {
        manadDag     = 0;
        månadsbudget = manUSD; // Fyll på månadsbudgeten

        // Köp direkt med hela månadsinsättningen
        const mängd   = manUSD / p;
        coin         += mängd;
        totInsattSEK += manSEK;   // ← månadsinsättning räknas som insatt
        trades.push({
          datum:    data[i].datum,
          typ:      'DCA',
          pris:     p,
          köptFör:  manSEK,
          orsak:    `Månadsinsättning ${manSEK.toLocaleString('sv-SE')} kr`,
        });
      }

      // ── Dippköp (extra köp vid stor dipp) ────────
      // Finansieras ur en separat dipp-budget = 50% av månadsinsättning
      // Denna kostnad räknas SEPARAT och läggs till totInsattSEK
      if (hist.length >= 20 && avv <= -0.05 && rsi < RSI_KÖP && manUSD > 0) {
        // Köp mer ju större dipp
        const dippFaktor  = Math.min(Math.abs(avv) / 0.05, 2); // 1x–2x
        const dippUSD     = (manUSD * 0.5) * dippFaktor;
        const dippSEK     = dippUSD * USD_SEK;
        const mängd       = dippUSD / p;
        coin             += mängd;
        totInsattSEK     += dippSEK;  // ← dippköp räknas som insatt
        trades.push({
          datum:    data[i].datum,
          typ:      'KÖP',
          pris:     p,
          köptFör:  dippSEK,
          orsak:    `Dippköp ${(avv*100).toFixed(1)}% under MA20 (RSI ${rsi.toFixed(0)}) ×${dippFaktor.toFixed(1)}`,
        });
      }

      // ── Portföljvärde ────────────────────────────
      // = alla coins vi äger × dagens pris × valutakurs
      const dagsvärde = coin * p * USD_SEK;
      botVals.push(Math.round(dagsvärde));
      hodlVals.push(Math.round(hodlCoin * p * USD_SEK));
      insattVals.push(Math.round(totInsattSEK));
    }

    // ── Beräkna slutresultat ──────────────────────────
    const labels    = data.map(d => d.datum);
    const slutBot   = botVals[botVals.length - 1];
    const slutHodl  = hodlVals[hodlVals.length - 1];

    // Avkastning = (vad det är värt nu - vad vi betalat) / vad vi betalat
    const botPnlSEK = slutBot - totInsattSEK;
    const botPct    = (botPnlSEK / totInsattSEK) * 100;

    // HODL-avkastning = bara startkapitalet, inga fler insättningar
    const hodlPnl   = slutHodl - kapSEK;
    const hodlPct   = (hodlPnl / kapSEK) * 100;

    const bankPct   = (dagar / 365) * 2.5;

    // Max drawdown
    let peak = botVals[0], maxDD = 0;
    for (const v of botVals) {
      if (v > peak) peak = v;
      const dd = peak > 0 ? (peak - v) / peak * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }

    // ── Visa resultat ─────────────────────────────────
    document.getElementById('result-big').innerHTML = `
      <div class="result-card highlight">
        <div class="result-label">SLUTVÄRDE (BOT)</div>
        <div class="result-value gold">${Math.round(slutBot).toLocaleString('sv-SE')} kr</div>
        <div class="result-sub">Totalt insatt: ${Math.round(totInsattSEK).toLocaleString('sv-SE')} kr</div>
      </div>
      <div class="result-card ${botPct >= 0 ? 'green-bg' : 'red-bg'}">
        <div class="result-label">BOTENS AVKASTNING</div>
        <div class="result-value ${botPct >= 0 ? 'green' : 'red'}">${botPct >= 0 ? '+' : ''}${botPct.toFixed(1)}%</div>
        <div class="result-sub">${botPnlSEK >= 0 ? '+' : ''}${Math.round(botPnlSEK).toLocaleString('sv-SE')} kr vinst</div>
      </div>
      <div class="result-card ${hodlPct >= 0 ? 'blue-bg' : 'red-bg'}">
        <div class="result-label">HODL HADE GETT</div>
        <div class="result-value blue">${hodlPct >= 0 ? '+' : ''}${hodlPct.toFixed(1)}%</div>
        <div class="result-sub">Bara startkapital dag 1</div>
      </div>
      <div class="result-card">
        <div class="result-label">SPARKONTO (2.5%/år)</div>
        <div class="result-value" style="color:var(--muted)">+${bankPct.toFixed(2)}%</div>
        <div class="result-sub">Bot: ${botPct >= bankPct ? '+' : ''}${(botPct - bankPct).toFixed(1)}% vs sparkonto</div>
      </div>
      <div class="result-card">
        <div class="result-label">MAX DRAWDOWN</div>
        <div class="result-value neg">-${maxDD.toFixed(1)}%</div>
        <div class="result-sub">Värsta tillfälliga nedgång</div>
      </div>
      <div class="result-card">
        <div class="result-label">ANTAL KÖP</div>
        <div class="result-value gold">${trades.length}</div>
        <div class="result-sub">${trades.filter(t=>t.typ==='DCA').length} DCA · ${trades.filter(t=>t.typ==='KÖP').length} dippköp</div>
      </div>`;

    // ── Graf ──────────────────────────────────────────
    if (calcChart) calcChart.destroy();
    calcChart = new Chart(document.getElementById('calcChart'), {
      type: 'line',
      data: { labels, datasets: [
        { label:'Bot (DCA + dippköp)', data:botVals,    borderColor:'#f59e0b', borderWidth:2,   pointRadius:0, tension:0.3, fill:true,  backgroundColor:'rgba(245,158,11,0.08)' },
        { label:'HODL (bara dag 1)',   data:hodlVals,   borderColor:'#60a5fa', borderWidth:1.5, pointRadius:0, tension:0.3, fill:false, borderDash:[5,4] },
        { label:'Insatt kapital',      data:insattVals, borderColor:'#3a3a50', borderWidth:1,   pointRadius:0, tension:0,   fill:false, borderDash:[2,3] },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: true, labels:{ color:'#6b6b88', font:{size:11}, boxWidth:12 } },
          tooltip: { backgroundColor:'#13131a', borderColor:'#22222e', borderWidth:1, titleColor:'#6b6b88', bodyColor:'#f0f0f8', callbacks:{ label: ctx => `${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString('sv-SE')} kr` }}
        },
        scales: {
          x: { ticks:{color:'#3a3a50',font:{size:10},maxTicksLimit:8}, grid:{color:'#1a1a24'} },
          y: { ticks:{color:'#3a3a50',font:{size:10},callback:v=>Math.round(v).toLocaleString('sv-SE')+' kr'}, grid:{color:'#1a1a24'} }
        }
      },
    });

    // ── Affärslista ───────────────────────────────────
    document.getElementById('trades-count-label').textContent =
      `${trades.length} köp totalt · DCA ackumulerar BTC utan att sälja`;

    document.getElementById('trades-mini').innerHTML =
      '<div class="trade-row-mini" style="color:var(--muted);font-size:10px;letter-spacing:0.05em;border-bottom:1px solid var(--border);padding-bottom:6px;">' +
      '<span>DATUM</span><span>TYP</span><span>PRIS</span><span>BELOPP</span><span>ORSAK</span></div>' +
      trades.slice(-50).reverse().map(t => `
        <div class="trade-row-mini">
          <span>${t.datum}</span>
          <span><span class="trade-tag ${t.typ==='DCA'?'tag-dca':'tag-buy'}">${t.typ}</span></span>
          <span>$${Math.round(t.pris).toLocaleString()}</span>
          <span style="color:var(--green)">${Math.round(t.köptFör).toLocaleString('sv-SE')} kr</span>
          <span style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.orsak}</span>
        </div>`).join('');

    const resEl = document.getElementById('calc-results');
    resEl.style.display = 'block';
    resEl.classList.add('fade-in');
    resEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  } catch (e) {
    console.error('Kalkylatorfel:', e);
    document.getElementById('calc-btn').textContent = '⚠️ ' + e.message;
  } finally {
    btn.textContent = 'Beräkna vad boten hade genererat';
    btn.disabled    = false;
  }
}

// ── Start ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initBigChart();
  setTimeout(uppdateraHeroPriser, 500);
  setTimeout(uppdateraLive,       1500);
  setTimeout(körKalkylator,       2500);
  setInterval(uppdateraLive,      60_000);
  setInterval(uppdateraHeroPriser,90_000);
});
