(function (root, factory) {
  const graph=factory();
  if(typeof module==='object'&&module.exports)module.exports=graph;
  else root.WuyingNodeGraphCore=graph;
})(globalThis,function(){
  'use strict';

  const WIDTH=350, HEIGHT=365, GAP=91, PORT_Y=48;
  const MODES={ps:'PS 上色',material:'材质',line:'线稿',shape:'造型'};
  const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,96}$/.test(value);
  const clampPosition=value=>Math.min(30000,Math.max(-30000,value));
  const findSketch=(graph,doc)=>graph.nodes.find(node=>node.type==='sketch'&&node.documentId===doc);
  const previewNode=(graph,id)=>graph.nodes.find(node=>node.type==='preview'&&node.id===id);

  function createGraph(doc){
    const preview={id:'preview-1',type:'preview',x:WIDTH+GAP,y:0,mode:'ps',variant:0};
    const graph={nodes:[preview],links:[],activePreview:preview.id};
    if(!validId(doc))return graph;
    const sketch={id:'sketch-1',type:'sketch',documentId:doc,x:0,y:0};
    return {...graph,nodes:[sketch,preview],links:[{from:sketch.id,to:preview.id}]};
  }

  function restoreGraph(value,documents){
    if(!value||!Array.isArray(value.nodes))return null;
    const nodes=[],ids=new Set(),docs=new Set();
    for(const node of value.nodes.slice(0,40)){
      if(!validId(node?.id)||ids.has(node.id)||!Number.isFinite(node.x)||!Number.isFinite(node.y))continue;
      const data={id:node.id,type:node.type,x:clampPosition(node.x),y:clampPosition(node.y)};
      if(node.type==='sketch'){
        if(!documents.has(node.documentId)||docs.has(node.documentId))continue;
        data.documentId=node.documentId;docs.add(node.documentId);
      }else if(node.type==='preview'){
        data.mode=Object.hasOwn(MODES,node.mode)?node.mode:'ps';
        data.variant=Number.isInteger(node.variant)&&node.variant>=0&&node.variant<=2?node.variant:0;
      }else continue;
      ids.add(node.id);nodes.push(data);
    }
    let graph={nodes,links:[],activePreview:null};
    graph.activePreview=previewNode(graph,value.activePreview)?.id??nodes.find(node=>node.type==='preview')?.id??null;
    if(Array.isArray(value.links))for(const edge of value.links.slice(0,100)){
      if(edge)graph=connect(graph,edge.from,edge.to);
    }
    return graph;
  }

  function connect(graph,from,to){
    if(!graph.nodes.some(node=>node.type==='sketch'&&node.id===from)||!previewNode(graph,to))return graph;
    if(graph.links.some(edge=>edge.from===from&&edge.to===to))return graph;
    return {...graph,links:[...graph.links.filter(edge=>edge.to!==to),{from,to}]};
  }

  function disconnect(graph,to){
    const links=graph.links.filter(edge=>edge.to!==to);
    return links.length===graph.links.length?graph:{...graph,links};
  }

  function sourceDocument(graph,previewId){
    const edge=graph.links.find(link=>link.to===previewId);
    return graph.nodes.find(node=>node.id===edge?.from&&node.type==='sketch')?.documentId??null;
  }

  function wireCurve(start,end){
    const bend=Math.min(230,Math.max(42,Math.abs(end.x-start.x)*.51+Math.abs(end.y-start.y)*.12));
    return 'M '+start.x+' '+start.y+' C '+(start.x+bend)+' '+start.y+' '+(end.x-bend)+' '+end.y+' '+end.x+' '+end.y;
  }

  function formOptions(scene,rules,studio){
    let curve=scene.curve;
    let ink=scene.ink;
    if(!curve?.closed){
      curve=null;
      const index=ink.findIndex(stroke=>{
        curve=studio.inkOutline([stroke],rules);
        return !!curve;
      });
      if(index>=0)ink=ink.filter((_,i)=>i!==index);
    }
    if(!curve?.closed||!rules.inspect(curve).ok)return [];
    const options=[{label:'原型',widthChange:0,scene:{...scene,curve,ink}}];
    const candidates=rules.generate(curve,{direction:'both',width:22,bend:16}).candidates;
    const first=candidates.find(candidate=>candidate.widthChange<-.06);
    const second=candidates.find(candidate=>candidate.widthChange>.06);
    const selected=[first,second,...candidates.filter(candidate=>candidate!==first&&candidate!==second)].filter(Boolean).slice(0,2);
    for(const variant of selected){
      const amount=variant.widthChange;
      const label=Math.abs(amount)<.06?'弧度变化':(amount<0?'收窄 ':'放宽 ')+Math.abs(amount).toFixed(0)+'%';
      options.push({label,widthChange:amount,scene:{...scene,curve:variant,ink}});
    }
    return options;
  }

  function lineSvg(scene,rules,studio,id){
    const frame=studio.frameFor(scene,rules,1.38);
    const [x,y,w,h]=frame;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="'+Math.round(1100*h/w)+'" viewBox="'+frame.join(' ')+
      '" role="img" aria-label="草图线稿"><rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+
      '" fill="#f4f1e9"/>'+studio.lineMarkup(scene,rules,{id})+'</svg>';
  }

  return {WIDTH,HEIGHT,GAP,PORT_Y,MODES,clampPosition,createGraph,restoreGraph,findSketch,previewNode,
    connect,disconnect,sourceDocument,wireCurve,formOptions,lineSvg};
});
