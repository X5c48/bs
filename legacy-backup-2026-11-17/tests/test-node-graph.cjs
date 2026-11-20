const { test } = require('node:test');
const assert = require('node:assert/strict');
const graph = require('./dist/node-graph-core.js');
const rules = require('./dist/sketch-rules.js');
const studio = require('./dist/studio-core.js');

test('a preview reads its connected sketch and reconnecting replaces only its own input', () => {
  let state=graph.createGraph('draft-1');
  const primary=graph.findSketch(state,'draft-1');
  const a=state.nodes.find(node=>node.type==='preview');
  const b={id:'preview-2',type:'preview',x:520,y:440,mode:'material'};
  const other={id:'sketch-2',documentId:'draft-2',type:'sketch',x:24,y:460};
  state={...state,nodes:[...state.nodes,b,other]};
  assert.equal(graph.sourceDocument(state,a.id),'draft-1');
  assert.equal(graph.sourceDocument(state,b.id),null);
  state=graph.connect(state,primary.id,b.id);
  state=graph.connect(state,other.id,a.id);
  assert.equal(graph.sourceDocument(state,a.id),'draft-2');
  assert.equal(graph.sourceDocument(state,b.id),'draft-1');
  assert.strictEqual(graph.connect(state,a.id,other.id),state);
  assert.strictEqual(graph.connect(state,a.id,a.id),state);
  state=graph.disconnect(state,a.id);
  assert.equal(graph.sourceDocument(state,a.id),null);
  assert.equal(graph.sourceDocument(state,b.id),'draft-1');
});

test('saved state drops invalid endpoints and missing sketch documents', () => {
  const state=graph.createGraph('draft-1');
  const corrupt={...state,nodes:[...state.nodes,{id:'broken',type:'sketch',documentId:'draft-2',x:Infinity,y:20}],
    links:[...state.links,{from:'broken',to:'preview-1'},{from:'preview-1',to:'preview-1'}]};
  const restored=graph.restoreGraph(corrupt,new Set(['draft-1']));
  assert.equal(restored.nodes.length,2);
  assert.deepEqual(restored.links,state.links);
  const missing=graph.restoreGraph(corrupt,new Set());
  assert.equal(missing.nodes.length,1);
  assert.equal(graph.sourceDocument(missing,'preview-1'),null);
});

test('a preview can combine one visual input with text and safely migrate legacy connections',()=>{
  let state=graph.createGraph('draft-1');
  const nodes=[...state.nodes,{id:'text-1',type:'text',x:5,y:5,prompt:'red lamp'},
    {id:'image-1',type:'image',x:5,y:390,image:null}];
  const legacy={nodes,links:[{from:'sketch-1',to:'preview-1'}],activePreview:'preview-1'};
  state=graph.restoreGraph(legacy,new Set(['draft-1']));
  assert.equal(graph.inputs(state,'preview-1').visual.documentId,'draft-1');
  assert.strictEqual(graph.connect(state,'text-1','preview-1','visual'),state);
  state=graph.connect(state,'text-1','preview-1','text');
  state=graph.connect(state,'image-1','preview-1','visual');
  assert.equal(graph.inputs(state,'preview-1').text.prompt,'red lamp');
  assert.equal(graph.inputs(state,'preview-1').visual.id,'image-1');
  assert.equal(graph.sourceDocument(state,'preview-1'),null);
  state=graph.disconnect(state,'preview-1','visual');
  assert.equal(graph.inputs(state,'preview-1').visual,null);
  assert.equal(graph.inputs(state,'preview-1').text.id,'text-1');
});

test('restoring the model node keeps its position and leaves visual links on their existing input', () => {
  const state=graph.createGraph('draft-1');
  const model={id:'model-1',type:'model',x:900,y:82};
  const restored=graph.restoreGraph({...state,nodes:[...state.nodes,model,{...model,id:'model-2'}]},new Set(['draft-1']));
  assert.deepEqual(restored.nodes.filter(node=>node.type==='model'),[model]);
  assert.deepEqual(restored.links,state.links);
  assert.strictEqual(graph.connect(restored,model.id,'preview-1','visual'),restored);
});

test('the legacy starter link survives when the first draft was never written to storage', () => {
  const legacy=graph.createGraph('missing-starter');
  const docs=new Set(['stable-starter']);
  const restored=graph.restoreGraph(legacy,docs,'stable-starter');
  assert.equal(graph.sourceDocument(restored,'preview-1'),'stable-starter');
  const disconnected=graph.restoreGraph({...legacy,links:[]},docs,'stable-starter');
  assert.equal(graph.sourceDocument(disconnected,'preview-1'),null);
  const userDraft=graph.restoreGraph(legacy,new Set(['actual-user-draft']),'stable-starter');
  assert.equal(graph.sourceDocument(userDraft,'preview-1'),null);
});

test('form mode applies genuine geometry variants and retains the source outline locks', () => {
  const curve=rules.createBase('rounded',true);
  const scene={id:'draft-1',curve,ink:[]};
  const forms=graph.formOptions(scene,rules,studio);
  assert.equal(forms[0].label,'原型');
  assert.ok(forms.length>1);
  assert.ok(forms.some(option=>option.widthChange<0));
  assert.ok(forms.some(option=>option.widthChange>0));
  for(const option of forms.slice(1)){
    for(const index of rules.lockedIndices(curve))assert.deepEqual(option.scene.curve.nodes[index],curve.nodes[index]);
  }
});

test('the recognized freehand contour is replaced for form preview while detail ink is kept', () => {
  const points=pairs=>pairs.map(([x,y])=>({x,y}));
  const stroke={size:2,color:'graphite',points:points([[0,0],[55,0],[55,33],[0,33],[0,1]])};
  const detail={size:2,color:'blue',points:points([[14,12],[39,22]])};
  const forms=graph.formOptions({ink:[stroke,detail]},rules,studio);
  assert.ok(forms.length>1);
  assert.deepEqual(forms[0].scene.ink,[detail]);
  assert.deepEqual(forms[1].scene.ink,[detail]);
  assert.equal(graph.formOptions({ink:[detail]},rules,studio).length,0);
});
