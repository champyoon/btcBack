const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const read = file => fs.readFileSync(path.join(__dirname,'..','supabase',file),'utf8');
const migration = read('migrations/202609150001_attendance_rpc.sql');
const a='11111111-1111-4111-8111-111111111111', b='22222222-2222-4222-8222-222222222222';
const pending='33333333-3333-4333-8333-333333333333', blocked='44444444-4444-4444-8444-444444444444', missing='55555555-5555-4555-8555-555555555555';
(async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
   create function auth.uid() returns uuid language sql stable as
   $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to anon,authenticated;`);
  await db.exec(read('admin_access.sql'));await db.exec(read('migrations/202609090001_membership_identity.sql'));
  // Isolated intended-schema fixtures, NOT an export of the uninspected live DB.
  await db.exec(`create table public.attendances(
   id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles(id),
   attendance_date date not null,created_at timestamptz not null default now(),
   constraint attendance_day_unique unique(user_id,attendance_date));
   create table public.rewards(
   id uuid primary key default gen_random_uuid(),user_id uuid not null references profiles(id),
   source_type text not null check(source_type in ('ATTENDANCE','SHOPPING')),merchant text,
   source_txn_key text not null constraint reward_txn_unique unique,
   purchase_amount bigint,purchase_currency text,amount_sats bigint not null check(amount_sats>0),
   status text not null check(status in ('PENDING','CONFIRMED','CANCELLED')),
   confirm_eligible_at timestamptz,confirmed_at timestamptz,
   created_at timestamptz not null default now(),updated_at timestamptz not null default now());
   alter table attendances enable row level security;alter table rewards enable row level security;
   revoke all on attendances,rewards from public,anon,authenticated;
   grant select on attendances,rewards to authenticated;
   create policy attendance_self on attendances for select to authenticated using(user_id=auth.uid());
   create policy reward_self on rewards for select to authenticated using(user_id=auth.uid());`);
  async function rejectedMigration(pattern){await assert.rejects(db.exec(migration),pattern);await db.exec('rollback');assert.equal((await db.query("select to_regprocedure('public.check_attendance()') f")).rows[0].f,null);}
  await db.exec('alter table attendances drop constraint attendance_day_unique');
  await rejectedMigration(/UNIQUE\(user_id, attendance_date\)/);
  await db.exec('alter table attendances add constraint attendance_day_unique unique(user_id,attendance_date)');
  await db.exec('alter table rewards drop constraint reward_txn_unique');
  await rejectedMigration(/UNIQUE\(source_txn_key\)/);
  await db.exec('alter table rewards add constraint reward_txn_unique unique(source_txn_key)');
  await db.exec('alter table rewards disable row level security');await rejectedMigration(/RLS must/);
  await db.exec('alter table rewards enable row level security');
  await db.exec('create policy unsafe_insert on rewards for insert to authenticated with check(true)');
  await rejectedMigration(/Client write policy/);await db.exec('drop policy unsafe_insert on rewards');
  await db.exec('grant truncate on rewards to authenticated');await rejectedMigration(/Unsafe client privileges/);
  await db.exec('revoke truncate on rewards from authenticated');
  for(const id of [a,b,pending,blocked])await db.query('insert into auth.users values($1,$2,now())',[id,`${id}@example.test`]);
  await db.exec(`update profiles set member_status='APPROVED' where id in ('${a}','${b}');update profiles set member_status='BLOCKED' where id='${blocked}';`);
  await db.exec(`insert into attendances(user_id,attendance_date) values('${a}','2026-09-01');
   insert into rewards(user_id,source_type,source_txn_key,amount_sats,status,confirmed_at)
   values('${a}','ATTENDANCE','ATTENDANCE:${a}:20260901',100,'CONFIRMED',now()),
   ('${a}','SHOPPING','existing-shopping',2150,'PENDING',null);`);
  const snapshot=async()=>({
   rewards:(await db.query('select * from rewards order by id')).rows,
   attendances:(await db.query('select * from attendances order by id')).rows,
   profiles:(await db.query('select * from profiles order by id')).rows,
   policies:(await db.query("select * from pg_policies where tablename in ('attendances','rewards','profiles','admin_users') order by tablename,policyname")).rows
  });
  const before=await snapshot();await db.exec(migration);assert.deepEqual(await snapshot(),before);
  const definition=(await db.query("select pg_get_functiondef('public.check_attendance()'::regprocedure) d")).rows[0].d;
  // Only the isolated test DB substitutes the clock; production RPC has no inputs.
  const clock=async instant=>db.exec(definition.replace('pg_catalog.statement_timestamp()',`'${instant}'::timestamptz`));
  async function asRole(role,user,sql='select public.check_attendance() result'){
   await db.exec(`begin;set local role ${role};`);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
   try{const result=sql.includes(';')?await db.exec(sql):await db.query(sql);await db.exec('commit');return result.rows;}catch(error){await db.exec('rollback');throw error;}
  }
  await clock('2026-09-15T00:00:00Z');
  const first=(await asRole('authenticated',a))[0].result;
  assert.deepEqual(first,{success:true,already_attended:false,attendance_date:'2026-09-15',reward_sats:100});
  const reward=(await db.query('select * from rewards where source_txn_key=$1',[`ATTENDANCE:${a}:20260915`])).rows[0];
  assert.equal(reward.user_id,a);assert.equal(reward.source_type,'ATTENDANCE');assert.equal(reward.status,'CONFIRMED');assert.equal(Number(reward.amount_sats),100);
  for(const field of ['merchant','purchase_amount','purchase_currency','confirm_eligible_at'])assert.equal(reward[field],null);
  assert.equal(reward.confirmed_at.toISOString(),'2026-09-15T00:00:00.000Z');
  assert.deepEqual(reward.created_at,reward.confirmed_at);assert.deepEqual(reward.updated_at,reward.confirmed_at);
  assert.deepEqual((await db.query("select created_at from attendances where user_id=$1 and attendance_date='2026-09-15'",[a])).rows[0].created_at,reward.created_at);
  const repeat=(await asRole('authenticated',a))[0].result;
  assert.deepEqual(repeat,{success:true,already_attended:true,attendance_date:'2026-09-15',reward_sats:0});
  await clock('2026-09-16T00:00:00Z');
  // PGlite queues operations on one connection; this tests bursts, not parallel sessions.
  await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[a]);
  const burst=await Promise.all(Array.from({length:12},()=>db.query('select public.check_attendance() result')));
  await db.exec('reset role');
  assert.equal(burst.filter(r=>!r.rows[0].result.already_attended).length,1);
  assert.equal(burst.reduce((sum,r)=>sum+r.rows[0].result.reward_sats,0),100);
  assert.equal((await db.query("select count(*)::int n from attendances where attendance_date='2026-09-16'")).rows[0].n,1);
  for(const zone of ['UTC','America/New_York','Asia/Seoul']){
   await db.exec(`set timezone='${zone}'`);
   for(const [instant,day] of [['2026-09-14T20:59:59Z','2026-09-14'],['2026-09-14T21:00:00Z','2026-09-15'],['2026-12-31T21:00:00Z','2027-01-01']]){
    assert.equal((await db.query('select public.attendance_logical_date($1)::text d',[instant])).rows[0].d,day);
   }
  }
  await clock('2026-09-14T20:59:59Z');assert.equal((await asRole('authenticated',b))[0].result.attendance_date,'2026-09-14');
  await clock('2026-09-14T21:00:00Z');assert.equal((await asRole('authenticated',b))[0].result.reward_sats,100);
  for(const [role,user,code] of [['anon','', '42501'],['authenticated','', '28000'],['authenticated',pending,'42501'],['authenticated',blocked,'42501'],['authenticated',missing,'42501']]){
   const snap=await snapshot();await assert.rejects(asRole(role,user),{code});assert.deepEqual(await snapshot(),snap);
  }
  for(const sql of ["insert into attendances(user_id,attendance_date) values('"+a+"',current_date)",
   "insert into rewards(user_id,source_type,source_txn_key,amount_sats,status) values('"+a+"','ATTENDANCE','fake',999,'CONFIRMED')",
   "update rewards set amount_sats=999",'delete from attendances',"select public.attendance_logical_date(now())"])
   await assert.rejects(asRole('authenticated',a,sql),{code:'42501'});
  await assert.rejects(asRole('authenticated',pending,`create temp table profiles(id uuid,member_status text);insert into profiles values('${pending}','APPROVED');select public.check_attendance()`),{code:'42501'});
  await assert.rejects(asRole('authenticated',a,`select public.check_attendance('${b}'::uuid)`),{code:'42883'});
  await clock('2026-09-18T00:00:00Z');
  await db.exec("create function public.test_reward_fail() returns trigger language plpgsql as $$begin raise exception 'test failure' using errcode='23514';end$$;create trigger test_failure before insert on rewards for each row execute function public.test_reward_fail();");
  const preFailure=await snapshot();await assert.rejects(asRole('authenticated',a),{code:'23514'});assert.deepEqual(await snapshot(),preFailure);
  await db.exec('drop trigger test_failure on rewards;drop function public.test_reward_fail()');
  await db.exec(`insert into rewards(user_id,source_type,source_txn_key,amount_sats,status,confirmed_at) values('${a}','ATTENDANCE','ATTENDANCE:${a}:20260918',100,'CONFIRMED',now())`);
  const orphan=await snapshot();await assert.rejects(asRole('authenticated',a),{code:'23505'});assert.deepEqual(await snapshot(),orphan);
  await db.exec(`insert into attendances(user_id,attendance_date) values('${a}','2026-09-19')`);await clock('2026-09-19T00:00:00Z');
  const unmatched=await snapshot();await assert.rejects(asRole('authenticated',a),/Attendance reward mismatch/);assert.deepEqual(await snapshot(),unmatched);
  const security=(await db.query("select prosecdef,pronargs,proconfig from pg_proc where oid='public.check_attendance()'::regprocedure")).rows[0];
  assert.equal(security.prosecdef,true);assert.equal(security.pronargs,0);assert.ok(security.proconfig.includes('search_path=""'));
  assert.ok(definition.includes('FOR UPDATE')||definition.includes('for update'));assert.match(definition,/on conflict \(user_id,attendance_date\) do nothing/i);
  console.log('PASS Attendance RPC: schema guards, APPROVED/auth/ACL, dates/timezones, fixed 100 sats, repeat/burst, atomic rollback, old data preservation, no client writes');
 }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
