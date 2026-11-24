const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const cache=path.join(require('node:os').homedir(),'AppData/Local/npm-cache/_npx');
const pw=fs.readdirSync(cache).map(d=>path.join(cache,d,'node_modules/playwright')).find(d=>fs.existsSync(d));
const {chromium}=require(pw||'playwright');
const origin='http://127.0.0.1:8881',original='bc1df03d-50be-4cc0-aecf-c40795477a69',aid='1b49c604-4c03-4e4b-a306-394511ae9879';
const root=path.resolve(__dirname,'..'),dir=path.join(root,'dist/file1-review'),out=path.join(dir,'record.json');
const record={status:'执行中',steps:[]},hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
function save(){fs.writeFileSync(out+'.tmp',JSON.stringify(record,null,2));fs.renameSync(out+'.tmp',out)}
(async()=>{
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true}),p=await browser.newPage({viewport:{width:1536,height:960}}),errors=[];
p.on('pageerror',e=>errors.push(e.message));let pid,before,source,shadeId,oldPeek,target,cleaned=false;
const shape=id=>origin+'/shape-studio.html?project='+id+'&asset='+aid;
const read=id=>p.evaluate(async ([id,aid])=>(await WuyingWorkspace.open(id).read()).assets[aid],[id,aid]);
const count=()=>p.locator('#shapeParts button').count();
const report=async(title,input,action,fn,decision,screen=true)=>{
 const s={title,input,action,time:new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})};
 try{const v=await fn();s.result=typeof v==='string'?v:JSON.stringify(v,null,2);s.ok=true;s.decision=decision;}
 catch(e){s.ok=false;s.result=e.message;s.decision='此步未达到预期，停止依赖此结果的步骤。'}
 if(screen){s.image='step-'+String(record.steps.length+1).padStart(3,'0')+'.jpg';await p.screenshot({path:path.join(dir,s.image),type:'jpeg',quality:72,timeout:6000}).catch(()=>{delete s.image})}
 record.steps.push(s);save();if(!s.ok)throw Error(title+' '+s.result);
};
const bounds=()=>p.evaluate(()=>({视口:innerWidth,页面宽度:document.documentElement.scrollWidth,体块右缘:shapePeek.getBoundingClientRect().right,属性栏右缘:document.querySelector('.shape-properties').getBoundingClientRect().right,画布宽度:shapeSheet.clientWidth}));
const selected=()=>p.locator('#shapeParts button[aria-pressed=true]').innerText();
const locks=()=>p.locator('#removePart').isDisabled();
const toggled=async()=>{await p.click('#toggleLock');await p.waitForFunction(()=>!removePart.disabled);return selected()};
try{
await report('启动测试浏览器','Edge · 1536 × 960 · 本机 CyberRealistic_FINAL_FP16.safetensors','打开“我的文件”，为测试浏览器设置与此前一致的模型。',async()=>{await p.addInitScript(()=>localStorage.setItem('wuying.liveModels',JSON.stringify({checkpoint:'CyberRealistic_FINAL_FP16.safetensors'})));await p.goto(origin+'/files.html');await p.waitForFunction(()=>window.WuyingWorkspace?.open);return p.url()},'工作区入口可用。');
await report('读取文件1原稿','项目 1 / 草图 1 · '+aid,'读取草图、部件、锁定表和底图索引，计算原稿摘要。',async()=>{source=await read(original);before=hash(source);return {画布:[source.width,source.height],主题:source.flow?.brief,底图:source.draft.reference,部件:source.draft.parts.map(x=>({名称:x.name,编号:x.id,锁定:x.locked})),原稿摘要:before}},'记录初态，结束时逐字节摘要复核。');
await report('建立验收副本','原稿画布、真实部件及引用的 PNG 底图','读取底图媒体，新建独立测试项目，复制画布和媒体。',async()=>{pid=await p.evaluate(async ([id,aid])=>{const src=WuyingWorkspace.open(id),a=(await src.read()).assets[aid],key=a.draft.reference.blobId,blob=await src.getBlob(key);if(!blob)throw Error('底图缺失');const pr=await WuyingProjects.create('文件1全过程验收-'+Date.now());await WuyingWorkspace.open(pr.id).change(d=>{d.assets[aid]=a},[{id:key,blob}]);return pr.id},[original,aid]);assert.equal(hash(await read(pid)),before);return '副本 '+pid+'；画布摘要与原稿一致。'},'后续解锁、移动和删除均指向这个副本。');
await report('进入部件推敲页',shape('副本'),'从正常页面入口载入副本。',async()=>{await p.goto(shape(pid));await p.waitForSelector('#shapeParts button');return '部件数 '+await count()},'部件列表已载入。');
await report('核对桌面布局','桌面视口 1536 × 960','读取画布尺寸以及预览、侧栏和页面的右边缘。',async()=>{const b=await bounds();assert.equal(b.体块右缘,b.视口);assert.equal(b.页面宽度,b.视口);return b},'体块与页面右缘对齐。');
await report('开启实时辅助','结构渲染 · 默认均衡档 · 文件1台灯','点击“开启实时辅助”，检查面板展开及开关状态。',async()=>{await p.click('#liveToggle');assert(await p.locator('#livePane').isVisible());return p.textContent('#liveState')},'预览面板显示当前状态。');
await report('等待真实模型出图','上一步提交的台灯结构图','等待本机模型返回图片，核查状态与图片原始尺寸。',async()=>{await p.waitForFunction(()=>liveImage.naturalWidth>0||liveState.dataset.error==='true',null,{timeout:120000});assert.equal(await p.locator('#liveState').getAttribute('data-error'),'false');return p.evaluate(()=>({状态:liveState.textContent,尺寸:[liveImage.naturalWidth,liveImage.naturalHeight]}))},'真实图片已返回。');
await report('选择第一部件','列表首行','点击首行，读出选中部件及锁定状态。',async()=>{await p.locator('#shapeParts button').first().click();shadeId=(await read(pid)).draft.parts[0].id;return selected()},'后续操作以该部件为目标。');
await report('核对锁定保护',shadeId,'检查“删除选中部件”的可用状态与提示。',async()=>({禁用:await locks(),提示:await p.locator('#removePart').getAttribute('title')}),'锁定状态决定能否执行删除。');
if(await locks()) await report('解锁拖动目标',shadeId,'在副本上点击“解锁部件”，等待删除按钮恢复可用。',toggled,'目标部件已允许编辑。');
await report('定位第 6 个节点','选中部件 · 节点索引 5','滚动到圆形锚点，记录屏幕中心和拖动前的体块形状。',async()=>{const h=p.locator('#shapeCanvas [data-node="5"]:not([data-control])').first();await h.scrollIntoViewIfNeeded();const r=await h.boundingBox();target={x:r.x+r.width/2,y:r.y+r.height/2};oldPeek=await p.locator('#peekSvg').innerHTML();return target},'获得实际鼠标起点。');
await report('按住节点',JSON.stringify(target),'移动到起点并按下鼠标左键。',async()=>{await p.mouse.move(target.x,target.y);await p.mouse.down();return '左键按下，保持按住。'},'拖动已开始。');
await report('拖动中查看反馈','水平 −15 px，垂直 +12 px，3 个移动事件','保持左键按下并移动，检查实时轮廓数、体块几何和状态文字。',async()=>{await p.mouse.move(target.x-15,target.y+12,{steps:3});const n=await p.locator('#liveOutline polygon').count(),changed=await p.locator('#peekSvg').innerHTML()!==oldPeek;assert.equal(n,await count());assert(changed);return {即时轮廓:n,体块变化:changed,状态:await p.textContent('#liveState')}},'松手之前，轮廓和体块均已跟随。');
await report('释放并核对节点保存','同一部件的第 6 个节点','松开鼠标，等待读取到变化后的节点。',async()=>{await p.mouse.up();const pt=source.draft.parts[0].points[5];await p.waitForFunction(async ([id,aid,old])=>JSON.stringify((await WuyingWorkspace.open(id).read()).assets[aid].draft.parts[0].points[5])!==JSON.stringify(old),[pid,aid,pt]);return {修改前:pt,修改后:(await read(pid)).draft.parts[0].points[5]}},'节点变化已持久化。');
await report('验证满部件窄屏','390 × 844，保留全部台灯部件','切换手机宽度并测量实际布局。',async()=>{await p.setViewportSize({width:390,height:844});const b=await bounds();assert.equal(b.页面宽度,390);assert.equal(b.体块右缘,390);return b},'页面无横向溢出，预览仍贴齐右缘。');
await report('恢复桌面视口','1536 × 960','恢复桌面大小。',async()=>{await p.setViewportSize({width:1536,height:960});return bounds()},'继续按桌面路径验证角度球。');
await report('打开产品渲染阶段','同一副本 / 草图 1 / render','进入图像工作室，等待角度球绘出台灯结构。',async()=>{await p.goto(origUrl());await p.waitForSelector('.sphere-subject polygon');return {投影面:await p.locator('.sphere-subject polygon').count(),读数:await p.textContent('#studioAngleLabel')}},'角度球包含当前主体投影。');
function origUrl(){return origin+'/image-studio.html?project='+pid+'&asset='+aid+'&stage=render'}
await report('关闭自动渲染','角度球“松手后自动渲染”','取消勾选，独立核对球面投影。',async()=>{await p.uncheck('#studioAngleAuto');return {自动渲染:await p.locator('#studioAngleAuto').isChecked()}},'以下键盘输入用于检查几何视角。');
await report('聚焦角度球','角度球键盘入口','将键盘焦点移到角度球。',async()=>{await p.locator('.angle-sphere').focus();return p.evaluate(()=>document.activeElement.getAttribute('aria-label'))},'方向键输入将送入角度球。');
let az=0,el=0;
for(const key of [...Array(6).fill('ArrowRight'),...Array(4).fill('ArrowLeft'),'ArrowUp']){
 if(key==='ArrowRight')az+=15;else if(key==='ArrowLeft')az-=15;else el+=15;
 await report('转到水平 '+az+'°、俯仰 '+el+'°','Shift + '+key,'按一次组合键，对比投影路径，读取该步的角度和视角名称。',async()=>{const before=await p.locator('.sphere-subject').innerHTML();await p.keyboard.press('Shift+'+key);const label=await p.textContent('#studioAngleLabel');assert.notEqual(before,await p.locator('.sphere-subject').innerHTML());assert(label.includes('水平 '+az+'°')&&label.includes('俯仰 '+el+'°'));return label},'读数与本次输入一致，主体投影已变化。');}
await report('回到部件推敲页',shape('副本'),'从同一副本进入部件编辑页面。',async()=>{await p.goto(shape(pid));await p.waitForSelector('#shapeParts button');return '当前 '+await count()+' 个部件'},'准备复验删除与预览同步。');
await report('删除前开启辅助','结构渲染模式','打开实时辅助，使删除发生在辅助运行期间。',async()=>{await p.click('#liveToggle');return p.textContent('#liveState')},'辅助已启动。');
while(await count()){
 const n=await count(),part=(await read(pid)).draft.parts[0],input=part.name+' / '+part.id;
 await report('选择待删的'+part.name,input,'点击部件列表第一行。',async()=>{await p.locator('#shapeParts button').first().click();return {选中:await selected(),删除按钮禁用:await locks(),列表数量:n}},'已核对删除目标。');
 if(await locks())await report('解锁'+part.name,input,'点击解锁并等到删除按钮可用。',toggled,'锁定保护解除，允许删除该部件。');
 await report('删除'+part.name,input,'点击删除，等待列表更新，复核持久化部件表、正视轮廓和预览状态。',async()=>{await p.click('#removePart');await p.waitForFunction(expected=>document.querySelectorAll('#shapeParts button').length===expected,n-1);const a=await read(pid);assert(!a.draft.parts.some(x=>x.id===part.id));assert(!a.design.views.front.outlines[part.id]);return {之前:n,之后:a.draft.parts.length,已删除编号:part.id,正视轮廓移除:true,体块投影面:await p.locator('#peekSvg polygon').count(),下一选中:n>1?await selected():'无',实时状态:await p.textContent('#liveState')}},'该部件的列表项、持久化数据和正视轮廓均已移除。');
}
await report('检查删除至空','副本中剩余 0 个部件','检查体块、实时面板和导出的 SVG 面数。',async()=>{assert(await p.locator('#shapePeek').isHidden());assert(await p.locator('#livePane').isHidden());assert.equal(await p.locator('#peekSvg polygon').count(),0);return '体块隐藏，实时面板收起，投影面数 0。'},'没有旧部件预览残留。');
await report('刷新验证','已删除全部部件的副本','重新加载页面，再读部件数量。',async()=>{await p.reload();await p.waitForSelector('#shapeShell:not([hidden])');assert.equal(await count(),0);return '刷新后部件数 0'},'空状态已保存。');
await report('窄屏空状态','390 × 844','在空项目下再次测量页面宽度。',async()=>{await p.setViewportSize({width:390,height:844});const b=await bounds();assert.equal(b.页面宽度,390);return b},'空状态无横向溢出。');
await report('检查浏览器异常','从打开文件台开始收集的 pageerror','统计整段操作中的页面脚本错误。',async()=>{assert.equal(errors.length,0);return '脚本错误 0 条'},'浏览器流程通过。');
await report('清理测试副本',pid,'仅删除本轮新建项目，核查项目清单。',async()=>{await p.goto(origin+'/files.html');await p.waitForFunction(()=>window.WuyingProjects?.remove);await p.evaluate(id=>WuyingProjects.remove(id),pid);cleaned=true;await p.reload();await p.waitForFunction(()=>window.WuyingProjects?.get);assert(!await p.evaluate(id=>!!WuyingProjects.get(id),pid));return '测试副本已移除。'},'临时数据清理完成。');
await report('复核原稿',original+'/'+aid,'重新读取原稿画布，比较首尾 SHA-256 摘要。',async()=>{const a=await read(original),end=hash(a);assert.equal(end,before);return {开始:before,结束:end,部件:a.draft.parts.length}},'原稿与开始时一致。');
await report('运行全量回归','正式平台目录下各 test-*.cjs','执行 node --test --test-reporter=spec，保留每个用例的返回。',async()=>{const tests=fs.readdirSync(root).filter(x=>/^test-.*\.cjs$/.test(x));return execFileSync(process.execPath,['--test','--test-reporter=spec',...tests],{cwd:root,encoding:'utf8',maxBuffer:4e6})},'回归命令以状态码 0 结束。',false);
await report('最终结论','以上各步的实际结果','统计本轮验证并保留每步截图和原始回归输出。',async()=>({此前通过步骤:record.steps.filter(s=>s.ok).length,失败:record.steps.filter(s=>!s.ok).length,原稿摘要:before}),'本轮实时辅助、布局、角度球和删除流程通过；原稿已核对。',false);
record.status='已完成';save();
}catch(e){record.status='执行中断';save();throw e}
finally{if(pid&&!cleaned)await p.evaluate(id=>WuyingProjects.remove(id),pid).catch(()=>{});await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
