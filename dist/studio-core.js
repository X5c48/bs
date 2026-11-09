(function (root, factory) {
  const studio = factory();
  if (typeof module === 'object' && module.exports) module.exports = studio;
  else root.WuyingStudioCore = studio;
})(globalThis, function () {
  'use strict';

  const MAX_STROKES = 80, MAX_POINTS = 300;
  const inks = {
    graphite: {label:'石墨', color:'#30333b'}, blue: {label:'钴蓝', color:'#5263c7'},
    ochre: {label:'赤陶', color:'#b56b4a'}, gray: {label:'浅灰', color:'#85848a'}
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

  function shoeSample() {
    return { closed:true, profile:'shoe', pins:{anchors:[],segments:[9]},
      nodes:nodes.map(([x,y,ix,iy,ox,oy]) => ({point:pt(x,y),in:pt(ix,iy),out:pt(ox,oy),explicit:true})) };
  }

  function cleanInk(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0,MAX_STROKES).flatMap(stroke => {
      if (!known(inks,stroke?.color) || !Number.isFinite(stroke.size) || stroke.size < .25 || stroke.size > 60 ||
          !Array.isArray(stroke.points) || !stroke.points.length ||
          !stroke.points.slice(0,MAX_POINTS).every(validPoint)) return [];
      return [{ color:stroke.color, size:n(stroke.size), points:stroke.points.slice(0,MAX_POINTS).map(p=>pt(n(p.x),n(p.y))) }];
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

  function inkOutline(strokes, rules) {
    for (const {points} of strokes) {
      if (points.length<4) continue;
      const b=bounds(points), diagonal=Math.hypot(b.width,b.height);
      const close=Math.min(24,Math.max(7,diagonal*.11));
      if (Math.min(b.width,b.height)<14 || gap(points[0],points.at(-1))>close) continue;
      const spaced=points.slice(1).reduce((out,p)=>{if(gap(p,out.at(-1))>2.2)out.push(p);return out;},[points[0]]);
      if (spaced.length>3&&gap(spaced[0],spaced.at(-1))<close)spaced.pop();
      const stride=Math.max(1,Math.ceil(spaced.length/48));
      const nodes=spaced.filter((_,i)=>i%stride===0).map(p=>({point:p,in:p,out:p}));
      const shape={nodes,closed:true};
      if (rules.inspect(shape).ok) return shape;
    }
    return null;
  }

  function sceneBounds(scene, rules) {
    const outline=scene.curve?.nodes?.length ? rules.controlBounds(scene.curve) : null;
    const ink=bounds(scene.ink.flatMap(stroke=>stroke.points));
    const boxes=[outline,ink].filter(Boolean);
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
    return strokes.map(stroke=>'<path class="studio-ink-line" d="'+brushPath(stroke)+'" fill="none" stroke="'+
      (monochrome?'#15151a':inks[stroke.color].color)+'" stroke-width="'+stroke.size+
      '" stroke-linejoin="round" stroke-linecap="round"/>').join('');
  }

  function lineMarkup(scene,rules,{id='lines',monochrome=false}={}) {
    const curve=scene.curve?.nodes?.length ? rules.pathData(scene.curve) : '';
    const clip=id+'-pattern';
    const detail=curve&&scene.profile==='shoe'
      ? '<defs><clipPath id="'+clip+'"><path d="'+curve+'"/></clipPath></defs>'+shoeSketchMarkup(clip,scene.offset) : '';
    return '<g color="'+(monochrome?'#15151a':'#35313b')+'">'+
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

  function renderSvg(scene, rules, options={}) {
    const id=/^[a-z][a-z0-9-]*$/.test(options.id||'')?options.id:'studio';
    const tone=known(tones,options.tone)?tones[options.tone]:tones.silver;
    const angle=Math.min(100,Math.max(0,Number(options.light??38)||0));
    const form=scene.curve?.closed ? scene.curve : scene.curve?.nodes?.length ? null : (Object.hasOwn(scene,'form')?scene.form:inkOutline(scene.ink,rules));
    const [x,y,w,h]=frameFor(scene,rules,options.ratio||1.24);
    const box=form ? sceneBounds({curve:form,ink:[]},rules) : null;
    const shape=form ? rules.pathData(form) : '';
    const stroke=scene.curve?.nodes?.length ? rules.pathData(scene.curve) : '';
    const ref=name=>id+'-'+name;
    const url=name=>'url(#'+ref(name)+')';
    const title='<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="'+Math.round(1100*h/w)+'" viewBox="'+[x,y,w,h].join(' ')+'" preserveAspectRatio="xMidYMid slice" role="img" aria-label="材质效果预览">';
    const background='<rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="'+url('paper')+'"/>';
    const paper='<radialGradient id="'+ref('paper')+'" cx="'+(27+angle*.28)+'%" cy="25%" r="84%"><stop stop-color="#fbfaf4"/><stop offset="1" stop-color="#dfdfda"/></radialGradient>';
    if (!form) return title+'<defs>'+paper+'</defs>'+background+
      (stroke?'<path d="'+stroke+'" fill="none" stroke="#40414a" stroke-width="2.1"/>':'')+
      inkMarkup(scene.ink)+'</svg>';
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
    return title+defs+background+'<g class="studio-object">'+
      '<ellipse cx="'+n(center+(angle-50)*.26)+'" cy="'+n(shadowY)+'" rx="'+n(box.width*.47)+'" ry="'+n(box.width*.045)+'" fill="#252327" opacity=".29" filter="'+url('blur')+'"/>'+
      '<ellipse cx="'+n(center)+'" cy="'+n(shadowY-box.width*.02)+'" rx="'+n(box.width*.36)+'" ry="'+n(box.width*.013)+'" fill="#423c37" opacity=".16"/>'+
      '<path d="'+shape+'" transform="translate(0 '+n(box.width*.015)+')" fill="'+tone.shade+'"/>'+
      '<path d="'+shape+'" fill="'+url('body')+'" stroke="'+tone.shade+'" stroke-width="1"/>'+
      (scene.profile==='shoe'?shoeFinish(id,tone,scene.offset):'')+
      '<path d="'+shape+'" fill="'+url('sheen')+'" stroke="#fffaec" stroke-opacity=".42" stroke-width="1.15"/>'+
      '<g opacity=".83">'+inkMarkup(scene.ink)+'</g></g></svg>';
  }

  return { MAX_STROKES,MAX_POINTS,inks,tones,shoeSample,cleanInk,brushPath,hitStroke,inkOutline,
    frameFor,inkMarkup,shoeSketchMarkup,lineMarkup,renderSvg };
});
