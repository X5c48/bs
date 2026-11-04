const test = require('node:test');
const assert = require('node:assert/strict');
const { testConnection, generate } = require('./dist/comfy.js');

const endpoint = 'http://localhost:8188';
const sketch = new Blob(['sketch'], { type: 'image/png' });
const resultImage = new Blob(['rendered image'], { type: 'image/png' });
const settings = {
  endpoint,
  checkpoint: 'sd15.safetensors',
  controlnet: 'scribble.safetensors',
  strength: 0.86,
  prompt: 'blue radio, brushed aluminum, studio lighting',
  negative: 'changed shape',
  sketch
};

test('lists installed model choices through native routes', async (t) => {
  t.mock.method(global, 'fetch', async (url, init) => {
    assert.equal(init.mode, 'cors');
    assert.equal(init.credentials, 'omit');
    if (url === 'https://comfy.example/proxy/models/checkpoints') {
      return Response.json(['sd15.safetensors']);
    }
    assert.equal(url, 'https://comfy.example/proxy/models/controlnet');
    return Response.json(['scribble.safetensors']);
  });
  assert.deepEqual(await testConnection('https://comfy.example/proxy/'), {
    checkpoints: ['sd15.safetensors'], controlnets: ['scribble.safetensors']
  });
});

test('uploads the sketch and runs a scribble-conditioned workflow', async (t) => {
  const statuses = [];
  const paths = [];
  let saveNodeId;
  t.mock.method(global, 'fetch', async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    paths.push(pathname);
    switch (pathname) {
      case '/upload/image': {
        assert.equal(init.method, 'POST');
        assert.equal(init.body.get('image').type, 'image/png');
        assert.equal(await init.body.get('image').text(), 'sketch');
        assert.equal(init.body.get('type'), 'input');
        return Response.json({ name: 'sketch.png', subfolder: 'wuying' });
      }
      case '/prompt': {
        const { prompt } = JSON.parse(init.body);
        const byClass = (name) => Object.entries(prompt).find(([, node]) => node.class_type === name);
        const [loadId, load] = byClass('LoadImage');
        const [invertId, invert] = byClass('ImageInvert');
        const [controlId, control] = byClass('ControlNetLoader');
        const [applyId, apply] = byClass('ControlNetApplyAdvanced');
        const [latentId, latent] = byClass('EmptyLatentImage');
        assert.equal(byClass('CheckpointLoaderSimple')[1].inputs.ckpt_name, settings.checkpoint);
        assert.equal(load.inputs.image, 'wuying/sketch.png');
        assert.deepEqual(invert.inputs.image, [loadId, 0]);
        assert.equal(control.inputs.control_net_name, settings.controlnet);
        assert.deepEqual(apply.inputs.image, [invertId, 0]);
        assert.deepEqual(apply.inputs.control_net, [controlId, 0]);
        assert.equal(apply.inputs.strength, settings.strength);
        assert.equal(prompt[apply.inputs.positive[0]].inputs.text, settings.prompt);
        assert.equal(prompt[apply.inputs.negative[0]].inputs.text, settings.negative);
        assert.equal(latent.inputs.width / latent.inputs.height, 1.25);
        const sample = byClass('KSampler')[1];
        assert.deepEqual(sample.inputs.positive, [applyId, 0]);
        assert.deepEqual(sample.inputs.negative, [applyId, 1]);
        assert.deepEqual(sample.inputs.latent_image, [latentId, 0]);
        [saveNodeId] = byClass('SaveImage');
        return Response.json({ prompt_id: 'job-123' });
      }
      case '/history/job-123':
        return Response.json({
          'job-123': { outputs: { [saveNodeId]: { images: [{ filename: 'final.png', subfolder: 'render', type: 'output' }] } } }
        });
      case '/view':
        assert.deepEqual(Object.fromEntries(searchParams), {
          filename: 'final.png', subfolder: 'render', type: 'output'
        });
        return new Response(resultImage);
      default:
        assert.fail('Unexpected route ' + pathname);
    }
  });
  const result = await generate({ ...settings, onStatus: (status) => statuses.push(status) });
  assert.equal(result.promptId, 'job-123');
  assert.equal(await result.blob.text(), 'rendered image');
  assert.deepEqual(paths, ['/upload/image', '/prompt', '/history/job-123', '/view']);
  assert.equal(statuses.length, 4);
  assert.ok(statuses.every((status) => typeof status === 'string' && status.length > 0));
});

test('reports validation, network, and execution errors', async (t) => {
  const fetchMock = t.mock.method(global, 'fetch', async (url) => {
    switch (new URL(url).pathname) {
      case '/upload/image': return Response.json({ name: 'sketch.png' });
      case '/prompt': return Response.json({ prompt_id: 'bad-job' });
      case '/history/bad-job':
        return Response.json({
          'bad-job': { status: { status_str: 'error', messages: [['execution_error', {
            exception_message: 'CUDA out of memory'
          }]] } }
        });
      default: throw new TypeError('Failed to fetch');
    }
  });
  await assert.rejects(testConnection('http://192.168.0.2:8188'), /HTTPS/);
  await assert.rejects(testConnection('https://user:secret@comfy.example'), /凭据/);
  assert.equal(fetchMock.mock.callCount(), 0);
  await assert.rejects(testConnection(endpoint), /CORS/);
  await assert.rejects(generate(settings), /CUDA out of memory/);
});

test('cancelled requests reject as AbortError before contacting ComfyUI', async (t) => {
  const fetchMock = t.mock.method(global, 'fetch', async () => assert.fail('Unexpected fetch'));
  await assert.rejects(generate({ ...settings, signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('polling waits for a queued job and can be cancelled', async (t) => {
  const controller = new AbortController();
  const paths = [];
  t.mock.method(global, 'fetch', async (url) => {
    const { pathname } = new URL(url);
    paths.push(pathname);
    switch (pathname) {
      case '/upload/image': return Response.json({ name: 'sketch.png' });
      case '/prompt': return Response.json({ prompt_id: 'pending-job' });
      case '/history/pending-job':
        setTimeout(() => controller.abort(), 0);
        return Response.json({});
      default: assert.fail('Unexpected route ' + pathname);
    }
  });
  await assert.rejects(generate({ ...settings, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(paths, ['/upload/image', '/prompt', '/history/pending-job']);
});

test('surfaces native prompt validation details', async (t) => {
  t.mock.method(global, 'fetch', async (url) => {
    if (new URL(url).pathname === '/upload/image') return Response.json({ name: 'sketch.png' });
    return Response.json({
      error: { message: 'Prompt outputs failed validation' },
      node_errors: { 6: { errors: [{ details: 'Scribble model is missing' }] } }
    }, { status: 400 });
  });
  await assert.rejects(generate(settings), /HTTP 400。Scribble model is missing/);
});
