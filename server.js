import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { openStore, hashPassword, checkPassword, tokenHash, validWindow } from './db.js';
import { buildTeamScorecard, validScorecardDate } from './scorecard.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, {recursive:true, mode:0o700});
fs.chmodSync(dataDir, 0o700);
const evidenceDir = path.join(dataDir, 'evidence');
fs.mkdirSync(evidenceDir, {recursive:true, mode:0o700});
const store = openStore(path.join(dataDir,'moonlight.sqlite'));
const {one,all,run,transaction,fail} = store;
const keyPath = path.join(dataDir,'secret.key');
if (!fs.existsSync(keyPath)) fs.writeFileSync(keyPath,randomBytes(32),{mode:0o600,flag:'wx'});
const key = fs.readFileSync(keyPath);
if (key.length!==32) throw new Error('The encryption key must be 32 bytes. Restore secret.key from backup.');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const jsonHeaders = {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const staticFiles = {'/':'index.html','/index.html':'index.html','/calendar':'index.html','/team-calendar':'index.html','/my-calendar':'index.html','/find-shifts':'index.html','/requests':'index.html','/time-evidence':'index.html','/team-scorecard':'index.html','/doctor-management':'index.html','/user-management':'index.html','/telegram-alerts':'index.html','/settings':'index.html','/help':'index.html','/styles.css':'styles.css','/app.js':'app.js'};
const loginAttempts=new Map();

function encrypt(value) {
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
  const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
}
function decrypt(value) {
  const bytes=Buffer.from(value,'base64');
  const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');
}
function setting(name) { return one('SELECT value FROM settings WHERE key=?',name)?.value || ''; }
function setSetting(name,value) { run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',name,value); }
function reply(res,status,data) {res.writeHead(status,jsonHeaders); res.end(JSON.stringify(data));}
function cookieValue(req) { return /(?:^|;\s*)moonlight_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1]; }
function currentUser(req) {
  const token=cookieValue(req); if (!token) return null;
  return one('SELECT u.id,u.name,u.email,u.account_type AS role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1',tokenHash(token),Date.now()) || null;
}
function requireUser(req) { const user=currentUser(req); if (!user) fail('Please sign in.',401); return user; }
function requireAdmin(req) { const user=requireUser(req); if (user.role!=='admin') fail('Admin access required.',403); return user; }
function validText(value,max,label) { const text=String(value||'').trim(); if (!text || text.length>max) fail(`${label} is required and must be ${max} characters or fewer.`); return text; }
function password(value) { if (typeof value!=='string' || value.length<10 || value.length>128) fail('Password must be 10 to 128 characters.'); return value; }
function email(value) { const text=String(value||'').trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) || text.length>180) fail('Enter a valid email address.'); return text; }
function numberId(value) { const id=Number(value); if (!Number.isSafeInteger(id)||id<1) fail('Choose a doctor.'); return id; }
function rateCents(value) { const text=String(value??'').trim();if(!/^\d{1,6}(?:\.\d{1,2})?$/.test(text))fail('Enter an hourly rate in pesos, up to two decimal places.');const cents=Math.round(Number(text)*100);if(cents<1||cents>10000000)fail('Hourly rate must be between ₱0.01 and ₱100,000.');return cents; }
function accountType(value) {if(!['admin','doctor','nurse','staff'].includes(value))fail('Choose admin, doctor, nurse, or staff.');return value;}
function manualTimes(input,shiftDate) {
  const format=/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;
  const start=String(input.clockIn||''),end=String(input.clockOut||'');
  if(!format.test(start)||!format.test(end)||!validWindow(start.slice(0,10),'00:00','23:59')||!validWindow(end.slice(0,10),'00:00','23:59'))fail('Enter valid start and end times.');
  if(start.slice(0,10)!==shiftDate)fail('The start time must be on the scheduled shift date (Asia/Manila).');
  const from=new Date(`${start}:00+08:00`),to=new Date(`${end}:00+08:00`);
  if(to<=from||to-from>36*3600000)fail('End time must be after start time and within 36 hours.');
  if(to.getTime()>Date.now()+5*60000)fail('You cannot submit future worked time.');
  return {from:from.toISOString(),to:to.toISOString()};
}
function assertOrigin(req) {
  const origin=req.headers.origin;
  if (origin && new URL(origin).host!==req.headers.host) fail('This request came from another site.',403);
}
async function body(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>30*1024*1024) fail('Upload is too large. Maximum request size is 30 MB.',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'); }
  catch { fail('Send valid JSON.'); }
}
function session(res,userId,clear=false) {
  const token=randomBytes(32).toString('hex');
  const secure=(process.env.COOKIE_SECURE==='1'?' Secure;':'');
  if (clear) res.setHeader('Set-Cookie',`moonlight_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0;${secure}`);
  else {
    run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',tokenHash(token),userId,Date.now()+7*86400000);
    res.setHeader('Set-Cookie',`moonlight_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800;${secure}`);
  }
}
function localRequest(req) {return ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);}
function monthRange(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value||'')) fail('Choose a valid month.');
  return [value+'-01',new Date(Date.UTC(Number(value.slice(0,4)),Number(value.slice(5,7)),1)).toISOString().slice(0,10)];
}
function state(user,month) {
  const [from,to]=monthRange(month);
  if(user.role==='admin') {
    const doctors=all('SELECT id,name,email,account_type AS role,active FROM users WHERE deleted_at IS NULL ORDER BY name');
    const availability=all('SELECT a.*,u.name AS doctor_name FROM availability a JOIN users u ON u.id=a.doctor_id WHERE u.deleted_at IS NULL AND a.date>=? AND a.date<? ORDER BY a.date,a.start_time',from,to);
    const bookings=all("SELECT b.*,d.name AS doctor_name,r.name AS requester_name FROM bookings b JOIN users d ON d.id=b.doctor_id JOIN users r ON r.id=b.requester_id WHERE b.date<? AND COALESCE(NULLIF(b.end_date,''),b.date)>=? ORDER BY b.date,b.start_time",to,from);
    const pendingCount=one("SELECT COUNT(*) AS count FROM bookings WHERE status='pending' AND approval_owner='admin'").count;
    return {user,doctors,availability,bookings,pendingCount,timezone:'Asia/Manila'};
  }
  const doctors=[{id:user.id,name:user.name,role:user.role,active:1}];
  const availability=all('SELECT a.*,u.name AS doctor_name FROM availability a JOIN users u ON u.id=a.doctor_id WHERE a.doctor_id=? AND a.date>=? AND a.date<? ORDER BY a.date,a.start_time',user.id,from,to);
  const bookings=all(`SELECT b.*,d.name AS doctor_name,r.name AS requester_name FROM bookings b
    JOIN users d ON d.id=b.doctor_id JOIN users r ON r.id=b.requester_id
    WHERE (b.requester_id=? OR (b.doctor_id=? AND b.status='approved')) AND b.date<? AND COALESCE(NULLIF(b.end_date,''),b.date)>=? ORDER BY b.date,b.start_time`,user.id,user.id,to,from)
    .map(b=>b.requester_id===user.id?b:{id:b.id,doctor_id:b.doctor_id,doctor_name:b.doctor_name,date:b.date,end_date:b.end_date,start_time:b.start_time,end_time:b.end_time,status:b.status,requester_id:null,requester_name:null,note:''});
  return {user,doctors,availability,bookings,timezone:'Asia/Manila'};
}
function openTimes(month) {
  const [from,to]=monthRange(month);
  const slots=all(`SELECT a.id AS availability_id,a.doctor_id,u.name AS doctor_name,a.date,a.start_time,a.end_time,a.location,a.rate_cents
    FROM availability a JOIN users u ON u.id=a.doctor_id AND u.active=1 AND u.account_type IN ('doctor','admin')
    WHERE a.date>=? AND a.date<? ORDER BY a.date,a.start_time,u.name`,from,to);
  const approved=all("SELECT doctor_id,date,start_time,end_time FROM bookings WHERE status='approved' AND date>=? AND date<? ORDER BY start_time",from,to);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return slots.filter(s=>s.date>=today).flatMap(slot=>{
    let parts=[[slot.start_time,slot.end_time]];
    for(const booking of approved.filter(b=>b.doctor_id===slot.doctor_id&&b.date===slot.date)) {
      parts=parts.flatMap(([start,end])=>{
        if(booking.end_time<=start||booking.start_time>=end)return [[start,end]];
        const remaining=[];
        if(start<booking.start_time)remaining.push([start,booking.start_time]);
        if(booking.end_time<end)remaining.push([booking.end_time,end]);
        return remaining;
      });
    }
    return parts.map(([start_time,end_time])=>({...slot,start_time,end_time}));
  });
}
function relieverPosts(month) {
  const [from,to]=monthRange(month);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    return all(`SELECT p.id,p.created_by,p.date,p.start_time,p.end_time,p.location,p.rate_cents,p.required_questions,p.created_at,u.name AS posted_by_name
    FROM reliever_posts p JOIN users u ON u.id=p.created_by AND u.active=1 AND u.deleted_at IS NULL
    WHERE p.active=1 AND p.date>=? AND p.date<? AND p.date>=?
    AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.reliever_post_id=p.id)
    ORDER BY p.date,p.start_time,p.id`,from,to,today);
}
function saveEvidence(input,kind) {
  if (!input || typeof input.data!=='string' || typeof input.mime!=='string') fail(`${kind} is required.`);
  const photoMimes=['image/jpeg','image/png','image/webp'];
  const documentMimes=[...photoMimes,'application/pdf'];
  const allowed=kind==='photo'?photoMimes:documentMimes;
  if (!allowed.includes(input.mime)) fail(`${kind} must be a JPG, PNG, WebP${kind==='document'?' or PDF':''} file.`);
  const bytes=Buffer.from(input.data,'base64');
  if (!bytes.length || bytes.length>(kind==='photo'?6:8)*1024*1024) fail(`${kind} exceeds the size limit.`);
  const valid= input.mime==='application/pdf'? bytes.subarray(0,5).toString()==='%PDF-' :
    input.mime==='image/png'? bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) :
    input.mime==='image/jpeg'? bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')) :
    bytes.subarray(0,4).toString()==='RIFF' && bytes.subarray(8,12).toString()==='WEBP';
  if (!valid) fail(`${kind} file content does not match its type.`);
  const name=randomBytes(18).toString('hex');
  fs.writeFileSync(path.join(evidenceDir,name),bytes,{mode:0o600,flag:'wx'});
  return name;
}
function removeEvidence(name) {if(name) {try {fs.unlinkSync(path.join(evidenceDir,name));}catch{}}}
function attendanceFor(user) {
  const rows=all(`SELECT a.*,b.date,b.end_date,b.start_time,b.end_time,b.status,b.doctor_id,b.requester_id,b.reliever_post_id,d.name AS doctor_name,r.name AS requester_name
    FROM attendance a JOIN bookings b ON b.id=a.booking_id JOIN users d ON d.id=b.doctor_id JOIN users r ON r.id=b.requester_id
    ${user.role==='admin'?'':'WHERE b.requester_id=?'} ORDER BY a.clock_in_at DESC LIMIT 200`,...(user.role==='admin'?[]:[user.id]));
  return rows.map(({clock_in_photo,clock_out_photo,document_file,...rest})=>({...rest,has_clock_in_photo:!!clock_in_photo,has_clock_out_photo:!!clock_out_photo,has_document:!!document_file}));
}
function doctorSummaries() {
  return all(`SELECT u.id,u.name,u.email,u.account_type AS role,u.active,
    (SELECT COUNT(*) FROM bookings b WHERE b.requester_id=u.id AND b.status='pending') AS pending_count,
    (SELECT COUNT(*) FROM bookings b WHERE b.requester_id=u.id AND b.status='approved') AS assigned_count,
    COALESCE((SELECT SUM((CAST(substr(b.end_time,1,2) AS INTEGER)*60+CAST(substr(b.end_time,4,2) AS INTEGER))-(CAST(substr(b.start_time,1,2) AS INTEGER)*60+CAST(substr(b.start_time,4,2) AS INTEGER))) FROM bookings b WHERE b.requester_id=u.id AND b.status='approved'),0) AS assigned_minutes,
    COALESCE((SELECT SUM((julianday(a.clock_out_at)-julianday(a.clock_in_at))*1440) FROM attendance a JOIN bookings b ON b.id=a.booking_id WHERE b.requester_id=u.id AND a.clock_out_at IS NOT NULL),0) AS completed_minutes
    FROM users u WHERE u.account_type='doctor' AND u.deleted_at IS NULL ORDER BY u.name`);
}
async function telegram(method,payload,overrideToken) {
  const encrypted=setting('telegram_token');
  const token=overrideToken|| (encrypted?decrypt(encrypted):'');
  if (!token) fail('Add a Telegram bot token in Settings first.',409);
  try {
    const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)
    });
    const result=await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description||'Telegram rejected the request.');
    return result.result;
  } catch(error) {
    const detail=error.name==='TimeoutError'?'Telegram timed out.':error.message;
    fail(`Telegram could not complete the request: ${detail}`,502);
  }
}
async function notifyRequest(id) {
  const chatId=setting('telegram_chat_id');
  if (!chatId || !setting('telegram_token')) return 'not_configured';
  const b=one('SELECT b.*,d.name AS doctor_name,r.name AS requester_name FROM bookings b JOIN users d ON d.id=b.doctor_id JOIN users r ON r.id=b.requester_id WHERE b.id=?',id);
  try {
    let answers=[];try{answers=JSON.parse(b.reliever_answers||'[]')}catch{}
    const responses=answers.map(x=>`${x.question}: ${x.answer}`).join('\n').slice(0,2800);
    await telegram('sendMessage',{chat_id:chatId,text:b.reliever_post_id?`New Reliever post request #${id}\n${b.requester_name}\n${b.date}, ${b.start_time}–${b.end_time} (Asia/Manila)\n${b.location}${responses?`\n\nRequired skill responses:\n${responses}`:''}\nOpen Moonlight Calendar to approve or decline.`:`New moonlighting request #${id}\n${b.requester_name} → ${b.doctor_name}\n${b.date}, ${b.start_time}–${b.end_time} (Asia/Manila)\nOpen Moonlight Calendar to approve or decline.`});
    run("UPDATE bookings SET notification_state='sent' WHERE id=?",id); return 'sent';
  } catch {run("UPDATE bookings SET notification_state='failed' WHERE id=?",id); return 'failed';}
}

async function api(req,res,url) {
  const method=req.method, route=url.pathname;
  if (method==='GET' && route==='/api/bootstrap') return reply(res,200,{needsSetup:one('SELECT COUNT(*) AS n FROM users').n===0,local:localRequest(req)});
  if (method==='POST' && route==='/api/setup') {
    if (!localRequest(req)) fail('Initial setup is available only from this computer.',403);
    const input=await body(req),name=validText(input.name,80,'Name'),mail=email(input.email),pass=password(input.password);
    const id=transaction(()=>{if(one('SELECT COUNT(*) AS n FROM users').n) fail('Setup is already complete.',409); return Number(run("INSERT INTO users(name,email,password_hash,role,account_type) VALUES(?,?,?,'admin','admin')",name,mail,hashPassword(pass)).lastInsertRowid);});
    session(res,id); return reply(res,201,{ok:true});
  }
  if (method==='POST' && route==='/api/login') {
    const input=await body(req),mail=email(input.email);
    if(loginAttempts.size>1000){for(const [key,value] of loginAttempts)if(value.until<Date.now())loginAttempts.delete(key);if(loginAttempts.size>1000)loginAttempts.clear();}
    const attemptKey=`${req.socket.remoteAddress}:${mail}`,attempt=loginAttempts.get(attemptKey);
    if(attempt && attempt.count>=5 && attempt.until>Date.now()) fail('Too many sign-in attempts. Wait 15 minutes and try again.',429);
    const user=one('SELECT * FROM users WHERE email=? AND active=1',mail);
    if (!user || !checkPassword(String(input.password||''),user.password_hash)) {
      loginAttempts.set(attemptKey,{count:(attempt?.until>Date.now()?attempt.count:0)+1,until:Date.now()+15*60000});
      fail('Email or password is incorrect.',401);
    }
    loginAttempts.delete(attemptKey);
    session(res,user.id); return reply(res,200,{ok:true});
  }
  if (method==='POST' && route==='/api/logout') {
    const token=cookieValue(req); if(token) run('DELETE FROM sessions WHERE token_hash=?',tokenHash(token));
    session(res,0,true); return reply(res,200,{ok:true});
  }
  if (method==='GET' && route==='/api/me') return reply(res,200,{user:requireUser(req)});
  if (method==='PATCH' && route==='/api/me') {
    const user=requireUser(req),input=await body(req);
    const newName=input.name?validText(input.name,80,'Name'):null;
    const newHash=input.newPassword?hashPassword(password(input.newPassword)):null;
    if(input.newPassword){
      const current=one('SELECT password_hash FROM users WHERE id=?',user.id);
      if(!checkPassword(String(input.currentPassword||''),current.password_hash)) fail('Current password is incorrect.',403);
    }
    transaction(()=>{
      if(newName)run('UPDATE users SET name=? WHERE id=?',newName,user.id);
      if(newHash){run('UPDATE users SET password_hash=? WHERE id=?',newHash,user.id);run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?',user.id,tokenHash(cookieValue(req)));}
    });
    return reply(res,200,{user:currentUser(req)});
  }
  if (method==='GET' && route==='/api/state') return reply(res,200,state(requireUser(req),url.searchParams.get('month')));
  if (method==='GET' && route==='/api/open-times') {requireUser(req);return reply(res,200,{openTimes:openTimes(url.searchParams.get('month'))});}
  if (method==='GET' && route==='/api/reliever-posts') {
    const user=requireUser(req);if(!['admin','doctor'].includes(user.role))fail('Reliever posts are available to doctors only.',403);
    return reply(res,200,{posts:relieverPosts(url.searchParams.get('month'))});
  }
  if (method==='GET' && route==='/api/bookings') {
    const user=requireUser(req),admin=user.role==='admin';
    const bookings=all(`SELECT b.*,d.name AS doctor_name,r.name AS requester_name
      FROM bookings b JOIN users d ON d.id=b.doctor_id JOIN users r ON r.id=b.requester_id ${admin?'':'WHERE b.requester_id=?'} ORDER BY CASE WHEN b.status='pending' THEN 0 ELSE 1 END,b.created_at DESC,b.id DESC LIMIT 500`,...(admin?[]:[user.id]));
    return reply(res,200,{bookings});
  }
  if (method==='GET' && route==='/api/attendance') return reply(res,200,{attendance:attendanceFor(requireUser(req))});
  if (method==='GET' && route==='/api/users') {requireAdmin(req);return reply(res,200,{users:all('SELECT id,name,email,account_type AS role,active,created_at FROM users WHERE deleted_at IS NULL ORDER BY name')});}
  if (method==='GET' && route==='/api/team-scorecard') {
    requireAdmin(req);
    const from=url.searchParams.get('from'),to=url.searchParams.get('to');
    if(!validScorecardDate(from)||!validScorecardDate(to)||from>to)fail('Choose a valid scorecard date range.',400);
    const users=all(`SELECT u.id,u.name,u.email,u.account_type AS role,u.active,u.deleted_at FROM users u
      WHERE (u.deleted_at IS NULL OR EXISTS
      (SELECT 1 FROM bookings b WHERE b.requester_id=u.id AND b.date>=? AND b.date<=? AND b.status IN ('pending','approved'))) ORDER BY u.name`,from,to);
    const bookings=all(`SELECT b.*,a.clock_in_at,a.clock_out_at,a.entry_source,
      a.clock_in_photo IS NOT NULL AS has_clock_in_photo,a.clock_out_photo IS NOT NULL AS has_clock_out_photo,
      a.document_file IS NOT NULL AS has_document
      FROM bookings b LEFT JOIN attendance a ON a.booking_id=b.id
      WHERE b.date>=? AND b.date<=? AND b.status IN ('pending','approved') ORDER BY b.date DESC,b.start_time DESC`,from,to);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    return reply(res,200,buildTeamScorecard(users,bookings,from,to,today));
  }
  if (method==='GET' && route==='/api/doctors/summary') {requireAdmin(req);return reply(res,200,{doctors:doctorSummaries()});}
  const doctorDetailsMatch=/^\/api\/doctors\/(\d+)\/details$/.exec(route);
  if (doctorDetailsMatch && method==='GET') {
    requireAdmin(req);const id=Number(doctorDetailsMatch[1]);
    const doctor=doctorSummaries().find(d=>d.id===id);if(!doctor) fail('Doctor not found.',404);
    const bookings=all(`SELECT b.id,b.date,b.start_time,b.end_time,b.status,b.note,b.rate_cents,b.created_at,b.decided_at,d.name AS doctor_name
      FROM bookings b JOIN users d ON d.id=b.doctor_id WHERE b.requester_id=? ORDER BY b.date DESC,b.start_time DESC LIMIT 100`,id);
    const attendance=all(`SELECT a.booking_id,a.clock_in_at,a.clock_out_at,a.document_name,
      a.clock_out_photo IS NOT NULL AS has_clock_out_photo,a.document_file IS NOT NULL AS has_document,
      b.date,b.start_time,b.end_time,d.name AS doctor_name
      FROM attendance a JOIN bookings b ON b.id=a.booking_id JOIN users d ON d.id=b.doctor_id
      WHERE b.requester_id=? ORDER BY a.clock_in_at DESC LIMIT 100`,id);
    return reply(res,200,{doctor,bookings,attendance});
  }
  if (method==='POST' && (route==='/api/doctors'||route==='/api/users')) {
    requireAdmin(req); const input=await body(req),name=validText(input.name,80,'Name'),mail=email(input.email),pass=password(input.password),kind=accountType(input.accountType||'doctor');
    try {const id=Number(run('INSERT INTO users(name,email,password_hash,role,account_type) VALUES(?,?,?,?,?)',name,mail,hashPassword(pass),kind==='admin'?'admin':'doctor',kind).lastInsertRowid); return reply(res,201,{id});}
    catch(e){if(e.code?.startsWith('SQLITE_CONSTRAINT')) fail('That email is already in use.',409);throw e;}
  }
  const userMatch=/^\/api\/users\/(\d+)$/.exec(route);
  if (userMatch && method==='PATCH') {
    const admin=requireAdmin(req),id=Number(userMatch[1]),input=await body(req);
    const target=one('SELECT * FROM users WHERE id=? AND deleted_at IS NULL',id);if(!target)fail('User not found.',404);
    if(input.active===false&&id===admin.id)fail('You cannot deactivate your own admin account.',409);
    const name=input.name?validText(input.name,80,'Name'):null,hash=input.password?hashPassword(password(input.password)):null;
    transaction(()=>{if(name)run('UPDATE users SET name=? WHERE id=?',name,id);if(hash)run('UPDATE users SET password_hash=? WHERE id=?',hash,id);if(typeof input.active==='boolean')run('UPDATE users SET active=? WHERE id=?',input.active?1:0,id);if(hash||input.active===false)run('DELETE FROM sessions WHERE user_id=?',id);});
    return reply(res,200,{ok:true});
  }
  if (userMatch && method==='DELETE') {
    const admin=requireAdmin(req),id=Number(userMatch[1]);
    transaction(()=>{
      const target=one('SELECT id,active FROM users WHERE id=? AND deleted_at IS NULL',id);
      if(!target)fail('User not found.',404);
      if(id===admin.id)fail('You cannot delete your own admin account.',409);
      if(target.active)fail('Deactivate this user before deleting them.',409);
      const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      if(one("SELECT id FROM bookings WHERE (requester_id=? OR doctor_id=?) AND (status='pending' OR (status='approved' AND date>=?)) LIMIT 1",id,id,today))fail('Resolve this user’s pending requests and current or future booked shifts before deleting them.',409);
      run('UPDATE users SET active=0,deleted_at=CURRENT_TIMESTAMP,name=?,email=?,password_hash=? WHERE id=?',`Deleted user #${id}`,`deleted-user-${id}@example.invalid`,'',id);
      run('DELETE FROM sessions WHERE user_id=?',id);
    });
    return reply(res,200,{ok:true});
  }
  const doctorMatch=/^\/api\/doctors\/(\d+)$/.exec(route);
  if (doctorMatch && method==='PATCH') {
    requireAdmin(req);const id=Number(doctorMatch[1]),input=await body(req);
    const doctor=one("SELECT * FROM users WHERE id=? AND role='doctor' AND deleted_at IS NULL",id);if(!doctor) fail('Doctor not found.',404);
    if(typeof input.active==='boolean') run('UPDATE users SET active=? WHERE id=?',input.active?1:0,id);
    if(input.password) run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(password(input.password)),id);
    if(input.password || input.active===false) run('DELETE FROM sessions WHERE user_id=?',id);
    if(input.name) run('UPDATE users SET name=? WHERE id=?',validText(input.name,80,'Name'),id);
    return reply(res,200,{ok:true});
  }
  if (method==='POST' && route==='/api/availability') {
    const user=requireUser(req),input=await body(req),doctorId=numberId(input.doctorId);
    if(user.role!=='admin'&&(user.role!=='doctor'||doctorId!==user.id))fail('You can add open time only to your own doctor calendar.',403);
    const id=store.addAvailability({doctorId,date:input.date,start:input.start,end:input.end,location:String(input.location||''),rateCents:rateCents(input.hourlyRate)});
    return reply(res,201,{id});
  }
  if(method==='POST'&&route==='/api/reliever-posts'){
    const user=requireUser(req);if(!['admin','doctor'].includes(user.role))fail('Only doctors can publish Reliever posts.',403);
    const input=await body(req);let requiredQuestions=input.requiredQuestions;if(typeof requiredQuestions==='string'){try{requiredQuestions=JSON.parse(requiredQuestions)}catch{fail('Enter valid required skill questions.')}}
    const id=store.addRelieverPost({createdBy:user.id,date:input.date,start:input.start,end:input.end,location:String(input.location||''),rateCents:rateCents(input.hourlyRate),requiredQuestions});
    return reply(res,201,{id});
  }
  const relieverPostMatch=/^\/api\/reliever-posts\/(\d+)$/.exec(route);
  if(relieverPostMatch&&method==='DELETE'){
    const user=requireUser(req);if(!['admin','doctor'].includes(user.role))fail('Reliever posts are available to doctors only.',403);
    store.removeRelieverPost(Number(relieverPostMatch[1]),user);return reply(res,200,{ok:true});
  }
  const relieverRequestMatch=/^\/api\/reliever-posts\/(\d+)\/request$/.exec(route);
  if(relieverRequestMatch&&method==='POST'){
    const user=requireUser(req);if(!['admin','doctor'].includes(user.role))fail('Only doctors can request Reliever posts.',403);
    const input=await body(req),id=store.requestRelieverPost({postId:Number(relieverRequestMatch[1]),requesterId:user.id,note:String(input.note||''),answers:input.answers});
    return reply(res,201,{id,notification:await notifyRequest(id)});
  }
  const availabilityMatch=/^\/api\/availability\/(\d+)$/.exec(route);
  if (availabilityMatch && method==='PATCH') {
    const user=requireUser(req),id=Number(availabilityMatch[1]),input=await body(req);
    const slot=one('SELECT id,doctor_id FROM availability WHERE id=?',id);if(!slot)fail('Open time not found.',404);
    if(user.role!=='admin'&&(user.role!=='doctor'||slot.doctor_id!==user.id))fail('You can edit only your own open time.',403);
    run('UPDATE availability SET rate_cents=? WHERE id=?',rateCents(input.hourlyRate),id);
    return reply(res,200,{ok:true});
  }
  if (availabilityMatch && method==='DELETE') {
    const user=requireUser(req),id=Number(availabilityMatch[1]),slot=one('SELECT * FROM availability WHERE id=?',id);if(!slot) fail('Open time not found.',404);
    if(user.role!=='admin'&&(user.role!=='doctor'||slot.doctor_id!==user.id))fail('You can remove only your own open time.',403);
    transaction(()=>{
      run('DELETE FROM availability WHERE id=?',id);
      run("UPDATE bookings SET status='declined',decided_at=CURRENT_TIMESTAMP WHERE doctor_id=? AND date=? AND status='pending' AND approval_owner='admin' AND start_time>=? AND end_time<=?",slot.doctor_id,slot.date,slot.start_time,slot.end_time);
    });
    return reply(res,200,{ok:true});
  }
  if (method==='POST' && route==='/api/bookings') {
    const user=requireUser(req),input=await body(req);
    const id=store.requestBooking({doctorId:numberId(input.doctorId),requesterId:user.id,date:input.date,start:input.start,end:input.end,note:String(input.note||'')});
    const notification=await notifyRequest(id);return reply(res,201,{id,notification});
  }
  if (method==='POST' && route==='/api/my-shifts') {
    const user=requireUser(req),input=await body(req);
    const id=store.addPersonalShift({userId:user.id,date:input.startDate||input.date,endDate:input.endDate||input.startDate||input.date,start:input.startTime||input.start,end:input.endTime||input.end,note:String(input.note||''),location:String(input.location||''),rateCents:rateCents(input.hourlyRate)});
    return reply(res,201,{id});
  }
  const personalShiftMatch=/^\/api\/my-shifts\/(\d+)$/.exec(route);
  if (personalShiftMatch && method==='PATCH') {
    const user=requireUser(req),input=await body(req),bookingId=Number(personalShiftMatch[1]);
    if(!Number.isSafeInteger(bookingId)||bookingId<1)fail('Choose a valid shift.');
    store.updatePersonalShift({bookingId,userId:user.id,date:input.startDate||input.date,endDate:input.endDate||input.startDate||input.date,start:input.startTime||input.start,end:input.endTime||input.end,note:String(input.note||''),location:String(input.location||''),rateCents:rateCents(input.hourlyRate)});
    return reply(res,200,{ok:true});
  }
  if (method==='POST' && route==='/api/admin-bookings') {
    requireAdmin(req);const input=await body(req);
    const requesterId=numberId(input.requesterId);
    if(input.doctorId!==undefined&&numberId(input.doctorId)!==requesterId)fail('The booking calendar must be the assigned team member’s calendar. Select only the team member.',400);
    const id=store.assignBooking({requesterId,date:input.startDate||input.date,endDate:input.endDate||input.startDate||input.date,start:input.startTime||input.start,end:input.endTime||input.end,note:String(input.note||''),location:String(input.location||''),rateCents:rateCents(input.hourlyRate)});
    return reply(res,201,{id});
  }
  const decisionMatch=/^\/api\/bookings\/(\d+)\/decision$/.exec(route);
  if (decisionMatch && method==='POST') {
    const user=requireUser(req),input=await body(req);store.decideBooking(Number(decisionMatch[1]),input.status,user);
    return reply(res,200,{ok:true});
  }
  const bookingRateMatch=/^\/api\/bookings\/(\d+)\/rate$/.exec(route);
  if(bookingRateMatch && method==='PATCH') {
    requireAdmin(req);const id=Number(bookingRateMatch[1]),input=await body(req);
    const updated=run('UPDATE bookings SET rate_cents=? WHERE id=?',rateCents(input.hourlyRate),id);
    if(updated.changes!==1)fail('Booking not found.',404);
    return reply(res,200,{ok:true});
  }
  const cancelMatch=/^\/api\/bookings\/(\d+)\/cancel$/.exec(route);
  if (cancelMatch && method==='POST') {store.cancelBooking(Number(cancelMatch[1]),requireUser(req));return reply(res,200,{ok:true});}
  const manualMatch=/^\/api\/bookings\/(\d+)\/time-entry$/.exec(route);
  if(manualMatch && method==='POST') {
    const user=requireUser(req),id=Number(manualMatch[1]),input=await body(req);
    const booking=one("SELECT date FROM bookings WHERE id=? AND requester_id=? AND status='approved'",id,user.id);
    if(!booking)fail('Approved shift not found for your account.',403);
    const {from,to}=manualTimes(input,booking.date),note=String(input.note||'').trim();
    if(note.length>500)fail('Evidence note must be 500 characters or fewer.');
    if(one('SELECT booking_id FROM attendance WHERE booking_id=?',id))fail('This shift already has a time record.',409);
    const uploaded=[];
    try {
      const photo=saveEvidence(input.photo,'photo');uploaded.push(photo);
      const outPhoto=input.outPhoto?saveEvidence(input.outPhoto,'photo'):null;if(outPhoto)uploaded.push(outPhoto);
      const document=input.document?saveEvidence(input.document,'document'):null;if(document)uploaded.push(document);
      transaction(()=>{
        if(one('SELECT booking_id FROM attendance WHERE booking_id=?',id))fail('This shift already has a time record.',409);
        if(!one("SELECT id FROM bookings WHERE id=? AND requester_id=? AND status='approved'",id,user.id))fail('Approved shift not found for your account.',403);
        run("INSERT INTO attendance(booking_id,clock_in_at,clock_out_at,clock_in_photo,clock_out_photo,document_file,document_name,document_mime,entry_source,evidence_note) VALUES(?,?,?,?,?,?,?,?,?,?)",id,from,to,photo,outPhoto,document,document?String(input.document.name||'Supporting document').slice(0,120):null,document?input.document.mime:null,'manual',note);
      });
    } catch(error) {for(const file of uploaded)removeEvidence(file);throw error;}
    return reply(res,201,{ok:true});
  }
  const clockMatch=/^\/api\/bookings\/(\d+)\/(clock-in|clock-out)$/.exec(route);
  if (clockMatch && method==='POST') {
    const user=requireUser(req),id=Number(clockMatch[1]),action=clockMatch[2],input=await body(req);
    const booking=one('SELECT * FROM bookings WHERE id=?',id);
    if(!booking || booking.requester_id!==user.id || booking.status!=='approved') fail('Approved shift not found for your account.',403);
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if(action==='clock-in' && booking.date!==today) fail('You can clock in only on the shift date (Asia/Manila).',409);
    const photo=saveEvidence(input.photo,'photo');let document,oldDocument;
    try {
      if(input.document) document=saveEvidence(input.document,'document');
      transaction(()=>{
        const current=one('SELECT * FROM attendance WHERE booking_id=?',id);
        if(action==='clock-in') {
          if(current) fail('You already clocked in for this shift.',409);
          run('INSERT INTO attendance(booking_id,clock_in_at,clock_in_photo,document_file,document_name,document_mime) VALUES(?,?,?,?,?,?)',id,new Date().toISOString(),photo,document||null,document?String(input.document.name||'Supporting document').slice(0,120):null,document?input.document.mime:null);
        } else {
          if(!current || current.clock_out_at) fail('Clock in first, or this shift is already complete.',409);
          oldDocument=current.document_file;
          run('UPDATE attendance SET clock_out_at=?,clock_out_photo=?,document_file=COALESCE(?,document_file),document_name=COALESCE(?,document_name),document_mime=COALESCE(?,document_mime) WHERE booking_id=?',new Date().toISOString(),photo,document||null,document?String(input.document.name||'Supporting document').slice(0,120):null,document?input.document.mime:null,id);
        }
      });
    } catch(e) {removeEvidence(photo);removeEvidence(document);throw e;}
    if(document && oldDocument)removeEvidence(oldDocument);
    return reply(res,200,{ok:true});
  }
  const evidenceMatch=/^\/api\/evidence\/(\d+)\/(in|out|document)$/.exec(route);
  if(evidenceMatch && method==='GET') {
    const user=requireUser(req),id=Number(evidenceMatch[1]),kind=evidenceMatch[2];
    const record=one('SELECT a.*,b.requester_id FROM attendance a JOIN bookings b ON b.id=a.booking_id WHERE a.booking_id=?',id);
    if(!record || (user.role!=='admin'&&record.requester_id!==user.id)) fail('Evidence not found.',404);
    const name=record[kind==='in'?'clock_in_photo':kind==='out'?'clock_out_photo':'document_file'];
    if(!name) fail('Evidence not found.',404);
    const bytes=fs.readFileSync(path.join(evidenceDir,name));
    const mime=kind==='document'?record.document_mime:bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))?'image/png':bytes.subarray(0,4).toString()==='RIFF'?'image/webp':'image/jpeg';
    res.writeHead(200,{'Content-Type':mime,'Content-Disposition':`${kind==='document'?'attachment':'inline'}; filename="${kind==='document'?'document':kind+'-photo'}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return;
  }
  if (method==='GET' && route==='/api/telegram') {requireAdmin(req);return reply(res,200,{configured:!!setting('telegram_token'),chatId:setting('telegram_chat_id')});}
  if (method==='PUT' && route==='/api/telegram') {
    requireAdmin(req);const input=await body(req),chatId=String(input.chatId||'').trim();
    if(chatId && !/^-?\d{5,20}$/.test(chatId)) fail('Chat ID must be a numeric Telegram chat ID.');
    if(input.token) {
      const token=String(input.token).trim();if(!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token)) fail('Bot token format looks incorrect.');
      setSetting('telegram_token',encrypt(token));
    }
    setSetting('telegram_chat_id',chatId);return reply(res,200,{configured:!!setting('telegram_token'),chatId});
  }
  if (method==='POST' && route==='/api/telegram/test') {
    requireAdmin(req);const chatId=setting('telegram_chat_id');if(!chatId) fail('Add a chat ID first.',409);
    await telegram('sendMessage',{chat_id:chatId,text:'Moonlight Calendar is connected. New shift requests will appear here.'});return reply(res,200,{ok:true});
  }
  if (method==='GET' && route==='/api/telegram/chats') {
    requireAdmin(req);const updates=await telegram('getUpdates',{limit:100,timeout:0});
    const chats=[...new Map(updates.map(u=>u.message?.chat).filter(Boolean).map(c=>[String(c.id),{id:String(c.id),name:c.title||[c.first_name,c.last_name].filter(Boolean).join(' ')||'Chat'}])).values()];
    return reply(res,200,{chats});
  }
  reply(res,404,{error:'Page not found.'});
}

export const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(req.method!=='GET' && req.method!=='HEAD') assertOrigin(req);
    if(url.pathname.startsWith('/api/')) return await api(req,res,url);
    const file=staticFiles[url.pathname];
    if(!file || !['GET','HEAD'].includes(req.method)) return reply(res,404,{error:'Page not found.'});
    const content=fs.readFileSync(path.join(root,'public',file));
    res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(req.method==='HEAD'?undefined:content);
  } catch(error) {
    if(!res.headersSent) reply(res,error.status||500,{error:error.status?error.message:'Something went wrong on the server. Please retry.'});
    if(!error.status) console.error(JSON.stringify({event:'request_error',path:req.url,message:error.message}));
  }
});
if (process.env.NODE_ENV!=='test') server.listen(port,host,()=>console.log(`Moonlight Calendar: http://${host}:${port}`));
