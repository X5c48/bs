(() => {
  'use strict';
  const flow=window.WuyingWorkflow;

  function node(tag, text, className) {
    const element=document.createElement(tag);
    if(text) element.textContent=text;
    if(className) element.className=className;
    return element;
  }

  function action(text, handler) {
    const button=node('button',text,'variation-action');
    button.type='button';
    button.onclick=handler;
    return button;
  }

  function form(initial, onChange=()=>{}) {
    const root=node('fieldset',null,'variation');
    const preset=node('select');
    preset.setAttribute('aria-label','造型方向预设');
    for(const [key,entry] of Object.entries(flow.formPresets)) preset.add(new Option(entry.label,key));
    const grid=node('div',null,'variation-map');
    const pad=node('div',null,'variation-pad');
    const sides=Array.from({length:4},()=>node('span',null,'variation-edge'));
    const dot=node('span',null,'variation-dot');
    grid.setAttribute('aria-hidden','true');
    pad.append(dot);
    grid.append(sides[0],sides[1],pad,sides[2],sides[3]);

    const ranges={};
    const axes=node('div',null,'variation-axes');
    for(const [key,title] of [['x','横轴'],['y','纵轴']]){
      const label=node('label',null,'variation-axis');
      const summary=node('span');
      const input=node('input');
      input.type='range';input.min='-100';input.max='100';input.step='1';
      input.setAttribute('aria-label',title);
      label.append(summary,input);
      axes.append(label);
      ranges[key]={input,summary};
      input.oninput=()=>{value[key]=Number(input.value);sync();};
      input.onchange=()=>onChange(read());
    }
    let value;
    const read=()=>({...value});
    function sync(){
      const axes=flow.formPresets[value.preset];
      [sides[0].textContent,sides[1].textContent,sides[2].textContent,sides[3].textContent]=[axes.y[1],axes.x[0],axes.x[1],axes.y[0]];
      dot.style.setProperty('--variation-x',(value.x+100)/2+'%');
      dot.style.setProperty('--variation-y',(100-value.y)/2+'%');
      for(const [key,{input,summary}] of Object.entries(ranges)){
        const offset=value[key], direction=offset?axes[key][offset>0?1:0]+' '+Math.abs(offset)+'%':'居中';
        input.value=offset;
        input.setAttribute('aria-valuetext',direction);
        summary.textContent=input.getAttribute('aria-label')+' · '+direction;
      }
    }
    function write(next){
      value=flow.normalizeForm(next);
      preset.value=value.preset;
      sync();
    }
    const reset=action('回到中心',()=>{write({preset:value.preset,x:0,y:0});onChange(read());});
    preset.onchange=()=>{write({preset:preset.value,x:0,y:0});onChange(read());};
    let pointer;
    function move(event){
      const bounds=pad.getBoundingClientRect();
      value=flow.normalizeForm({
        preset:value.preset,
        x:(event.clientX-bounds.left)/bounds.width*200-100,
        y:100-(event.clientY-bounds.top)/bounds.height*200
      });
      sync();
    }
    pad.onpointerdown=event=>{
      if(pointer!==undefined||event.button!==0||root.disabled) return;
      pointer=event.pointerId;
      pad.setPointerCapture(pointer);
      move(event);
    };
    pad.onpointermove=event=>{if(event.pointerId===pointer) move(event);};
    pad.onpointerup=event=>{
      if(event.pointerId!==pointer) return;
      move(event);
      pointer=undefined;
      onChange(read());
    };
    pad.onlostpointercapture=event=>{
      if(event.pointerId!==pointer) return;
      pointer=undefined;
      onChange(read());
    };
    const header=node('div',null,'variation-row');
    header.append(preset,reset);
    root.append(node('legend','造型方向'),header,grid,axes);
    write(initial);
    return {root,read,write,focus:()=>preset.focus()};
  }

  function palette(initial, loadColors, onChange=()=>{}) {
    const root=node('fieldset',null,'variation');
    const tiles=node('div',null,'variation-colors');
    const message=node('p',null,'variation-message');
    message.setAttribute('role','status');
    let colors, revision=0;
    const read=()=>[...colors];
    const notify=()=>{revision++;message.textContent='';onChange(read());};
    const add=action('添加颜色',()=>{
      const defaults=['#546bd9','#e18e55','#355f56','#c55a72','#c5b688','#618bbd','#8559a8','#d2d9dc','#464849','#a6b774'];
      colors.push(defaults.find(color=>!colors.includes(color)));
      render();
      notify();
      tiles.lastElementChild.querySelector('input').focus();
    });
    const extract=action('从图片提取',async()=>{
      const started=++revision;
      extract.disabled=true;
      message.textContent='正在提取主色…';
      try{
        const next=flow.normalizePalette(await loadColors());
        if(!root.isConnected||started!==revision) return;
        if(!next.length) throw new Error('图片中没有可提取的颜色。');
        write(next);
        onChange(read());
        message.textContent='已提取 '+next.length+' 色。';
      } catch(error){
        if(started===revision) message.textContent=error.message;
      } finally {
        extract.disabled=false;
      }
    });
    function render(){
      tiles.replaceChildren();
      colors.forEach((color,index)=>{
        const tile=node('div',null,'variation-color');
        const input=node('input');
        input.type='color';input.value=color;
        input.setAttribute('aria-label','颜色 '+(index+1));
        const code=node('span',color);
        input.oninput=()=>{code.textContent=input.value;};
        input.onchange=()=>{colors[index]=input.value;notify();};
        const remove=action('×',()=>{
          colors.splice(index,1);
          render();
          notify();
          const next=tiles.children[Math.min(index,colors.length-1)];
          (next?.querySelector('input')||add).focus();
        });
        remove.setAttribute('aria-label','移除颜色 '+(index+1));
        tile.append(input,code,remove);
        tiles.append(tile);
      });
      add.disabled=colors.length>=10;
    }
    function write(value){
      revision++;
      colors=flow.normalizePalette(value);
      message.textContent='';
      render();
    }
    const actions=node('div',null,'variation-row variation-palette-actions');
    actions.append(extract,add);
    root.append(node('legend','目标色板'),actions,tiles,message);
    write(initial);
    return {root,read,write,focus:()=>extract.focus()};
  }

  function viewpoint(initial, onChange=()=>{}) {
    const root=node('fieldset',null,'variation');
    const grid=node('div',null,'view-map');
    const extra=node('details',null,'view-extra');
    const secondary=node('div',null,'view-map');
    extra.append(node('summary','俯仰与底面'),secondary);
    const note=node('p',null,'view-count');
    note.setAttribute('role','status');
    const buttons=new Map();
    let selected;
    const read=()=>[...selected];
    for(const [key,preset] of Object.entries(flow.viewPresets)){
      const button=action(preset.label,()=>{
        selected=selected.includes(key)?selected.filter(view=>view!==key):[...selected,key];
        sync();
        onChange(read());
      });
      button.dataset.view=key;
      buttons.set(key,button);
      (preset.secondary?secondary:grid).append(button);
    }
    const anchor=node('span',null,'view-anchor');
    anchor.setAttribute('aria-hidden','true');
    grid.insertBefore(anchor,buttons.get('right'));

    function sync(){
      const full=selected.length>=flow.viewBatchLimit;
      for(const [key,button] of buttons){
        const checked=selected.includes(key);
        button.setAttribute('aria-pressed',String(checked));
        button.disabled=full&&!checked;
      }
      note.textContent=selected.length
        ? '已选 '+selected.length+'/'+flow.viewBatchLimit+' 个角度，每个角度 1 张'
        : '最多选 '+flow.viewBatchLimit+' 个角度';
    }
    function write(value){
      selected=flow.normalizeViews(value);
      if(selected.some(view=>flow.viewPresets[view].secondary)) extra.open=true;
      sync();
    }
    root.append(node('legend','目标视角'),grid,extra,note);
    write(initial);
    return {root,read,write,focus:()=>buttons.get(selected[0]||'front').focus()};
  }

  window.WuyingVariationControls={form,palette,viewpoint};
})();

