// Uses the production gateway client. The temporary wallet is never funded or saved.
import { Wallet } from 'ethers';
import { InterlinkGateway } from '../src/chain/gateway.js';
import { NativeTransfers } from '../src/chain/transfers.js';
import { safeError, tokens } from '../src/domain.js';

try {
  const wallet=new Wallet(Wallet.createRandom().privateKey);
  let clock=Date.now();
  const gateway=new InterlinkGateway({baseUrl:'https://evm-rpc.test-net.interlinklabs.ai/v1',chainId:19042026,siweDomain:'interlinklabs.ai',timeoutMs:15000,wallet,now:()=>clock});
  const chain=new NativeTransfers(gateway,{wallet,chainId:19042026,maxFeePerGas:100n*10n**9n,maxGasLimit:100000n});
  await chain.initialize();
  console.log('SIWE validation and login passed. Chain: 19042026 / 0x1228eea.');
  const [balance,block,gasPrice,priority,nonce]=await Promise.all([
    chain.balance(),chain.blockNumber(),gateway.rpc<string>('eth_gasPrice',[]),gateway.rpc<string>('eth_maxPriorityFeePerGas',[]),chain.confirmedNonce(),
  ]);
  console.log(JSON.stringify({balance_tITL:tokens(balance),block:block.toString(),gasPriceWei:BigInt(gasPrice).toString(),maxPriorityFeeWei:BigInt(priority).toString(),nonce}));
  // Advance only the local expiry clock to exercise refresh without a 15-minute wait.
  clock+=14*60_000+1001;
  await chain.blockNumber();
  console.log('Token refresh and subsequent authenticated RPC passed.');
  console.log('No transactions were signed or sent. The temporary wallet and tokens were not saved.');
} catch (error) {console.error(safeError(error));process.exitCode=1;}
