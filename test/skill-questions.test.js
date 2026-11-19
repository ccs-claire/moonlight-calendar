import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function editor(count=1){
 const handlers={},messages=[];
 const rows=Array.from({length:count},()=>({focused:false,querySelector(){return {focus:()=>{this.focused=true}}},remove(){rows.splice(rows.indexOf(this),1)}}));
 const list={querySelectorAll:()=>rows,insertAdjacentHTML(position,html){assert.equal(position,'beforeend');assert.match(html,/skill-prompt/);rows.push({focused:false,querySelector(){return {focus:()=>{this.focused=true}}}})},get lastElementChild(){return rows.at(-1)}};
 const context=vm.createContext({document:{addEventListener:(name,fn)=>{handlers[name]=fn},querySelector:()=>null},modal:{querySelector:()=>list,querySelectorAll:()=>[]},toast:message=>messages.push(message),skillQuestionRow:()=>'<input class="skill-prompt">'});
 vm.runInContext(source.slice(source.indexOf("document.addEventListener('click',async event=>"),source.indexOf("\ndocument.addEventListener('keydown'")),context);
 const click=dataset=>handlers.click({target:{closest:selector=>selector==='button'?{dataset,closest:selector=>selector==='.skill-question-list'?list:selector==='.skill-question'?rows.at(-1):null}:null}});
 return {rows,messages,click};
}
test('bare Add question attribute appends an editable question and focuses its prompt',async()=>{
 const {rows,click}=editor(),first=rows[0];
 await click({addSkillQuestion:''});
 assert.ok(rows.some(row=>row!==first),'Add question must append a new row');
 assert.equal(rows.at(-1).focused,true);
});
test('eight questions prevents an extra question and explains the limit',async()=>{
 const {rows,messages,click}=editor(8),before=[...rows];
 await click({addSkillQuestion:''});
 assert.deepEqual(rows,before);assert.match(messages[0],/up to 8/);
});
test('remove question preserves other rows and refuses to remove the final question',async()=>{
 const {rows,messages,click}=editor(2),first=rows[0],last=rows[1];
 await click({removeSkill:''});assert.ok(rows.includes(first));assert.ok(!rows.includes(last));
 await click({removeSkill:''});assert.ok(rows.includes(first));assert.match(messages[0],/at least one/);
});
