(() => {
  'use strict';

  const button=document.getElementById('recordLive');
  const output=document.getElementById('studioVisual');
  const workbench=window.WuyingWorkbench, board=workbench?.board;
  const mime=['video/webm;codecs=vp8','video/webm'].find(type=>window.MediaRecorder?.isTypeSupported(type));
  if(!button||!output||!board||!mime||!HTMLCanvasElement.prototype.captureStream)return;
  button.hidden=false;
  let current=null;

  function fit(context,image,x,y,width,height){
    if(!image)return;
    const scale=Math.min(width/image.naturalWidth,height/image.naturalHeight);
    const w=image.naturalWidth*scale,h=image.naturalHeight*scale;
    context.drawImage(image,x+(width-w)/2,y+(height-h)/2,w,h);
  }

  async function decode(blob){
    const url=URL.createObjectURL(blob);
    try{
      const image=new Image();
      image.src=url;
      await image.decode();
      return image;
    }finally{URL.revokeObjectURL(url);}
  }

  async function readOutput(){
    const image=output.querySelector('img');
    if(image?.complete&&image.naturalWidth)return image;
    const svg=output.querySelector('svg');
    return svg?decode(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'})):null;
  }

  async function paint(take){
    const context=take.context, scene=board.sceneState();
    const ai=output.dataset.kind==='ai';
    const [left,right]=await Promise.allSettled([
      board.captureFrame(scene,{color:true,width:720,height:512}).then(decode),readOutput()
    ]);
    if(take.stopping||current!==take)return;
    if(left.status==='fulfilled')take.left=left.value;
    if(right.status==='fulfilled'&&right.value){
      take.right=right.value;
      take.ai=ai;
    }
    context.fillStyle='#1b201c';context.fillRect(0,0,1440,576);
    context.fillStyle='#e7eddf';context.font='22px "Microsoft YaHei", sans-serif';
    context.fillText('01  草图',20,34);
    context.fillText(take.ai?'02  AI 渲染':'02  本地造型预览',732,34);
    context.fillStyle='#f5f3ec';context.fillRect(20,49,688,506);
    context.fillStyle='#e5e6dd';context.fillRect(732,49,688,506);
    fit(context,take.left,20,49,688,506);
    fit(context,take.right,732,49,688,506);
  }

  function finish(take){
    if(take.stopping)return;
    take.stopping=true;
    clearTimeout(take.timer);clearTimeout(take.deadline);
    if(take.recorder.state!=='inactive')take.recorder.stop();
    button.disabled=true;
    button.textContent='正在保存';
  }

  function start(){
    const canvas=document.createElement('canvas');
    canvas.width=1440;canvas.height=576;
    const stream=canvas.captureStream(8);
    let recorder;
    try{recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:2500000});}
    catch{
      for(const track of stream.getTracks())track.stop();
      workbench.toast('当前浏览器无法录制预览');return;
    }
    const take={recorder,stream,context:canvas.getContext('2d'),chunks:[]};
    current=take;
    take.context.fillStyle='#1b201c';take.context.fillRect(0,0,1440,576);
    recorder.ondataavailable=event=>{if(event.data.size)take.chunks.push(event.data);};
    recorder.onerror=()=>{take.failed=true;finish(take);};
    recorder.onstop=()=>{
      for(const track of stream.getTracks())track.stop();
      clearTimeout(take.timer);clearTimeout(take.deadline);
      current=null;button.disabled=false;
      button.setAttribute('aria-pressed','false');button.textContent='录制过程';
      if(take.failed||!take.chunks.length){workbench.toast('录制没有保存，请重试');return;}
      workbench.download(new Blob(take.chunks,{type:mime}),'物映-草图与渲染过程.webm');
    };
    const loop=async()=>{
      try{await paint(take);}catch{}
      if(current===take&&!take.stopping)take.timer=setTimeout(loop,140);
    };
    try{recorder.start(1000);}
    catch{
      for(const track of stream.getTracks())track.stop();
      current=null;workbench.toast('当前浏览器无法开始录制');return;
    }
    button.setAttribute('aria-pressed','true');button.textContent='停止录制';
    take.deadline=setTimeout(()=>finish(take),60000);
    loop();
  }

  button.onclick=()=>{if(current)finish(current);else start();};
})();
