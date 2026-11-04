const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtemp, mkdir, writeFile, appendFile, readFile, stat, access, rm, realpath } = require('node:fs/promises');
const { once } = require('node:events');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const binary = process.env.DWCUE_TEST_SERVER_BINARY || path.resolve(__dirname, '../server/build/dwcue-server');
const shim = path.join(os.tmpdir(), 'dwcue-storage-isolation-test.dylib');
if (process.platform === 'darwin') execFileSync('xcrun', ['clang', '-std=c11', '-dynamiclib', '-O2',
  '-o', shim, path.join(__dirname, 'storage-read-delay.c')]);
const token = 'isolated-storage-research';
let nextCommandId = 0;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, inject = false, reads = 1) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dwcue-storage-probe-'));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const media = path.join(dir, 'injected.bin'), marker = path.join(dir, 'read-entered');
  await writeFile(media, Buffer.alloc(20 * 1024 * 1024, 42));
  const env = { ...process.env, LIVEPLAY_STATE_DIR: path.join(dir, 'state'), LIVEPLAY_ACCESS_TOKEN: token, LIVEPLAY_ALLOWED_ORIGINS: `http://127.0.0.1:${port}` };
  if (inject) Object.assign(env, { DYLD_INSERT_LIBRARIES: shim, DWCUE_STORAGE_STALL_PATH: await realpath(media), DWCUE_STORAGE_STALL_ENTERED: marker, DWCUE_STORAGE_STALL_MS: '2500', DWCUE_STORAGE_STALL_READS: String(reads) });
  const child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(port)], { cwd: dir, env, stdio: ['ignore','pipe','pipe'] });
  let log = ''; child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const force = setTimeout(() => child.kill('SIGKILL'), 5000); child.kill('SIGTERM'); await once(child, 'exit'); clearTimeout(force); } await rm(dir, { recursive: true, force: true }); });
  const request = (url, body) => fetch(`http://127.0.0.1:${port}${url}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, Connection: 'close', 'Content-Type':'application/json' }, ...(body ? {body:JSON.stringify(body)} : {}), signal: AbortSignal.timeout(7000) });
  let ready = false;
  for (let i=0;i<160;i++) { assert.equal(child.exitCode ?? child.signalCode, null, log); try { const response = await request('/api/health'); ready = response.ok; await response.arrayBuffer(); } catch {} if (ready) break; await sleep(25); }
  assert.ok(ready, log); await sleep(60);
  return { dir, media, marker, port, request, child };
}
async function stream(f,t) {
 const socket = new WebSocket(`ws://127.0.0.1:${f.port}/ws?access_token=${token}`);
 await once(socket,'open'); t.after(()=>socket.close());
 const stop=()=>new Promise((resolve,reject)=>{const id='disk-'+ ++nextCommandId, start=performance.now();const timeout=setTimeout(()=>reject(new Error('ack timeout')),6000); const listener=event=>{let message=JSON.parse(String(event.data)); if(message.type==='command_ack'&&message.command_id===id){socket.removeEventListener('message',listener); clearTimeout(timeout);assert.equal(message.ok,true);resolve(performance.now()-start);}};socket.addEventListener('message',listener);socket.send(JSON.stringify({type:'stop_all',fade_ms:0,command_id:id}));});
 return {stop};
}
for (const range of [true,false]) test(`injected regular file read delay (${range?'range':'whole file'})`, { timeout:15000, skip: process.platform !== 'darwin' }, async t=>{
 const f=await fixture(t,true), clients=await Promise.all(Array.from({length:os.cpus().length+2},()=>stream(f,t))); const before=await Promise.all(clients.map(ws=>ws.stop()));
 const mediaResult = new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port:f.port,path:`/api/media?path=${encodeURIComponent(f.media)}`,headers:{Authorization:`Bearer ${token}`,Connection:'close',...(range?{Range:'bytes=0-16777215'}:{})}},res=>{let bytes=0;res.on('data',b=>bytes+=b.length);res.on('end',()=>resolve({status:res.statusCode,bytes}));});req.on('error',reject);});
 let entered=false;for(let i=0;i<300;i++){try{await access(f.marker);entered=true;break;}catch{}await sleep(5);}
 assert.ok(entered,'fread delay was not injected');
 const during=await Promise.all(clients.map(ws=>ws.stop())), result=await mediaResult, after=await Promise.all(clients.map(ws=>ws.stop()));
 assert.ok(Math.max(...during)<400,`control workers stalled, got ${during}`);assert.ok(Math.max(...after)<500);
 console.log(JSON.stringify({case:range?'range':'whole_file',injected_read_delay_ms:2500,ws_ack_before_ms:before,ws_ack_during_ms:during,ws_ack_after_ms:after,...result}));
});

test('disconnect during a storage read leaves control responsive', {timeout:15000, skip: process.platform !== 'darwin'}, async t=>{
 const f=await fixture(t,true), clients=await Promise.all(Array.from({length:os.cpus().length+2},()=>stream(f,t)));
 let request;
 const result=new Promise(resolve=>{request=http.get({host:'127.0.0.1',port:f.port,path:`/api/media?path=${encodeURIComponent(f.media)}`,headers:{Authorization:`Bearer ${token}`,Range:'bytes=0-16777215',Connection:'close'}},res=>{res.resume();res.once('end',()=>resolve('end'));});request.once('error',()=>resolve('aborted'));});
 let entered=false;for(let i=0;i<300;i++){try{await access(f.marker);entered=true;break;}catch{}await sleep(5);}assert.ok(entered);
 request.destroy();await result;
 const delay=await Promise.all(clients.map(ws=>ws.stop()));assert.ok(Math.max(...delay)<400);
 console.log(JSON.stringify({case:'disconnect_during_read',injected_read_delay_ms:2500,ws_ack_after_disconnect_ms:delay}));
});

test('saturated media storage rejects excess work while auth and controls stay responsive',
  { timeout: 15000, skip: process.platform !== 'darwin' }, async t => {
    const f = await fixture(t, true, 2);
    const clients = await Promise.all(Array.from({ length: os.cpus().length + 2 }, () => stream(f, t)));
    const statuses = [], requests = [];
    const responses = Array.from({ length: 12 }, () => new Promise(resolve => {
      const request = http.get({ host: '127.0.0.1', port: f.port,
        path: `/api/media?path=${encodeURIComponent(f.media)}`,
        headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-16777215', Connection: 'close' },
      }, response => {
        statuses.push(response.statusCode);
        response.resume(); response.on('end', resolve); response.on('error', resolve);
      });
      requests.push(request);
      request.on('error', resolve);
    }));
    t.after(() => requests.forEach(request => request.destroy()));
    for (let i = 0; i < 200 && !statuses.includes(503); i++) await sleep(5);
    assert.ok(statuses.includes(503), 'excess preparation must be refused instead of queued without a bound');
    const delays = await Promise.all(clients.map(client => client.stop()));
    assert.ok(Math.max(...delays) < 400, `saturation stalled control: ${Math.max(...delays)} ms`);
    const unauthenticated = await fetch(`http://127.0.0.1:${f.port}/api/media?path=${encodeURIComponent(f.media)}`);
    assert.equal(unauthenticated.status, 401, 'authorization must run before admission');
    await unauthenticated.arrayBuffer();
    requests.forEach(request => request.destroy());
    await Promise.all(responses);
    await sleep(2600);
    assert.equal((await f.request('/api/health')).status, 200);
    assert.equal(f.child.exitCode ?? f.child.signalCode, null);
  });
test('graceful shutdown safely drains the already executing file read', {timeout:15000, skip: process.platform !== 'darwin'}, async t=>{
 const f=await fixture(t,true);
 const request=http.get({host:'127.0.0.1',port:f.port,path:`/api/media?path=${encodeURIComponent(f.media)}`,headers:{Authorization:`Bearer ${token}`,Range:'bytes=0-16777215',Connection:'close'}},res=>res.resume());request.on('error',()=>{});t.after(()=>request.destroy());
 let entered=false;for(let i=0;i<300;i++){try{await access(f.marker);entered=true;break;}catch{}await sleep(5);}assert.ok(entered);
 const start=performance.now();f.child.kill('SIGTERM');await once(f.child,'exit');const delay=performance.now()-start;
 assert.equal(f.child.exitCode,0);assert.equal(f.child.signalCode,null);console.log(JSON.stringify({case:'shutdown_during_read',injected_read_delay_ms:2500,shutdown_ms:delay,exit_code:f.child.exitCode,exit_signal:f.child.signalCode}));
});
