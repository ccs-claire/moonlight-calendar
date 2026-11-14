import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const timeRe = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validWindow(date, start, end, endDate=date) {
  if (!dateRe.test(date || '') || !dateRe.test(endDate || '') || !timeRe.test(start || '') || !timeRe.test(end || '')) return false;
  const from = Date.parse(`${date}T${start}:00Z`), to = Date.parse(`${endDate}T${end}:00Z`);
  return Number.isFinite(from) && Number.isFinite(to) && to > from && to-from <= 36*3600000 && new Date(from).toISOString().slice(0,10)===date && new Date(to).toISOString().slice(0,10)===endDate;
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','doctor')),
      account_type TEXT NOT NULL DEFAULT 'doctor' CHECK(account_type IN ('admin','doctor','nurse','staff')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS availability (
      id INTEGER PRIMARY KEY, doctor_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '', rate_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reliever_posts (
      id INTEGER PRIMARY KEY, created_by INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      location TEXT NOT NULL, rate_cents INTEGER NOT NULL,
      required_questions TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1, legacy_availability_id INTEGER UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY, doctor_id INTEGER NOT NULL REFERENCES users(id),
      requester_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL, end_date TEXT NOT NULL DEFAULT '', start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', rate_cents INTEGER NOT NULL DEFAULT 0,
      location TEXT NOT NULL DEFAULT '',
      approval_owner TEXT NOT NULL DEFAULT 'admin' CHECK(approval_owner IN ('admin','assignee')),
      reliever_post_id INTEGER REFERENCES reliever_posts(id),
      reliever_answers TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','cancelled')),
      notification_state TEXT NOT NULL DEFAULT 'not_configured',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attendance (
      booking_id INTEGER PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
      clock_in_at TEXT NOT NULL, clock_out_at TEXT,
      clock_in_photo TEXT NOT NULL, clock_out_photo TEXT,
      document_file TEXT, document_name TEXT, document_mime TEXT,
      entry_source TEXT NOT NULL DEFAULT 'clock', evidence_note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_availability_date ON availability(doctor_id,date);
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(doctor_id,date,status);
  `);
  const columns=table=>db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
  if(!columns('reliever_posts').includes('required_questions'))db.exec("ALTER TABLE reliever_posts ADD COLUMN required_questions TEXT NOT NULL DEFAULT '[]'");
  if(!columns('bookings').includes('reliever_answers'))db.exec("ALTER TABLE bookings ADD COLUMN reliever_answers TEXT NOT NULL DEFAULT '[]'");
  if(!columns('bookings').includes('end_date'))db.exec("ALTER TABLE bookings ADD COLUMN end_date TEXT NOT NULL DEFAULT ''; UPDATE bookings SET end_date=date WHERE end_date=''");
  if(!columns('users').includes('account_type')) {
    db.exec("ALTER TABLE users ADD COLUMN account_type TEXT NOT NULL DEFAULT 'doctor' CHECK(account_type IN ('admin','doctor','nurse','staff'))");
    db.exec("UPDATE users SET account_type='admin' WHERE role='admin'");
  }
  if(!columns('users').includes('deleted_at'))db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT');
  if(!columns('availability').includes('rate_cents'))db.exec('ALTER TABLE availability ADD COLUMN rate_cents INTEGER NOT NULL DEFAULT 0');
  if(!columns('bookings').includes('rate_cents'))db.exec('ALTER TABLE bookings ADD COLUMN rate_cents INTEGER NOT NULL DEFAULT 0');
  if(!columns('bookings').includes('location'))db.exec("ALTER TABLE bookings ADD COLUMN location TEXT NOT NULL DEFAULT ''; UPDATE bookings SET location=COALESCE((SELECT a.location FROM availability a WHERE a.doctor_id=bookings.doctor_id AND a.date=bookings.date AND a.start_time<=bookings.start_time AND a.end_time>=bookings.end_time ORDER BY a.id LIMIT 1),'')");
  if(!columns('bookings').includes('approval_owner'))db.exec("ALTER TABLE bookings ADD COLUMN approval_owner TEXT NOT NULL DEFAULT 'admin' CHECK(approval_owner IN ('admin','assignee'))");
  if(!columns('bookings').includes('reliever_post_id')){
    db.exec('ALTER TABLE bookings ADD COLUMN reliever_post_id INTEGER REFERENCES reliever_posts(id)');
    db.exec(`INSERT INTO reliever_posts(created_by,date,start_time,end_time,location,rate_cents,legacy_availability_id)
      SELECT a.doctor_id,a.date,a.start_time,a.end_time,a.location,a.rate_cents,a.id FROM availability a
      WHERE a.rate_cents>0 AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.doctor_id=a.doctor_id AND b.date=a.date
        AND b.status IN ('pending','approved') AND b.start_time<a.end_time AND b.end_time>a.start_time)`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_reliever_post ON bookings(reliever_post_id) WHERE reliever_post_id IS NOT NULL; CREATE INDEX IF NOT EXISTS idx_reliever_posts_date ON reliever_posts(date,active)');
  if(!columns('attendance').includes('entry_source'))db.exec("ALTER TABLE attendance ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'clock'");
  if(!columns('attendance').includes('evidence_note'))db.exec("ALTER TABLE attendance ADD COLUMN evidence_note TEXT NOT NULL DEFAULT ''");
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const fail = (message, status=400) => { const error = new Error(message); error.status=status; throw error; };

  function addAvailability({doctorId,date,start,end,location='',rateCents}) {
    if (!validWindow(date,start,end)) fail('Enter a valid date and a start time before the end time.');
    if (location.length > 120) fail('Location must be 120 characters or fewer.');
    if(!Number.isSafeInteger(rateCents)||rateCents<1)fail('Enter a valid hourly rate.');
    return transaction(() => {
      if (!one("SELECT id FROM users WHERE id=? AND active=1 AND account_type IN ('doctor','admin')", doctorId)) fail('Doctor not found.',404);
      if (one('SELECT id FROM availability WHERE doctor_id=? AND date=? AND start_time<? AND end_time>?',doctorId,date,end,start)) fail('This availability overlaps an existing open time.',409);
      return Number(run('INSERT INTO availability(doctor_id,date,start_time,end_time,location,rate_cents) VALUES(?,?,?,?,?,?)',doctorId,date,start,end,location.trim(),rateCents).lastInsertRowid);
    });
  }
  function addRelieverPost({createdBy,date,start,end,location='',rateCents,requiredQuestions=[]}) {
    if(!validWindow(date,start,end))fail('Enter a valid date and a start time before the end time.');
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if(date<today)fail('Choose today or a future date in Philippine Time.');
    if(!location.trim()||location.length>120)fail('Enter a location of 120 characters or fewer.');
    if(!Number.isSafeInteger(rateCents)||rateCents<1)fail('Enter a valid hourly rate.');
    if(!Array.isArray(requiredQuestions)||requiredQuestions.length<1||requiredQuestions.length>8)fail('Add between 1 and 8 required skill questions.');
    const questions=requiredQuestions.map(item=>{const question=String(item?.question||'').trim(),type=item?.type;if(!question||question.length>160||!['yes_no','details'].includes(type))fail('Each required skill question needs a description and a valid response type.');return {question,type}});
    return transaction(()=>{
      if(!one("SELECT id FROM users WHERE id=? AND active=1 AND deleted_at IS NULL AND account_type IN ('doctor','admin')",createdBy))fail('Only doctors can publish Reliever posts.',403);
      if(one('SELECT id FROM reliever_posts WHERE created_by=? AND date=? AND start_time=? AND end_time=? AND location=? AND active=1 AND NOT EXISTS(SELECT 1 FROM bookings WHERE reliever_post_id=reliever_posts.id)',createdBy,date,start,end,location.trim()))fail('You already have an open Reliever post for this time and location.',409);
      return Number(run('INSERT INTO reliever_posts(created_by,date,start_time,end_time,location,rate_cents,required_questions) VALUES(?,?,?,?,?,?,?)',createdBy,date,start,end,location.trim(),rateCents,JSON.stringify(questions)).lastInsertRowid);
    });
  }
  function requestRelieverPost({postId,requesterId,note='',answers=[]}) {
    if(note.length>500)fail('Note must be 500 characters or fewer.');
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    return transaction(()=>{
      const post=one(`SELECT p.* FROM reliever_posts p JOIN users creator ON creator.id=p.created_by
        WHERE p.id=? AND p.active=1 AND p.date>=? AND creator.active=1 AND creator.deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.reliever_post_id=p.id)`,postId,today);
      if(!post)fail('This Reliever post has already been requested or is unavailable.',409);
      let questions=[];try{questions=JSON.parse(post.required_questions||'[]')}catch{fail('The Reliever post has invalid skill questions.',500)}
      if(!Array.isArray(answers)||answers.length!==questions.length)fail('Answer every required skill question.');
      const normalized=questions.map((q,index)=>{const answer=String(answers[index]?.answer||'').trim();if(!answer||answer.length>500||(q.type==='yes_no'&&!['yes','no'].includes(answer)))fail(`Answer “${q.question}” with ${q.type==='yes_no'?'Yes or No':'details'}.`);return {question:q.question,type:q.type,answer}});
      if(post.created_by===requesterId)fail('You cannot request your own Reliever post.',409);
      if(!one("SELECT id FROM users WHERE id=? AND active=1 AND deleted_at IS NULL AND account_type IN ('doctor','admin')",requesterId))fail('Only doctors can request Reliever posts.',403);
      if(one("SELECT id FROM bookings WHERE requester_id=? AND date=? AND status='approved' AND start_time<? AND end_time>?",requesterId,post.date,post.end_time,post.start_time))fail('You already have a booking at this time.',409);
      return Number(run("INSERT INTO bookings(doctor_id,requester_id,date,start_time,end_time,note,rate_cents,location,approval_owner,reliever_post_id,reliever_answers,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')",requesterId,requesterId,post.date,post.start_time,post.end_time,note.trim(),post.rate_cents,post.location,'admin',postId,JSON.stringify(normalized)).lastInsertRowid);
    });
  }
  function removeRelieverPost(postId,user) {
    return transaction(()=>{
      const post=one('SELECT * FROM reliever_posts WHERE id=? AND active=1',postId);
      if(!post)fail('Reliever post not found.',404);
      if(user.role!=='admin'&&post.created_by!==user.id)fail('You can remove only your own Reliever post.',403);
      if(one('SELECT id FROM bookings WHERE reliever_post_id=?',postId))fail('A requested Reliever post cannot be removed.',409);
      run('UPDATE reliever_posts SET active=0 WHERE id=?',postId);
      return post;
    });
  }
  function requestBooking({doctorId,requesterId,date,start,end,note=''}) {
    if (!validWindow(date,start,end)) fail('Enter a valid date and a start time before the end time.');
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if (date<today) fail('Choose today or a future date in Philippine Time.');
    if (note.length > 500) fail('Note must be 500 characters or fewer.');
    return transaction(() => {
      if (!one("SELECT id FROM users WHERE id=? AND active=1 AND account_type IN ('doctor','admin')",doctorId)) fail('Doctor calendar is unavailable.',404);
      const slot=one('SELECT id,rate_cents,location FROM availability WHERE doctor_id=? AND date=? AND start_time<=? AND end_time>=?',doctorId,date,start,end);
      if (!slot) fail('This time is outside the doctor’s open availability.',409);
      if (one("SELECT id FROM bookings WHERE doctor_id=? AND date=? AND status='approved' AND start_time<? AND end_time>?",doctorId,date,end,start)) fail('This time is already booked.',409);
      if (one("SELECT id FROM bookings WHERE requester_id=? AND date=? AND status='approved' AND start_time<? AND end_time>?",requesterId,date,end,start)) fail('You already have a booking at this time.',409);
      if (one("SELECT id FROM bookings WHERE doctor_id=? AND requester_id=? AND date=? AND start_time=? AND end_time=? AND status='pending'",doctorId,requesterId,date,start,end)) fail('You already have a pending request for this time.',409);
      return Number(run("INSERT INTO bookings(doctor_id,requester_id,date,start_time,end_time,note,rate_cents,location,status) VALUES(?,?,?,?,?,?,?,?,'pending')",doctorId,requesterId,date,start,end,note.trim(),slot.rate_cents,slot.location).lastInsertRowid);
    });
  }
  function decideBooking(id,status,user) {
    if (!['approved','declined'].includes(status)) fail('Choose approve or decline.');
    return transaction(() => {
      const booking=one("SELECT * FROM bookings WHERE id=? AND status='pending'",id);
      if (!booking) fail('Pending request not found.',404);
      if(booking.approval_owner==='assignee'&&booking.requester_id!==user.id)fail('Only the assigned team member can answer this offer.',403);
      if(booking.approval_owner==='admin'&&user.role!=='admin')fail('Admin access required to decide this request.',403);
      if (status==='approved') {
        if (booking.approval_owner==='admin'&&!booking.reliever_post_id&&!one('SELECT id FROM availability WHERE doctor_id=? AND date=? AND start_time<=? AND end_time>=?',booking.doctor_id,booking.date,booking.start_time,booking.end_time)) fail('Availability has changed.',409);
        if (one("SELECT id FROM bookings WHERE doctor_id=? AND date=? AND status='approved' AND start_time<? AND end_time>?",booking.doctor_id,booking.date,booking.end_time,booking.start_time)) fail('This time is already booked.',409);
        if (one("SELECT id FROM bookings WHERE requester_id=? AND date=? AND status='approved' AND start_time<? AND end_time>?",booking.requester_id,booking.date,booking.end_time,booking.start_time)) fail('This team member already has a booking at this time.',409);
        run("UPDATE bookings SET status='declined',decided_at=CURRENT_TIMESTAMP WHERE (doctor_id=? OR requester_id=?) AND date=? AND status='pending' AND id<>? AND start_time<? AND end_time>?",booking.doctor_id,booking.requester_id,booking.date,id,booking.end_time,booking.start_time);
      }
      run('UPDATE bookings SET status=?,decided_at=CURRENT_TIMESTAMP WHERE id=?',status,id);
      return booking;
    });
  }
  function assignBooking({requesterId,date,endDate=date,start,end,note='',location='',rateCents}) {
    if (!validWindow(date,start,end,endDate)) fail('Enter a valid start and end date and time (up to 36 hours).');
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if (date<today) fail('Choose today or a future date in Philippine Time.');
    if (note.length>500) fail('Note must be 500 characters or fewer.');
    if (!location.trim()||location.length>120) fail('Enter a location of 120 characters or fewer.');
    if(!Number.isSafeInteger(rateCents)||rateCents<1)fail('Enter an hourly rate for this booking.');
    return transaction(()=>{
      if (!one("SELECT id FROM users WHERE id=? AND active=1 AND account_type<>'admin'",requesterId)) fail('Choose an active non-admin team member.',404);
      const startStamp=`${date}T${start}`,endStamp=`${endDate}T${end}`;
      if (one("SELECT id FROM bookings WHERE (doctor_id=? OR requester_id=?) AND status='approved' AND date||'T'||start_time<? AND COALESCE(NULLIF(end_date,''),date)||'T'||end_time>?",requesterId,requesterId,endStamp,startStamp)) fail('This team member already has a booking at this time.',409);
      if (one("SELECT id FROM bookings WHERE requester_id=? AND status='pending' AND approval_owner='assignee' AND date||'T'||start_time<? AND COALESCE(NULLIF(end_date,''),date)||'T'||end_time>?",requesterId,endStamp,startStamp)) fail('This team member already has a pending offer at this time.',409);
      const id=Number(run("INSERT INTO bookings(doctor_id,requester_id,date,end_date,start_time,end_time,note,rate_cents,location,approval_owner,status) VALUES(?,?,?,?,?,?,?,?,?,?,'pending')",requesterId,requesterId,date,endDate,start,end,note.trim(),rateCents,location.trim(),'assignee').lastInsertRowid);
      return id;
    });
  }
  function addPersonalShift({userId,date,endDate=date,start,end,note='',location='',rateCents}) {
    if (!validWindow(date,start,end,endDate)) fail('Enter a valid start and end date and time (up to 36 hours).');
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if (date<today) fail('Choose today or a future date in Philippine Time.');
    if (!location.trim()||location.length>120) fail('Enter a location of 120 characters or fewer.');
    if (note.length>500) fail('Note must be 500 characters or fewer.');
    if (!Number.isSafeInteger(rateCents)||rateCents<1) fail('Enter a valid hourly rate.');
    return transaction(()=>{
      const user=one('SELECT id FROM users WHERE id=? AND active=1 AND deleted_at IS NULL',userId);
      if(!user)fail('Your account is not active.',403);
      const startStamp=`${date}T${start}`,endStamp=`${endDate}T${end}`;
      if(one("SELECT id FROM bookings WHERE requester_id=? AND status IN ('pending','approved') AND date||'T'||start_time<? AND COALESCE(NULLIF(end_date,''),date)||'T'||end_time>?",userId,endStamp,startStamp))fail('This overlaps another shift or offer on your calendar.',409);
      return Number(run("INSERT INTO bookings(doctor_id,requester_id,date,end_date,start_time,end_time,note,rate_cents,location,approval_owner,status) VALUES(?,?,?,?,?,?,?,?,?,?,'approved')",userId,userId,date,endDate,start,end,note.trim(),rateCents,location.trim(),'admin').lastInsertRowid);
    });
  }
  function updatePersonalShift({bookingId,userId,date,endDate=date,start,end,note='',location='',rateCents}) {
    if(!validWindow(date,start,end,endDate))fail('Enter a valid start and end date and time (up to 36 hours).');
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    if(date<today)fail('Choose today or a future date in Philippine Time.');
    if(!location.trim()||location.length>120)fail('Enter a location of 120 characters or fewer.');
    if(note.length>500)fail('Note must be 500 characters or fewer.');
    if(!Number.isSafeInteger(rateCents)||rateCents<1)fail('Enter a valid hourly rate.');
    return transaction(()=>{
      const booking=one("SELECT id FROM bookings WHERE id=? AND requester_id=? AND doctor_id=? AND approval_owner='admin' AND reliever_post_id IS NULL AND status='approved'",bookingId,userId,userId);
      if(!booking)fail('This shift cannot be edited from My Calendar.',403);
      if(one('SELECT booking_id FROM attendance WHERE booking_id=?',bookingId))fail('A shift with a time record cannot be edited.',409);
      const startStamp=`${date}T${start}`,endStamp=`${endDate}T${end}`;
      if(one("SELECT id FROM bookings WHERE requester_id=? AND id<>? AND status IN ('pending','approved') AND date||'T'||start_time<? AND COALESCE(NULLIF(end_date,''),date)||'T'||end_time>?",userId,bookingId,endStamp,startStamp))fail('This overlaps another shift or offer on your calendar.',409);
      run("UPDATE bookings SET date=?,end_date=?,start_time=?,end_time=?,note=?,location=?,rate_cents=? WHERE id=? AND requester_id=? AND doctor_id=? AND approval_owner='admin' AND reliever_post_id IS NULL AND status='approved'",date,endDate,start,end,note.trim(),location.trim(),rateCents,bookingId,userId,userId);
      return bookingId;
    });
  }
  function cancelBooking(id, user) {
    return transaction(() => {
      const booking=one('SELECT * FROM bookings WHERE id=?',id);
      if (!booking) fail('Request not found.',404);
      if (user.role!=='admin' && booking.requester_id!==user.id) fail('You cannot cancel this request.',403);
      if (!['pending','approved'].includes(booking.status)) fail('This request cannot be cancelled.',409);
      if (one('SELECT booking_id FROM attendance WHERE booking_id=?',id)) fail('A shift with a time record cannot be cancelled.',409);
      run("UPDATE bookings SET status='cancelled',decided_at=CURRENT_TIMESTAMP WHERE id=?",id);
      return booking;
    });
  }
  return {db,one,all,run,transaction,fail,addAvailability,addRelieverPost,requestRelieverPost,removeRelieverPost,requestBooking,decideBooking,assignBooking,addPersonalShift,updatePersonalShift,cancelBooking};
}
