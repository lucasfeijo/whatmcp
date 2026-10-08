import { invoke, isTauri } from '@tauri-apps/api/core';
export const native=isTauri();
export async function call<T>(method:string,params:unknown={}):Promise<T>{
  if(native)return invoke<T>('archive_call',{method,params});
  const r=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
  const reply=await r.json();if(!reply.ok)throw new Error(reply.error);return reply.result;
}
export async function shell<T>(command:string,args:Record<string,unknown>={}):Promise<T>{
  if(native)return invoke<T>(command,args);
  const r=await fetch('/shell',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command,args})});const reply=await r.json();if(!reply.ok)throw new Error(reply.error);return reply.result;
}
