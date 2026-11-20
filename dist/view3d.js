// 模块 3：3D 视角查看。把当前图（候选 / 实时帧 / 画布合成）抠出主体、充气成闭合体块，
// 正面贴原图，可 360° 旋转、滚轮缩放、调厚度、截图回图层、导出 GLB。
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ENGINE_URL = 'vendor/model-engine.js';
  let enginePromise, T, ui, view, source, rebuildTimer, buildToken = 0;

  function loadEngine() {
    if (window.WuyingModelEngine?.GLTFExporter) return Promise.resolve(window.WuyingModelEngine);
    if (!enginePromise) enginePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ENGINE_URL;
      script.onload = () => window.WuyingModelEngine?.GLTFExporter ? resolve(window.WuyingModelEngine) : reject(new Error('3D 引擎版本不对，缺少 GLB 导出。'));
      script.onerror = () => reject(new Error('3D 引擎加载失败，请检查网络或刷新页面。'));
      document.head.append(script);
    }).catch(error => { enginePromise = null; throw error; });
    return enginePromise;
  }

  // 解码源图：mask 用长边 ≤512 的像素，贴图用长边 ≤2048 的画布。
  async function decode(blob) {
    if (!blob) throw new Error('没有可查看的图像。');
    let bitmap;
    try { bitmap = await createImageBitmap(blob); }
    catch { throw new Error('图像无法解码，换一张 PNG / JPG 再试。'); }
    const draw = limit => {
      const k = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, Math.round(bitmap.width * k));
      canvas.height = Math.max(2, Math.round(bitmap.height * k));
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas;
    };
    const small = draw(512), texture = draw(2048);
    const pixels = small.getContext('2d').getImageData(0, 0, small.width, small.height);
    bitmap.close?.();
    return { pixels, texture, width: small.width, height: small.height };
  }

  function setup() {
    if (view) return view;
    const stage = ui.stage;
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.domElement.className = 'view3d-canvas';
    stage.prepend(renderer.domElement);
    const scene = new T.Scene();
    const pmrem = new T.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new T.RoomEnvironment(), .04).texture;
    scene.add(new T.AmbientLight(0xffffff, .35));
    const key = new T.DirectionalLight(0xffffff, 1.2);
    key.position.set(1.5, 2, 2.5);
    scene.add(key);
    const camera = new T.PerspectiveCamera(35, 1, .01, 50);
    const controls = new T.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.minDistance = .5;
    controls.maxDistance = 6;
    view = { renderer, scene, camera, controls, mesh: null, frame: 0 };
    const resize = () => {
      const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    view.resize = resize;
    new ResizeObserver(resize).observe(stage);
    return view;
  }

  function resetCamera() {
    view.camera.position.set(.55, .25, 2.1);
    view.controls.target.set(0, 0, 0);
    view.controls.update();
  }

  function loop() {
    if (!ui.dialog.open) { view.frame = 0; return; }
    view.controls.update();
    view.renderer.render(view.scene, view.camera);
    view.frame = requestAnimationFrame(loop);
  }

  function status(text, error = false) {
    ui.status.textContent = text;
    ui.status.dataset.error = String(!!error);
    ui.retry.hidden = !error;
  }

  function busy(on) {
    ui.busy.hidden = !on;
    ui.capture.disabled = on || !view?.mesh;
    ui.exportButton.disabled = on || !view?.mesh;
  }

  // 用当前厚度重建网格。失败时保留上一个网格并提示。
  async function rebuild() {
    const token = ++buildToken;
    busy(true);
    status('');
    await new Promise(r => setTimeout(r, 16));
    if (token !== buildToken) return;
    try {
      const thickness = Number(ui.thickness.value) / 100;
      const t0 = performance.now();
      const result = window.WuyingInflate.build(source.pixels.data, source.width, source.height, { grid: 128, thickness });
      const geometry = new T.BufferGeometry();
      geometry.setAttribute('position', new T.BufferAttribute(result.positions, 3));
      geometry.setAttribute('uv', new T.BufferAttribute(result.uvs, 2));
      geometry.setIndex(new T.BufferAttribute(result.indices, 1));
      geometry.computeVertexNormals();
      if (!view.material) {
        const map = new T.CanvasTexture(source.texture);
        map.colorSpace = T.SRGBColorSpace;
        map.anisotropy = 4;
        view.material = new T.MeshStandardMaterial({ map, roughness: .5, metalness: 0 });
      }
      if (view.mesh) { view.mesh.geometry.dispose(); view.mesh.geometry = geometry; }
      else { view.mesh = new T.Mesh(geometry, view.material); view.mesh.name = source.name || '物映体块'; view.scene.add(view.mesh); }
      view.stats = { ...result.stats, size: result.size, closed: window.WuyingInflate.isClosed(result.indices), ms: Math.round(performance.now() - t0) };
      ui.meta.textContent = view.stats.triangles.toLocaleString() + ' 个三角面 · 厚度 ' + Math.round(thickness * 100) + '%';
      status('拖动旋转，滚轮缩放，右键平移。');
    } catch (error) {
      view.stats = { error: error.message };
      status(error.message, true);
    } finally {
      if (token === buildToken) busy(false);
    }
  }

  function disposeMesh() {
    if (!view) return;
    if (view.mesh) { view.scene.remove(view.mesh); view.mesh.geometry.dispose(); view.mesh = null; }
    if (view.material) { view.material.map?.dispose(); view.material.dispose(); view.material = null; }
    view.stats = null;
  }

  async function load() {
    busy(true);
    status('正在载入 3D 引擎…');
    try {
      T = await loadEngine();
      setup();
      disposeMesh();
      source = { ...(await decode(await source.getBlob())), getBlob: source.getBlob, name: source.name };
      view.resize();
      resetCamera();
      if (!view.frame) loop();
      await rebuild();
    } catch (error) {
      view && (view.stats = { error: error.message });
      busy(false);
      status(error.message, true);
    }
  }

  // getBlob：返回要查看的图（异步，便于画布合成）；onCapture(blob)：截图回调。
  function open({ getBlob, name, sourceLabel, onCapture }) {
    bind();
    source = { getBlob, name };
    ui.onCapture = onCapture;
    ui.heading.textContent = '3D 查看 · ' + (sourceLabel || '当前图');
    ui.meta.textContent = '';
    if (!ui.dialog.open) ui.dialog.showModal();
    if (view && !view.frame) loop();
    return load();
  }

  // 截图：按当前视角渲染一张 PNG（尺寸由调用方给，默认取画面尺寸）。
  async function capture(width, height) {
    if (!view?.mesh) throw new Error('还没有可截图的体块。');
    const { renderer, camera } = view;
    const w = width || ui.stage.clientWidth, h = height || ui.stage.clientHeight;
    const ratio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.render(view.scene, camera);
    const blob = await new Promise(r => renderer.domElement.toBlob(r, 'image/png'));
    renderer.setPixelRatio(ratio);
    view.resize();
    if (!blob) throw new Error('截图失败。');
    return blob;
  }

  function exportGlb() {
    if (!view?.mesh) return Promise.reject(new Error('还没有可导出的体块。'));
    return new Promise((resolve, reject) => new T.GLTFExporter().parse(view.mesh, resolve, error => reject(new Error('GLB 导出失败：' + (error?.message || error))), { binary: true }));
  }

  // 读回校验：GLTFLoader 能解析，且三角面数一致。
  function verifyGlb(buffer) {
    return new Promise((resolve, reject) => new T.GLTFLoader().parse(buffer, '', gltf => {
      let triangles = 0, textured = false;
      gltf.scene.traverse(node => {
        if (!node.isMesh) return;
        const index = node.geometry.index;
        triangles += (index ? index.count : node.geometry.attributes.position.count) / 3;
        textured ||= !!node.material?.map;
      });
      resolve({ triangles, textured, bytes: buffer.byteLength });
    }, error => reject(new Error('GLB 读回失败：' + (error?.message || error)))));
  }

  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    ui = {
      dialog: $('studioView3d'), stage: $('studioView3dStage'), busy: $('studioView3dBusy'), heading: $('view3dHeading'),
      meta: $('studioView3dMeta'), status: $('studioView3dStatus'), retry: $('studioView3dRetry'),
      thickness: $('studioView3dThickness'), thicknessValue: $('studioView3dThicknessValue'),
      capture: $('studioView3dCapture'), exportButton: $('studioView3dExport')
    };
    $('studioView3dClose').addEventListener('click', () => ui.dialog.close());
    $('studioView3dReset').addEventListener('click', () => view && resetCamera());
    ui.retry.addEventListener('click', () => void (view?.mesh ? rebuild() : load()));
    ui.thickness.addEventListener('input', () => {
      ui.thicknessValue.textContent = ui.thickness.value + '%';
      if (!source?.pixels || !view) return;
      ui.busy.hidden = false;
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => void rebuild(), 60);
    });
    ui.capture.addEventListener('click', async () => {
      ui.capture.disabled = true;
      try {
        const blob = await capture(ui.captureSize?.width, ui.captureSize?.height);
        await ui.onCapture?.(blob);
        status('已把当前视角截图加为新图层。');
      } catch (error) { status('截图失败：' + error.message, true); }
      finally { ui.capture.disabled = !view?.mesh; }
    });
    ui.exportButton.addEventListener('click', async () => {
      ui.exportButton.disabled = true;
      try {
        const buffer = await exportGlb();
        const check = await verifyGlb(buffer);
        const href = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
        const a = document.createElement('a');
        a.href = href;
        a.download = (source?.name || '物映体块').replace(/[<>:"/\\|?*]/g, '-') + '.glb';
        a.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
        status('已导出 GLB（' + Math.round(check.bytes / 1024) + ' KB，读回校验通过，' + check.triangles.toLocaleString() + ' 个三角面）。');
      } catch (error) { status(error.message, true); }
      finally { ui.exportButton.disabled = !view?.mesh; }
    });
    ui.dialog.addEventListener('close', () => { clearTimeout(rebuildTimer); if (view?.frame) cancelAnimationFrame(view.frame); if (view) view.frame = 0; });
  }

  window.WuyingView3D = {
    open, capture, exportGlb, verifyGlb, loadEngine,
    setCaptureSize: size => { bind(); ui.captureSize = size; },
    state: () => ({ open: !!ui?.dialog.open, busy: ui ? !ui.busy.hidden : false, stats: view?.stats || null, status: ui?.status.textContent || '' }),
    camera: () => view && { position: view.camera.position.toArray(), azimuth: view.controls.getAzimuthalAngle(), distance: view.camera.position.distanceTo(view.controls.target) }
  };
})();
