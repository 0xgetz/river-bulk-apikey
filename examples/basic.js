'use strict';

/**
 * Example: create a single River account and print its API key, then
 * immediately list the models the key can access.
 *
 *   BU_CDP_WS=wss://... node examples/basic.js
 */

const { CDP, provisionAccount, listModels } = require('../src/river');
const { MailTM } = require('../src/mailtm');

(async () => {
  const wsUrl = process.env.BU_CDP_WS || process.env.CDP_WS;
  if (!wsUrl) throw new Error('set BU_CDP_WS (cloud) or CDP_WS (local Chrome)');

  const cdp = new CDP(wsUrl, {});
  await cdp.connect();
  await cdp.attachToPage();

  const account = await provisionAccount(cdp, new MailTM(), {
    keyName: 'example-key',
    log: (m) => console.error('·', m),
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
