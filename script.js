// ===================== 開關與設定 =====================
// 如果你已經有 Cloudflare Worker / 代理端點可以轉 OpenAI API，填在這裡：
// 例如： const OPENAI_PROXY_URL = "https://你的域名/ai-proxy";
const OPENAI_PROXY_URL = "";   // 先留空也沒關係 → 會只用本地規則建議
const OPENAI_MODEL = "gpt-5";  // 你的模型代號（代理那邊會轉）

// ===================== DOM & 小工具 =====================
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const adviceEl = $("aiAdvice");

function setStatus(msg){ if(statusEl) statusEl.textContent = msg; }
function safeSetAdvice(text){ if(adviceEl) adviceEl.textContent = text || "（暫無資料）"; }

// 台股只輸入數字就自動加 .TW；美股直接代號
function normalizeSymbol(input){
  const s = (input || "").trim().toUpperCase();
  if(!s) return s;
  return /^\d+$/.test(s) ? `${s}.TW` : s;
}

function fetchTimeout(url, opt = {}, ms = 8000){
  return new Promise((resolve, reject)=>{
    const id = setTimeout(()=>reject(new Error("timeout")), ms);
    fetch(url, opt).then(r=>{ clearTimeout(id); resolve(r); })
                   .catch(e=>{ clearTimeout(id); reject(e); });
  });
}

// 多路徑 + 重試
async function fetchJSONWithRetry(urls, opt = {}, tries = 3){
  let lastErr;
  for(let round = 0; round < Math.max(tries,1); round++){
    for(const {name, url} of urls){
      try{
        setStatus(`連線中：${name}…`);
        const res = await fetchTimeout(url, {...opt, mode:"cors"}, 8000);
        if(!res.ok) throw new Error(`${name} http ${res.status}`);
        return await res.json();
      }catch(e){ lastErr = e; }
    }
    await new Promise(s=>setTimeout(s, 500 + round * 300));
  }
  throw lastErr || new Error("all routes failed");
}

// ===================== Yahoo Finance 來源 =====================
async function fetchYahooChart(symbol, range = "6mo", interval = "1d"){
  const core = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const bust = `&_=${Date.now()}`;
  const routes = [
    { name:"isomorphic", url:"https://cors.isomorphic-git.org/" + core + bust },
    { name:"allorigins", url:"https://api.allorigins.win/raw?url=" + encodeURIComponent(core + bust) },
    { name:"thingproxy", url:"https://thingproxy.freeboard.io/fetch/" + core + bust },
    { name:"direct",     url: core + bust },
  ];
  return fetchJSONWithRetry(routes, {}, 2);
}

// ===================== 轉換與指標 =====================
function toCandles(json){
  const r = json?.chart?.result?.[0];
  if(!r) throw new Error("chart result not found");
  const ts = r.timestamp || [];
  const q  = r.indicators?.quote?.[0] || {};
  const o=q.open||[], h=q.high||[], l=q.low||[], c=q.close||[], v=q.volume||[];

  const candles = [], volumes = [];
  for(let i=0;i<ts.length;i++){
    if(o[i]==null || h[i]==null || l[i]==null || c[i]==null) continue;
    const bar = { time: ts[i], open:+o[i], high:+h[i], low:+l[i], close:+c[i] };
    candles.push(bar);
    volumes.push({
      time: ts[i],
      value: +(v[i]||0),
      color: bar.close >= bar.open ? "#26a69a" : "#ef5350"
    });
  }
  return { candles, volumes };
}

function smaSeries(candles, n){
  const out = [];
  let sum = 0;
  const q = [];
  for(const c of candles){
    q.push(c.close);
    sum += c.close;
    if(q.length > n) sum -= q.shift();
    out.push({ time:c.time, value: sum / q.length });
  }
  return out;
}

// RSI(14)
function rsiSeries(candles, period = 14){
  const out = [];
  if(candles.length < period+1) return out;
  let gain = 0, loss = 0;
  for(let i=1;i<=period;i++){
    const diff = candles[i].close - candles[i-1].close;
    if(diff >= 0) gain += diff; else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out.push({ time:candles[period].time, value: avgLoss === 0 ? 100 : 100 - (100/(1 + avgGain/avgLoss)) });

  for(let i=period+1;i<candles.length;i++){
    const diff = candles[i].close - candles[i-1].close;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain*(period-1) + g)/period;
    avgLoss = (avgLoss*(period-1) + l)/period;
    const rs = avgLoss === 0 ? 100 : 100 - (100/(1 + avgGain/avgLoss));
    out.push({ time:candles[i].time, value: rs });
  }
  return out;
}

// ATR(14)
function atr(candles, period = 14){
  if(candles.length < period+1) return 0;
  const trs = [];
  for(let i=1;i<candles.length;i++){
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }
  const n = Math.min(period, trs.length);
  let s = 0;
  for(let i=trs.length-n;i<trs.length;i++) s += trs[i];
  return s / n;
}

// ===================== 圖表 =====================
let kChart, sCandle, sVol, sMA5, sMA20, sMA60;

function ensureKChart(){
  if(kChart) return;
  kChart = LightweightCharts.createChart($("kChart"), {
    layout: { background:{ color:"#0b1220" }, textColor:"#e5e7eb" },
    grid:   { vertLines:{ color:"#1f2937" },  horzLines:{ color:"#1f2937" } },
    timeScale: { rightOffset:2, borderColor:"#334155" },
    rightPriceScale: { borderColor:"#334155" },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
  });
  sCandle = kChart.addCandlestickSeries({
    upColor:"#26a69a", downColor:"#ef5350",
    borderUpColor:"#26a69a", borderDownColor:"#ef5350",
    wickUpColor:"#26a69a",  wickDownColor:"#ef5350"
  });
  sVol = kChart.addHistogramSeries({
    priceScaleId:"", priceFormat:{ type:"volume" }, base:0, color:"#888"
  });
  kChart.priceScale("").applyOptions({ scaleMargins:{ top:0.8, bottom:0 } });
  sMA5  = kChart.addLineSeries({ color:"#facc15", lineWidth:2 });
  sMA20 = kChart.addLineSeries({ color:"#e879f9", lineWidth:2 });
  sMA60 = kChart.addLineSeries({ color:"#60a5fa", lineWidth:2 });
}

function rangeByInterval(interval){
  switch(interval){
    case "5m":  return "5d";
    case "15m": return "10d";
    case "30m": return "1mo";
    case "60m": return "3mo";
    default:    return "6mo";
  }
}

async function renderK(symbol, interval){
  ensureKChart();
  const range = rangeByInterval(interval);
  const json = await fetchYahooChart(symbol, range, interval);
  const { candles, volumes } = toCandles(json);
  if(candles.length < 5) throw new Error("資料不足");

  sCandle.setData(candles);
  sVol.setData(volumes);
  const ma5  = smaSeries(candles, 5);
  const ma20 = smaSeries(candles, 20);
  const ma60 = smaSeries(candles, 60);
  sMA5.setData(ma5);
  sMA20.setData(ma20);
  sMA60.setData(ma60);
  kChart.timeScale().fitContent();

  const last = candles.at(-1);
  const v = (x)=> (x??0).toFixed(2);
  $("kLegend").textContent =
    `O:${v(last.open)} H:${v(last.high)} L:${v(last.low)} C:${v(last.close)}  | ` +
    `MA5:${v(ma5.at(-1)?.value)}  MA20:${v(ma20.at(-1)?.value)}  MA60:${v(ma60.at(-1)?.value)}`;

  // === 先顯示「本地規則型」建議（一定會有） ===
  const localAdvice = makeFullAdvice(candles, volumes, ma5, ma20, ma60);
  safeSetAdvice(localAdvice);

  // === 再嘗試「雲端 AI 總結」（可選） ===
  if(OPENAI_PROXY_URL){
    try{
      const prompt = buildAIPrompt(symbol, candles, ma5, ma20, ma60, volumes);
      const ai = await fetchAIAdvice(prompt, 12000);
      if(ai && ai.trim()){
        safeSetAdvice(`${localAdvice}\n\n———\n🧠 雲端 AI 總結：\n${ai.trim()}`);
      }
    }catch(e){
      console.warn("AI 總結失敗：", e.message);
      // 不覆蓋本地建議，只在狀態列提示
      setStatus(`AI 總結失敗：${e.message}`);
    }
  }
}

// ===================== 走勢 ↔ 即時價 =====================
function formatTs(ts){
  try { return new Date(ts*1000).toLocaleString(); }
  catch { return String(ts); }
}

async function refreshQuote(){
  const raw = $("symbol").value;
  const symbol = normalizeSymbol(raw);
  if(!symbol){ alert("請先輸入代號"); return; }

  try{
    setStatus("讀取中…");
    const base = await fetchYahooChart(symbol, "6mo", "1d");
    const r = base?.chart?.result?.[0];
    if(!r) throw new Error("無資料");

    const closeArr = r.indicators?.quote?.[0]?.close || [];
    const lastClose = closeArr.at(-1);
    const ts = (r.timestamp || []).at(-1);

    $("priceInfo").textContent = `${symbol} 最新/收盤：${Number(lastClose||0).toFixed(2)}`;
    $("updateTime").textContent = `更新時間：${formatTs(ts)}（Yahoo 可能延遲 10–20 分）`;

    const itv = $("kInterval").value || "1d";
    await renderK(symbol, itv);

    setStatus("完成");
  }catch(e){
    console.error(e);
    setStatus("讀取失敗：" + e.message);
    alert("讀取失敗：" + e.message);
  }
}

// ===================== 規則型 AI（本地） =====================
function avg(arr, n){
  if(!arr?.length) return 0;
  const m = Math.max(1, Math.min(n, arr.length));
  let s = 0;
  for(let i=arr.length-m;i<arr.length;i++) s += (arr[i].value ?? arr[i]);
  return s / m;
}

function makeTrendStructureAdvice(candles){
  const N = Math.min(60, candles.length);
  const slice = candles.slice(-N);
  let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;

  for(let i=1;i<slice.length;i++){
    if(slice[i].high > slice[i-1].high) higherHighs++; else if(slice[i].high < slice[i-1].high) lowerHighs++;
    if(slice[i].low  > slice[i-1].low ) higherLows++;  else if(slice[i].low  < slice[i-1].low ) lowerLows++;
  }

  let view = "結構：震盪整理";
  if(higherHighs > lowerHighs && higherLows > lowerLows) view = "結構：上升通道（高低點同步墊高）";
  if(lowerHighs > higherHighs && lowerLows > higherLows) view = "結構：下降通道（高低點同步下移）";

  let streakHigh = 0, streakLow = 0;
  for(let i=slice.length-1;i>0;i--){
    if(slice[i].high >= slice[i-1].high) { streakHigh++; } else break;
  }
  for(let i=slice.length-1;i>0;i--){
    if(slice[i].low  <= slice[i-1].low ) { streakLow++; } else break;
  }
  if(streakHigh >= 3) view += "；短線連續創高（留意追高風險）";
  if(streakLow  >= 3) view += "；短線連續創低（留意超跌反彈）";

  return view;
}

function makeSupportResistanceAdvice(candles){
  const N = Math.min(20, candles.length);
  const win = candles.slice(-N);
  const hi = Math.max(...win.map(b=>b.high));
  const lo = Math.min(...win.map(b=>b.low));
  const last = candles.at(-1);
  const a = atr(candles, 14);
  const nearPct = 0.01;
  const nearStr = (px) => Math.abs(last.close - px)/px <= nearPct ? "（接近）" : "";
  return [
    `壓力區：約 ${hi.toFixed(2)} ${nearStr(hi)}（觀察放量突破）`,
    `支撐區：約 ${lo.toFixed(2)} ${nearStr(lo)}（跌破小心續弱）`,
    `ATR(14) ≈ ${a.toFixed(2)}（安全邊際）`
  ].join("；");
}

function makeVolumeAnomalyAdvice(candles, volumes){
  const last = candles.at(-1);
  const volNow = volumes.at(-1)?.value ?? 0;
  const vol20  = avg(volumes.map(v=>({value:v.value})), 20);
  const spike = vol20 ? volNow / vol20 : 1;

  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low || 1;
  const bodyRatio = body / range;
  let bodyView = "";
  if(bodyRatio >= 0.7) bodyView = "長實體K（趨勢明確）";
  else if(bodyRatio <= 0.3) bodyView = "長影線K（多空拉鋸）";
  else bodyView = "中等實體K";

  let volView = `量能：${spike.toFixed(2)}x / 20日均量`;
  if(spike >= 2.0) volView += "（異常放大，可能突破/出貨）";
  else if(spike <= 0.6) volView += "（顯著量縮，籌碼沉澱）";

  return `${volView}；${bodyView}`;
}

function makeTechnicalAdvice(candles, ma5, ma20, ma60){
  const p = candles.at(-1).close;
  const m5  = ma5.at(-1)?.value ?? p;
  const m20 = ma20.at(-1)?.value ?? p;
  const m60 = ma60.at(-1)?.value ?? p;

  let trend = "盤整/轉折觀察";
  if(m5 > m20 && m20 > m60) trend = "多頭排列（偏多）";
  if(m5 < m20 && m20 < m60) trend = "空頭排列（偏空）";

  let cross = "均線交叉：無明顯交叉";
  const prev5  = ma5.at(-2)?.value;
  const prev20 = ma20.at(-2)?.value;
  if(prev5 && prev20){
    if(prev5 < prev20 && m5 > m20) cross = "⚡ MA5 上穿 MA20（黃金交叉）";
    if(prev5 > prev20 && m5 < m20) cross = "⚠ MA5 下穿 MA20（死亡交叉）";
  }

  const rsi = rsiSeries(candles, 14);
  const r = rsi.at(-1)?.value ?? 50;
  let rsiView = `RSI(14)：${r.toFixed(1)}`;
  if(r >= 70) rsiView += "（偏熱/易震盪）";
  else if(r <= 30) rsiView += "（偏冷/留意反彈）";

  let pos = "價格位於均線附近";
  if(p > m5 && p > m20 && p > m60) pos = "價格在均線之上（多方優勢）";
  if(p < m5 && p < m20 && p < m60) pos = "價格在均線之下（空方優勢）";

  return { summary: [`趨勢：${trend}`, pos, cross, rsiView].join("；"), rsi:r, m5, m20, m60, price:p };
}

function makeOverallSentiment(tech, volumes){
  let score = 0;
  if(tech.m5 > tech.m20) score += 1; else score -= 1;
  if(tech.m20 > tech.m60) score += 1; else score -= 1;
  if(tech.rsi >= 60) score += 1;
  if(tech.rsi <= 40) score -= 1;
  if(tech.price > tech.m60) score += 1; else score -= 1;

  const volNow = volumes.at(-1)?.value ?? 0;
  const vol20  = avg(volumes.map(v=>({value:v.value})), 20);
  if(vol20){
    const spike = volNow / vol20;
    if(spike >= 1.5) score += 1;
    if(spike <= 0.7) score -= 1;
  }

  let mood = "🌫 中性";
  if(score >= 3) mood = "🔥 強多";
  else if(score === 2) mood = "🌤 偏多";
  else if(score <= -3) mood = "❄ 強空";
  else if(score === -2) mood = "🌧 偏空";

  let action = "中性觀望，聚焦支撐/壓力與風險控管。";
  if(mood === "🔥 強多") action = "偏多操作：回檔靠近 MA20 可分批布局，跌破 MA20 嚴設停損。";
  if(mood === "🌤 偏多") action = "順勢做多，遇壓力不過先減碼。";
  if(mood === "🌧 偏空") action = "反彈不過 MA20/MA60 以逢高減碼為主。";
  if(mood === "❄ 強空") action = "保守應對：反彈減碼，僅短線試單，嚴格控風險。";

  return `${mood}｜${action}`;
}

function makeFullAdvice(candles, volumes, ma5, ma20, ma60){
  const a1 = makeTrendStructureAdvice(candles);
  const a2 = makeSupportResistanceAdvice(candles);
  const tech = makeTechnicalAdvice(candles, ma5, ma20, ma60);
  const a3 = makeVolumeAnomalyAdvice(candles, volumes);
  const mood = makeOverallSentiment(tech, volumes);

  return [
    a1,
    a2,
    tech.summary,
    a3,
    `綜合判斷：${mood}`,
    "（以上僅供教育與研究使用，非投資建議）"
  ].join("\n");
}

// ===================== 雲端 AI（可選，用代理端點） =====================
function buildAIPrompt(symbol, candles, ma5, ma20, ma60, volumes){
  const last = candles.at(-1);
  const v = (x)=> (x??0).toFixed(2);
  const m5  = v(ma5.at(-1)?.value);
  const m20 = v(ma20.at(-1)?.value);
  const m60 = v(ma60.at(-1)?.value);
  const volNow = volumes.at(-1)?.value ?? 0;

  return [
    `請扮演專業台股/美股技術分析師，以精煉中文產出 120~180 字的結論與操作框架，避免過度保守或武斷。`,
    `重點：趨勢（均線結構）、關鍵價位（支撐/壓力）、風險（停損/部位）、倉位建議（區間）。`,
    `標的：${symbol}`,
    `最新 O:${v(last.open)} H:${v(last.high)} L:${v(last.low)} C:${v(last.close)} 量:${volNow}`,
    `MA5:${m5}  MA20:${m20}  MA60:${m60}`,
    `請以「結論一句話」開頭，接著條列 3~4 點行動事項。`
  ].join("\n");
}

async function fetchAIAdvice(prompt, timeoutMs = 12000){
  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role:"system", content:"你是嚴謹的技術分析顧問，輸出簡潔可執行的觀點。" },
      { role:"user", content: prompt }
    ],
    temperature: 0.6,
    max_tokens: 320
  };
  const res = await fetchTimeout(OPENAI_PROXY_URL, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify(body)
  }, timeoutMs);
  if(!res.ok) throw new Error(`AI http ${res.status}`);
  const json = await res.json();
  // 常見 proxy 會回成：{choices:[{message:{content:"..."}}]}
  return json?.choices?.[0]?.message?.content || json?.content || "";
}

// ===================== 綁定事件 =====================
$("fetchBtn").addEventListener("click", refreshQuote);
$("kRefresh").addEventListener("click", async ()=>{
  const raw = $("symbol").value;
  const symbol = normalizeSymbol(raw);
  const itv = $("kInterval").value || "1d";
  try{
    setStatus("更新 K 線中…");
    await renderK(symbol, itv);
    setStatus("完成");
  }catch(e){
    console.error(e);
    setStatus("K 線讀取失敗：" + e.message);
    alert("K 線讀取失敗：" + e.message);
  }
});
$("symbol").addEventListener("keydown", (e)=>{ if(e.key==="Enter") $("fetchBtn").click(); });

// 預設載入
window.addEventListener("load", ()=>{
  $("symbol").value = "AAPL";
  safeSetAdvice("（準備中…）");
  $("fetchBtn").click();
});
