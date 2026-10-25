import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadCsv, MAX_CSV_BYTES, parseAddressCsv } from '../src/csv.js';
import { cooldownQuotes, QuoteBag, successQuotes } from '../src/content/quotes.js';
import { commandData } from '../src/discord/commands.js';
import { errorCard, successCard } from '../src/discord/embeds.js';
import { extractAddresses, FaucetError } from '../src/domain.js';
import { address, makePayout } from './helpers.js';

test('CSV accepts a UTF-8 BOM, address headers and bare addresses, with deduplication',()=>{
  assert.deepEqual(parseAddressCsv(`\uFEFFaddress\r\n${address(1)}\r\n${address(2)}\r\n${address(1)}\r\n`,100),{addresses:[address(1),address(2)],duplicateCount:1});
  assert.deepEqual(parseAddressCsv(`${address(1)}\n${address(2)}`,100).addresses,[address(1),address(2)]);
  assert.deepEqual(parseAddressCsv(`name,wallet_address\nAlice,${address(1)}`,100).addresses,[address(1)]);
});
test('CSV validation rejects bad rows, formula cells, ambiguous columns and large files',()=>{
  for (const csv of ['address\nnot-a-wallet','address\n=HYPERLINK("bad")','address,wallet\nwrong,wrong','',`address\n${address(0)}`]) assert.throws(()=>parseAddressCsv(csv,100),FaucetError);
  assert.throws(()=>parseAddressCsv(`${address(1)}\n${address(2)}`,1));
  assert.throws(()=>parseAddressCsv('a'.repeat(MAX_CSV_BYTES+1),100));
});
test('CSV downloader refuses external hosts, redirects and oversized streams',async()=>{
  let calls=0;
  const fake=(async(_input:unknown,init?:RequestInit)=>{calls++;assert.equal(init?.redirect,'error');return new Response('x'.repeat(MAX_CSV_BYTES+1));}) as typeof fetch;
  await assert.rejects(downloadCsv({url:'https://evil.example/data.csv',name:'data.csv',size:10},fake));assert.equal(calls,0);
  await assert.rejects(downloadCsv({url:'https://cdn.discordapp.com/a.csv',name:'a.csv',size:10},fake),error=>error instanceof FaucetError&&error.code==='CSV_SIZE');
});
test('chat detection matches wallets without truncating transaction hashes',()=>{
  assert.deepEqual(extractAddresses(`gm, please fund ${address(1)}!`),[address(1)]);
  assert.deepEqual(extractAddresses(`0x${'a'.repeat(64)}`),[]);
  assert.deepEqual(extractAddresses(`${address(1)} ${address(1)}`),[address(1)]);
});
test('both quote collections have 100+ unique replies and do not repeat before exhaustion',()=>{
  for (const source of [cooldownQuotes,successQuotes]) {
    assert.ok(source.length>=100);assert.equal(new Set(source).size,source.length);
    const bag=new QuoteBag(source,max=>max-1);const cycle=Array.from({length:source.length},()=>bag.next());
    assert.equal(new Set(cycle).size,source.length);assert.notEqual(bag.next(),cycle.at(-1));
  }
});
test('Discord command definitions serialize, restrict admin commands and expose every required control',()=>{
  assert.equal(commandData.length,3);
  const root=commandData.find(c=>c.name==='faucet-admin')!;
  assert.equal(root.default_member_permissions,'8');
  const alerts=root.options?.find(c=>c.name==='alerts');
  assert.ok(alerts && 'options' in alerts);
  for(const name of ['setup','target-add','target-remove','targets-clear','status','disable','test']) assert.ok(alerts.options?.some(c=>c.name===name));
  for (const name of ['channel-add','channel-remove','amount','cooldown','start','stop','role-grant','role-revoke','limits','pending']) assert.ok(root.options?.some(c=>c.name===name));
  const mods=commandData.find(c=>c.name==='faucet-mod')!;
  for (const name of ['blacklist-add','blacklist-remove','bulk','batch-status','cooldown']) assert.ok(mods.options?.some(c=>c.name===name));
});
test('success embeds include the exact amount, wallet, timestamp and explorer link',()=>{
  const job=makePayout({status:'confirmed',txHash:`0x${'a'.repeat(64)}`,confirmedAt:Date.now()});
  const data=successCard(job,'tITL','https://explorer.test-net.interlinklabs.ai').toJSON();
  assert.ok(data.url?.endsWith(`/tx/0x${'a'.repeat(64)}`));assert.ok(JSON.stringify(data).includes('1.0 tITL'));assert.ok(JSON.stringify(data).includes(address(1)));
  const cooldown=errorCard(new FaucetError('COOLDOWN','Wait',Date.now()+1000)).toJSON();assert.ok(cooldown.fields?.some(f=>f.name==='Available again'));
});
