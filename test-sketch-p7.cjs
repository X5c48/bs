// P7 草图阶段实时辅助 → 造型探索
// 覆盖三件事：档位数值单调、风格底词/负向词守住「白底无场景」、Qwen 通道不再套摄影脚手架。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function renderHarness() {
  const live = [], qwen = [], canvases = [];
  const png = () => new Blob(['png'], { type: 'image/png' });
  const context2d = () => ({
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineJoin: '', lineCap: '', globalAlpha: 1,
    fillRect() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {},
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}
  });
  const document = {
    createElement: tag => {
      if (tag !== 'canvas') throw new Error('unexpected ' + tag);
      const canvas = { width: 0, height: 0, getContext: () => context2d(), toBlob: cb => cb(png()) };
      canvases.push(canvas);
      return canvas;
    }
  };
  const window = {
    WuyingShapeModel: require('./dist/shape-model.js'),
    WuyingComfy: {
      renderLive: async options => { live.push(options); return { blob: png() }; },
      renderQwen: async options => { qwen.push(options); return { blob: png() }; }
    },
    WuyingWorkspaceRender: null
  };
  const context = vm.createContext({
    window, document, Blob, Uint8ClampedArray,
    createImageBitmap: async () => ({ width: 640, height: 480, close() {} }),
    fetch: async () => ({ json: async () => ({ ControlNetLoader: { input: { required: { control_net_name: [['control_v11p_sd15_scribble_fp16']] } } } }) })
  });
  vm.runInContext(fs.readFileSync(__dirname + '/dist/workspace-render.js', 'utf8'), context);
  return { render: window.WuyingWorkspaceRender, live, qwen, png, canvases };
}

const base = () => ({
  endpoint: 'http://127.0.0.1:8188',
  checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
  controlnet: 'control_v11p_sd15_scribble_fp16',
  prompt: 'a desk lamp'
});

test('探索幅度三档：控制强度递减、重画力度递增、控制截断点递减', () => {
  const { render } = renderHarness();
  assert.equal(render.exploreTiers.map(tier => tier.id).join(','), 'tight,balanced,loose');
  const [tight, balanced, loose] = render.exploreTiers;
  assert.ok(tight.controlStrength > balanced.controlStrength && balanced.controlStrength > loose.controlStrength);
  assert.ok(tight.denoise < balanced.denoise && balanced.denoise < loose.denoise);
  assert.ok(tight.endPercent > balanced.endPercent && balanced.endPercent > loose.endPercent);
  // 贴线档靠 ControlNet 锁线（强度接近 1、全程不松手），而不是靠压低重画力度：
  // 压低 denoise 只会原样保留用户的浅灰底图，模型没机会铺明暗。
  assert.ok(tight.controlStrength >= .9, '贴线档条件强度必须接近满值');
  assert.equal(tight.endPercent, 1, '贴线档 ControlNet 必须全程有效');
  assert.ok(tight.denoise >= .6, '贴线档也要给模型留出铺明暗的余地');
  assert.equal(render.exploreTier('nope').id, 'balanced');
  assert.equal(render.exploreTier(undefined).id, 'balanced');
});

test('风格底词固定在白底灰模/马克笔，负向词把照片级与场景全部推走', () => {
  const { render } = renderHarness();
  const style = render.sketchStyleDirective();
  assert.match(style, /marker/i);
  assert.match(style, /grey|gray/i);
  assert.match(style, /plain white (paper|background)/i);
  assert.match(style, /one single product/i, '必须写死单件，否则模型会在空白处补出别的产品');
  assert.match(style, /no other objects/i);
  assert.match(style, /no scene/i);
  assert.match(style, /no (scene|background|environment)/i);
  assert.match(style, /no color/i, '材质必须中性，不能提前评价 CMF');
  const negative = render.sketchNegative;
  for (const word of ['photo', 'photorealistic', '3d render', 'scene', 'environment', 'room', 'grass', 'props', 'colored materials']) {
    assert.match(negative, new RegExp(word, 'i'), '负向词缺少 ' + word);
  }
  assert.doesNotMatch(negative, /illustration/, '草图阶段本身就是插画风，不能把它写进负向词');
});

test('造型倾向：三组对偶可组合，非法值被忽略，再点一次即取消', () => {
  const { render } = renderHarness();
  // 跨 vm realm 的数组不能直接 deepEqual（原型不同），逐项比。
  assert.equal(render.exploreTendencies.map(group => group.id).join(','), 'density,form,weight');
  assert.equal(render.sketchTendencyDirective({}), '');
  assert.equal(render.sketchTendencyDirective(null), '');
  const filtered = render.tendencySelection({ density: 'bogus', form: 'organic' });
  assert.equal(filtered.density, undefined);
  assert.equal(filtered.form, 'organic');
  const text = render.sketchTendencyDirective({ density: 'simple', form: 'geometric', weight: 'light' });
  assert.match(text, /simplified form/);
  assert.match(text, /straight edges/);
  assert.match(text, /slim sections/);
  // 只写进选择的那一边，另一边不能出现
  assert.doesNotMatch(text, /layered form/);
  assert.doesNotMatch(text, /organic form/);
  assert.match(render.sketchStyleDirective({ form: 'organic' }), /Form tendency: organic form/);
  assert.doesNotMatch(render.sketchStyleDirective({ form: '' }), /Form tendency/);
});

test('explorePlan 一次给出档位全部参数，界面与出图共用同一份数值', () => {
  const { render } = renderHarness();
  const plan = render.explorePlan({ tier: 'loose', tendency: { weight: 'heavy' } });
  assert.equal(plan.id, 'loose');
  assert.equal(plan.label, '发散');
  assert.equal(plan.negative, render.sketchNegative);
  assert.match(plan.style, /marker/i);
  assert.match(plan.style, /weighty/);
  assert.equal(plan.controlStrength, render.exploreTiers[2].controlStrength);
});

test('SD 实时：带 explore 时走档位参数，负向词换成草图版', async () => {
  const { render, live, png } = renderHarness();
  await render.generate({
    ...base(), kind: 'render', source: png(), live: true, liveTier: 'balanced',
    size: { width: 640, height: 480 },
    explore: { tier: 'tight', tendency: { form: 'geometric' } }
  });
  assert.equal(live.length, 1);
  const call = live[0];
  assert.equal(call.input, 'sketch');
  assert.equal(call.controlStrength, .95, 'ConditionNet 强度走档位，不再和滑块耦合');
  assert.equal(call.denoiseOverride, .62, '贴线档保留足够重画力度铺明暗');
  assert.equal(call.endPercent, 1);
  assert.match(call.prompt, /a desk lamp/);
  assert.ok(call.prompt.startsWith('Grey marker'), '风格底词必须打头，否则会被 77 token 截断挤掉');
  assert.match(call.prompt, /marker/i);
  assert.match(call.prompt, /geometric form/);
  assert.match(call.negative, /photorealistic/);
  assert.match(call.negative, /no environment|environment/);
  assert.doesNotMatch(call.negative, /bad anatomy/, '草图版负向词不应沿用产品摄影那一套');
});

test('SD 实时：不带 explore 时行为完全不变（回归保护）', async () => {
  const { render, live, png } = renderHarness();
  await render.generate({ ...base(), kind: 'render', source: png(), live: true, strength: .6, size: { width: 640, height: 480 } });
  const call = live[0];
  assert.equal(call.controlStrength, undefined);
  assert.equal(call.denoiseOverride, undefined);
  assert.doesNotMatch(call.prompt, /marker/i);
  assert.match(call.negative, /bad anatomy/);
});

test('Qwen 通道：造型探索不再追加产品摄影脚手架，负向词同步换成草图版', async () => {
  const { render, qwen, png } = renderHarness();
  await render.generate({
    ...base(), kind: 'render', source: png(), live: true,
    checkpoint: 'qwen_image_2.1_turbo_int8_convrot.safetensors',
    size: { width: 640, height: 480 },
    explore: { tier: 'balanced' }
  });
  assert.equal(qwen.length, 1);
  const call = qwen[0];
  assert.doesNotMatch(call.prompt, /Photorealistic product design render/, '草图阶段必须是灰模，不能是产品摄影');
  assert.match(call.prompt, /marker/i);
  assert.match(call.negative, /photorealistic/);
  assert.doesNotMatch(call.negative, /distorted silhouette/, '草图阶段不该带成品级的还原约束');
});

test('liveWorkflow：档位重画力度覆盖公式下限，且以草图本身作 latent 起点', () => {
  const { liveWorkflow } = require('./dist/comfy.js');
  const job = {
    checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
    input: 'sketch', quality: 'live', inputImage: 'lines.png', prompt: 'lamp',
    controlnet: 'control_v11p_sd15_scribble_fp16'
  };
  const plain = liveWorkflow({ ...job, strength: .6 });
  // 原行为：空 latent 全重画，靠条件图控形
  assert.equal(plain[8].class_type, 'EmptyLatentImage');
  const explore = liveWorkflow({ ...job, strength: .95, controlStrength: .95, denoiseOverride: .62, endPercent: 1 });
  assert.equal(explore[7].inputs.strength, .95);
  assert.equal(explore[7].inputs.end_percent, 1);
  assert.equal(explore[8].class_type, 'VAEEncode', '贴线档必须以草图作 latent 起点');
  const [scaleId] = explore[8].inputs.pixels;
  const [loadId] = explore[scaleId].inputs.image;
  assert.equal(explore[loadId].inputs.image, 'lines.png', '没有配色参考时用草图本身');
  assert.equal(explore[9].inputs.denoise, .62);
  // 档位显式给的力度优先于公式（.85 - .95*.14 ≈ .717）
  assert.notEqual(explore[9].inputs.denoise, plain[9].inputs.denoise);
});

test('liveWorkflow：有配色参考时贴线档仍以配色图作 latent 起点', () => {
  const { liveWorkflow } = require('./dist/comfy.js');
  const graph = liveWorkflow({
    checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors',
    input: 'sketch', quality: 'live', inputImage: 'lines.png', colorGuide: 'colors.png',
    prompt: 'lamp', controlnet: 'control_v11p_sd15_scribble_fp16',
    strength: .95, controlStrength: .95, denoiseOverride: .62
  });
  const [scaleId] = graph[8].inputs.pixels;
  const [loadId] = graph[scaleId].inputs.image;
  assert.equal(graph[loadId].inputs.image, 'colors.png');
  assert.equal(graph[9].inputs.denoise, .62);
});

test('草图均衡实时直接在采样尺寸对齐输入，其余实时任务沿用原尺寸', async () => {
  const { render, live, png, canvases } = renderHarness();
  const request={...base(),kind:'render',source:png(),live:true,liveTier:'balanced'};
  await render.generate({...request,explore:{tier:'balanced'}});
  assert.deepEqual([canvases[0].width,canvases[0].height],[800,640]);
  assert.equal(live[0].sketchPreview,true);
  assert.equal(live[0].controlStrength,.88);
  canvases.length=0;
  await render.generate(request);
  assert.deepEqual([canvases[0].width,canvases[0].height],[1280,1024]);
  assert.equal(live[1].sketchPreview,false);
});