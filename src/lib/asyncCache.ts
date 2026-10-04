/** Success TTL; failure retry; request deduplication; bounded storage; safe invalidation. */
export class AsyncCache<T> {
  private values=new Map<string,{at:number;value:T}>();
  private pending=new Map<string,Promise<T>>();
  private generation=0;
  constructor(private ttl:number|((value:T)=>number),private max=200,private clock=Date.now) {}
  clear() { this.generation++; this.values.clear(); this.pending.clear(); }
  async get(key:string,loader:()=>Promise<T>):Promise<T> {
    const prior=this.values.get(key);
    if (prior && this.clock()-prior.at<(typeof this.ttl==='number'?this.ttl:this.ttl(prior.value))) return prior.value;
    const pending=this.pending.get(key); if (pending) return pending;
    if(this.pending.size>=this.max)throw new Error('Request capacity reached; retry shortly');
    const generation=this.generation;
    const task=Promise.resolve().then(loader).then(value=>{
      if (generation===this.generation) {
        if(this.values.size>=this.max)this.values.delete(this.values.keys().next().value!);
        this.values.set(key,{at:this.clock(),value});
      }
      return value;
    });
    this.pending.set(key,task);
    try {return await task;} finally {if(this.pending.get(key)===task)this.pending.delete(key);}
  }
}
