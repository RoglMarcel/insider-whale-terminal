import Database from 'better-sqlite3';

const DB_PATH = 'C:/Users/8marc/AppData/Roaming/insider-tracker/insider-tracker.db';

function main() {
  const db = new Database(DB_PATH, { readonly: true });
  
  const rows = db.prepare(`
    SELECT ticker, score, conviction_level, total_dollar_volume, insider_count, top_insider_role, trade_date, scraped_at, score_breakdown
    FROM signals
    ORDER BY score DESC
  `).all() as any[];

  console.log(`Total signals in DB: ${rows.length}\n`);

  console.log('Score distribution:');
  const distribution: Record<string, number> = {};
  rows.forEach(r => {
    const rounded = Math.floor(r.score);
    distribution[rounded] = (distribution[rounded] || 0) + 1;
  });
  console.log(JSON.stringify(distribution, null, 2));

  console.log('\nTop 15 signals by score:');
  console.log('  TICKER  SCORE  CONVICTION  VOLUME      INSIDERS  ROLE');
  rows.slice(0, 15).forEach(r => {
    console.log(
      `  ${r.ticker.padEnd(6)}  ${String(r.score).padStart(5)}  ${r.conviction_level.padEnd(10)}  $${Math.round(r.total_dollar_volume).toLocaleString('en-US').padEnd(10)}  ${String(r.insider_count).padEnd(8)}  ${r.top_insider_role}`
    );
  });

  console.log('\nBottom 15 signals by score:');
  console.log('  TICKER  SCORE  CONVICTION  VOLUME      INSIDERS  ROLE');
  rows.slice(-15).forEach(r => {
    console.log(
      `  ${r.ticker.padEnd(6)}  ${String(r.score).padStart(5)}  ${r.conviction_level.padEnd(10)}  $${Math.round(r.total_dollar_volume).toLocaleString('en-US').padEnd(10)}  ${String(r.insider_count).padEnd(8)}  ${r.top_insider_role}`
    );
  });

  db.close();
}

main();
