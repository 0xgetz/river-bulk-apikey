#!/usr/bin/env node
'use strict';

/**
 * Connect River AI to a 9Router instance.
 *
 * River ships an OpenAI-compatible endpoint (https://api.river.ai/v1), so a
 * single connection is enough: register one `openai-compatible` provider-node
 * with prefix `river`, then a connection that carries one of your River API
 * keys. Rotate keys by calling this again with a different --api-key.
 *
 * Usage:
 *   node src/connect-9router.js \
 *     --base http://localhost:20128 --password 123456 \
 *     --api-key rv_xxx [--name "River"] [--prefix river]
 *
 * Options:
 *   --model <id>   default model (e.g. zai-org/GLM-5.3-Flash)
 *
 * Zero dependencies. Node.js >= 18.
 */

const UA = 'river-bulk-9router-connector/1.0';

async function login9router(base, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ password: password ?? '123456' }),
  });
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const cookie = sc.map((c) => c.split(';')[0]).join('; ');
  return { ok: res.ok, cookie, body: (await res.text()).slice(0, 200) };
}

async function api(base, cookie, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, 400) };
}

async function ensureNode(base, cookie, { name, prefix, baseUrl }) {
  const list = await api(base, cookie, '/api/provider-nodes');
  const nodes = (list.json && list.json.nodes) || [];
  const existing = nodes.find((n) => n.name === name || n.prefix === prefix);
  if (existing) {
    console.log(`provider-node exists: ${existing.id} (prefix ${existing.prefix})`);
    return existing;
  }
  const created = await api(base, cookie, '/api/provider-nodes', {
    method: 'POST',
    body: JSON.stringify({ name, prefix, apiType: 'chat', type: 'openai-compatible', baseUrl }),
  });
  if (!created.ok) throw new Error(`create node failed ${created.status}: ${created.text}`);
  console.log(`provider-node created: ${created.json.node.id}`);
  return created.json.node;
}

async function ensureConnection(base, cookie, { nodeId, name, apiKey, defaultModel }) {
  const list = await api(base, cookie, '/api/providers');
  const conns = (list.json && list.json.connections) || [];
  const existing = conns.find((c) => c.provider === nodeId || c.name === name);
  if (existing) {
    console.log(`connection exists: ${existing.id} (${existing.name})`);
    return existing;
  }
  const created = await api(base, cookie, '/api/providers', {
    method: 'POST',
    body: JSON.stringify({ provider: nodeId, apiKey, name, priority: 1, defaultModel: defaultModel || null }),
  });
  if (!created.ok && created.status !== 409) {
    throw new Error(`create connection failed ${created.status}: ${created.text}`);
  }
  console.log(`connection created: ${(created.json && created.json.connection && created.json.connection.id) || '(conflict)'}`);
  return created.json && created.json.connection;
}

async function connectRiver({ base = 'http://localhost:20128', password = '123456', apiKey, name = 'River', prefix = 'river', baseUrl = 'https://api.river.ai/v1', defaultModel = 'zai-org/GLM-5.3-Flash' }) {
  if (!apiKey) throw new Error('--api-key is required');
  const { cookie, ok, body } = await login9router(base, password);
  console.log(`9Router login: ${ok ? 'ok' : 'not required/failed'} ${ok ? '' : body}`);
  const node = await ensureNode(base, cookie, { name, prefix, baseUrl });
  await ensureConnection(base, cookie, { nodeId: node.id, name, apiKey, defaultModel });
  console.log(`\nDone. Models: ${prefix}/zai-org/GLM-5.3-Flash · ${prefix}/deepseek-ai/DeepSeek-V4.1-Flash`);
}

if (require.main === module) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[k] = v;
    }
  }
  connectRiver({
    base: args.base,
    password: args.password,
    apiKey: args['api-key'],
    name: args.name,
    prefix: args.prefix,
    baseUrl: args['base-url'],
    defaultModel: args.model,
  }).catch((e) => {
    console.error('[fatal] ' + e.message);
    process.exit(1);
  });
}

module.exports = { connectRiver, login9router, ensureNode, ensureConnection };
