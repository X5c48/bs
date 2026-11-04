(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const radians = Math.PI / 180;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const unit = ([x, y, z]) => {
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
  };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];

  function number(value, fallback, min, max) {
    const parsed = Number(value ?? fallback);
    return clamp(Number.isFinite(parsed) ? parsed : fallback, min, max);
  }

  function parseColor(value) {
    const hex = String(value ?? '').trim();
    if (/^#[\da-f]{3}$/i.test(hex)) return [...hex.slice(1)].map(c => parseInt(c + c, 16));
    if (!/^#[\da-f]{6}$/i.test(hex)) return [135, 149, 154];
    return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
  }

  function tint(base, exposure, lift = 0) {
    const channels = base.map(channel => Math.round(clamp(channel * exposure + lift, 0, 255)));
    return 'rgb(' + channels.join(',') + ')';
  }

  // Counter-clockwise perimeter seen from the front of the speaker.
  function profile(w, h, radius, z, dx = 0, dy = 0) {
    const rx = w / 2;
    const ry = h / 2;
    const r = clamp(radius, 0.1, Math.min(rx, ry) - 0.1);
    const corners = [[rx - r, ry - r], [-rx + r, ry - r], [-rx + r, -ry + r], [rx - r, -ry + r]];
    const points = [];
    for (let corner = 0; corner < 4; corner++) {
      for (let step = 0; step <= 8; step++) {
        const angle = (corner + step / 8) * Math.PI / 2;
        points.push([dx + corners[corner][0] + Math.cos(angle) * r, dy + corners[corner][1] + Math.sin(angle) * r, z]);
      }
    }
    return points;
  }

  function circle(x, y, r, z, count = 52) {
    return Array.from({ length: count }, (_, i) => {
      const angle = i * TAU / count;
      return [x + Math.cos(angle) * r, y + Math.sin(angle) * r, z];
    });
  }

  function closedPath(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
  }

  function draw(canvas, state = {}) {
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return;
    const cssWidth = bounds.width;
    const cssHeight = bounds.height;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(cssWidth * ratio);
    const pixelHeight = Math.round(cssHeight * ratio);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(pixelWidth / cssWidth, 0, 0, pixelHeight / cssHeight, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const w = number(state.width, 140, 100, 190);
    const h = number(state.height, 110, 80, 150);
    const d = number(state.depth, 76, 50, 115);
    const requestedRadius = number(state.radius, 22, 6, 32);
    const variant = state.variant ?? 'box';
    const material = state.material ?? 'metal';
    const radius = variant === 'capsule' ? Math.min(w, h) * 0.46 : requestedRadius;
    const lightLevel = number(state.light, 67, 10, 100) / 100;
    const yaw = number(state.rotation, -24, -3600, 3600) * radians;
    const pitch = -number(state.tilt, -14, -70, 70) * radians;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const shell = parseColor(state.color);
    let scale = Math.min(cssWidth / 250, cssHeight / 174);
    const cx = cssWidth * 0.5;
    const screenY = cssHeight * 0.487;
    const cameraDistance = 575;
    const key = unit([-0.48, 0.82, 0.82]);
    const fill = unit([0.85, 0.1, 0.5]);

    function transform([x, y, z]) {
      if (variant === 'slope') {
        x *= 1 - 0.14 * (y / h + 0.5);
        z -= y * 0.22;
      }
      const tx = x * cy + z * sy;
      const tz = z * cy - x * sy;
      return [tx, y * cp - tz * sp, y * sp + tz * cp];
    }

    function projectCamera([x, y, z]) {
      const magnification = scale * cameraDistance / (cameraDistance - z);
      return [cx + x * magnification, screenY - y * magnification];
    }

    const project = point => projectCamera(transform(point));

    function paintShadow() {
      const floor = project([0, -h / 2 - 2, 0]);
      const sx = Math.max(w * 0.55, 57) * scale;
      const sy = (12 + Math.abs(Math.sin(pitch)) * d * 0.31) * scale;
      ctx.save();
      ctx.translate(floor[0] + sx * 0.12, floor[1] + sy * 0.08);
      ctx.scale(sx * 1.35, sy);
      const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      shadow.addColorStop(0, 'rgba(32,42,63,0.30)');
      shadow.addColorStop(0.44, 'rgba(38,51,73,0.18)');
      shadow.addColorStop(0.8, 'rgba(47,60,82,0.055)');
      shadow.addColorStop(1, 'rgba(47,60,82,0)');
      ctx.fillStyle = shadow;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    const faces = [];
    function addFace(worldPoints, base, finish = 'plain', shadeBias = 0) {
      const points = worldPoints.map(transform);
      const normal = unit(cross(subtract(points[1], points[0]), subtract(points[2], points[0])));
      const center = points.reduce((sum, [x, y, z]) => [sum[0] + x, sum[1] + y, sum[2] + z], [0, 0, 0]).map(x => x / points.length);
      if (dot(normal, [-center[0], -center[1], cameraDistance - center[2]]) <= 0.002) return;
      faces.push({ normal, z: center[2], points: points.map(projectCamera), base, finish, shadeBias });
    }

    function bridge(rings, base, finish, shadeBias) {
      for (let layer = 0; layer < rings.length - 1; layer++) {
        const back = rings[layer], front = rings[layer + 1];
        for (let i = 0; i < back.length; i++) {
          const j = (i + 1) % back.length;
          addFace([back[i], back[j], front[j], front[i]], base, finish, shadeBias);
        }
      }
    }

    const bevel = material === 'plastic' ? 7.5 : 5.5;
    const edge = (z, inset) => profile(w - inset * 2, h - inset * 2, radius - inset, z);
    const rear = -d / 2;
    const front = d / 2;
    const rings = [
      edge(rear, bevel),
      edge(rear + bevel * 0.26, bevel * 0.34),
      edge(rear + bevel * 0.68, bevel * 0.08),
      edge(rear + bevel, 0),
      edge(front - bevel, 0),
      edge(front - bevel * 0.68, bevel * 0.08),
      edge(front - bevel * 0.26, bevel * 0.34),
      edge(front, bevel),
    ];

    // Large forms and steep camera angles can extend beyond the base scale.
    // Use their perspective bounds to keep the whole enclosure in the stage.
    let maxProjectedX = 0;
    let maxProjectedY = 0;
    for (const point of rings.flat()) {
      const [x, y, z] = transform(point);
      const perspective = cameraDistance / (cameraDistance - z);
      maxProjectedX = Math.max(maxProjectedX, Math.abs(x * perspective));
      maxProjectedY = Math.max(maxProjectedY, Math.abs(y * perspective));
    }
    scale = Math.min(
      scale,
      cssWidth * 0.445 / (maxProjectedX + 4),
      (Math.min(screenY, cssHeight - screenY) - cssHeight * 0.055) / (maxProjectedY + 5),
    );
    bridge(rings, shell, material);
    addFace(rings[0].slice().reverse(), shell, material, -0.07);
    addFace(rings[rings.length - 1], shell, material, 0.03);

    function lighting(normal, type, bias) {
      const diffuse = Math.max(0, dot(normal, key));
      const bounce = Math.max(0, dot(normal, fill));
      const specularAxis = unit([key[0], key[1], key[2] + 1]);
      const specular = Math.pow(Math.max(0, dot(normal, specularAxis)), type === 'metal' ? 7 : 16);
      const specularWeight = type === 'metal' ? 28 : type === 'plastic' ? 12 : 4;
      return [0.46 + lightLevel * 0.30 + diffuse * (0.31 + lightLevel * 0.32) + bounce * 0.13 + bias, specular * specularWeight * lightLevel];
    }

    function paintFace(face) {
      const [exposure, lift] = lighting(face.normal, face.finish, face.shadeBias);
      const points = face.points;
      const plain = tint(face.base, exposure, lift);
      let finish = plain;
      if (face.finish !== 'plain') {
        const xs = points.map(p => p[0]);
        const ys = points.map(p => p[1]);
        const lo = Math.min(...ys), hi = Math.max(...ys);
        if (hi - lo > 24) {
          const left = Math.min(...xs), right = Math.max(...xs);
          const gradient = ctx.createLinearGradient(left, lo, right, hi);
          gradient.addColorStop(0, tint(face.base, exposure * 1.12, lift + (face.finish === 'metal' ? 13 : 7)));
          gradient.addColorStop(0.44, plain);
          gradient.addColorStop(1, tint(face.base, exposure * 0.88, lift));
          finish = gradient;
        }
      }
      closedPath(ctx, points);
      ctx.fillStyle = finish;
      ctx.fill();
      ctx.strokeStyle = finish;
      ctx.lineJoin = 'round';
      ctx.lineWidth = 0.54;
      ctx.stroke();
    }

    paintShadow();
    faces.sort((a, b) => a.z - b.z);
    faces.forEach(paintFace);

    // The front plate, perforations, and knob are modeled on the front plane.
    // Project their paths separately so yaw and pitch affect their silhouettes.
    const faceNormal = unit(cross(subtract(transform([1, 0, front]), transform([0, 0, front])), subtract(transform([0, 1, front]), transform([0, 0, front]))));
    const frontCenter = transform([0, 0, front]);
    const viewNormal = unit([-frontCenter[0], -frontCenter[1], cameraDistance - frontCenter[2]]);
    const frontVisibility = dot(faceNormal, viewNormal);
    if (frontVisibility > 0.025) {
      const plateWidth = w * (variant === 'capsule' ? 0.75 : 0.85);
      const plateHeight = h * 0.65;
      const panelY = h * 0.093;
      const plateRadius = variant === 'capsule' ? Math.min(plateWidth, plateHeight) * 0.44 : clamp(radius * 0.70, 5, plateHeight * 0.43);
      const edgeZ = front + 0.6;
      const grilleZ = front + 1.4;
      const outline = profile(plateWidth + 1.2, plateHeight + 1.2, plateRadius + 0.6, edgeZ, 0, panelY).map(project);
      closedPath(ctx, outline);
      ctx.fillStyle = tint(shell, 0.62, 7);
      ctx.fill();
      ctx.strokeStyle = 'rgba(26,32,40,0.39)';
      ctx.lineWidth = 0.9;
      ctx.stroke();
      const perforated = profile(plateWidth - 2.8, plateHeight - 2.8, plateRadius - 1.4, grilleZ, 0, panelY).map(project);
      closedPath(ctx, perforated);
      const t = project([0, panelY + plateHeight / 2, grilleZ]), b = project([0, panelY - plateHeight / 2, grilleZ]);
      const gradient = ctx.createLinearGradient(t[0], t[1], b[0], b[1]);
      const grilleBase = material === 'fabric' ? [70, 78, 85] : material === 'plastic' ? [33, 39, 46] : [37, 43, 48];
      gradient.addColorStop(0, tint(grilleBase, 0.95 + lightLevel * 0.46, 3));
      gradient.addColorStop(0.48, tint(grilleBase, 0.93 + lightLevel * 0.18, 1));
      gradient.addColorStop(1, tint(grilleBase, 0.72 + lightLevel * 0.18));
      ctx.fillStyle = gradient;
      ctx.fill();
      ctx.save();
      ctx.clip();

      if (frontVisibility > 0.14) {
        const step = material === 'fabric' ? 2.1 : 3.5;
        const radius = material === 'fabric' ? 0.41 : 0.66;
        const axisA = project([0, panelY, grilleZ]);
        const axisB = project([radius, panelY, grilleZ]);
        const axisC = project([0, panelY + radius, grilleZ]);
        const rx = Math.max(0.28, Math.hypot(axisB[0] - axisA[0], axisB[1] - axisA[1]));
        const ry = Math.max(0.28, Math.hypot(axisC[0] - axisA[0], axisC[1] - axisA[1]));
        const angle = Math.atan2(axisB[1] - axisA[1], axisB[0] - axisA[0]);
        ctx.beginPath();
        for (let row = 0, y = panelY - plateHeight / 2; y <= panelY + plateHeight / 2; y += step, row++) {
          for (let x = -plateWidth / 2 + (row % 2) * step * 0.5; x < plateWidth / 2; x += step) {
            const pt = project([x, y, grilleZ]);
            ctx.moveTo(pt[0] + rx * Math.cos(angle), pt[1] + rx * Math.sin(angle));
            ctx.ellipse(pt[0], pt[1], rx, ry, angle, 0, TAU);
          }
        }
        ctx.fillStyle = material === 'fabric' ? 'rgba(235,238,238,0.26)' : 'rgba(5,9,14,0.78)';
        ctx.fill();
      }
      ctx.restore();
      closedPath(ctx, perforated);
      ctx.strokeStyle = 'rgba(224,234,244,0.20)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const bx = number(state.buttonX, 0.25, -0.32, 0.32) * w;
      const by = -number(state.buttonY, 0.34, -0.35, 0.35) * h;
      const knobRadius = clamp(Math.min(w, h) * 0.061, 4.5, 8.5);
      const knobStart = front + 1.6;
      const knobEnd = front + 5.4;
      const beforeKnob = faces.length;
      const knobOuter = circle(bx, by, knobRadius + 1, knobStart);
      addFace(knobOuter, [48, 56, 60], 'metal');
      const knobBase = circle(bx, by, knobRadius, knobStart + 0.1);
      const knobFace = circle(bx, by, knobRadius - 0.55, knobEnd);
      bridge([knobBase, knobFace], [158, 168, 173], 'metal', -0.15);
      addFace(knobFace, [197, 207, 209], 'metal');
      faces.slice(beforeKnob).sort((a, b) => a.z - b.z).forEach(paintFace);

      const mark = [
        project([bx + knobRadius * 0.48, by + knobRadius * 0.34, knobEnd + 0.02]),
        project([bx + knobRadius * 0.73, by + knobRadius * 0.51, knobEnd + 0.02]),
      ];
      ctx.beginPath();
      ctx.moveTo(...mark[0]);
      ctx.lineTo(...mark[1]);
      ctx.lineCap = 'round';
      ctx.lineWidth = clamp(scale * 0.5, 0.8, 2);
      ctx.strokeStyle = 'rgba(17,26,35,0.68)';
      ctx.stroke();
      const indicator = circle(bx - knobRadius * 2.25, by, 1.5, front + 1.8, 18).map(project);
      closedPath(ctx, indicator);
      ctx.fillStyle = '#a4efce';
      ctx.fill();
    } else if (frontVisibility < -0.25) {
      // The rear jack plate is rendered only when its surface is visible.
      const port = profile(w * 0.29, h * 0.24, 3, rear - 0.4, 0, -h * 0.22).map(project);
      closedPath(ctx, port);
      ctx.fillStyle = '#242c35';
      ctx.fill();
      for (let i = -1; i <= 1; i += 2) {
        closedPath(ctx, circle(i * w * 0.065, -h * 0.22, 3.1, rear - 0.6, 26).map(project));
        ctx.fillStyle = '#10141a';
        ctx.fill();
        ctx.strokeStyle = 'rgba(229,233,239,0.28)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
  }

  window.WuyingRenderer = { draw };
})();


