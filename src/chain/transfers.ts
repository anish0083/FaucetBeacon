import { keccak256, toQuantity, type Wallet } from 'ethers';
import { FaucetError, type Payout } from '../domain.js';
import { GatewayError, InterlinkGateway } from './gateway.js';

export type PreparedTransfer = { rawTx: string; txHash: string; nonce: number };
export type Receipt = { transactionHash: string; blockNumber: string; status: string; from: string; to: string | null };
export interface TransferChain {
  initialize(): Promise<void>;
  resetAuthentication(): void;
  balance(): Promise<bigint>;
  prepare(address: string, amount: bigint): Promise<PreparedTransfer>;
  broadcast(rawTx: string, expectedHash: string): Promise<void>;
  receipt(hash: string): Promise<Receipt | null>;
  blockNumber(): Promise<bigint>;
  confirmedNonce(): Promise<number>;
}
export type TransferOptions = {wallet: Wallet; chainId: number; maxFeePerGas: bigint; maxGasLimit: bigint};
function quantity(value: string): bigint {
  if (!/^0x[0-9a-fA-F]+$/.test(value)) throw new GatewayError('RPC_SCHEMA','The gateway returned an invalid Ethereum quantity.');
  return BigInt(value);
}
export class NativeTransfers implements TransferChain {
  private verified=false;
  constructor(private readonly gateway: InterlinkGateway,private readonly options: TransferOptions) {}
  async initialize(): Promise<void> { this.verified=false; await this.gateway.initialize(); this.verified=true; }
  resetAuthentication(): void { this.gateway.resetAuthentication();this.verified=false; }
  private assertReady():void {if (!this.verified) throw new FaucetError('CHAIN_ID','The gateway network has not been verified. Use the admin start or recheck command.');}
  async balance(): Promise<bigint> { this.assertReady();return quantity(await this.gateway.rpc<string>('eth_getBalance',[this.options.wallet.address,'latest'])); }
  async prepare(address: string, amount: bigint): Promise<PreparedTransfer> {
    this.assertReady();
    const ownAddress=this.options.wallet.address;
    const [balance,nonceValue,block,priorityValue,gasPriceValue,estimateValue] = await Promise.all([
      this.balance(),
      this.gateway.rpc<string>('eth_getTransactionCount',[ownAddress,'pending']),
      this.gateway.rpc<{baseFeePerGas?:string}>('eth_getBlockByNumber',['latest',false]),
      this.gateway.rpc<string>('eth_maxPriorityFeePerGas',[]),
      this.gateway.rpc<string>('eth_gasPrice',[]),
      this.gateway.rpc<string>('eth_estimateGas',[{from:ownAddress,to:address,value:toQuantity(amount)}]).catch(error=>{
        if (error instanceof GatewayError && error.code==='RPC_REJECTED') throw new FaucetError('RECIPIENT_REJECTED','The gateway could not estimate a native transfer to this recipient.');
        throw error;
      }),
    ]);
    if (!block.baseFeePerGas) throw new FaucetError('GAS_MODEL','The gateway did not return EIP-1559 base-fee data.');
    const priority=quantity(priorityValue);
    const suggested=quantity(block.baseFeePerGas)*2n+priority;
    const gasPrice=quantity(gasPriceValue);
    const maxFee=suggested>gasPrice?suggested:gasPrice;
    if (maxFee>this.options.maxFeePerGas || priority>maxFee) throw new FaucetError('GAS_LIMIT','Gas fees exceed the configured ceiling. Payouts are paused until an admin restarts them.');
    const estimate=quantity(estimateValue);
    const gasLimit=(estimate*120n+99n)/100n;
    if (estimate<21000n || gasLimit>this.options.maxGasLimit) throw new FaucetError('RECIPIENT_GAS','This recipient needs more gas than the faucet permits.');
    if (balance<amount+gasLimit*maxFee) throw new FaucetError('LOW_BALANCE','The funding wallet needs more tITL for the payout and gas.');
    const nonce=Number(quantity(nonceValue));
    if (!Number.isSafeInteger(nonce) || nonce<0) throw new FaucetError('RPC_SCHEMA','The wallet nonce is outside the supported range.');
    let rawTx: string;
    try { rawTx=await this.options.wallet.signTransaction({type:2,chainId:this.options.chainId,nonce,to:address,value:amount,gasLimit,maxFeePerGas:maxFee,maxPriorityFeePerGas:priority}); }
    catch { throw new FaucetError('SIGNING','The native transfer could not be signed.'); }
    return {rawTx,txHash:keccak256(rawTx),nonce};
  }
  async broadcast(rawTx: string, expectedHash: string): Promise<void> {
    this.assertReady();
    const hash=await this.gateway.rpc<string>('eth_sendRawTransaction',[rawTx]);
    if (typeof hash!=='string' || hash.toLowerCase()!==expectedHash.toLowerCase()) throw new GatewayError('TX_HASH_MISMATCH','The gateway returned a different transaction hash. The faucet is paused for review.');
  }
  async receipt(hash: string): Promise<Receipt | null> {
    this.assertReady();
    // This gateway can hang on receipt requests for unknown hashes. A transaction
    // lookup returns null promptly, allowing the saved signature's first broadcast.
    const transaction=await this.gateway.rpc<{hash:string;blockNumber:string|null}|null>('eth_getTransactionByHash',[hash]);
    if (transaction===null) return null;
    if (!transaction || typeof transaction.hash!=='string' || transaction.hash.toLowerCase()!==hash.toLowerCase()
      || (transaction.blockNumber!==null && !/^0x[0-9a-fA-F]+$/.test(transaction.blockNumber))) {
      throw new GatewayError('RPC_SCHEMA','The gateway returned an invalid transaction lookup.');
    }
    if (transaction.blockNumber===null) return null;
    const receipt=await this.gateway.rpc<Receipt|null>('eth_getTransactionReceipt',[hash]);
    if (receipt && (typeof receipt.transactionHash!=='string' || receipt.transactionHash.toLowerCase()!==hash.toLowerCase() || typeof receipt.from!=='string' || receipt.from.toLowerCase()!==this.options.wallet.address.toLowerCase()
      || (receipt.to!==null && typeof receipt.to!=='string') || !['0x0','0x1'].includes(receipt.status) || !/^0x[0-9a-fA-F]+$/.test(receipt.blockNumber))) throw new GatewayError('RPC_SCHEMA','The receipt did not match this funding wallet and transaction.');
    return receipt;
  }
  async blockNumber(): Promise<bigint> {this.assertReady(); return quantity(await this.gateway.rpc<string>('eth_blockNumber',[])); }
  async confirmedNonce(): Promise<number> {
    this.assertReady();
    const nonce=Number(quantity(await this.gateway.rpc<string>('eth_getTransactionCount',[this.options.wallet.address,'latest'])));
    if (!Number.isSafeInteger(nonce) || nonce<0) throw new GatewayError('RPC_SCHEMA','The gateway returned an invalid confirmed nonce.');
    return nonce;
  }
}

export function receiptMatchesPayout(receipt: Receipt, payout: Payout): boolean {
  return receipt.to?.toLowerCase()===payout.address.toLowerCase() && receipt.transactionHash.toLowerCase()===payout.txHash?.toLowerCase();
}
