import { parse } from 'csv-parse/sync';
import { addressKey, FaucetError, tokens, txUrl, type Payout } from './domain.js';

export const MAX_CSV_BYTES=256*1024;
const HEADERS=new Set(['address','wallet','wallet_address','walletaddress']);
export function parseAddressCsv(content: string, maxRows: number): {addresses: string[]; duplicateCount: number} {
  if (Buffer.byteLength(content,'utf8')>MAX_CSV_BYTES) throw new FaucetError('CSV_SIZE','CSV attachments must be 256 KB or smaller.');
  let rows: string[][];
  try { rows=parse(content,{bom:true,trim:true,skip_empty_lines:true,relax_column_count:true,max_record_size:2000}) as string[][]; }
  catch { throw new FaucetError('CSV_FORMAT','This CSV could not be read. Use one address per row, with an optional address header.'); }
  if (!rows.length) throw new FaucetError('CSV_EMPTY','The CSV is empty.');
  const first=rows[0]!;
  const headerColumns=first.map((cell,i)=>HEADERS.has(cell.toLowerCase())?i:-1).filter(i=>i>=0);
  if (headerColumns.length>1) throw new FaucetError('CSV_HEADER','Use exactly one address column.');
  const hasHeader=headerColumns.length===1;
  const column=headerColumns[0]??0;
  const data=hasHeader?rows.slice(1):rows;
  if (!data.length || data.length>maxRows) throw new FaucetError('BATCH_SIZE',`The CSV must contain between 1 and ${maxRows} address rows.`);
  const addresses: string[]=[];
  const failures: number[]=[];
  for (const [index,row] of data.entries()) {
    try {
      if (!hasHeader && row.length!==1) throw new Error();
      addresses.push(addressKey(row[column]??''));
    } catch { failures.push(index+(hasHeader?2:1)); }
  }
  if (failures.length) throw new FaucetError('CSV_ADDRESSES',`Invalid or missing wallet addresses on CSV row(s): ${failures.slice(0,10).join(', ')}${failures.length>10?'…':''}. Fix the file before confirming any payouts.`);
  const unique=[...new Set(addresses)];
  return {addresses:unique,duplicateCount:addresses.length-unique.length};
}

export async function downloadCsv(attachment:{url:string;name:string|null;size:number}, fetcher:typeof fetch=fetch): Promise<string> {
  if (!attachment.name?.toLowerCase().endsWith('.csv')) throw new FaucetError('CSV_TYPE','Upload a .csv file.');
  if (attachment.size>MAX_CSV_BYTES) throw new FaucetError('CSV_SIZE','CSV attachments must be 256 KB or smaller.');
  let url: URL;
  try { url=new URL(attachment.url); } catch { throw new FaucetError('CSV_URL','Invalid Discord attachment URL.'); }
  if (url.protocol!=='https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname) || url.username || url.password) throw new FaucetError('CSV_URL','Only attachments uploaded directly to Discord are accepted.');
  let response: Response;
  try { response=await fetcher(url,{signal:AbortSignal.timeout(15000),redirect:'error'}); }
  catch { throw new FaucetError('CSV_DOWNLOAD','The CSV download failed. Upload it again and retry.'); }
  if (!response.ok || !response.body) throw new FaucetError('CSV_DOWNLOAD','Discord could not provide the CSV attachment. Upload it again.');
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let bytes=0;
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) break;
      bytes+=value.byteLength;
      if (bytes>MAX_CSV_BYTES) { await reader.cancel(); throw new FaucetError('CSV_SIZE','CSV attachments must be 256 KB or smaller.'); }
      chunks.push(value);
    }
    return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  } catch (error) {
    if (error instanceof FaucetError) throw error;
    throw new FaucetError('CSV_ENCODING','The CSV must be a readable UTF-8 text file.');
  } finally { reader.releaseLock(); }
}

function cell(value: string): string { return `"${value.replace(/"/g,'""')}"`; }
export function batchReport(payouts: Payout[], explorerUrl: string): Buffer {
  const rows=[['payout_id','address','amount_tITL','status','tx_hash','explorer_url','error_code']];
  for (const p of payouts) rows.push([p.id,p.address,tokens(p.amountWei),p.status,p.txHash??'',p.txHash?txUrl(explorerUrl,p.txHash):'',p.errorCode??'']);
  return Buffer.from(rows.map(row=>row.map(cell).join(',')).join('\r\n'),'utf8');
}
