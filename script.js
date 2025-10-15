// ====== 設定區 ======
// 安全作法：請把 OPENAI_PROXY_URL 改成你自己的「後端代理網址」（例如 Cloudflare Worker / Netlify Function）
// 該代理要在伺服器端夾帶 OpenAI API Key、並轉送到 OpenAI API，瀏覽器端不放金鑰。
const OPENAI_PROXY_URL = ""; // 例： "https://你的域名.workers.dev/chat"
const OPENAI_MODEL = "gpt-5"; // 模型名稱

// ====== 工具 ======
const statusEl = document.getElementById('status');
function setStatus(msg){ statusEl.textContent = msg; }

function normalizeSymbol(input){
  const s = (input || "").trim().toUpperCase();
  // 若全為數字，視為台股，自動加 .TW
  if(/^\d+$/.test(s)) return s + ".TW";
  return s;
}

// ====== Yahoo Finance 取價（含 CORS 代理備援） ======
async function fetchYahooChart(symbol, range='3mo', interval='1d'){
  const core = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const viaProxy = `https://cors.isomorphic-git.org/${core}`;
  try{
    setStatus('連線 Yahoo Finance…');
    let r = await fetch(core, {mode:'cors'});
    if(!r.ok) throw new Error('direct fetch blocked');
    return await r.json();
  }catch(e){
    setStatus('直接連線受阻，改用代理連線…');
    let r2 = await fetch(viaProxy, {mode:'cors'});
    if(!r2.ok) throw new Error('proxy fetch failed');
    return await r2.json();
  }
}

// ====== 畫圖 ======
let chart;
function drawChart(labels, data, symbol){
  const ctx = document.getElementById("priceChart").getContext("2d");
  if(chart){ chart.destroy(); }
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: `${symbol} 收盤價`,
        data,
        borderColor: 'rgb(75,192,192)',
        fill: false,
        tension: 0.2
      }]
    },
    options: {
      plugins: { legend:{ labels:{ color:'#ddd' } } },
      scales: {
        x: { ticks: { color:'#aaa' } },
        y: { ticks: { color:'#aaa' } }
      }
    }
  });
}

// ====== 規則版 AI 建議（備援） ======
function ruleAdvice(prices){
  if(!prices || prices.length<5) return '資料不足';
  const first = prices[0], last = prices[prices.length-1];
  const change = ((last-first)/first*100).toFixed(2);
  const trend = last>first ? '上升' : '下跌';
  const ma = (arr,n)=> arr.slice(-n).reduce((a,b)=>a+b,0)/Math.min(n,arr.length);
  const ma5 = ma(prices,5).toFixed(2);
  const ma20 = ma(prices,20).toFixed(2);
  const tip = last>ma20 ? '偏多觀察，回檔靠近均線可低接' : '偏空整理，反彈至均線不追高';
  return `📊 趨勢：${trend}（三個月漲跌幅 ${change}%）
📈 均線：MA5=${ma5}、MA20=${ma20}
💡 建議：${tip}
⚠️ 免責：僅示範，非投資建議。`;
}

// ====== ChatGPT 建議（透過代理） ======
async function gptAdvice(symbol, closes){
  if(!OPENAI_PROXY_URL){
    return ruleAdvice(closes);
  }
  const body = {
    model: OPENAI_MODEL,
    messages: [{
      role: "user",
      content: `你是台股/美股分析師。請分析股票 ${symbol} 最近30筆收盤價：${JSON.stringify(closes.slice(-30))}
請用繁體中文，分成「技術面、籌碼面(如無資料可用一般原則說明)、基本面(用常見指標)、題材、短線操作建議、停損與進出價位」六段精簡條列，重點明確。`
    }]
  };
  const r = await fetch(OPENAI_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body)
  });
  if(!r.ok) throw new Error("OpenAI 代理錯誤");
  const j = await r.json();
  return j.choices?.[0]?.message?.content || "AI 建議生成失敗（代理回傳格式不符）。";
}

// ====== 主要流程 ======
document.getElementById("fetchBtn").addEventListener("click", async () => {
  let input = document.getElementById("symbol").value;
  const symbol = normalizeSymbol(input);
  if(!symbol){ alert("請輸入代號，如 2330 或 AAPL"); return; }
  document.getElementById("symbol").value = symbol; // 顯示轉換結果
  try{
    setStatus('讀取資料中…');
    const json = await fetchYahooChart(symbol);
    const res = json?.chart?.result?.[0];
    if(!res) throw new Error('API 無回傳 result');
    const ts = res.timestamp || [];
    const closes = res.indicators?.quote?.[0]?.close || [];
    if(!ts.length || !closes.length) throw new Error('資料不足');
    const labels = ts.map(t=> new Date(t*1000).toLocaleDateString());
    const last = closes[closes.length-1];
    const lastDate = labels[labels.length-1];

    document.getElementById("priceInfo").textContent = `${symbol} 現價：${Number(last).toFixed(2)}`;
    document.getElementById("updateTime").textContent = `更新時間：${lastDate}`;
    drawChart(labels, closes, symbol);

    setStatus('生成 AI 建議…');
    let advice;
    try{
      advice = await gptAdvice(symbol, closes);
    }catch(e){
      console.warn(e);
      advice = ruleAdvice(closes);
    }
    document.getElementById("aiAdvice").textContent = advice;
    setStatus('完成');
  }catch(err){
    console.error(err);
    setStatus('讀取失敗：' + err.message + '（試試 AAPL 或 2330）');
    alert('讀取失敗：' + err.message + '\n請確認代號或稍後再試');
  }
});
