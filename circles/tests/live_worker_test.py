# Tests circles inside the real live Worker code (worker/worker.js after patch-worker.mjs), running locally in
# Cloudflare's runtime with a local D1 and KV and a throwaway bot token. Nothing real is contacted.
#
# From the repo root:
#   node circles/scripts/patch-worker.mjs worker/worker.js        (already applied on the feature/circles-worker branch)
#   mkdir -p /tmp/live && cp worker/worker.js /tmp/live/ && cp circles/tests/live-wrangler.toml /tmp/live/wrangler.toml
#   (cd /tmp/live && npx wrangler dev --local --port 8790) &
#   python3 circles/tests/live_worker_test.py
import hashlib, hmac, json, os, subprocess, time, urllib.request

TOK = '123:local-test-token'
BASE = os.environ.get('LIVE_BASE', 'http://127.0.0.1:8790') + '/api/sq/c/'
LIVE_DIR = os.environ.get('LIVE_DIR', '/tmp/live')
WRANGLER = os.environ.get('WRANGLER', 'npx wrangler')

def login(uid):
    d = {'id': uid, 'first_name': 'T', 'auth_date': int(time.time())}
    dcs = '\n'.join(f'{k}={d[k]}' for k in sorted(d))
    d['hash'] = hmac.new(hashlib.sha256(TOK.encode()).digest(), dcs.encode(), hashlib.sha256).hexdigest()
    return d

def call(uid, action, body=None, origin='https://lab.dionysty.pages.dev'):
    b = dict(body or {}); b['login'] = login(uid)
    req = urllib.request.Request(BASE + action, data=json.dumps(b).encode(), headers={'content-type': 'application/json', 'Origin': origin})
    try:
        r = urllib.request.urlopen(req); return json.loads(r.read()), r.headers.get('Access-Control-Allow-Origin')
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), None

# Unregistered people are refused.
r, _ = call(999, 'sky'); assert r['ok'] is False and 'register' in r['error'], r
# Seed three members in the existing people table.
sql = ("INSERT OR REPLACE INTO people (uid,pid,alias,member,temples,at) VALUES "
       "('111','pa','Asha',1,'[\"thinkers\"]',0),('222','pb','Bilal',1,'[\"artists\"]',0),('333','pc','Chandni',1,'[]',0);")
subprocess.run(f'{WRANGLER} d1 execute localtest --local --command "{sql.replace(chr(34), chr(92)+chr(34))}"', shell=True, cwd=LIVE_DIR, capture_output=True)

# Bad signature is refused by the Worker's own auth.
bad = login(111); bad['hash'] = '0' * 64
req = urllib.request.Request(BASE + 'sky', data=json.dumps({'login': bad}).encode(), headers={'content-type': 'application/json'})
try: urllib.request.urlopen(req); assert False, 'bad hash accepted'
except urllib.error.HTTPError as e: assert e.code == 401

r, cors = call(111, 'sky'); assert r['ok'] and cors == 'https://lab.dionysty.pages.dev', (r, cors)
for uid in (111, 222): call(uid, 'leave')
cid = call(111, 'new', {'topic': 'Years', 'mode': 'knock', 'temple': 'thinkers'})[0]['cid']
assert call(222, 'join', {'id': cid})[0].get('knock') is True
assert call(222, 'knock', {'id': cid})[0]['ok']
k = call(111, 'state')[0]['knocks']; assert k[0]['alias'] == 'Bilal'
assert call(111, 'answer', {'kid': k[0]['kid'], 'yes': True})[0]['ok']
assert call(222, 'join', {'id': cid})[0]['ok']
ppl = call(222, 'people')[0]['people']; assert {p['alias'] for p in ppl} == {'Asha', 'Chandni'}, ppl
assert call(222, 'invite', {'pid': 'pc'})[0]['sent'] == 'knock'
st = call(111, 'state')[0]; assert st['knocks'][0]['sponsor'] == 'Bilal' and len(st['members']) == 2
assert call(111, 'mode', {'mode': 'invite'})[0]['ok']
outside = [c for c in call(333, 'sky')[0]['circles'] if c['id'] == cid][0]
assert 'people' not in outside and 'count' not in outside, outside
assert call(222, 'say', {'text': 'hello'})[0]['ok']
assert call(222, 'light', {'kind': 'circle', 'id': cid})[0]['left'] == 4
call(111, 'leave'); call(222, 'leave')
assert not [c for c in call(333, 'sky')[0]['circles'] if c['id'] == cid], 'circle should disperse'
print('live worker circles test passed')
