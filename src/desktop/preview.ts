// Browser QA only. Never exposes a real profile or a production listener.
import { createServer } from 'node:http';
import { DesktopService } from './service.ts';
if(process.env.WHATMCP_DESKTOP_MODE!=='demo'||!process.env.WHATMCP_HOME)throw new Error('Preview requires an isolated demo profile');
const service=new DesktopService();
// Preview state is fixture-only. It never persists or opens a requested profile.
let state={version:1,choice:'welcome',step:0,complete:false,mode:'demo',folder:null as string|null};
async function fixtureCall(method:string,params:any={}) {
  const result:any=await service.call(method,params);
  if(method==='overview'||method==='settings')return {...result,demo:state.mode==='demo',...(method==='overview'?{profile:state.mode==='demo'?process.env.WHATMCP_HOME:'/synthetic/app-archive'}:{})};
  return result;
}
async function fixtureShell(command:string,args:any={}) {
  if(command==='onboarding_state')return state;
  if(command==='switch_profile'){
    if(!['demo','archive','existing'].includes(args.mode))throw new Error('Invalid fixture mode');
    if(args.mode==='existing'&&args.folder!=='/synthetic-existing')throw new Error('Na prévia, use /synthetic-existing para o arquivo fictício.');
    state={...state,mode:args.mode,folder:args.mode==='existing'?args.folder:null,...(state.choice==='setup'?{}:{choice:args.mode==='demo'?'demo':'ready',complete:args.mode!=='demo'})};return fixtureCall('overview');
  }
  if(command==='onboarding_action'){
    if(args.action==='begin')state={...state,choice:'setup',complete:false,step:state.mode==='demo'?0:state.step};
    else if(args.action==='demo')state={...state,choice:'demo',complete:false,step:0};
    else if(args.action==='step'&&Number.isInteger(args.step)&&args.step>=0&&args.step<=3&&!(state.mode==='demo'&&args.step>0))state={...state,step:args.step};
    else if(args.action==='finish'&&state.mode!=='demo')state={...state,choice:'ready',complete:true,step:3};
    else throw new Error('Ação de prévia inválida');return state;
  }
  if(command==='open_fda_settings')return null;
  throw new Error('Esta ação está disponível no app instalado.');
}
createServer(async(req,res)=>{res.setHeader('Content-Type','application/json');if(req.method!=='POST'||!['/api','/shell'].includes(req.url??'')){res.writeHead(404).end();return;}if(!req.headers['content-type']?.startsWith('application/json')||req.headers.origin&&!/^http:\/\/127\.0\.0\.1:(1420|1421|5420|5421)$/.test(req.headers.origin)){res.writeHead(403).end();return;}try{let text='';for await(const b of req){text+=b;if(text.length>65536)throw new Error('Request too large');}const input=JSON.parse(text);res.end(JSON.stringify({ok:true,result:req.url==='/shell'?await fixtureShell(input.command,input.args):await fixtureCall(input.method,input.params)}));}catch(e){res.writeHead(400).end(JSON.stringify({ok:false,error:(e as Error).message}));}}).listen(Number(process.env.WHATMCP_PREVIEW_PORT??1421),'127.0.0.1');
process.on('SIGTERM',async()=>{await service.call('shutdown');process.exit(0);});
