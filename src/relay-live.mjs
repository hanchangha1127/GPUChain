// A stream is newline-delimited JSON inside encrypted, indexed frames. Splitting
// bytes instead of delta fields also handles large tool arguments and UTF-8.
const FRAME_BYTES = 48 * 1024;
export const MAX_FRAME_BOX = 128 * 1024;
const MAX_DELTA_BYTES = 16 * 1024 * 1024;

export function relayFrameWriter(send) {
  let parts=[], size=0, count=0, timer, failure, sending=Promise.resolve();
  function flush() {
    clearTimeout(timer);
    timer=undefined;
    if (!size) return;
    const bytes=Buffer.concat(parts,size).toString('base64url');
    parts=[]; size=0;
    const index=++count;
    sending=sending.then(async()=>{
      if (!failure) await send(index,{bytes});
    }).catch(err=>{ failure=err; });
  }
  async function wait() { await sending; if (failure) throw failure; }
  return {
    async push(delta) {
      await wait();
      const raw=Buffer.from(JSON.stringify(delta)+'\n');
      if (raw.length>MAX_DELTA_BYTES) throw Error('Relay delta exceeds the size limit');
      for (let start=0; start<raw.length;) {
        const take=Math.min(FRAME_BYTES-size,raw.length-start);
        parts.push(raw.subarray(start,start+take));
        size+=take; start+=take;
        if (size===FRAME_BYTES) {flush(); await wait();}
      }
      if (!count) {flush(); await wait();}
      else if (size && !timer) timer=setTimeout(flush,100);
    },
    async finish() {flush(); await wait(); return count;},
    async stop() {clearTimeout(timer); parts=[]; size=0; await sending;}
  };
}

export function relayFrameReader(onDelta) {
  let parts=[], size=0;
  return {
    async push(frame) {
      const b64=frame?.bytes;
      if (typeof b64!=='string' || !b64.length || b64.length>Math.ceil(FRAME_BYTES*4/3)) throw Error('Invalid relay stream bytes');
      const raw=Buffer.from(b64,'base64url');
      if (raw.toString('base64url')!==b64) throw Error('Invalid relay stream encoding');
      for (let start=0; start<raw.length;) {
        const end=raw.indexOf(10,start);
        const part=raw.subarray(start,end<0?raw.length:end);
        size+=part.length;
        if (size>MAX_DELTA_BYTES) throw Error('Relay delta exceeds the size limit');
        parts.push(part);
        if (end<0) break;
        const json=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts,size));
        parts=[]; size=0; start=end+1;
        await onDelta(JSON.parse(json));
      }
    },
    finish() {if (size) throw Error('Relay stream ended inside a delta');}
  };
}
