import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openStore } from '../src/db/index.ts';
import { reconcileProjectionModel, prepareReadyCandidates, publishCandidates } from '../src/transcription/projection.ts';
import { importWindowsUnified } from '../src/index/windows-import.ts';

test('WAren6 import appends newer messages and is idempotent', () => {
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-win-import-'));
  try {
    const archive=join(dir,'archive.db'), source=join(dir,'unified_whatsapp.db');
    const db=openStore(archive);
    const old=1_700_000_000;
    db.prepare('INSERT INTO threads(id,title,kind,msg_count,first_ts,last_ts,first_seen_at,last_seen_at) VALUES(?,?,?,1,?,?,?,?)')
      .run('123@s.whatsapp.net','Existing','dm',old,old,old,old);
    db.prepare('INSERT INTO messages(id,thread_id,ts,text,is_from_me,kind,stanza_id,first_seen_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('123@s.whatsapp.net:old','123@s.whatsapp.net',old,'from iPhone',0,'text','old',old);
    db.close();
    const s=new DatabaseSync(source);
    s.exec('CREATE TABLE messages(msg_id TEXT,chat_jid TEXT,chat_name TEXT,sender_jid TEXT,sender_name TEXT,from_me INTEGER,timestamp INTEGER,text TEXT,is_group INTEGER,msg_type TEXT)');
    const ins=s.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)');
    ins.run('old','123@s.whatsapp.net','Windows',null,null,0,old,'should not replace',0,'chat');
    ins.run('new','123@s.whatsapp.net','Windows','123@s.whatsapp.net','Sender',0,old+60,'new text',0,'chat');
    ins.run('new','123@s.whatsapp.net','Windows','123@s.whatsapp.net','Sender',0,old+60,'new text',0,'chat');
    ins.run(null,'123@s.whatsapp.net','Windows',null,null,0,old+70,'unstable',0,'chat');
    s.close();
    const first=importWindowsUnified(archive,source);
    assert.equal(first.added,1);
    assert.equal(first.skipped,1);
    const second=importWindowsUnified(archive,source);
    assert.equal(second.added,0);
    const check=new DatabaseSync(archive,{readOnly:true});
    assert.equal((check.prepare('SELECT COUNT(*) n FROM messages').get() as {n:number}).n,2);
    assert.equal((check.prepare('SELECT text FROM messages WHERE stanza_id=?').get('old') as {text:string}).text,'from iPhone');
    assert.equal((check.prepare('SELECT COUNT(*) n FROM windows').get() as {n:number}).n,1);
    check.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('incremental import recovers old missing bodies without importing old unrelated history', () => {
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-win-recovery-'));
  try {
    const archive=join(dir,'archive.db'), source=join(dir,'source.db');
    const db=openStore(archive), old=1_700_000_000, latest=old+30*86400;
    db.prepare('INSERT INTO threads(id,kind,first_seen_at,last_seen_at) VALUES(?,?,?,?)')
      .run('chat','dm',old,latest);
    const insert=db.prepare('INSERT INTO messages(id,thread_id,ts,text,is_from_me,kind,stanza_id,first_seen_at) VALUES(?,?,?,?,?,?,?,?)');
    insert.run('chat:missing','chat',old,null,0,'text','missing',old);
    insert.run('chat:blank','chat',old,'  ',0,'text','blank',old);
    insert.run('chat:preserved','chat',old,'original',0,'text','preserved',old);
    db.prepare('INSERT INTO sync_state(id,last_source_pk,last_ts,last_run_at,msg_count,full_runs) VALUES(?,0,?,?,3,0)')
      .run('windows-waren6',latest,latest);
    db.close();
    const s=new DatabaseSync(source);
    s.exec('CREATE TABLE messages(msg_id TEXT,chat_jid TEXT,chat_name TEXT,sender_jid TEXT,sender_name TEXT,from_me INTEGER,timestamp INTEGER,text TEXT,is_group INTEGER,msg_type TEXT)');
    const row=s.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)');
    for(const [id,text] of [['missing','recovered body'],['blank','recovered blank'],['preserved','replacement'],['unrelated','old history']])
      row.run(id,'chat','Chat',null,null,0,old,text,0,'chat');
    s.close();
    const result=importWindowsUnified(archive,source);
    assert.equal(result.recovered,2);
    assert.equal(result.added,0);
    const check=openStore(archive);
    assert.equal((check.prepare("SELECT text FROM messages WHERE id='chat:missing'").get() as any).text,'recovered body');
    assert.equal((check.prepare("SELECT text FROM messages WHERE id='chat:preserved'").get() as any).text,'original');
    assert.equal(check.prepare("SELECT id FROM messages WHERE id='chat:unrelated'").get(),undefined);
    assert.equal((check.prepare("SELECT last_ts FROM sync_state WHERE id='windows-waren6'").get() as any).last_ts,latest);
    assert.ok((check.prepare("SELECT COUNT(*) n FROM windows_fts WHERE windows_fts MATCH 'recovered'").get() as any).n>0);
    check.close();
    assert.equal(importWindowsUnified(archive,source).recovered,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('Windows import invalidates prepared audio candidates before publication', () => {
  const dir=mkdtempSync(join(tmpdir(),'whatmcp-win-projection-'));
  try {
    const archive=join(dir,'archive.db'), source=join(dir,'source.db');
    const db=openStore(archive);
    db.exec("INSERT INTO threads(id,kind,first_seen_at,last_seen_at) VALUES('chat','dm',1,1)");
    db.exec("INSERT INTO messages(id,thread_id,ts,kind,is_from_me,first_seen_at) VALUES('chat:audio','chat',1,'audio',0,1)");
    const cfg={openaiModel:'test',openaiDims:4,openaiKey:null} as any;
    reconcileProjectionModel(db,'gpt-transcribe');
    prepareReadyCandidates(db,cfg);
    const generation=(db.prepare('SELECT desired_generation g FROM thread_projection_state').get() as any).g;
    const s=new DatabaseSync(source);
    s.exec('CREATE TABLE messages(msg_id TEXT,chat_jid TEXT,chat_name TEXT,sender_jid TEXT,sender_name TEXT,from_me INTEGER,timestamp INTEGER,text TEXT,is_group INTEGER,msg_type TEXT)');
    s.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)').run('text','chat','Chat',null,null,0,2,'preservar novidade',0,'chat');
    s.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?)').run('audio2','chat','Chat',null,null,0,3,null,0,'ptt');
    s.close();
    importWindowsUnified(archive,source,{full:true});
    assert.ok((db.prepare('SELECT desired_generation g FROM thread_projection_state').get() as any).g>generation);
    assert.equal(publishCandidates(db,cfg),0,'old prepared result must not overwrite fresh text');
    assert.equal((db.prepare("SELECT COUNT(*) n FROM windows_fts WHERE windows_fts MATCH 'novidade'").get() as any).n,1);
    prepareReadyCandidates(db,cfg);publishCandidates(db,cfg);
    assert.equal((db.prepare('SELECT pending_audio n FROM thread_projection_state').get() as any).n,2);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM windows_fts WHERE windows_fts MATCH 'novidade'").get() as any).n,1);
    db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
