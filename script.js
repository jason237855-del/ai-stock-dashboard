/* =========================================================
   AI 股票儀表板 - 最簡版（不用 Worker / 不用金鑰）
   台股即時價優先 TWSE，失敗才退 Yahoo
   日K/分K仍走 Yahoo（免費來源通常有延遲）
   ========================================================= */

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const symbolInput = $("symbol");
const fetchBtn     = $("fetchBtn");
const statusEl     = $("status");
const priceInfoEl  = $("priceInfo");
const updateTimeEl = $("updateTime");
const kIntervalSel = $("kInterval");
const kRefreshBtn  = $("kRefresh");
const kChartBox    = $("kChart");
const kLegend      = $("kLegend");
const aiAdviceEl   = $("aiAdvice");

/* ---------- 小工具 ---------- */
function setStatus(msg){ if(statusEl) statusEl.textContent = msg || ""; }
function isTW(input){
  const s = String(input||"").trim().toUpperCase();
  return /\.TW$/.test(s) || /^\d+$/.test(s);
}
function normSymbol(input){
  const s = String(input||"").trim().toUpperCase();
  return /^\d+$/.test(s) ? `${s}.TW` : s;
}
function onlyNumber(symTW){
  return String(symTW||"").toUpperCase().replace(".TW","").replace(/\D/g,"");
}
function tsToLocal(ts){
  if(!ts) return "—";
  const d = new Date(ts*1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
}

/* ---------- 逾時/重試 ---------- */
function fetchTimeout(url, opt={}, ms=8000){
  return new Promise((resolve,reject)=>{
    const id = setTimeout(()=>reject(new Error("timeout")), ms);
    fetch(url, {...opt, mode:"cors"}).then(r=>{clearTimeout(id);resolve(r)}).catch(e=>{clearTimeout(id);reject(e)});
  });
}
async function fetchTextMulti(routes, tries=3){
  let lastErr;
  for(let t=0;t<tries;t++){
    for(const {name,url} of routes){
      try{
        setStatus(`連線中：${name}…`);
        const res = await fetchTimeout(url, {}, 8000);
        if(!res.ok) throw new Error(`${name} http ${res.status}`);
        return await res.text();
      }catch(e){ lastErr=e; }
    }
    await new Promise(s=>setTimeout(s, 300+t*200));
  }
  throw lastErr || new Error("all routes failed");
}
async function fetchJSONMulti(routes, tries=3){
  const txt = await fetchTextMulti(routes, tries);
  try{ return JSON.parse(txt); }
  catch{
    // 有些回傳前面會多字元（JSONP/防呆），嘗試剝頭
    const clean = (txt||"").replace(/^[^{[]+/,"");
    return JSON.parse(clean);
  }
}

/* =========================================================
   台股（TW）即時價：TWSE MIS，失敗才退 Yahoo Quote
   ========================================================= */
// TWSE MIS: https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw
async function twseRealtime(symTW){
  const num = onlyNumber(symTW);
  const base = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_${num}.tw&_=${Date.now()}`;
  const routes = [
    {name:"isomorphic", url:"https://cors.isomorphic-git.org/" + base},
    {name:"allorigins", url:"https://api.allorigins.win/raw?url=" + encodeURIComponent(base)},
    {name:"thingproxy", url:"https://thingproxy.freeboard.io/fetch/" + base},
    {name:"direct",     url: base},
  ];
  const j = await fetchJSONMulti(routes, 2);
  const row = j?.msgArray?.[0];
  if(!row) throw new Error("TWSE 無資料");
  return {
    last: Number(row.z || row.y || 0),
    open: Number(row.o||0),
    high: Number(row.h||0),
    low:  Number(row.l||0),
    time: Number(row.tlong||0)/1000
  };
}

// Yahoo Quote: https://query1.finance.yahoo.com/v7/finance/quote?symbols=AAPL
async function yahooQuote(symbol){
  const core = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&_=${Date.now()}`;
  const routes = [
    {name:"isomorphic", url:"https://cors.isomorphic-git.org/" + core},
    {name:"allorigins", url:"https://api.allorigins.win/raw?url=" + encodeURIComponent(core)},
    {name:"thingproxy", url:"https://thingproxy.freeboard.io/fetch/" + core},
    {name:"direct",     url: core},
  ];
  const j = await fetchJSONMulti(routes, 2);
  const r = j?.quoteResponse?.result?.[0];
  if(!r) throw new Error("Yahoo 無報價");
  const ts = Math.floor((r.regularMarketTime || r.postMarketTime || Date.now()/1000));
  return {
    last: Number(r.regularMarketPrice ?? r.postMarketPrice ?? r.bid ?? r.ask ?? 0),
    open: Number(r.regularMarketOpen ?? 0),
    high: Number(r.regularMarketDayHigh ?? 0),
    low:  Number(r.regularMarketDayLow ?? 0),
    time: ts
  };
}

// 封裝：即時價（台股→TWSE，否則→Yahoo；台股失敗才退 Yahoo）
async function getRealtime(symbolRaw){
  const sym = normSymbol(symbolRaw);
  if(isTW(sym)){
    try { return await twseRealtime(sym); }
    catch { return await yahooQuote(sym); }
  }else{
    return await yahooQuote(sym);
  }
}

/* =========================================================
   K 線：Yahoo chart（range/interval 可切）
   ========================================================= */
// Yahoo Chart: https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?range=6mo&interval=1d
async function yahooChart(symbol, range="6mo", interval="1d"){
  const core = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&_=${Date.now()}`;
  const routes = [
    {name:"isomorphic", url:"https://cors.isomorphic-git.org/" + core},
    {name:"allorigins", url:"https://api.allorigins.win/raw?url=" + encodeURIComponent(core)},
    {name:"thingproxy", url:"https://thingproxy.freeboard.io/fetch/" + core},
    {name:"direct",     url: core},
  ];
  const j = await fetchJSONMulti(routes, 2);
  const r = j?.chart?.result?.[0];
  if(!r) throw new Error("Yahoo K 線無資料");
  const ts = r.timestamp || [];
  const q  = r.indicators?.quote?.[0] || {};
  const o=q.open||[], h=q.high||[], l=q.low||[], c=q.close||[], v=q.volume||[];
  const candles=[], volumes=[];
  for(let i=0;i<ts.length;i++){
    if(o[i]==null||h[i]==null||l[i]==null||c[i]==null) continue;
    const bar = { time: ts[i], open:+o[i], high:+h[i], low:+l[i], close:+c[i] };
    candles.push(bar);
    volumes.push({ time: ts[i], value:+(v[i]||0), color: bar.close>=bar.open ? "#26a69a" : "#ef5350" });
  }
  return {candles, volumes};
}

/* =========================================================
   繪圖（Lightweight Charts）+ MA5/20/60 + 量能
   ========================================================= */
let chart, candleSeries, volSeries, ma5, ma20, ma60;

function ensureChart(){
  if(chart) return;
  chart = LightweightCharts.createChart(kChartBox, {
    layout:{ background:{color:"#0b1220"}, textColor:"#cbd5e1" },
    grid:{ vertLines:{color:"#1f2937"}, horzLines:{color:"#1f2937"} },
    rightPriceScale:{ borderColor:"#374151" },
    timeScale:{ borderColor:"#374151" },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
    height: 420,
  });
  candleSeries = chart.addCandlestickSeries({
    upColor:"#26a69a", downColor:"#ef5350", wickUpColor:"#26a69a", wickDownColor:"#ef5350", borderVisible:false
  });
  volSeries = chart.addHistogramSeries({ priceFormat:{type:"volume"}, priceScaleId:"", color:"#60a5fa",  });
  ma5  = chart.addLineSeries({ color:"#fbbf24", lineWidth:2 });
  ma20 = chart.addLineSeries({ color:"#a78bfa", lineWidth:2 });
  ma60 = chart.addLineSeries({ color:"#60a5fa", lineWidth:2 });
}

function sma(data, period){
  const out=[]; let sum=0;
  for(let i=0;i<data.length;i++){
    const v = data[i].close;
    sum += v;
    if(i>=period) sum -= data[i-period].close;
    if(i>=period-1) out.push({ time:data[i].time, value: +(sum/period).toFixed(2) });
  }
  return out;
}

/* =========================================================
   主流程
   ========================================================= */
async function refreshQuoteAndChart(){
  try{
    const raw = symbolInput.value;
    if(!raw){ alert("請輸入股票代號（台股輸入數字即可）"); return; }
    const sym = normSymbol(raw);

    setStatus("開始讀取…");
    // 1) 即時價
    const q = await getRealtime(sym);
    priceInfoEl.textContent  = `${sym} 最新/開/高/低： ${q.last} / ${q.open} / ${q.high} / ${q.low}`;
    updateTimeEl.textContent = `最後更新：${tsToLocal(q.time)}（免費來源可能有延遲）`;

    // 2) K 線
    ensureChart();
    const interval = kIntervalSel.value; // 1d, 5m, 15m, 30m, 60m
    const isDaily = interval === "1d";
    const range = isDaily ? "6mo" : "5d"; // 分K範圍縮短以提升速度
    const {candles, volumes} = await yahooChart(sym, range, interval === "1d" ? "1d" : interval);
    candleSeries.setData(candles);
    volSeries.setData(volumes);
    ma5.setData(sma(candles,5));
    ma20.setData(sma(candles,20));
    ma60.setData(sma(candles,60));

    // 3) 顯示當下 OHLC 與 MA 提示
    const last = candles[candles.length-1] || {};
    const ma5v  = (ma5._series?._data?.at?.(-1)?.value)  ?? (sma(candles,5).at(-1)?.value);
    const ma20v = (ma20._series?._data?.at?.(-1)?.value) ?? (sma(candles,20).at(-1)?.value);
    const ma60v = (ma60._series?._data?.at?.(-1)?.value) ?? (sma(candles,60).at(-1)?.value);
    kLegend.textContent = `O:${(last.open??"—")} H:${(last.high??"—")} L:${(last.low??"—")} C:${(last.close??"—")} | MA5:${(ma5v??"—")} MA20:${(ma20v??"—")} MA60:${(ma60v??"—")}`;

    // 4) 簡易 AI（規則）建議：不使用雲端 AI
    aiAdviceEl.textContent = buildRuleAdvice(q.last, {ma5:ma5v, ma20:ma20v, ma60:ma60v}, volumes.at?.(-1)?.value || 0);

    setStatus("完成");
  }catch(e){
    console.error(e);
    setStatus("");
    alert(`讀取失敗：${e.message||e}`);
  }
}

/* ---------- 規則版「AI 建議」：全本地運算 ---------- */
function buildRuleAdvice(price, ma, vol){
  const lines=[];
  if(ma.ma5 && ma.ma20 && ma.ma60){
    const up  = price>ma.ma5 && ma.ma5>ma.ma20 && ma.ma20>ma.ma60;
    const dn  = price<ma.ma5 && ma.ma5<ma.ma20 && ma.ma20<ma.ma60;
    const gold = ma.ma5>ma.ma20 && Math.abs(ma.ma5-ma.ma20)/ma.ma20<0.01;
    const dead = ma.ma5<ma.ma20 && Math.abs(ma.ma5-ma.ma20)/ma.ma20<0.01;

    if(up)  lines.push("趨勢：多頭排列，偏多觀察；回檔近 MA5/20 可分批。");
    if(dn)  lines.push("趨勢：空頭排列，偏空觀察；反彈靠近 MA20/60 易遇壓。");
    if(gold)lines.push("訊號：MA5 上穿 MA20（黃金交叉）— 短線偏多。");
    if(dead)lines.push("訊號：MA5 下破 MA20（死亡交叉）— 短線轉弱。");
  }
  if(vol){
    lines.push(`量能：最新量 ${Intl.NumberFormat().format(vol)}，搭配價位判斷突破/假突破。`);
  }
  lines.push("免責聲明：僅供教育示範，非投資建議。");
  return lines.join("\n");
}

/* ---------- 綁定事件 ---------- */
fetchBtn?.addEventListener("click", refreshQuoteAndChart);
kRefreshBtn?.addEventListener("click", refreshQuoteAndChart);
// Enter 快捷
symbolInput?.addEventListener("keydown", (e)=>{ if(e.key==="Enter") refreshQuoteAndChart(); });

/* ---------- 預設：若有值自動載入 ---------- */
setTimeout(()=>{
  if(symbolInput && symbolInput.value){ refreshQuoteAndChart(); }
}, 300);
