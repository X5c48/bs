'use strict';

const {randomUUID}=require('node:crypto');
const {mkdirSync,readFileSync,renameSync,writeFileSync}=require('node:fs');
const {dirname}=require('node:path');

function createImageProfiles({file,ApiError,publicProfile,keyValue}) {
  const entries=new Map();

  function details(input) {
    const name=typeof input.name==='string'?input.name.trim():'';
    if(!name||name.length>80) throw new ApiError(400,'请输入 1–80 个字符的接口名称。');
    return {name,...publicProfile(input)};
  }

  if(file){
    try {
      const records=JSON.parse(readFileSync(file,'utf8'));
      if(Array.isArray(records)){
        for(const record of records){
          if(!/^[a-f0-9-]{36}$/i.test(record?.id||'')) continue;
          try { entries.set(record.id,{...details(record),id:record.id,key:'',revision:randomUUID()}); }
          catch { /* Skip a malformed saved entry. */ }
        }
      }
    } catch {}
  }

  function describe({key,...profile}) {
    return {...profile,hasKey:!!key,ready:!!key};
  }

  function save(data) {
    const previous=data.id?entries.get(data.id):undefined;
    if(data.id&&!previous) throw new ApiError(404,'该接口已不存在，请重新载入。');
    const profile=details(data), entered=keyValue(data.key);
    const entry={...profile,id:previous?.id||randomUUID(),revision:randomUUID(),
      key:data.clearKey===true?'':entered||(profile.baseUrl===previous?.baseUrl?previous.key:'')};
    if(file){
      const next=new Map(entries);
      next.set(entry.id,entry);
      const records=Array.from(next.values(),({id,name,baseUrl,model,size,edit,imageField})=>({id,name,baseUrl,model,size,edit,imageField}));
      mkdirSync(dirname(file),{recursive:true});
      writeFileSync(file+'.tmp',JSON.stringify(records,null,2));
      renameSync(file+'.tmp',file);
    }
    entries.set(entry.id,entry);
    return describe(entry);
  }

  return {list:()=>Array.from(entries.values(),describe),get:id=>entries.get(id),save};
}

module.exports={createImageProfiles};

