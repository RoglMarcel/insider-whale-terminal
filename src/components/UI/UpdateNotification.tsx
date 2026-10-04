import { useEffect, useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { api } from '@/lib/ipc';

export function UpdateNotification() {
  const { t } = useI18n();
  const [status, setStatus] = useState<'idle' | 'available' | 'downloaded'>('idle');
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    // Query cached status on mount to resolve background/hidden startup race conditions
    api.app.getUpdateStatus()
      .then((res) => {
        if (res && res.status !== 'idle') {
          setVersion(res.version);
          setStatus(res.status);
        }
      })
      .catch(() => undefined);

    const unsubAvailable = api.app.onUpdateAvailable((ver) => {
      setVersion(ver);
      setStatus('available');
    });

    const unsubDownloaded = api.app.onUpdateDownloaded((ver) => {
      setVersion(ver);
      setStatus('downloaded');
    });

    return () => { unsubAvailable(); unsubDownloaded(); };
  }, []);

  if (status === 'idle') return null;
  return (
    <details className="data-note">
      <summary>{status === 'downloaded' ? t('upd.ready') : t('upd.downloading')}</summary>
      <div className="data-note-body">
        <p>{status === 'downloaded' ? t('upd.readyBody', { version }) : t('upd.downloadingBody', { version })}</p>
        {status === 'downloaded' && <div className="mt-2 flex gap-2">
          <button className="btn" onClick={() => setStatus('idle')}>{t('upd.later')}</button>
          <button className="btn" onClick={() => void api.app.quitAndInstall()}>{t('upd.restart')}</button>
        </div>}
      </div>
    </details>
  );
}
