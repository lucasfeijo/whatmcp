import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openStore } from '../src/db/index.ts';
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
