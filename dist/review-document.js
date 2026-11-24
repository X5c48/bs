export async function openDocument(project,store){
  const data=(await store.read()).reviewDocument;
  document.title=project.name+' · 物映';
  const make=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node};
  const sheet=make('main');sheet.className='review-document';
  const back=make('a','← 我的文件');back.href='files.html';
  if(project.fileType!=='review-document'){back.textContent='← 返回工作台';back.href='workbench.html?project='+encodeURIComponent(project.id);}
  sheet.append(back,make('h1',data.title||project.name),make('p',data.steps.length+' 个步骤 · '+data.steps.filter(s=>s.mediaId).length+' 张截图 · '+data.status));
  const jump=make('select');jump.setAttribute('aria-label','定位步骤');sheet.append(jump);
  jump.onchange=()=>document.getElementById('step-'+jump.value)?.scrollIntoView();
  document.body.replaceChildren(sheet);
  const urls=[];
  const images=new IntersectionObserver(entries=>{
    for(const {isIntersecting,target} of entries) if(isIntersecting){
      images.unobserve(target);
      store.getBlob(target.dataset.media).then(blob=>{
        if(!blob)throw Error();const url=URL.createObjectURL(blob);urls.push(url);target.src=url;
      }).catch(()=>{target.alt='截图读取失败，请刷新重试。'});
    }
  },{rootMargin:'600px'});
  window.addEventListener('pagehide',e=>{if(!e.persisted){images.disconnect();urls.forEach(url=>URL.revokeObjectURL(url));}},{once:true});
  const fields=[['title','步骤名称'],['time','时间（上海时间）'],['input','输入'],['action','执行操作'],['result','实际返回'],['decision','判断']];
  let dirty=0;
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  data.steps.forEach((step,index)=>{
    const section=make('section'),heading=make('h2'),edit=make('button','编辑本步'),content=make('div'),msg=make('p');
    section.id='step-'+(index+1);msg.setAttribute('role','status');
    const option=make('option');option.value=index+1;jump.append(option);
    function preview(){
      heading.textContent=(index+1)+'. '+step.title;option.textContent=heading.textContent;
      content.replaceChildren();
      for(const [key,label] of fields.slice(1)){content.append(make('h3',label),make('pre',step[key]));}
      content.append(make('small',step.ok?'通过':'未通过'));edit.hidden=false;
    }
    section.append(heading,edit,content,msg);preview();
    if(step.mediaId){const img=make('img');img.alt='第 '+(index+1)+' 步现场截图';img.dataset.media=step.mediaId;section.append(img);images.observe(img);}
    edit.onclick=()=>{
      dirty++;edit.hidden=true;msg.textContent='';content.replaceChildren();
      const inputs={},base={...step};
      for(const [key,label] of fields){const wrap=make('label',label),input=make('textarea');input.value=step[key];input.rows=key==='result'?8:key==='title'||key==='time'?1:3;wrap.append(input);content.append(wrap);inputs[key]=input;}
      const passed=make('input');passed.type='checkbox';passed.checked=step.ok;const checked=make('label','步骤通过');checked.prepend(passed);content.append(checked);
      const save=make('button','保存修改'),cancel=make('button','取消');content.append(save,cancel);inputs.title.focus();
      cancel.onclick=()=>{dirty--;preview();msg.textContent='已取消。';};
      save.onclick=async()=>{
        save.disabled=cancel.disabled=true;
        const changes={ok:passed.checked};for(const [key] of fields)changes[key]=inputs[key].value;
        try{await store.change(doc=>{
          const current=doc.reviewDocument.steps[index];
          if(Object.keys(changes).some(k=>current[k]!==base[k]))throw Error('这一步已在其他窗口修改，请刷新后重新编辑。');
          Object.assign(current,changes);
        });Object.assign(step,changes);dirty--;preview();msg.textContent='已保存。';}
        catch(e){msg.textContent=e.message;save.disabled=cancel.disabled=false;}
      };
    };
    sheet.append(section);
  });
}
