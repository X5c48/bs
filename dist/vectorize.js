// 位图矢量化（整体规划 P2）：线稿位图 → 二值网格 → 连通域 → 外轮廓追踪 → 简化多边形。
// 纯逻辑、可在 Node 单测；浏览器侧只负责把底图画到离屏画布取 ImageData。
// 产出直接喂给 shape-model.tracePart（描线部件），节点结构沿用 sketch-rules。
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory(require('./sketch-rules.js'));
  else root.WuyingVectorize=factory(root.WuyingSketchRules);
})(globalThis,function(rules){
  'use strict';
  // 顺时针八邻域（屏幕坐标 y 向下）
  const DIRS=[[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];

  // RGBA → 0/1 网格：越暗越算线条；全透明当背景忽略
  function binarize(rgba,width,height,threshold=0.62){
    const grid=new Uint8Array(width*height);
    for(let i=0,p=0;i<grid.length;i++,p+=4){
      if(rgba[p+3]<90) continue;
      const lum=(0.299*rgba[p]+0.587*rgba[p+1]+0.114*rgba[p+2])/255;
      if(lum<threshold) grid[i]=1;
    }
    return grid;
  }

  // 4 连通域标记：返回每个连通域的像素下标集合与外接框（小噪点先滤掉）
  function components(grid,width,height,minPixels=24){
    const seen=new Uint8Array(grid.length), list=[];
    for(let start=0;start<grid.length;start++){
      if(!grid[start]||seen[start]) continue;
      const pixels=[],stack=[start];
      seen[start]=1;
      let minX=width,maxX=-1,minY=height,maxY=-1;
      while(stack.length){
        const index=stack.pop();
        pixels.push(index);
        const x=index%width,y=(index-x)/width;
        if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y;
        if(x>0){const n=index-1;if(grid[n]&&!seen[n]){seen[n]=1;stack.push(n);}}
        if(x<width-1){const n=index+1;if(grid[n]&&!seen[n]){seen[n]=1;stack.push(n);}}
        if(y>0){const n=index-width;if(grid[n]&&!seen[n]){seen[n]=1;stack.push(n);}}
        if(y<height-1){const n=index+width;if(grid[n]&&!seen[n]){seen[n]=1;stack.push(n);}}
      }
      if(pixels.length>=minPixels) list.push({pixels,minX,maxX,minY,maxY});
    }
    return list;
  }

  // 单个连通域的外轮廓（Moore 邻域追踪，从最上一行最左的像素出发）
  function traceBoundary(member,width,height,start){
    const inside=index=>member.has(index);
    let cx=start%width,cy=(start-cx)/width;
    const points=[{x:cx,y:cy}];
    let backDir=4; // 起点从「西侧背景」进入
    const limit=member.size*8+64;
    for(let step=0;step<limit;step++){
      let moved=false;
      for(let k=1;k<=8;k++){
        const dir=(backDir+k)%8,[dx,dy]=DIRS[dir];
        const nx=cx+dx,ny=cy+dy;
        if(nx<0||ny<0||nx>=width||ny>=height) continue;
        const index=ny*width+nx;
        if(!inside(index)) continue;
        points.push({x:nx,y:ny});
        cx=nx;cy=ny;
        backDir=(dir+4)%8; // 下一步从刚离开的背景像素一侧开始扫
        moved=true;
        break;
      }
      if(!moved) break;
      if(cx===start%width&&cy===(start-(start%width))/width&&points.length>3) break;
    }
    return points;
  }

  // 多边形面积（鞋带公式，取绝对值）
  function area(points){
    let sum=0;
    for(let i=0;i<points.length;i++){
      const a=points[i],b=points[(i+1)%points.length];
      sum+=a.x*b.y-b.x*a.y;
    }
    return Math.abs(sum)/2;
  }

  function bounds(points){
    const xs=points.map(p=>p.x),ys=points.map(p=>p.y);
    const minX=Math.min(...xs),minY=Math.min(...ys);
    return {x:minX,y:minY,width:Math.max(...xs)-minX,height:Math.max(...ys)-minY};
  }

  function contour(comp,width,height,tolerance,minArea){
      const member=new Set(comp.pixels);
      // 起点：外接框内最上一行、最左的像素
      let start=-1;
      for(let y=comp.minY;y<=comp.maxY&&start<0;y++){
        for(let x=comp.minX;x<=comp.maxX;x++){
          if(member.has(y*width+x)){ start=y*width+x; break; }
        }
      }
      if(start<0) return null;
      const raw=traceBoundary(member,width,height,start);
      if(raw.length<6) return null;
      // 追踪会带回起点作为闭合点：去掉首尾重复与相邻重复，否则 inspect 会判退化
      const same=(a,b)=>Math.abs(a.x-b.x)<1e-6&&Math.abs(a.y-b.y)<1e-6;
      let points=rules.simplifyStroke(raw,tolerance*tolerance)
        .filter((point,index,list)=>index===0||!same(point,list[index-1]));
      if(points.length>1&&same(points[0],points.at(-1))) points.pop();
      if(points.length<3||points.length>90) return null;
      const measured=area(points);
      if(measured<minArea) return null;
      const box=bounds(points);
      if(box.width<6||box.height<6) return null;
      return {points,area:measured,bounds:box,pixels:comp.pixels.length};
  }

  // 对相接的手绘轮廓，在局部网格内扩张一像素，隔离细小断口；只追踪不通向边缘的空白区。
  function enclosedParts(comp,imageWidth,tolerance,minArea){
    const width=comp.maxX-comp.minX+5,height=comp.maxY-comp.minY+5;
    const open=new Uint8Array(width*height).fill(1);
    for(const index of comp.pixels){
      const x=index%imageWidth-comp.minX+2,y=Math.floor(index/imageWidth)-comp.minY+2;
      for(let dy=-1;dy<=1;dy++) open.fill(0,(y+dy)*width+x-1,(y+dy)*width+x+2);
    }
    const result=[];
    for(const region of components(open,width,height,Math.max(1,Math.floor(minArea)))){
      if(region.minX===0||region.minY===0||region.maxX===width-1||region.maxY===height-1) continue;
      const outline=contour(region,width,height,tolerance,minArea);
      if(!outline) continue;
      for(const p of outline.points){p.x+=comp.minX-2;p.y+=comp.minY-2;}
      outline.bounds=bounds(outline.points);
      result.push(outline);
    }
    return result;
  }

  // 网格 → 部件候选：连通域 → 轮廓 → 简化 → 面积过滤，按面积从大到小
  function detectParts(grid,width,height,{minPixels=24,minArea=200,maxParts=8,tolerance=2}={}){
    const found=[];
    for(const comp of components(grid,width,height,minPixels)){
      const outer=contour(comp,width,height,tolerance,minArea);
      const boxArea=(comp.maxX-comp.minX+1)*(comp.maxY-comp.minY+1);
      const inner=comp.pixels.length<boxArea*.5?enclosedParts(comp,width,tolerance,minArea):[];
      if(inner.length>1||!outer) found.push(...inner);
      else found.push(outer);
    }
    return found.sort((a,b)=>b.area-a.area).slice(0,maxParts);
  }

  return {binarize,components,traceBoundary,area,bounds,detectParts};
});
