(() => {
  'use strict';
  const params=new URLSearchParams(location.search);
  const requested=params.get('project');
  const demo=params.get('demo')==='1';
  const projects=window.WuyingProjects;
  const id=!demo&&requested!=='legacy'&&projects?.get(requested)?requested:null;
  const redirecting=!demo&&requested!=='legacy'&&!id&&location.protocol!=='file:';
  window.WuyingProjectEntry={id,suffix:id?projects.suffix(id):'',redirecting};
  if(redirecting)location.replace('files.html');
})();
