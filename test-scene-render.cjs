// P8 场景板出图层：分区去噪必须真的分成两段，且产品段与场景段用互斥遮罩。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const calls = [];
  const outputs = [];
  const png = (tag = 'png') => new Blob([tag], { type: 'image/png' });
  const composeCalls = [];
  const window = {
    WuyingShapeModel: require('./dist/shape-model.js'),
    WuyingComfy: {
      renderRegion: async options => {
        calls.push(options);
        const blob = png('out-' + calls.length);
        outputs.push(blob);
        return { blob };
      },
      renderLive: async () => ({ blob: png() }),
      renderQwen: async () => ({ blob: png() })
    },
    WuyingSceneBoard: {
      compose: async (scene, size, resolve) => {
        composeCalls.push({ scene, size, resolve });
        return {
          image: png('image'), productMask: png('product-mask'), sceneMask: png('scene-mask'),
          outline: png('outline'), box: { left: 10, top: 10, right: 90, bottom: 90 },
          ratio: { x: .1, y: .1, w: .3, h: .4, area: .12 }, cutout: true, width: size.width, height: size.height
        };
      },
      scenePrompt: (scene, extra) => 'PROMPT[' + (scene.lighting || '') + '|' + (scene.material || '') + '|' + (scene.prompt || '') + '|' + (extra || '') + ']',
      sceneNegative: 'SCENE-NEG'
    }
  };
  const context = vm.createContext({
    window, document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({}), toBlob: cb => cb(png()) }) },
    Blob, Uint8ClampedArray, Uint32Array, crypto: { getRandomValues: array => { array[0] = 7; return array; } },
    Math, Number, Object, Array, String, JSON, Promise, Error, console
  });
  vm.runInContext(fs.readFileSync(__dirname + '/dist/workspace-render.js', 'utf8'), context);
  return { render: window.WuyingWorkspaceRender, calls, composeCalls, outputs };
}

const scene = { lighting: 'window', material: 'matte', prompt: '户外草地', product: { blobId: 'mold-1' } };

test('场景板出图分成两段：产品区浅改、场景区深改，遮罩互斥', async () => {
  const { render, calls, outputs } = harness();
  await render.renderSceneBoard({
    scene, size: { width: 1024, height: 768 }, resolve: async () => null,
    endpoint: 'http://127.0.0.1:8188', checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
    controlnet: 'control_v11p_sd15_scribble_fp16.safetensors', seed: 42, slot: 'scene-test'
  });
  assert.equal(calls.length, 2, '必须正好两段采样');
  const [first, second] = calls;
  assert.equal(first.maskImage.type, 'image/png');
  assert.notEqual(first.maskImage, second.maskImage, '两段不能用同一张遮罩');
  assert.ok(first.denoise <= .45, '产品段要浅，不超过 .45，实际 ' + first.denoise);
  assert.ok(second.denoise >= .7, '场景段要深，不少于 .7，实际 ' + second.denoise);
  assert.equal(second.sourceImage, outputs[0], '第二段以第一段结果为输入');
  assert.equal(first.guideImage.type, 'image/png', '产品轮廓要作控形条件');
  assert.equal(first.controlnet, 'control_v11p_sd15_scribble_fp16.safetensors');
  assert.match(first.prompt, /PROMPT\[window\|matte\|户外草地\|\]/);
  assert.equal(first.negative, 'SCENE-NEG');
  assert.equal(second.negative, 'SCENE-NEG');
  assert.equal(first.seed, 42);
  assert.equal(second.seed, 43, '两段换种子，避免同一噪声模式叠两次');
});

test('合成尺寸对齐到 8 的倍数，避免 VAE 裁掉几像素后对不上', async () => {
  const { render, composeCalls, calls } = harness();
  await render.renderSceneBoard({
    scene, size: { width: 1021, height: 767 }, resolve: async () => null,
    checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors', seed: 1, slot: 's'
  });
  assert.equal(composeCalls[0].size.width, 1016);
  assert.equal(composeCalls[0].size.height, 760);
  assert.equal(calls.length, 2);
});

test('显式给的力度会被钳在安全区间，不允许把产品改形', async () => {
  const { render, calls } = harness();
  await render.renderSceneBoard({
    scene, size: { width: 512, height: 512 }, resolve: async () => null,
    checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors', seed: 1, slot: 's',
    productDenoise: .9, sceneDenoise: .2
  });
  assert.equal(calls[0].denoise, .55, '产品段超过 .55 必须被压回来');
  assert.equal(calls[1].denoise, .45, '场景段低于 .45 必须被抬回去');
});

test('Qwen 通道直接拦掉：它没有局部重绘，走不了分区去噪', async () => {
  const { render, calls } = harness();
  await assert.rejects(
    () => render.renderSceneBoard({
      scene, size: { width: 512, height: 512 }, resolve: async () => null,
      checkpoint: 'qwen_image_2.1_turbo_int8_convrot.safetensors', seed: 1, slot: 's'
    }),
    /SD1\.5/
  );
  assert.equal(calls.length, 0);
});

test('没选模型时给出明确提示，不去跑半截链路', async () => {
  const { render, calls } = harness();
  await assert.rejects(
    () => render.renderSceneBoard({ scene, size: { width: 512, height: 512 }, resolve: async () => null }),
    /基础模型/
  );
  assert.equal(calls.length, 0);
});
