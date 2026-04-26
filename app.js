// ────────────────────────────────────────
//   CRYPTOBOT PRO – app.js
//   Live:     CoinGecko via CORS-proxy
//   Historik: Kraken (smart intervallval)
//     1 mån  → 1h  data (720 punkter)
//     3 mån  → 4h  data (540 punkter)
//     6 mån  → 4h  data (720 punkter = 120d)
//     1 år   → 1d  data (365 punkter)
//     2 år   → 1d  data (730 punkter)
// ────────────────────────────────────────

const USD_SEK    = 10.5;
const RSI_KÖP    = 40;
const RSI_SÄLJ   = 65;
const ADX_GRÄNS  = 25;
const TRAILING   = 0.15;
const MAX_PTS    = 80;

// Micro-trade parametrar (backtestade optimala)
const MICRO_DIPP      = 0.005;  // 0.5% dipp under MA
const MICRO_VINST     = 0.02;   // +2% sälj
const MICRO_STOPLOSS  = 0.02;   // -2% stop loss
const MICRO_POSSTRL   = 0.5;    // 50% av trading-cash
const BAS_ANDEL       = 0.5;    // 50% alltid i BTC

const COINGECKO  = 'https://api.coingecko.com/api/v3';
const PROXY      = 'https://corsproxy.io/?';
const COIN_IDS   = { BTCUSDT: 'bitcoin', ETHUSDT: 'ethereum' };
const KRAKEN_PAR = { BTCUSDT: 'XBTUSD',  ETHUSDT: 'ETHUSD'  };

let liveSymbol  = 'BTCUSDT';
let liveHistory = [];
let killSwitch  = false;
let bigChart    = null;
let calcChart   = null;

function px(url) { return PROXY + encodeURIComponent(url); }

// ── Indikatorer ────────────────────────────────────────

function beräknaRSI(p, n = 14) {
  if (p.length < n + 1) return 50;
  const d  = p.slice(-(n+1)).map((v,i,a) => i===0?0:v-a[i-1]).slice(1);
  const ag = d.map(x=>x>0?x:0).reduce((a,b)=>a+b,0)/n;
  const al = d.map(x=>x<0?-x:0).reduce((a,b)=>a+b,0)/n;
  if (al===0) return 100;
  return parseFloat((100-100/(1+ag/al)).toFixed(1));
}

function beräknaEMA(p, n) {
  if (p.length < n) return p[p.length-1];
  let e = p.slice(0,n).reduce((a,b)=>a+b,0)/n;
  const k = 2/(n+1);
  for (let i=n;i<p.length;i++) e=p[i]*k+e*(1-k);
  return e;
}

function beräknaMA(p, n) {
  if (p.length < n) return p[p.length-1];
  return p.slice(-n).reduce((a,b)=>a+b,0)/n;
}

function beräknaADX(p, n=14) {
  if (p.length < n*2) return 20;
  const hi=p.map(x=>x*1.002), lo=p.map(x=>x*0.998);
  const tr=[],dmp=[],dmn=[];
  for (let i=1;i<p.length;i++){
    tr.push(Math.max(hi[i]-lo[i],Math.abs(hi[i]-p[i-1]),Math.abs(lo[i]-p[i-1])));
    const pd=hi[i]-hi[i-1],nd=lo[i-1]-lo[i];
    dmp.push(pd>nd&&pd>0?pd:0); dmn.push(nd>pd&&nd>0?nd:0);
  }
  const atr=tr.slice(-n).reduce((a,b)=>a+b,0)/n||1;
  const dip=100*dmp.slice(-n).reduce((a,b)=>a+b,0)/n/atr;
  const din=100*dmn.slice(-n).reduce((a,b)=>a+b,0)/n/atr;
  return parseFloat((100*Math.abs(dip-din)/(dip+din||1)).toFixed(1));
}

// ── API ────────────────────────────────────────────────

async function hämtaPrisOchHistorik(coinId) {
  const [pr, hr] = await Promise.all([
    fetch(px(`${COINGECKO}/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`)),
    fetch(px(`${COINGECKO}/coins/${coinId}/market_chart?vs_currency=usd&days=5&interval=hourly`)),
  ]);
  if (!pr.ok||!hr.ok) throw new Error('CoinGecko svarade inte');
  const pd=await pr.json(), hd=await hr.json();
  return { pris:pd[coinId].usd, ch24:pd[coinId].usd_24h_change, closes:hd.prices.map(p=>p[1]) };
}

async function uppdateraHeroPriser() {
  try {
    const res=await fetch(px(`${COINGECKO}/simple/price?ids=bitcoin,ethereum&vs_currencies=usd`));
    const d=await res.json();
    document.getElementById('hero-btc').textContent='$'+Math.round(d.bitcoin.usd).toLocaleString('sv-SE');
    document.getElementById('hero-eth').textContent='$'+Math.round(d.ethereum.usd).toLocaleString('sv-SE');
  } catch(e){console.error(e);}
}

// Smart datahämtning – väljer rätt Kraken-intervall per period
async function hämtaKrakenData(symbol, dagar) {
  const par = KRAKEN_PAR[symbol];

  // Välj intervall baserat på period
  // Kraken returnerar alltid max ~720 punkter per request
  let intervall, punktPerDag, label;
  if (dagar <= 30) {
    intervall = 60;    // 1h  → 720 timmar = 30 dagar
    punktPerDag = 24;
    label = '1h';
  } else if (dagar <= 120) {
    intervall = 240;   // 4h  → 720 punkter = 120 dagar
    punktPerDag = 6;
    label = '4h';
  } else {
    intervall = 1440;  // 1d  → 720 dagliga = 720 dagar
    punktPerDag = 1;
    label = '1d';
  }

  const sedan = Math.floor((Date.now() - (dagar+5)*86400000)/1000);
  const url   = `https://api.kraken.com/0/public/OHLC?pair=${par}&interval=${intervall}&since=${sedan}`;
  const res   = await fetch(url);
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
  const json  = await res.json();
  if (json.error?.length>0) throw new Error(json.error[0]);
  const nyckel = Object.keys(json.result).find(k=>k!=='last');
  const rader  = json.result[nyckel].slice(-(dagar*punktPerDag));

  return {
    punkter: rader.map(r=>({
      datum:    new Date(r[0]*1000).toISOString().slice(0,10),
      close:    parseFloat(r[4]),
    })),
    punktPerDag,
    intervallLabel: label,
  };
}

// ── Live Chart ─────────────────────────────────────────

function initBigChart() {
  bigChart = new Chart(document.getElementById('bigChart'), {
    type:'line',
    data:{
      labels:Array(MAX_PTS).fill(''),
      datasets:[
        {label:'Pris',data:Array(MAX_PTS).fill(null),borderColor:'#f59e0b',borderWidth:2,pointRadius:0,tension:0.3,fill:true,backgroundColor:'rgba(245,158,11,0.05)'},
        {label:'MA20',data:Array(MAX_PTS).fill(null),borderColor:'#4444aa',borderWidth:1,pointRadius:0,tension:0.3,fill:false,borderDash:[5,4]},
        {label:'KÖP', data:Array(MAX_PTS).fill(null),type:'scatter',backgroundColor:'#22c55e',pointRadius:7,pointStyle:'triangle',showLine:false},
        {label:'SÄLJ',data:Array(MAX_PTS).fill(null),type:'scatter',backgroundColor:'#ef4444',pointRadius:7,pointStyle:'triangle',rotation:180,showLine:false},
      ],
    },
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{backgroundColor:'#13131a',borderColor:'#22222e',borderWidth:1,titleColor:'#6b6b88',bodyColor:'#f0f0f8',callbacks:{label:ctx=>`${ctx.dataset.label}: $${Math.round(ctx.parsed.y).toLocaleString('sv-SE')}`}}},
      scales:{x:{ticks:{color:'#3a3a50',font:{size:10},maxTicksLimit:8},grid:{color:'#1a1a24'}},y:{ticks:{color:'#3a3a50',font:{size:10},callback:v=>'$'+Math.round(v).toLocaleString('sv-SE')},grid:{color:'#1a1a24'}}},
    },
  });
}

function pushLive(pris,ma20Val,signal,tid) {
  if (bigChart.data.labels.length>=MAX_PTS){bigChart.data.labels.shift();bigChart.data.datasets.forEach(d=>d.data.shift());}
  bigChart.data.labels.push(tid);
  bigChart.data.datasets[0].data.push(pris);
  bigChart.data.datasets[1].data.push(ma20Val);
  bigChart.data.datasets[2].data.push(signal==='KÖP'?pris:null);
  bigChart.data.datasets[3].data.push(signal==='SÄLJ'?pris:null);
  bigChart.update('none');
}

// ── UI helpers ─────────────────────────────────────────

function setMetric(id,value,cls){const el=document.getElementById(id);if(!el)return;el.textContent=value;el.className='metric-tile-value '+cls;}
function setBadge(id,text,cls) {const el=document.getElementById(id);if(!el)return;el.textContent=text;el.className='ind-badge '+cls;}

function uppdateraIndKort(rsiVal,adxVal,avvPct){
  document.getElementById('rsi-big').textContent=rsiVal.toFixed(1);
  document.getElementById('rsi-fill').style.width=rsiVal+'%';
  document.getElementById('rsi-fill').style.background=rsiVal<RSI_KÖP?'#22c55e':rsiVal>RSI_SÄLJ?'#ef4444':'#6b6b88';
  setBadge('rsi-badge',rsiVal<RSI_KÖP?'KÖPZON':rsiVal>RSI_SÄLJ?'SÄLJZON':'NEUTRALT',rsiVal<RSI_KÖP?'ibuy':rsiVal>RSI_SÄLJ?'isell':'ihold');
  document.getElementById('adx-big').textContent=adxVal.toFixed(1);
  document.getElementById('adx-fill').style.width=Math.min(adxVal,100)+'%';
  document.getElementById('adx-fill').style.background=adxVal>ADX_GRÄNS?'#60a5fa':'#6b6b88';
  setBadge('adx-badge',adxVal>ADX_GRÄNS?'STARK TREND':'SVAG TREND',adxVal>ADX_GRÄNS?'istrong':'iweak');
  document.getElementById('ma-big').textContent=(avvPct>=0?'+':'')+avvPct.toFixed(2)+'%';
  document.getElementById('ma-fill').style.width=Math.min(Math.max((avvPct+15)/30*100,0),100)+'%';
  document.getElementById('ma-fill').style.background=avvPct<=-0.5?'#22c55e':avvPct>5?'#ef4444':'#6b6b88';
  setBadge('ma-badge',avvPct<=-0.5?'DIPP':avvPct>5?'ÖVERKÖPT':'NORMALT',avvPct<=-0.5?'ibuy':avvPct>5?'isell':'ihold');
}

// ── Live uppdatering ───────────────────────────────────

async function uppdateraLive() {
  try {
    const coinId=COIN_IDS[liveSymbol];
    const {pris,ch24,closes}=await hämtaPrisOchHistorik(coinId);
    liveHistory=closes;
    const rsiVal=beräknaRSI(liveHistory),adxVal=beräknaADX(liveHistory);
    const ma20Val=beräknaMA(liveHistory,20),avv=(pris-ma20Val)/ma20Val*100;
    const ema20=beräknaEMA(liveHistory,20),ema50=beräknaEMA(liveHistory,50);
    const emaCross=liveHistory.length>52&&beräknaEMA(liveHistory.slice(0,-1),20)<=beräknaEMA(liveHistory.slice(0,-1),50)&&ema20>ema50;
    if (liveHistory.length>=168){const vf=(pris-liveHistory[liveHistory.length-169])/liveHistory[liveHistory.length-169];if(vf<=-0.25)killSwitch=true;if(killSwitch&&vf>-0.10&&rsiVal>35&&rsiVal<60)killSwitch=false;}
    let signal='AVVAKTAR';
    if (killSwitch) signal='KILL SWITCH';
    else if (rsiVal>RSI_SÄLJ) signal='SÄLJSIGNAL';
    else if (avv<=-MICRO_DIPP*100&&rsiVal<RSI_KÖP) signal='KÖPSIGNAL (dipp)';
    else if (emaCross&&adxVal>ADX_GRÄNS&&rsiVal<RSI_SÄLJ) signal='KÖPSIGNAL (EMA)';
    const tid=new Date().toLocaleTimeString('sv-SE');
    pushLive(pris,ma20Val,signal.includes('KÖP')?'KÖP':signal.includes('SÄLJ')?'SÄLJ':null,tid);
    document.getElementById('live-price').textContent='$'+pris.toLocaleString('sv-SE',{maximumFractionDigits:0});
    document.getElementById('live-updated').textContent='Uppdaterad '+tid;
    const chEl=document.getElementById('live-change');
    chEl.textContent=(ch24>=0?'+':'')+ch24.toFixed(2)+'% (24h)';chEl.className='price-change '+(ch24>=0?'pos':'neg');
    const sigColors={'KÖPSIGNAL (dipp)':'#22c55e','KÖPSIGNAL (EMA)':'#22c55e','SÄLJSIGNAL':'#ef4444','KILL SWITCH':'#ef4444','AVVAKTAR':'#6b6b88'};
    const sigEl=document.getElementById('live-signal-box');sigEl.textContent=signal;sigEl.style.color=sigColors[signal]||'#6b6b88';
    document.getElementById('hero-rsi').textContent=rsiVal.toFixed(1);
    document.getElementById('hero-rsi').style.color=rsiVal<RSI_KÖP?'#22c55e':rsiVal>RSI_SÄLJ?'#ef4444':'#22c55e';
    document.getElementById('hero-signal').textContent=signal;
    document.getElementById('hero-signal').style.color=sigColors[signal]||'#6b6b88';
    setMetric('m-rsi',rsiVal.toFixed(1),rsiVal<RSI_KÖP?'pos':rsiVal>RSI_SÄLJ?'neg':'gold');
    setMetric('m-adx',adxVal.toFixed(1),adxVal>ADX_GRÄNS?'pos':'gold');
    setMetric('m-ma',(avv>=0?'+':'')+avv.toFixed(2)+'%',avv<=-MICRO_DIPP*100?'pos':avv>5?'neg':'gold');
    setMetric('m-kill',killSwitch?'AKTIV':'Inaktiv',killSwitch?'neg':'pos');
    setMetric('m-ema',emaCross?'Korsning!':'Ingen',emaCross?'pos':'gold');
    uppdateraIndKort(rsiVal,adxVal,avv);
  } catch(e){console.error(e);document.getElementById('live-updated').textContent='Uppdateringsfel – försöker igen...';}
}

function byttSymbol(sym,btn){
  liveSymbol=sym;liveHistory=[];
  document.querySelectorAll('.sym-tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
  if(bigChart){bigChart.data.labels.fill('');bigChart.data.datasets.forEach(d=>d.data.fill(null));bigChart.update('none');}
  uppdateraLive();
}

// ── SIMULERING ─────────────────────────────────────────
//
//  50% basinnehav + micro trading
//  Smart intervallval per period:
//  ≤30d  → 1h data  (bäst för micro trades, 720 punkter)
//  ≤120d → 4h data  (720 punkter = 120 dagar)
//  >120d → 1d data  (upp till 730 dagar)

async function körKalkylator() {
  const kapSEK = parseFloat(document.getElementById('c-kapital').value)||1000;
  const manSEK = parseFloat(document.getElementById('c-manad').value)||0;
  const symbol = document.getElementById('c-symbol').value;
  const dagar  = parseInt(document.getElementById('c-period').value);
  const kapUSD = kapSEK/USD_SEK, manUSD=manSEK/USD_SEK;

  const btn=document.getElementById('calc-btn');
  btn.textContent='Hämtar data från Kraken...';btn.disabled=true;

  try {
    const {punkter,punktPerDag,intervallLabel} = await hämtaKrakenData(symbol,dagar);
    const priser = punkter.map(d=>d.close);
    if (priser.length<20) throw new Error('För lite data');

    // Hur ofta månadsinsättning (i antal punkter)
    const månadsIntervall = Math.round(30*punktPerDag);

    // ── Portföljstate ─────────────────────────────────
    const basUSD   = kapUSD*BAS_ANDEL;
    let basCoin    = basUSD/priser[0];
    let tradeCash  = kapUSD*(1-BAS_ANDEL);
    let tradeCoin  = 0, tradeEntry=0;
    let totInsatt  = kapSEK;
    let räknare    = 0;

    const hodlCoin = kapUSD/priser[0];
    const trades=[], botVals=[], hodlVals=[], insattVals=[];

    trades.push({datum:punkter[0].datum,typ:'KÖP',pris:priser[0],vp:null,orsak:`Basinnehav 50% (${(basUSD*USD_SEK).toFixed(0)} kr)`});

    for (let i=0;i<priser.length;i++){
      const p=priser[i],hist=priser.slice(0,i+1);
      const rsi=beräknaRSI(hist,14),ma20=beräknaMA(hist,20),avv=(p-ma20)/ma20;

      // Månadsinsättning
      räknare++;
      if (räknare>=månadsIntervall&&manUSD>0){
        basCoin+=(manUSD*BAS_ANDEL)/p;
        tradeCash+=manUSD*(1-BAS_ANDEL);
        totInsatt+=manSEK;räknare=0;
        trades.push({datum:punkter[i].datum,typ:'DCA',pris:p,vp:null,orsak:`Månadsinsättning ${manSEK} kr`});
      }

      // SÄLJ: +2% vinst ELLER -2% stop loss
      if (tradeCoin>0){
        const vp=(p-tradeEntry)/tradeEntry*100;
        if (vp>=MICRO_VINST*100){
          tradeCash+=tradeCoin*p;
          trades.push({datum:punkter[i].datum,typ:'SÄLJ',pris:p,vp,orsak:`+${vp.toFixed(1)}% vinst ✓`});
          tradeCoin=0;tradeEntry=0;
        } else if (vp<=-MICRO_STOPLOSS*100){
          tradeCash+=tradeCoin*p;
          trades.push({datum:punkter[i].datum,typ:'SÄLJ',pris:p,vp,orsak:`${vp.toFixed(1)}% stop loss`});
          tradeCoin=0;tradeEntry=0;
        }
      }

      // KÖP: RSI<40 + dipp 0.5% under MA20
      if (tradeCoin===0&&tradeCash>kapUSD*0.05&&hist.length>=20&&rsi<RSI_KÖP&&avv<=-MICRO_DIPP){
        const bel=tradeCash*MICRO_POSSTRL;
        tradeCoin=bel/p;tradeEntry=p;tradeCash-=bel;
        trades.push({datum:punkter[i].datum,typ:'KÖP',pris:p,vp:null,orsak:`RSI ${rsi.toFixed(0)} + dipp ${(avv*100).toFixed(1)}% (${intervallLabel})`});
      }

      botVals.push(Math.round(((basCoin+tradeCoin)*p+tradeCash)*USD_SEK));
      hodlVals.push(Math.round(hodlCoin*p*USD_SEK));
      insattVals.push(Math.round(totInsatt));
    }

    // ── Dagliga graf-punkter (en per dag) ────────────
    const dagIndex=[];let sistaD='';
    punkter.forEach((d,i)=>{if(d.datum!==sistaD){dagIndex.push(i);sistaD=d.datum;}});
    const labels     = dagIndex.map(i=>punkter[i].datum);
    const botDaglig  = dagIndex.map(i=>botVals[i]);
    const hodlDaglig = dagIndex.map(i=>hodlVals[i]);
    const insattDagl = dagIndex.map(i=>insattVals[i]);

    // ── Slutresultat ──────────────────────────────────
    const slutPris  = priser[priser.length-1];
    const slutBot   = ((basCoin+tradeCoin)*slutPris+tradeCash)*USD_SEK;
    const slutHodl  = hodlCoin*slutPris*USD_SEK;
    const botPnl    = slutBot-totInsatt;
    const botPct    = botPnl/totInsatt*100;
    const hodlPct   = (slutHodl-kapSEK)/kapSEK*100;
    const bankPct   = dagar/365*2.5;

    let peak=botVals[0]||0,maxDD=0;
    for (const v of botVals){if(v>peak)peak=v;const dd=peak>0?(peak-v)/peak*100:0;if(dd>maxDD)maxDD=dd;}

    const säljTrades  = trades.filter(t=>t.typ==='SÄLJ');
    const vinstSälj   = säljTrades.filter(t=>t.vp!==null&&t.vp>0);
    const microKöp    = trades.filter(t=>t.typ==='KÖP'&&t.orsak.includes(intervallLabel));

    // ── UI ────────────────────────────────────────────
    document.getElementById('result-big').innerHTML=`
      <div class="result-card highlight">
        <div class="result-label">SLUTVÄRDE (BOT)</div>
        <div class="result-value gold">${Math.round(slutBot).toLocaleString('sv-SE')} kr</div>
        <div class="result-sub">Insatt: ${Math.round(totInsatt).toLocaleString('sv-SE')} kr · Data: ${intervallLabel}</div>
      </div>
      <div class="result-card ${botPct>=0?'green-bg':'red-bg'}">
        <div class="result-label">BOTENS AVKASTNING</div>
        <div class="result-value ${botPct>=0?'green':'red'}">${botPct>=0?'+':''}${botPct.toFixed(1)}%</div>
        <div class="result-sub">${botPnl>=0?'+':''}${Math.round(botPnl).toLocaleString('sv-SE')} kr vinst</div>
      </div>
      <div class="result-card ${hodlPct>=0?'blue-bg':'red-bg'}">
        <div class="result-label">HODL HADE GETT</div>
        <div class="result-value blue">${hodlPct>=0?'+':''}${hodlPct.toFixed(1)}%</div>
        <div class="result-sub">Bara köp dag 1</div>
      </div>
      <div class="result-card">
        <div class="result-label">SPARKONTO (2.5%/år)</div>
        <div class="result-value" style="color:var(--muted)">+${bankPct.toFixed(2)}%</div>
        <div class="result-sub">Bot: ${botPct>=bankPct?'+':''}${(botPct-bankPct).toFixed(1)}% vs sparkonto</div>
      </div>
      <div class="result-card">
        <div class="result-label">MAX DRAWDOWN</div>
        <div class="result-value neg">-${maxDD.toFixed(1)}%</div>
        <div class="result-sub">Värsta tillfälliga nedgång</div>
      </div>
      <div class="result-card">
        <div class="result-label">MICRO TRADES</div>
        <div class="result-value gold">${säljTrades.length}</div>
        <div class="result-sub">${vinstSälj.length} vinst · ${säljTrades.length-vinstSälj.length} stop loss · ${microKöp.length} köp</div>
      </div>`;

    if (calcChart) calcChart.destroy();
    calcChart=new Chart(document.getElementById('calcChart'),{
      type:'line',data:{labels,datasets:[
        {label:'Bot (50% bas + micro)',data:botDaglig, borderColor:'#f59e0b',borderWidth:2,  pointRadius:0,tension:0.3,fill:true, backgroundColor:'rgba(245,158,11,0.08)'},
        {label:'HODL (bara dag 1)',   data:hodlDaglig,borderColor:'#60a5fa',borderWidth:1.5,pointRadius:0,tension:0.3,fill:false,borderDash:[5,4]},
        {label:'Insatt kapital',      data:insattDagl,borderColor:'#3a3a50',borderWidth:1,  pointRadius:0,tension:0,  fill:false,borderDash:[2,3]},
      ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:true,labels:{color:'#6b6b88',font:{size:11},boxWidth:12}},tooltip:{backgroundColor:'#13131a',borderColor:'#22222e',borderWidth:1,titleColor:'#6b6b88',bodyColor:'#f0f0f8',callbacks:{label:ctx=>`${ctx.dataset.label}: ${Math.round(ctx.parsed.y).toLocaleString('sv-SE')} kr`}}},
        scales:{x:{ticks:{color:'#3a3a50',font:{size:10},maxTicksLimit:8},grid:{color:'#1a1a24'}},y:{ticks:{color:'#3a3a50',font:{size:10},callback:v=>Math.round(v).toLocaleString('sv-SE')+' kr'},grid:{color:'#1a1a24'}}}
      },
    });

    document.getElementById('trades-count-label').textContent=`${trades.length} affärer · ${microKöp.length} köp · ${säljTrades.length} sälj (${vinstSälj.length} vinst)`;
    document.getElementById('trades-mini').innerHTML=
      '<div class="trade-row-mini" style="color:var(--muted);font-size:10px;border-bottom:1px solid var(--border);padding-bottom:6px;">'+
      '<span>DATUM</span><span>TYP</span><span>PRIS</span><span>VINST</span><span>ORSAK</span></div>'+
      trades.slice(-50).reverse().map(t=>`
        <div class="trade-row-mini">
          <span>${t.datum}</span>
          <span><span class="trade-tag ${t.typ==='SÄLJ'?'tag-sell':t.typ==='DCA'?'tag-dca':'tag-buy'}">${t.typ}</span></span>
          <span>$${Math.round(t.pris).toLocaleString()}</span>
          <span style="color:${t.vp===null?'var(--muted)':t.vp>=0?'var(--green)':'var(--red)'}">
            ${t.vp===null?'–':(t.vp>=0?'+':'')+t.vp.toFixed(1)+'%'}
          </span>
          <span style="color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${t.orsak}</span>
        </div>`).join('');

    const resEl=document.getElementById('calc-results');
    resEl.style.display='block';resEl.classList.add('fade-in');
    resEl.scrollIntoView({behavior:'smooth',block:'nearest'});

  } catch(e){
    console.error(e);
    document.getElementById('calc-btn').textContent='⚠️ '+e.message;
  } finally {
    btn.textContent='Beräkna vad boten hade genererat';btn.disabled=false;
  }
}

// ── Start ──────────────────────────────────────────────

document.addEventListener('DOMContentLoaded',()=>{
  initBigChart();
  setTimeout(uppdateraHeroPriser,500);
  setTimeout(uppdateraLive,1500);
  setTimeout(körKalkylator,2500);
  setInterval(uppdateraLive,60_000);
  setInterval(uppdateraHeroPriser,90_000);
});
