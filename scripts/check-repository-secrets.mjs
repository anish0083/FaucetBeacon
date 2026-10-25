// Check staged blobs, never print credential values or file contents.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parse} from 'dotenv';
try {
  const git=(args)=>execFileSync('git',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  const files=git(['ls-files','-z']).split('\0').filter(Boolean);
  if(!files.length) throw new Error('No staged files');
  const env=fs.existsSync('.env')?parse(fs.readFileSync('.env')):{};
  const values=Object.entries(env).filter(([key,value])=>/TOKEN|SECRET|PRIVATE_KEY|PASSWORD/.test(key)&&value.length>16)
    .flatMap(([key,value])=>[value,...(key.includes('PRIVATE_KEY')?[value.replace(/^0x/,'')]:[])]);
  const bad=files.filter(file=>file==='.env'||/^\.env\.(?!example$)/.test(file)||/^(\.data|node_modules|dist|\.test-build|\.npm-cache)\//.test(file));
  const leaks=files.filter(file=>{const blob=git(['show',`:${file}`]);return values.some(value=>blob.includes(value));});
  if(bad.length||leaks.length) {console.error(JSON.stringify({blockedPaths:bad,secretMatches:leaks}));process.exitCode=1;}
  else console.log(`Secret scan passed for ${files.length} staged files.`);
} catch {console.error('Repository secret scan could not complete. Nothing should be published.');process.exitCode=1;}
