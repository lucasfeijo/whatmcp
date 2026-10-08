export type Onboarding={version:number;choice:'welcome'|'demo'|'setup'|'ready';step:number;complete:boolean;mode:string;folder:string|null;warning?:string|null};
export type Snapshot={values:Record<string,unknown>;revision:string;keyConfigured:boolean;configPath:string};
export type Features={semantic:boolean;key:string;model:string;language:string;python:string;modelPath:string;ffmpeg:string;ffprobe:string;autoTranscribe:boolean};
export function featuresFrom(snapshot:Snapshot):Features {
  const v=snapshot.values;
  return {semantic:snapshot.keyConfigured,key:'',model:String(v.transcription_model??''),language:String(v.transcription_default_language??'pt-BR'),python:String(v.transcription_local_python_path??''),modelPath:String(v.transcription_local_model_path??''),ffmpeg:String(v.ffmpeg_path??''),ffprobe:String(v.ffprobe_path??''),autoTranscribe:!!v.transcription_auto_after_import};
}
export function featurePatch(f:Features,snapshot:Snapshot) {
  if((f.semantic||f.model==='gpt-transcribe')&&!f.key.trim()&&!snapshot.keyConfigured)throw new Error('Informe uma chave OpenAI ou deixe os recursos de nuvem para depois.');
  if(f.model==='faster-whisper'&&(!f.python.trim()||!f.modelPath.trim()))throw new Error('Selecione o Python e a pasta do modelo Whisper local.');
  const patch:Record<string,unknown>={transcription_model:f.model||null,transcription_default_language:f.language.trim(),transcription_auto_after_import:!!f.model&&f.autoTranscribe};
  if((f.semantic||f.model==='gpt-transcribe')&&f.key.trim())patch.openai_api_key=f.key.trim();
  if(f.model==='faster-whisper'){patch.transcription_local_python_path=f.python.trim();patch.transcription_local_model_path=f.modelPath.trim();}
  // Preserve existing executable settings unless the user supplied a replacement.
  if(f.ffmpeg.trim())patch.ffmpeg_path=f.ffmpeg.trim();if(f.ffprobe.trim())patch.ffprobe_path=f.ffprobe.trim();
  return patch;
}
