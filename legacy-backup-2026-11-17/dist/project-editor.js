(() => {
  'use strict';

  const workbench = window.WuyingWorkbench;
  const id = workbench?.projectId;
  if (!id) return;

  const {board, graph, studio, live} = workbench;
  const projects = window.WuyingProjects;
  const rules = window.WuyingSketchRules;
  const core = window.WuyingStudioCore;
  const $ = id => document.getElementById(id);
  const shell = document.querySelector('.app-shell');
  const url = new URL(location.href);
  const query = '?project=' + encodeURIComponent(id);
  let project = projects.get(id);
  let opening = false;

  function save(patch) {
    project = projects.update(id, patch);
    return project;
  }

  shell.dataset.project = 'active';
  document.title = project.name + ' · 物映';
  $('projectHomeLink').hidden = false;
  $('projectBoardLink').href = 'image-board.html' + query;
  $('projectBoardLink').hidden = false;
  $('projectBriefLink').href = 'concept.html' + query;
  $('projectBriefLink').hidden = false;
  document.querySelector('.brand span').textContent = project.name;
  $('projectMobileViews').hidden = false;

  function setMobileView(view) {
    shell.dataset.projectView = view;
    for (const button of $('projectMobileViews').querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.projectView === view));
    }
  }
  setMobileView('sketch');
  $('projectMobileViews').addEventListener('click', event => {
    const button = event.target.closest('button[data-project-view]');
    if (button) setMobileView(button.dataset.projectView);
  });
  $('tab-generate').addEventListener('click', () => setMobileView('effect'));
  $('flowNextRender').addEventListener('click', () => setMobileView('effect'));
  $('tab-iterate').addEventListener('click', () => setMobileView('effect'));
  $('flowNextIterate').addEventListener('click', () => setMobileView('effect'));
  $('tab-derive').addEventListener('click', () => setMobileView('sketch'));
  $('addModelNode').addEventListener('click', () => setMobileView('effect'));

  const directionId = url.searchParams.get('adopt');
  const requestedDraft = url.searchParams.get('draft');
  const take = url.searchParams.get('take');
  let draftId = requestedDraft || project.activeDraftId;
  if (directionId) {
    try {
      const index = project.directions.findIndex(item => item.id === directionId);
      if (index < 0) throw new Error('找不到这条方向，请返回简报选择。');
      const direction = window.WuyingConceptGeometry.validate({directions: project.directions}, rules)[index];
      const draft = board.addConceptDraft(direction, take || directionId);
      if (!draft) throw new Error('未能保存草稿，请检查浏览器存储空间。');
      draftId = draft.id;
      const adopted = project.adopted.some(item => item.draftId === draftId)
        ? project.adopted
        : [...project.adopted, {draftId, directionId, name:direction.name, shape:direction.shape, createdAt:Date.now()}];
      save({desk:'editor', activeDraftId:draftId, editorPanel:'derive', adopted});
      url.searchParams.delete('adopt');
      url.searchParams.delete('take');
      url.searchParams.delete('draft');
      history.replaceState(null, '', url);
    } catch (error) {
      workbench.toast(error.message);
      if (!draftId) {
        location.replace('concept.html' + query);
        return;
      }
    }
  }

  if (draftId) board.openCurve(draftId);
  if (!board.sceneState().id) board.addBlank();
  const openedId = board.sceneState().id;
  if (openedId) graph.connectSketch(openedId);
  const desiredPanel = url.searchParams.get('stage') || project.editorPanel;
  const editorPanels = ['derive','generate','iterate'];
  const panel = editorPanels.includes(desiredPanel) ? desiredPanel : 'derive';
  workbench.setPanel(panel);
  setMobileView(panel === 'derive' ? 'sketch' : 'effect');

  let lastKey = '';
  function rememberDesk() {
    const scene = board.sceneState();
    const currentPanel = shell.dataset.panel;
    if (!scene.id || !editorPanels.includes(currentPanel)) return;
    const key = scene.id + '/' + currentPanel;
    if (key === lastKey) return;
    try {
      save({desk:'editor', activeDraftId:scene.id, editorPanel:currentPanel});
      lastKey = key;
    } catch (error) { workbench.toast(error.message); }
  }
  window.addEventListener('sketchstatechange', rememberDesk);
  window.addEventListener('boardscenechange', rememberDesk);
  rememberDesk();
  if (url.searchParams.has('draft') || url.searchParams.has('stage')) {
    url.searchParams.delete('draft');
    url.searchParams.delete('stage');
    history.replaceState(null,'',url);
  }

  workbench.openPresentation = async ({palette=false} = {}) => {
    if (opening) return;
    const scene = board.sceneState({drafts:false});
    if (!scene.id) {
      workbench.toast('请先选择一份草稿。');
      return;
    }
    opening = true;
    let slot;
    try {
      const old = projects.get(id)?.presentation;
      const linked = graph.linkedDocumentId() === scene.id;
      const result = !palette && linked
        ? live.results(graph.activePreview()?.id).find(item => item.id === studio.selectedResult() && item.draftId === scene.id)
        : null;
      const localEffect = palette && (scene.curve || scene.ink.length || scene.underlay)
        ? new Blob([core.renderSvg(scene,rules,{...palette,id:'presentation-material',ratio:1.25,useInkColors:false})],{type:'image/svg+xml;charset=utf-8'})
        : null;
      if (result || localEffect) {
        slot = crypto.randomUUID();
        await projects.savePresentation(id,result?.blob || localEffect,slot);
        save({presentation:{
          draftId:scene.id, resultId:result?.id || null, slot,
          sourceStamp:result ? result.sourceStamp : board.controlSource(scene.id).stamp,
          label:result ? '渲染效果' : '配色预览'
        }});
        if (old?.slot) projects.deletePresentation(id,old.slot).catch(() => {});
      }
      location.assign('presentation.html' + query + '&draft=' + encodeURIComponent(scene.id));
    } catch (error) {
      if (slot) projects.deletePresentation(id,slot).catch(() => {});
      workbench.toast(error.message || '无法保存展示效果。');
    } finally {
      opening = false;
    }
  };
})();
