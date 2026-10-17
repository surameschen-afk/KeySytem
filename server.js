// เว็บรับซองของขวัญ TrueMoney Wallet
// รัน: node server.js   (ต้องใช้ Node.js 18 ขึ้นไป ไม่ต้องติดตั้งแพ็กเกจเพิ่ม)
const http = require("http");
const fs = require("fs");

const PORT = process.env.PORT || 3000;
const PHONE = process.env.TRUEMONEY_PHONE || "0992952538"; // เบอร์ที่รับเงิน (ฝั่งเซิร์ฟเวอร์เท่านั้น)
const LOG_FILE = "redemptions.jsonl";

const ERRORS = {
  VOUCHER_NOT_FOUND: "ไม่พบซองนี้ ตรวจสอบลิงก์อีกครั้ง",
  VOUCHER_OUT_OF_STOCK: "ซองนี้ถูกรับไปหมดแล้ว",
  VOUCHER_EXPIRED: "ซองนี้หมดอายุแล้ว",
  TARGET_USER_REDEEMED: "เบอร์นี้เคยรับซองนี้ไปแล้ว",
  CANNOT_GET_OWN_VOUCHER: "รับซองที่ตัวเองสร้างไม่ได้",
  INTERNAL_ERROR: "ระบบ TrueMoney ขัดข้อง ลองใหม่อีกครั้ง",
};

// จำกัดจำนวนครั้งต่อ IP (กันยิงรัว)
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 10;
}

function extractCode(input) {
  const s = String(input || "").trim();
  const m = s.match(/[?&]v=([0-9A-Za-z]+)/) || s.match(/^([0-9A-Za-z]{18,64})$/);
  return m ? m[1] : null;
}

async function redeem(code) {
  const r = await fetch(`https://gift.truemoney.com/campaign/vouchers/${code}/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
    body: JSON.stringify({ mobile: PHONE, voucher_hash: code }),
  });
  const raw = await r.text();
  console.log("TrueMoney HTTP", r.status, raw.slice(0, 300));
  let j = {};
  try { j = JSON.parse(raw); } catch {}
  const status = j?.status?.code || "INTERNAL_ERROR";
  if (status !== "SUCCESS") return { ok: false, message: ERRORS[status] || `เกิดข้อผิดพลาด (${status})` };
  return {
    ok: true,
    amount: Number(j.data?.my_ticket?.amount_baht ?? j.data?.voucher?.amount_baht ?? 0),
    from: j.data?.owner_profile?.full_name || "",
  };
}

const masked = PHONE.slice(0, 3) + "-xxx-" + PHONE.slice(-4);

const PAGE = `<!doctype html>
<html lang="th"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>รับซองทรูมันนี่</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Mitr:wght@400;500&family=Sarabun:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#fff4e8;--ink:#2b1608;--red:#d8321f;--orange:#ff7a1a;--line:#f1cfae;--ok:#1d7a3a}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg);color:var(--ink);font-family:Sarabun,sans-serif}
main{width:100%;max-width:440px}
h1{font-family:Mitr,sans-serif;font-weight:500;font-size:2rem;margin:0 0 6px}
p.sub{margin:0 0 22px;line-height:1.5}
.env{background:var(--red);color:#fff;border-radius:18px 18px 0 0;padding:18px 20px;font-family:Mitr,sans-serif;font-size:1.05rem;position:relative}
.env::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:22px;background:#fff;clip-path:polygon(0 100%,50% 0,100% 100%)}
.card{background:#fff;border:2px solid var(--red);border-top:0;border-radius:0 0 18px 18px;padding:26px 20px 20px}
label{display:block;font-weight:600;margin-bottom:6px}
input{width:100%;font:inherit;padding:12px;border:2px solid var(--line);border-radius:10px;color:var(--ink)}
input:focus-visible,button:focus-visible{outline:3px solid var(--orange);outline-offset:2px}
button{margin-top:14px;width:100%;font:500 1.05rem Mitr,sans-serif;padding:13px;border:0;border-radius:10px;background:var(--red);color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
#msg{margin-top:14px;min-height:1.4em;font-weight:600}
#msg.ok{color:var(--ok)}#msg.err{color:var(--red)}
</style></head><body><main>
<h1>รับซองทรูมันนี่</h1>
<p class="sub">วางลิงก์ซองของขวัญ แล้วกดรับ เงินจะเข้ากระเป๋า ${masked}</p>
<div class="env">ซองของขวัญ TrueMoney</div>
<form class="card" id="f">
<label for="link">ลิงก์ซองของขวัญ</label>
<input id="link" placeholder="https://gift.truemoney.com/campaign/?v=..." autocomplete="off" required>
<button id="btn">รับซอง</button>
<div id="msg" role="status"></div>
</form></main>
<script>
const f=document.getElementById("f"),msg=document.getElementById("msg"),btn=document.getElementById("btn");
f.addEventListener("submit",async e=>{
  e.preventDefault();btn.disabled=true;msg.className="";msg.textContent="กำลังรับซอง...";
  try{
    const r=await fetch("/api/redeem",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({link:document.getElementById("link").value})});
    const j=await r.json();
    if(j.ok){msg.className="ok";msg.textContent="รับสำเร็จ "+j.amount.toLocaleString("th-TH")+" บาท"+(j.from?" จาก "+j.from:"");f.reset();}
    else{msg.className="err";msg.textContent=j.message;}
  }catch{msg.className="err";msg.textContent="เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง";}
  btn.disabled=false;
});
</script></body></html>`;

http
  .createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (req.method === "POST" && req.url === "/api/redeem") {
      const send = (obj, code = 200) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(obj));
      };
      const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress;
      if (limited(ip)) return send({ ok: false, message: "ลองบ่อยเกินไป รอสักครู่" }, 429);
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 5000) return send({ ok: false, message: "ข้อมูลใหญ่เกินไป" }, 413);
      }
      let link;
      try { link = JSON.parse(body).link; } catch { return send({ ok: false, message: "ข้อมูลไม่ถูกต้อง" }, 400); }
      const code = extractCode(link);
      if (!code) return send({ ok: false, message: "ลิงก์ซองไม่ถูกต้อง" });
      try {
        const result = await redeem(code);
        if (result.ok) fs.appendFile(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), code, amount: result.amount, from: result.from }) + "\n", () => {});
        return send(result);
      } catch {
        return send({ ok: false, message: "เชื่อมต่อ TrueMoney ไม่ได้ ลองใหม่อีกครั้ง" }, 502);
      }
    }
    res.writeHead(404);
    res.end("Not found");
  })
  .listen(PORT, () => console.log(`เปิดที่ http://localhost:${PORT}  (รับเงินเข้าเบอร์ ${masked})`));
