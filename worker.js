import { buildTeamScorecard, validScorecardDate } from './scorecard.js';

const encoder=new TextEncoder();
const jsonHeaders={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const dateRe=/^\d{4}-\d{2}-\d{2}$/;
const timeRe=/^(?:[01]\d|2[0-3]):[0-5]\d$/;

function problem(message,status=400){const error=new Error(message);error.status=status;throw error;}
function result(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{...jsonHeaders,...headers}});}
function one(env,sql,...args){return env.DB.prepare(sql).bind(...args).first();}
async function all(env,sql,...args){return (await env.DB.prepare(sql).bind(...args).all()).results;}
function run(env,sql,...args){return env.DB.prepare(sql).bind(...args).run();}
function text(value,max,label){const parsed=String(value??'').trim();if(!parsed||parsed.length>max)problem(`${label} is required and must be ${max} characters or fewer.`);return parsed;}
function email(value){const parsed=String(value??'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(parsed)||parsed.length>180)problem('Enter a valid email address.');return parsed;}
function password(value){if(typeof value!=='string'||value.length<10||value.length>128)problem('Password must be 10 to 128 characters.');return value;}
function id(value){const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<1)problem('Choose a valid user.');return parsed;}
function role(value){if(!['admin','doctor','nurse','staff'].includes(value))problem('Choose admin, doctor, nurse, or staff.');return value;}
function rate(value){const parsed=String(value??'').trim();if(!/^\d{1,6}(?:\.\d{1,2})?$/.test(parsed))problem('Enter an hourly rate in pesos, up to two decimal places.');const cents=Math.round(Number(parsed)*100);if(cents<1||cents>10000000)problem('Hourly rate must be between ₱0.01 and ₱100,000.');return cents;}
function validWindow(date,start,end,endDate=date){if(!dateRe.test(date||'')||!dateRe.test(endDate||'')||!timeRe.test(start||'')||!timeRe.test(end||''))return false;const from=Date.parse(`${date}T${start}:00Z`),to=Date.parse(`${endDate}T${end}:00Z`);return Number.isFinite(from)&&Number.isFinite(to)&&to>from&&to-from<=36*3600000&&new Date(from).toISOString().slice(0,10)===date&&new Date(to).toISOString().slice(0,10)===endDate;}
function monthRange(month){if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||''))problem('Choose a valid month.');return [month+'-01',new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),1)).toISOString().slice(0,10)];}
function manilaToday(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function randomHex(count){return [...crypto.getRandomValues(new Uint8Array(count))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function bytesToB64(bytes){let output='';for(const byte of bytes)output+=String.fromCharCode(byte);return btoa(output);}
function b64ToBytes(value){return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
async function digest(value){const bytes=await crypto.subtle.digest('SHA-256',encoder.encode(value));return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');}
async function hashPassword(value){const salt=crypto.getRandomValues(new Uint8Array(16)),key=await crypto.subtle.importKey('raw',encoder.encode(value),'PBKDF2',false,['deriveBits']);const hash=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:210000,hash:'SHA-256'},key,256));return `pbkdf2$210000$${bytesToB64(salt)}$${bytesToB64(hash)}`;}
async function checkPassword(value,stored){if(!stored)return false;const [kind,count,saltText,expectedText]=stored.split('$');if(kind!=='pbkdf2'||!count||!saltText||!expectedText)return false;const salt=b64ToBytes(saltText),expected=b64ToBytes(expectedText),key=await crypto.subtle.importKey('raw',encoder.encode(value),'PBKDF2',false,['deriveBits']);const actual=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:Number(count),hash:'SHA-256'},key,expected.length*8));let difference=expected.length^actual.length;for(let i=0;i<expected.length;i++)difference|=expected[i]^actual[i];return difference===0;}
async function encryptionKey(env){if(!env.TOKEN_ENCRYPTION_KEY)problem('TOKEN_ENCRYPTION_KEY secret is not configured.',503);let bytes;try{bytes=b64ToBytes(env.TOKEN_ENCRYPTION_KEY)}catch{problem('TOKEN_ENCRYPTION_KEY must be base64.',503)}if(bytes.length!==32)problem('TOKEN_ENCRYPTION_KEY must contain 32 bytes.',503);return crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']);}
async function encrypt(env,value){const iv=crypto.getRandomValues(new Uint8Array(12)),key=await encryptionKey(env),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(value)));const packed=new Uint8Array(iv.length+cipher.length);packed.set(iv);packed.set(cipher,iv.length);return bytesToB64(packed);}
async function decrypt(env,value){const bytes=b64ToBytes(value),key=await encryptionKey(env);try{return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.slice(0,12)},key,bytes.slice(12)))}catch{problem('Bot token could not be decrypted. Check TOKEN_ENCRYPTION_KEY.',503)}}
async function setting(env,key){return (await one(env,'SELECT value FROM ml_settings WHERE key=?',key))?.value||'';}
function setSetting(env,key,value){return run(env,'INSERT INTO ml_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,value);}
function cookie(req){return /(?:^|;\s*)moonlight_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.get('Cookie')||'')?.[1];}
async function userFor(req,env){const token=cookie(req);if(!token)return null;return await one(env,'SELECT u.id,u.name,u.email,u.role FROM ml_sessions s JOIN ml_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1',await digest(token),Date.now());}
async function requireUser(req,env){const user=await userFor(req,env);if(!user)problem('Please sign in.',401);return user;}
async function requireAdmin(req,env){const user=await requireUser(req,env);if(user.role!=='admin')problem('Admin access required.',403);return user;}
async function readBody(req){const bytes=await req.arrayBuffer();if(bytes.byteLength>30*1024*1024)problem('Upload is too large. Maximum request size is 30 MB.',413);try{return JSON.parse(new TextDecoder().decode(bytes)||'{}')}catch{problem('Send valid JSON.')}}
async function session(env,userId){const token=randomHex(32);await run(env,'INSERT INTO ml_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',await digest(token),userId,Date.now()+7*86400000);return `moonlight_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`;}
function checkWindow(input){const date=input.startDate||input.date,endDate=input.endDate||date,start=input.startTime||input.start,end=input.endTime||input.end;if(!validWindow(date,start,end,endDate))problem('Enter a valid start and end date and time (up to 36 hours).');if(date<manilaToday())problem('Choose today or a future date in Philippine Time.');return {date,endDate,start,end};}
function manualTimes(input,shiftDate){
 const format=/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/;
 const start=String(input.clockIn||''),end=String(input.clockOut||'');
 if(!format.test(start)||!format.test(end)||!validWindow(start.slice(0,10),'00:00','23:59')||!validWindow(end.slice(0,10),'00:00','23:59'))problem('Enter valid start and end times.');
 if(start.slice(0,10)!==shiftDate)problem('The start time must be on the scheduled shift date (Asia/Manila).');
 const from=new Date(`${start}:00+08:00`),to=new Date(`${end}:00+08:00`);
 if(to<=from||to-from>36*3600000)problem('End time must be after start time and within 36 hours.');
 if(to.getTime()>Date.now()+5*60000)problem('You cannot submit future worked time.');
 return {from:from.toISOString(),to:to.toISOString()};
}

async function calendarState(env,user,month){
 const [from,to]=monthRange(month);
 if(user.role==='admin'){
  const [doctors,availability,bookings,pending]=await Promise.all([
   all(env,'SELECT id,name,email,role,active FROM ml_users WHERE deleted_at IS NULL ORDER BY name'),
   all(env,'SELECT a.*,u.name AS doctor_name FROM ml_availability a JOIN ml_users u ON u.id=a.doctor_id WHERE u.deleted_at IS NULL AND a.date>=? AND a.date<? ORDER BY a.date,a.start_time',from,to),
   all(env,'SELECT b.*,d.name AS doctor_name,r.name AS requester_name FROM ml_bookings b JOIN ml_users d ON d.id=b.doctor_id JOIN ml_users r ON r.id=b.requester_id WHERE b.date<? AND COALESCE(NULLIF(b.end_date,\'\'),b.date)>=? ORDER BY b.date,b.start_time',to,from),
   one(env,"SELECT COUNT(*) AS count FROM ml_bookings WHERE status='pending' AND approval_owner='admin'")
  ]);
  return {user,doctors,availability,bookings,pendingCount:pending.count,timezone:'Asia/Manila'};
 }
 const [availability,bookings]=await Promise.all([
  all(env,'SELECT a.*,u.name AS doctor_name FROM ml_availability a JOIN ml_users u ON u.id=a.doctor_id WHERE a.doctor_id=? AND a.date>=? AND a.date<? ORDER BY a.date,a.start_time',user.id,from,to),
  all(env,`SELECT b.*,d.name AS doctor_name,r.name AS requester_name FROM ml_bookings b JOIN ml_users d ON d.id=b.doctor_id JOIN ml_users r ON r.id=b.requester_id
    WHERE (b.requester_id=? OR (b.doctor_id=? AND b.status='approved')) AND b.date<? AND COALESCE(NULLIF(b.end_date,''),b.date)>=? ORDER BY b.date,b.start_time`,user.id,user.id,to,from)
 ]);
 return {user,doctors:[{id:user.id,name:user.name,role:user.role,active:1}],availability,bookings:bookings.map(b=>b.requester_id===user.id?b:{id:b.id,doctor_id:b.doctor_id,doctor_name:b.doctor_name,date:b.date,end_date:b.end_date,start_time:b.start_time,end_time:b.end_time,status:b.status,requester_id:null,requester_name:null,note:''}),timezone:'Asia/Manila'};
}
async function openTimes(env,month){
 const [from,to]=monthRange(month);
 const [slots,approved]=await Promise.all([
  all(env,`SELECT a.id AS availability_id,a.doctor_id,u.name AS doctor_name,a.date,a.start_time,a.end_time,a.location,a.rate_cents FROM ml_availability a
    JOIN ml_users u ON u.id=a.doctor_id AND u.active=1 AND u.role IN ('admin','doctor') WHERE a.date>=? AND a.date<? ORDER BY a.date,a.start_time,u.name`,from,to),
  all(env,"SELECT doctor_id,date,start_time,end_time FROM ml_bookings WHERE status='approved' AND date>=? AND date<? ORDER BY start_time",from,to)
 ]);
 return slots.filter(s=>s.date>=manilaToday()).flatMap(slot=>{
  let parts=[[slot.start_time,slot.end_time]];
  for(const b of approved.filter(x=>x.doctor_id===slot.doctor_id&&x.date===slot.date))parts=parts.flatMap(([start,end])=>{
    if(b.end_time<=start||b.start_time>=end)return [[start,end]];
    const remaining=[];if(start<b.start_time)remaining.push([start,b.start_time]);if(b.end_time<end)remaining.push([b.end_time,end]);return remaining;
  });
  return parts.map(([start_time,end_time])=>({...slot,start_time,end_time}));
 });
}
async function relieverPosts(env,month){
 const [from,to]=monthRange(month);
 return all(env,`SELECT p.id,p.created_by,p.date,p.start_time,p.end_time,p.location,p.rate_cents,p.required_questions,p.created_at,u.name AS posted_by_name
  FROM ml_reliever_posts p JOIN ml_users u ON u.id=p.created_by AND u.active=1 AND u.deleted_at IS NULL
  WHERE p.active=1 AND p.date>=? AND p.date<? AND p.date>=? AND NOT EXISTS
  (SELECT 1 FROM ml_bookings b WHERE b.reliever_post_id=p.id) ORDER BY p.date,p.start_time,p.id`,from,to,manilaToday());
}
async function attendanceFor(env,user){
 const rows=await all(env,`SELECT a.*,b.date,b.end_date,b.start_time,b.end_time,b.status,b.doctor_id,b.requester_id,b.reliever_post_id,d.name AS doctor_name,r.name AS requester_name
   FROM ml_attendance a JOIN ml_bookings b ON b.id=a.booking_id JOIN ml_users d ON d.id=b.doctor_id JOIN ml_users r ON r.id=b.requester_id
   ${user.role==='admin'?'':'WHERE b.requester_id=?'} ORDER BY a.clock_in_at DESC LIMIT 200`,...(user.role==='admin'?[]:[user.id]));
 return rows.map(({clock_in_photo,clock_out_photo,document_file,clock_in_mime,clock_out_mime,...rest})=>({...rest,has_clock_in_photo:!!clock_in_photo,has_clock_out_photo:!!clock_out_photo,has_document:!!document_file}));
}
async function doctorSummaries(env){return all(env,`SELECT u.id,u.name,u.email,u.role,u.active,
  (SELECT COUNT(*) FROM ml_bookings b WHERE b.requester_id=u.id AND b.status='pending') AS pending_count,
  (SELECT COUNT(*) FROM ml_bookings b WHERE b.requester_id=u.id AND b.status='approved') AS assigned_count,
  COALESCE((SELECT SUM((CAST(substr(b.end_time,1,2) AS INTEGER)*60+CAST(substr(b.end_time,4,2) AS INTEGER))-(CAST(substr(b.start_time,1,2) AS INTEGER)*60+CAST(substr(b.start_time,4,2) AS INTEGER))) FROM ml_bookings b WHERE b.requester_id=u.id AND b.status='approved'),0) AS assigned_minutes,
  COALESCE((SELECT SUM((julianday(a.clock_out_at)-julianday(a.clock_in_at))*1440) FROM ml_attendance a JOIN ml_bookings b ON b.id=a.booking_id WHERE b.requester_id=u.id AND a.clock_out_at IS NOT NULL),0) AS completed_minutes
  FROM ml_users u WHERE u.role='doctor' AND u.deleted_at IS NULL ORDER BY u.name`)}
function validEvidence(input,kind){
 if(!input||typeof input.data!=='string'||typeof input.mime!=='string')problem(`${kind} is required.`);
 const photo=['image/jpeg','image/png','image/webp'],allowed=kind==='photo'?photo:[...photo,'application/pdf'];
 if(!allowed.includes(input.mime))problem(`${kind} must be a JPG, PNG, WebP${kind==='document'?' or PDF':''} file.`);
 let bytes;try{bytes=b64ToBytes(input.data)}catch{problem(`${kind} is not valid base64.`)}
 if(!bytes.length||bytes.length>(kind==='photo'?6:8)*1024*1024)problem(`${kind} exceeds the size limit.`);
 const valid=input.mime==='application/pdf'?new TextDecoder().decode(bytes.slice(0,5))==='%PDF-':input.mime==='image/png'?bytes.slice(0,8).every((v,i)=>v===[137,80,78,71,13,10,26,10][i]):input.mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:new TextDecoder().decode(bytes.slice(0,4))==='RIFF'&&new TextDecoder().decode(bytes.slice(8,12))==='WEBP';
 if(!valid)problem(`${kind} file content does not match its type.`);
 return bytes;
}
async function uploadEvidence(env,input,kind){if(!env.EVIDENCE)problem('R2 EVIDENCE binding is not configured.',503);const bytes=validEvidence(input,kind),key=`moonlight/evidence/${crypto.randomUUID()}`;await env.EVIDENCE.put(key,bytes,{httpMetadata:{contentType:input.mime}});return key;}
async function telegram(env,method,payload){const encrypted=await setting(env,'telegram_token');if(!encrypted)problem('Add a Telegram bot token in Settings first.',409);const token=await decrypt(env,encrypted);try{const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(8000)});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.description||'Telegram rejected the request.');return data.result}catch(error){problem(`Telegram could not complete the request: ${error.name==='TimeoutError'?'Telegram timed out.':error.message}`,502)}}
async function notifyRequest(env,bookingId){const chatId=await setting(env,'telegram_chat_id');if(!chatId||!await setting(env,'telegram_token'))return 'not_configured';const b=await one(env,'SELECT b.*,d.name AS doctor_name,r.name AS requester_name FROM ml_bookings b JOIN ml_users d ON d.id=b.doctor_id JOIN ml_users r ON r.id=b.requester_id WHERE b.id=?',bookingId);try{let answers=[];try{answers=JSON.parse(b.reliever_answers||'[]')}catch{}const responses=answers.map(x=>`${x.question}: ${x.answer}`).join('\n').slice(0,2800);const text=b.reliever_post_id?`New Reliever post request #${bookingId}\n${b.requester_name}\n${b.date}, ${b.start_time}–${b.end_time} (Asia/Manila)\n${b.location}${responses?`\n\nRequired skill responses:\n${responses}`:''}\nOpen Moonlight Calendar to approve or decline.`:`New moonlighting request #${bookingId}\n${b.requester_name} → ${b.doctor_name}\n${b.date}, ${b.start_time}–${b.end_time} (Asia/Manila)\nOpen Moonlight Calendar to approve or decline.`;await telegram(env,'sendMessage',{chat_id:chatId,text});await run(env,"UPDATE ml_bookings SET notification_state='sent' WHERE id=?",bookingId);return 'sent'}catch{await run(env,"UPDATE ml_bookings SET notification_state='failed' WHERE id=?",bookingId);return 'failed'}}

async function api(req,env,url){
 const method=req.method,route=url.pathname;
 if(method==='GET'&&route==='/api/bootstrap'){const count=await one(env,'SELECT COUNT(*) AS n FROM ml_users');return result({needsSetup:count.n===0,setupKeyRequired:true});}
 if(method==='POST'&&route==='/api/setup'){
  if(!env.ADMIN_SETUP_KEY)problem('Set ADMIN_SETUP_KEY as a Worker secret before creating the admin account.',503);
  const input=await readBody(req);if(input.setupKey!==env.ADMIN_SETUP_KEY)problem('Setup key is incorrect.',403);
  const name=text(input.name,80,'Name'),mail=email(input.email),hash=await hashPassword(password(input.password));
  const inserted=await run(env,"INSERT INTO ml_users(name,email,password_hash,role) SELECT ?,?,?,'admin' WHERE NOT EXISTS(SELECT 1 FROM ml_users)",name,mail,hash);
  if(inserted.meta.changes!==1)problem('Setup is already complete.',409);
  return result({ok:true},201,{'Set-Cookie':await session(env,inserted.meta.last_row_id)});
 }
 if(method==='POST'&&route==='/api/login'){
  const input=await readBody(req),mail=email(input.email),ip=req.headers.get('CF-Connecting-IP')||'local',key=await digest(`${ip}:${mail}`),attempt=await one(env,'SELECT count,until_ms FROM ml_login_attempts WHERE attempt_key=?',key);
  if(attempt&&attempt.count>=5&&attempt.until_ms>Date.now())problem('Too many sign-in attempts. Wait 15 minutes and try again.',429);
  const user=await one(env,'SELECT * FROM ml_users WHERE email=? AND active=1',mail);
  if(!user||!await checkPassword(String(input.password||''),user.password_hash)){
   await run(env,'INSERT INTO ml_login_attempts(attempt_key,count,until_ms) VALUES(?,?,?) ON CONFLICT(attempt_key) DO UPDATE SET count=excluded.count,until_ms=excluded.until_ms',key,(attempt?.until_ms>Date.now()?attempt.count:0)+1,Date.now()+15*60000);
   problem('Email or password is incorrect.',401);
  }
  await run(env,'DELETE FROM ml_login_attempts WHERE attempt_key=?',key);
  return result({ok:true},200,{'Set-Cookie':await session(env,user.id)});
 }
 if(method==='POST'&&route==='/api/logout'){const token=cookie(req);if(token)await run(env,'DELETE FROM ml_sessions WHERE token_hash=?',await digest(token));return result({ok:true},200,{'Set-Cookie':'moonlight_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});}
 if(method==='GET'&&route==='/api/me')return result({user:await requireUser(req,env)});
 if(method==='PATCH'&&route==='/api/me'){
  const user=await requireUser(req,env),input=await readBody(req),name=input.name?text(input.name,80,'Name'):null,hash=input.newPassword?await hashPassword(password(input.newPassword)):null;
  if(hash){const current=await one(env,'SELECT password_hash FROM ml_users WHERE id=?',user.id);if(!await checkPassword(String(input.currentPassword||''),current.password_hash))problem('Current password is incorrect.',403);}
  if(name)await run(env,'UPDATE ml_users SET name=? WHERE id=?',name,user.id);
  if(hash){await run(env,'UPDATE ml_users SET password_hash=? WHERE id=?',hash,user.id);await run(env,'DELETE FROM ml_sessions WHERE user_id=? AND token_hash<>?',user.id,await digest(cookie(req)));}
  return result({user:await userFor(req,env)});
 }
 if(method==='GET'&&route==='/api/state')return result(await calendarState(env,await requireUser(req,env),url.searchParams.get('month')));
 if(method==='GET'&&route==='/api/open-times'){await requireUser(req,env);return result({openTimes:await openTimes(env,url.searchParams.get('month'))});}
 if(method==='GET'&&route==='/api/reliever-posts'){
  const user=await requireUser(req,env);if(!['admin','doctor'].includes(user.role))problem('Reliever posts are available to doctors only.',403);
  return result({posts:await relieverPosts(env,url.searchParams.get('month'))});
 }
 if(method==='GET'&&route==='/api/bookings'){
  const user=await requireUser(req,env),admin=user.role==='admin';
  const bookings=await all(env,`SELECT b.*,d.name AS doctor_name,r.name AS requester_name
   FROM ml_bookings b JOIN ml_users d ON d.id=b.doctor_id JOIN ml_users r ON r.id=b.requester_id ${admin?'':'WHERE b.requester_id=?'}
   ORDER BY CASE WHEN b.status='pending' THEN 0 ELSE 1 END,b.created_at DESC,b.id DESC LIMIT 500`,...(admin?[]:[user.id]));
  return result({bookings});
 }
 if(method==='GET'&&route==='/api/attendance')return result({attendance:await attendanceFor(env,await requireUser(req,env))});
 if(method==='GET'&&route==='/api/users'){await requireAdmin(req,env);return result({users:await all(env,'SELECT id,name,email,role,active,created_at FROM ml_users WHERE deleted_at IS NULL ORDER BY name')});}
 if(method==='GET'&&route==='/api/team-scorecard'){
  await requireAdmin(req,env);
  const from=url.searchParams.get('from'),to=url.searchParams.get('to');
  if(!validScorecardDate(from)||!validScorecardDate(to)||from>to)problem('Choose a valid scorecard date range.',400);
  const [users,bookings]=await Promise.all([
   all(env,`SELECT u.id,u.name,u.email,u.role,u.active,u.deleted_at FROM ml_users u
    WHERE (u.deleted_at IS NULL OR EXISTS
    (SELECT 1 FROM ml_bookings b WHERE b.requester_id=u.id AND b.date>=? AND b.date<=? AND b.status IN ('pending','approved'))) ORDER BY u.name`,from,to),
   all(env,`SELECT b.*,a.clock_in_at,a.clock_out_at,a.entry_source,
    a.clock_in_photo IS NOT NULL AS has_clock_in_photo,a.clock_out_photo IS NOT NULL AS has_clock_out_photo,
    a.document_file IS NOT NULL AS has_document
    FROM ml_bookings b LEFT JOIN ml_attendance a ON a.booking_id=b.id
    WHERE b.date>=? AND b.date<=? AND b.status IN ('pending','approved') ORDER BY b.date DESC,b.start_time DESC`,from,to)
  ]);
  return result(buildTeamScorecard(users,bookings,from,to,manilaToday()));
 }
 if(method==='GET'&&route==='/api/doctors/summary'){await requireAdmin(req,env);return result({doctors:await doctorSummaries(env)});}
 const doctorDetails=/^\/api\/doctors\/(\d+)\/details$/.exec(route);
 if(doctorDetails&&method==='GET'){
  await requireAdmin(req,env);const doctor=(await doctorSummaries(env)).find(d=>d.id===Number(doctorDetails[1]));if(!doctor)problem('Doctor not found.',404);
  const bookings=await all(env,`SELECT b.id,b.date,b.start_time,b.end_time,b.status,b.note,b.rate_cents,b.created_at,b.decided_at,d.name AS doctor_name
   FROM ml_bookings b JOIN ml_users d ON d.id=b.doctor_id WHERE b.requester_id=? ORDER BY b.date DESC,b.start_time DESC LIMIT 100`,doctor.id);
  const attendance=await all(env,`SELECT a.booking_id,a.clock_in_at,a.clock_out_at,a.document_name,
   a.clock_out_photo IS NOT NULL AS has_clock_out_photo,a.document_file IS NOT NULL AS has_document,
   b.date,b.start_time,b.end_time,d.name AS doctor_name
   FROM ml_attendance a JOIN ml_bookings b ON b.id=a.booking_id JOIN ml_users d ON d.id=b.doctor_id WHERE b.requester_id=? ORDER BY a.clock_in_at DESC LIMIT 100`,doctor.id);
  return result({doctor,bookings,attendance});
 }
 if(method==='POST'&&route==='/api/users'){
  await requireAdmin(req,env);const input=await readBody(req),name=text(input.name,80,'Name'),mail=email(input.email),kind=role(input.accountType),hash=await hashPassword(password(input.password));
  try{const inserted=await run(env,'INSERT INTO ml_users(name,email,password_hash,role) VALUES(?,?,?,?)',name,mail,hash,kind);return result({id:inserted.meta.last_row_id},201)}catch(error){if(String(error.message).includes('UNIQUE'))problem('That email is already in use.',409);throw error;}
 }
 const userMatch=/^\/api\/users\/(\d+)$/.exec(route);
 if(userMatch&&method==='PATCH'){
  const admin=await requireAdmin(req,env),userId=id(userMatch[1]),input=await readBody(req),target=await one(env,'SELECT id FROM ml_users WHERE id=? AND deleted_at IS NULL',userId);if(!target)problem('User not found.',404);
  if(input.active===false&&userId===admin.id)problem('You cannot deactivate your own admin account.',409);
  const name=input.name?text(input.name,80,'Name'):null,hash=input.password?await hashPassword(password(input.password)):null;
  if(name)await run(env,'UPDATE ml_users SET name=? WHERE id=?',name,userId);
  if(hash)await run(env,'UPDATE ml_users SET password_hash=? WHERE id=?',hash,userId);
  if(typeof input.active==='boolean')await run(env,'UPDATE ml_users SET active=? WHERE id=?',input.active?1:0,userId);
  if(hash||input.active===false)await run(env,'DELETE FROM ml_sessions WHERE user_id=?',userId);
  return result({ok:true});
 }
 if(userMatch&&method==='DELETE'){
  const admin=await requireAdmin(req,env),userId=id(userMatch[1]);
  const target=await one(env,'SELECT id,active FROM ml_users WHERE id=? AND deleted_at IS NULL',userId);
  if(!target)problem('User not found.',404);
  if(userId===admin.id)problem('You cannot delete your own admin account.',409);
  if(target.active)problem('Deactivate this user before deleting them.',409);
  const today=manilaToday();
  const updated=await run(env,`UPDATE ml_users SET active=0,deleted_at=CURRENT_TIMESTAMP,name=?,email=?,password_hash=?
   WHERE id=? AND active=0 AND deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM ml_bookings WHERE (requester_id=? OR doctor_id=?) AND (status='pending' OR (status='approved' AND date>=?)))`,
   `Deleted user #${userId}`,`deleted-user-${userId}@example.invalid`,'',userId,userId,userId,today);
  if(updated.meta.changes!==1)problem('Resolve this user’s pending requests and current or future booked shifts before deleting them.',409);
  await run(env,'DELETE FROM ml_sessions WHERE user_id=?',userId);
  return result({ok:true});
 }
 if(method==='POST'&&route==='/api/availability'){
  const user=await requireUser(req,env),input=await readBody(req),doctorId=id(input.doctorId);checkWindow(input);
  if(user.role!=='admin'&&(user.role!=='doctor'||doctorId!==user.id))problem('You can add open time only to your own doctor calendar.',403);
  const location=String(input.location||'').trim();if(location.length>120)problem('Location must be 120 characters or fewer.');const cents=rate(input.hourlyRate);
  if(!await one(env,"SELECT id FROM ml_users WHERE id=? AND active=1 AND role IN ('admin','doctor')",doctorId))problem('Doctor not found.',404);
  const inserted=await run(env,`INSERT INTO ml_availability(doctor_id,date,start_time,end_time,location,rate_cents)
   SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM ml_availability WHERE doctor_id=? AND date=? AND start_time<? AND end_time>?)`,doctorId,input.date,input.start,input.end,location,cents,doctorId,input.date,input.end,input.start);
  if(inserted.meta.changes!==1)problem('This availability overlaps an existing open time.',409);return result({id:inserted.meta.last_row_id},201);
 }
 if(method==='POST'&&route==='/api/reliever-posts'){
  const user=await requireUser(req,env);if(!['admin','doctor'].includes(user.role))problem('Only doctors can publish Reliever posts.',403);
  const input=await readBody(req);checkWindow(input);const location=text(input.location,120,'Location'),cents=rate(input.hourlyRate);
  if(!Array.isArray(input.requiredQuestions)||input.requiredQuestions.length<1||input.requiredQuestions.length>8)problem('Add between 1 and 8 required skill questions.');
  const questions=input.requiredQuestions.map(item=>{const question=String(item?.question||'').trim(),type=item?.type;if(!question||question.length>160||!['yes_no','details'].includes(type))problem('Each required skill question needs a description and a valid response type.');return {question,type}});
  const today=manilaToday();if(input.date<today)problem('Choose today or a future date in Philippine Time.');
  const duplicate=await one(env,'SELECT id FROM ml_reliever_posts WHERE created_by=? AND date=? AND start_time=? AND end_time=? AND location=? AND active=1 AND NOT EXISTS(SELECT 1 FROM ml_bookings WHERE reliever_post_id=ml_reliever_posts.id)',user.id,input.date,input.start,input.end,location);
  if(duplicate)problem('You already have an open Reliever post for this time and location.',409);
  const inserted=await run(env,'INSERT INTO ml_reliever_posts(created_by,date,start_time,end_time,location,rate_cents,required_questions) VALUES(?,?,?,?,?,?,?)',user.id,input.date,input.start,input.end,location,cents,JSON.stringify(questions));
  return result({id:inserted.meta.last_row_id},201);
 }
 const relieverPostMatch=/^\/api\/reliever-posts\/(\d+)$/.exec(route);
 if(relieverPostMatch&&method==='DELETE'){
  const user=await requireUser(req,env);if(!['admin','doctor'].includes(user.role))problem('Reliever posts are available to doctors only.',403);
  const postId=id(relieverPostMatch[1]),post=await one(env,'SELECT * FROM ml_reliever_posts WHERE id=? AND active=1',postId);
  if(!post)problem('Reliever post not found.',404);if(user.role!=='admin'&&post.created_by!==user.id)problem('You can remove only your own Reliever post.',403);
  const removed=await run(env,'UPDATE ml_reliever_posts SET active=0 WHERE id=? AND active=1 AND NOT EXISTS(SELECT 1 FROM ml_bookings WHERE reliever_post_id=?)',postId,postId);
  if(removed.meta.changes!==1)problem('A requested Reliever post cannot be removed.',409);return result({ok:true});
 }
 const relieverRequestMatch=/^\/api\/reliever-posts\/(\d+)\/request$/.exec(route);
 if(relieverRequestMatch&&method==='POST'){
  const user=await requireUser(req,env);if(!['admin','doctor'].includes(user.role))problem('Only doctors can request Reliever posts.',403);
  const postId=id(relieverRequestMatch[1]),input=await readBody(req),note=String(input.note||'').trim();if(note.length>500)problem('Note must be 500 characters or fewer.');
  const post=await one(env,`SELECT p.required_questions FROM ml_reliever_posts p JOIN ml_users creator ON creator.id=p.created_by AND creator.active=1 AND creator.deleted_at IS NULL WHERE p.id=? AND p.active=1 AND p.date>=? AND p.created_by<>? AND NOT EXISTS(SELECT 1 FROM ml_bookings b WHERE b.reliever_post_id=p.id)`,postId,manilaToday(),user.id);
  if(!post)problem('This Reliever post has already been requested or is unavailable.',409);
  let questions=[];try{questions=JSON.parse(post.required_questions||'[]')}catch{problem('The Reliever post has invalid skill questions.',500)}
  if(!Array.isArray(input.answers)||input.answers.length!==questions.length)problem('Answer every required skill question.');
  const answers=questions.map((q,index)=>{const answer=String(input.answers[index]?.answer||'').trim();if(!answer||answer.length>500||(q.type==='yes_no'&&!['yes','no'].includes(answer)))problem(`Answer “${q.question}” with ${q.type==='yes_no'?'Yes or No':'details'}.`);return {question:q.question,type:q.type,answer}});
  const today=manilaToday();
  let inserted;try{inserted=await run(env,`INSERT INTO ml_bookings(doctor_id,requester_id,date,start_time,end_time,note,rate_cents,location,approval_owner,reliever_post_id,reliever_answers,status)
   SELECT ?,?,p.date,p.start_time,p.end_time,?,p.rate_cents,p.location,'admin',p.id,?,'pending' FROM ml_reliever_posts p
   JOIN ml_users creator ON creator.id=p.created_by AND creator.active=1 AND creator.deleted_at IS NULL
   WHERE p.id=? AND p.active=1 AND p.date>=? AND p.created_by<>?
   AND NOT EXISTS(SELECT 1 FROM ml_bookings existing WHERE existing.reliever_post_id=p.id)
   AND NOT EXISTS(SELECT 1 FROM ml_bookings existing WHERE existing.requester_id=? AND existing.date=p.date AND existing.status='approved' AND existing.start_time<p.end_time AND existing.end_time>p.start_time)
   LIMIT 1`,user.id,user.id,note,JSON.stringify(answers),postId,today,user.id,user.id)}catch(error){if(String(error.message).includes('UNIQUE'))problem('This Reliever post has already been requested or is unavailable.',409);throw error;}
  if(inserted.meta.changes!==1)problem('This Reliever post has already been requested or is unavailable.',409);
  const bookingId=inserted.meta.last_row_id;return result({id:bookingId,notification:await notifyRequest(env,bookingId)},201);
 }
 const availabilityMatch=/^\/api\/availability\/(\d+)$/.exec(route);
 if(availabilityMatch&&method==='PATCH'){const user=await requireUser(req,env),slotId=id(availabilityMatch[1]),input=await readBody(req),slot=await one(env,'SELECT doctor_id FROM ml_availability WHERE id=?',slotId);if(!slot)problem('Open time not found.',404);if(user.role!=='admin'&&(user.role!=='doctor'||slot.doctor_id!==user.id))problem('You can edit only your own open time.',403);const updated=await run(env,'UPDATE ml_availability SET rate_cents=? WHERE id=?',rate(input.hourlyRate),slotId);if(updated.meta.changes!==1)problem('Open time not found.',404);return result({ok:true});}
 if(availabilityMatch&&method==='DELETE'){
  const user=await requireUser(req,env),slotId=id(availabilityMatch[1]),slot=await one(env,'SELECT doctor_id,date,start_time,end_time FROM ml_availability WHERE id=?',slotId);
  if(!slot)problem('Open time not found.',404);
  if(user.role!=='admin'&&(user.role!=='doctor'||slot.doctor_id!==user.id))problem('You can remove only your own open time.',403);
  const deleted=await run(env,'DELETE FROM ml_availability WHERE id=?',slotId);
  if(deleted.meta.changes!==1)problem('Open time not found.',404);
  await run(env,"UPDATE ml_bookings SET status='declined',decided_at=CURRENT_TIMESTAMP WHERE doctor_id=? AND date=? AND status='pending' AND approval_owner='admin' AND start_time>=? AND end_time<=?",slot.doctor_id,slot.date,slot.start_time,slot.end_time);
  return result({ok:true});
 }
 if(method==='POST'&&route==='/api/my-shifts'){
  const user=await requireUser(req,env),raw=await readBody(req),input={...raw,...checkWindow(raw)};
  const note=String(input.note||'').trim(),location=text(input.location,120,'Location'),cents=rate(input.hourlyRate);
  if(note.length>500)problem('Note must be 500 characters or fewer.');
  const inserted=await run(env,`INSERT INTO ml_bookings(doctor_id,requester_id,date,end_date,start_time,end_time,note,rate_cents,location,approval_owner,status)
   SELECT ?,?,?,?,?,?,?,?,?,'admin','approved' WHERE EXISTS(SELECT 1 FROM ml_users WHERE id=? AND active=1 AND deleted_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM ml_bookings b WHERE b.requester_id=? AND b.status IN ('pending','approved') AND b.date||'T'||b.start_time<? AND COALESCE(NULLIF(b.end_date,''),b.date)||'T'||b.end_time>?)`,
   user.id,user.id,input.date,input.endDate,input.start,input.end,note,cents,location,user.id,user.id,`${input.endDate}T${input.end}`,`${input.date}T${input.start}`);
  if(inserted.meta.changes!==1)problem('This overlaps another shift or offer on your calendar.',409);
  return result({id:inserted.meta.last_row_id},201);
 }
 const personalShiftMatch=/^\/api\/my-shifts\/(\d+)$/.exec(route);
 if(personalShiftMatch&&method==='PATCH'){
  const user=await requireUser(req,env),bookingId=id(personalShiftMatch[1]),raw=await readBody(req),input={...raw,...checkWindow(raw)};
  const note=String(input.note||'').trim(),location=text(input.location,120,'Location'),cents=rate(input.hourlyRate);
  if(note.length>500)problem('Note must be 500 characters or fewer.');
  const booking=await one(env,"SELECT id FROM ml_bookings WHERE id=? AND requester_id=? AND doctor_id=? AND approval_owner='admin' AND reliever_post_id IS NULL AND status='approved'",bookingId,user.id,user.id);
  if(!booking)problem('This shift cannot be edited from My Calendar.',403);
  if(await one(env,'SELECT booking_id FROM ml_attendance WHERE booking_id=?',bookingId))problem('A shift with a time record cannot be edited.',409);
  const startStamp=`${input.date}T${input.start}`,endStamp=`${input.endDate}T${input.end}`;
  if(await one(env,"SELECT id FROM ml_bookings WHERE requester_id=? AND id<>? AND status IN ('pending','approved') AND date||'T'||start_time<? AND COALESCE(NULLIF(end_date,''),date)||'T'||end_time>?",user.id,bookingId,endStamp,startStamp))problem('This overlaps another shift or offer on your calendar.',409);
  const updated=await run(env,`UPDATE ml_bookings SET date=?,end_date=?,start_time=?,end_time=?,note=?,location=?,rate_cents=?
   WHERE id=? AND requester_id=? AND doctor_id=? AND approval_owner='admin' AND reliever_post_id IS NULL AND status='approved'
   AND NOT EXISTS(SELECT 1 FROM ml_attendance WHERE booking_id=?)`,input.date,input.endDate,input.start,input.end,note,location,cents,bookingId,user.id,user.id,bookingId);
  if(updated.meta.changes!==1)problem('This shift changed while you were editing it. Refresh and try again.',409);
  return result({ok:true});
 }
 if(method==='POST'&&(route==='/api/bookings'||route==='/api/admin-bookings')){
  const adminAssignment=route==='/api/admin-bookings';
  const user=adminAssignment?await requireAdmin(req,env):await requireUser(req,env),raw=await readBody(req),input={...raw,...checkWindow(raw)},requesterId=adminAssignment?id(input.requesterId):user.id,doctorId=adminAssignment?requesterId:id(input.doctorId);
  const note=String(input.note||'').trim();if(note.length>500)problem('Note must be 500 characters or fewer.');
  if(adminAssignment){
   if(input.doctorId!==undefined&&id(input.doctorId)!==requesterId)problem('The booking calendar must be the assigned team member’s calendar. Select only the team member.',400);
   if(!await one(env,"SELECT id FROM ml_users WHERE id=? AND active=1 AND role<>'admin'",requesterId))problem('Choose an active non-admin team member.',404);
   const location=String(input.location||'').trim();if(!location||location.length>120)problem('Enter a location of 120 characters or fewer.');
   const cents=rate(input.hourlyRate);
   const inserted=await run(env,`INSERT INTO ml_bookings(doctor_id,requester_id,date,end_date,start_time,end_time,note,rate_cents,location,approval_owner,status)
    SELECT ?,?,?,?,?,?,?,?,?,'assignee','pending' WHERE NOT EXISTS(SELECT 1 FROM ml_bookings b WHERE (b.requester_id=? OR b.doctor_id=?) AND b.status='approved' AND b.date||'T'||b.start_time<? AND COALESCE(NULLIF(b.end_date,''),b.date)||'T'||b.end_time>?)
    AND NOT EXISTS(SELECT 1 FROM ml_bookings b WHERE b.requester_id=? AND b.status='pending' AND b.approval_owner='assignee' AND b.date||'T'||b.start_time<? AND COALESCE(NULLIF(b.end_date,''),b.date)||'T'||b.end_time>?)`,
    doctorId,requesterId,input.date,input.endDate,input.start,input.end,note,cents,location,requesterId,requesterId,`${input.endDate}T${input.end}`,`${input.date}T${input.start}`,requesterId,`${input.endDate}T${input.end}`,`${input.date}T${input.start}`);
   if(inserted.meta.changes!==1)problem('This team member already has a booking or pending offer at this time.',409);
   return result({id:inserted.meta.last_row_id},201);
  }
  const inserted=await run(env,`INSERT INTO ml_bookings(doctor_id,requester_id,date,end_date,start_time,end_time,note,rate_cents,location,status)
    SELECT ?,?,?,?,?,?,?,a.rate_cents,a.location,'pending' FROM ml_availability a JOIN ml_users d ON d.id=a.doctor_id AND d.active=1 AND d.role IN ('admin','doctor')
    JOIN ml_users r ON r.id=? AND r.active=1
    WHERE a.doctor_id=? AND a.date=? AND a.start_time<=? AND a.end_time>=?
    AND NOT EXISTS(SELECT 1 FROM ml_bookings b WHERE b.doctor_id=? AND b.date=? AND b.status='approved' AND b.start_time<? AND b.end_time>?)
    AND NOT EXISTS(SELECT 1 FROM ml_bookings b WHERE b.requester_id=? AND b.date=? AND b.status='approved' AND b.start_time<? AND b.end_time>?)
    AND NOT EXISTS(SELECT 1 FROM ml_bookings b WHERE b.doctor_id=? AND b.requester_id=? AND b.date=? AND b.start_time=? AND b.end_time=? AND b.status='pending')
    LIMIT 1`,doctorId,requesterId,input.date,input.date,input.start,input.end,note,requesterId,doctorId,input.date,input.start,input.end,doctorId,input.date,input.end,input.start,requesterId,input.date,input.end,input.start,doctorId,requesterId,input.date,input.start,input.end);
  if(inserted.meta.changes!==1)problem('This time is unavailable, already booked, or already requested.',409);
  const bookingId=inserted.meta.last_row_id;
  return result({id:bookingId,notification:await notifyRequest(env,bookingId)},201);
 }
 const decisionMatch=/^\/api\/bookings\/(\d+)\/decision$/.exec(route);
 if(decisionMatch&&method==='POST'){
  const user=await requireUser(req,env),bookingId=id(decisionMatch[1]),input=await readBody(req);
  if(!['approved','declined'].includes(input.status))problem('Choose approve or decline.');
  const pending=await one(env,"SELECT approval_owner,requester_id FROM ml_bookings WHERE id=? AND status='pending'",bookingId);
  if(!pending)problem('Pending offer or request not found.',404);
  if(pending.approval_owner==='assignee'&&pending.requester_id!==user.id)problem('Only the assigned team member can answer this offer.',403);
  if(pending.approval_owner==='admin'&&user.role!=='admin')problem('Admin access required to decide this request.',403);
  let updated;
  if(input.status==='declined')updated=await run(env,"UPDATE ml_bookings SET status='declined',decided_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'",bookingId);
  else updated=await run(env,`UPDATE ml_bookings SET status='approved',decided_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'
    AND (approval_owner='assignee' OR reliever_post_id IS NOT NULL OR EXISTS(SELECT 1 FROM ml_availability a WHERE a.doctor_id=ml_bookings.doctor_id AND a.date=ml_bookings.date AND a.start_time<=ml_bookings.start_time AND a.end_time>=ml_bookings.end_time))
    AND NOT EXISTS(SELECT 1 FROM ml_bookings b WHERE b.doctor_id=ml_bookings.doctor_id AND b.date=ml_bookings.date AND b.status='approved' AND b.start_time<ml_bookings.end_time AND b.end_time>ml_bookings.start_time)
    AND NOT EXISTS(SELECT 1 FROM ml_bookings b WHERE b.requester_id=ml_bookings.requester_id AND b.date=ml_bookings.date AND b.status='approved' AND b.start_time<ml_bookings.end_time AND b.end_time>ml_bookings.start_time)`,bookingId);
  if(updated.meta.changes!==1)problem('Pending request not found or the time is already booked.',409);
  if(input.status==='approved'){const b=await one(env,'SELECT doctor_id,requester_id,date,start_time,end_time FROM ml_bookings WHERE id=?',bookingId);await run(env,"UPDATE ml_bookings SET status='declined',decided_at=CURRENT_TIMESTAMP WHERE (doctor_id=? OR requester_id=?) AND date=? AND status='pending' AND id<>? AND start_time<? AND end_time>?",b.doctor_id,b.requester_id,b.date,bookingId,b.end_time,b.start_time)}
  return result({ok:true});
 }
 const bookingRateMatch=/^\/api\/bookings\/(\d+)\/rate$/.exec(route);
 if(bookingRateMatch&&method==='PATCH'){
  await requireAdmin(req,env);const bookingId=id(bookingRateMatch[1]),input=await readBody(req);
  const updated=await run(env,'UPDATE ml_bookings SET rate_cents=? WHERE id=?',rate(input.hourlyRate),bookingId);
  if(updated.meta.changes!==1)problem('Booking not found.',404);
  return result({ok:true});
 }
 const cancelMatch=/^\/api\/bookings\/(\d+)\/cancel$/.exec(route);
 if(cancelMatch&&method==='POST'){
  const user=await requireUser(req,env),bookingId=id(cancelMatch[1]);
  const updated=await run(env,`UPDATE ml_bookings SET status='cancelled',decided_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','approved')
    AND (?='admin' OR requester_id=?) AND NOT EXISTS(SELECT 1 FROM ml_attendance WHERE booking_id=?)`,bookingId,user.role,user.id,bookingId);
  if(updated.meta.changes!==1)problem('This booking cannot be cancelled. Check its status or time record.',409);
  return result({ok:true});
 }
 const manualMatch=/^\/api\/bookings\/(\d+)\/time-entry$/.exec(route);
 if(manualMatch&&method==='POST'){
  const user=await requireUser(req,env),bookingId=id(manualMatch[1]),input=await readBody(req);
  const booking=await one(env,"SELECT date FROM ml_bookings WHERE id=? AND requester_id=? AND status='approved'",bookingId,user.id);
  if(!booking)problem('Approved shift not found for your account.',403);
  const {from,to}=manualTimes(input,booking.date),note=String(input.note||'').trim();
  if(note.length>500)problem('Evidence note must be 500 characters or fewer.');
  if(await one(env,'SELECT booking_id FROM ml_attendance WHERE booking_id=?',bookingId))problem('This shift already has a time record.',409);
  const uploaded=[];
  try{
   const photo=await uploadEvidence(env,input.photo,'photo');uploaded.push(photo);
   const outPhoto=input.outPhoto?await uploadEvidence(env,input.outPhoto,'photo'):null;if(outPhoto)uploaded.push(outPhoto);
   const document=input.document?await uploadEvidence(env,input.document,'document'):null;if(document)uploaded.push(document);
   const inserted=await run(env,`INSERT INTO ml_attendance(booking_id,clock_in_at,clock_out_at,clock_in_photo,clock_in_mime,clock_out_photo,clock_out_mime,document_file,document_name,document_mime,entry_source,evidence_note)
    SELECT b.id,?,?,?,?,?,?,?,?,?,?,? FROM ml_bookings b WHERE b.id=? AND b.requester_id=? AND b.status='approved'
    AND NOT EXISTS(SELECT 1 FROM ml_attendance WHERE booking_id=b.id)`,from,to,photo,input.photo.mime,outPhoto,outPhoto?input.outPhoto.mime:null,document,document?String(input.document.name||'Supporting document').slice(0,120):null,document?input.document.mime:null,'manual',note,bookingId,user.id);
   if(inserted.meta.changes!==1)problem('This shift already has a time record or is no longer approved.',409);
  }catch(error){for(const key of uploaded)await env.EVIDENCE.delete(key);throw error;}
  return result({ok:true},201);
 }
 const clockMatch=/^\/api\/bookings\/(\d+)\/(clock-in|clock-out)$/.exec(route);
 if(clockMatch&&method==='POST'){
  const user=await requireUser(req,env),bookingId=id(clockMatch[1]),action=clockMatch[2],input=await readBody(req);
  const booking=await one(env,'SELECT * FROM ml_bookings WHERE id=? AND requester_id=? AND status=\'approved\'',bookingId,user.id);
  if(!booking)problem('Approved shift not found for your account.',403);
  if(action==='clock-in'&&booking.date!==manilaToday())problem('You can clock in only on the shift date (Asia/Manila).',409);
  if(action==='clock-in'&&await one(env,'SELECT booking_id FROM ml_attendance WHERE booking_id=?',bookingId))problem('You already clocked in for this shift.',409);
  if(action==='clock-out'){const record=await one(env,'SELECT booking_id,clock_out_at FROM ml_attendance WHERE booking_id=?',bookingId);if(!record||record.clock_out_at)problem('Clock in first, or this shift is already complete.',409);}
  const uploaded=[];let photo,document;
  try{
   photo=await uploadEvidence(env,input.photo,'photo');uploaded.push(photo);
   if(input.document){document=await uploadEvidence(env,input.document,'document');uploaded.push(document);}
   let updated;
   if(action==='clock-in')updated=await run(env,`INSERT INTO ml_attendance(booking_id,clock_in_at,clock_in_photo,clock_in_mime,document_file,document_name,document_mime)
     SELECT b.id,?,?,?, ?,?,? FROM ml_bookings b WHERE b.id=? AND b.requester_id=? AND b.status='approved' AND b.date=?
     AND NOT EXISTS(SELECT 1 FROM ml_attendance WHERE booking_id=b.id)`,new Date().toISOString(),photo,input.photo.mime,document||null,document?String(input.document.name||'Supporting document').slice(0,120):null,document?input.document.mime:null,bookingId,user.id,manilaToday());
   else updated=await run(env,`UPDATE ml_attendance SET clock_out_at=?,clock_out_photo=?,clock_out_mime=?,document_file=COALESCE(?,document_file),document_name=COALESCE(?,document_name),document_mime=COALESCE(?,document_mime)
     WHERE booking_id=? AND clock_out_at IS NULL AND EXISTS(SELECT 1 FROM ml_bookings b WHERE b.id=ml_attendance.booking_id AND b.requester_id=? AND b.status='approved')`,new Date().toISOString(),photo,input.photo.mime,document||null,document?String(input.document.name||'Supporting document').slice(0,120):null,document?input.document.mime:null,bookingId,user.id);
   if(updated.meta.changes!==1)problem('Shift time record changed. Refresh and try again.',409);
  }catch(error){for(const key of uploaded)await env.EVIDENCE.delete(key);throw error;}
  return result({ok:true});
 }
 const evidenceMatch=/^\/api\/evidence\/(\d+)\/(in|out|document)$/.exec(route);
 if(evidenceMatch&&method==='GET'){
  const user=await requireUser(req,env),bookingId=id(evidenceMatch[1]),kind=evidenceMatch[2];
  const record=await one(env,'SELECT a.*,b.requester_id FROM ml_attendance a JOIN ml_bookings b ON b.id=a.booking_id WHERE a.booking_id=?',bookingId);
  if(!record||(user.role!=='admin'&&record.requester_id!==user.id))problem('Evidence not found.',404);
  const key=record[kind==='in'?'clock_in_photo':kind==='out'?'clock_out_photo':'document_file'];if(!key)problem('Evidence not found.',404);
  if(!env.EVIDENCE)problem('R2 EVIDENCE binding is not configured.',503);const object=await env.EVIDENCE.get(key);if(!object)problem('Evidence file is missing. Contact an admin.',404);
  const mime=record[kind==='in'?'clock_in_mime':kind==='out'?'clock_out_mime':'document_mime'];
  return new Response(object.body,{headers:{'Content-Type':mime,'Content-Disposition':`${kind==='document'?'attachment':'inline'}; filename="${kind==='document'?'document':kind+'-photo'}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }
 if(method==='GET'&&route==='/api/telegram'){await requireAdmin(req,env);return result({configured:!!await setting(env,'telegram_token'),chatId:await setting(env,'telegram_chat_id')});}
 if(method==='PUT'&&route==='/api/telegram'){
  await requireAdmin(req,env);const input=await readBody(req),chatId=String(input.chatId||'').trim();if(chatId&&!/^-?\d{5,20}$/.test(chatId))problem('Chat ID must be a numeric Telegram chat ID.');
  if(input.token){const token=String(input.token).trim();if(!/^\d{5,20}:[A-Za-z0-9_-]{20,}$/.test(token))problem('Bot token format looks incorrect.');await setSetting(env,'telegram_token',await encrypt(env,token));}
  await setSetting(env,'telegram_chat_id',chatId);return result({configured:!!await setting(env,'telegram_token'),chatId});
 }
 if(method==='POST'&&route==='/api/telegram/test'){await requireAdmin(req,env);const chatId=await setting(env,'telegram_chat_id');if(!chatId)problem('Add a chat ID first.',409);await telegram(env,'sendMessage',{chat_id:chatId,text:'Moonlight Calendar is connected. New shift requests will appear here.'});return result({ok:true});}
 if(method==='GET'&&route==='/api/telegram/chats'){await requireAdmin(req,env);const updates=await telegram(env,'getUpdates',{limit:100,timeout:0}),chats=[...new Map(updates.map(u=>u.message?.chat).filter(Boolean).map(c=>[String(c.id),{id:String(c.id),name:c.title||[c.first_name,c.last_name].filter(Boolean).join(' ')||'Chat'}])).values()];return result({chats});}
 return result({error:'Page not found.'},404);
}

export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(!url.pathname.startsWith('/api/')){
   if(!env.ASSETS)return result({error:'Static assets are not configured.'},503);
   const pages=new Set(['/','/calendar','/team-calendar','/my-calendar','/find-shifts','/requests','/time-evidence','/team-scorecard','/doctor-management','/user-management','/telegram-alerts','/settings','/help']);
   const assetRequest=pages.has(url.pathname)?new Request(new URL('/',url),request):request;
   const response=await env.ASSETS.fetch(assetRequest);
   const headers=new Headers(response.headers);
   headers.set('Cache-Control','no-store');
   if(response.headers.get('Content-Type')?.includes('text/html'))headers.set('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
   return new Response(response.body,{status:response.status,headers});
  }
  try{
   if(!env.DB)problem('D1 DB binding is not configured.',503);
   if(!['GET','HEAD'].includes(request.method)){const origin=request.headers.get('Origin');if(origin&&new URL(origin).origin!==url.origin)problem('This request came from another site.',403);}
   return await api(request,env,url);
  }catch(error){if(!error.status)console.error(JSON.stringify({event:'request_error',path:url.pathname,message:error.message}));return result({error:error.status?error.message:'Something went wrong on the server. Please retry.'},error.status||500);}
 }
};
