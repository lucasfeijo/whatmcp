import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { Config } from '../config.ts';
import { availableModels } from '../transcription/models.ts';
const exec=promisify(execFile);
export async function setupReadiness(cfg:Config,demo=false) {
  async function binary(path:string|undefined) {if(demo)return true;try{await exec(path??'', ['-version'],{timeout:5000,maxBuffer:65536,windowsHide:true});return true}catch{return false}}
  const [ffmpeg,ffprobe,models]=await Promise.all([binary(cfg.ffmpegPath),binary(cfg.ffprobePath),cfg.transcriptionModel&&!demo?availableModels(cfg):Promise.resolve([])]);
  const model=cfg.transcriptionModel?models.find(m=>m.model===cfg.transcriptionModel):null;
  return {
    textReady:true,semanticConfigured:!!cfg.openaiKey,
    transcription:cfg.transcriptionModel?{ready:demo||!!model?.available&&ffmpeg&&ffprobe,model:cfg.transcriptionModel,reason:demo?'Dados sintéticos':model?.reason??'Método indisponível'}:null,
    ffmpeg,ffprobe,
    source:process.platform==='win32'?{configured:demo||!!cfg.windowsWaren6Path&&existsSync(cfg.windowsWaren6Path),detail:'WAren6 e WhatsApp Desktop precisam estar configurados.'}:{configured:false,detail:'A permissão de leitura será verificada ao iniciar a primeira sincronização. Nenhum dado do WhatsApp foi lido nesta verificação.'},
  };
}
