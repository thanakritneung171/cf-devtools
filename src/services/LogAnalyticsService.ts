export class LogAnalyticsService {

  constructor(private logs:any[]) {}

parseLog(log:any){

if(!log?.Event?.Request?.URL) return null;

 const parsed=new URL(log.Event.Request.URL);

 return {

  ip:"unknown",
  method:log?.Event?.Request?.Method || "GET",
  path:parsed.pathname,
  status:log?.Event?.Response?.Status || 200,
  latency:log?.WallTimeMs || 0,
  timestamp:log?.EventTimestampMs || 0

 };

}

  getDashboard() {

    let total = 0;
    let errors = 0;

    const api:Record<string,number> = {};
    const ips:Set<string> = new Set();

    for (const raw of this.logs) {

      const log = this.parseLog(raw);
      if (!log) continue;

      total++;

      ips.add(log.ip);

      api[log.path] = (api[log.path] || 0) + 1;

      if (log.status >= 400) errors++;
    }

    const topApi = Object.entries(api)
      .sort((a,b)=>b[1]-a[1])
      .slice(0,10);

    return {
      total_requests: total,
      errors,
      unique_ips: ips.size,
      top_api: topApi
    };
  }

getTopIPs(){

 const ips:Record<string,number>={}

 for(const raw of this.logs){

  const log=this.parseLog(raw)
  if(!log) continue

  const ip = log.ip || "unknown"

  ips[ip]=(ips[ip]||0)+1

 }

 return Object.entries(ips)
  .sort((a,b)=>b[1]-a[1])
  .slice(0,10)

}

getRecentErrors(){

const errors:any[]=[];

 for(const raw of this.logs || []){

  const log=this.parseLog(raw);

  if(!log) continue;

  if((log.status || 0) >= 400){

   errors.push({
    ip:log.ip || "unknown",
    url:log.path || "-",
    status:log.status || 0,
    time:log.timestamp || 0
   });

  }

 }

 return errors.slice(-20);

}

}