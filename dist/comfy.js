(function () {
  'use strict';

  const REQUEST_TIMEOUT_MS = 30_000;
  const GENERATION_TIMEOUT_MS = 300_000;
  const POLL_INTERVAL_MS = 1_500;
  const SAVE_NODE_ID = '11';

  function endpointBase(endpoint) {
    let url;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error('请输入完整的 ComfyUI 地址，例如 http://127.0.0.1:8188。');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
      throw new Error('远程 ComfyUI 地址必须使用 HTTPS，本机可使用 HTTP。');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('ComfyUI 地址请勿包含登录凭据、查询参数或片段。');
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
  }

  function serverError(payload) {
    const node = Object.values(payload?.node_errors || {})[0];
    const detail = node?.errors?.[0];
    const message = detail?.details || detail?.message || payload?.error?.message;
    return typeof message === 'string' ? message.slice(0, 280) : '';
  }

  async function request(base, path, signal, options = {}) {
    const { image = false, ...init } = options;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    requestSignal.throwIfAborted();

    try {
      const response = await fetch(base + path, {
        ...init,
        signal: requestSignal,
        credentials: 'omit',
        mode: 'cors',
        redirect: 'error',
        cache: 'no-store'
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        requestSignal.throwIfAborted();
        const detail = serverError(payload);
        throw new Error('ComfyUI 返回 HTTP ' + response.status + (detail ? '。' + detail : '。'));
      }
      if (image) {
        const blob = await response.blob();
        if (!blob.size || !blob.type.startsWith('image/')) {
          throw new Error('ComfyUI 返回的文件无法识别为图像。');
        }
        return blob;
      }
      return await response.json();
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new Error('连接 ComfyUI 超时，请检查服务是否可用。');
      if (error instanceof SyntaxError) throw new Error('ComfyUI 返回了无效响应，请检查服务地址。');
      if (error instanceof TypeError) {
        throw new Error('无法连接 ComfyUI。请检查服务地址、CORS 设置和浏览器的本地网络访问权限。');
      }
      throw error;
    }
  }

  async function testConnection(endpoint, { signal } = {}) {
    const base = endpointBase(endpoint);
    const [checkpoints, controlnets] = await Promise.all([
      request(base, '/models/checkpoints', signal),
      request(base, '/models/controlnet', signal)
    ]);
    if (!Array.isArray(checkpoints) || !Array.isArray(controlnets)
        || [...checkpoints, ...controlnets].some((name) => typeof name !== 'string')) {
      throw new Error('ComfyUI 返回了无效的模型列表。');
    }
    return { checkpoints, controlnets };
  }

  function workflow({ checkpoint, controlnet, strength, prompt, negative, image, seed }) {
    const node = (class_type, inputs) => ({ class_type, inputs });
    return {
      1: node('CheckpointLoaderSimple', { ckpt_name: checkpoint }),
      2: node('CLIPTextEncode', { clip: ['1', 1], text: prompt }),
      3: node('CLIPTextEncode', { clip: ['1', 1], text: negative }),
      4: node('LoadImage', { image }),
      5: node('ImageInvert', { image: ['4', 0] }),
      6: node('ControlNetLoader', { control_net_name: controlnet }),
      7: node('ControlNetApplyAdvanced', {
        positive: ['2', 0], negative: ['3', 0], control_net: ['6', 0], image: ['5', 0],
        strength, start_percent: 0, end_percent: 1
      }),
      8: node('EmptyLatentImage', { width: 640, height: 512, batch_size: 1 }),
      9: node('KSampler', {
        model: ['1', 0], positive: ['7', 0], negative: ['7', 1], latent_image: ['8', 0],
        seed, steps: 24, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1
      }),
      10: node('VAEDecode', { samples: ['9', 0], vae: ['1', 2] }),
      [SAVE_NODE_ID]: node('SaveImage', { images: ['10', 0], filename_prefix: 'Wuying/render' })
    };
  }

  function delay(signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, POLL_INTERVAL_MS);
      function cancel() {
        clearTimeout(timer);
        reject(signal.reason);
      }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  async function waitForImage(base, promptId, signal) {
    const path = '/history/' + encodeURIComponent(promptId);
    while (true) {
      const history = await request(base, path, signal);
      const job = Object.hasOwn(history || {}, promptId) ? history[promptId] : null;
      if (job?.status?.status_str === 'error') {
        const failure = job.status.messages?.find(([event]) => event === 'execution_error'
          || event === 'execution_interrupted');
        const detail = failure?.[1]?.exception_message;
        throw new Error('ComfyUI 生成失败。' + (typeof detail === 'string' ? detail.slice(0, 280) : ''));
      }
      const image = job?.outputs?.[SAVE_NODE_ID]?.images?.[0];
      if (typeof image?.filename === 'string' && image.filename) return image;
      if (job?.status?.completed) throw new Error('ComfyUI 已完成任务，但没有返回图像。');
      await delay(signal);
    }
  }

  async function generate({
    endpoint, checkpoint, controlnet, strength, prompt, negative = '', sketch, signal, onStatus
  }) {
    signal?.throwIfAborted();
    const base = endpointBase(endpoint);
    if (typeof checkpoint !== 'string' || !checkpoint.trim()
        || typeof controlnet !== 'string' || !controlnet.trim()) {
      throw new Error('请先选择 SD1.5 主模型与匹配的 Scribble ControlNet。');
    }
    if (typeof prompt !== 'string' || !prompt.trim() || typeof negative !== 'string') {
      throw new Error('请填写生成提示词。');
    }
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
      throw new Error('草图控形强度须在 0 到 1 之间。');
    }
    if (!(sketch instanceof Blob) || !sketch.size || sketch.type !== 'image/png') {
      throw new Error('控形草图必须为 PNG 图像。');
    }

    const deadline = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
    const generationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const random = crypto.getRandomValues(new Uint32Array(3));
    const upload = new FormData();
    upload.set('image', sketch, 'wuying-' + random[0] + '-' + random[1] + '.png');
    upload.set('type', 'input');
    upload.set('overwrite', 'false');
    try {
      onStatus?.('正在上传控形草图…');
      const uploaded = await request(base, '/upload/image', generationSignal, {
        method: 'POST', body: upload
      });
      if (typeof uploaded?.name !== 'string' || !uploaded.name) {
        throw new Error('ComfyUI 未返回上传后的草图文件名。');
      }
      const image = uploaded.subfolder ? uploaded.subfolder + '/' + uploaded.name : uploaded.name;

      onStatus?.('正在提交生成任务…');
      const queued = await request(base, '/prompt', generationSignal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: workflow({ checkpoint, controlnet, strength, prompt, negative, image, seed: random[2] })
        })
      });
      const promptId = queued?.prompt_id;
      if (typeof promptId !== 'string' || !promptId) {
        throw new Error('ComfyUI 未返回任务编号。' + serverError(queued));
      }

      onStatus?.('等待 ComfyUI 生成…');
      const output = await waitForImage(base, promptId, generationSignal);
      const params = new URLSearchParams({
        filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output'
      });
      onStatus?.('正在下载生成结果…');
      const blob = await request(base, '/view?' + params, generationSignal, { image: true });
      return { blob, promptId };
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) throw new Error('ComfyUI 生成等待超过 5 分钟，请在后端查看队列。');
      throw error;
    }
  }

  const api = { testConnection, generate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.WuyingComfy = api;
}());
