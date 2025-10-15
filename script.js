// ====== 設定區 ======
const OPENAI_PROXY_URL = "";   // 之後有 Cloudflare Worker 再填
const OPENAI_MODEL     = "gpt-5";

// ====== 工具 ======
const statusEl   = document.getElementById('status');
const priceInfo  = document.getElementById('priceInfo');
const updateTime = document.getElementById('updateTime');
const adviceEl   = document.getElementById('aiAdvice');
function setStatus(m){ if(statusEl) statusEl.textContent = m; }

// 台股純數字自動補 .TW
function normalizeSymbol(input){
  const s = (input||"").trim().toUpperCase();
  return /^\d+$/.test(s) ? s + ".TW" : s;
}

// ====== 抓價（多層代理備援） ======
async function fetchWithFallback(url) {
  const tries = [
    { name: "direct", url }, // 直接連
    { name: "isomorphic-cors", url: "https://cors.isomorphic-git.org/" + url },
    { name: "allorigins", url: "https://api.allorigins.win/raw?url=" + encodeURIComponent(url) },
  ];
  let lastErr;
  for (const t of tries) {
    try {
      setStatus(`連線中：${t.name}…`);
      const r = await fetch(t.url, { mode: "cors" });
      if (!r.ok) throw new Error(`${t.name} http ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      console.warn("fetch failed on", t.name, e);
    }
  }
  throw lastErr || new Error("all fetch attempts failed");
}

async function fetchYahooChart(symbol, range='3mo', interval='1d'){
  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  return fetchWithFallback(base);
}

// ====== 畫圖 ======
let chart;
function drawChart(labels, data, symbol){
  const ctx = document.getElementById("priceChart").getContext("2d");
  if(chart) chart.destroy();
  chart = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{ label:`${symbol} 收盤價`, data, borderColor:'rgb(75,192,192)', fill:false, tension:0.2, pointRadius:0 }]},
    options:{
      plugins:{ legend:{ labels:{ color:'#ddd'} } },
      scales:{ x:{ ticks:{ color:'#aaa'} }, y:{ ticks:{ color:'#aaa'} } }
    }
  });
}

// ====== 規則版 AI 建議（備援） ======
function ruleAdvice(prices){
  if(!prices || prices.length<5) return '資料不足';
  const first = prices[0], last = prices.at(-1);
  const change = ((last-first)/first*100).toFixed(2);
  const trend = last>first ? '上升' : '下跌';
  const ma = (arr,n)=> arr.slice(-n).reduce((a,b)=>a+b,0)/Math.min(n,arr.length);
  const ma5  = ma(prices,5).toFixed(2);
  const ma20 = ma(prices,20).toFixed(2);
  const tip  = last>ma20 ? '偏多：回檔靠近 MA20 可分批低接' : '偏空：反彈接近 MA20 不追高';
  return `📊 趨勢：${trend}（三個月漲跌幅 ${change}%）
📈 均線：MA5=${ma5}、MA20=${ma20}
💡 建議：${tip}
⚠️ 免責：示範用途，非投資建議。`;
}

// ====== ChatGPT 建議（有代理才會走） ======
async function gptAdvice(symbol, closes){
  if(!OPENAI_PROXY_URL) return ruleAdvice(closes);
  const body = {
    model: OPENAI_MODEL,
    messages: [{
      role:"user",
      content:`你是台股/美股分析師。分析 ${symbol} 最近30筆收盤價：${JSON.stringify(closes.slice(-30))}
請用繁體中文，條列「技術面、籌碼面(若無資料用原則說明)、基本面(常見指標)、題材、短線建議、停損與進出價位」。`
    }]
  };
  const r = await fetch(OPENAI_PROXY_URL, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
  if(!r.ok) throw new Error("OpenAI 代理錯誤");
  const j = await r.json();
  return j.choices?.[0]?.message?.content || ruleAdvice(closes);
}

// ====== 主流程 ======
document.getElementById("fetchBtn").addEventListener("click", async () => {
  const raw = document.getElementById("symbol").value;
  const symbol = normalizeSymbol(raw);
  if(!symbol){ alert("請輸入代號，如 2330 或 AAPL"); return; }

  try{
    setStatus('讀取資料中…');
    const json = await fetchYahooChart(symbol);
    const res = json?.chart?.result?.[0];
    if(!res) throw new Error('API 無回傳 result');
    const ts     = res.timestamp || [];
    const closes = res.indicators?.quote?.[0]?.close || [];
    if(!ts.length || !closes.length) throw new Error('資料不足');

    const labels = ts.map(t=> new Date(t*1000).toLocaleDateString());
    const last   = closes.at(-1);
    const lastDt = labels.at(-1);

    priceInfo.textContent  = `${symbol} 現價：${Number(last).toFixed(2)}`;
    updateTime.textContent = `更新時間：${lastDt}`;
    drawChart(labels, closes, symbol);

    setStatus('生成 AI 建議…');
    let text;
    try{ text = await gptAdvice(symbol, closes); }
    catch{ text = ruleAdvice(closes); }
    adviceEl.textContent = text;
    setStatus('完成');
  }catch(err){
    console.error(err);
    setStatus('讀取失敗：' + err.message + '（先試 AAPL 或 2330）');
    alert('讀取失敗：' + err.message);
  }
});
