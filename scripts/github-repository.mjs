// Invoked by publish-github.ps1. Credentials arrive over stdin, never command arguments.
import fs from 'node:fs';
const [owner,name]=process.argv.slice(2);
try {
  if(!owner||!name||!/^[-\w.]+$/.test(owner)||!/^[-\w.]+$/.test(name)) throw new Error();
  const fields=Object.fromEntries(fs.readFileSync(0,'utf8').trim().split(/\r?\n/).map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];}));
  if(!fields.password) throw new Error();
  const request=(path,method='GET',body)=>fetch(`https://api.github.com${path}`,{
    method,headers:{Authorization:`Bearer ${fields.password}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(20000),
  });
  const account=await request('/user');
  if(!account.ok || (await account.json()).login.toLowerCase()!==owner.toLowerCase()) throw new Error();
  const existing=await request(`/repos/${owner}/${name}`);
  if(existing.status===404) {
    const created=await request('/user/repos','POST',{name,private:true,auto_init:false,description:'Discord tITL faucet for Interlink Testnet, with shared wallet and per-server controls.'});
    if(created.status!==201 || !(await created.json()).private) throw new Error();
  } else {
    if(!existing.ok) throw new Error();
    const repo=await existing.json();
    if(!repo.private || !repo.permissions?.push) throw new Error();
  }
  console.log(`https://github.com/${owner}/${name}.git`);
} catch {console.error('GitHub private repository setup failed. Check account login and repository permissions. No credentials were printed.');process.exitCode=1;}
