import { useEffect,useState } from 'react';
import { useI18n } from '@/hooks/useI18n';
import { api } from '@/lib/ipc';
import type { SoftwareUpdateState } from '@/types/softwareUpdate';
export function UpdateNotification(){
  const {language}=useI18n();const de=language==='de';
  const [state,setState]=useState<SoftwareUpdateState>({status:'idle',version:''});
  const [installed,setInstalled]=useState('');
  useEffect(()=>{
    let active=true;
    const read=()=>void api.app.getUpdateStatus().then(s=>{if(active)setState(s);}).catch(e=>{if(active)setState(s=>({...s,status:'error',error:String(e)}));});
    read();void api.app.getVersion().then(v=>{if(active)setInstalled(v);}).catch(()=>undefined);
    const a=api.app.onUpdateAvailable(read),b=api.app.onUpdateDownloaded(read),c=api.app.onUpdateError(read);
    const timer=setInterval(read,2000);
    return()=>{active=false;clearInterval(timer);a();b();c();};
  },[]);
  const check=async()=>{setState(s=>({...s,status:'checking',error:undefined}));try{setState(await api.app.checkForSoftwareUpdates());}catch(e){setState(s=>({...s,status:'error',error:String(e)}));}};
  const labels=de?{idle:'Noch nicht geprüft',checking:'Prüfung läuft',available:'Update wird geladen',downloaded:'Bereit zur Installation',current:'Aktuell',error:'Update fehlgeschlagen'}:{idle:'Not checked yet',checking:'Checking',available:'Downloading update',downloaded:'Ready to install',current:'Up to date',error:'Update failed'};
  return <details className="data-note" open={state.status==='error'||state.status==='downloaded'}>
    <summary>{de?'Softwareupdates':'Software updates'} · {installed} · {labels[state.status]}</summary>
    <div className="data-note-body space-y-2" aria-live="polite">
      <p>{de?'Diese Prüfung aktualisiert die Anwendung. Finanzdaten werden separat aktualisiert.':'This check updates the application. Financial data is refreshed separately.'}</p>
      {state.version&&<p>Version {state.version}{state.progress!=null?` · ${state.progress.toFixed(0)}%`:''}</p>}
      {state.checkedAt&&<p>{de?'Letzte Prüfung':'Last check'}: {new Date(state.checkedAt).toLocaleString(de?'de-DE':'en-US')}</p>}
      {state.error&&<p role="alert">{state.error}</p>}
      <button className="btn" disabled={state.status==='checking'} onClick={()=>void check()}>{state.status==='error'?(de?'Erneut versuchen':'Retry'):(de?'Auf Softwareupdate prüfen':'Check for software update')}</button>
      {state.status==='downloaded'&&<button className="btn" onClick={()=>void api.app.quitAndInstall().catch(e=>setState(s=>({...s,status:'error',error:String(e)})))}>{de?'Neu starten und installieren':'Restart and install'}</button>}
    </div>
  </details>;
}
