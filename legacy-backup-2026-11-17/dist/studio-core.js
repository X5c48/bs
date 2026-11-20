(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/drawing-tools.js'));
  else root.WuyingStudioCore = factory(root.WuyingOpenDrawing);
})(globalThis, function (drawing) {
  'use strict';

  const MAX_STROKES = 80, MAX_POINTS = 300;
  const inks = {
    graphite: {label:'石墨', color:'#30333b'}, blue: {label:'钴蓝', color:'#5263c7'},
    ochre: {label:'赤陶', color:'#b56b4a'}, moss: {label:'苔绿', color:'#557b54'}, gray: {label:'浅灰', color:'#85848a'}
  };
  const tones = {
    silver: { label:'钛雾', chip:'#b7b3a7', bright:'#eae6da', mid:'#b6b0a4', shade:'#6b6863', accent:'#989083', rubber:'#3e3e39' },
    moss:   { label:'苔绿', chip:'#6d7761', bright:'#c4c8a4', mid:'#75816a', shade:'#3c4a3a', accent:'#9b9a67', rubber:'#303729' },
    dune:   { label:'沙丘', chip:'#bd9975', bright:'#f1dabe', mid:'#c3a185', shade:'#715548', accent:'#ae7f5a', rubber:'#523c32' },
    blue:   { label:'雾蓝', chip:'#788b9d', bright:'#cbd8de', mid:'#8297ac', shade:'#475c73', accent:'#59768c', rubber:'#293749' },
    clay:   { label:'赤岩', chip:'#ae6d58', bright:'#edc0a9', mid:'#b77962', shade:'#6d453b', accent:'#9e5846', rubber:'#53362d' },
    ink:    { label:'岩墨', chip:'#50505b', bright:'#b0adb2', mid:'#696674', shade:'#343342', accent:'#4b485b', rubber:'#252533' }
  };
  const nodes = [
    [154,245,142,264,157,219], [176,178,169,201,181,165], [230,215,208,220,252,209],
    [291,160,271,184,300,150], [325,164,311,149,348,184], [397,226,369,212,436,247],
    [519,247,485,233,541,256], [542,289,555,272,536,302], [487,313,523,310,442,320],
    [343,311,392,310,285,305], [171,300,226,319,149,292]
  ];
  const shoe = {
    sole: 'M142 252 Q171 259 193 267 Q226 279 263 269 L310 258 Q347 249 384 264 Q432 279 488 274 Q532 269 553 254 L558 327H139Z',
    rubber: 'M141 278 Q179 301 226 296 L283 290 Q315 285 348 292 Q426 309 491 297 Q531 290 552 277 L560 328H140Z',
    heel: 'M143 253L165 184Q177 162 193 187Q205 214 225 217L250 245Q213 258 173 260Z',
    toe: 'M343 265 Q373 238 397 233 Q414 230 434 236 Q481 234 525 246 Q545 252 550 267 Q523 273 492 275 Q410 283 371 268Z',
    stripe: 'M173 239 Q235 228 266 208 L288 196 L312 199 L290 221 Q255 246 216 255Z',
    eye: 'M254 208 Q276 184 297 163 Q306 151 317 158 Q344 180 370 207 L392 228 Q379 240 368 230 Q344 209 318 184 Q312 177 304 183 Q283 203 268 214Z',
    collar: 'M171 189 Q180 168 192 182 Q212 216 229 212 Q250 207 266 191',
    laces: ['M283 186 Q299 182 316 196','M295 174 Q308 173 327 190','M306 168 Q321 167 339 196','M323 177 Q338 177 350 204','M338 189 Q350 189 361 214','M352 202 Q362 204 375 223']
  };
  const n = value => +value.toFixed(2);
  const pt = (x,y) => ({x,y});
  const gap = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  const known = (group, key) => Object.hasOwn(group, key);
  const validPoint = p => Number.isFinite(p?.x) && Number.isFinite(p?.y) && Math.max(Math.abs(p.x),Math.abs(p.y)) <= 1e6;
  const pointPair = p => n(p.x) + ' ' + n(p.y);
  const sketchViews = {
    front: { label:'正面', prompt:'straight-on front elevation' },
    side: { label:'侧面', prompt:'right side elevation, side profile' },
    top: { label:'顶面', prompt:'directly overhead top view, top elevation' }
  };
  const modelSize = { span:2.6, depthStep:.014, defaultDepth:35 };

  function shoeSample() {
    return { closed:true, profile:'shoe', pins:{anchors:[],segments:[9]},
      nodes:nodes.map(([x,y,ix,iy,ox,oy]) => ({point:pt(x,y),in:pt(ix,iy),out:pt(ox,oy),explicit:true})) };
  }

  function cleanDepth(value) {
    const length=Math.hypot(value?.x,value?.y);
    if(!Number.isFinite(length)||length<2)return null;
    const scale=Math.min(1,240/length);
    return pt(n(value.x*scale),n(value.y*scale));
  }

  function cleanInk(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0,MAX_STROKES).flatMap(stroke => {
      if (!known(inks,stroke?.color) || !Number.isFinite(stroke.size) || stroke.size < .25 || stroke.size > 60 ||
          !Array.isArray(stroke.points) || !stroke.points.length ||
          !stroke.points.slice(0,MAX_POINTS).every(validPoint)) return [];
      const points=stroke.points.slice(0,MAX_POINTS).map(p=>{
        const point=pt(n(p.x),n(p.y));
        if(Number.isFinite(p.pressure))point.pressure=n(Math.min(1,Math.max(0,p.pressure)));
        return point;
      });
      const opacity=Number.isFinite(stroke.opacity)?n(Math.min(1,Math.max(.05,stroke.opacity))):1;
      const clean={color:stroke.color,size:n(stroke.size),opacity,points};
      if(stroke.engine==='perfect')clean.engine='perfect';
      const depth=cleanDepth(stroke.depth);
      if(depth)clean.depth=depth;
      return [clean];
    });
  }

  function brushPath({ points }) {
    const first = points[0], last = points.at(-1);
    if (points.length === 1) return 'M' + pointPair(first) + ' L' + pointPair(pt(first.x+.02,first.y));
    let path = 'M' + pointPair(first);
    for (let i=1;i<points.length-1;i++) {
      const a=points[i], b=points[i+1];
      path += ' Q' + pointPair(a) + ' ' + pointPair(pt((a.x+b.x)/2,(a.y+b.y)/2));
    }
    return path + ' L' + pointPair(last);
  }

  function penOptions(stroke) {
    return {
      size:stroke.size,thinning:stroke.points.some(p=>Number.isFinite(p.pressure)) ? .62 : 0,
      smoothing:.66,streamline:.42,simulatePressure:false,last:true
    };
  }

  function brushGeometry(stroke) {
    const points=stroke.points;
    if(stroke.engine==='perfect'&&drawing?.getStroke){
      const edge=drawing.getStroke(points,penOptions(stroke));
      if(edge.length>=3){
        const middle=([x,y],[nextX,nextY])=>n((x+nextX)/2)+' '+n((y+nextY)/2);
        const commands=edge.map(([x,y],i)=>'Q'+n(x)+' '+n(y)+' '+middle(edge[i],edge[(i+1)%edge.length]));
        return {d:'M'+middle(edge.at(-1),edge[0])+' '+commands.join(' ')+' Z',filled:true};
      }
    }
    if(points.length<2||!points.some(p=>Number.isFinite(p.pressure)))return {d:brushPath(stroke),filled:false};
    const radii=points.map(p=>stroke.size*(.24+.76*(p.pressure??.5))/2);
    const sides=sign=>points.map((p,i)=>{
      const a=points[Math.max(0,i-1)], b=points[Math.min(i+1,points.length-1)];
      const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy)||1;
      return pt(p.x-dy*radii[i]*sign/length,p.y+dx*radii[i]*sign/length);
    });
    const edge=[...sides(1),...sides(-1).reverse()];
    const caps=[0,points.length-1].map(i=>{
      const p=points[i],r=n(radii[i]);
      return ' M'+n(p.x+r)+' '+n(p.y)+' a'+r+' '+r+' 0 1 1 '+n(-2*r)+' 0 a'+r+' '+r+' 0 1 1 '+n(2*r)+' 0';
    }).join('');
    return {d:'M'+edge.map(pointPair).join(' L')+' Z'+caps,filled:true};
  }

  function enclosedMask(data,width,height){
    if(width<3||height<3||width*height>400000||data.length!==width*height*4)return null;
    const flags=new Uint8Array(width*height),queue=new Int32Array(flags.length);
    let first=0,last=0;
    for(let i=0;i<flags.length;i++){
      const p=i*4;
      if(data[p+3]>100&&data[p]*.299+data[p+1]*.587+data[p+2]*.114<165)flags[i]=1;
    }
    const push=i=>{if(!flags[i]){flags[i]=2;queue[last++]=i;}};
    for(let x=0;x<width;x++){push(x);push((height-1)*width+x);}
    for(let y=1;y<height-1;y++){push(y*width);push(y*width+width-1);}
    while(first<last){
      const i=queue[first++], x=i%width;
      if(x>0)push(i-1);
      if(x<width-1)push(i+1);
      if(i>=width)push(i-width);
      if(i+width<flags.length)push(i+width);
    }
    let filled=0;
    const mask=flags.map(value=>{if(value===0){filled++;return 255;}return 0;});
    return filled>=Math.max(9,flags.length*.003)?mask:null;
  }

  function pointDistance(p, a, b) {
    const dx=b.x-a.x,dy=b.y-a.y;
    const t=Math.min(1,Math.max(0,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
    return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
  }

  function segmentDistance(a,b,c,d) {
    const cross=(p,q,r)=>(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
    const ab=cross(a,b,c)*cross(a,b,d), cd=cross(c,d,a)*cross(c,d,b);
    if (ab<0 && cd<0) return 0;
    return Math.min(pointDistance(a,c,d),pointDistance(b,c,d),pointDistance(c,a,b),pointDistance(d,a,b));
  }

  function hitStroke(stroke, point, radius, previous = point) {
    const points=stroke.points, threshold=radius+stroke.size*.5;
    return points.some((p,i)=>segmentDistance(point,previous,p,points[i+1]||p)<=threshold);
  }

  function bounds(points) {
    if (!points.length) return null;
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
    const x=Math.min(...xs),y=Math.min(...ys);
    return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
  }

  function closedStroke(points,rules) {
    if(points.length<4)return null;
    const extent=bounds(points);
    const tolerance=Math.min(24,Math.max(6,Math.hypot(extent.width,extent.height)*.10));
    if(Math.min(extent.width,extent.height)<7||gap(points[0],points.at(-1))>tolerance)return null;
    const spaced=[points[0]];
    for(const point of points.slice(1))if(gap(point,spaced.at(-1))>2.2)spaced.push(point);
    if(spaced.length>3&&gap(spaced[0],spaced.at(-1))<=tolerance)spaced.pop();
    const stride=Math.max(1,Math.ceil(spaced.length/48));
    const nodes=spaced.filter((_,i)=>i%stride===0).map(point=>({point,in:point,out:point}));
    const shape={nodes,closed:true};
    return rules.inspect(shape).ok?shape:null;
  }

  function inkRegions(strokes,rules) {
    const regions=[], used=new Set();
    function add(shape,indices){
      const stroke=strokes[indices[0]];
      const color=indices.map(i=>strokes[i].color).find(value=>['moss','ochre','blue'].includes(value))||stroke.color;
      const depth=indices.map(index=>cleanDepth(strokes[index].depth)).find(Boolean)||null;
      if(depth&&indices.length===1&&stroke.engine==='perfect'&&drawing?.getStrokePoints){
        const center=drawing.getStrokePoints(stroke.points,penOptions(stroke)).map(({point:[x,y]})=>pt(x,y));
        shape=closedStroke(center,rules)||shape;
      }
      regions.push({shape,color,box:rules.controlBounds(shape),indices,depth});
      for(const index of indices)used.add(index);
    }
    for(const [index,{points}] of strokes.entries()){
      const shape=closedStroke(points,rules);
      if(shape)add(shape,[index]);
      if(regions.length===12)break;
    }
    for(let start=0;start<strokes.length&&regions.length<12;start++){
      if(used.has(start)||strokes[start].points.length<2)continue;
      let points=strokes[start].points;
      const chain=[start];
      for(let count=0;count<7;count++){
        const end=points.at(-1);
        let candidate=null, closest=14;
        for(const [index,stroke] of strokes.entries()){
          if(used.has(index)||chain.includes(index)||stroke.points.length<2)continue;
          const forward=gap(end,stroke.points[0]), reverse=gap(end,stroke.points.at(-1));
          const distance=Math.min(forward,reverse);
          if(distance>=closest)continue;
          closest=distance;
          candidate={index,points:forward<=reverse?stroke.points:stroke.points.slice().reverse()};
        }
        if(!candidate)break;
        points=points.concat(candidate.points);
        chain.push(candidate.index);
        const shape=closedStroke(points,rules);
        if(shape){add(shape,chain);break;}
      }
    }
    return regions.sort((a,b)=>b.box.width*b.box.height-a.box.width*a.box.height);
  }

  function inkOutline(strokes,rules) {
    return inkRegions(strokes,rules)[0]?.shape||null;
  }

  function closedOutline(scene,rules){
    const shape=scene.curve;
    return shape?.closed&&rules.inspect(shape).ok?shape:inkOutline(scene.ink||[],rules);
  }

  function depthParts(scene,rules){
    const parts=[];
    const vectorDepth=cleanDepth(scene.depth);
    if(vectorDepth&&scene.curve?.closed&&rules.inspect(scene.curve).ok){
      parts.push({shape:scene.curve,box:rules.controlBounds(scene.curve),indices:null,depth:vectorDepth});
    }
    if(scene.ink?.some(stroke=>stroke.depth)){
      const regions=scene.regions||inkRegions(scene.ink,rules);
      parts.push(...regions.filter(part=>part.depth));
    }
    return parts;
  }

  function orthographicProjection(scene,rules,view){
    if(view!=='side'&&view!=='top')return [];
    const marked=depthParts(scene,rules);
    const outline=marked.length?null:closedOutline(scene,rules);
    const parts=marked.map(({shape,depth,color})=>({
      ...rules.inspect(shape).bounds,thickness:Math.hypot(depth.x,depth.y),color
    }));
    if(outline){
      const size=rules.controlBounds(outline);
      const thickness=Math.max(size.width,size.height)*modelSize.defaultDepth*modelSize.depthStep/modelSize.span;
      parts.push({...rules.inspect(outline).bounds,thickness});
    }
    if(!parts.length)return [];
    const left=Math.min(...parts.map(part=>part.x)),right=Math.max(...parts.map(part=>part.x+part.width));
    const top=Math.min(...parts.map(part=>part.y)),bottom=Math.max(...parts.map(part=>part.y+part.height));
    const thickness=Math.max(...parts.map(part=>part.thickness));
    const sideStart=(left+right-thickness)/2,topStart=(top+bottom+thickness)/2;
    // The right view preserves height. The top view preserves width and shows the back above the front.
    return parts.map(part=>{
      const box=view==='side' ? [sideStart,part.y,part.thickness,part.height] :
        [part.x,topStart-part.thickness,part.width,part.thickness];
      const [x,y,width,height]=box.map(n);
      return {x,y,width,height,color:part.color||'graphite'};
    });
  }

  function depthTarget(scene,rules,point,tolerance){
    const parts=inkRegions(scene.ink||[],rules);
    if(scene.curve?.closed){
      parts.push({shape:scene.curve,box:rules.controlBounds(scene.curve),indices:null,depth:cleanDepth(scene.depth)});
    }
    parts.sort((a,b)=>a.box.width*a.box.height-b.box.width*b.box.height);
    for(const part of parts){
      const box=part.box;
      if(point.x<box.x-tolerance||point.x>box.x+box.width+tolerance||
         point.y<box.y-tolerance||point.y>box.y+box.height+tolerance)continue;
      const outline=rules.inspect(part.shape);
      if(!outline.ok)continue;
      let inside=false;
      for(let i=1;i<outline.points.length;i++){
        const a=outline.points[i-1],b=outline.points[i];
        if(pointDistance(point,a,b)<=tolerance)return part;
        if((a.y>point.y)!==(b.y>point.y)&&
          point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;
      }
      if(inside)return part;
    }
    return null;
  }

  function depthMarkup(scene,rules,{id='depth',style='guide',tone='silver',useInkColors=true,showFrontGuide=false}={}){
    if(scene.view==='front'&&!showFrontGuide)return '';
    const colorTone={moss:'moss',ochre:'clay',blue:'blue'};
    return depthParts(scene,rules).map(({shape,depth,color},index)=>{
      const {points,area,bounds:box}=rules.inspect(shape);
      if(!points)return '';
      const visible=points.slice(1).map((b,i)=>{
        const a=points[i];
        return Math.sign(area)*((b.x-a.x)*depth.y-(b.y-a.y)*depth.x)<-1e-5;
      });
      // Walk the outline from a hidden edge to join adjacent visible walls.
      const hidden=visible.indexOf(false);
      if(hidden<0)return '';
      let side='', run=[];
      for(let step=1;step<=visible.length;step++){
        const i=(hidden+step)%visible.length;
        if(visible[i]){
          if(!run.length)run.push(points[i]);
          run.push(points[i+1]);
        }else if(run.length){
          const back=run.slice().reverse().map(p=>pointPair(pt(p.x+depth.x,p.y+depth.y)));
          side+='M'+run.map(pointPair).join(' L')+' L'+back.join(' L')+' Z ';
          run=[];
        }
      }
      if(!side)return '';
      const clip=id+'-side-'+index;
      const x=n(box.x+Math.min(0,depth.x)-4), y=n(box.y+Math.min(0,depth.y)-4);
      const w=n(box.width+Math.abs(depth.x)+8), h=n(box.height+Math.abs(depth.y)+8);
      const outside='M'+x+' '+y+' h'+w+' v'+h+' h-'+w+' Z '+rules.pathData(shape);
      const paint=(useInkColors&&tones[colorTone[color]])||tones[tone]||tones.silver;
      const fill=style==='line'?'none':style==='shade'?paint.shade:'#c1d1bb';
      const stroke=style==='line'?'#15151a':style==='shade'?paint.rubber:'#55704e';
      return '<defs><clipPath id="'+clip+'"><path d="'+outside+'" clip-rule="evenodd"/></clipPath></defs>'+
        '<path class="studio-depth-side" d="'+side+'" fill="'+fill+'" stroke="'+stroke+
        '" stroke-width="1.6" stroke-linejoin="round" clip-path="url(#'+clip+')"/>';
    }).join('');
  }

  function sceneBounds(scene, rules) {
    const outline=scene.curve?.nodes?.length ? rules.controlBounds(scene.curve) : null;
    const ink=bounds(scene.ink.flatMap(stroke=>stroke.points));
    const sides=scene.view==='front'?[]:depthParts(scene,rules).map(({box,depth})=>({...box,x:box.x+depth.x,y:box.y+depth.y}));
    const boxes=[outline,ink,scene.underlay,...sides].filter(Boolean);
    if (!boxes.length) return {x:150,y:140,width:385,height:190};
    const x=Math.min(...boxes.map(b=>b.x)), y=Math.min(...boxes.map(b=>b.y));
    return {x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};
  }

  function frameFor(scene, rules, ratio=1.24) {
    if(Array.isArray(scene.frame)&&scene.frame.length===4&&scene.frame.every(Number.isFinite)&&scene.frame[2]>0&&scene.frame[3]>0){
      const [x,y,w,h]=scene.frame,width=Math.max(w,h*ratio),height=width/ratio;
      return [x+(w-width)/2,y+(h-height)/2,width,height].map(n);
    }
    const box=sceneBounds(scene,rules);
    const width=Math.max(box.width*1.18+24,(box.height*1.26+34)*ratio,scene.curve?.nodes?.length?300:350);
    const height=width/ratio;
    return [n(box.x+(box.width-width)/2),n(box.y+(box.height-height)/2),n(width),n(height)];
  }

  function shoeSketchMarkup(clipId,offset=0) {
    return '<g clip-path="url(#'+clipId+')" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><g transform="translate('+n(offset)+' 0)">'+
      [shoe.heel,shoe.toe,shoe.stripe,shoe.eye,shoe.sole,shoe.rubber].map(d=>'<path d="'+d+'" stroke-width="1.08"/>').join('')+
      '<path d="'+shoe.collar+'" stroke-width="1.2"/>'+shoe.laces.map(d=>'<path d="'+d+'" stroke-width="2"/>').join('')+
      '<path d="M165 281 Q218 304 277 283 Q310 275 348 284 Q444 308 523 283" stroke-width=".7" stroke-dasharray="3 2" opacity=".6"/></g></g>';
  }

  function inkMarkup(strokes, monochrome=false) {
    return strokes.map(stroke=>{
      const {d,filled}=brushGeometry(stroke), color=monochrome?'#15151a':inks[stroke.color].color;
      const style=filled?' fill="'+color+'"':' fill="none" stroke="'+color+'" stroke-width="'+stroke.size+'"';
      return '<path class="studio-ink-line" d="'+d+'"'+style+' opacity="'+(monochrome?1:stroke.opacity??1)+
        '" stroke-linejoin="round" stroke-linecap="round"/>';
    }).join('');
  }

  function underlayMarkup(underlay,{mask=false,opacity=.80,blend=false}={}){
    if(!underlay)return '';
    const src=mask?underlay.mask:underlay.src;
    if(typeof src!=='string'||!/^data:image\/(?:jpeg|png);base64,[a-zA-Z0-9+/=]+$/.test(src)||
      ![underlay.x,underlay.y,underlay.width,underlay.height].every(Number.isFinite))return '';
    return '<image href="'+src+'" x="'+underlay.x+'" y="'+underlay.y+'" width="'+underlay.width+'" height="'+underlay.height+
      '" opacity="'+opacity+'" preserveAspectRatio="none"'+(blend?' style="mix-blend-mode:multiply"':'')+'/>';
  }

  function rasterTint(underlay,id,tone,angle,includeLines){
    if(!underlay)return '';
    const lines=includeLines?underlayMarkup(underlay,{blend:true}):'';
    const mask=underlayMarkup(underlay,{mask:true,opacity:1});
    if(!mask)return lines;
    const rect=' x="'+underlay.x+'" y="'+underlay.y+'" width="'+underlay.width+'" height="'+underlay.height+'"';
    return '<defs><mask id="'+id+'-inkmask" maskUnits="userSpaceOnUse" style="mask-type:alpha"'+rect+'>'+mask+'</mask>'+
      '<linearGradient id="'+id+'-wash" x1="'+angle+'%" y1="0%" x2="75%" y2="100%"><stop stop-color="'+tone.bright+'"/>'+
      '<stop offset=".58" stop-color="'+tone.mid+'"/><stop offset="1" stop-color="'+tone.shade+'"/></linearGradient></defs>'+
      '<rect class="studio-ps-raster"'+rect+' fill="url(#'+id+'-wash)" mask="url(#'+id+'-inkmask)" opacity=".91"/>'+
      lines;
  }

  function lineMarkup(scene,rules,{id='lines',monochrome=false,fillInk=false}={}) {
    const curve=scene.curve?.nodes?.length ? rules.pathData(scene.curve) : '';
    const clip=id+'-pattern';
    const detail=curve&&scene.profile==='shoe'
      ? '<defs><clipPath id="'+clip+'"><path d="'+curve+'"/></clipPath></defs>'+shoeSketchMarkup(clip,scene.offset) : '';
    const colorFill=fillInk&&!monochrome?inkRegions(scene.ink,rules)
      .filter(region=>['moss','ochre','blue'].includes(region.color))
      .map(({shape,color})=>'<path d="'+rules.pathData(shape)+'" fill="'+inks[color].color+'" fill-opacity=".82"/>')
      .join(''):'';
    return '<g color="'+(monochrome?'#15151a':'#35313b')+'">'+underlayMarkup(scene.underlay,{opacity:monochrome?1:.82})+
      colorFill+depthMarkup(scene,rules,{id:id+'-depth',style:monochrome?'line':'guide'})+
      (curve?'<path d="'+curve+'" stroke="currentColor" stroke-width="2.1" fill="none"/>'+detail:'')+
      inkMarkup(scene.ink,monochrome)+'</g>';
  }

  function shoeFinish(id,tone,offset=0) {
    const fill=(d,color,stroke='#ffffff30')=>'<path d="'+d+'" fill="'+color+'" stroke="'+stroke+'" stroke-width=".95"/>';
    const url=name=>'url(#'+id+'-'+name+')';
    const laceShadow=shoe.laces.map(d=>'<path d="'+d+'" transform="translate(0 1.2)"/>').join('');
    const laces=shoe.laces.map(d=>'<path d="'+d+'"/>').join('');
    return '<g clip-path="'+url('clip')+'"><g transform="translate('+n(offset)+' 0)">'+
      '<rect x="135" y="146" width="435" height="180" fill="'+url('weave')+'" opacity=".58"/>'+
      fill(shoe.heel,url('trim'))+fill(shoe.stripe,tone.accent)+fill(shoe.toe,url('trim'))+
      fill(shoe.eye,url('trim'),'#493f3936')+
      '<path d="'+shoe.collar+'" fill="none" stroke="'+tone.bright+'" stroke-width="3.1" stroke-linecap="round" opacity=".75"/>'+
      '<g fill="none" stroke="'+tone.shade+'" stroke-width="5" stroke-linecap="round" opacity=".85">'+laceShadow+'</g>'+
      '<g fill="none" stroke="#f3eee1" stroke-width="3.25" stroke-linecap="round">'+laces+'</g>'+
      fill(shoe.sole,url('foam'))+fill(shoe.rubber,url('tread'),'#211e1e35')+
      '<path d="M158 271 Q198 292 251 276 L302 266 Q326 257 361 270 Q446 296 532 268" fill="none" stroke="#faf5ea" stroke-opacity=".64" stroke-width="2"/>'+
      '<path d="M167 293 Q218 309 269 295 Q313 284 348 295 Q439 312 524 288" fill="none" stroke="#242525" stroke-opacity=".42" stroke-width="2" stroke-dasharray="5 3"/>'+
      '</g></g>';
  }

  function renderRegions(regions,rules,id,tone,angle,useInkColors) {
    const colorTone={moss:'moss',ochre:'clay',blue:'blue'};
    return regions.map(({shape,box,color,depth:drawnDepth},index)=>{
      const paint=(useInkColors&&tones[colorTone[color]])||tone;
      const region=id+'-region-'+index,path=rules.pathData(shape);
      const size=Math.min(box.width,box.height);
      const depth=n(Math.max(.6,size*.03));
      const shadow=n(Math.max(.6,size*.045));
      return '<g class="studio-ink-region"><defs><linearGradient id="'+region+'" x1="'+n(angle*.65)+'%" y1="2%" x2="80%" y2="100%">'+
        '<stop stop-color="'+paint.bright+'"/><stop offset=".44" stop-color="'+paint.mid+'"/><stop offset="1" stop-color="'+paint.shade+'"/></linearGradient>'+
        '<filter id="'+region+'-shadow" x="-30%" y="-75%" width="160%" height="250%"><feGaussianBlur stdDeviation="'+shadow+'"/></filter></defs>'+
        '<ellipse cx="'+n(box.x+box.width*.53)+'" cy="'+n(box.y+box.height+depth)+'" rx="'+n(box.width*.46)+'" ry="'+shadow+
        '" fill="#312f31" opacity=".22" filter="url(#'+region+'-shadow)"/>'+
        (drawnDepth?'':'<path d="'+path+'" transform="translate('+depth+' '+depth+')" fill="'+paint.shade+'" opacity=".84"/>')+
        '<path d="'+path+'" fill="url(#'+region+')" stroke="'+paint.shade+'" stroke-width=".9"/>'+
        '<path d="'+path+'" fill="none" stroke="'+paint.bright+'" stroke-opacity=".8" stroke-width=".7"/></g>';
    }).join('');
  }

  function renderSvg(scene, rules, options={}) {
    const id=/^[a-z][a-z0-9-]*$/.test(options.id||'')?options.id:'studio';
    const tone=known(tones,options.tone)?tones[options.tone]:tones.silver;
    const angle=Math.min(100,Math.max(0,Number(options.light??38)||0));
    const ps=options.style==='ps';
    const form=scene.curve?.closed ? scene.curve : scene.curve?.nodes?.length ? null : scene.form||null;
    const regions=scene.regions||(Object.hasOwn(scene,'form')?[]:inkRegions(scene.ink,rules));
    const patches=renderRegions(regions,rules,id,tone,angle,options.useInkColors!==false);
    const sides=depthMarkup({...scene,regions},rules,{id:id+'-depth',style:'shade',tone:options.tone,useInkColors:options.useInkColors});
    const [x,y,w,h]=frameFor(scene,rules,options.ratio||1.24);
    const box=form ? sceneBounds({curve:form,ink:[]},rules) : null;
    const shape=form ? rules.pathData(form) : '';
    const stroke=options.outline!==false&&scene.curve?.nodes?.length ? rules.pathData(scene.curve) : '';
    const ref=name=>id+'-'+name;
    const url=name=>'url(#'+ref(name)+')';
    const title='<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="'+Math.round(1100*h/w)+'" viewBox="'+[x,y,w,h].join(' ')+'" preserveAspectRatio="xMidYMid slice" role="img" aria-label="材质效果预览">';
    const background='<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="'+url('paper')+'"/>';
    const paper='<radialGradient id="'+ref('paper')+'" cx="'+(27+angle*.28)+'%" cy="25%" r="84%"><stop stop-color="#fbfaf4"/><stop offset="1" stop-color="#dfdfda"/></radialGradient>';
    if (!form) {
      const wash=ps&&!patches?'<g class="studio-ps-wash" opacity=".30" transform="translate(1 2.5)">'+
        inkMarkup(scene.ink.map(line=>({...line,size:line.size*2.7})))+'</g>':'';
      return title+'<defs>'+paper+'</defs>'+background+rasterTint(scene.underlay,id,tone,angle,options.underlayLines!==false)+sides+patches+wash+
        (stroke?'<path d="'+stroke+'" fill="none" stroke="#40414a" stroke-width="2.1"/>':'')+
        inkMarkup(scene.ink)+'</svg>';
    }
    const grad=(name,stops)=>'<linearGradient id="'+ref(name)+'" x1="'+(angle-15)+'%" y1="0%" x2="'+(80-angle*.55)+'%" y2="100%">'+
      stops.map(([offset,color])=>'<stop offset="'+offset+'" stop-color="'+color+'"/>').join('')+'</linearGradient>';
    const shadowY=box.y+box.height+box.width*.023, center=box.x+box.width*.5;
    const defs='<defs>'+paper+grad('body',[['0',tone.bright],['.30',tone.mid],['.67',tone.mid],['1',tone.shade]])+
      grad('trim',[['0',tone.bright],['.57',tone.mid],['1',tone.accent]])+
      grad('foam',[['0','#f3eddf'],['.52','#d7cfbd'],['1','#a0998b']])+
      grad('tread',[['0',tone.shade],['1',tone.rubber]])+
      '<radialGradient id="'+ref('sheen')+'" cx="'+(22+angle*.48)+'%" cy="13%" r="67%"><stop stop-color="#fef9e9" stop-opacity=".48"/><stop offset="1" stop-color="#fef9e9" stop-opacity="0"/></radialGradient>'+
      '<pattern id="'+ref('weave')+'" patternUnits="userSpaceOnUse" width="3.2" height="3"><path d="M.25 2L1.55 .65 M1.9 2.8L2.8 1.9" stroke="#fff6e7" stroke-opacity=".47" stroke-width=".6"/><path d="M.4 2.5L1.6 1.3" stroke="#302a28" stroke-opacity=".21" stroke-width=".51"/></pattern>'+
      '<filter id="'+ref('blur')+'" x="-50%" y="-250%" width="200%" height="600%"><feGaussianBlur stdDeviation="'+n(box.width*.024)+'"/></filter>'+
      '<clipPath id="'+ref('clip')+'"><path d="'+shape+'"/></clipPath></defs>';
    const lighting=ps?'<g class="studio-ps-light" clip-path="'+url('clip')+'">'+
      '<path d="M '+n(box.x)+' '+n(box.y+box.height*.28)+' L '+n(box.x+box.width)+' '+n(box.y+box.height*.09)+
      ' v '+n(box.height*.14)+' l '+n(-box.width)+' '+n(box.height*.20)+' Z" fill="#fcf2d7" opacity=".19"/>'+
      '<path d="M '+n(box.x)+' '+n(box.y+box.height*.81)+' Q '+n(center)+' '+n(box.y+box.height*.63)+' '+n(box.x+box.width)+' '+n(box.y+box.height*.74)+
      ' v '+n(box.height*.30)+' H '+n(box.x)+' Z" fill="'+tone.shade+'" opacity=".20"/></g>':'';
    const linework=ps?'<path class="studio-ps-outline" d="'+shape+'" fill="none" stroke="#373039" stroke-opacity=".87" stroke-width="1.8"/>'+
      (scene.profile==='shoe'?'<g color="#453b3d" opacity=".66">'+shoeSketchMarkup(ref('clip'),scene.offset)+'</g>':''):'';
    return title+defs+background+'<g class="studio-object">'+
      '<ellipse cx="'+n(center+(angle-50)*.26)+'" cy="'+n(shadowY)+'" rx="'+n(box.width*.47)+'" ry="'+n(box.width*.045)+'" fill="#252327" opacity=".29" filter="'+url('blur')+'"/>'+
      '<ellipse cx="'+n(center)+'" cy="'+n(shadowY-box.width*.02)+'" rx="'+n(box.width*.36)+'" ry="'+n(box.width*.013)+'" fill="#423c37" opacity=".16"/>'+
      sides+(scene.depth?'':'<path d="'+shape+'" transform="translate(0 '+n(box.width*.015)+')" fill="'+tone.shade+'"/>')+
      '<path d="'+shape+'" fill="'+url('body')+'" stroke="'+tone.shade+'" stroke-width="1"/>'+
      (scene.profile==='shoe'?shoeFinish(id,tone,scene.offset):'')+
      '<path d="'+shape+'" fill="'+url('sheen')+'" stroke="#fffaec" stroke-opacity=".42" stroke-width="1.15"/>'+
      lighting+linework+(options.underlayLines!==false?underlayMarkup(scene.underlay,{opacity:.56,blend:true}):'')+
      patches+'<g opacity=".94">'+inkMarkup(scene.ink)+'</g></g></svg>';
  }

  return { MAX_STROKES,MAX_POINTS,inks,tones,sketchViews,modelSize,shoeSample,cleanInk,cleanDepth,depthParts,depthTarget,depthMarkup,orthographicProjection,brushPath,brushGeometry,enclosedMask,underlayMarkup,hitStroke,inkOutline,inkRegions,closedOutline,
    frameFor,inkMarkup,shoeSketchMarkup,lineMarkup,renderSvg };
});
