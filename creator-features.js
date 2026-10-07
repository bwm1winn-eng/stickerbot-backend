import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { normalizeSticker, stickerBackground } from './sticker-background.js';

const EMOTIONS = ['happy smile','sad with tears','surprised wow','in love with hearts','angry frown','playful wink','laughing','crying','sleepy yawn','thinking','confused','proud','celebrating','shy blush','scared','bored','excited','suspicious','facepalm','thumbs up','thankful','apologetic','determined','goodbye waving'];
const EMOJIS=['😀','😢','😮','😍','😠','😉','😂','😭','🥱','🤔','😕','😎','🥳','😊','😨','😑','🤩','🤨','🤦','👍','🙏','😔','💪','👋'];
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PACK=/^[A-Za-z0-9_]{1,64}$/;

export function createCreatorFeatures(d) {
  const db=d.supabaseRequest, cache=d.generatedCache; let working=false, timer;
  const rpc=(name,body)=>db('rpc/'+name,{method:'POST',body:JSON.stringify(body)});
  const api=async(req)=>{const id=d.extractUserId(req.body?.initData);if(!id){const e=new Error('Open inside Telegram');e.status=401;throw e;}return id;};
  const route=(fn)=>async(req,res)=>{try{await fn(req,res);}catch(e){const status=e.dbCode==='42501'?403:e.dbCode==='22023'||e.dbCode==='P0001'?409:e.code==='INVALID_BACKGROUND'?400:e.status||500; console.warn('Creator action unavailable:',e.code||e.dbCode||'CREATOR_ERROR');res.status(status).json({error:status>=500?'Action temporarily unavailable':e.message,code:e.code||'CREATOR_ACTION_FAILED'});}};
  async function packAccess(userId,shortName,ownerOnly=false){
    if(typeof shortName!=='string'||!PACK.test(shortName))return null;
    const [pack]=await db(`sticker_packs?short_name=eq.${encodeURIComponent(shortName)}&select=short_name,title,user_id`);
    if(!pack)return null;if(pack.user_id===userId)return {...pack,role:'owner'};
    if(ownerOnly)return null;
    const members=await db(`sticker_pack_members?pack_short_name=eq.${encodeURIComponent(shortName)}&user_id=eq.${userId}&removed_at=is.null&select=user_id`);
    return members?.length?{...pack,role:'contributor'}:null;
  }
  async function accessiblePacks(userId){
    const owned=await db(`sticker_packs?user_id=eq.${userId}&select=short_name,title`);
    const members=await db(`sticker_pack_members?user_id=eq.${userId}&removed_at=is.null&select=pack_short_name`);
    const names=(members||[]).slice(0,100).map(m=>m.pack_short_name).filter(name=>PACK.test(name));
    const shared=names.length?(await db(`sticker_packs?short_name=in.(${names.join(',')})&select=short_name,title`)).map(p=>({...p,role:'contributor'})):[];
    return [...(owned||[]).map(p=>({...p,role:'owner'})),...shared];
  }
  async function putAsset(userId,buffer){
    const id=randomBytes(24).toString('hex'),expiresAt=Date.now()+86400_000;
    await db('creator_assets',{method:'POST',body:JSON.stringify({id,user_id:userId,image_data:buffer.toString('base64'),expires_at:new Date(expiresAt).toISOString()})});
    remember(id,{userId,buffer,expiresAt});return id;
  }
  function remember(id,asset){cache.set(id,asset);let bytes=0;for(const [key,item]of cache){if(item.expiresAt<=Date.now()){cache.delete(key);continue;}bytes+=item.buffer?.length||0;}while(bytes>48*1024*1024&&cache.size){const key=cache.keys().next().value;bytes-=cache.get(key).buffer?.length||0;cache.delete(key);}}
  async function getAsset(id,userId=null){
    if(typeof id!=='string'||!/^[a-f0-9]{48}$/.test(id))return null;
    let asset=cache.get(id);if(asset?.expiresAt<=Date.now()){cache.delete(id);asset=null;}
    if(!asset){const rows=await db(`creator_assets?id=eq.${id}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=user_id,image_data,expires_at`);if(!rows?.length)return null;asset={userId:rows[0].user_id,buffer:Buffer.from(rows[0].image_data,'base64'),expiresAt:Date.parse(rows[0].expires_at)};remember(id,asset);}
    return userId!==null&&asset.userId!==userId?null:asset.buffer;
  }
  async function makePack(userId,title,ids,key=randomUUID(),emojis=[]){
    const buffers=[];for(const id of ids){const b=await getAsset(id,userId);if(!b)throw Object.assign(new Error('Sticker expired; generate or upload again'),{status:410});buffers.push(b);}
    const suffix='_by_'+await d.getBotUsername();
    const prefix='pack_'+createHash('sha256').update(userId+':'+key).digest('hex').slice(0,24);
    const shortName=prefix.slice(0,64-suffix.length).replace(/_+$/,'')+suffix;
    try{await d.createStickerSet(userId,shortName,title,buffers,emojis);}catch(error){
      // A lost create response can be recovered by its deterministic, random name.
      if(!/already|occupied/i.test(error.message))throw error;
      await d.telegramApi('getStickerSet',{name:shortName});
    }
    await db('sticker_packs?on_conflict=short_name',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates'},body:JSON.stringify({short_name:shortName,user_id:userId,title})});
    d.invalidateStickerSetCache(shortName);return 'https://t.me/addstickers/'+shortName;
  }
  async function saveRequest(req,res){
    const userId=await api(req),body=req.body,key=body.requestId||randomUUID();
    const ids=Array.isArray(body.stickers)?[...new Set(body.stickers.map(s=>s?.id))]:[];
    if(!UUID.test(key)||!ids.length||ids.length>24||ids.some(id=>typeof id!=='string'))return res.status(400).json({error:'Choose between one and 24 stickers'});
    const title=typeof body.packName==='string'?body.packName.trim():'';
    const target=body.targetPackShortName||null;
    if(!target&&(!title||title.length>64))return res.status(400).json({error:'Pack title must contain 1–64 characters'});
    const pack=target?await packAccess(userId,target):null;if(target&&!pack)return res.status(403).json({error:'Pack access denied'});
    const buffers=[];for(const id of ids){const b=await getAsset(id,userId);if(!b)return res.status(410).json({error:'Sticker expired; generate or upload again'});buffers.push(b);}
    const claim=await rpc('creator_pack_begin',{p_user_id:userId,p_key:key,p_payload:{ids,title,target}});
    if(!claim.claimed){if(claim.state==='completed')return res.json(claim.result);return res.status(409).json({error:'Save already submitted',code:'PACK_SAVE_PENDING'});}
    try{
      let link;if(pack){for(const buffer of buffers){if(!await packAccess(userId,target))throw Object.assign(new Error('Pack access revoked'),{status:403});await d.addStickerToSet(pack.user_id,target,buffer);}d.invalidateStickerSetCache(target);link='https://t.me/addstickers/'+target;}else link=await makePack(userId,title,ids,key);
      const result={ok:true,packLink:link};await db(`creator_pack_operations?request_key=eq.${key}`,{method:'PATCH',body:JSON.stringify({state:'completed',result})});res.json(result);
    }catch(error){await db(`creator_pack_operations?request_key=eq.${key}`,{method:'PATCH',body:JSON.stringify({state:'failed',result:{error:'Save could not be confirmed'}})}).catch(()=>{});throw error;}
  }
  const publicJob=(job)=>({id:job.id,state:job.state,attempted:job.attempted,total:24,cost:job.cost,charged:job.images.length*2,images:job.images,packLink:job.pack_link,packError:job.pack_error});
  async function work(){
    if(working)return;working=true;
    try{let job;while((job=await rpc('creator_job_claim',{}))){
      const images=[];let state='completed',link=null,packError=null;
      try{
        for(let i=0;i<24;i++){
          const [fresh]=await db(`creator_jobs?id=eq.${job.id}&select=state`);if(fresh?.state!=='running'){state='cancelled';break;}
          if(await d.isAccountBanned(job.user_id)){state='interrupted';break;}
          await db(`creator_jobs?id=eq.${job.id}&state=eq.running`,{method:'PATCH',body:JSON.stringify({lease_until:new Date(Date.now()+180000).toISOString()})});
          const result=await d.generateStickerSet(`${job.payload.prompt}, ${EMOTIONS[i]}, single character, same character design and clothing throughout this collection`,1,null,{cfg:d.TIERS.ultimate,style:job.payload.style,background:stickerBackground(job.payload.background,job.payload.color),userId:job.user_id});
          if(result.length)images.push({...result[0],emotion:EMOTIONS[i],emoji:EMOJIS[i]});
          await db(`creator_jobs?id=eq.${job.id}&state=eq.running`,{method:'PATCH',body:JSON.stringify({attempted:i+1,images,lease_until:new Date(Date.now()+180000).toISOString()})});
        }
        if(images.length&&state==='completed'){try{link=await makePack(job.user_id,job.payload.title,images.map(s=>s.id),job.id,images.map(s=>s.emoji));}catch{packError='Pack could not be saved automatically. Your images remain available.';}}
      }catch{state='interrupted';}
      await rpc('creator_job_finish',{p_id:job.id,p_state:state,p_pack_link:link,p_pack_error:packError});
    }}catch(error){console.warn('Creator queue unavailable:',error.dbCode||error.code||'QUEUE_ERROR');}finally{working=false;}
  }
  function register(app){
    app.get('/api/creator/status',(_req,res)=>res.json({version:'2026-10-07-creator',uploadMaxBytes:4*1024*1024,assetRetentionHours:24,automaticPack:{tier:'ultimate',count:24,maxCost:48},backgrounds:['white','black','color','transparent'],sharedPacks:true,dailySubscriptionCoins:false}));
    app.post('/api/add-to-pack',route(saveRequest));
    app.post('/api/packs/invite',route(async(req,res)=>{const userId=await api(req),token=randomBytes(32).toString('base64url');const data=await rpc('creator_invite_create',{p_user_id:userId,p_pack:req.body.shortName,p_hash:createHash('sha256').update(token).digest('hex')});const bot=await d.getBotUsername();res.json({...data,link:`https://t.me/${bot}?start=pack_${token}`});}));
    app.post('/api/packs/join',route(async(req,res)=>{const userId=await api(req);if(typeof req.body.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(req.body.token))return res.status(400).json({error:'Invalid invitation'});res.json(await rpc('creator_invite_join',{p_user_id:userId,p_hash:createHash('sha256').update(req.body.token).digest('hex')}));}));
    app.post('/api/packs/members',route(async(req,res)=>{const userId=await api(req);if(!await packAccess(userId,req.body.shortName,true))return res.status(403).json({error:'Owner access required'});res.json({members:await db(`sticker_pack_members?pack_short_name=eq.${encodeURIComponent(req.body.shortName)}&removed_at=is.null&select=user_id,joined_at`)});}));
    app.post('/api/packs/remove-member',route(async(req,res)=>{const userId=await api(req),member=Number(req.body.memberId);if(!Number.isSafeInteger(member)||member<=0)return res.status(400).json({error:'Invalid member'});res.json({ok:await rpc('creator_member_remove',{p_user_id:userId,p_pack:req.body.shortName,p_member:member})});}));
    app.post('/api/packs/revoke-invite',route(async(req,res)=>{const userId=await api(req);if(!await packAccess(userId,req.body.shortName,true))return res.status(403).json({error:'Owner access required'});await db(`sticker_pack_invites?pack_short_name=eq.${encodeURIComponent(req.body.shortName)}&revoked_at=is.null`,{method:'PATCH',body:JSON.stringify({revoked_at:new Date().toISOString()})});res.json({ok:true});}));
    app.post('/api/stickers/upload',route(async(req,res)=>{const userId=await api(req);const recent=await db(`creator_assets?user_id=eq.${userId}&created_at=gt.${encodeURIComponent(new Date(Date.now()-3600000).toISOString())}&select=id&limit=100`);if(recent.length>=100)return res.status(429).json({error:'Please wait before uploading more images'});const text=req.body.data;if(typeof text!=='string'||text.length>Math.ceil(4*1024*1024/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(text))return res.status(400).json({error:'Choose a PNG, JPEG or WebP image under 4 MB'});const buffer=Buffer.from(text,'base64');if(buffer.length>4*1024*1024)return res.status(413).json({error:'Image too large'});const normalized=await normalizeSticker(buffer,stickerBackground(),{upload:true});const id=await putAsset(userId,normalized);res.json({id,url:'/api/image/'+id,animated:false});}));
    app.post('/api/packs/jobs/start',route(async(req,res)=>{const userId=await api(req),body=req.body;const background=stickerBackground(body.background,body.color);if(typeof body.prompt!=='string'||!body.prompt.trim()||body.prompt.length>4000||typeof body.title!=='string'||!body.title.trim()||body.title.length>64||!UUID.test(body.requestId)||!Object.hasOwn(d.STICKER_ART_STYLES,body.style))return res.status(400).json({error:'Invalid pack request'});const payload={prompt:body.prompt.trim(),title:body.title.trim(),style:body.style,background:background.mode,color:background.color};const result=await rpc('creator_job_start',{p_user_id:userId,p_id:body.requestId,p_payload:payload,p_expected_cost:body.expectedCost});res.json(result);setImmediate(work);}));
    app.post('/api/packs/jobs/status',route(async(req,res)=>{const userId=await api(req);const filter=UUID.test(req.body.id||'')?`id=eq.${req.body.id}&`:'state=in.(queued,running)&';const jobs=await db(`creator_jobs?${filter}user_id=eq.${userId}&select=*&order=created_at.desc&limit=1`);res.json({job:jobs?.length?publicJob(jobs[0]):null,balance:await d.getOrCreateBalance(userId)});setImmediate(work);}));
    app.post('/api/packs/jobs/cancel',route(async(req,res)=>{const userId=await api(req);if(!UUID.test(req.body.id||''))return res.status(400).json({error:'Invalid job'});const [job]=await db(`creator_jobs?id=eq.${req.body.id}&user_id=eq.${userId}&select=id,state`);if(!job)return res.status(404).json({error:'Job unavailable'});if(job.state==='running')return res.status(409).json({error:'Running generation must finish its current attempt'});res.json(await rpc('creator_job_finish',{p_id:job.id,p_state:'cancelled'}));}));
  }
  function start(){timer=setInterval(work,15_000);timer.unref();setImmediate(work);const cleanup=setInterval(()=>{db(`creator_assets?expires_at=lt.${encodeURIComponent(new Date().toISOString())}`,{method:'DELETE'}).catch(()=>{});db(`creator_jobs?state=in.(completed,interrupted,cancelled)&finished_at=lt.${encodeURIComponent(new Date(Date.now()-30*86400000).toISOString())}`,{method:'DELETE'}).catch(()=>{});db(`creator_pack_operations?state=eq.completed&created_at=lt.${encodeURIComponent(new Date(Date.now()-30*86400000).toISOString())}`,{method:'DELETE'}).catch(()=>{});},3600_000);cleanup.unref();}
  return {register,start,packAccess,accessiblePacks,putAsset,getAsset,saveRequest,makePack};
}
