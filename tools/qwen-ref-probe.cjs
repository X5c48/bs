// 验证 TextEncodeQwenImage21 的参考图接线方式：输出 latent 尺寸跟着参考图比例走 = 生效。
const fs = require('node:fs');
const path = require('node:path');

const endpoint = process.env.COMFY || 'http://127.0.0.1:8188';
const ref = process.argv[2] || path.join(__dirname, 'probe-plate-input-v2.png');
const resolution = Number(process.argv[3] || 640);

async function upload(buffer) {
  const form = new FormData();
  form.set('image', new Blob([buffer], { type: 'image/png' }), 'ref-probe-' + buffer.length + '.png');
  form.set('type', 'input');
  form.set('overwrite', 'true');
  const response = await fetch(endpoint + '/upload/image', { method: 'POST', body: form });
  return (await response.json()).name;
}
async function submit(prompt) {
  const response = await fetch(endpoint + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data).slice(0, 400));
  return data.prompt_id;
}
async function wait(promptId) {
  for (let i = 0; i < 600; i++) {
    const history = await (await fetch(endpoint + '/history/' + promptId)).json();
    const job = history[promptId];
    if (job?.status?.status_str === 'error') {
      const message = job.status.messages?.find(([e]) => e === 'execution_error')?.[1];
      throw new Error('exec error: ' + JSON.stringify(message || {}).slice(0, 400));
    }
    const image = job?.outputs?.['11']?.images?.[0];
    if (image) {
      const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
      const blob = await (await fetch(endpoint + '/view?' + params)).arrayBuffer();
      return Buffer.from(blob);
    }
    await new Promise(r => setTimeout(r, 900));
  }
  throw new Error('timeout');
}
const dims = buffer => buffer.readUInt32BE(16) + 'x' + buffer.readUInt32BE(20);

function graph(name, imagesInput) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_2.1_turbo_int8_convrot.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen3vl_8b_int8_convrot.safetensors', type: 'qwen_image', device: 'default' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_2.1_vae_bf16.safetensors' } },
    '5': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['3', 0], prompt: 'product photo of the object exactly as shown, matte white surfaces, studio softbox lighting, light gray background', negative_prompt: 'blurry, extra objects, text', resolution, vae: ['4', 0], images: imagesInput } },
    '6': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
    '7': { class_type: 'RandomNoise', inputs: { noise_seed: 11, noise_mode: 'fixed' } },
    '8': { class_type: 'CFGGuider', inputs: { model: ['2', 0], cfg: 1, positive: ['5', 0], negative: ['5', 1] } },
    '9': { class_type: 'ManualSigmas', inputs: { sigmas: '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0' } },
    '10': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['7', 0], guider: ['8', 0], sampler: ['6', 0], sigmas: ['9', 0], latent_image: ['5', 2] } },
    '12': { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['4', 0] } },
    '11': { class_type: 'SaveImage', inputs: { images: ['12', 0], filename_prefix: 'Wuying/refprobe-' + name } },
    '14': { class_type: 'LoadImage', inputs: { image: 'PLACEHOLDER' } }
  };
}

(async () => {
  const name = await upload(fs.readFileSync(ref));
  const variants = {
    dict: { image_1: ['14', 0] },
    nested: { image_1: { image: ['14', 0] } },
    // 动态输入在 API 格式里按「父.子」扁平键下发，这是 Autogrow 的真实展开名
    dotted: { 'images.image_1': ['14', 0] }
  };
  for (const [label, images] of Object.entries(variants)) {
    const prompt = graph(label, images);
    prompt['14'].inputs.image = name;
    if (label === 'dotted') {
      delete prompt['5'].inputs.images;
      Object.assign(prompt['5'].inputs, images);
    }
    try {
      const id = await submit(prompt);
      const out = await wait(id);
      fs.writeFileSync(path.join(__dirname, `refprobe-${label}.png`), out);
      console.log(`${label}: OK ${dims(out)} (${images ? 'ref wired' : 'no ref'})`);
    } catch (error) {
      console.log(`${label}: FAIL ${String(error.message).slice(0, 300)}`);
    }
  }
})();
