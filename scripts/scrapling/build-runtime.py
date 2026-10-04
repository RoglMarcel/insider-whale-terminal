"""Build a self-contained native Scrapling worker, with no end-user Python setup."""
import json
import hashlib
import subprocess
import sys
from pathlib import Path
from importlib.metadata import distributions

root=Path(__file__).resolve().parents[2]
out=root/'build/scrapling-runtime'
subprocess.run([sys.executable,'-m','PyInstaller','--noconfirm','--onedir','--name','scrapling-fetch',
 '--distpath',str(out),'--workpath',str(root/'tmp/scrapling-freeze'),'--specpath',str(root/'tmp'),
 '--collect-all','curl_cffi','--collect-data','scrapling','--copy-metadata','scrapling',
 '--collect-data','tld','--collect-data','browserforge','--collect-data','apify_fingerprint_datapoints','--hidden-import','scrapling.fetchers.requests',
 str(root/'scripts/scrapling/fetch.py')],check=True,cwd=root)
worker=out/'scrapling-fetch'/('scrapling-fetch.exe' if sys.platform=='win32' else 'scrapling-fetch')
health=subprocess.run([str(worker)],input='{"mode":"health"}',text=True,capture_output=True,check=True)
info=json.loads(health.stdout)
if info!={'engine':'scrapling','version':'0.4.15','frozen':True}:raise RuntimeError('Incorrect bundled engine')
notices=[]
for dist in distributions():
    sections=[]
    for file in dist.files or []:
        if any(word in file.name.lower() for word in ['license','copying','notice']) and file.suffix.lower() in {'.txt','.md',''}:
            try:sections.append(dist.locate_file(file).read_text(errors='replace'))
            except (OSError,UnicodeError):pass
    if sections:notices.append(dist.metadata['Name']+'\n'+'\n'.join(sections))
python_license=Path(sys.base_prefix)/'LICENSE.txt'
if python_license.exists():notices.append('Python\n'+python_license.read_text())
(worker.parent/'THIRD-PARTY-NOTICES.txt').write_text('\n\n'.join(notices),encoding='utf-8')
(worker.parent/'runtime.json').write_text(json.dumps({**info,'sourceSha256':hashlib.sha256((root/'scripts/scrapling/fetch.py').read_bytes()).hexdigest()}))
print(json.dumps({'worker':str(worker),**info}))
