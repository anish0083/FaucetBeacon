import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FaucetError } from './domain.js';

export function webPort(env:NodeJS.ProcessEnv=process.env):number|null {
  const value=env.PORT?.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value) || Number(value)<1 || Number(value)>65535) throw new FaucetError('CONFIG','PORT must be an integer from 1 to 65535.');
  return Number(value);
}

/** HTTP status only: no claims, admin controls, balances or secrets are exposed. */
export async function startHealthServer(port:number|null,ready:()=>boolean,host='0.0.0.0') {
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
    const available=ready();
    response.writeHead(available?200:503);
    response.end(request.method==='HEAD'?undefined:JSON.stringify({service:'FaucetBeacon',status:available?'ready':'starting'}));
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
