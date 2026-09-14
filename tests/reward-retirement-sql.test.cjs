const assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const read=file=>fs.readFileSync('supabase/'+file,'utf8');
(async()=>{
 const db=new PGlite();
 try{
 await db.exec("create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select null::uuid$$;");
 for(const file of ['reward_requests.sql','admin_setup.sql','reward_sats_migration.sql'])await db.exec(read(file));
 await db.exec("create table rewards(id int);insert into rewards values(42);create table attendances(id int);insert into attendances values(43);");
 const migration=read('migrations/202609140001_retire_reward_requests.sql');
 const confirmed=migration.replace("backup_confirmed = 'no'","backup_confirmed = 'yes'");
 await db.exec("insert into reward_requests(store_name,purchase_date,purchase_amount,customer_name,email,lightning_destination) values('쿠팡','2026-01-01',100,'Test','test@example.com','test@wallet.com')");
 async function blocked(sql,pattern){await assert.rejects(db.exec(sql),pattern);await db.exec('rollback');assert.equal((await db.query('select count(*)::int n from reward_requests')).rows[0].n,1);}
 await blocked(migration,/backup/);
 await db.exec('create view dependent_view as select * from reward_requests');
 await blocked(confirmed,/depend/);await db.exec('drop view dependent_view');
 await db.exec('create table dependent_fk(id uuid references reward_requests(id))');
 await blocked(confirmed,/Foreign keys/);await db.exec('drop table dependent_fk');
 await db.exec('create trigger shared_validator before update on rewards for each row execute function validate_reward_status_transition()');
 await blocked(confirmed,/another table/);await db.exec('drop trigger shared_validator on rewards');
 await db.exec('create policy unexpected_policy on reward_requests for select using(true)');
 await blocked(confirmed,/Unexpected RLS/);await db.exec('drop policy unexpected_policy on reward_requests');
 await db.exec("create function legacy_reader() returns bigint language plpgsql as $$begin return (select count(*) from reward_requests);end$$");
 await blocked(confirmed,/Another routine/);await db.exec('drop function legacy_reader()');
 await db.exec(confirmed);
 assert.equal((await db.query("select to_regclass('public.reward_requests') as t,to_regprocedure('public.validate_reward_status_transition()') as f")).rows[0].t,null);
 assert.equal((await db.query("select to_regprocedure('public.validate_reward_status_transition()') as f")).rows[0].f,null);
 assert.equal((await db.query('select id from rewards')).rows[0].id,42);
 assert.equal((await db.query('select id from attendances')).rows[0].id,43);
 assert.equal((await db.query("select count(*)::int n from pg_policies where tablename='admin_users'")).rows[0].n,1);
 await db.exec(migration);
 console.log('PASS retirement: backup guard, dependency rollback, repeat execution, protected tables/admin RLS');
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
