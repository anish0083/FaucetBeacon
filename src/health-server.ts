import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FaucetError } from './domain.js';
import type { RuntimeStatus } from './runtime-health.js';

const KEEP_ALIVE_MS=8*60*1000;

export function webPort(env:NodeJS.ProcessEnv=process.env):number|null {
  const value=env.PORT?.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value) || Number(value)<1 || Number(value)>65535) throw new FaucetError('CONFIG','PORT must be an integer from 1 to 65535.');
  return Number(value);
}

/** Public HTTPS URL only: localhost pings never count as Render inbound traffic. */
export function keepAliveTarget(env:NodeJS.ProcessEnv=process.env):string|null {
  const raw=env.KEEP_ALIVE_URL?.trim()||env.RENDER_EXTERNAL_URL?.trim();
  if (!raw) return null;
  try {
    const url=new URL(raw.includes('://')?raw:`https://${raw}`);
    const host=url.hostname.toLowerCase();
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return null;
    if (host==='localhost' || host==='127.0.0.1' || host==='::1' || host==='0.0.0.0') return null;
    url.pathname='/healthz';url.search='';url.hash='';
    return url.toString();
  } catch { return null; }
}

export function keepAliveIntervalMs(env:NodeJS.ProcessEnv=process.env):number {
  const value=env.KEEP_ALIVE_MS?.trim();
  if (!value) return KEEP_ALIVE_MS;
  if (!/^\d+$/.test(value) || Number(value)<60_000 || Number(value)>14*60*1000) throw new FaucetError('CONFIG','KEEP_ALIVE_MS must be an integer from 60000 to 840000.');
  return Number(value);
}

export function startKeepAlive(url:string|null,intervalMs=KEEP_ALIVE_MS,ping:(target:string)=>Promise<unknown>=target=>fetch(target,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(5000)})) {
  if (!url) return null;
  const tick=()=>{void ping(url).catch(()=>{});};
  const timer=setInterval(tick,intervalMs);
  timer.unref();
  return ()=>clearInterval(timer);
}

/** HTTP status only: no claims, admin controls, balances or secrets are exposed. */
export async function startHealthServer(port:number|null,ready:()=>boolean|RuntimeStatus,host='0.0.0.0') {
  if (port===null) return null;
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json; charset=utf-8');
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    if (!['GET','HEAD'].includes(request.method??'')) {
      response.setHeader('Allow','GET, HEAD');response.writeHead(405);response.end('{"error":"method_not_allowed"}');return;
    }
    const path=request.url?.split('?')[0];
    if (path!=='/' && path!=='/healthz') {response.writeHead(404);response.end('{"error":"not_found"}');return;}
    const state=ready();
    const status=typeof state==='boolean'?{status:state?'ready':'starting'}:state;
    const available=status.status==='ready';
    response.writeHead(available?200:503);
    response.end(request.method==='HEAD'?undefined:JSON.stringify({service:'FaucetBeacon',...status}));
  });
  server.maxConnections=100;
  server.headersTimeout=5000;server.requestTimeout=5000;server.keepAliveTimeout=1000;
  await new Promise<void>((resolve,reject)=>{
    const failed=()=>reject(new FaucetError('HTTP_LISTEN','The HTTP status port could not be opened. Check PORT and whether it is already in use.'));
    server.once('error',failed);
    server.listen(port,host,()=>{server.removeListener('error',failed);resolve();});
  });
  return {
    port:(server.address() as AddressInfo).port,
    close:()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();}),
  };
}
