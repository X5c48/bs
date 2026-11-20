(() => {
  'use strict';

  const perSourceLimit=6, projectLimit=18;

  function limited(records){
    const seen=new Set(), counts=new Map();
    return records.filter(record=>record.blob instanceof Blob)
      .sort((a,b)=>b.created-a.created)
      .filter(record=>{
        const count=counts.get(record.scope)||0;
        if(seen.has(record.id)||count>=perSourceLimit)return false;
        seen.add(record.id);
        counts.set(record.scope,count+1);
        return true;
      }).slice(0,projectLimit);
  }

  function create(name,changed){
    let entries=[],disposed=false,storage='loading';
    function merge(records){
      if(disposed)return;
      const previous=new Map(entries.map(entry=>[entry.id,entry]));
      entries=limited([...records,...entries]).map(record=>{
        const existing=previous.get(record.id);
        previous.delete(record.id);
        return existing||{...record,src:URL.createObjectURL(record.blob)};
      });
      for(const entry of previous.values())URL.revokeObjectURL(entry.src);
      changed();
    }

    const database=new Promise(resolve=>{
      try{
        const open=indexedDB.open(name,1);
        open.onupgradeneeded=()=>open.result.createObjectStore('renders',{keyPath:'id'});
        open.onsuccess=()=>{
          const db=open.result;
          db.onversionchange=()=>db.close();
          resolve(db);
        };
        open.onerror=open.onblocked=()=>resolve(null);
      }catch{resolve(null);}
    });
    function sessionOnly(){
      storage='session';
      if(!disposed)changed();
    }
    database.then(db=>{
      if(!db){sessionOnly();return;}
      if(disposed)return;
      const tx=db.transaction('renders','readonly');
      const request=tx.objectStore('renders').getAll();
      request.onsuccess=()=>{
        if(storage==='loading')storage='device';
        merge(request.result);
      };
      tx.onerror=tx.onabort=sessionOnly;
    }).catch(sessionOnly);

    return {
      add(record){
        merge([record]);
        database.then(db=>{
          if(!db||disposed)return;
          const tx=db.transaction('renders','readwrite'), store=tx.objectStore('renders');
          tx.onerror=tx.onabort=sessionOnly;
          store.put(record);
          const read=store.getAll();
          read.onsuccess=()=>{
            const keep=new Set(limited(read.result).map(entry=>entry.id));
            for(const entry of read.result)if(!keep.has(entry.id))store.delete(entry.id);
          };
        }).catch(sessionOnly);
      },
      list:scope=>scope===undefined?[...entries]:entries.filter(entry=>entry.scope===scope),
      storage:()=>storage,
      dispose(){
        disposed=true;
        for(const entry of entries)URL.revokeObjectURL(entry.src);
        entries=[];
        database.then(db=>db?.close());
      }
    };
  }

  window.WuyingFlowResults={create};
})();
