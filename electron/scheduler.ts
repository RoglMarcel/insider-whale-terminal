import { marketInstant, upcomingMarketRuns, scheduleRegistration } from './marketSchedule';
import cron, { type ScheduledTask } from 'node-cron';
import type { AppSettings } from '../src/types';
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Auto-refresh scheduler. Cron jobs fire at market open (9:30), midday (12:00),
 * and close (16:00) Eastern, on weekdays only. node-cron handles the timezone.
 */
const TIMEZONE = 'America/New_York';

const CRON_TIMES = {
  marketOpen: '30 9 * * 1-5', // 9:30 AM ET, Mon–Fri
  midday: '0 12 * * 1-5', // 12:00 PM ET
  close: '0 16 * * 1-5', // 4:00 PM ET
} as const;

let tasks: ScheduledTask[] = [];

export function stopScheduler(): void {
  for (const t of tasks) {
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }
  tasks = [];
}

/**
 * Robustly converts New York time (ET, e.g. "09:30") to user's local system time (HH:MM)
 * based on current active Daylight Saving Time offsets.
 */
export function getLocalTimeForET(etTimeStr: string): string {
  const day = new Intl.DateTimeFormat('en-CA', {timeZone: TIMEZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const date = marketInstant(day, etTimeStr);
  return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}

let taskSync = Promise.resolve();
export function syncTaskScheduler(settings: AppSettings): Promise<void> {
  const snapshot = structuredClone(settings);
  taskSync = taskSync.catch(() => undefined).then(async () => {
    if (process.platform !== 'win32' || !app.isPackaged) return;
    const dates = upcomingMarketRuns(snapshot);
    if (dates.length) {
      // Register successfully before removing legacy tasks; failure preserves the existing schedule.
      await execFileAsync('powershell', ['-NoProfile','-NonInteractive','-Command',scheduleRegistration(app.getPath('exe'), dates)], { windowsHide: true });
    }
    const obsolete = ['InsiderWhaleTerminal_MarketOpen','InsiderWhaleTerminal_Midday','InsiderWhaleTerminal_MarketClose'];
    if (!dates.length) obsolete.push('InsiderWhaleTerminal_DailyScrape');
    for (const name of obsolete) await execFileAsync('schtasks',['/delete','/tn',name,'/f'],{windowsHide:true}).catch(() => undefined);
  });
  return taskSync;
}

/**
 * (Re)configure the scheduler from settings. Call again whenever settings change.
 */
export function configureScheduler(
  settings: AppSettings,
  triggerMain: () => void,
  triggerNews: () => void,
): void {
  stopScheduler();

  // Synchronize Windows Task Scheduler tasks in background
  syncTaskScheduler(settings).catch((err) => {
    console.error('[scheduler] Task Scheduler sync failed:', err);
  });

  if (!settings.scheduleEnabled) return;
  tasks.push(cron.schedule('5 0 * * *', () => { void syncTaskScheduler(settings).catch(console.error); }, { timezone: TIMEZONE }));

  const add = (expr: string) => {
    const task = cron.schedule(expr, triggerMain, { timezone: TIMEZONE });
    tasks.push(task);
  };

  if (settings.scheduleTimes.marketOpen) add(CRON_TIMES.marketOpen);
  if (settings.scheduleTimes.midday) add(CRON_TIMES.midday);
  if (settings.scheduleTimes.close) add(CRON_TIMES.close);

  // Live News cron: every 15 minutes (24/7). A fresh headless browser launch +
  // x.com scrape every 5 min was heavy and a bot-detection trigger; the scrape is
  // also single-flighted (see runTwitterScrape) so overlapping ticks are no-ops.
  const newsTask = cron.schedule('*/15 * * * *', triggerNews);
  tasks.push(newsTask);

  // Trigger news scrape immediately on startup/config
  Promise.resolve().then(triggerNews).catch(() => undefined);
}

/** Human-readable summary of the next scheduled runs (for the UI/logs). */
export function describeSchedule(settings: AppSettings): string[] {
  if (!settings.scheduleEnabled) return [];
  const out: string[] = [];
  if (settings.scheduleTimes.marketOpen) out.push('9:30 AM ET — Market Open');
  if (settings.scheduleTimes.midday) out.push('12:00 PM ET — Midday');
  if (settings.scheduleTimes.close) out.push('4:00 PM ET — Market Close');
  return out;
}
