# End-to-end: two real browsers (Asha and Bilal) on a phone-sized screen against the dev server.
# Run: node --no-warnings scripts/dev-server.js &   then   python3 tests/e2e.py
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BASE', 'http://localhost:8787')
API = os.environ.get('CIRCLES_API', BASE + '/api/')
SHOTS = os.path.join(os.path.dirname(__file__), 'shots')
def api(pid, action, body=None):
    b = dict(body or {}); b['login'] = {'id': pid}
    req = urllib.request.Request(f'{API}sq/c/{action}', data=json.dumps(b).encode(), headers={'content-type': 'application/json'})
    return json.loads(urllib.request.urlopen(req).read())

errors = []
with sync_playwright() as p:
    exe = '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome'
    br = p.chromium.launch(executable_path=exe if os.path.exists(exe) else None)
    def phone(pid):
        ctx = br.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(f'{pid}: {e}'))
        pg.on('console', lambda m: m.type == 'error' and errors.append(f'{pid} console: {m.text}'))
        pg.goto(f'{BASE}/?as={pid}'); return pg
    for pid in 'cdefg': api(pid, 'sky')  # on the staging Worker, people appear once they have used circles
    asha, bilal = phone('a'), phone('b')

    # Asha starts a knock circle in the Thinkers room.
    expect(asha.locator('#dyc-launch')).to_be_visible()
    asha.click('#dyc-launch'); asha.wait_for_timeout(400)
    asha.screenshot(path=f'{SHOTS}/01-empty-sky.png')
    asha.click('#dyc-new'); asha.wait_for_timeout(400)
    asha.fill('#dyc-topic', 'The year you would relive')
    asha.fill('#dyc-name', 'Years')
    asha.click('[data-m="knock"]')
    asha.select_option('#dyc-temple', 'thinkers')
    asha.screenshot(path=f'{SHOTS}/02-start-circle.png')
    asha.click('#dyc-light')
    expect(asha.locator('.dyc-sheet .dyc-st')).to_have_text('Years')
    asha.fill('#dyc-say', 'I would pick the year my parents met'); asha.press('#dyc-say', 'Enter')
    expect(asha.locator('.dyc-ln .b')).to_have_text('I would pick the year my parents met')

    # Bilal finds it and knocks.
    bilal.click('#dyc-launch')
    bilal.locator('.dyc-row', has_text='Years').click()
    expect(bilal.locator('#dyc-go')).to_have_text('Knock')
    bilal.screenshot(path=f'{SHOTS}/03-outside-knock.png')
    bilal.click('#dyc-go')
    expect(bilal.locator('.dyc-banner')).to_contain_text('Knocking')

    # Asha lets him in; Bilal flies in on his own.
    expect(asha.locator('.dyc-knock')).to_contain_text('Bilal', timeout=8000)
    asha.screenshot(path=f'{SHOTS}/04-founder-sees-knock.png')
    asha.click('.dyc-knock [data-a="in"]')
    expect(bilal.locator('.dyc-sheet.on .dyc-st')).to_have_text('Years', timeout=10000)
    expect(bilal.locator('.dyc-ln .b').first).to_have_text('I would pick the year my parents met', timeout=8000)

    # Bilal invites Chandni: becomes a sponsored knock for Asha.
    bilal.click('#dyc-inv'); bilal.locator('[data-pid="c"]').click()
    expect(bilal.locator('[data-pid="c"]')).to_contain_text('Sent as a knock')
    bilal.click('#dyc-back')
    expect(asha.locator('.dyc-knock')).to_contain_text('Bilal wants to bring Chandni', timeout=8000)

    # Pin a line, give light.
    asha.locator('.dyc-ln').first.click(); asha.locator('.dyc-ln').first.click()
    expect(asha.locator('#dyc-pinned .dyc-pin')).to_contain_text('parents met', timeout=6000)
    asha.click('#dyc-give')
    expect(asha.locator('#dyc-lt')).to_contain_text('1 of 10 light', timeout=6000)
    asha.screenshot(path=f'{SHOTS}/05-inside.png')

    # Founder switches mode to invite only; others see only name and theme.
    asha.click('[data-mode="invite"]'); asha.wait_for_timeout(600)
    api('f', 'new', {'topic': 'Open questions', 'mode': 'open', 'temple': 'lovers'})
    sky = api('g', 'sky')
    years = [c for c in sky['circles'] if c['name'] == 'Years'][0]
    assert 'people' not in years and 'count' not in years, years

    # Enough light from five people turns it into a star when everyone leaves.
    cid = years['id']
    for pid in ['c', 'd', 'e']:
        api('a', 'invite', {'pid': pid}); api(pid, 'join', {'id': cid})
    for pid in ['b', 'c', 'd', 'e']:
        for _ in range(3 if pid != 'e' else 0): api(pid, 'light', {'kind': 'circle', 'id': cid})
    api('e', 'light', {'kind': 'circle', 'id': cid})
    for pid in ['c', 'd', 'e']: api(pid, 'leave')
    bilal.click('#dyc-min'); bilal.wait_for_timeout(300)
    bilal.screenshot(path=f'{SHOTS}/06-sky-with-circles.png')
    bilal.click('#dyc-close'); bilal.click('#dyc-launch'); bilal.click('#dyc-out'); bilal.click('#dyc-out')
    asha.click('#dyc-out'); asha.click('#dyc-out')
    bilal.wait_for_timeout(500); bilal.click('#dyc-close'); bilal.click('#dyc-launch'); bilal.wait_for_timeout(1200)
    expect(bilal.locator('.dyc-row', has_text='Years')).to_contain_text('parents met', timeout=8000)
    bilal.screenshot(path=f'{SHOTS}/07-star-born.png')
    bilal.locator('.dyc-row', has_text='Years').click()
    expect(bilal.locator('.dyc-sheet.on')).to_contain_text('What was said', timeout=6000)
    bilal.screenshot(path=f'{SHOTS}/08-star-sheet.png')

    # Room filter.
    bilal.click('.dyc-sx'); bilal.wait_for_timeout(400)
    bilal.click('[data-r="lovers"]'); bilal.wait_for_timeout(300)
    expect(bilal.locator('.dyc-row')).to_have_count(1)
    bilal.screenshot(path=f'{SHOTS}/09-lovers-room.png')
    br.close()

if errors:
    print('ERRORS:', *errors, sep='\n'); sys.exit(1)
print('e2e passed')
