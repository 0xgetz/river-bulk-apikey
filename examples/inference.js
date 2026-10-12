'use strict';

/**
 * Example: use a River API key with the OpenAI SDK / fetch, exactly like any
 * OpenAI-compatible endpoint. River exposes POST https://api.river.ai/v1/chat/completions
 *
 *   RIVER_API_KEY=rv_... node examples/inference.js
 */

const API = 'https://api.river.ai/v1';

async function chat(apiKey, { model = 'zai-org/GLM-5.3-Flash', messages }) {
  const res = await fetch(`${API}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 512 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

(async () => {
  const apiKey = process.env.RIVER_API_KEY;
  if (!apiKey) throw new Error('set RIVER_API_KEY');

  const out = await chat(apiKey, {
    model: 'zai-org/GLM-5.3-Flash',
    messages: [{ role: 'user', content: 'Explain LoRA fine-tuning in one sentence.' }],
  });

  const msg = out.choices[0].message;
  console.log(msg.content || msg.reasoning_content);
  console.log('\nusage:', JSON.stringify(out.usage));
})().catch((e) => {
  console.error('[fatal]', e.message);
  process.exit(1);
});
