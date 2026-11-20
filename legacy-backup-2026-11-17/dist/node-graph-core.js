(function (root, factory) {
  const graph=factory();
  if(typeof module==='object'&&module.exports)module.exports=graph;
  else root.WuyingNodeGraphCore=graph;
})(globalThis,function(){
  'use strict';

  const WIDTH=350, HEIGHT=365, GAP=91, PORT_Y=48;
  const MODES={ai:'AI 渲染',ps:'同步上色',material:'材质',line:'线稿',shape:'造型'};
  const slotOf=type=>type==='text'?'text':type==='sketch'||type==='image'?'visual':null;
  const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(value);
  const clampPosition=value=>Math.min(30000,Math.max(-30000,value));
  const findSketch=(graph,doc)=>graph.nodes.find(node=>node.type==='sketch'&&node.documentId===doc);
  const previewNode=(graph,id)=>graph.nodes.find(node=>node.type==='preview'&&node.id===id);

  function createGraph(doc){
    const preview={id:'preview-1',type:'preview',x:WIDTH+GAP,y:0,mode:'ai',variant:0,auto:true};
    const graph={version:2,nodes:[preview],links:[],activePreview:preview.id};
    if(!validId(doc))return graph;
    const sketch={id:'sketch-1',type:'sketch',documentId:doc,x:0,y:0};
    return {...graph,nodes:[sketch,preview],links:[{from:sketch.id,to:preview.id,slot:'visual'}]};
  }

  function restoreGraph(value,documents,starterId){
    if(!value||!Array.isArray(value.nodes))return null;
    const nodes=[],ids=new Set(),docs=new Set();
    // An earlier build did not save an untouched starter draft before saving its connections.
    const repairStarter=documents.size===1&&documents.has(starterId)&&
      !value.nodes.some(node=>node?.type==='sketch'&&node.documentId===starterId);
    for(const node of value.nodes.slice(0,40)){
      if(!validId(node?.id)||ids.has(node.id)||!Number.isFinite(node.x)||!Number.isFinite(node.y))continue;
      const data={id:node.id,type:node.type,x:clampPosition(node.x),y:clampPosition(node.y)};
      if(node.type==='sketch'){
        const documentId=repairStarter&&node.id==='sketch-1'?starterId:node.documentId;
        if(!documents.has(documentId)||docs.has(documentId))continue;
        data.documentId=documentId;docs.add(documentId);
      }else if(node.type==='preview'){
        data.mode=Object.hasOwn(MODES,node.mode)?node.mode:'ai';
        if(!value.version&&data.mode==='ps')data.mode='ai';
        data.variant=Number.isInteger(node.variant)&&node.variant>=0&&node.variant<=2?node.variant:0;
        data.auto=node.auto!==false;
      }else if(node.type==='text'){
        data.prompt=typeof node.prompt==='string'?node.prompt.slice(0,1200):'';
      }else if(node.type==='image'){
        const image=node.image;
        data.image=typeof image?.src==='string'&&image.src.length<950000&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(image.src)
          ?{src:image.src,name:typeof image.name==='string'?image.name.slice(0,80):'参考图片'}:null;
      }else if(node.type!=='model'||nodes.some(item=>item.type==='model'))continue;
      ids.add(node.id);nodes.push(data);
    }
    let graph={version:2,nodes,links:[],activePreview:null};
    graph.activePreview=previewNode(graph,value.activePreview)?.id??nodes.find(node=>node.type==='preview')?.id??null;
    if(Array.isArray(value.links))for(const edge of value.links.slice(0,100)){
      if(edge)graph=connect(graph,edge.from,edge.to,edge.slot);
    }
    return graph;
  }

  function connect(graph,from,to,requested){
    const node=graph.nodes.find(item=>item.id===from),slot=slotOf(node?.type);
    if(!slot||(requested&&requested!==slot)||!previewNode(graph,to))return graph;
    if(graph.links.some(edge=>edge.from===from&&edge.to===to&&edge.slot===slot))return graph;
    return {...graph,links:[...graph.links.filter(edge=>edge.to!==to||edge.slot!==slot),{from,to,slot}]};
  }

  function disconnect(graph,to,slot){
    const links=graph.links.filter(edge=>edge.to!==to||(slot&&edge.slot!==slot));
    return links.length===graph.links.length?graph:{...graph,links};
  }

  function inputs(graph,previewId){
    const source=slot=>{
      const edge=graph.links.find(link=>link.to===previewId&&link.slot===slot);
      return graph.nodes.find(node=>node.id===edge?.from)??null;
    };
    return {visual:source('visual'),text:source('text')};
  }

  function sourceDocument(graph,previewId){
    const {visual}=inputs(graph,previewId);
    return visual?.type==='sketch'?visual.documentId:null;
  }

  function wireCurve(start,end){
    const bend=Math.min(230,Math.max(42,Math.abs(end.x-start.x)*.51+Math.abs(end.y-start.y)*.12));
    return 'M '+start.x+' '+start.y+' C '+(start.x+bend)+' '+start.y+' '+(end.x-bend)+' '+end.y+' '+end.x+' '+end.y;
  }

  function formOptions(scene,rules,studio){
    let curve=scene.curve;
    let ink=scene.ink, depth=scene.depth;
    if(!curve?.closed){
      curve=null;
      const index=ink.findIndex(stroke=>{
        curve=studio.inkOutline([stroke],rules);
        return !!curve;
      });
      if(index>=0){
        depth=ink[index].depth;
        ink=ink.filter((_,i)=>i!==index);
      }
    }
    if(!curve?.closed||!rules.inspect(curve).ok)return [];
    const options=[{label:'原型',widthChange:0,scene:{...scene,curve,ink,depth}}];
    const candidates=rules.generate(curve,{direction:'both',width:22,bend:16}).candidates;
    const first=candidates.find(candidate=>candidate.widthChange<-.06);
    const second=candidates.find(candidate=>candidate.widthChange>.06);
    const selected=[first,second,...candidates.filter(candidate=>candidate!==first&&candidate!==second)].filter(Boolean).slice(0,2);
    for(const variant of selected){
      const amount=variant.widthChange;
      const label=Math.abs(amount)<.06?'弧度变化':(amount<0?'收窄 ':'放宽 ')+Math.abs(amount).toFixed(0)+'%';
      options.push({label,widthChange:amount,scene:{...scene,curve:variant,ink,depth}});
    }
    return options;
  }

  function lineSvg(scene,rules,studio,id,ratio=1.38){
    const frame=studio.frameFor(scene,rules,ratio);
    const [x,y,w,h]=frame;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="'+Math.round(1100*h/w)+'" viewBox="'+frame.join(' ')+
      '" role="img" aria-label="草图线稿"><rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+
      '" fill="#f4f1e9"/>'+studio.lineMarkup(scene,rules,{id})+'</svg>';
  }

  return {WIDTH,HEIGHT,GAP,PORT_Y,MODES,clampPosition,createGraph,restoreGraph,findSketch,previewNode,
    slotOf,connect,disconnect,inputs,sourceDocument,wireCurve,formOptions,lineSvg};
});
