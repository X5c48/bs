(() => {
  'use strict';

  const engineUrl = new URL('vendor/model-engine.js', document.currentScript.src).href;
  const maxSize = 50 * 1024 * 1024;
  const modelSize = window.WuyingStudioCore.modelSize;
  const views = {
    angle: { label: '斜视', direction: [1, .62, 1.75] },
    front: { label: '正视', direction: [0, 0, 1] },
    side: { label: '右视', direction: [1, 0, 0] },
    top: { label: '俯视', direction: [0, 1, .0001] }
  };
  let enginePromise;
  let databasePromise;

  function loadEngine() {
    if (!enginePromise) {
      enginePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = engineUrl;
        script.onload = () => window.WuyingModelEngine ? resolve(window.WuyingModelEngine) : reject();
        script.onerror = () => { script.remove(); reject(); };
        document.head.append(script);
      }).catch(() => {
        enginePromise = null;
        throw new Error('3D 组件未能加载');
      });
    }
    return enginePromise;
  }

  function modelStorage(mode, action) {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const open = indexedDB.open('wuying-model-files', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('models');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          db.onversionchange = () => { db.close(); databasePromise = null; };
          resolve(db);
        };
      }).catch(error => { databasePromise = null; throw error; });
    }
    return databasePromise.then(db => new Promise((resolve, reject) => {
      const transaction = db.transaction('models', mode);
      const request = action(transaction.objectStore('models'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    }));
  }

  function disposeObject(object) {
    const geometries = new Set(), materials = new Set(), textures = new Set(), bitmaps = new Set();
    object.traverse(item => {
      if (item.geometry) geometries.add(item.geometry);
      for (const material of [].concat(item.material || [])) materials.add(material);
      item.skeleton?.dispose();
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) {
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      material.dispose();
    }
    for (const texture of textures) {
      if (typeof texture.image?.close === 'function') bitmaps.add(texture.image);
      texture.dispose();
    }
    for (const bitmap of bitmaps) bitmap.close();
  }

  function outlineModel(T, outline, bounds, depth, color, bevel = .026) {
    const scale = modelSize.span / Math.max(bounds.width, bounds.height);
    const xy = point => [(point.x - bounds.x) * scale, (bounds.y + bounds.height - point.y) * scale];
    const shape = new T.Shape();
    shape.moveTo(...xy(outline.nodes[0].point));
    outline.nodes.forEach((point, index) => {
      const next = outline.nodes[(index + 1) % outline.nodes.length];
      shape.bezierCurveTo(...xy(point.out), ...xy(next.in), ...xy(next.point));
    });
    shape.closePath();
    const geometry = new T.ExtrudeGeometry(shape, { depth, steps: 1, curveSegments: 14,
      bevelEnabled: true, bevelSegments: 3, bevelThickness: bevel, bevelSize: bevel });
    const face = new T.MeshStandardMaterial({ color, metalness: .27, roughness: .58 });
    const side = face.clone();
    side.color.multiplyScalar(.73);
    return new T.Mesh(geometry, [face, side]);
  }

  function depthModel(T, parts, color) {
    const left = Math.min(...parts.map(part => part.box.x));
    const top = Math.min(...parts.map(part => part.box.y));
    const right = Math.max(...parts.map(part => part.box.x + part.box.width));
    const bottom = Math.max(...parts.map(part => part.box.y + part.box.height));
    const frame = { x: left, y: top, width: right - left, height: bottom - top };
    const scale = modelSize.span / Math.max(frame.width, frame.height);
    const group = new T.Group();
    try {
      for (const part of parts) {
        const depth = Math.hypot(part.depth.x, part.depth.y) * scale;
        const bevel = Math.min(.026, depth * .18, Math.min(part.box.width, part.box.height) * scale * .05);
        const mesh = outlineModel(T, part.shape, frame, depth, color, bevel);
        mesh.position.z = -depth;
        group.add(mesh);
      }
      return group;
    } catch (error) {
      disposeObject(group);
      throw error;
    }
  }

  function inspectGlb(data) {
    const header = new DataView(data);
    if (data.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 ||
        header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== data.byteLength ||
        header.getUint32(16, true) !== 0x4e4f534a || header.getUint32(12, true) > data.byteLength - 20) {
      throw new Error('无法读取此 GLB 文件');
    }
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, header.getUint32(12, true))));
    for (const resource of [...(json.buffers || []), ...(json.images || [])]) {
      if (resource.uri !== undefined && !/^data:/i.test(resource.uri)) {
        throw new Error('请选择内嵌贴图的 GLB 文件');
      }
    }
    if (json.extensionsRequired?.some(name =>
      ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(name))) {
      throw new Error('请从建模软件导出标准 GLB，关闭网格或贴图压缩');
    }
  }

  async function readModel(T, name, blob) {
    const format = name.match(/\.(glb|obj|stl)$/i)?.[1].toLowerCase();
    if (!format || blob.size > maxSize || blob.size === 0) {
      throw new Error('请选择 50 MB 以内的 GLB、OBJ 或 STL');
    }
    if (format === 'obj') return new T.OBJLoader().parse(await blob.text());

    const bytes = await blob.arrayBuffer();
    if (format === 'glb') {
      inspectGlb(bytes);
      const manager = new T.LoadingManager();
      manager.setURLModifier(url => {
        if (!/^(blob:|data:)/i.test(url)) throw new Error('请选择内嵌贴图的 GLB 文件');
        return url;
      });
      const gltf = await new T.GLTFLoader(manager).parseAsync(bytes, '');
      return gltf.scene;
    }

    if (bytes.byteLength < 84) throw new Error('无法读取此 STL 文件');
    const triangles = new DataView(bytes).getUint32(80, true);
    const prefix = new TextDecoder().decode(new Uint8Array(bytes, 0, 12));
    if (84 + triangles * 50 !== bytes.byteLength && !/^.{0,4}solid/.test(prefix)) {
      throw new Error('无法读取此 STL 文件');
    }
    const geometry = new T.STLLoader().parse(bytes);
    const material = new T.MeshStandardMaterial({ color: geometry.hasColors ? '#ffffff' : '#a4adad', vertexColors: !!geometry.hasColors, roughness: .47 });
    const mesh = new T.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }

  function createView(T, stage) {
    let renderer;
    try { renderer = new T.WebGLRenderer({ antialias: true }); }
    catch { throw new Error('3D 预览需要支持 WebGL 2 的浏览器'); }

    const canvas = renderer.domElement;
    canvas.setAttribute('aria-label', '3D 模型视图');
    canvas.setAttribute('role', 'img');
    canvas.tabIndex = 0;
    canvas.dataset.modelViewport = '';
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.16;
    stage.prepend(canvas);
    const scene = new T.Scene();
    scene.background = new T.Color('#d7dcdb');
    const camera = new T.PerspectiveCamera(35, 1, .015, 80);
    camera.position.set(3, 2, 6);
    const controls = new T.OrbitControls(camera, canvas);
    controls.minDistance = .7;
    controls.maxDistance = 18;
    controls.zoomSpeed = .84;
    controls.listenToKeyEvents(canvas);
    const draw = () => renderer.render(scene, camera);
    controls.addEventListener('change', draw);
    canvas.addEventListener('webglcontextrestored', draw);
    const grid = new T.GridHelper(5.5, 16, '#adb7b3', '#bdc6c2');
    grid.material.transparent = true;
    grid.material.opacity = .53;
    scene.add(grid, new T.HemisphereLight('#f4f8fa', '#a1a598', 1.45));
    const key = new T.DirectionalLight('#fff6e8', 2.7);
    key.position.set(3, 6, 4);
    const rim = new T.DirectionalLight('#e7f1ff', 1.1);
    rim.position.set(-4, 3, -2);
    scene.add(key, rim);

    const pmrem = new T.PMREMGenerator(renderer);
    const room = new T.RoomEnvironment();
    const env = pmrem.fromScene(room, .04);
    scene.environment = env.texture;
    scene.environmentIntensity = .84;
    room.dispose();
    pmrem.dispose();

    let holder = null, width = 1, height = 1, motion = 0;
    const stopMotion = () => { cancelAnimationFrame(motion); motion = 0; };
    controls.addEventListener('start', stopMotion);
    function resize() {
      if (!stage.clientWidth || !stage.clientHeight) return;
      width = stage.clientWidth;
      height = stage.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      draw();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();

    function setView(name, animate = false) {
      stopMotion();
      const direction = new T.Vector3(...views[name].direction).normalize();
      const vertical = camera.fov * Math.PI / 360;
      const fov = Math.min(vertical, Math.atan(Math.tan(vertical) * camera.aspect));
      const distance = 1.38 / Math.sin(fov) * 1.10;
      const update = (target, position) => {
        controls.target.copy(target);
        camera.position.copy(position).add(target);
        controls.update();
        draw();
      };
      const center = new T.Vector3();
      if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        update(center, direction.multiplyScalar(distance));
        return;
      }
      const startTarget = controls.target.clone();
      const startDirection = camera.position.clone().sub(startTarget);
      const startDistance = startDirection.length();
      startDirection.normalize();
      const rotation = new T.Quaternion().setFromUnitVectors(startDirection, direction);
      const step = new T.Quaternion(), point = new T.Vector3(), target = new T.Vector3();
      const began = performance.now();
      const animateCamera = now => {
        const time = Math.min(1, (now - began) / 240);
        const blend = 1 - (1 - time) ** 3;
        target.copy(startTarget).lerp(center, blend);
        step.identity().slerp(rotation, blend);
        point.copy(startDirection).applyQuaternion(step).multiplyScalar(startDistance + (distance - startDistance) * blend);
        update(target, point);
        motion = time < 1 ? requestAnimationFrame(animateCamera) : 0;
      };
      motion = requestAnimationFrame(animateCamera);
    }

    function currentYaw() {
      const offset = camera.position.clone().sub(controls.target);
      return T.MathUtils.radToDeg(Math.atan2(offset.x, offset.z));
    }

    function rotateYaw(degrees, animate = false) {
      stopMotion();
      const axis = new T.Vector3(0, 1, 0);
      const radians = T.MathUtils.degToRad(degrees);
      const update = offset => {
        camera.position.copy(controls.target).add(offset);
        controls.update();
        draw();
      };
      if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        update(camera.position.clone().sub(controls.target).applyAxisAngle(axis, radians));
        return;
      }
      const start = camera.position.clone().sub(controls.target);
      const began = performance.now();
      const animateCamera = now => {
        const time = Math.min(1, (now - began) / 240);
        const blend = 1 - (1 - time) ** 3;
        update(start.clone().applyAxisAngle(axis, radians * blend));
        motion = time < 1 ? requestAnimationFrame(animateCamera) : 0;
      };
      motion = requestAnimationFrame(animateCamera);
    }

    function rotateTo(degrees, animate = true) {
      rotateYaw(degrees - currentYaw(), animate);
    }

    function clear() {
      stopMotion();
      if (holder) { scene.remove(holder); disposeObject(holder); holder = null; }
      grid.visible = false;
      draw();
    }

    function show(object, preserveView = false) {
      let hasMesh = false;
      object.traverse(item => {
        if (item.isMesh && item.geometry?.getAttribute('position')?.count >= 3) hasMesh = true;
      });
      const bounds = new T.Box3().setFromObject(object);
      const sphere = bounds.getBoundingSphere(new T.Sphere());
      if (!hasMesh || !Number.isFinite(sphere.radius) || sphere.radius <= 0 ||
          ![sphere.center.x, sphere.center.y, sphere.center.z].every(Number.isFinite)) {
        throw new Error('文件中没有可预览的网格');
      }
      const offset = new T.Group();
      offset.position.copy(sphere.center).negate();
      offset.add(object);
      const next = new T.Group();
      next.scale.setScalar(1.38 / sphere.radius);
      next.add(offset);
      if (holder) { scene.remove(holder); disposeObject(holder); }
      holder = next;
      grid.position.y = (bounds.min.y - sphere.center.y) * next.scale.x - .04;
      grid.visible = true;
      scene.add(holder);
      if (preserveView) draw();
      else setView('angle');
    }

    function capture() {
      const ratio = renderer.getPixelRatio(), aspect = camera.aspect, fov = camera.fov;
      const captureWidth = 960, captureHeight = 768;
      try {
        grid.visible = false;
        camera.aspect = captureWidth / captureHeight;
        if (aspect > camera.aspect) {
          const horizontal = Math.tan(T.MathUtils.degToRad(fov / 2)) * aspect;
          camera.fov = T.MathUtils.radToDeg(2 * Math.atan(horizontal / camera.aspect));
        }
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(1);
        renderer.setSize(captureWidth, captureHeight, false);
        draw();
        for (const quality of [.86, .70, .52]) {
          const image = canvas.toDataURL('image/jpeg', quality);
          if (image.length < 950000) return image;
        }
        throw new Error('取景图体积过大');
      } finally {
        grid.visible = true;
        camera.aspect = aspect;
        camera.fov = fov;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(ratio);
        renderer.setSize(width, height, false);
        draw();
      }
    }

    return { show, clear, setView, rotateYaw, rotateTo, capture, onOrbit: listener => controls.addEventListener('start', listener), dispose() {
      stopMotion();
      observer.disconnect();
      controls.dispose();
      if (holder) disposeObject(holder);
      disposeObject(grid);
      env.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    } };
  }

  function mount({ stage, footer, sub, state, storageId, onReference, onRender, getSketch, getOutline, getDepthParts, outlineKey, bounds }) {
    stage.className = 'graph-model-stage';
    stage.innerHTML = '<div class="graph-model-message" role="status">正在打开 3D 预览…</div>';
    footer.innerHTML = '<input type="file" accept=".glb,.obj,.stl" hidden aria-label="选择模型文件">' +
      '<button type="button" class="graph-control graph-model-open" disabled title="导入 GLB、OBJ 或 STL">导入模型</button>' +
      '<select class="graph-control" aria-label="模型视角" disabled></select>' +
      '<label class="graph-model-depth" title="调整轮廓体块的厚度">厚度 <input type="range" min="12" max="68" value="' + modelSize.defaultDepth + '" aria-label="体块厚度"></label>' +
      '<button type="button" class="graph-control graph-model-source" hidden>草图体块</button>' +
      '<button type="button" class="graph-control graph-model-capture" disabled>取为参考图</button>' +
      '<button type="button" class="graph-control graph-model-render" disabled>渲染此视角</button>';
    const message = stage.querySelector('.graph-model-message');
    const fileInput = footer.querySelector('input');
    const open = footer.querySelector('.graph-model-open');
    const capture = footer.querySelector('.graph-model-capture');
    const render = footer.querySelector('.graph-model-render');
    const preset = footer.querySelector('select');
    const depth = footer.querySelector('input[type=range]');
    const source = footer.querySelector('.graph-model-source');
    const freeView = new Option('自由视角', 'custom');
    freeView.disabled = true;
    preset.append(...Object.entries(views).map(([value, view]) => new Option(view.label, value)), freeView);

    let T, view, closed = false, busy = true, activeName = '', displayed = '', lastFile = null, previousSketch = null;
    let drawnParts = 0;
    const setMessage = (text, error = false) => {
      message.textContent = text;
      message.dataset.error = String(error);
    };
    const setBusy = value => {
      busy = value;
      open.disabled = !view || busy;
      preset.disabled = capture.disabled = render.disabled = !displayed || busy;
      depth.disabled = displayed !== 'sketch' || busy || drawnParts > 0;
      source.disabled = busy;
      source.hidden = !lastFile;
      source.textContent = displayed === 'file' ? '草图体块' : '上次模型';
      depth.parentElement.hidden = displayed === 'file' || displayed === 'sketch' && drawnParts > 0;
    };

    function updateSketch(force = false) {
      if (!view || busy || (displayed === 'file' && !force)) return;
      const { scene, color, viewName } = getSketch();
      const key = [scene.id, scene.curve && outlineKey(scene.curve), scene.depth?.x, scene.depth?.y, color, depth.value].join('|');
      const viewChanged = viewName !== previousSketch?.viewName;
      const showPlane = animate => {
        if (!viewName) return;
        preset.value = viewName;
        view.setView(viewName, animate);
      };
      if (!force && previousSketch?.key === key && previousSketch.ink.length === scene.ink.length &&
          previousSketch.ink.every((stroke, i) => stroke === scene.ink[i])) {
        if (viewChanged && displayed === 'sketch') showPlane(true);
        previousSketch.viewName = viewName;
        return;
      }
      previousSketch = { key, ink: scene.ink, viewName };
      const parts = getDepthParts(scene);
      drawnParts = parts.length;
      const outline = drawnParts ? null : getOutline(scene);
      const preserve = displayed === 'sketch' && !force;
      if (!drawnParts && !outline) {
        displayed = '';
        view.clear();
        sub.textContent = scene.title;
        sub.title = scene.title;
        state.textContent = '等待轮廓';
        setMessage('画出一个闭合轮廓，即可看 3D 体块');
        setBusy(false);
        return;
      }
      let mesh;
      try {
        mesh = drawnParts ? depthModel(T, parts, color) : outlineModel(T, outline, bounds(outline), Number(depth.value) * modelSize.depthStep, color);
        view.show(mesh, preserve);
      } catch {
        if (mesh) disposeObject(mesh);
        displayed = '';
        view.clear();
        state.textContent = '等待轮廓';
        setMessage('轮廓暂时无法形成体块，请调整交叉处', true);
        setBusy(false);
        return;
      }
      activeName = scene.title;
      displayed = 'sketch';
      if (!preserve) preset.value = 'angle';
      if (!preserve || viewChanged) showPlane(preserve);
      sub.textContent = scene.title;
      sub.title = scene.title;
      state.textContent = '草图同步';
      setMessage(drawnParts ? '已同步 '+drawnParts+' 个部件的厚度 · 拖动旋转' : '由轮廓加厚 · 拖动旋转');
      setBusy(false);
    }

    async function importFile(name, blob, persist) {
      setBusy(true);
      setMessage('正在读取模型…');
      let object;
      try {
        object = await readModel(T, name, blob);
        if (closed) return;
        view.show(object);
        object = null;
        activeName = name;
        displayed = 'file';
        lastFile = { name, blob };
        sub.textContent = name;
        sub.title = name;
        state.textContent = '已导入';
        preset.value = 'angle';
        if (persist) {
          try { await modelStorage('readwrite', store => store.put({ name, blob }, storageId)); }
          catch {
            if (!closed) setMessage('模型在本次打开期间可用', true);
            return;
          }
        }
        if (!closed) setMessage('拖动旋转 · 滚轮或双指缩放');
      } catch (error) {
        if (!closed) setMessage(error.message && /^[\u3400-\u9fff]/.test(error.message) ? error.message : '无法读取这个模型文件', true);
      } finally {
        if (object) disposeObject(object);
        if (!closed) setBusy(false);
      }
    }

    async function start() {
      try {
        T = await loadEngine();
        if (closed) return;
        view = createView(T, stage);
        view.onOrbit(() => { preset.value = 'custom'; });
        const saved = await modelStorage('readonly', store => store.get(storageId)).catch(() => null);
        if (closed) return;
        setBusy(false);
        updateSketch();
        if (saved) await importFile(saved.name, saved.blob, false);
      } catch (error) {
        if (!closed) setMessage(error.message || '无法打开 3D 预览', true);
      }
    }

    open.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file && view && !busy) importFile(file.name, file, true);
    };
    preset.onchange = () => view.setView(preset.value, true);
    depth.oninput = () => updateSketch();
    source.onclick = () => {
      if (displayed === 'file') updateSketch(true);
      else if (lastFile) importFile(lastFile.name, lastFile.blob, false);
    };
    const sendView = callback => {
      try {
        const src = view.capture();
        if (!src.startsWith('data:image/jpeg;base64,')) throw new Error();
        const label = views[preset.value]?.label || '自由视角';
        callback({ src, name: activeName.replace(/\.[^.]+$/, '').slice(0, 65) + ' · ' + label });
      } catch { setMessage('暂时无法截取当前视角', true); }
    };
    capture.onclick = () => sendView(onReference);
    render.onclick = () => sendView(onRender);

    start();
    return { updateSketch, rotateYaw: degrees => view?.rotateYaw(degrees, true), rotateTo: degrees => view?.rotateTo(degrees, true), dispose() {
      closed = true;
      view?.dispose();
      modelStorage('readwrite', store => store.delete(storageId)).catch(() => {});
    } };
  }

  window.WuyingModelPreview = { mount };
})();
