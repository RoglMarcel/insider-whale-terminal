"""Publish truthful per-stage health and retain last-success timestamps in SQLite."""
import json
import os
from pathlib import Path
import sqlite3
from datetime import datetime, timezone

STATUSES = {'success', 'partial', 'failed', 'skipped'}


def stage(outcome, report, previous):
    previous = previous or {}
    if outcome == 'skipped':
        report = {'status': 'skipped', 'reason': 'desktop_publish'}
    elif outcome != 'success' or not report or report.get('status') not in STATUSES:
        report = {'status': 'failed', 'reason': 'update_failed'}
    result = dict(report)
    result.setdefault('checkedAt', datetime.now(timezone.utc).isoformat())
    result['lastSuccessAt'] = (report.get('checkedAt') if report['status'] == 'success'
                               else previous.get('lastSuccessAt'))
    return result


def read(path, fallback=None):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def build(meta, portfolio, reports, outcomes, previous):
    stages = {key: stage(outcomes[key], reports.get(key), previous.get(key))
              for key in ('portfolio', 'outcomes')}
    status = meta.get('status')
    stages['signals'] = stage('success', {
        'status': status if status in STATUSES else 'failed',
        'reason': 'updated' if status == 'success' else 'source_errors',
        'checkedAt': meta.get('generatedAt'),
    }, previous.get('signals'))
    stages['signals']['lastUpdatedAt'] = meta.get('signalAsOf') or meta.get('generatedAt')
    stages['signals']['source'] = meta.get('source', 'unknown')
    stages['portfolio']['lastUpdatedAt'] = (portfolio or {}).get('meta', {}).get('lastRun')
    if not portfolio:
        stages['portfolio']['status'] = 'failed'
        stages['portfolio']['reason'] = 'unavailable'
        stages['portfolio']['lastSuccessAt'] = previous.get('portfolio', {}).get('lastSuccessAt')
    result = {'checkedAt': datetime.now(timezone.utc).isoformat(), 'stages': stages}
    result['status'] = 'partial' if any(s['status'] in ('partial', 'failed') for s in stages.values()) else 'success'
    return result


if __name__ == '__main__':
    out = Path('public/data')
    with sqlite3.connect('data/insider-tracker.db') as db:
        row = db.execute("SELECT value FROM app_settings WHERE key='web_update_health'").fetchone()
        previous = json.loads(row[0]).get('stages', {}) if row else {}
        health = build(read(out / 'meta.json', {}), read(out / 'portfolio.json'),
                       {k: read(Path(f'tmp/{k}-update.json')) for k in ('portfolio', 'outcomes')},
                       {k: os.environ.get(k.upper() + '_OUTCOME', 'failure') for k in ('portfolio', 'outcomes')}, previous)
        db.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('web_update_health',?)", (json.dumps(health),))
    (out / 'update-health.json').write_text(json.dumps(health, indent=2))
    if health['status'] == 'partial':
        print('::warning::Partial data update; see per-stage update-health.json')
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as stream:
            stream.write('## Data update status\n\nStage | Status | Last successful update\n--- | --- | ---\n')
            for name, item in health['stages'].items():
                stream.write(f"{name} | {item['status']} | {item.get('lastSuccessAt') or 'Unknown'}\n")
