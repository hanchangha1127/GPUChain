import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { purgeExpiredRelay, relayRoute } from './relay-service.mjs';

// Native validators use the same migration, statements and atomic batches as hosted D1.
export function openRelayDatabase(path) {
  const sql=new DatabaseSync(path);
  try {
    sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; PRAGMA auto_vacuum=FULL;');
    sql.exec('BEGIN IMMEDIATE');
    const version=sql.prepare('PRAGMA user_version').get().user_version;
    if (version<1) {
      sql.exec(readFileSync(new URL('../hosting/sites/drizzle/0004_relay_mailbox.sql',import.meta.url),'utf8'));
      sql.exec('PRAGMA user_version=1');
    }
    if (version<2) {
      sql.exec(readFileSync(new URL('../hosting/sites/drizzle/0005_relay_stream.sql', import.meta.url),'utf8'));
      sql.exec('PRAGMA user_version=2');
    }
    if (version<3) {
      sql.exec(readFileSync(new URL('../hosting/sites/drizzle/0006_relay_failure.sql',import.meta.url),'utf8'));
      sql.exec('PRAGMA user_version=3');
    }
    sql.exec('COMMIT');
    function prepare(query,args=[]) {
      const stmt=sql.prepare(query);
      return {
        bind(...values){return prepare(query,values);},
        first(){return stmt.get(...args) ?? null;},
        all(){return {results:stmt.all(...args)};},
        run(){return {meta:{changes:stmt.run(...args).changes}};}
      };
    }
    return {prepare,close:()=>sql.close(),batch(statements){
      sql.exec('BEGIN IMMEDIATE');
      try {const values=statements.map(s=>s.run());sql.exec('COMMIT');return values;}
      catch(err){sql.exec('ROLLBACK');throw err;}
    }};
  } catch(err){sql.close();throw err;}
}

export function localRelay(dir) {
  const path=join(dir,'relay.sqlite');
  let database,timer;
  function open(){
    if (!database) {
      database=openRelayDatabase(path);
      timer=setInterval(()=>purgeExpiredRelay(database).catch(()=>{}),60_000);
      timer.unref();
    }
    return database;
  }
  if(existsSync(path)) purgeExpiredRelay(open()).catch(()=>{});
  return {
    async serve(req,res,state){
      const writable=req.method!=='GET' && req.method!=='HEAD';
      const request=new Request('http://localhost'+req.url,{method:req.method,headers:req.headers,
        ...(writable ? {body:Readable.toWeb(req),duplex:'half'} : {})});
      const reply=await relayRoute(request,open(),state);
      res.writeHead(reply.status,Object.fromEntries(reply.headers));
      res.end(Buffer.from(await reply.arrayBuffer()));
    },
    close(){clearInterval(timer);database?.close();}
  };
}
