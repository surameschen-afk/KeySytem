// ระบบคีย์เชื่อมสคริปต์จริง + HWID + แบน + ล็อก + ต่อเวลา
// อัปเดต v2: เพิ่ม/ลบไอดีโรบอคต่อคีย์ (ไวท์ลิสต์) + แบนไอดีโรบอค (แบล็กลิสต์) + แก้โน้ต + Webhook Discord + กันยิงรัว + สำรองข้อมูล
const http = require('http'), fs = require('fs'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || '';
const WEBHOOK = process.env.WEBHOOK_URL || ''; // (ไม่บังคับ) ลิงก์ Discord Webhook แจ้งเตือนเหตุการณ์สำคัญ
const BIND = ['hwid', 'ip'].includes(process.env.BIND_MODE) ? process.env.BIND_MODE : 'uid'; // ค่าเริ่มต้น: ผูกตามไอดีโรบอค
const LBL = { uid: 'ไอดีโรบอค', ip: 'IP', hwid: 'HWID' }[BIND];
const getIP = req => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
if (!ADMIN) { console.log('กรุณาตั้ง ADMIN_PASSWORD ก่อน'); process.exit(1); }

const DB = './data.json';
let db = { keys: {}, script: 'print("สคริปต์ทำงานแล้ว")', logs: [], blacklist: [] };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
db.logs = db.logs || [];
db.blacklist = db.blacklist || [];
const save = () => fs.writeFileSync(DB, JSON.stringify(db));
const EMO = { create: '➕', bind: '🔗', fail: '❌', hwid: '⚠️', ban: '⛔', start: '⏱️', block: '🚫', addid: '🆔' };
const log = (type, key, info) => {
  db.logs.unshift({ t: Date.now(), type, key, info });
  if (db.logs.length > 200) db.logs.length = 200;
  save();
  if (WEBHOOK && EMO[type] && typeof fetch === 'function')
    fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `${EMO[type]} **${key}** ${info}`.slice(0, 1900) }) }).catch(() => {});
};

// ไอดีโรบอค: ตัวเลขล้วน 1-16 หลัก
const cleanId = s => /^[1-9]\d{0,15}$/.test(String(s).trim()) ? String(s).trim() : '';
const parseIds = s => [...new Set(String(s || '').split(/[\s,]+/).map(cleanId).filter(Boolean))].slice(0, 20);

// คีย์ใช้ได้เมื่อ: ถาวร / ยังไม่เริ่มนับ (exp = null) / ยังไม่หมดอายุ
const valid = k => { const r = db.keys[k]; return !!r && (r.perm || !r.exp || r.exp > Date.now()); };
// ลบเฉพาะคีย์ที่เริ่มนับแล้วและหมดอายุ (ถาวรและยังไม่เริ่มนับจะไม่ถูกลบ)
setInterval(() => { for (const k in db.keys) { const r = db.keys[k]; if (!r.perm && r.exp && r.exp < Date.now()) delete db.keys[k]; } save(); }, 600000);

// กันยิงรัว: ไม่เกิน 30 ครั้ง/นาที ต่อ IP
const hits = new Map();
setInterval(() => hits.clear(), 60000);
const limited = ip => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 30; };

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
local uid = 0
pcall(function() uid = game:GetService("Players").LocalPlayer.UserId end)
local ok, src = pcall(function()
    return game:HttpGet("${base}/api/script?key=" .. HttpService:UrlEncode(key) .. "&hwid=" .. HttpService:UrlEncode(getHWID()) .. "&uid=" .. tostring(uid))
end)
if ok and src then
    loadstring(src)()
else
    warn("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้")
end
`, 'text/plain');
  }

  if (p === '/api/script') {
    if (limited(getIP(req))) return send(res, 200, 'warn("ส่งคำขอถี่เกินไป รอสักครู่")', 'text/plain');
    const k = (url.searchParams.get('key') || '').toUpperCase();
    const hwid = (url.searchParams.get('hwid') || '').trim();
    const uid = cleanId(url.searchParams.get('uid') || '');
    const rec = db.keys[k];
    // ไอดีที่ถูกแบนทั้งระบบ
    if (uid && db.blacklist.some(b => b.id === uid)) { log('block', k.slice(0, 30) || '-', 'ไอดี ' + uid + ' อยู่ในแบล็กลิสต์ ถูกปฏิเสธ'); return send(res, 200, 'warn("ไอดีนี้ถูกระงับการใช้งาน")', 'text/plain'); }
    if (!valid(k)) { log('fail', k.slice(0, 30) || '-', 'คีย์ผิดหรือหมดอายุ'); return send(res, 200, 'warn("คีย์ไม่ถูกต้องหรือหมดอายุ")', 'text/plain'); }
    if (rec.banned) { log('ban', k, 'คีย์ที่ถูกระงับพยายามใช้'); return send(res, 200, 'warn("คีย์นี้ถูกระงับ")', 'text/plain'); }
    // ไวท์ลิสต์ไอดีโรบอค: ถ้าคีย์มีไอดีที่เพิ่มไว้ ต้องเป็นไอดีในรายการเท่านั้น
    const wl = rec.ids || [];
    if (wl.length && !wl.includes(uid)) { log('hwid', k, 'ไอดี ' + (uid || '-') + ' ไม่อยู่ในรายการที่อนุญาต ถูกปฏิเสธ'); return send(res, 200, 'warn("ไอดีโรบอคนี้ไม่ได้รับอนุญาตใช้คีย์นี้")', 'text/plain'); }
    // โหมดผูกด้วยไอดี + มีไวท์ลิสต์ → ใช้รายการไอดีเป็นตัวผูกแทน (ไม่ผูกซ้ำ)
    if (!(BIND === 'uid' && wl.length)) {
      const id = BIND === 'hwid' ? hwid : BIND === 'ip' ? getIP(req) : uid;
      if (!id) return send(res, 200, 'warn("อ่านข้อมูลบัญชีไม่ได้")', 'text/plain');
      if (!rec.hwid) { rec.hwid = id; log('bind', k, 'ผูก ' + LBL + ' ' + id + ' ครั้งแรก'); }
      else if (rec.hwid !== id) { log('hwid', k, LBL + ' ' + id + ' ไม่ตรง ถูกปฏิเสธ'); return send(res, 200, 'warn("คีย์นี้ผูกกับ' + LBL + 'อื่นแล้ว")', 'text/plain'); }
    }
    // เริ่มนับเวลาตอนใช้งานสำเร็จครั้งแรก (คีย์ถาวรไม่ต้องนับ)
    if (!rec.perm && !rec.exp) { rec.exp = Date.now() + (rec.dur || 1) * 60000; log('start', k, 'เริ่มนับเวลา'); }
    rec.uses = (rec.uses || 0) + 1; rec.last = Date.now(); if (uid) rec.lastUid = uid;
    log('use', k, 'โหลดสคริปต์' + (uid ? ' (ไอดี ' + uid + ')' : ''));
    return send(res, 200, db.script, 'text/plain');
  }

  if (p.startsWith('/admin/api/')) {
    if (req.headers['x-admin'] !== ADMIN) return send(res, 401, { error: 'รหัสไม่ถูกต้อง' });

    if (p === '/admin/api/list') {
      const keys = Object.entries(db.keys).map(([k, v]) => ({ key: k, exp: v.exp || null, perm: !!v.perm, dur: v.dur || 0, created: v.created || 0, hwid: v.hwid || null, note: v.note || '', banned: !!v.banned, uses: v.uses || 0, last: v.last || 0, ids: v.ids || [], lastUid: v.lastUid || '' })).sort((a, b) => b.created - a.created);
      return send(res, 200, { keys, script: db.script, logs: db.logs, blacklist: db.blacklist, bind: BIND, webhook: !!WEBHOOK });
    }
    if (p === '/admin/api/create') {
      const b = await readBody(req);
      const name = String(b.name || 'KEY').toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/^-+|-+$/g, '') || 'KEY';
      const perm = !!b.perm;
      const mins = Math.max(1, Math.floor(Number(b.minutes) || 1));
      const count = Math.min(50, Math.max(1, Math.floor(Number(b.count) || 1)));
      const note = String(b.note || '').slice(0, 60);
      const ids = parseIds(b.ids);
      const made = [];
      for (let i = 0; i < count; i++) {
        const key = `${name}-${rnd(2)}-${rnd(2)}`;
        db.keys[key] = perm
          ? { perm: true, exp: null, dur: 0, created: Date.now(), hwid: null, note, uses: 0, ids: [...ids] }
          : { perm: false, exp: null, dur: mins, created: Date.now(), hwid: null, note, uses: 0, ids: [...ids] };
        made.push(key);
      }
      log('create', made[0], `สร้าง ${count} คีย์ (${perm ? 'ถาวร' : mins + ' นาที เริ่มนับเมื่อใช้งาน'})` + (ids.length ? ' ล็อกไอดี ' + ids.join(',') : ''));
      return send(res, 200, { keys: made });
    }
    if (p === '/admin/api/extend') {
      const b = await readBody(req);
      const r = db.keys[b.key];
      if (r && !r.perm) {
        const add = Math.max(1, Number(b.minutes) || 0);
        if (r.exp) r.exp += add * 60000; else r.dur = (r.dur || 0) + add; // ยังไม่เริ่มนับ → เพิ่มที่ระยะเวลา
        save();
      }
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
    // เพิ่มไอดีโรบอคให้คีย์ (รับหลายไอดี คั่นด้วย , หรือเว้นวรรค)
    if (p === '/admin/api/addid') {
      const b = await readBody(req);
      const r = db.keys[b.key], add = parseIds(b.id);
      if (!r) return send(res, 200, { ok: false, error: 'ไม่พบคีย์' });
      if (!add.length) return send(res, 200, { ok: false, error: 'ไอดีต้องเป็นตัวเลขเท่านั้น' });
      r.ids = r.ids || [];
      // คีย์ที่ผูกไอดีไว้แล้ว (โหมด uid) → เก็บไอดีเดิมเข้ารายการก่อน จะได้ไม่หลุด
      if (BIND === 'uid' && !r.ids.length && r.hwid) r.ids.push(r.hwid);
      for (const i of add) if (!r.ids.includes(i) && r.ids.length < 20) r.ids.push(i);
      save(); log('addid', b.key, 'เพิ่มไอดี ' + add.join(','));
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/api/rmid') {
      const b = await readBody(req);
      const r = db.keys[b.key];
      if (r) { r.ids = (r.ids || []).filter(i => i !== String(b.id)); save(); log('addid', b.key, 'ลบไอดี ' + b.id); }
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/api/note') {
      const b = await readBody(req);
      if (db.keys[b.key]) { db.keys[b.key].note = String(b.note || '').slice(0, 60); save(); }
      return send(res, 200, { ok: true });
    }
    // แบล็กลิสต์ไอดีโรบอค (ใช้ได้ทุกคีย์)
    if (p === '/admin/api/blacklist') {
      const b = await readBody(req);
      if (b.remove) { db.blacklist = db.blacklist.filter(x => x.id !== String(b.id)); save(); return send(res, 200, { ok: true }); }
      const add = parseIds(b.id);
      if (!add.length) return send(res, 200, { ok: false, error: 'ไอดีต้องเป็นตัวเลขเท่านั้น' });
      const why = String(b.reason || '').slice(0, 60);
      for (const i of add) if (!db.blacklist.some(x => x.id === i)) db.blacklist.unshift({ id: i, reason: why, t: Date.now() });
      save(); log('block', 'BLACKLIST', 'แบนไอดี ' + add.join(',') + (why ? ' (' + why + ')' : ''));
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
