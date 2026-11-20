(() => {
  'use strict';

  const store = window.WuyingProjects;
  const rules = window.WuyingSketchRules;
  const $ = id => document.getElementById(id);
  const form = $('new-project-form');
  const toggle = $('new-project-toggle');
  const nameInput = $('project-name');
  const list = $('project-list');

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function status(message, error = false) {
    const node = $('project-status');
    node.textContent = message;
    node.classList.toggle('is-error', error);
    node.hidden = !message;
  }

  function showForm(open, focus = true) {
    form.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (focus) (open ? nameInput : toggle).focus();
  }

  function projectHref(project) {
    const page = project.desk === 'editor' ? 'image-board.html' : 'concept.html';
    return page + '?project=' + encodeURIComponent(project.id);
  }

  function firstShape(project) {
    for (const item of [...project.adopted, ...project.directions]) {
      const direction = typeof item === 'string'
        ? project.directions.find(candidate => candidate.id === item)
        : item.direction || item;
      if (direction?.shape) return direction.shape;
    }
    return null;
  }

  function cover(project) {
    const node = element('div', 'project-cover');
    node.setAttribute('aria-hidden', 'true');
    const shape = firstShape(project);
    const pathData = shape && rules?.pathData(shape);
    if (pathData) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 800 640');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', pathData);
      svg.append(path);
      node.append(svg);
    } else {
      node.classList.add('project-cover-empty');
      node.append(element('span', '', project.desk === 'editor' ? '草图工作台' : '概念简报'));
    }
    return node;
  }

  function formatDate(time) {
    const date = new Date(time);
    return Number.isFinite(date.valueOf())
      ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(date)
      : '';
  }

  function createProjectCard(project) {
    const article = element('article', 'project-item');
    const open = element('a', 'project-link');
    open.href = projectHref(project);
    open.append(cover(project), element('h3', '', project.name));
    const steps = {derive:'草图',generate:'渲染',iterate:'推演'};
    const stage = project.desk === 'editor' ? (steps[project.editorPanel] || steps.derive)
      : project.directions.length ? '方向比较' : '简报';
    const details = [stage, formatDate(project.updatedAt)].filter(Boolean).join(' · ');
    open.append(element('p', 'project-meta', details));

    const renameButton = element('button', 'text-button project-rename', '重命名');
    renameButton.type = 'button';
    renameButton.setAttribute('aria-label', '重命名 ' + project.name);
    const rename = element('form', 'project-rename-form');
    rename.hidden = true;
    const input = element('input');
    input.type = 'text';
    input.maxLength = 80;
    input.required = true;
    input.setAttribute('aria-label', '新项目名称');
    input.value = project.name;
    const save = element('button', 'secondary-button', '保存');
    save.type = 'submit';
    const cancel = element('button', 'plain-button', '取消');
    cancel.type = 'button';
    rename.append(input, save, cancel);
    renameButton.onclick = () => {
      rename.hidden = false;
      renameButton.hidden = true;
      input.focus();
      input.select();
    };
    cancel.onclick = () => {
      input.value = project.name;
      rename.hidden = true;
      renameButton.hidden = false;
      renameButton.focus();
    };
    rename.onsubmit = event => {
      event.preventDefault();
      const name = input.value.trim();
      if (!name) {
        status('请输入项目名称。', true);
        input.focus();
        return;
      }
      try {
        if (!store.rename(project.id, name)) throw new Error('未找到项目');
        render();
        status('已重命名为“' + name + '”。');
        [...list.querySelectorAll('.project-link')].find(link => link.href === open.href)?.focus();
      } catch {
        status('暂时无法保存项目名称。', true);
      }
    };
    article.append(open, renameButton, rename);
    return article;
  }

  function render() {
    const projects = store.list();
    $('project-empty').hidden = projects.length > 0;
    $('project-section').hidden = projects.length === 0;
    $('project-count').textContent = projects.length + ' 个项目';
    list.replaceChildren(...projects.map(createProjectCard));
  }

  if (!store) {
    toggle.disabled = true;
    status('项目功能未加载。刷新页面后重试。', true);
    return;
  }
  toggle.onclick = () => showForm(form.hidden);
  $('empty-create').onclick = () => showForm(true);
  $('new-project-cancel').onclick = () => showForm(false);
  form.onkeydown = event => {
    if (event.key === 'Escape') showForm(false);
  };
  form.onsubmit = event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      status('请输入项目名称。', true);
      nameInput.focus();
      return;
    }
    try {
      const project = store.create(name);
      if (!project?.id) throw new Error('未创建项目');
      location.assign(projectHref(project));
    } catch {
      status('暂时无法创建项目。请检查浏览器是否允许本地存储。', true);
    }
  };
  try {
    render();
  } catch {
    status('暂时无法读取项目。', true);
  }
})();
