import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker.js';

function environment(){
 const db=new DatabaseSync(':memory:');
 for(const migration of ['0001_init.sql','0002_manual_time.sql','0003_user_delete.sql','0004_booking_location.sql','0005_assignee_approval.sql','0006_reliever_posts.sql'])db.exec(fs.readFileSync(new URL(`../migrations/${migration}`,import.meta.url),'utf8'));
 const files=new Map();
 return {ASSETS:{fetch(request){return new Response('<!doctype html><title>Moonlight Calendar</title>',{headers:{'Content-Type':'text/html'}})}},DB:{prepare(sql){return {bind(...values){const statement=db.prepare(sql);return {
  async first(){return statement.get(...values)||null},
  async all(){return {results:statement.all(...values)}},
  async run(){const result=statement.run(...values);return {meta:{changes:result.changes,last_row_id:Number(result.lastInsertRowid)}}}
 }}}}},EVIDENCE:{async put(key,body){files.set(key,body)},async get(key){const body=files.get(key);return body?{body}:null},async delete(key){files.delete(key)}},ADMIN_SETUP_KEY:'private-setup-key',TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64'),close(){db.close()}};
}

test('Cloudflare D1 worker separates User Management from doctor hours and protects evidence',async()=>{
 const env=environment();
 const call=async(route,method='GET',body,cookie='')=>{
  const response=await worker.fetch(new Request(`https://moonlight.example${route}`,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),env);
  return {status:response.status,data:route.includes('/evidence/')?null:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]||'',response};
 };
 try{
  for(const page of ['/team-scorecard','/doctor-management','/user-management']){
   const response=await worker.fetch(new Request(`https://moonlight.example${page}`),env);
   assert.equal(response.status,200);
   assert.match(await response.text(),/Moonlight Calendar/);
  }
  assert.equal((await call('/api/bootstrap')).data.setupKeyRequired,true);
  assert.equal((await call('/api/setup','POST',{name:'Admin',email:'admin@example.test',password:'a-very-long-password',setupKey:'wrong'})).status,403);
  const setup=await call('/api/setup','POST',{name:'Admin',email:'admin@example.test',password:'a-very-long-password',setupKey:'private-setup-key'});
  assert.equal(setup.status,201);const admin=setup.cookie;
  const owner=await call('/api/users','POST',{name:'Dr Owner',email:'owner@example.test',password:'owner-password',accountType:'doctor'},admin);
  const doctor=await call('/api/users','POST',{name:'Dr Assigned',email:'doctor@example.test',password:'doctor-password',accountType:'doctor'},admin);
  const nurse=await call('/api/users','POST',{name:'Nurse One',email:'nurse@example.test',password:'nurse-password',accountType:'nurse'},admin);
  const staff=await call('/api/users','POST',{name:'Staff One',email:'staff@example.test',password:'staff-password',accountType:'staff'},admin);
  assert.equal(owner.status,201);assert.equal(doctor.status,201);assert.equal(nurse.status,201);assert.equal(staff.status,201);
  const users=(await call('/api/users','GET',undefined,admin)).data.users;
  assert.deepEqual(new Set(users.map(u=>u.role)),new Set(['admin','doctor','nurse','staff']));
  const doctors=(await call('/api/doctors/summary','GET',undefined,admin)).data.doctors;
  assert.equal(doctors.length,2);assert.ok(doctors.every(u=>u.role==='doctor'));
  const signed=(await call('/api/login','POST',{email:'doctor@example.test',password:'doctor-password'})).cookie;
  const outsider=(await call('/api/login','POST',{email:'nurse@example.test',password:'nurse-password'})).cookie;
  assert.equal((await call('/api/users','GET',undefined,signed)).status,403);
  assert.equal((await call('/api/doctors/summary','GET',undefined,outsider)).status,403);
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const slot=await call('/api/availability','POST',{doctorId:owner.data.id,date,start:'09:00',end:'17:00',hourlyRate:'1800.00'},admin);
  assert.equal(slot.status,201);
  for(const cookie of [admin,signed,outsider]){
   assert.ok((await call(`/api/open-times?month=${date.slice(0,7)}`,'GET',undefined,cookie)).data.openTimes.some(o=>o.availability_id===slot.data.id));
  }
  const request=await call('/api/bookings','POST',{doctorId:owner.data.id,date,start:'09:00',end:'12:00'},signed);
  assert.equal(request.status,201);assert.equal(request.data.notification,'not_configured');
  assert.equal((await call('/api/bookings','GET',undefined,signed)).data.bookings[0].rate_cents,180000);
  assert.equal((await call(`/api/bookings/${request.data.id}/decision`,'POST',{status:'approved'},admin)).status,200);
  const assigned=await call('/api/admin-bookings','POST',{requesterId:staff.data.id,date,start:'12:00',end:'17:00',hourlyRate:'1800',location:'Clinic'},admin);
  assert.equal(assigned.status,201);
  assert.equal((await call('/api/bookings','GET',undefined,admin)).data.bookings.find(b=>b.id===assigned.data.id).status,'pending');
  assert.equal((await call(`/api/bookings/${assigned.data.id}/decision`,'POST',{status:'approved'},admin)).status,403);
  const summary=(await call('/api/doctors/summary','GET',undefined,admin)).data.doctors;
  assert.equal(summary.find(u=>u.id===doctor.data.id).assigned_minutes,180);
  assert.equal((await call('/api/admin-bookings','POST',{requesterId:staff.data.id,date,start:'13:00',end:'14:00',hourlyRate:'1800',location:'Clinic'},admin)).status,409);
  assert.equal((await call(`/api/bookings/${assigned.data.id}/cancel`,'POST',undefined,admin)).status,200);
  const nurseState=(await call(`/api/state?month=${date.slice(0,7)}`,'GET',undefined,outsider)).data;
  assert.deepEqual(nurseState.doctors.map(u=>u.id),[nurse.data.id]);assert.deepEqual(nurseState.availability,[]);
  const photo={mime:'image/png',name:'time.png',data:Buffer.from('89504e470d0a1a0a00000000','hex').toString('base64')};
  assert.equal((await call(`/api/bookings/${request.data.id}/clock-in`,'POST',{photo},signed)).status,200);
  assert.equal((await call(`/api/evidence/${request.data.id}/in`,'GET',undefined,outsider)).status,404);
  assert.equal((await call(`/api/evidence/${request.data.id}/in`,'GET',undefined,signed)).status,200);
  assert.equal((await call(`/api/bookings/${request.data.id}/cancel`,'POST',undefined,admin)).status,409);
  const manualSlot=await call('/api/availability','POST',{doctorId:owner.data.id,date,start:'00:00',end:'01:00',hourlyRate:'900.00'},admin);
  assert.equal(manualSlot.status,201);
  const manualShift=await call('/api/admin-bookings','POST',{requesterId:nurse.data.id,date,start:'00:00',end:'01:00',hourlyRate:'900',location:'Clinic'},admin);
  assert.equal(manualShift.status,201);
  assert.equal((await call(`/api/bookings/${manualShift.data.id}/decision`,'POST',{status:'approved'},signed)).status,403);
  assert.equal((await call(`/api/bookings/${manualShift.data.id}/decision`,'POST',{status:'approved'},outsider)).status,200);
  const manualInput={clockIn:`${date}T00:00`,clockOut:`${date}T00:01`,note:'Uploaded after shift',photo};
  assert.equal((await call(`/api/bookings/${manualShift.data.id}/time-entry`,'POST',manualInput,signed)).status,403);
  assert.equal((await call(`/api/bookings/${manualShift.data.id}/time-entry`,'POST',{...manualInput,clockOut:`${date}T00:00`},outsider)).status,400);
  assert.equal((await call(`/api/bookings/${manualShift.data.id}/time-entry`,'POST',manualInput,outsider)).status,201);
  const manualRecord=(await call('/api/attendance','GET',undefined,outsider)).data.attendance[0];
  assert.equal(manualRecord.booking_id,manualShift.data.id);assert.equal(manualRecord.entry_source,'manual');assert.equal(manualRecord.evidence_note,'Uploaded after shift');
  const scorecard=(await call(`/api/team-scorecard?from=${date}&to=${date}`,'GET',undefined,admin)).data;
  assert.ok(scorecard.team.some(u=>u.role==='staff'));
  const nurseScore=scorecard.team.find(u=>u.id===nurse.data.id);
  assert.equal(nurseScore.completed_shifts,1);assert.equal(nurseScore.worked_minutes,1);
  assert.equal(nurseScore.earned_cents,1500);assert.equal(nurseScore.shifts.find(s=>s.id===manualShift.data.id).has_clock_in_photo,true);
  assert.equal((await call(`/api/team-scorecard?from=${date}&to=${date}`,'GET',undefined,signed)).status,403);
  assert.equal((await call('/api/team-scorecard?from=2026-02-30&to=2026-03-01','GET',undefined,admin)).status,400);
  assert.equal((await call('/api/team-scorecard?from=2025-01-01&to=2025-01-31','GET',undefined,admin)).data.totals.booked_shifts,0);
  assert.equal((await call(`/api/evidence/${manualShift.data.id}/in`,'GET',undefined,outsider)).status,200);
  assert.equal((await call(`/api/evidence/${manualShift.data.id}/in`,'GET',undefined,signed)).status,404);
  assert.equal((await call(`/api/bookings/${manualShift.data.id}/time-entry`,'POST',manualInput,outsider)).status,409);
  assert.equal((await call(`/api/bookings/${request.data.id}/rate`,'PATCH',{hourlyRate:'1950'},signed)).status,403);
  assert.equal((await call(`/api/bookings/${request.data.id}/rate`,'PATCH',{hourlyRate:'1950'},admin)).status,200);
  assert.equal((await call('/api/bookings','GET',undefined,signed)).data.bookings.find(b=>b.id===request.data.id).rate_cents,195000);
  assert.equal((await call('/api/availability','POST',{doctorId:owner.data.id,date,start:'21:00',end:'22:00',hourlyRate:'1200'},signed)).status,403);
  assert.equal((await call('/api/availability','POST',{doctorId:doctor.data.id,date,start:'21:00',end:'22:00',hourlyRate:'1200'},outsider)).status,403);
  const ownOpen=await call('/api/availability','POST',{doctorId:doctor.data.id,date,start:'21:00',end:'22:00',hourlyRate:'1200',location:'Night clinic'},signed);
  assert.equal(ownOpen.status,201);
  assert.ok((await call(`/api/state?month=${date.slice(0,7)}`,'GET',undefined,admin)).data.availability.some(a=>a.id===ownOpen.data.id));
  assert.equal((await call(`/api/availability/${ownOpen.data.id}`,'PATCH',{hourlyRate:'1300'},outsider)).status,403);
  assert.equal((await call(`/api/availability/${ownOpen.data.id}`,'PATCH',{hourlyRate:'1300'},signed)).status,200);
  const openRequest=await call('/api/bookings','POST',{doctorId:doctor.data.id,date,start:'21:00',end:'22:00'},outsider);
  const directOffer=await call('/api/admin-bookings','POST',{requesterId:doctor.data.id,date,start:'21:00',end:'22:00',hourlyRate:'1300',location:'Night clinic'},admin);
  assert.equal(openRequest.status,201);assert.equal(directOffer.status,201);
  assert.equal((await call(`/api/availability/${ownOpen.data.id}`,'DELETE',undefined,signed)).status,200);
  const afterRemoval=(await call('/api/bookings','GET',undefined,admin)).data.bookings;
  assert.equal(afterRemoval.find(b=>b.id===openRequest.data.id).status,'declined');
  assert.equal(afterRemoval.find(b=>b.id===directOffer.data.id).status,'pending');
  assert.equal((await call(`/api/bookings/${directOffer.data.id}/decision`,'POST',{status:'approved'},signed)).status,200);
  const freeDoctor=await call('/api/users','POST',{name:'Dr Free',email:'free@example.test',password:'free-password',accountType:'doctor'},admin);
  const freeStaff=await call('/api/users','POST',{name:'Free Staff',email:'free-staff@example.test',password:'free-staff-password',accountType:'staff'},admin);
  const noOpen=await call('/api/admin-bookings','POST',{requesterId:freeStaff.data.id,date,start:'18:00',end:'20:00',hourlyRate:'2100',location:'ER Annex'},admin);
  assert.equal(noOpen.status,201);
  const noOpenBooking=(await call('/api/bookings','GET',undefined,admin)).data.bookings.find(b=>b.id===noOpen.data.id);
  assert.equal(noOpenBooking.location,'ER Annex');assert.equal(noOpenBooking.rate_cents,210000);assert.equal(noOpenBooking.doctor_id,freeStaff.data.id);assert.equal(noOpenBooking.status,'pending');
  assert.equal((await call('/api/admin-bookings','POST',{requesterId:freeStaff.data.id,date,start:'18:30',end:'19:30',hourlyRate:'2200',location:'Ward B'},admin)).status,409);
  const freeStaffCookie=(await call('/api/login','POST',{email:'free-staff@example.test',password:'free-staff-password'})).cookie;
  assert.equal((await call(`/api/bookings/${noOpen.data.id}/decision`,'POST',{status:'approved'},freeStaffCookie)).status,200);
  const declinedOffer=await call('/api/admin-bookings','POST',{requesterId:freeStaff.data.id,date,start:'21:00',end:'22:00',hourlyRate:'2100',location:'Ward B'},admin);
  assert.equal(declinedOffer.status,201);
  assert.equal((await call(`/api/bookings/${declinedOffer.data.id}/decision`,'POST',{status:'declined'},freeStaffCookie)).status,200);
  assert.equal((await call('/api/bookings','GET',undefined,freeStaffCookie)).data.bookings.find(b=>b.id===declinedOffer.data.id).status,'declined');
  assert.equal((await call('/api/admin-bookings','POST',{requesterId:users.find(u=>u.role==='admin').id,date,start:'20:00',end:'21:00',hourlyRate:'2100',location:'ER Annex'},admin)).status,404);
  assert.equal((await call('/api/admin-bookings','POST',{requesterId:nurse.data.id,date,start:'20:00',end:'21:00',hourlyRate:'2100',location:'ER Annex'},signed)).status,403);
  assert.equal((await call('/api/admin-bookings','POST',{doctorId:owner.data.id,requesterId:nurse.data.id,date,start:'20:00',end:'21:00',hourlyRate:'2100',location:'ER Annex'},admin)).status,400);
  assert.equal((await call(`/api/users/${nurse.data.id}`,'DELETE',undefined,outsider)).status,403);
  assert.equal((await call(`/api/users/${nurse.data.id}`,'DELETE',undefined,admin)).status,409);
  assert.equal((await call(`/api/users/${users.find(u=>u.role==='admin').id}`,'DELETE',undefined,admin)).status,409);
  assert.equal((await call(`/api/users/${nurse.data.id}`,'PATCH',{active:false},admin)).status,200);
  assert.equal((await call(`/api/users/${nurse.data.id}`,'DELETE',undefined,admin)).status,409);
  const unused=await call('/api/users','POST',{name:'Unused Doctor',email:'unused@example.test',password:'unused-password',accountType:'doctor'},admin);
  assert.equal(unused.status,201);
  const unusedSession=(await call('/api/login','POST',{email:'unused@example.test',password:'unused-password'})).cookie;
  assert.equal((await call(`/api/users/${unused.data.id}`,'PATCH',{active:false},admin)).status,200);
  assert.equal((await call(`/api/users/${unused.data.id}`,'DELETE',undefined,admin)).status,200);
  assert.equal((await call(`/api/users/${unused.data.id}`,'DELETE',undefined,admin)).status,404);
  assert.equal((await call(`/api/users/${unused.data.id}`,'PATCH',{active:true},admin)).status,404);
  assert.equal((await call('/api/me','GET',undefined,unusedSession)).status,401);
  assert.equal((await call('/api/login','POST',{email:'unused@example.test',password:'unused-password'})).status,401);
  assert.ok(!(await call('/api/users','GET',undefined,admin)).data.users.some(u=>u.id===unused.data.id));
  assert.ok(!(await call('/api/doctors/summary','GET',undefined,admin)).data.doctors.some(u=>u.id===unused.data.id));
  assert.equal((await call('/api/users','POST',{name:'Replacement Doctor',email:'unused@example.test',password:'replacement-password',accountType:'doctor'},admin)).status,201);
  assert.equal((await call(`/api/users/${staff.data.id}`,'PATCH',{active:false},admin)).status,200);
  assert.equal((await call(`/api/users/${staff.data.id}`,'DELETE',undefined,admin)).status,200);
  assert.equal((await call('/api/bookings','GET',undefined,admin)).data.bookings.find(b=>b.id===assigned.data.id).requester_name,`Deleted user #${staff.data.id}`);
 }finally{env.close()}
});
