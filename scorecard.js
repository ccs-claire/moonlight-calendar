const datePattern=/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

export function validScorecardDate(value){
  if(!datePattern.test(value||''))return false;
  const date=new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())&&date.toISOString().slice(0,10)===value;
}

const minutes=(date,start,endDate,end)=>Math.max(0,(Date.parse(`${endDate||date}T${end}:00Z`)-Date.parse(`${date}T${start}:00Z`))/60000);

export function buildTeamScorecard(users,bookings,from,to,today){
  const byUser=new Map(users.map(user=>[user.id,{
    id:user.id,name:user.name,email:user.deleted_at?'':user.email,role:user.role,active:user.active,deleted:!!user.deleted_at,
    pending_count:0,booked_shifts:0,booked_minutes:0,scheduled_cents:0,
    completed_shifts:0,worked_minutes:0,earned_cents:0,due_shifts:0,due_completed_shifts:0,
    missing_time_count:0,in_progress_count:0,missing_rate_count:0,shifts:[]
  }]));
  for(const booking of bookings){
    const row=byUser.get(booking.requester_id);
    if(!row)continue;
    const shiftEndDate=booking.end_date||booking.date;
    const bookedMinutes=minutes(booking.date,booking.start_time,shiftEndDate,booking.end_time);
    const rateCents=Number(booking.rate_cents)||0;
    const completed=booking.status==='approved'&&!!booking.clock_out_at;
    const workedMinutes=completed?Math.max(0,(Date.parse(booking.clock_out_at)-Date.parse(booking.clock_in_at))/60000):0;
    const scheduledCents=booking.status==='approved'&&rateCents>0?Math.round(bookedMinutes*rateCents/60):0;
    const earnedCents=completed&&rateCents>0?Math.round(workedMinutes*rateCents/60):0;
    if(booking.status==='pending')row.pending_count++;
    if(booking.status==='approved'){
      row.booked_shifts++;
      row.booked_minutes+=bookedMinutes;
      row.scheduled_cents+=scheduledCents;
      if(completed){row.completed_shifts++;row.worked_minutes+=workedMinutes;row.earned_cents+=earnedCents;}
      if(shiftEndDate<today){row.due_shifts++;if(completed)row.due_completed_shifts++;}
      if(shiftEndDate<today&&!completed)row.missing_time_count++;
      if(booking.clock_in_at&&!booking.clock_out_at)row.in_progress_count++;
      if(rateCents<=0)row.missing_rate_count++;
    }
    row.shifts.push({
      id:booking.id,date:booking.date,end_date:shiftEndDate,start_time:booking.start_time,end_time:booking.end_time,
      status:booking.status,location:booking.location||'',rate_cents:rateCents,
      booked_minutes:bookedMinutes,scheduled_cents:scheduledCents,
      clock_in_at:booking.clock_in_at||null,clock_out_at:booking.clock_out_at||null,
      entry_source:booking.entry_source||null,worked_minutes:workedMinutes,earned_cents:earnedCents,
      has_clock_in_photo:!!booking.has_clock_in_photo,has_clock_out_photo:!!booking.has_clock_out_photo,
      has_document:!!booking.has_document
    });
  }
  const team=[...byUser.values()].sort((a,b)=>a.name.localeCompare(b.name));
  for(const row of team)row.shifts.sort((a,b)=>b.date.localeCompare(a.date)||b.start_time.localeCompare(a.start_time));
  const totals={members:team.length,active_members:team.filter(x=>x.active).length,
    booked_shifts:0,booked_minutes:0,scheduled_cents:0,completed_shifts:0,
    worked_minutes:0,earned_cents:0,due_shifts:0,due_completed_shifts:0,missing_time_count:0,in_progress_count:0,
    missing_rate_count:0,pending_count:0};
  for(const row of team)for(const key of Object.keys(totals))if(key!=='members'&&key!=='active_members')totals[key]+=row[key];
  return {from,to,team,totals};
}
