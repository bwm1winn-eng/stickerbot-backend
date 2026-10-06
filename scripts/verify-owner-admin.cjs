const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {createHmac,timingSafeEqual}=require('node:crypto');
const routes=new Map(),middleware=[];let calls=[],uid=42;
const app={use(...args){middleware.push(args);},post(p,h){routes.set(p,h);},get(){},listen(){}};
const express=()=>app;express.json=()=>()=>{};
const c=vm.createContext({express,cors:()=>()=>{},fetch:async()=>{throw Error('unexpected real request');},sharp(){},Buffer,URL,URLSearchParams,createHmac,timingSafeEqual,console:{log(){},warn(){},error(){}},process:{env:{OWNER_TELEGRAM_ID:'42',BOT_TOKEN:'fixture'}},setTimeout,clearTimeout});
vm.runInContext(fs.readFileSync('outputs/backend-release/server.js','utf8').replace(/^import[^\r\n]*(?:\r?\n|$)/gm,''),c);
c.extractUserId=()=>uid;c.supabaseRequest=async(p,o)=>{calls.push({p,o});if(p.startsWith('rpc/'))return{ok:true};if(p.startsWith('app_user_moderation'))return[{banned:true}];return[];};
async function request(path,body){let out={};const res={status(n){out.status=n;return this;},json(b){out.body=b;return this;}};await routes.get(path)({body},res);return out;}
(async()=>{
 for(uid of [0,84])for(const path of ['/api/admin/users','/api/admin/action']){calls=[];const r=await request(path,{action:'ban',targetUserId:90,isOwner:true,role:'admin'});assert.equal(r.status,uid?403:400);assert.equal(calls.length,0);}
 uid=42;for(const body of [{action:'ban',targetUserId:42},{action:'set-balance',targetUserId:90,amount:-1},{action:'grant-plan',targetUserId:90,tier:'ultimate',days:0},{action:'delete-everything',targetUserId:90},{action:'ban',targetUserId:'1&select=*'}]){calls=[];assert.equal((await request('/api/admin/action',{requestId:'a-valid-request-123',...body})).status,400);assert.equal(calls.length,0);}
 calls=[];await request('/api/admin/action',{action:'grant-plan',targetUserId:90,tier:'ultimate',days:30,reason:'test',requestId:'a-valid-request-123'});assert.equal(calls.length,1);assert.equal(calls[0].p,'rpc/account_admin_action');assert.equal(JSON.parse(calls[0].o.body).p_actor,42);
 assert.equal(await c.isAccountBanned(42),false);assert.equal(await c.isAccountBanned(84),true);
 uid=84;let denied,next=false;await c.accountAccessGuard({body:{initData:'fixture'}},{status(n){denied=n;return this;},json(){return this;}},()=>next=true);assert.equal(denied,403);assert.equal(next,false);
 uid=42;await c.accountAccessGuard({body:{initData:'fixture'}},{status(){throw Error('owner denied');}},()=>next=true);assert.equal(next,true);
 assert.ok(middleware.some(a=>a[0]==='/api'));
 assert.equal(c.isOwnerUser(84),false);c.process.env.OWNER_TELEGRAM_ID='';assert.equal(c.isOwnerUser(0),false);c.process.env.OWNER_TELEGRAM_ID='not-an-id';assert.equal(c.isOwnerUser(42),false);
 console.log('PASS owner-only authorization, role spoof refusal, invalid inputs, self-ban prevention, moderation enforcement and missing-owner fail closed. No live requests.');
})().catch(e=>{console.error(e);process.exitCode=1;});
