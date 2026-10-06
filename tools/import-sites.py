import datetime
import hashlib
import json
from pathlib import Path
import re
import urllib.request

root = Path(__file__).resolve().parents[1]
def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'visave-build'})
    return urllib.request.urlopen(request, timeout=60).read()

metadata = json.loads(fetch('https://api.github.com/repos/yt-dlp/yt-dlp/commits?path=supportedsites.md&per_page=1'))
commit = metadata[0]['sha']
source = fetch(f'https://raw.githubusercontent.com/yt-dlp/yt-dlp/{commit}/supportedsites.md')
groups = {}
entries = 0
for line in source.decode().splitlines():
    match = re.match(r'\s*- \*\*(.+?)\*\*(.*)', line)
    if not match:
        continue
    name, description = match.groups()
    name = name.replace('\u200b', '')
    base = name.split(':')[0]
    group = groups.setdefault(base.casefold(), {'name': base, 'names': [], 'broken': False})
    group['names'].append(name)
    group['broken'] |= 'Currently broken' in description
    entries += 1
assert entries > 1000, 'Upstream format changed; refusing to publish an incomplete list.'
data = {'imported': datetime.date.today().isoformat(), 'commit': commit, 'source': 'https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md', 'sha256': hashlib.sha256(source).hexdigest(), 'extractors': entries, 'groups': sorted(groups.values(), key=lambda group: group['name'].casefold())}
(root / 'extension/sites-data.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print(f'Imported {entries} extractors into {len(groups)} groups; commit {commit}.')
