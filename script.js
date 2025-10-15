// ====== 設定區 ======
const OPENAI_PROXY_URL = ""; // 未使用，可留空
const OPENAI_MODEL = "gpt-5";

// ====== 工具 ======
const statusEl = document.getElementById("status");
function setStatus(msg){ if(statusEl) statusEl.textContent = msg; }

function normalizeSymbol(input){
  const s = (input || "").trim().toUpperCase();
  if(!s) return s;
  if(/^\d+$/.test(s)) return s + ".TW"; // 台股自動加 .TW
  return s;
}

// ====== 通用 Fetch with Timeout ======
function fetchTimeout(url, opt={}, ms=8000){
  return new Promise((resolve, reject)=>{
    const id = setTimeout(()=>reject(new Error("timeout")), ms);
    fetch(url, opt).then(r=>{ clearTimeout(id); resolve(r); })
                   .catch(e=>{ clearTimeout(id); reject(e); });
  });
}

// ====== 多路徑重試 ======
async function fetchJSONWithRetry(urls, opt={}, tries=3){
  let lastErr;
  for(let i=0;i<Math.max(tries,1);i++){
    for(const {name,url} of urls){
      try{
        setStatus(`連線中：${name}…`);
        const r = await fetchTimeout(url, {...opt, mode:"cors"}, 8000);
        if(!r.ok) throw new Error(`${name} http ${r.status}`);
        return await r.json();
      }catch(e){ lastErr = e; }
    }
    await new Promise(s=>setTimeout(s,500+i*300)); // 延遲後重試
  }
  throw lastErr || new Error("all routes failed");
}

// ====== Yahoo Finance API ======
async function fetchYahooChart(symbol, range='3mo', interval='1d'){
  const core = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const bust = `&_=${Date.now()}`;
  const routes = [
    { name:"isomorphic", url:"https://cors.isomorphic-git.org/" + core + bust },
    { name:"allorigins", url:"https://api.allorigins.win/raw?url=" + encodeURIComponent(core+bust) },
    { name:"thingproxy", url:"https://thingproxy.freeboard.io/fetch/" + core + bust },
    { name:"direct", url: core + bust }
  ];
  return fetchJSONWithRetry(routes, {}, 2);
}

// ====== 資料轉換 & 計算 ======
function toCandles(json){
  const r = json?.chart?.result?.[0];
  if(!r) throw new Error('chart result not found');
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const o=q.open||[], h=q.high||[], l=q.low||[], c=q.close||[], v=q.volume||[];
  const candles=[], volumes=[];
  for(let i=0;i<ts.length;i++){
    if(o[i]==null||h[i]==null||l[i]==null||c[i]==null) continue;
    const bar={time:ts[i],open:+o[i],high:+h[i],low:+l[i],close:+c[i]};
    candles.push(bar);
    volumes.push({
      time:ts[i],value:+(v[i]||0),
      color: bar.close>=bar.open ? '#26a69a' : '#ef5350'
    });
  }
  return {candles,volumes};
}

function smaSeries(candles,n){
  const out=[],q=[],len=n;
  let sum=0;
  for(const c of candles){
    q.push(c.close); sum+=c.close;
    if(q.length>len) sum-=q.shift();
    out.push({time:c.time,value:sum/q.length});
  }
  return out;
}

// ====== K 線圖 ======
let kChart,sCandle,sVol,sMA5,sMA20,sMA60;

function ensureKChart(){
  if(kChart) return;
  kChart = LightweightCharts.createChart(document.getElementById('kChart'),{
    layout:{background:{color:'#0b1220'},textColor:'#e5e7eb'},
    grid:{vertLines:{color:'#1f2937'},horzLines:{color:'#1f2937'}},
    timeScale:{rightOffset:2,borderColor:'#334155'},
    rightPriceScale:{borderColor:'#334155'},
    crosshair:{mode:LightweightCharts.CrosshairMode.Normal}
  });
  sCandle = kChart.addCandlestickSeries({
    upColor:'#26a69a',downColor:'#ef5350',
    borderUpColor:'#26a69a',borderDownColor:'#ef5350',
    wickUpColor:'#26a69a',wickDownColor:'#ef5350'
  });
  sVol = kChart.addHistogramSeries({
    priceScaleId:'',priceFormat:{type:'volume'},base:0,color:'#888'
  });
  kChart.priceScale('').applyOptions({scaleMargins:{top:0.8,bottom:0}});
  sMA5  = kChart.addLineSeries({color:'#facc15',lineWidth:2});
  sMA20 = kChart.addLineSeries({color:'#e879f9',lineWidth:2});
  sMA60 = kChart.addLineSeries({color:'#60a5fa',lineWidth:2});
}

function rangeByInterval(interval){
  switch(interval){
    case'5m':return'5d';
    case'15m':return'10d';
    case'30m':return'1mo';
    case'60m':return'3mo';
    default:return'6mo';
  }
}

async function renderK(symbol,interval){
  ensureKChart();
  const range=rangeByInterval(interval);
  const json=await fetchYahooChart(symbol,range,interval);
  const {candles,volumes}=toCandles(json);
  if(candles.length<5) throw new Error('資料不足');
  sCandle.setData(candles);
  sVol.setData(volumes);
  const ma5=smaSeries(candles,5);
  const ma20=smaSeries(candles,20);
  const ma60=smaSeries(candles,60);
  sMA5.setData(ma5);
  sMA20.setData(ma20);
  sMA60.setData(ma60);
  kChart.timeScale().fitContent();
  const last=candles.at(-1);
  const v=x=>(x??0).toFixed(2);
  document.getElementById('kLegend').textContent=
    `O:${v(last.open)} H:${v(last.high)} L:${v(last.low)} C:${v(last.close)} | `+
    `MA5:${v(ma5.at(-1)?.value)} MA20:${v(ma20.at(-1)?.value)} MA60:${v(ma60.at(-1)?.value)}`;
}

// ====== 即時價 ======
function formatTs(ts){
  try{return new Date(ts*1000).toLocaleString();}catch{return ts;}
}

async function refreshQuote(){
  const raw=document.getElementById('symbol').value;
  const symbol=normalizeSymbol(raw);
  if(!symbol){alert("請先輸入代號");return;}
  try{
    setStatus('讀取中…');
    const interval='1d';
    const json=await fetchYahooChart(symbol,'6mo',interval);
    const r=json?.chart?.result?.[0];
    if(!r) throw new Error('無資料');
    const closeArr=r.indicators?.quote?.[0]?.close||[];
    const lastClose=closeArr.at(-1);
    const ts=(r.timestamp||[]).at(-1);
    document.getElementById('priceInfo').textContent=
      `${symbol} 最新/收盤：${Number(lastClose||0).toFixed(2)}`;
    document.getElementById('updateTime').textContent=
      `更新時間：${formatTs(ts)}（Yahoo 可能延遲 10–20 分）`;
    const itv=document.getElementById('kInterval').value||'1d';
    await renderK(symbol,itv);
    setStatus('完成');
  }catch(e){
    console.error(e);
    setStatus('讀取失敗：'+e.message);
    alert('讀取失敗：'+e.message);
  }
}

// ====== 綁定事件 ======
document.getElementById('fetchBtn').addEventListener('click',refreshQuote);
document.getElementById('kRefresh').addEventListener('click',async()=>{
  const raw=document.getElementById('symbol').value;
  const symbol=normalizeSymbol(raw);
  const itv=document.getElementById('kInterval').value||'1d';
  try{
    setStatus('更新 K 線中…');
    await renderK(symbol,itv);
    setStatus('完成');
  }catch(e){
    console.error(e);
    setStatus('K 線讀取失敗：'+e.message);
    alert('K 線讀取失敗：'+e.message);
  }
});
document.getElementById('symbol').addEventListener('keydown',e=>{
  if(e.key==='Enter') document.getElementById('fetchBtn').click();
});
window.addEventListener('load',()=>{
  const inp=document.getElementById('symbol');
  inp.value='AAPL';
  document.getElementById('fetchBtn').click();
});
