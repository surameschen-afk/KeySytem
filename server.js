// ระบบคีย์เชื่อมสคริปต์จริง + HWID + แบน + ล็อก + ต่อเวลา
// อัปเดต v3: บันทึกอัตโนมัติ (เขียนไฟล์แบบปลอดภัย + ไฟล์สำรอง .bak) + ซิงก์สำรองขึ้น GitHub Gist (ข้อมูลไม่หายตอนอัปเดตบน Render) + นำเข้าไฟล์สำรอง
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || '';
const WEBHOOK = process.env.WEBHOOK_URL || ''; // (ไม่บังคับ) ลิงก์ Discord Webhook แจ้งเตือนเหตุการณ์สำคัญ
const BIND = ['hwid', 'ip'].includes(process.env.BIND_MODE) ? process.env.BIND_MODE : 'uid'; // ค่าเริ่มต้น: ผูกตามไอดีโรบอค
const LBL = { uid: 'ไอดีโรบอค', ip: 'IP', hwid: 'HWID' }[BIND];
const GH_TOKEN = process.env.GITHUB_TOKEN || ''; // (แนะนำ) โทเคน GitHub สิทธิ์ gist สำหรับสำรองข้อมูลอัตโนมัติ
const GIST_ID = process.env.GIST_ID || '';       // ไอดีของ Gist (secret) ที่ใช้เก็บข้อมูล
const getIP = req => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
if (!ADMIN) { console.log('กรุณาตั้ง ADMIN_PASSWORD ก่อน'); process.exit(1); }

// ที่เก็บไฟล์: ตั้ง DATA_DIR=/data ถ้าใช้ Persistent Disk ของ Render
const DB = process.env.DATA_FILE || path.join(process.env.DATA_DIR || '.', 'data.json');
try { fs.mkdirSync(path.dirname(DB), { recursive: true }); } catch {}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
let db = readJson(DB) || readJson(DB + '.bak') || { keys: {} };
const norm = () => {
  db.keys = db.keys || {};
  if (typeof db.script !== 'string') db.script = 'print("สคริปต์ทำงานแล้ว")';
  db.logs = db.logs || [];
  db.blacklist = db.blacklist || [];
  db.updated = db.updated || 0;
};
norm();

const sync = { disk: !!(process.env.DATA_DIR || process.env.DATA_FILE), gist: !!(GH_TOKEN && GIST_ID), last: 0, err: '' };
const ghHeaders = { Authorization: 'Bearer ' + GH_TOKEN, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'key-system' };

// ---------- บันทึกอัตโนมัติ ----------
let dirty = false, timer = null, pushTimer = null, pushing = false;
const writeLocal = () => {
  try {
    fs.writeFileSync(DB + '.tmp', JSON.stringify(db));
    try { if (fs.existsSync(DB)) fs.copyFileSync(DB, DB + '.bak'); } catch {}
    fs.renameSync(DB + '.tmp', DB); // เขียนเสร็จแล้วค่อยสลับไฟล์ กันไฟล์พังตอนดับกลางคัน
  } catch (e) { console.log('บันทึกไฟล์ไม่ได้:', e.message); }
};
const flush = () => { timer = null; if (!dirty) return; dirty = false; writeLocal(); };
const pushRemote = async () => {
  pushTimer = null;
  if (!sync.gist || typeof fetch !== 'function') return false;
  if (pushing) { pushTimer = setTimeout(pushRemote, 5000); return false; }
  pushing = true;
  let ok = false;
  try {
    const r = await fetch('https://api.github.com/gists/' + GIST_ID, { method: 'PATCH', headers: ghHeaders, body: JSON.stringify({ files: { 'data.json': { content: JSON.stringify(db) } } }) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    sync.last = Date.now(); sync.err = ''; ok = true;
  } catch (e) {
    sync.err = e.message; console.log('ซิงก์ Gist ไม่สำเร็จ:', e.message);
    if (!pushTimer) pushTimer = setTimeout(pushRemote, 60000); // ลองใหม่ใน 1 นาที
  }
  pushing = false;
  return ok;
};
const save = () => {
  db.updated = Date.now(); dirty = true;
  if (!timer) timer = setTimeout(flush, 800);
  if (sync.gist && !pushTimer) pushTimer = setTimeout(pushRemote, 15000);
};
const pullRemote = async () => {
  try {
    const r = await fetch('https://api.github.com/gists/' + GIST_ID, { headers: ghHeaders });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const g = await r.json(), f = g.files && g.files['data.json'];
    if (!f) return { ok: true, data: null };
    let txt = f.content;
    if (f.truncated || txt == null) txt = await (await fetch(f.raw_url, { headers: ghHeaders })).text();
    return { ok: true, data: JSON.parse(txt || '{}') };
  } catch (e) { sync.err = e.message; console.log('ดึงข้อมูลจาก Gist ไม่สำเร็จ:', e.message); return { ok: false, data: null }; }
};
let closing = false;
const shutdown = async () => {
  if (closing) return; closing = true;
  clearTimeout(timer); dirty = false; writeLocal();
  if (sync.gist) { clearTimeout(pushTimer); await Promise.race([pushRemote(), new Promise(r => setTimeout(r, 5000))]); }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const EMO = { create: '➕', bind: '🔗', fail: '❌', hwid: '⚠️', ban: '⛔', start: '⏱️', block: '🚫', addid: '🆔' };
const log = (type, key, info) => {
  db.logs.unshift({ t: Date.now(), type, key, info });
  if (db.logs.length > 200) db.logs.length = 200;
  save();
  if (WEBHOOK && EMO[type] && typeof fetch === 'function')
    fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `${EMO[type]} **${key}** ${info}`.slice(0, 1900) }) }).catch(() => {});
};

// ไอดีโรบอค: ชื่อ @username (3-20 ตัว a-z 0-9 _ ไม่สนตัวพิมพ์ใหญ่เล็ก) หรือเลข UserID
const cleanUid = s => /^[1-9]\d{0,15}$/.test(String(s).trim()) ? String(s).trim() : '';
const cleanId = s => { s = String(s).trim().replace(/^@/, ''); return /^[A-Za-z0-9_]{3,20}$/.test(s) ? s.toLowerCase() : cleanUid(s); };
const parseIds = s => [...new Set(String(s || '').split(/[\s,]+/).map(cleanId).filter(Boolean))].slice(0, 20);

// คีย์ใช้ได้เมื่อ: ถาวร / ยังไม่เริ่มนับ (exp = null) / ยังไม่หมดอายุ
const valid = k => { const r = db.keys[k]; return !!r && (r.perm || !r.exp || r.exp > Date.now()); };
// ลบเฉพาะคีย์ที่เริ่มนับแล้วและหมดอายุ (ถาวรและยังไม่เริ่มนับจะไม่ถูกลบ)
setInterval(() => { let n = 0; for (const k in db.keys) { const r = db.keys[k]; if (!r.perm && r.exp && r.exp < Date.now()) { delete db.keys[k]; n++; } } if (n) save(); }, 600000);

// กันยิงรัว: ไม่เกิน 30 ครั้ง/นาที ต่อ IP
const hits = new Map();
setInterval(() => hits.clear(), 60000);
const limited = ip => { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n > 30; };

const readBody = req => new Promise(r => {
  let d = '';
  req.on('data', c => { d += c; if (d.length > 8e6) req.destroy(); });
  req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } });
});
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const rnd = n => crypto.randomBytes(n).toString('hex').toUpperCase();

const server = http.createServer(async (req, res) => {
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
local uid, pname = 0, ""
pcall(function() uid = game:GetService("Players").LocalPlayer.UserId end)
pcall(function() pname = game:GetService("Players").LocalPlayer.Name end)
local ok, src = pcall(function()
    return game:HttpGet("${base}/api/script?key=" .. HttpService:UrlEncode(key) .. "&hwid=" .. HttpService:UrlEncode(getHWID()) .. "&uid=" .. tostring(uid) .. "&name=" .. HttpService:UrlEncode(pname))
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
    const uid = cleanUid(url.searchParams.get('uid') || '');
    const name = cleanId(url.searchParams.get('name') || ''); // ชื่อ @ ของผู้เล่น (ตัวพิมพ์เล็ก)
    const rec = db.keys[k];
    // ไอดีที่ถูกแบนทั้งระบบ
    if ((uid || name) && db.blacklist.some(b => b.id === uid || b.id === name)) { log('block', k.slice(0, 30) || '-', 'ไอดี ' + (name ? '@' + name : uid) + ' อยู่ในแบล็กลิสต์ ถูกปฏิเสธ'); return send(res, 200, 'warn("ไอดีนี้ถูกระงับการใช้งาน")', 'text/plain'); }
    if (!valid(k)) { log('fail', k.slice(0, 30) || '-', 'คีย์ผิดหรือหมดอายุ'); return send(res, 200, 'warn("คีย์ไม่ถูกต้องหรือหมดอายุ")', 'text/plain'); }
    if (rec.banned) { log('ban', k, 'คีย์ที่ถูกระงับพยายามใช้'); return send(res, 200, 'warn("คีย์นี้ถูกระงับ")', 'text/plain'); }
    // รายชื่อไอดีโรบอค (@ชื่อ) ที่ใช้คีย์นี้ได้ — ตรวจด้วยชื่อ หรือ UserID
    const wl = rec.ids || [];
    const me = [name, uid].filter(Boolean);
    if (wl.length && !me.some(x => wl.includes(x))) { log('hwid', k, 'ไอดี ' + (name ? '@' + name : uid || '-') + ' ไม่อยู่ในรายการที่อนุญาต ถูกปฏิเสธ'); return send(res, 200, 'warn("ไอดีโรบอคนี้ไม่ได้รับอนุญาตใช้คีย์นี้")', 'text/plain'); }
    if (BIND === 'uid') {
      // โหมดชื่อ: คนแรกที่ใช้จะถูกเพิ่มเข้ารายการอัตโนมัติ แอดมินเพิ่มคนอื่นเองได้ภายหลัง
      if (!wl.length) {
        if (!me.length) return send(res, 200, 'warn("อ่านข้อมูลบัญชีไม่ได้")', 'text/plain');
        if (rec.hwid && uid && rec.hwid !== uid) { log('hwid', k, 'ไอดี ' + uid + ' ไม่ตรง ถูกปฏิเสธ'); return send(res, 200, 'warn("คีย์นี้ผูกกับ' + LBL + 'อื่นแล้ว")', 'text/plain'); }
        rec.ids = [name || uid]; if (uid) rec.hwid = uid;
        log('bind', k, 'ผูก ' + (name ? '@' + name : uid) + ' ครั้งแรก');
      }
    } else {
      const id = BIND === 'hwid' ? hwid : getIP(req);
      if (!id) return send(res, 200, 'warn("อ่านข้อมูลบัญชีไม่ได้")', 'text/plain');
      if (!rec.hwid) { rec.hwid = id; log('bind', k, 'ผูก ' + LBL + ' ' + id + ' ครั้งแรก'); }
      else if (rec.hwid !== id) { log('hwid', k, LBL + ' ' + id + ' ไม่ตรง ถูกปฏิเสธ'); return send(res, 200, 'warn("คีย์นี้ผูกกับ' + LBL + 'อื่นแล้ว")', 'text/plain'); }
    }
    // เริ่มนับเวลาตอนใช้งานสำเร็จครั้งแรก (คีย์ถาวรไม่ต้องนับ)
    if (!rec.perm && !rec.exp) { rec.exp = Date.now() + (rec.dur || 1) * 60000; log('start', k, 'เริ่มนับเวลา'); }
    rec.uses = (rec.uses || 0) + 1; rec.last = Date.now(); if (uid) rec.lastUid = uid; if (name) rec.lastName = name;
    log('use', k, 'โหลดสคริปต์' + (name ? ' (@' + name + ')' : ''));
    return send(res, 200, db.script, 'text/plain');
  }

  if (p.startsWith('/admin/api/')) {
    if (req.headers['x-admin'] !== ADMIN) return send(res, 401, { error: 'รหัสไม่ถูกต้อง' });

    if (p === '/admin/api/list') {
      const keys = Object.entries(db.keys).map(([k, v]) => ({ key: k, exp: v.exp || null, perm: !!v.perm, dur: v.dur || 0, created: v.created || 0, hwid: v.hwid || null, note: v.note || '', banned: !!v.banned, uses: v.uses || 0, last: v.last || 0, ids: v.ids || [], lastUid: v.lastUid || '', lastName: v.lastName || '' })).sort((a, b) => b.created - a.created);
      return send(res, 200, { keys, script: db.script, logs: db.logs, blacklist: db.blacklist, bind: BIND, webhook: !!WEBHOOK, sync });
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
      log('create', made[0], `สร้าง ${count} คีย์ (${perm ? 'ถาวร' : mins + ' นาที เริ่มนับเมื่อใช้งาน'})` + (ids.length ? ' ล็อกไอดี ' + ids.map(i => '@' + i).join(',') : ''));
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
      if (!add.length) return send(res, 200, { ok: false, error: 'ชื่อโรบอคไม่ถูกต้อง (a-z 0-9 _ ยาว 3-20 ตัว)' });
      r.ids = r.ids || [];
      // คีย์ที่ผูกไว้แล้วแต่ยังไม่มีรายการ (ข้อมูลเก่า) → เก็บไอดีเดิมเข้ารายการก่อน จะได้ไม่หลุด
      if (BIND === 'uid' && !r.ids.length && r.hwid) r.ids.push(r.hwid);
      for (const i of add) if (!r.ids.includes(i) && r.ids.length < 20) r.ids.push(i);
      save(); log('addid', b.key, 'เพิ่มไอดี ' + add.map(i => '@' + i).join(','));
      return send(res, 200, { ok: true });
    }
    if (p === '/admin/api/rmid') {
      const b = await readBody(req);
      const r = db.keys[b.key];
      if (r) { r.ids = (r.ids || []).filter(i => i !== String(b.id)); save(); log('addid', b.key, 'ลบไอดี @' + b.id); }
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
      if (b.remove) { const rid = cleanId(b.id) || String(b.id).trim(); db.blacklist = db.blacklist.filter(x => x.id !== rid && x.id !== String(b.id)); save(); log('block', 'BLACKLIST', 'ปลดแบนไอดี ' + b.id); return send(res, 200, { ok: true }); }
      const add = parseIds(b.id);
      if (!add.length) return send(res, 200, { ok: false, error: 'ชื่อโรบอคไม่ถูกต้อง (a-z 0-9 _ ยาว 3-20 ตัว)' });
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

    // นำเข้าไฟล์สำรอง (ไฟล์ที่ได้จากปุ่ม 💾 สำรอง) — คีย์ชื่อซ้ำจะถูกทับ
    if (p === '/admin/api/import') {
      const b = await readBody(req);
      const arr = Array.isArray(b.keys) ? b.keys : Object.entries(b.keys || {}).map(([key, v]) => ({ ...v, key }));
      let n = 0;
      for (const v of arr) {
        const key = String((v && v.key) || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
        if (!key) continue;
        db.keys[key] = {
          perm: !!v.perm, exp: Number(v.exp) || null, dur: Number(v.dur) || 0, created: Number(v.created) || Date.now(),
          hwid: v.hwid || null, note: String(v.note || '').slice(0, 60), banned: !!v.banned, uses: Number(v.uses) || 0, last: Number(v.last) || 0,
          ids: Array.isArray(v.ids) ? [...new Set(v.ids.map(cleanId).filter(Boolean))].slice(0, 20) : [],
          lastUid: v.lastUid || '', lastName: v.lastName || ''
        };
        n++;
      }
      if (Array.isArray(b.blacklist)) for (const x of b.blacklist) { const id = cleanId(x && x.id); if (id && !db.blacklist.some(y => y.id === id)) db.blacklist.push({ id, reason: String(x.reason || '').slice(0, 60), t: Number(x.t) || Date.now() }); }
      if (typeof b.script === 'string' && b.script) db.script = b.script;
      save(); log('create', 'IMPORT', 'นำเข้าข้อมูล ' + n + ' คีย์');
      return send(res, 200, { ok: true, n });
    }
    // สั่งซิงก์ขึ้น Gist ทันที
    if (p === '/admin/api/syncnow') {
      if (!sync.gist) return send(res, 200, { ok: false, error: 'ยังไม่ได้ตั้งค่า GITHUB_TOKEN / GIST_ID' });
      clearTimeout(timer); flush(); clearTimeout(pushTimer);
      const ok = await pushRemote();
      return send(res, 200, ok ? { ok: true } : { ok: false, error: 'ซิงก์ไม่สำเร็จ: ' + sync.err });
    }
  }
  send(res, 404, 'Not found', 'text/plain');
});

// ---------- เริ่มทำงาน: กู้ข้อมูลจาก Gist ถ้าไฟล์ในเครื่องหาย/เก่ากว่า ----------
(async () => {
  if (sync.gist && typeof fetch === 'function') {
    let r = { ok: false };
    for (let i = 0; i < 3 && !r.ok; i++) { r = await pullRemote(); if (!r.ok) await new Promise(x => setTimeout(x, 2000)); }
    const empty = !Object.keys(db.keys).length && !db.updated;
    if (!r.ok && empty) { console.log('ดึงข้อมูลสำรองไม่ได้ และเครื่องยังไม่มีข้อมูล หยุดเพื่อกันข้อมูลถูกเขียนทับ (Render จะรีสตาร์ทให้เอง)'); process.exit(1); }
    const rem = r.data;
    if (rem && ((rem.updated || 0) > db.updated || (empty && rem.keys && Object.keys(rem.keys).length))) {
      db = rem; norm(); writeLocal(); console.log('กู้ข้อมูลจาก Gist แล้ว: ' + Object.keys(db.keys).length + ' คีย์');
    }
  }
  server.listen(PORT, () => console.log('Running on port ' + PORT + ' | ไฟล์ข้อมูล: ' + DB + ' | Gist: ' + (sync.gist ? 'เปิด' : 'ปิด')));
})();
