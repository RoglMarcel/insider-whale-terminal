import type { AppSettings } from '../src/types';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23' });
function parts(time: number): Record<string,string> { return Object.fromEntries(formatter.formatToParts(time).map(p=>[p.type,p.value])); }
export function marketInstant(day: string, time: string): Date {
  const [hour,minute]=time.split(':').map(Number);
  for (const offset of [4,5]) {
    const instant=Date.parse(`${day}T00:00:00Z`)+(hour+offset)*3600000+minute*60000;
    const p=parts(instant);
    if (`${p.year}-${p.month}-${p.day}`===day && Number(p.hour)===hour && Number(p.minute)===minute) return new Date(instant);
  }
  throw new Error('Unable to resolve New York market time');
}
/** At most 33 one-shot triggers, each with that date's NY offset, below Windows' 48-trigger limit. */
export function upcomingMarketRuns(settings: AppSettings, now=Date.now()): Date[] {
  if (!settings.scheduleEnabled) return [];
  const p=parts(now), day=Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
  const selected=Object.entries({marketOpen:'09:30',midday:'12:00',close:'16:00'}).filter(([key])=>settings.scheduleTimes[key as keyof AppSettings['scheduleTimes']]).map(([,time])=>time);
  const result: Date[]=[];
  for (let n=0;n<15;n++) {
    const date=new Date(day+n*86400000);
    if ([0,6].includes(date.getUTCDay())) continue;
    for (const time of selected) { const at=marketInstant(date.toISOString().slice(0,10),time); if (+at>now) result.push(at); }
  }
  return result;
}
export function scheduleRegistration(exe: string, dates: Date[]): string {
  const safeExe=exe.replace(/'/g,"''");
  const triggers=dates.map(d=>`$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Parse('${d.toISOString()}').ToLocalTime()); $trigger.StartBoundary = '${d.toISOString()}'; $trigger`).join('\n');
  return `$ErrorActionPreference = 'Stop'
    $action = New-ScheduledTaskAction -Execute '${safeExe}' -Argument '--scheduled-scrape'
    $triggers = @( ${triggers} )
    $taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun
    Register-ScheduledTask -TaskName 'InsiderWhaleTerminal_DailyScrape' -Action $action -Trigger $triggers -Settings $taskSettings -Force | Out-Null`;
}
