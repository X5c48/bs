(() => {
  'use strict';

  const workbench = window.WuyingWorkbench;
  if (!workbench) return;
  const $ = id => document.getElementById(id);
  const shell = document.querySelector('.app-shell');

  const panel=document.querySelector('.vizcom-panel'), rail=$('flowRenderRail');
  const home=$('panel-generate'), wide=matchMedia('(min-width: 1180px)');
  const openPanel=$('flowOpenRenderPanel');
  const qualityButtons=[...document.querySelectorAll('[data-vp-quality]')];
  let quality='fast';
  function placePanel(){
    const render=shell.dataset.panel==='generate'&&workbench.graph.paired();
    const docked=render&&wide.matches;
    rail.hidden=!docked;
    openPanel.hidden=!render||docked;
    if(docked&&panel.parentElement!==rail)rail.append(panel);
    else if(!docked&&panel.parentElement!==home)home.prepend(panel);
    const api=workbench.live.apiMode();
    for(const button of qualityButtons){
      button.disabled=api&&button.dataset.vpQuality==='fast';
      button.setAttribute('aria-pressed',String(button.dataset.vpQuality===(api?'pro':quality)));
    }
  }
  wide.addEventListener('change',schedule);
  openPanel.onclick=()=>$('toggleTools').click();
  function generate(quick=false){
    workbench.studio.selectResult(null);
    workbench.live.renderFinal({force:true,quick});
  }
  const tabs = [...document.querySelectorAll('.vp-tab')];
  const panes = [...document.querySelectorAll('.vp-mode')];
  const verbTemplates = {
    '改色': '把主体改成磨砂金属，颜色换成',
    '改形': '把底座的圆角改得更锐利，整体比例更修长',
    '去除': '去掉旋钮上方的凸起',
    '添加': '在侧面添加一圈散热格栅',
    '想象': '想象一种更轻盈、更现代的造型语言'
  };
  const verbs = [...document.querySelectorAll('[data-vp-verb]')];
  const modifyText = $('vpModifyText'), promptText = $('vpPromptText');
  const resultGrid = $('vpResultGrid'), resultCount = $('vpResultCount');
  const angleChips = [...document.querySelectorAll('[data-vp-angle]')];
  let resultKey = null, currentAngle = 0, frame = 0;

  function setMode(mode) {
    for (const tab of tabs) {
      const selected=tab.dataset.vpMode===mode;
      tab.setAttribute('aria-selected',String(selected));
      tab.tabIndex=selected?0:-1;
    }
    for (const pane of panes) pane.hidden = pane.dataset.vpPane !== mode;
  }
  tabs.forEach(tab => tab.addEventListener('click', () => setMode(tab.dataset.vpMode)));
  tabs[0].parentElement.addEventListener('keydown',event=>{
    const index=tabs.indexOf(event.target);
    if(index<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:
      (index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    setMode(tabs[next].dataset.vpMode);tabs[next].focus();event.preventDefault();
  });
  setMode('modify');

  verbs.forEach(verb => verb.addEventListener('click', () => {
    const template = verbTemplates[verb.dataset.vpVerb];
    modifyText.value = template;
    modifyText.focus();
    modifyText.setSelectionRange(template.length, template.length);
  }));

  function applyPrompt(text) {
    const prompt = $('renderPrompt');
    if (prompt) {
      prompt.value = text;
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  $('vpApplyModify').addEventListener('click', () => {
    const value = modifyText.value.trim();
    if (!value) { workbench.toast('先写一句修改描述'); return; }
    applyPrompt(value);
    workbench.toast('已填入渲染提示');
  });
  $('vpApplyPrompt').addEventListener('click', () => {
    const value = promptText.value.trim();
    applyPrompt(value);
    generate(quality==='fast');
  });
  for(const button of qualityButtons)button.onclick=()=>{
    quality=button.dataset.vpQuality;
    placePanel();
  };

  function ensureModel() {
    if (workbench.model?.hasModel?.()) return;
    workbench.model?.ensure?.();
  }
  $('vpNewView').addEventListener('click', () => {
    if (workbench.model?.hasModel?.()) {
      currentAngle = (currentAngle + 45) % 360;
      workbench.model.rotate(45);
      syncAngles();
      workbench.toast('新视角 · 顺时针旋转 45°');
    } else {
      ensureModel();
      workbench.toast('已打开 3D 体块 · 可切换视角');
    }
  });
  $('vpVariate').addEventListener('click', () => {
    if (!workbench.graph?.paired?.()) { ensureModel(); }
    workbench.setPanel('iterate');
  });
  $('vpGenerate').addEventListener('click', () => generate());

  function syncAngles() {
    const pressed = angleChips.find(chip => Number(chip.dataset.vpAngle) === currentAngle);
    for (const chip of angleChips) chip.setAttribute('aria-pressed', String(chip === pressed));
  }
  angleChips.forEach(chip => chip.addEventListener('click', () => {
    ensureModel();
    currentAngle = Number(chip.dataset.vpAngle);
    workbench.model?.rotateTo?.(currentAngle);
    syncAngles();
    workbench.toast('视角 ' + currentAngle + '°');
  }));

  function slot(result) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vp-slot';
    if (result) {
      button.dataset.vpResult = result.id;
      button.title = '效果 · ' + new Date(result.created).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      button.setAttribute('aria-label', button.title);
      const image = new Image();
      image.src = result.src;
      image.alt = '';
      image.draggable = false;
      button.append(image);
    } else {
      button.disabled = true;
      button.textContent = '—';
    }
    return button;
  }

  function syncResults() {
    frame = 0;
    placePanel();
    const node = workbench.graph?.activePreview?.();
    const entries = node ? (workbench.live?.results?.(node.id) || []) : [];
    const picked = workbench.studio?.selectedResult?.();
    const key = entries.map(entry => entry.id).join('|');
    if (key !== resultKey) {
      resultKey = key;
      const buttons = [];
      for (let index = 0; index < 4; index++) buttons.push(slot(entries[index] || null));
      resultGrid.replaceChildren(...buttons);
    }
    for (const button of resultGrid.querySelectorAll('[data-vp-result]')) {
      button.setAttribute('aria-pressed', String(!!picked && button.dataset.vpResult === picked));
    }
    resultCount.textContent = Math.min(entries.length, 4) + '/4';
  }
  resultGrid.addEventListener('click', event => {
    const button = event.target.closest('[data-vp-result]');
    if (!button) return;
    const id = button.dataset.vpResult;
    workbench.studio?.selectResult?.(workbench.studio.selectedResult?.() === id ? null : id);
    schedule();
  });

  function schedule() { if (!frame) frame = requestAnimationFrame(syncResults); }
  for (const event of ['wuyinglivechange', 'graphchange', 'boardscenechange', 'sketchstatechange', 'wuyingresultchange']) window.addEventListener(event, schedule);
  syncAngles();
  syncResults();
})();
