// ระบบคีย์เชื่อมสคริปต์จริง + HWID + แบน + ล็อก + ต่อเวลา
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || '';
if (!ADMIN) { console.log('กรุณาตั้ง ADMIN_PASSWORD ก่อน'); process.exit(1); }

const DB = './data.json';
let db = { keys: {}, script: 'print("สคริปต์ทำงานแล้ว")', logs: [] };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
db.logs = db.logs || [];
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
const log = (type, key, info) => { db.logs.unshift({ t: Date.now(), type, key, info }); if (db.logs.length > 100) db.logs.length = 100; save(); };
const valid = k => db.keys[k] && db.keys[k].exp > Date.now();
setInterval(() => { for (const k in db.keys) if (db.keys[k].exp < Date.now()) delete db.keys[k]; save(); }, 600000);

const readBody = req => new Promise(r => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 2e6) req.destroy(); });
  req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } });
});
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const rnd = n => crypto.randomBytes(n).toString('hex').toUpperCase();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/admin')
    return send(res, 200, fs.readFileSync('./admin.html', 'utf8'), 'text/html');

  if (p === '/loader.lua') {
    const base = process.env.BASE_URL || 'https://' + req.headers.host;
    return send(res, 200,
`local key = tostring(getgenv().Key or "")
local function getHWID()
    local ok, v = pcall(function() return gethwid and gethwid() end)
    if ok and v then return tostring(v) end
    return game:GetService("RbxAnalyticsService"):GetClientId()
end
local HttpService = game:GetService("HttpService")
local ok, src = pcall(function()
    return game:HttpGet("${base}/api/script?key=" .. HttpService:UrlEncode(key) .. "&hwid=" .. HttpService:UrlEncode(getHWID()))
end)
if ok and src then
    loadstring(src)()
else
    warn("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
end
`, 'text/plain');
  }

  if (p === '/api/script') {
    const k = (url.searchParams.get('key') || '').toUpperCase();
    const hwid = (url.searchParams.get('hwid') || '').trim();
    const rec = db.keys[k];
    if (!valid(k)) { log('fail', k.slice(0, 30) || '-', 'คีย์ผิดหรือหมดอายุ'); return send(res, 200, 'warn("คีย์ไม่ถูกต้องหรือหมดอายุ")', 'text/plain'); }
    if (rec.banned) { log('ban', k, 'คีย์ที่ถูกระงับพยายามใช้'); return send(res, 200, 'warn("คีย์นี้ถูกระงับ")', 'text/plain'); }
    if (!hwid) return send(res, 200, 'warn("อ่าน HWID ไม่ได้")', 'text/plain');
    if (!rec.hwid) { rec.hwid = hwid; log('bind', k, 'ผูก HWID ครั้งแรก'); }
    else if (rec.hwid !== hwid) { log('hwid', k, 'HWID ไม่ตรง ถูกปฏิเสธ'); return send(res, 200, 'warn("คีย์นี้ผูกกับเครื่องอื่นแล้ว")', 'text/plain'); }
    rec.uses = (rec.uses || 0) + 1; rec.last = Date.now();
    log('use', k, 'โหลดสคริปต์');
    return send(res, 200, db.script, 'text/plain');
  }

  if (p.startsWith('/admin/api/')) {
    if (req.headers['x-admin'] !== ADMIN) return send(res, 401, { error: 'รหัสไม่ถูกต้อง' });

    if (p === '/admin/api/list') {
      const keys = Object.entries(db.keys).map(([k, v]) => ({ key: k, exp: v.exp, hwid: v.hwid || null, note: v.note || '', banned: !!v.banned, uses: v.uses || 0, last: v.last || 0 })).sort((a, b) => b.exp - a.exp);
      return send(res, 200, { keys, script: db.script, logs: db.logs });
    }
    if (p === '/admin/api/create') {
      const b = await readBody(req);
      const name = String(b.name || 'KEY').toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/^-+|-+$/g, '') || 'KEY';
      const mins = Math.max(1, Math.floor(Number(b.minutes) || 1));
      const count = Math.min(50, Math.max(1, Math.floor(Number(b.count) || 1)));
      const note = String(b.note || '').slice(0, 60);
      const made = [];
      for (let i = 0; i < count; i++) {
        const key = `${name}-${rnd(2)}-${rnd(2)}`;
        db.keys[key] = { exp: Date.now() + mins * 60000, hwid: null, note, uses: 0 };
        made.push(key);
      }
      log('create', made[0], `สร้าง ${count} คีย์`);
      return send(res, 200, { keys: made });
    }
    if (p === '/admin/api/extend') {
      const b = await readBody(req);
      if (db.keys[b.key]) { db.keys[b.key].exp += Math.max(1, Number(b.minutes) || 0) * 60000; save(); }
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/api/ban') {
      const b = await readBody(req);
      if (db.keys[b.key]) { db.keys[b.key].banned = !db.keys[b.key].banned; save(); }
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/api/reset') {
      const b = await readBody(req);
      if (db.keys[b.key]) { db.keys[b.key].hwid = null; save(); }
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/api/delete') {
      const b = await readBody(req);
      delete db.keys[b.key]; save();
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/api/script') {
      const b = await readBody(req);
      db.script = String(b.script || ''); save();
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/api/clearlogs') { db.logs = []; save(); return send(res, 200, { ok: true }); }
  }
  send(res, 404, 'Not found', 'text/plain');
}).listen(PORT, () => console.log('Running on port ' + PORT));
