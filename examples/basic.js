'use strict';

/**
 * Example: create a single River account and print its API key, then
 * immediately list the models the key can access.
 *
 *   node examples/basic.js --cdp-url http://127.0.0.1:9222
 *   node examples/basic.js --proxy http://user:pass@host:8080   # recommended
 *
 * Without --proxy the example signs up from this machine's own address and says
 * so out loud (allowDirect); with a proxy both the page traffic and the mail /
 * console calls leave through it.
 */

const { CDP, provisionAccount, listModels } = require('../src/river');
const { MailTM } = require('../src/mailtm');
const { parseProxy, createAgent } = require('../src/proxy');

(async () => {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
  }
  const url = args['cdp-url'] || process.env.CDP_URL || 'http://127.0.0.1:9222';
  const proxy = args.proxy ? parseProxy(args.proxy) : null;
  const ver = await (await fetch(url.replace(/\/$/, '') + '/json/version')).json();
  const wsUrl = args['cdp-ws'] || process.env.CDP_WS || ver.webSocketDebuggerUrl;

  const cdp = new CDP(wsUrl, {});
  await cdp.connect();
  await cdp.attachToPage();

  const account = await provisionAccount(cdp, new MailTM({ agent: proxy ? createAgent(proxy) : undefined }), {
    keyName: 'example-key',
    log: (m) => console.error('·', m),
    proxy,
    // Without --proxy this example would sign up from this machine's own
    // address, which is exactly what the proxy list exists to avoid; the
    // library therefore needs the intent spelled out.
    allowDirect: !proxy,
  });
  cdp.close();

  console.log('\naccount :', account.email);
  console.log('password:', account.password);
  console.log('api key :', account.apiKey);
  console.log('balance :', '$' + account.balanceUsd);

  const models = await listModels(account.apiKey);
  console.log('models  :', models.data.map((m) => m.id).join(', '));
})().catch((e) => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
