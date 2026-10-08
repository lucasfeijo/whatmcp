import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadConfig, DATA_DIR, CONFIG_PATH, type Config } from '../config.ts';
import { openStore, openStoreRO } from '../db/index.ts';
import { searchHybrid, listThreads, listPeople, getConversation, listMessageFeed, stats } from '../search/search.ts';
import { mediaPath } from '../transcription/media.ts';
import { configSnapshot, saveSettings } from './settings.ts';
import { seedDemo, demoVector } from './demo.ts';
import { closeStores } from '../store.ts';
import { setupReadiness } from './readiness.ts';

const query=z.object({query:z.string().trim().min(1).max(2000),mode:z.enum(['hybrid','bm25','vector']).default('hybrid'),thread:z.string().max(300).optional(),sender:z.string().max(300).optional(),threadId:z.string().max(300).optional(),senderId:z.string().max(300).optional(),after:z.number().int().optional(),before:z.number().int().optional(),kind:z.enum(['all','text','audio']).default('all'),limit:z.number().int().min(1).max(100).default(40)}).strict();
type Job={id:string;kind:string;messageId?:string;retry?:boolean;state:'running'|'done'|'failed'|'cancelled'|'interrupted';startedAt:number;finishedAt?:number;detail:string;done?:number;total?:number;};
export class DesktopService {
  readonly demo:boolean;private active:ChildProcess|null=null;private jobs:Job[]=[];private leaseEnd=0;private leaseDeadline=0;private watchdog?:NodeJS.Timeout;
  constructor(){
    this.demo=process.env.WHATMCP_DESKTOP_MODE==='demo';
    if(this.demo)seedDemo(DATA_DIR);
    else if(process.env.WHATMCP_DESKTOP_MODE==='archive'&&!existsSync(join(DATA_DIR,'archive.db')))openStore(join(DATA_DIR,'archive.db')).close();
    const history=join(DATA_DIR,'desktop-jobs.json');
    if(existsSync(history)){try{this.jobs=JSON.parse(readFileSync(history,'utf8')).slice(0,30).map((j:Job)=>j.state==='running'?{...j,state:'interrupted',detail:'App closed before completion; completed archive work is preserved.'}:j);}catch{this.jobs=[];}}
  }
  private cfg():Config {const cfg=loadConfig();if(process.platform==='darwin'&&!this.demo)cfg.mediaRoots={...cfg.mediaRoots,macos:join(DATA_DIR,'media','macos')};return cfg;}
  private ctx(){const cfg=this.cfg();return {storePath:cfg.store,embedCfg:{model:cfg.openaiModel,dimensions:cfg.openaiDims,apiKey:this.demo?'':cfg.openaiKey??''}};}
  private persist(){mkdirSync(DATA_DIR,{recursive:true,mode:0o700});writeFileSync(join(DATA_DIR,'desktop-jobs.json'),JSON.stringify(this.jobs.slice(0,30)),{mode:0o600});}
  private redact(text:string){const key=this.cfg().openaiKey;return (key?text.split(key).join('[credential]'):text).replace(/sk-[A-Za-z0-9_-]+/g,'[credential]').slice(-2000);}
  private audio(){const db=openStoreRO(this.cfg().store);try{return db.prepare(`SELECT m.id,m.thread_id,t.title thread_title,m.ts,m.text,m.kind,COALESCE(s.display_name,'Você') sender_name,a.availability,a.duration_s,
    CASE WHEN EXISTS(SELECT 1 FROM audio_transcripts x WHERE x.message_id=m.id AND x.audio_sha256=a.sha256 AND x.status IN ('done','no_speech')) THEN 1 ELSE 0 END done,
    (SELECT status FROM audio_transcripts x WHERE x.message_id=m.id AND x.audio_sha256=a.sha256 ORDER BY updated_at DESC LIMIT 1) transcription_status
    FROM messages m JOIN threads t ON t.id=m.thread_id LEFT JOIN senders s ON s.id=m.sender_id LEFT JOIN audio_media a ON a.message_id=m.id WHERE m.kind='audio' ORDER BY m.ts DESC LIMIT 500`).all();}finally{db.close();}}
  async call(method:string,raw:unknown={}) :Promise<unknown>{
    const p=(raw??{}) as Record<string,any>;
    switch(method){
      case 'overview':{
        const ctx=this.ctx(),summary=stats(ctx),cfg=this.cfg();const db=openStoreRO(cfg.store);
        try{const count=(sql:string,...a:any[])=>Number((db.prepare(sql).get(...a) as any)?.n??0);
          const model=`openai/${cfg.openaiModel}@${cfg.openaiDims}`;
          const pending=`SELECT w.id FROM windows w LEFT JOIN window_vectors v ON v.content_hash=w.content_hash AND v.model=? WHERE v.content_hash IS NULL`;
          const missing=count(`SELECT COUNT(*) n FROM windows WHERE id IN (${pending})`,model);
          const affected=count(`SELECT COUNT(DISTINCT m.id) n FROM messages m JOIN windows w ON w.thread_id=m.thread_id AND m.ts BETWEEN w.start_ts AND w.end_ts WHERE w.id IN (${pending})`,model);
          const pendingAudio=`m.kind='audio' AND NOT EXISTS(SELECT 1 FROM audio_transcripts x LEFT JOIN audio_media a ON a.message_id=m.id WHERE x.message_id=m.id AND x.audio_sha256=a.sha256 AND x.status IN ('done','no_speech'))`;
          const audioPending=count(`SELECT COUNT(*) n FROM messages m WHERE ${pendingAudio}`);
          const audioAvailable=count(`SELECT COUNT(*) n FROM messages m JOIN audio_media a ON a.message_id=m.id WHERE ${pendingAudio} AND a.availability='available'`);
          return {...summary,pendingSegments:missing,affectedMessages:affected,audioPending,audioAvailable,audioUnavailable:audioPending-audioAvailable,jobs:this.jobs,captureExpiresAt:this.leaseEnd,platform:process.platform,demo:this.demo,profile:DATA_DIR,keyConfigured:!!cfg.openaiKey,transcriptionModel:cfg.transcriptionModel??null};
        }finally{db.close();}
      }
      case 'threads':return listThreads(this.ctx(),z.object({query:z.string().max(300).optional(),limit:z.number().int().min(1).max(500).default(300)}).parse(p));
      case 'people':return listPeople(this.ctx(),{limit:300});
      case 'search':{
        const q=query.parse(p),cfg=this.cfg();if(q.mode==='vector'&&!this.demo&&!cfg.openaiKey)throw new Error('Configure an OpenAI key in Settings to search by meaning.');
        const {kind,...params}=q;
        const r=await searchHybrid(this.ctx(),{...params,minSim:cfg.minSim,strongSim:cfg.strongSim},this.demo?{embedQuery:async()=>demoVector(q.query)}:{});
        if(kind!=='all'){const db=openStoreRO(cfg.store);try{r.hits=r.hits.filter(h=>!!db.prepare('SELECT 1 FROM messages WHERE thread_id=? AND ts BETWEEN ? AND ? AND kind=? LIMIT 1').get(h.thread_id,h.start_ts,h.end_ts,kind));}finally{db.close();}}
        return {...r,demoSemantic:this.demo&&q.mode!=='bm25'};
      }
      case 'conversation':{
        const data=z.object({thread_id:z.string().min(1).max(300),around_ts:z.number().optional(),limit:z.number().int().min(1).max(500).default(100)}).strict().parse(p);
        return getConversation(this.ctx(),data);
      }
      case 'feed':return listMessageFeed(this.ctx(),z.object({thread_id:z.string().max(300).optional(),after:z.number().default(0),before:z.number().default(4102444800),limit:z.number().int().min(1).max(200).default(100),last:z.object({ts:z.number(),id:z.string()}).optional()}).strict().parse(p));
      case 'audio':return this.audio();
      case 'pending-windows':{const cfg=this.cfg(),db=openStoreRO(cfg.store);try{return db.prepare(`SELECT w.id,w.thread_id,t.title,w.start_ts,w.text FROM windows w JOIN threads t ON t.id=w.thread_id LEFT JOIN window_vectors v ON v.content_hash=w.content_hash AND v.model=? WHERE v.content_hash IS NULL ORDER BY w.start_ts DESC LIMIT 200`).all(`openai/${cfg.openaiModel}@${cfg.openaiDims}`);}finally{db.close();}}
      case 'media':{
        const id=z.string().max(500).parse(p.id),cfg=this.cfg(),db=openStoreRO(cfg.store);try{const row=db.prepare('SELECT source_id,relative_path FROM audio_media WHERE message_id=?').get(id) as any;if(!row)throw new Error('Audio file is unavailable');const file=mediaPath(cfg,row);if(statSync(file).size>25_000_000)throw new Error('Audio playback is limited to 25 MB');const bytes=readFileSync(file);return {base64:bytes.toString('base64'),mime:/\.wav$/i.test(file)?'audio/wav':/\.ogg$/i.test(file)?'audio/ogg':'audio/mp4'};}finally{db.close();}
      }
      case 'setup-readiness':return setupReadiness(this.cfg(),this.demo);
      case 'settings':return {...configSnapshot(CONFIG_PATH),configPath:CONFIG_PATH,platform:process.platform,demo:this.demo};
      case 'save-settings':if(this.active)throw new Error('Wait for the current job before changing settings');if(this.demo&&('openai_model' in p.patch||'openai_dims' in p.patch))throw new Error('The demo uses its own synthetic vector model');return saveSettings(CONFIG_PATH,p.patch,z.string().parse(p.revision));
      case 'grant-capture':this.leaseEnd=Date.now()+5*60_000;this.leaseDeadline=performance.now()+5*60_000;return {expiresAt:this.leaseEnd};
      case 'revoke-capture':this.leaseEnd=0;this.leaseDeadline=0;if(this.active&&this.jobs[0]?.kind==='sync')await this.cancel();return {expiresAt:0};
      case 'start-job':return this.startJob(p);
      case 'cancel-job':return this.cancel();
      case 'shutdown':await this.cancel();closeStores();return {ok:true};
      default:throw new Error('Unknown desktop command');
    }
  }
  private startJob(raw:unknown){
    const p=z.object({kind:z.enum(['sync','transcribe','embed','install-model']),messageId:z.string().max(500).optional(),retry:z.boolean().default(false)}).strict().parse(raw);
    if(this.active)throw new Error('Another desktop job is running');
    if(p.kind==='sync'&&process.platform==='darwin'&&!this.demo&&(Date.now()>=this.leaseEnd||performance.now()>=this.leaseDeadline))throw new Error('Authorize a five-minute capture in Settings → Dados e acesso first.');
    const cfg=this.cfg();if(!this.demo&&p.kind==='embed'&&!cfg.openaiKey)throw new Error('Configure an OpenAI key first');
    if(!this.demo&&p.kind==='transcribe'&&!cfg.transcriptionModel)throw new Error('Choose a transcription method in Settings first');
    const job:Job={id:randomUUID(),kind:p.kind,messageId:p.messageId,retry:p.retry,state:'running',startedAt:Date.now(),detail:'Starting…'};this.jobs.unshift(job);
    const child=spawn(process.execPath,['--experimental-sqlite','--experimental-strip-types','--no-warnings',join(import.meta.dirname,'worker.ts')],{env:process.env,stdio:['pipe','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
    this.active=child;this.persist();child.stdin.end(JSON.stringify({...p,expiresAt:this.leaseEnd}));
    let lines='';const output=(s:string)=>{job.detail=this.redact(s);try{const v=JSON.parse(s).progress;if(v?.phase==='progress'){job.done=v.done;job.total=v.done+v.pending;}if(typeof v==='string')job.detail=this.redact(v);}catch{}this.persist();};
    child.stdout.on('data',b=>{lines+=b.toString();const values=lines.split('\n');lines=values.pop()!;values.filter(Boolean).forEach(output);});child.stderr.on('data',b=>output(b.toString()));
    let finished=false;const finish=(code:number|null)=>{if(finished)return;finished=true;clearTimeout(this.watchdog);if(this.active===child)this.active=null;if(job.state==='running'){job.state=code===0?'done':'failed';if(code===0)job.detail='Completed';}job.finishedAt=Date.now();this.persist();};
    child.once('error',e=>{job.detail=this.redact(e.message);finish(1);});child.once('close',finish);
    const budget=p.kind==='sync'&&!this.demo&&process.platform==='darwin'?Math.min(this.leaseDeadline-performance.now(),(cfg.syncTimeoutMinutes??10)*60000):p.kind==='sync'?(cfg.syncTimeoutMinutes??30)*60000:90*60000;
    this.watchdog=setTimeout(()=>{job.detail='Job timed out; completed progress is preserved';void this.cancel('failed');},budget);return job;
  }
  private async cancel(state:'cancelled'|'failed'='cancelled'){
    const child=this.active;if(!child||!child.pid)return {ok:true};const job=this.jobs.find(j=>j.state==='running');if(job)job.state=state;
    if(process.platform==='win32'){await new Promise<void>((resolve,reject)=>{const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',reject);killer.once('close',()=>resolve());});}
    else {const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));try{process.kill(-child.pid,'SIGTERM');}catch{}const killer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)try{process.kill(-child.pid!,'SIGKILL')}catch{}},2000);await closed;clearTimeout(killer);}
    this.persist();return {ok:true};
  }
}
