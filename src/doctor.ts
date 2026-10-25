import { loadConfig } from './config.js';
import { InterlinkGateway } from './chain/gateway.js';
import { NativeTransfers } from './chain/transfers.js';
import { safeError, tokens } from './domain.js';

try {
  const config=loadConfig();
  const gateway=new InterlinkGateway({baseUrl:config.rpcBaseUrl,chainId:config.chainId,siweDomain:config.siweDomain,timeoutMs:config.rpcTimeoutMs,wallet:config.wallet});
  const chain=new NativeTransfers(gateway,{wallet:config.wallet,chainId:config.chainId,maxFeePerGas:config.maxFeePerGas,maxGasLimit:config.maxGasLimit});
  await chain.initialize();
  console.log(`Gateway login and chain ID verified: ${config.chainId} (0x${config.chainId.toString(16)}).`);
  console.log(`Funding wallet: ${config.wallet.address}`);
  console.log(`Balance: ${tokens(await chain.balance())} ${config.symbol}`);
  console.log('Read-only diagnostics passed. No transactions were signed or sent.');
} catch (error) {console.error(safeError(error));process.exitCode=1;}
