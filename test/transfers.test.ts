import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, Wallet, keccak256 } from 'ethers';
import { NativeTransfers } from '../src/chain/transfers.js';
import { type InterlinkGateway } from '../src/chain/gateway.js';
import { FaucetError, amountWei } from '../src/domain.js';
import { address } from './helpers.js';

const wallet=new Wallet(`0x${'2'.padStart(64,'0')}`);
function setup(overrides:Record<string,unknown>={}) {
  const calls:{method:string;params:unknown[]}[]=[];
  const values:Record<string,unknown>={eth_getBalance:`0x${BigInt(amountWei('100')).toString(16)}`,eth_getTransactionCount:'0x7',eth_getBlockByNumber:{baseFeePerGas:'0x2540be400'},eth_maxPriorityFeePerGas:'0x3b9aca00',eth_gasPrice:'0x28fa6ae00',eth_estimateGas:'0x5208',...overrides};
  const gateway={initialize:async()=>{},resetAuthentication:()=>{},rpc:async(method:string,params:unknown[])=>{calls.push({method,params});return values[method];}} as unknown as InterlinkGateway;
  const chain=new NativeTransfers(gateway,{wallet,chainId:19042026,maxFeePerGas:100n*10n**9n,maxGasLimit:100000n});
  return {chain,calls};
}
test('native transfer uses EIP-1559, exact amounts and the owned wallet for gateway reads',async()=>{
  const {chain,calls}=setup();await chain.initialize();
  const prepared=await chain.prepare(address(1),BigInt(amountWei('1.000000000000000001')));
  const tx=Transaction.from(prepared.rawTx);
  assert.equal(tx.type,2);assert.equal(tx.chainId,19042026n);assert.equal(tx.nonce,7);assert.equal(tx.value,1000000000000000001n);assert.equal(tx.to?.toLowerCase(),address(1));assert.equal(tx.from,wallet.address);assert.equal(tx.data,'0x');
  assert.equal(tx.maxFeePerGas,21n*10n**9n);assert.equal(tx.maxPriorityFeePerGas,10n**9n);assert.equal(tx.gasLimit,25200n);assert.equal(prepared.txHash,keccak256(prepared.rawTx));
  for (const c of calls.filter(c=>['eth_getBalance','eth_getTransactionCount'].includes(c.method))) assert.equal(c.params[0],wallet.address);
  assert.deepEqual(calls.find(c=>c.method==='eth_getBlockByNumber')?.params,['latest',false]);
});
test('funding and fee checks prevent signing when amount plus gas cannot be covered',async()=>{
  const low=setup({eth_getBalance:'0x1'});await low.chain.initialize();await assert.rejects(low.chain.prepare(address(1),1n),e=>e instanceof FaucetError&&e.code==='LOW_BALANCE');
  const high=setup({eth_getBlockByNumber:{baseFeePerGas:'0x174876e800'}});await high.chain.initialize();await assert.rejects(high.chain.prepare(address(1),1n),e=>e instanceof FaucetError&&e.code==='GAS_LIMIT');
});
test('chain validation is required before balance reads, signing and broadcasting',async()=>{
  const {chain,calls}=setup();await assert.rejects(chain.prepare(address(1),1n));await assert.rejects(chain.balance());await assert.rejects(chain.broadcast('0xsigned',`0x${'1'.repeat(64)}`));assert.equal(calls.length,0);
});

test('unknown and pending transactions skip the gateway receipt endpoint that hangs before mining',async()=>{
  const hash=`0x${'a'.repeat(64)}`;
  for (const tx of [null,{hash,blockNumber:null}]) {
    const {chain,calls}=setup({eth_getTransactionByHash:tx});await chain.initialize();
    assert.equal(await chain.receipt(hash),null);
    assert.deepEqual(calls.map(c=>c.method),['eth_getTransactionByHash']);
  }
});

test('a mined transaction, including one whose submission response was lost, still verifies its original receipt',async()=>{
  const hash=`0x${'b'.repeat(64)}`;
  const receipt={transactionHash:hash,from:wallet.address,to:address(1),status:'0x1',blockNumber:'0xa'};
  const {chain,calls}=setup({eth_getTransactionByHash:{hash,blockNumber:'0xa'},eth_getTransactionReceipt:receipt});await chain.initialize();
  assert.deepEqual(await chain.receipt(hash),receipt);
  assert.deepEqual(calls.map(c=>c.method),['eth_getTransactionByHash','eth_getTransactionReceipt']);
});

test('a malformed or mismatched transaction lookup fails closed before any broadcast',async()=>{
  const hash=`0x${'c'.repeat(64)}`;
  for (const tx of [undefined,{}, {hash:`0x${'d'.repeat(64)}`,blockNumber:null},{hash,blockNumber:'invalid'}]) {
    const {chain,calls}=setup({eth_getTransactionByHash:tx});await chain.initialize();
    await assert.rejects(chain.receipt(hash),e=>e instanceof FaucetError&&e.code==='RPC_SCHEMA');
    assert.equal(calls.length,1);
  }
});
