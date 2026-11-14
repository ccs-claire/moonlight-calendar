import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamScorecard, validScorecardDate } from '../scorecard.js';

test('team scorecard separates booked time from completed time and pay',()=>{
  assert.equal(validScorecardDate('2026-02-29'),false);
  assert.equal(validScorecardDate('2026-11-13'),true);
  const users=[{id:1,name:'Dr Ana',email:'ana@example.test',role:'doctor',active:1},{id:2,name:'Nurse Bea',email:'bea@example.test',role:'nurse',active:0}];
  const bookings=[
    {id:10,requester_id:1,date:'2026-11-10',start_time:'09:00',end_time:'11:00',status:'approved',rate_cents:120000,location:'Clinic',clock_in_at:'2026-11-10T01:15:00.000Z',clock_out_at:'2026-11-10T03:45:00.000Z',entry_source:'manual',has_clock_in_photo:1,has_clock_out_photo:1,has_document:1},
    {id:11,requester_id:1,date:'2026-11-11',start_time:'09:00',end_time:'10:00',status:'approved',rate_cents:0,location:'Ward'},
    {id:12,requester_id:2,date:'2026-11-12',start_time:'09:00',end_time:'10:00',status:'pending',rate_cents:90000,location:'ER'}
  ];
  const result=buildTeamScorecard(users,bookings,'2026-11-07','2026-11-13','2026-11-13');
  const ana=result.team[0],bea=result.team[1];
  assert.equal(ana.booked_minutes,180);
  assert.equal(ana.worked_minutes,150);
  assert.equal(ana.scheduled_cents,240000);
  assert.equal(ana.earned_cents,300000);
  assert.equal(ana.completed_shifts,1);
  assert.equal(ana.missing_time_count,1);
  assert.equal(ana.missing_rate_count,1);
  assert.equal(ana.shifts.find(s=>s.id===10).has_document,true);
  assert.equal(bea.pending_count,1);
  assert.equal(result.totals.active_members,1);
  assert.equal(result.totals.earned_cents,300000);
});
