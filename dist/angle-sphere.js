// 阶段 5：角度球。球面拖动控制水平方位角（0–360）与俯仰角（-85–85），
// 映射到现有 11 档视角预设，松手即按该视角渲染（Krea 式即拖即渲）。
(() => {
  'use strict';
  const svgNS = 'http://www.w3.org/2000/svg';
  // 8 个水平方位扇区（正视 = 0°，顺时针）。
  const directions = [
    [0, 'front'], [45, 'front-right'], [90, 'right'], [135, 'rear-right'],
    [180, 'rear'], [225, 'rear-left'], [270, 'left'], [315, 'front-left']
  ];
  const elevationBands = { overhead: 55, high: 25, low: -55 };

  function wrapAngle(value) {
    if (!Number.isFinite(value)) return 0;
    return ((value % 360) + 360) % 360;
  }
  function clampEl(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(-85, Math.min(85, Math.round(value)));
  }

  // 视角映射：俯仰超过 55° 直接顶视 / 底视；25–55° 且朝向前半区用「前上方」；
  // 其余按最近水平方位。返回的 view 与 WuyingWorkflow.viewPresets 的键一致。
  function mapToView(azimuth, elevation) {
    const az = wrapAngle(azimuth), el = clampEl(elevation);
    const dir = directions.reduce((best, [deg, key]) => {
      const delta = Math.min(Math.abs(az - deg), 360 - Math.abs(az - deg));
      return delta < best.delta ? { delta, key } : best;
    }, { delta: 999, key: 'front' });
    // 「前上方」只对前向扇区有意义；侧向 / 后向忽略俯仰，回落到水平方位。
    const facingFront = ['front', 'front-left', 'front-right'].includes(dir.key);
    if (el > elevationBands.overhead) return { view: 'top', azimuth: az, elevation: el, direction: dir.key };
    if (el < elevationBands.low) return { view: 'bottom', azimuth: az, elevation: el, direction: dir.key };
    if (el > elevationBands.high && facingFront) return { view: 'elevated', azimuth: az, elevation: el, direction: dir.key };
    return { view: dir.key, azimuth: az, elevation: el, direction: dir.key };
  }

  function normalize(value) {
    const az = wrapAngle(value?.azimuth), el = clampEl(value?.elevation);
    return { azimuth: az, elevation: el };
  }

  // 球面正交投影：把手 x = cx + R·cos(el)·sin(az)，y = cy − R·sin(el)。
  // 正视（az 0）与后视（az 180）投影都落在圆心，用朝向深度区分把手大小。
  function handlePoint(azimuth, elevation, size) {
    const az = wrapAngle(azimuth) * Math.PI / 180, el = clampEl(elevation) * Math.PI / 180;
    const c = size / 2, radius = size * .38;
    return { x: c + radius * Math.cos(el) * Math.sin(az), y: c - radius * Math.sin(el) };
  }
  // 朝向深度：1 = 正对观察者（正视），-1 = 背对（后视）。
  function facing(azimuth, elevation) {
    const az = wrapAngle(azimuth) * Math.PI / 180, el = clampEl(elevation) * Math.PI / 180;
    return Math.cos(el) * Math.cos(az);
  }

  function create({ size = 148, onChange = () => {}, label = '视角球' } = {}) {
    size = Math.max(96, size);
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('role', 'application');
    svg.setAttribute('aria-label', label);
    svg.classList.add('angle-sphere');
    const circle = tag('circle', { cx: size / 2, cy: size / 2, r: size * .38, class: 'sphere-body' });
    const equator = tag('ellipse', { cx: size / 2, cy: size / 2, rx: size * .38, ry: size * .12, class: 'sphere-line' });
    const meridian = tag('ellipse', { cx: size / 2, cy: size / 2, rx: size * .12, ry: size * .38, class: 'sphere-line' });
    const crossV = tag('line', { x1: size / 2, y1: size * .06, x2: size / 2, y2: size * .94, class: 'sphere-line' });
    const crossH = tag('line', { x1: size * .06, y1: size / 2, x2: size * .94, y2: size / 2, class: 'sphere-line' });
    const handle = tag('circle', { r: Math.max(9, size * .075), class: 'sphere-handle' });
    const readout = tag('text', { x: size / 2, y: size - 6, class: 'sphere-readout', 'text-anchor': 'middle' });
    svg.append(circle, equator, meridian, crossV, crossH, handle, readout);
    const state = { azimuth: 0, elevation: 0 };
    let dragging = false;

    function tag(name, attrs) {
      const node = document.createElementNS(svgNS, name);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      return node;
    }
    function sync() {
      const point = handlePoint(state.azimuth, state.elevation, size);
      handle.setAttribute('cx', point.x);
      handle.setAttribute('cy', point.y);
      // 把手大小随朝向：朝向观察者最大，背对最小，避免正视/后视投影重合时无法分辨。
      const depth = facing(state.azimuth, state.elevation);
      handle.setAttribute('r', Math.max(5, size * .075 * (.55 + .45 * depth)));
      handle.setAttribute('fill-opacity', String(.55 + .45 * (depth + 1) / 2));
      const az = Math.round(state.azimuth), el = Math.round(state.elevation);
      readout.textContent = '水平 ' + az + '° · 俯仰 ' + el + '°';
      svg.setAttribute('aria-valuetext', readout.textContent);
    }
    // 轨道球拖动：水平位移转方位角，竖直位移转俯仰角（0.55°/px，Shift 加速）。
    let last = null;
    function fromEvent(event) {
      if (!last) return;
      const step = event.shiftKey ? 1.1 : .55;
      state.azimuth = wrapAngle(state.azimuth + (event.clientX - last.x) * step);
      state.elevation = clampEl(state.elevation - (event.clientY - last.y) * step);
      last = { x: event.clientX, y: event.clientY };
      sync();
    }
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragging = true;
      last = { x: event.clientX, y: event.clientY };
      svg.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    svg.addEventListener('pointermove', event => { if (dragging) fromEvent(event); });
    const release = event => {
      if (!dragging) return;
      dragging = false;
      last = null;
      onChange(read());
    };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('lostpointercapture', release);
    svg.addEventListener('keydown', event => {
      const step = event.shiftKey ? 15 : 5;
      let handled = true;
      if (event.key === 'ArrowLeft') state.azimuth = wrapAngle(state.azimuth - step);
      else if (event.key === 'ArrowRight') state.azimuth = wrapAngle(state.azimuth + step);
      else if (event.key === 'ArrowUp') state.elevation = clampEl(state.elevation + step);
      else if (event.key === 'ArrowDown') state.elevation = clampEl(state.elevation - step);
      else handled = false;
      if (handled) { sync(); onChange(read()); event.preventDefault(); }
    });
    svg.tabIndex = 0;
    sync();
    const read = () => ({ azimuth: wrapAngle(state.azimuth), elevation: clampEl(state.elevation) });
    const set = (azimuth, elevation) => {
      state.azimuth = wrapAngle(normalize({ azimuth, elevation }).azimuth);
      state.elevation = clampEl(elevation);
      sync();
    };
    return { root: svg, read, set };
  }

  window.WuyingAngleSphere = { create, mapToView, normalize, handlePoint, facing, directions, elevationBands };
})();
