import { FaucetError } from './domain.js';

/** Bounds concurrent request work and waiting memory; accepted payouts live in Postgres. */
export class WorkQueue {
  private active=0;
  private readonly keys=new Set<string>();
  private readonly waiting:{start:()=>void;timer:ReturnType<typeof setTimeout>}[]=[];
  constructor(private readonly concurrency=8,private readonly maxWaiting=100,private readonly waitMs=60_000) {
    if (!Number.isInteger(concurrency) || concurrency<1 || !Number.isInteger(maxWaiting) || maxWaiting<0 || waitMs<=0) throw new Error('Invalid work queue limits');
  }
  get size():number {return this.active+this.waiting.length;}
  run<T>(key:string,work:()=>Promise<T>):Promise<T> {
    if (this.keys.has(key)) return Promise.reject(new FaucetError('REQUEST_IN_PROGRESS','Your earlier request is still being checked. Please wait for its status before trying again.'));
    if (this.active>=this.concurrency && this.waiting.length>=this.maxWaiting) return Promise.reject(this.busy());
    this.keys.add(key);
    return new Promise<T>((resolve,reject)=>{
      const start=()=>{
        this.active++;
        const finish=()=>{
          this.keys.delete(key);this.active--;
          const next=this.waiting.shift();
          if (next) {clearTimeout(next.timer);next.start();}
        };
        void Promise.resolve().then(work).then(value=>{finish();resolve(value);},error=>{finish();reject(error);});
      };
      if (this.active<this.concurrency) {start();return;}
      const entry={start,timer:setTimeout(()=>{
        const index=this.waiting.indexOf(entry);
        if (index<0) return;
        this.waiting.splice(index,1);this.keys.delete(key);reject(this.busy());
      },this.waitMs)};
      this.waiting.push(entry);
    });
  }
  private busy():FaucetError {
    return new FaucetError('BUSY','Lots of requests are being checked right now. This request has not been accepted; please try again shortly.');
  }
}
