'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createImageServer } = require('./server/image-api.cjs');

async function start(server, t) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return 'http://127.0.0.1:' + server.address().port;
}

const brief = {
  product: '便携台灯', scenario: '宿舍床头', goal: '收纳方便',
  constraints: '不遮挡开关', referenceNotes: '折叠台灯的结构'
};
const anchors = [
  { x: .08, y: .16 }, { x: .92, y: .16 }, { x: .82, y: .7 },
  { x: .42, y: .84 }, { x: .12, y: .7 }
];
const directions = ['窄底座', '斜面主体', '分层外壳'].map(name => ({
  name, reason: '适合窄空间', tradeoff: '需要进一步验证稳定性', anchors,
  parts: [{ label: '开关', x: .24, y: .26 }]
}));

async function fixture(t) {
  const seen = [];
  let reply = { status: 200, body: { choices: [{ message: { content: JSON.stringify({ directions }) } }] } };
  const upstream = await start(createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    reply.notify?.();
    if (reply.wait) await reply.wait;
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  }), t);
  const base = await start(createImageServer(), t);
  const api = (path, body, origin = 'http://127.0.0.1:8881') => fetch(base + '/api/' + path, body ? {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  } : { headers: { Origin: origin } });
  const config = { baseUrl: upstream + '/v1/chat/completions', model: 'test-text', key: 'text-private' };
  return { api, config, upstream, seen, respond(next) { reply = next; } };
}

test('text provider settings stay isolated and send only brief text to Chat Completions', async t => {
  const { api, config, upstream, seen } = await fixture(t);
  const initial = await (await api('concept/config')).json();
  assert.equal(initial.ready, false);
  assert.equal((await api('concept-suggestions', { brief })).status, 400);
  assert.equal((await api('concept/config', config, 'https://other.example')).status, 403);
  assert.equal((await api('config', { baseUrl: upstream + '/image/v1', model: 'test-image', key: 'image-private' })).status, 200);

  const publicSettings = await (await api('concept/config', config)).json();
  assert.deepEqual(publicSettings, { baseUrl: upstream + '/v1', model: 'test-text', ready: true, hasKey: true });
  assert.deepEqual(await (await api('concept/config')).json(), publicSettings);
  assert.equal((await (await api('config')).json()).model, 'test-image');
  const response = await api('concept-suggestions', { brief, attachments: ['private-file'], tools: ['delete'] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { directions });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/v1/chat/completions');
  assert.equal(seen[0].auth, 'Bearer text-private');
  assert.equal(seen[0].body.model, 'test-text');
  assert.deepEqual(JSON.parse(seen[0].body.messages[1].content), brief);
  assert.doesNotMatch(JSON.stringify(seen[0].body), /private-file|image-private/);
  assert.ok(!Object.hasOwn(seen[0].body, 'tools'));

  const moved = await (await api('concept/config', { baseUrl: upstream + '/other', model: 'test-text' })).json();
  assert.equal(moved.hasKey, false);
  assert.equal((await (await api('config')).json()).hasKey, true);
});

test('concept requests reject invalid inputs and model replies without exposing provider content', async t => {
  const { api, config, seen, respond } = await fixture(t);
  assert.equal((await api('concept/config', config)).status, 200);
  assert.equal((await api('concept-suggestions', { brief: { ...brief, product: ' ' } })).status, 400);
  assert.equal(seen.length, 0);

  const invalid = [
    { directions: directions.slice(0, 2) },
    { directions: [{ ...directions[0], anchors: anchors.slice(0, 4) }, ...directions.slice(1)] },
    { directions: [{ ...directions[0], anchors: [{ x: .07, y: .5 }, ...anchors.slice(1)] }, ...directions.slice(1)] },
    { directions: [{ ...directions[0], parts: [{ x: .5, y: .5 }] }, ...directions.slice(1)] }
  ];
  for (const proposal of invalid) {
    respond({ status: 200, body: { choices: [{ message: { content: JSON.stringify(proposal) + ' private-reply' } }] } });
    const malformed = await api('concept-suggestions', { brief });
    assert.equal(malformed.status, 502);
    assert.doesNotMatch(await malformed.text(), /private-reply/);
    respond({ status: 200, body: { choices: [{ message: { content: JSON.stringify(proposal) } }] } });
    assert.equal((await api('concept-suggestions', { brief })).status, 502);
  }
  respond({ status: 429, body: { error: 'private-provider-message' } });
  const rateLimited = await api('concept-suggestions', { brief });
  assert.equal(rateLimited.status, 502);
  assert.doesNotMatch(await rateLimited.text(), /private-provider-message/);
  assert.match((await api('concept-suggestions', { brief }).then(r => r.json())).error, /429/);
});

test('an active concept request blocks duplicates and releases the slot afterward', async t => {
  const { api, config, seen, respond } = await fixture(t);
  assert.equal((await api('concept/config', config)).status, 200);
  let complete, notify;
  const wait = new Promise(resolve => { complete = resolve; });
  const received = new Promise(resolve => { notify = resolve; });
  respond({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ directions }) } }] }, wait, notify });
  const first = api('concept-suggestions', { brief });
  try {
    await received;
    assert.equal((await api('concept-suggestions', { brief })).status, 429);
    assert.equal(seen.length, 1);
  } finally { complete(); }
  assert.equal((await first).status, 200);
  assert.equal((await api('concept-suggestions', { brief })).status, 200);
});
