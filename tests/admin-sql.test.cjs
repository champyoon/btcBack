const assert=require('node:assert/strict'), fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
(async()=>{
 const db=new PGlite();
 try{
 await db.exec("create role anon; create role authenticated; create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;");
 await db.exec(fs.readFileSync('supabase/admin_access.sql','utf8'));
 const id='11111111-1111-4111-8111-111111111111';
 await db.exec(`insert into auth.users values ('${id}');insert into admin_users(user_id,email) values ('${id}','admin@example.com');`);
 async function role(name,sql,user=''){
 await db.exec('begin;set local role '+name);
 await db.query("select set_config('request.jwt.claim.sub',$1,true)",[user]);
 try{return await db.query(sql);}finally{await db.exec('rollback');}
 }
 await assert.rejects(role('anon','select * from admin_users'));
 assert.equal((await role('authenticated','select * from admin_users')).rows.length,0);
 assert.equal((await role('authenticated','select * from admin_users',id)).rows.length,1);
 for(const r of ['anon','authenticated']) for(const sql of ["update admin_users set email='x'",'delete from admin_users',`insert into admin_users values ('${id}','x',now())`]) await assert.rejects(role(r,sql,id));
 await db.exec('delete from admin_users');
 assert.equal((await role('authenticated','select * from admin_users',id)).rows.length,0);
 console.log('PASS admin RLS, no membership escalation, revocation');
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
