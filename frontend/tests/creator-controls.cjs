/* Offline browser mocks on about:blank: every request is intercepted. No live site access. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
scripts.forEach((script, i) => new vm.Script(script, { filename: `frontend-inline-${i}.js` }));
const playwright = require(require.resolve('playwright', { paths: [process.env.CODEX_BROWSER_MODULES || '', path.resolve(path.dirname(process.execPath), '..', 'node_modules'), process.cwd()] }));

(async () => {
  const browser = await playwright.chromium.launch(fs.existsSync(playwright.chromium.executablePath())
    ? { headless: true, executablePath: playwright.chromium.executablePath() }
    : { headless: true, channel: process.env.CODEX_BROWSER_CHANNEL || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1060, height: 960 }, reducedMotion: 'reduce' });
  const errors = [], calls = [], dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
  let account = { balance: 1000, isOwner: false, premium: { active: false, tier: null, expiresAt: null }, freeDaily: { limit: 8, used: 0, remaining: 8 }, freeEmotion: { limit: 1, used: 0, remaining: 1, available: true, resetAt: '2099-01-01T00:00:00Z' } };
  let packs = [{ short_name: 'pack_alpha', title: 'Alpha', role: 'owner' }, { short_name: 'pack_beta', title: 'Beta', role: 'owner' }];
  let job = null, pendingPackResponse = null, failPacks = false;
  let loseStartResponse = false, failRecoveryStatusCount = 0, mockChargeCount = 0;
  const tokenA = 'A'.repeat(43), tokenB = 'B'.repeat(43), tokenC = 'C'.repeat(43);
  const installFixture = savedJob => {
    const storage = new Map();
    Object.defineProperty(window, 'localStorage', { configurable:true, value:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key),clear:()=>storage.clear()} });
    if (!crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{value:()=> '00000000-0000-4000-8000-'+String(Date.now()).slice(-12).padStart(12,'0')});
    localStorage.setItem('stickerTheme', 'editorial');
    localStorage.setItem('stickerLang', 'en');
    localStorage.setItem('stickerLanguageDefaultV2', 'yes');
    localStorage.setItem('stickerMotion', 'reduced');
    if (savedJob) localStorage.setItem('stickerCreatorJob', savedJob);
    window.Telegram = { WebApp: { initData: 'mock-auth', initDataUnsafe: { user: { id: 123 }, start_param: 'pack_'+'A'.repeat(43) }, ready() {}, expand() {}, onEvent() {}, setHeaderColor() {}, setBackgroundColor() {}, openTelegramLink() { throw Error('Real Telegram action attempted'); } } };
  };
  await page.evaluate(installFixture);
  const fixtureRoute = async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: url.pathname.endsWith('.svg')?'image/svg+xml':url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: url.pathname.endsWith('.svg')?'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="48" fill="#cfece5"/><text x="128" y="148" text-anchor="middle" font-size="64">★</text></svg>':'' });
    const body = request.postDataJSON() || {};
    calls.push({ endpoint: url.pathname, body });
    let response;
    if (url.pathname === '/api/balance') response = account;
    else if (url.pathname === '/api/packs/jobs/status') {
      if (failRecoveryStatusCount > 0) {
        failRecoveryStatusCount--;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary mock status failure' }) });
      }
      const visibleJob = body.id ? (job?.id === body.id ? job : null) : (['queued','running'].includes(job?.state) ? job : null);
      response = { ...account, job: visibleJob };
    }
    else if (url.pathname === '/api/my-packs') {
      if (pendingPackResponse) await pendingPackResponse;
      if (failPacks) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Mock unavailable' }) });
      response = { packs };
    } else if (url.pathname === '/api/my-packs/stickers') {
      const saved = packs.find(pack => pack.short_name === body.shortName);
      response = { pack: { shortName: body.shortName, title: saved?.title, role: saved?.role }, stickers: [] };
    } else if (url.pathname === '/api/packs/jobs/start') {
      job = { id: body.requestId, state: 'running', total: body.count, attempted: 1, cost: body.expectedCost, charged: body.expectedCost, images: [], packLink: null, packError: null };
      account = { ...account, balance: account.balance - body.expectedCost };
      mockChargeCount++;
      if (!account.premium.active && !account.isOwner) account = { ...account, freeDaily:{ limit:8,used:body.count,remaining:8-body.count },freeEmotion:{...account.freeEmotion,used:1,remaining:0,available:false} };
      if (loseStartResponse) {
        if (loseStartResponse === 'completed') job = { ...job, state:'completed', attempted:body.count, images:Array.from({length:body.count},(_,i)=>({id:`mock-recovered-${i}`,url:'https://offline-api.test/mock-image.svg'})) };
        loseStartResponse = false;
        return route.abort('connectionreset');
      }
      response = { ...account, id: job.id, state: job.state, total: job.total, cost: job.cost };
    } else if (url.pathname === '/api/packs/join') {
      packs = [...packs, { short_name: 'pack_joined', title: 'Joined', role: 'contributor' }];
      response = { shortName: 'pack_joined', title: 'Joined', role: 'contributor' };
    } else if (url.pathname === '/api/packs/invite') response = { link: `https://local-sticker.test/?invite=${tokenA}`, expiresAt: '2099-01-01T00:00:00Z', maxUses: 20 };
    else if (url.pathname === '/api/packs/revoke-invite') response = { ok: true };
    else if (url.pathname === '/api/add-to-pack') response = { packLink: 'https://t.me/addstickers/pack_beta' };
    else if (url.pathname === '/api/generate') response = { ...account, images: [] };
    else { errors.push(`Unexpected mock endpoint: ${url.pathname}`); return route.fulfill({ status: 404, body: '{}' }); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  };
  await page.route('**/*', fixtureRoute);
  const read = expression => page.evaluate(expression);
  const waitIdle = () => page.waitForFunction(() => window.creatorTools && !window.creatorTools.busy());
  const finishJob = async () => {
    job = { ...job, state: 'completed', attempted: job.total };
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitIdle();
    job = null;
  };
  try {
    const fixtureHtml = html.replace("const BACKEND = 'https://stickerbot-backend.onrender.com';", "const BACKEND = 'https://offline-api.test';");
    await page.setContent(fixtureHtml, {waitUntil:'load'});
    assert.equal(page.url(), 'about:blank', 'Fixture runs entirely in memory without target navigation');
    await waitIdle();
    await page.waitForFunction(() => freeDailyState?.limit === 8 && freeEmotionState?.available);
    assert.deepEqual(errors, [], 'Full frontend initializes without runtime exceptions');
    assert.equal(await read(() => document.documentElement.dataset.theme), 'prism');
    assert.equal(await read(() => localStorage.getItem('stickerTheme')), 'prism', 'Editorial preference migrates');
    assert.equal(await read(() => document.documentElement.dataset.motion), 'reduced');
    for (const id of ['creatorModeRow', 'countRow', 'freeDailyHint', 'costText']) assert.equal(await page.locator('#' + id).isVisible(), true, `${id} is visible with advanced settings closed`);
    assert.equal(await read(() => document.getElementById('creatorSettings').open), false);
    assert.match(await page.locator('#creatorSettingsSummary').textContent(), /Original.*White/);
    assert.equal(await page.locator('#countRow button').count(), 8);
    assert.match(await page.locator('#freeDailyHint').textContent(), /8 of 8/);
    assert.match(await page.locator('#costText').textContent(), /4 × 5 coins = 20 coins/);
    assert.equal(await page.locator('#premiumEmotionSet').count(), 0, 'Legacy six-expression toggle removed');

    const inviteChecks = await page.evaluate(({ tokenA, tokenB, tokenC }) => [
      resolvePackInvite(new URLSearchParams(`invite=${tokenA}`), 'bad-start'),
      resolvePackInvite(new URLSearchParams(`invite=bad&tgWebAppStartParam=pack_${tokenB}`), 'bad-start'),
      resolvePackInvite(new URLSearchParams(`invite=${tokenA}&tgWebAppStartParam=pack_${tokenB}`), `pack_${tokenC}`),
      resolvePackInvite(new URLSearchParams(`tgWebAppStartParam=bad&tgWebAppStartParam=pack_${tokenB}`), 'bad-start'),
      resolvePackInvite(new URLSearchParams('invite=bad&tgWebAppStartParam=wrong'), 'unrelated'),
    ], { tokenA, tokenB, tokenC });
    assert.deepEqual(inviteChecks, [tokenA, tokenB, tokenA, tokenB, '']);

    await page.selectOption('#creatorMode', 'pack24');
    assert.equal(await page.locator('#creatorCountSelect option').count(), 7);
    await page.selectOption('#creatorCountSelect', '8');
    assert.match(await page.locator('#costText').textContent(), /8 × 5 coins = 40 coins/);
    await page.fill('#promptInput', 'A friendly space cat');
    await page.fill('#creatorPackName', 'Cat emotions');
    await page.click('#generateBtn');
    await page.waitForFunction(() => document.getElementById('creatorProgressBar').max === 8 && document.getElementById('creatorProgressBar').value === 1 && freeDailyState?.remaining === 0);
    const start = calls.find(call => call.endpoint === '/api/packs/jobs/start');
    assert.equal(start.body.count, 8); assert.equal(start.body.expectedCost, 40);assert.equal(start.body.style,'vector');
    assert.match(dialogs.at(-1), /8 × 5 coins = 40 coins/);
    assert.equal(await read(() => genCount),8,'Reservation keeps submitted quantity frozen');
    assert.match(await page.locator('#costText').textContent(),/8 × 5 coins = 40 coins/,'Reservation keeps submitted quote frozen');
    assert.equal(await read(() => freeDailyState.remaining),0);
    assert.equal(calls.filter(call => call.endpoint === '/api/packs/jobs/start').length, 1);
    await finishJob();

    await page.evaluate(() => { applyFreeEmotionState({ limit: 1, used: 1, remaining: 0, available: false }); applyFreeDailyState({ limit: 8, used: 3, remaining: 5 }); });
    assert.equal(await page.locator('#generateBtn').isDisabled(), true);
    assert.match(await page.locator('#freeEmotionHint').textContent(), /has been used/);
    await page.selectOption('#creatorMode', 'single');
    assert.equal(await page.locator('#generateBtn').isDisabled(), false, 'Daily ordinary allowance remains usable');
    await page.evaluate(() => applyFreeDailyState({ limit: 8, used: 7, remaining: 1 }));
    assert.equal(await read(() => document.getElementById('creatorMode').options[1].disabled), true);
    assert.match(await page.locator('#freeEmotionHint').textContent(), /At least two/);
    assert.equal(await read(() => genCount), 1);

    for (const [tier, max, ordinaryMax, price] of [['standard', 6, 6, 4], ['luxury', 10, 10, 3], ['ultimate', 36, 12, 2]]) {
      account = {...account,premium:{active:true,tier,expiresAt:'2099-01-01T00:00:00Z'},freeDaily:null,freeEmotion:null};
      await page.evaluate(tier => { premiumState = { active: true, tier, expiresAt: '2099-01-01T00:00:00Z' }; applyFreeDailyState(null); applyFreeEmotionState(null); renderPremiumBadge(); }, tier);
      await page.selectOption('#creatorMode', 'pack24');
      assert.equal(await page.locator('#creatorCountSelect option').count(), max - 1, tier);
      await page.selectOption('#creatorCountSelect', String(max));
      assert.match(await page.locator('#costText').textContent(), new RegExp(`${max} × ${price} coins = ${max * price} coins`));
      await page.selectOption('#creatorMode', 'single');
      assert.equal(await page.locator('#countRow button').count(), ordinaryMax);
      assert.match(await page.locator('#freeDailyHint').textContent(), /unlimited/);
    }
    assert.deepEqual(await page.evaluate(() => {const previousOwner=isOwner,previousPremium=premiumState;isOwner=true;premiumState={active:false,tier:null,expiresAt:null};const free=[generationLimit(false),generationLimit(true)];premiumState={active:true,tier:'luxury',expiresAt:'2099-01-01T00:00:00Z'};const paid=[generationLimit(false),generationLimit(true)];isOwner=previousOwner;premiumState=previousPremium;return [free,paid];}),[[8,8],[10,10]],'Owner follows active plan batch limits');
    await page.selectOption('#creatorMode', 'pack24');
    await page.selectOption('#creatorCountSelect', '36');
    await page.click('#generateBtn');
    await page.waitForFunction(() => document.getElementById('creatorProgressBar').max === 36 && document.getElementById('creatorProgressBar').value === 1);
    const ultimateStart = calls.filter(call => call.endpoint === '/api/packs/jobs/start').at(-1);
    assert.equal(ultimateStart.body.count, 36); assert.equal(ultimateStart.body.expectedCost, 72);
    await page.evaluate(() => {premiumState={active:false,tier:null,expiresAt:null};applyFreeDailyState({limit:8,used:8,remaining:0});applyFreeEmotionState({limit:1,used:1,remaining:0,available:false});renderPremiumBadge();});
    assert.equal(await read(() => genCount),36,'Active job remains 36 after plan expiration');
    assert.match(await page.locator('#costText').textContent(),/36 × 2 coins = 72 coins/,'Active job keeps authorized unit price');
    await finishJob();
    await page.selectOption('#creatorMode', 'single');

    await page.evaluate(() => setPackMode('existing'));
    await page.waitForFunction(() => myPacksLoaded);
    await page.selectOption('#packSelect', 'pack_beta');
    await page.evaluate(() => loadMyPacks());
    assert.equal(await page.locator('#packSelect').inputValue(), 'pack_beta', 'Cached load renders and preserves selected target');
    await page.evaluate(() => { document.getElementById('packSelect').innerHTML = ''; });
    await page.evaluate(() => loadMyPacks());
    assert.equal(await page.locator('#packSelect option').count(), 3, 'Cached load repairs an unrendered selector');
    await page.selectOption('#packSelect', 'pack_beta');
    await page.evaluate(() => loadMyPacks(true));
    assert.equal(await page.locator('#packSelect').inputValue(), 'pack_beta', 'Refresh preserves valid target');
    let releasePacks; pendingPackResponse = new Promise(resolve => { releasePacks = resolve; });
    const requestCount = calls.filter(call => call.endpoint === '/api/my-packs').length;
    const concurrent = page.evaluate(() => Promise.all([loadMyPacks(true), loadMyPacks()]));
    await page.waitForFunction(() => document.getElementById('packSelect').disabled);
    releasePacks(); await concurrent; pendingPackResponse = null;
    assert.equal(calls.filter(call => call.endpoint === '/api/my-packs').length, requestCount + 1, 'Concurrent loads await the same request');
    assert.equal(await page.locator('#packSelect').inputValue(), 'pack_beta');
    failPacks = true;
    await page.evaluate(() => loadMyPacks(true));
    assert.equal(await read(() => packMode), 'existing', 'Load errors preserve explicit existing mode');
    assert.equal(await page.locator('#packSelect').inputValue(), 'pack_beta');
    assert.equal(await page.locator('#packSelectEmpty').isVisible(), true);
    failPacks = false;
    await page.evaluate(() => loadMyPacks(true));
    packs = packs.filter(pack => pack.short_name !== 'pack_beta');
    await page.evaluate(() => loadMyPacks(true));
    assert.equal(await page.locator('#packSelect').inputValue(), '', 'Removed target requires a fresh explicit selection');
    await page.evaluate(() => { currentResults = [{ id: 'mock-image', url: 'https://offline-api.test/mock-image.svg' }]; selectedIndices = new Set([0]); updateFooter(); });
    const savesBefore = calls.filter(call => call.endpoint === '/api/add-to-pack').length;
    await page.evaluate(() => document.getElementById('addBtn').click());
    assert.equal(calls.filter(call => call.endpoint === '/api/add-to-pack').length, savesBefore, 'Empty target prevents save POST');
    assert.equal(await read(() => packMode), 'existing');

    await page.selectOption('#packSelect','pack_alpha');
    await page.evaluate(() => document.getElementById('addBtn').click());
    await page.waitForFunction(() => document.getElementById('successModal').classList.contains('visible'));
    assert.equal(calls.filter(call => call.endpoint === '/api/add-to-pack').at(-1).body.targetPackShortName,'pack_alpha','Validated selected pack is posted explicitly');
    await page.evaluate(() => closeModal(document.getElementById('successModal')));

    await page.click('#creatorJoinButton');
    await page.waitForFunction(() => document.activeElement?.dataset.shortName === 'pack_joined');
    assert.equal(await page.locator('#libraryView').isVisible(), true);
    assert.equal(calls.filter(call => call.endpoint === '/api/packs/join').at(-1).body.token, tokenA);
    await page.locator('.creator-pack-menu').first().locator('summary').click();
    await page.getByRole('button', { name: 'Invite contributors', exact: true }).first().click();
    await page.waitForFunction(() => document.getElementById('creatorInviteModal').classList.contains('visible'));
    assert.equal(calls.filter(call => call.endpoint === '/api/packs/invite').at(-1).body.rotate, false);
    assert.match(await page.locator('#creatorInviteExpiry').textContent(), /Valid until/);
    await page.click('#creatorInviteClose');
    await page.getByRole('button', { name: 'Replace invitation links', exact: true }).first().click();
    await page.waitForFunction(() => document.getElementById('creatorInviteModal').classList.contains('visible'));
    assert.equal(calls.filter(call => call.endpoint === '/api/packs/invite').at(-1).body.rotate, true);
    assert.match(dialogs.at(-1), /Existing links will stop working/);
    await page.click('#creatorInviteClose');
    await page.click('#createTab');

    for (const language of ['en','ru','es','zh','hi','ar','pt','fr','ja','de','id','tr']) {
      await page.evaluate(language => { lang = language; applyLang(); }, language);
      for (const id of ['creatorModeLabel','creatorQuantityLabel','creatorSettingsSummary','costText']) assert.ok((await page.locator('#'+id).textContent()).trim(), `${language}: ${id}`);
      assert.equal(await page.locator('#themeSelect option[value="prism"]').textContent(), 'Prism Studio');
    }
    await page.evaluate(() => {lang='en';applyLang();selectedIndices.clear();updateFooter();});
    const savedAccount=account;
    account={...account,premium:{active:false,tier:null,expiresAt:null},freeDaily:{limit:8,used:8,remaining:0},freeEmotion:{limit:1,used:1,remaining:0,available:false}};
    job={id:'00000000-0000-4000-8000-000000000036',state:'running',total:36,attempted:9,cost:72,charged:72,images:[],packLink:null,packError:null};
    const startsBeforeResume=calls.filter(call=>call.endpoint==='/api/packs/jobs/start').length;
    const resumed=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
    resumed.on('pageerror',error=>errors.push(error.message));
    await resumed.evaluate(installFixture,job.id);await resumed.route('**/*',fixtureRoute);await resumed.setContent(fixtureHtml,{waitUntil:'load'});
    await resumed.waitForFunction(()=>document.getElementById('creatorProgressBar').max===36&&genCount===36);
    assert.equal(resumed.url(),'about:blank');
    assert.equal(await resumed.locator('#creatorMode').inputValue(),'pack24');
    assert.match(await resumed.locator('#costText').textContent(),/36 × 2 coins = 72 coins/);
    assert.match(await resumed.locator('#creatorProgressText').textContent(),/9 \/ 36/);
    assert.equal(calls.filter(call=>call.endpoint==='/api/packs/jobs/start').length,startsBeforeResume,'Resuming polls existing job without submitting another');
    await resumed.close();account=savedAccount;job=null;
    for (const lostState of ['running','completed']) {
      const previousAccount = account;
      account={balance:1000,isOwner:false,premium:{active:false,tier:null,expiresAt:null},freeDaily:{limit:8,used:0,remaining:8},freeEmotion:{limit:1,used:0,remaining:1,available:true,resetAt:'2099-01-01T00:00:00Z'}};
      const recovery = await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
      recovery.on('pageerror',error=>errors.push(error.message));
      recovery.on('dialog',dialog=>dialog.accept());
      await recovery.evaluate(installFixture);
      await recovery.route('**/*',fixtureRoute);
      await recovery.setContent(fixtureHtml,{waitUntil:'load'});
      await recovery.waitForFunction(()=>window.creatorTools&&!window.creatorTools.busy()&&freeEmotionState?.available);
      await recovery.selectOption('#creatorMode','pack24');
      await recovery.selectOption('#creatorCountSelect','4');
      await recovery.fill('#promptInput','A friendly space cat');
      await recovery.fill('#creatorPackName','Recovered cat emotions');
      const beforeLostStart=calls.filter(call=>call.endpoint==='/api/packs/jobs/start').length;
      const beforeLostCharges=mockChargeCount;
      const beforeLostStatus=calls.filter(call=>call.endpoint==='/api/packs/jobs/status').length;
      loseStartResponse=lostState;
      // An admitted running job first loses both its start reply and its status reply.
      // The next status check must recover that job while the submit button stays locked.
      failRecoveryStatusCount=lostState==='running'?1:0;
      await recovery.click('#generateBtn');
      if(lostState==='running') {
        await recovery.waitForFunction(()=>!document.getElementById('creatorProgress').hidden&&document.getElementById('creatorProgressText').textContent.includes('Action could not be confirmed'));
        assert.equal(await recovery.evaluate(()=>creatorTools.busy()),true,'Lost start and status replies retain submit lock');
        assert.equal(await recovery.locator('#generateBtn').isDisabled(),true);
        assert.match(await recovery.locator('#costText').textContent(),/4 × 5 coins = 20 coins/,'Recovery preserves authorized quote');
        await recovery.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
        await recovery.waitForFunction(()=>document.getElementById('creatorProgressBar').max===4&&document.getElementById('creatorProgressBar').value===1&&freeEmotionState?.available===false);
        assert.equal(await recovery.evaluate(()=>localStorage.getItem('stickerCreatorJob')),job.id,'Recovery persists admitted job ID');
        assert.equal(await recovery.evaluate(()=>creatorTools.busy()),true,'Recovered running job remains locked');
        job={...job,state:'completed',attempted:job.total};
        await recovery.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      }
      await recovery.waitForFunction(()=>!creatorTools.busy()&&document.getElementById('creatorProgressText').textContent.includes('Complete'));
      assert.equal(recovery.url(),'about:blank','Lost-response fixture never navigates to live URLs');
      assert.equal(calls.filter(call=>call.endpoint==='/api/packs/jobs/start').length,beforeLostStart+1,`${lostState}: recovery does not resubmit`);
      assert.equal(mockChargeCount,beforeLostCharges+1,`${lostState}: server admits and charges once`);
      assert.equal(await recovery.evaluate(()=>getBalance()),980,`${lostState}: recovered balance is not charged again locally`);
      assert.equal(await recovery.evaluate(()=>freeDailyState.remaining),4);
      assert.equal(await recovery.evaluate(()=>freeEmotionState.available),false);
      const submitted=calls.filter(call=>call.endpoint==='/api/packs/jobs/start').at(-1);
      const lookupCalls=calls.filter(call=>call.endpoint==='/api/packs/jobs/status').slice(beforeLostStatus);
      assert.ok(lookupCalls.some(call=>call.body.id===submitted.body.requestId),`${lostState}: recovery looks up exact request nonce, including completed jobs`);
      if(lostState==='completed') assert.equal(await recovery.evaluate(()=>currentResults.length),4,'A completed job with a lost start reply restores its generated results');
      await recovery.close();account=previousAccount;job=null;
    }
    const screenshots = process.env.CODEX_FRONTEND_SCREENSHOTS;
    for (const width of [320, 390, 760, 1060]) {
      await page.setViewportSize({width,height:960});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `No horizontal overflow at ${width}px`);
      for (const id of ['creatorModeRow','countRow','freeDailyHint','costText']) assert.equal(await page.locator('#'+id).isVisible(), true, `${id}: ${width}px`);
    }
    if (screenshots) {
      fs.mkdirSync(screenshots, {recursive:true});
      const previousAccount = account;
      account={balance:1000,isOwner:false,premium:{active:false,tier:null,expiresAt:null},freeDaily:{limit:8,used:0,remaining:8},freeEmotion:{limit:1,used:0,remaining:1,available:true,resetAt:'2099-01-01T00:00:00Z'}};
      const preview=await browser.newPage({viewport:{width:1060,height:960},reducedMotion:'reduce'});
      preview.on('pageerror',error=>errors.push(error.message));
      await preview.evaluate(installFixture);
      await preview.route('**/*',fixtureRoute);
      await preview.setContent(fixtureHtml,{waitUntil:'load'});
      await preview.waitForFunction(()=>window.creatorTools&&!window.creatorTools.busy()&&freeDailyState?.limit===8);
      assert.equal(preview.url(),'about:blank','Screenshots use the same fully intercepted in-memory fixture');
      await preview.screenshot({path:path.join(screenshots,'prism-desktop.png'),fullPage:true});
      await preview.setViewportSize({width:390,height:844});
      await preview.screenshot({path:path.join(screenshots,'prism-mobile.png'),fullPage:true});
      await preview.close();account=previousAccount;
    }
    assert.deepEqual(errors, []);
    console.log('PASS: offline frontend mocks on about:blank: syntax, initialization, visible controls, quotas, 12 languages, dynamic quotes and progress, frozen reservation/expiry quotes, saved-job resume and lost running/completed start-response recovery without duplicate submission or charge, cached/concurrent pack selection, invite parsing, join focus, invitation rotation, and four viewport widths. All requests intercepted; no live site, provider, or Telegram calls.');
  } catch (error) { if (errors.length) console.error('Browser runtime errors:',errors); throw error; }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
