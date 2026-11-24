// 场景板（P8）：把产品放进真实场景，边摆边出照片级效果。
// 定位见整体规划 6.4 第 5 阶段：左侧场景板，右侧实时帧，产品保护靠分区去噪。
//
// 这一层的原则是「保形交给合成，不交给提示词」：
// 产品像素先由 canvas 精确摆放、精确抠图，生成模型只负责重新打光和重画场景。
// 所以几何与抠图都写成纯函数，能被单测覆盖；只有真正的画图才碰 canvas。
(function () {
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const round = n => Math.round(n);

  // ── 预设 ────────────────────────────────────────────────────────
  // 光照预设决定「光从哪来、影子多硬」，是场景板里最影响真实感的一档。
  const lightingPresets = [
    { id: 'studio', label: '棚拍', prompt: 'studio product photography, large soft box from upper left, seamless neutral backdrop, even fill light, soft round contact shadow' },
    { id: 'daylight', label: '日光', prompt: 'outdoor natural daylight, soft sun from upper right, warm neutral white balance, crisp long cast shadow' },
    { id: 'night', label: '夜景', prompt: 'night time scene, warm practical light sources, deep shadows, cool blue ambient, gentle rim light on the subject edge' },
    { id: 'window', label: '窗光', prompt: 'diffused window light from the left, soft shadow falloff, bright airy interior' }
  ];

  // 内置场景：纯色块搭出来，不依赖外部图片。地块用 y 起点决定地平线高度。
  const sampleScenes = [
    { id: 'studio', label: '棚拍', backdrop: '#f0eeea', blocks: [
      { x: 0, y: .74, w: 1, h: .26, color: '#dedad2' }
    ] },
    { id: 'desk', label: '木桌面', backdrop: '#dcd4c6', blocks: [
      { x: 0, y: .6, w: 1, h: .4, color: '#b18a5f' },
      { x: 0, y: .56, w: 1, h: .05, color: '#8d6a47' }
    ] },
    { id: 'wall', label: '灰墙', backdrop: '#c9c6c0', blocks: [
      { x: 0, y: .7, w: 1, h: .3, color: '#a7a39c' }
    ] },
    { id: 'outdoor', label: '户外草地', backdrop: '#cfe0ea', blocks: [
      { x: 0, y: .64, w: 1, h: .36, color: '#a6bb8b' }
    ] }
  ];

  // 材质标签：只补一句材质描述，不改产品结构。
  const materialTags = [
    { id: 'matte', label: '磨砂塑料', prompt: 'matte injection-moulded plastic with fine grain' },
    { id: 'brushed', label: '拉丝金属', prompt: 'brushed aluminium with fine directional streaks' },
    { id: 'glass', label: '透明玻璃', prompt: 'clear glass with soft refraction and clean highlights' },
    { id: 'wood', label: '哑光木', prompt: 'matte lacquered wood with visible grain' },
    { id: 'fabric', label: '软织物', prompt: 'soft woven fabric with shallow folds' },
    { id: 'ceramic', label: '陶瓷釉面', prompt: 'glazed ceramic with a smooth satin surface' }
  ];

  // ── 数据模型 ────────────────────────────────────────────────────
  function emptyScene() {
    return {
      version: 1,
      backdrop: '#f0eeea',
      blocks: [],
      props: [],
      // 产品对象：x/y 是「底边中点」的归一化位置，缩放时产品始终站在这条地线上。
      product: null,
      prompt: '',
      lighting: 'studio',
      material: '',
      scene: 'studio',
      seed: 0
    };
  }

  function normalizeScene(input) {
    const base = emptyScene();
    if (!input || typeof input !== 'object') return base;
    return {
      ...base,
      ...input,
      blocks: Array.isArray(input.blocks) ? input.blocks.filter(block => block && block.color) : [],
      props: Array.isArray(input.props) ? input.props.filter(prop => prop && prop.blobId) : [],
      product: input.product && input.product.blobId ? { ...input.product } : null
    };
  }

  function newProduct({ blobId, source = 'mold', x = .5, y = .78, scale = .55, rotate = 0, angle = null }) {
    return { blobId, source, x, y, scale, rotate, angle, shadow: true };
  }

  function newBlock({ color = '#b18a5f', x = 0, y = .62, w = 1, h = .38 } = {}) {
    return { id: 'block-' + Math.random().toString(36).slice(2, 9), color, x, y, w, h };
  }

  function newProp({ blobId, x = .2, y = .7, scale = .18 }) {
    return { id: 'prop-' + Math.random().toString(36).slice(2, 9), blobId, x, y, scale };
  }

  // ── 纯几何 ──────────────────────────────────────────────────────
  // scale 是「产品高度占画布高度的比例」，所以换画幅时产品不变形。
  function productBox(product, canvasWidth, canvasHeight, imageWidth, imageHeight) {
    if (!product || !(imageWidth > 0) || !(imageHeight > 0)) return null;
    const height = clamp(product.scale, .02, 1.6) * canvasHeight;
    const width = height * (imageWidth / imageHeight);
    const centerX = clamp(product.x, 0, 1) * canvasWidth;
    const baseY = clamp(product.y, 0, 1) * canvasHeight;
    return {
      centerX,
      baseY,
      width,
      height,
      left: centerX - width / 2,
      top: baseY - height,
      right: centerX + width / 2,
      bottom: baseY
    };
  }

  // 归一化包围盒：给分区去噪算「产品占多少画面」用，和画布尺寸无关。
  function boxRatio(box, canvasWidth, canvasHeight) {
    if (!box) return { x: 0, y: 0, w: 0, h: 0, area: 0 };
    const x = clamp(box.left / canvasWidth, 0, 1);
    const y = clamp(box.top / canvasHeight, 0, 1);
    const w = clamp((box.right - box.left) / canvasWidth, 0, 1);
    const h = clamp((box.bottom - box.top) / canvasHeight, 0, 1);
    return { x, y, w, h, area: w * h };
  }

  // ── 白底抠图（纯函数）─────────────────────────────────────────────
  // 白模和棚拍稿都是「浅色背景 + 有明暗的产品」，从四边做连通填充比按亮度阈值稳：
  // 产品暗面不会被误判成背景，背景里的小亮点也不会被误判成产品。
  function whiteBackdropAlpha(data, width, height, options = {}) {
    const tolerance = options.tolerance ?? 30;
    const alpha = new Uint8ClampedArray(width * height);
    if (!width || !height) return alpha;

    // 背景色取四边像素的中位数，避免某个角被产品压住时整体跑偏。
    const edgeSamples = [];
    for (let x = 0; x < width; x += Math.max(1, round(width / 64))) {
      edgeSamples.push((0 * width + x) * 4, ((height - 1) * width + x) * 4);
    }
    for (let y = 0; y < height; y += Math.max(1, round(height / 64))) {
      edgeSamples.push((y * width + 0) * 4, (y * width + width - 1) * 4);
    }
    const median = channel => {
      const values = edgeSamples.map(index => data[index + channel]).sort((a, b) => a - b);
      return values[values.length >> 1] || 0;
    };
    const seed = [median(0), median(1), median(2)];
    const near = index => {
      const dr = data[index] - seed[0], dg = data[index + 1] - seed[1], db = data[index + 2] - seed[2];
      // 加权距离：人眼对绿更敏感，白底产品通常偏暖或偏冷，加权后不容易漏抠。
      return (.3 * dr * dr + .59 * dg * dg + .11 * db * db) <= tolerance * tolerance;
    };

    // 先从四边把连通的背景点灌满。
    const background = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let tail = 0;
    const push = index => {
      if (background[index] || !near(index * 4)) return;
      background[index] = 1;
      queue[tail++] = index;
    };
    for (let x = 0; x < width; x += 1) { push(x); push((height - 1) * width + x); }
    for (let y = 0; y < height; y += 1) { push(y * width); push(y * width + width - 1); }
    for (let head = 0; head < tail; head += 1) {
      const index = queue[head];
      const x = index % width, y = (index - x) / width;
      if (x > 0) push(index - 1);
      if (x < width - 1) push(index + 1);
      if (y > 0) push(index - width);
      if (y < height - 1) push(index + width);
    }

    for (let index = 0; index < width * height; index += 1) alpha[index] = background[index] ? 0 : 255;

    // 边缘一圈做羽化，贴进场景后才不会有硬边。
    const feathered = new Uint8ClampedArray(alpha);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        let sum = 0;
        for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += alpha[index + dy * width + dx];
        // 只柔化边界（周围 9 点里既有前景又有背景），内部和外部保持原值。
        const average = sum / 9;
        feathered[index] = (average > 4 && average < 251) ? average : alpha[index];
      }
    }
    return feathered;
  }

  // 遮罩是「产品区域 + 外扩」：外扩给生成模型留出重新打光、落影的空间。
  function dilateMask(alpha, width, height, radius = 6) {
    const out = new Uint8ClampedArray(alpha);
    if (radius <= 0) return out;
    const step = Math.max(1, round(radius / 2));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (alpha[y * width + x] > 8) continue;
        let found = false;
        for (let dy = -radius; dy <= radius && !found; dy += step) {
          for (let dx = -radius; dx <= radius; dx += step) {
            const ny = y + dy, nx = x + dx;
            if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
            if (alpha[ny * width + nx] > 200) { found = true; break; }
          }
        }
        if (found) out[y * width + x] = 255;
      }
    }
    return out;
  }

  function invertMask(alpha, length) {
    const out = new Uint8ClampedArray(length);
    for (let index = 0; index < length; index += 1) out[index] = 255 - alpha[index];
    return out;
  }

  // 轮廓：遮罩的梯度。生成时作 ControlNet 条件，保证场景怎么重画产品边缘都不跑。
  function outlineFromMask(alpha, width, height, threshold = 60) {
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const right = x < width - 1 ? alpha[index + 1] : alpha[index];
        const down = y < height - 1 ? alpha[index + width] : alpha[index];
        const edge = Math.abs(alpha[index] - right) + Math.abs(alpha[index] - down) > threshold;
        const value = edge ? 0 : 255;
        out[index * 4] = value;
        out[index * 4 + 1] = value;
        out[index * 4 + 2] = value;
        out[index * 4 + 3] = 255;
      }
    }
    return out;
  }

  // ── 提示词编译（纯函数）─────────────────────────────────────────
  const lightingPrompt = id => (lightingPresets.find(item => item.id === id) || lightingPresets[0]).prompt;
  const materialPrompt = id => (materialTags.find(item => item.id === id) || {}).prompt || '';

  function scenePrompt(scene, extra = '') {
    const light = lightingPrompt(scene.lighting);
    const material = materialPrompt(scene.material);
    return [
      'A single real physical product placed naturally in this photographed scene.',
      'Keep its silhouette, proportions and parts exactly as in the reference placement.',
      'Match the scene lighting direction, perspective, contact shadow and colour temperature.',
      light,
      material,
      String(scene.prompt || '').trim(),
      String(extra || '').trim(),
      'Photorealistic product photography, sharp focus, natural depth of field.'
    ].filter(Boolean).join(' ');
  }

  // 负向词要盯住「产品变形」和「多出物体」，这两项是场景化最容易翻车的。
  const sceneNegative = 'extra products, duplicate object, second copy of the product, distorted silhouette, ' +
    'warped shape, melted edges, floating object, missing shadow, wrong scale, deformed parts, ' +
    'text, watermark, signature, lowres, worst quality, low quality, jpeg artifacts, blurry, clutter';

  // ── canvas 工具 ────────────────────────────────────────────────
  function canvasOf(width, height) {
    const element = document.createElement('canvas');
    element.width = Math.max(1, round(width));
    element.height = Math.max(1, round(height));
    return element;
  }
  const toPng = element => new Promise((resolve, reject) => {
    element.toBlob(blob => blob ? resolve(blob) : reject(new Error('画布无法导出。')), 'image/png');
  });

  // 解码 + 抠图：已经有 alpha 的图直接用，白底图走连通填充。
  async function prepareProduct(blob, options = {}) {
    const bitmap = await createImageBitmap(blob);
    try {
      const width = bitmap.width, height = bitmap.height;
      const element = canvasOf(width, height);
      const context = element.getContext('2d', { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, width, height);
      const corners = [0, (width - 1) * 4, (height - 1) * width * 4, ((height - 1) * width + width - 1) * 4];
      const transparent = corners.every(index => pixels.data[index + 3] < 12);
      let alpha;
      if (transparent) {
        alpha = new Uint8ClampedArray(width * height);
        for (let index = 0; index < width * height; index += 1) alpha[index] = pixels.data[index * 4 + 3];
      } else {
        alpha = whiteBackdropAlpha(pixels.data, width, height, options);
        for (let index = 0; index < width * height; index += 1) pixels.data[index * 4 + 3] = alpha[index];
      }
      context.putImageData(pixels, 0, 0);
      return { canvas: element, alpha, width, height, cutout: !transparent };
    } finally { bitmap.close(); }
  }

  // ── 合成 ────────────────────────────────────────────────────────
  // 返回：底图（产品已就位）、产品遮罩、场景遮罩、产品轮廓、产品包围盒。
  async function compose(scene, size, resolve, options = {}) {
    const width = Math.max(64, round(size.width)), height = Math.max(64, round(size.height));
    const state = normalizeScene(scene);
    const base = canvasOf(width, height);
    const context = base.getContext('2d', { willReadFrequently: true });
    context.fillStyle = state.backdrop;
    context.fillRect(0, 0, width, height);

    // 色块：按 y 从大到小画，近处的地块压住远处的。
    for (const block of [...state.blocks].sort((a, b) => b.y - a.y)) {
      context.fillStyle = block.color;
      context.fillRect(round(block.x * width), round(block.y * height),
        Math.max(1, round(block.w * width)), Math.max(1, round(block.h * height)));
    }

    for (const prop of state.props) {
      if (!resolve) continue;
      const blob = await resolve(prop.blobId).catch(() => null);
      if (!blob) continue;
      const bitmap = await createImageBitmap(blob).catch(() => null);
      if (!bitmap) continue;
      const propHeight = clamp(prop.scale, .02, 1) * height;
      const propWidth = propHeight * (bitmap.width / bitmap.height);
      context.drawImage(bitmap, round(prop.x * width - propWidth / 2), round(prop.y * height - propHeight), propWidth, propHeight);
      bitmap.close();
    }

    let prepared = null, box = null;
    if (state.product && resolve) {
      const blob = await resolve(state.product.blobId).catch(() => null);
      if (blob) {
        prepared = await prepareProduct(blob, options.cutout || {});
        box = productBox(state.product, width, height, prepared.width, prepared.height);
        if (box) {
          // 接触阴影：产品脚下压一层径向渐变，生成模型不必从零猜落影位置。
          if (state.product.shadow !== false) {
            const radius = box.width * .62;
            const gradient = context.createRadialGradient(box.centerX, box.baseY, 1, box.centerX, box.baseY, radius);
            gradient.addColorStop(0, 'rgba(0,0,0,.26)');
            gradient.addColorStop(.6, 'rgba(0,0,0,.10)');
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            context.save();
            context.beginPath();
            context.ellipse(box.centerX, box.baseY, radius, radius * .22, 0, 0, Math.PI * 2);
            context.fillStyle = gradient;
            context.fill();
            context.restore();
          }
          context.save();
          context.translate(box.centerX, box.baseY);
          context.rotate((Number(state.product.rotate) || 0) * Math.PI / 180);
          context.drawImage(prepared.canvas, -box.width / 2, -box.height, box.width, box.height);
          context.restore();
        }
      }
    }

    // 从合成结果反推产品遮罩：只在产品包围盒内取原始 alpha，旋转后依然准确。
    let outlineCanvas = null;
    const maskCanvas = canvasOf(width, height);
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
    maskContext.fillStyle = '#000';
    maskContext.fillRect(0, 0, width, height);
    if (prepared && box) {
      const layer = canvasOf(width, height);
      const layerContext = layer.getContext('2d');
      layerContext.translate(box.centerX, box.baseY);
      layerContext.rotate((Number(state.product.rotate) || 0) * Math.PI / 180);
      layerContext.drawImage(prepared.canvas, -box.width / 2, -box.height, box.width, box.height);
      const layerPixels = layerContext.getImageData(0, 0, width, height).data;
      const alpha = new Uint8ClampedArray(width * height);
      for (let index = 0; index < width * height; index += 1) alpha[index] = layerPixels[index * 4 + 3];
      const grown = dilateMask(alpha, width, height, Math.max(3, round(Math.min(width, height) * .012)));
      const maskPixels = maskContext.getImageData(0, 0, width, height);
      for (let index = 0; index < width * height; index += 1) {
        const value = grown[index];
        maskPixels.data[index * 4] = value;
        maskPixels.data[index * 4 + 1] = value;
        maskPixels.data[index * 4 + 2] = value;
        maskPixels.data[index * 4 + 3] = 255;
      }
      maskContext.putImageData(maskPixels, 0, 0);
      // 轮廓用未外扩的 alpha，外扩后边缘会偏粗、ControlNet 会锁到阴影上。
      const outline = outlineFromMask(alpha, width, height);
      outlineCanvas = canvasOf(width, height);
      outlineCanvas.getContext('2d').putImageData(new ImageData(outline, width, height), 0, 0);
    }

    const sceneMaskCanvas = canvasOf(width, height);
    const sceneMaskContext = sceneMaskCanvas.getContext('2d');
    sceneMaskContext.drawImage(maskCanvas, 0, 0);
    sceneMaskContext.globalCompositeOperation = 'difference';
    sceneMaskContext.fillStyle = '#fff';
    sceneMaskContext.fillRect(0, 0, width, height);

    return {
      image: await toPng(base),
      productMask: await toPng(maskCanvas),
      sceneMask: await toPng(sceneMaskCanvas),
      outline: outlineCanvas ? await toPng(outlineCanvas) : null,
      box,
      ratio: boxRatio(box, width, height),
      cutout: prepared ? prepared.cutout : false,
      width,
      height
    };
  }

  window.WuyingSceneBoard = {
    emptyScene, normalizeScene, newProduct, newBlock, newProp,
    productBox, boxRatio,
    whiteBackdropAlpha, dilateMask, invertMask, outlineFromMask,
    lightingPresets, sampleScenes, materialTags,
    lightingPrompt, materialPrompt, scenePrompt, sceneNegative,
    prepareProduct, compose
  };
})();
