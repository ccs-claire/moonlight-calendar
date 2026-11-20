import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';

const source=fs.readFileSync(new URL('../supabase/functions/moonlight/index.ts',import.meta.url),'utf8');
function harness(changes){
 const queries=[];
 const context=vm.createContext({URL,Date,JSON,Number,String,Math,problem(message,status=400){throw Object.assign(new Error(message),{status})},result:(data,status)=>({data,status}),requireUser:async()=>({id:7,role:'doctor'}),requireAdmin:async()=>({id:1,role:'admin'}),readBody:async req=>req.body,checkWindow:raw=>({date:raw.date,endDate:raw.endDate||raw.date,start:raw.start,end:raw.end}),text:value=>value,rate:()=>50000,id:Number,one:async()=>({id:7}),dateRe:/^\d{4}-\d{2}-\d{2}$/,
 run:async(env,sql,...args)=>{
  assert.equal((sql.match(/\?/g)||[]).length,args.length,'Every SQL placeholder must have one argument');
  assert.equal((sql.match(/jsonb_to_recordset\(\?::jsonb\)/g)||[]).length,(sql.match(/jsonb_to_recordset\(\?::jsonb\) AS o\(date text,end_date text\)/g)||[]).length,'Every recordset must define its PostgreSQL columns');
  for(const value of args.filter(value=>typeof value==='string'&&value.startsWith('[{'))){
   for(const window of JSON.parse(value)){
    assert.match(window.date,/^\d{4}-\d{2}-\d{2}$/);
    assert.match(window.end_date,/^\d{4}-\d{2}-\d{2}$/,'JSON keys must match the PostgreSQL recordset columns');
   }
  }
  queries.push({sql,args});return {meta:{changes,last_row_id:100}};
 }});
 vm.runInContext(source.slice(source.indexOf('function recurringWindows('),source.indexOf('\nfunction manualTimes')),context);
 vm.runInContext(source.slice(source.indexOf('async function api('),source.indexOf('\nDeno.serve')),context);
 return {context,queries};
}

test('shift inserts execute through the PostgreSQL query bridge',{skip:!process.env.MOONLIGHT_TEST_POSTGRES_URL},async()=>{
 const connection=process.env.MOONLIGHT_TEST_POSTGRES_URL;
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(connection).hostname),'Use a disposable local test database');
 for(const route of ['/api/my-shifts','/api/admin-bookings']){
  for(const repeat of ['none','weekly']){
   const count=repeat==='none'?1:3,{context,queries}=harness(count);
   await context.api({method:'POST',body:{requesterId:7,date:'2027-01-01',endDate:'2027-01-02',start:'20:00',end:'08:00',location:'Clinic',hourlyRate:'500',repeatFrequency:repeat,repeatUntil:'2027-01-15'}},{},new URL('https://example.test'+route));
   const {sql,args}=queries[0];
   const literal=value=>"'"+value.replaceAll("'","''")+"'";
   const output=execFileSync('psql',[connection,'-X','-qAt','-v','ON_ERROR_STOP=1'],{encoding:'utf8',input:`BEGIN;
INSERT INTO ml_users(id,name,email,password_hash,role) VALUES(7,'Test','shift-test@example.test','unused','doctor');
SELECT moonlight_query(${literal(sql)},${literal(JSON.stringify(args))}::jsonb);
ROLLBACK;`});
   const saved=JSON.parse(output.trim());
   assert.equal(saved.changes,count);
   for(const row of saved.rows){assert.equal(row.end_date,new Date(Date.parse(row.date+'T00:00:00Z')+86400000).toISOString().slice(0,10));}
  }
 }
});
for(const route of ['/api/my-shifts','/api/admin-bookings']){
 for(const repeat of ['none','weekly'])test(`${route} saves ${repeat} with valid SQL bindings`,async()=>{
  const count=repeat==='none'?1:3,{context,queries}=harness(count);
  const response=await context.api({method:'POST',body:{requesterId:7,date:'2027-01-01',start:'08:00',end:'12:00',location:'Clinic',hourlyRate:'500',repeatFrequency:repeat,repeatUntil:'2027-01-15'}},{},new URL('https://example.test'+route));
  assert.equal(response.status,201);assert.equal(response.data.created,count);assert.equal(queries.length,1);
 });
 test(`${route} rejects conflicting series`,async()=>{
  const {context}=harness(0);
  await assert.rejects(context.api({method:'POST',body:{requesterId:7,date:'2027-01-01',start:'08:00',end:'12:00',location:'Clinic',hourlyRate:'500',repeatFrequency:'weekly',repeatUntil:'2027-01-15'}},{},new URL('https://example.test'+route)),error=>error.status===409);
 });
}
