(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const media = file => 'media/' + file;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const clamp = value => Math.min(1,Math.max(0,value));
  const origin = 'https://vizcom.com';
  const nav = [
    ['Product', [['Overview','/product'],['Download','/download']],0],
    ['Solutions', [['Industrial Design','/solutions/industrial-design'],['Footwear','/solutions/footwear'],['Gaming','/solutions/gaming'],['Apparel','/solutions/apparel'],['Automotive','/solutions/automotive'],['Enterprise','/enterprise']],1],
    ['Programs', [['Vizcom for Students','/programs/students'],['Vizcom for Educators','/programs/educators'],['Challenges','/challenges']],0],
    ['Resources', [['University','/university'],['Documentation','https://docs.vizcom.com/'],['Case Studies','/case-studies'],['Blog','/blog'],['Careers','/careers']],2],
    ['Pricing','/pricing'], ['Contact','/contact']
  ];
  const shell = document.querySelector('.nav-shell'), flyout = $('navFlyout'), menu = $('menuToggle');
  const navTriggers = [];
  let navIndex = -1, navTimer;
  const isMobile = () => matchMedia('(max-width:700px)').matches;

  function openNav(index) {
    clearTimeout(navTimer);
    navIndex = index;
    for (const item of navTriggers) item.button.setAttribute('aria-expanded',String(item.index===index));
    flyout.hidden = index<0;
    if (index<0) return;
    const [,links,picture] = nav[index];
    const list = document.createElement('ul');
    for (const [label,href] of links) {
      const row = document.createElement('li'), link = document.createElement('a');
      link.textContent = label;
      link.href = new URL(href,origin).href;
      row.append(link);
      list.append(row);
    }
    const image = new Image();
    image.src = media('nav-'+picture+'.webp');
    image.alt = '';
    flyout.replaceChildren(list,image);
    if (isMobile()) navTriggers.find(item => item.index===index).button.after(flyout);
    else shell.append(flyout);
  }

  nav.forEach(([label,value],index) => {
    const trigger = document.createElement(Array.isArray(value)?'button':'a');
    trigger.textContent = label;
    if (Array.isArray(value)) {
      trigger.type = 'button';
      trigger.setAttribute('aria-controls','navFlyout');
      trigger.setAttribute('aria-expanded','false');
      trigger.addEventListener('pointerenter',() => {if (!isMobile()) openNav(index);});
      trigger.onclick = event => openNav(navIndex===index && (isMobile() || event.detail===0)?-1:index);
      trigger.addEventListener('keydown',event => {
        if (event.key!=='ArrowDown') return;
        event.preventDefault();
        openNav(index);
        flyout.querySelector('a')?.focus();
      });
      navTriggers.push({button:trigger,index});
    } else trigger.href = origin+value;
    $('navGroups').append(trigger);
  });
  shell.addEventListener('pointerenter',() => clearTimeout(navTimer));
  shell.addEventListener('pointerleave',() => {if (!isMobile()) navTimer=setTimeout(() => openNav(-1),120);});
  menu.onclick = () => {
    const open = shell.dataset.open!=='true';
    shell.dataset.open = String(open);
    menu.setAttribute('aria-expanded',String(open));
    if (!open) openNav(-1);
  };
  document.addEventListener('keydown',event => {
    if (event.key!=='Escape' || (navIndex<0&&shell.dataset.open!=='true')) return;
    const trigger = navTriggers.find(item => item.index===navIndex)?.button;
    if (isMobile()) {
      shell.dataset.open='false';
      menu.setAttribute('aria-expanded','false');
      menu.focus();
    } else trigger?.focus();
    openNav(-1);
  });
  window.addEventListener('resize',() => {if (navIndex>=0) openNav(navIndex);});

  const slides = [0,2,1].map((id,index) => {
    const article = document.createElement('div');
    article.className = 'hero-slide';
    const drawing = new Image(), render = new Image();
    drawing.alt = ['Car sketch','Chair sketch','Jacket sketch'][index];
    drawing.src = media('hero-line-'+id+'.avif');
    render.alt = '';
    render.src = media('hero-render-'+id+'.avif');
    drawing.draggable = render.draggable = false;
    article.append(drawing,render);
    $('heroSlides').append(article);
    return article;
  });
  const labels = ['car','chair','jacket'];
  const hero = $('hero'), heroReel = $('heroReel');
  let activeSlide = 0, heroPointer, heroCut = 0, heroMoved = false;
  function showSlide(index) {
    activeSlide = (index+slides.length)%slides.length;
    heroCut = 0;
    $('heroInput').value = 'Make this '+labels[activeSlide]+' real';
    slides.forEach((slide,i) => {
      const offset = (i-activeSlide+4)%3-1;
      const wrapped = slide.dataset.offset!==undefined && Math.abs(Number(slide.dataset.offset)-offset)>1;
      slide.classList.toggle('is-wrap',wrapped);
      slide.dataset.offset=offset;
      slide.style.setProperty('--offset',offset);
      slide.dataset.active = String(i===activeSlide);
      slide.setAttribute('aria-hidden',String(i!==activeSlide));
    });
    requestUpdate();
  }
  $('heroPrev').onclick = () => showSlide(activeSlide-1);
  $('heroNext').onclick = () => showSlide(activeSlide+1);
  $('heroPrompt').onsubmit = event => {event.preventDefault();heroCut=heroCut<.85?1:0;requestUpdate();};
  heroReel.addEventListener('keydown',event => {
    if (event.target!==heroReel) return;
    if (event.key==='ArrowLeft' || event.key==='ArrowRight') {
      event.preventDefault();
      showSlide(activeSlide+(event.key==='ArrowLeft'?-1:1));
    }
  });
  heroReel.onpointerdown = event => {
    if (event.button!==0 || event.target.closest('button')) return;
    heroPointer = {id:event.pointerId,x:event.clientX,y:event.clientY};
    heroReel.setPointerCapture(event.pointerId);
  };
  heroReel.onpointerup = event => {
    if (heroPointer?.id!==event.pointerId) return;
    const dx = event.clientX-heroPointer.x, dy = event.clientY-heroPointer.y;
    if (Math.abs(dx)>40 && Math.abs(dx)>Math.abs(dy)) showSlide(activeSlide+(dx<0?1:-1));
    else if (Math.abs(dx)<9&&Math.abs(dy)<9) {heroCut = heroCut>.1?0:.56;requestUpdate();}
  };
  heroReel.onlostpointercapture = () => {heroPointer=null;};
  heroReel.onpointermove = event => {
    if (reduced.matches || event.pointerType!=='mouse' || heroPointer) return;
    const offset = (event.clientX / innerWidth - .5) * 10;
    $('heroSlides').style.transform = 'translateX('+offset.toFixed(1)+'px)';
    heroMoved = true;
  };
  heroReel.onpointerleave = () => {
    if (heroMoved) $('heroSlides').style.transform = '';
  };

  const logoLabels = ['Dell','New Balance','Ford','Electrolux','Brooks','Hasbro','Hasbro','Also','Amcor','Bark','Bass Pro Shops','Bissell','Breville Sage','Canon','Coloplast','Columbia','DAF','Dainese','Dart','Deep','DLR Group','Dorel Juvenile','Ekornes','Fourthcrown','Foxtail','Generac'];
  const logos = document.createElement('div');
  logos.className = 'marquee-group';
  logoLabels.forEach((label,index) => {
    const image = new Image();
    image.src = media('logo-'+index+'.svg'); image.alt = label;
    logos.append(image);
  });
  const logoCopy = logos.cloneNode(true);
  logoCopy.setAttribute('aria-hidden','true');
  const marqueeTrack = document.createElement('div');
  marqueeTrack.className = 'marquee-track';
  marqueeTrack.append(logos,logoCopy);
  $('marquee').append(marqueeTrack);

  const story = $('story'), studio = $('studioScene'), iterate = $('iterateScene'), real = $('realScene');
  const buttons = [...story.querySelectorAll('[data-step-button]')];
  const stageAnchors = ['demo-sketch','demo-render','demo-iterate','demo-real'];
  const steps = [0,.11,.35,.64,1];
  const renderImages = [4,4,4,4].map(value => 'layer-'+value+'.webp');
  const layerNames = ['Canvas','Sketch','Color Block','Highlights','Render'];
  const shoeBase = $('shoeBase'), shoeReveal = $('shoeReveal'), shoeVideo = $('shoeVideo');
  const layerList = $('layerList'), resultTiles = $('resultTiles');
  const variantTiles = [];
  let raf = 0, stage = 0, layerKey = '', resultKey = '', variant = 13;
  let layerChoice = null, assets = false, pickedResult = -1, playbackStart = 0, batchStart = 0, formMode = false;
  let replayed = false, batchReady = false;

  function assign(image,file) {
    if (image.getAttribute('src')!==media(file)) image.src=media(file);
  }
  function timeLength() {return Math.max(1,story.offsetHeight-innerHeight);}
  function stageScroll(index,at=0.03,instant=false) {
    const y = story.getBoundingClientRect().top+scrollY;
    const percent = steps[index]+(steps[index+1]-steps[index])*at;
    window.scrollTo({top:y+timeLength()*percent+1,behavior:instant||reduced.matches?'instant':'smooth'});
    requestUpdate();
  }

  buttons.forEach((button,index) => {
    button.onclick = () => {
      history.replaceState(null,'','#'+stageAnchors[index]);
      layerChoice=null;
      stageScroll(index,index===2?.42:index===3?.55:.09);
    };
    button.onkeydown = event => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key==='Home'?0:event.key==='End'?3:(index+(event.key==='ArrowLeft'?3:1))%4;
      buttons[next].focus();
      buttons[next].click();
    };
  });

  function syncLayers(count) {
    const key = [count,layerChoice,assets].join('|');
    if (key===layerKey) return;
    layerKey = key;
    const entries = [];
    for (let layer=count;layer>=0;layer--) {
      if (assets && layer===0) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'layer-entry';
      button.setAttribute('aria-pressed',String(layer===layerChoice));
      const eye = document.createElement('span');
      eye.className = 'layer-state';
      eye.textContent = layerChoice===layer?'◉':'⊙';
      const image = layer===0 ? document.createElement('b') : new Image();
      if (layer===0) image.className = 'blank-chip';
      else {image.src = media('layer-'+layer+'.webp');image.alt='';}
      const text = document.createElement('span'), opacity = document.createElement('span');
      text.textContent = layerNames[layer];
      opacity.textContent = layer===0?'Settings':'N 100% ﹀';
      text.append(opacity);
      button.append(eye,image,text);
      button.onclick = () => {layerChoice=layerChoice===layer?null:layer;requestUpdate();};
      entries.push(button);
    }
    layerList.replaceChildren(...entries);
  }
  $('tabLayers').onclick = () => toggleAssets(false);
  $('tabAssets').onclick = () => toggleAssets(true);
  function toggleAssets(value) {
    assets = value;
    $('tabLayers').setAttribute('aria-pressed',String(!assets));
    $('tabAssets').setAttribute('aria-pressed',String(assets));
    requestUpdate();
  }

  function syncResults(count) {
    const key = [count,pickedResult].join('|');
    if (key===resultKey) return;
    resultKey = key;
    $('resultCount').value = count+'/4';
    $('resultProgress').value = count;
    resultTiles.replaceChildren(...renderImages.map((file,index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label','Render result '+(index+1));
      button.setAttribute('aria-pressed',String(pickedResult===index));
      button.disabled = index>=count;
      if (!button.disabled) {
        const image = new Image();
        image.src = media(file);image.alt='';
        button.append(image);
        button.onclick = () => {pickedResult=index;layerChoice=null;requestUpdate();};
      }
      return button;
    }));
  }
  $('examplePrompt').onclick = () => {$('renderPrompt').value='Studio photograph of a neutral mesh and suede running shoe';$('renderPrompt').focus();};
  $('resetPrompt').onclick = () => {$('renderPrompt').value='';pickedResult=-1;layerChoice=null;requestUpdate();};
  $('verbs').onclick = event => {
    const button = event.target.closest('button');
    if (!button) return;
    $('renderPrompt').value = button.textContent.replace('…',' ');
    $('renderPrompt').focus();
  };
  $('renderDemo').onsubmit = event => {
    event.preventDefault();
    layerChoice=null;pickedResult=-1;replayed=false;
    playbackStart = performance.now();
    stageScroll(1,.02,true);
  };
  $('showVariations').onclick = () => buttons[2].click();

  for (let i=0;i<28;i++) {
    const button = document.createElement('button');
    const thumb = new Image();
    thumb.src = media('variant-'+i+'.webp');
    thumb.alt = '';
    button.type = 'button';
    button.setAttribute('aria-label','Colorway '+(i+1));
    button.setAttribute('aria-pressed','false');
    button.append(thumb);
    button.onclick = () => {
      variant = i;
      variantTiles.forEach((tile,j) => tile.setAttribute('aria-pressed',String(j===i)));
      assign($('chosenImage'),'variant-'+i+'.webp');
    };
    variantTiles.push(button);
    $('variantWall').append(button);
    const preview = thumb.cloneNode();
    preview.loading = 'lazy';
    $('realGallery').append(preview);
  }
  variantTiles[variant].setAttribute('aria-pressed','true');
  const formButton = $('variationModes').firstElementChild, colorButton = $('variationModes').lastElementChild;
  $('variationModes').onclick = event => {
    if (!event.target.closest('button')) return;
    formMode = event.target===formButton;
    formButton.setAttribute('aria-pressed',String(formMode));
    colorButton.setAttribute('aria-pressed',String(!formMode));
    $('generateVariations').textContent = formMode?'Explore form':'Generate';
  };
  $('generateVariations').onclick = () => {
    if (formMode) {
      $('formPad').scrollIntoView({behavior:reduced.matches?'instant':'smooth',block:'center'});
      $('formPad').focus({preventScroll:true});
      return;
    }
    batchReady = false;
    batchStart = performance.now();
    requestUpdate();
  };

  function play(video) {if (video.paused) video.play().catch(() => {});}
  $('shoeAnimate').onsubmit = event => {
    event.preventDefault();
    const delay = reduced.matches?0:240;
    stageScroll(3,.57,true);
    setTimeout(() => {shoeVideo.currentTime=0;play(shoeVideo);},delay);
  };
  $('expandVideo').onclick = () => {
    $('videoDialog').showModal();
    play($('fullVideo'));
  };
  $('closeVideo').onclick = () => $('videoDialog').close();
  $('videoDialog').addEventListener('close',() => $('fullVideo').pause());
  $('videoDialog').addEventListener('click',event => {if(event.target===$('videoDialog')) $('videoDialog').close();});

  const chairImage = $('chairImage'), chairVideo = $('chairVideo');
  function showChair(index) {
    chairVideo.pause();
    chairVideo.hidden = true;
    chairImage.hidden = false;
    assign(chairImage,'chair-'+index+'.webp');
  }
  function paletteButtons(parent,colors) {
    colors.forEach(({name,file,color,index}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label',name);
      button.setAttribute('aria-pressed','false');
      if (file) {
        const img = new Image();
        img.src = media(file);img.alt='';
        button.append(img);
      } else button.style.backgroundColor = color;
      button.onclick = () => {
        for (const sibling of parent.children) sibling.setAttribute('aria-pressed',String(sibling===button));
        showChair(index);
      };
      parent.append(button);
    });
  }
  paletteButtons($('chairPalette'),[0,1,2,3].map((index)=>({index,name:['Original','Sculpted','Technicolor','Studio'][index],file:'palette-'+index+'.png'})));
  paletteButtons($('chairColors'),['#ac431e','#92365e','#d7dca0','#ffc843'].map((color,i)=>({index:8+i,color,name:['Terracotta','Plum','Mint','Yellow'][i]})));
  const chairModes = $('chairModes'), formPad = $('formPad');
  let pad = [.5,.5], chairMode = 1;
  function updatePad(x,y) {
    pad = [clamp(x),clamp(y)];
    formPad.style.setProperty('--x',pad[0]*100+'%');
    formPad.style.setProperty('--y',pad[1]*100+'%');
    const quadrant = Number(pad[0]>.5)+2*Number(pad[1]>.5);
    showChair([8,4,0][chairMode]+quadrant);
  }
  function pointerOnPad(event) {
    const rect = formPad.getBoundingClientRect();
    updatePad((event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height);
  }
  formPad.onpointerdown = event => {
    if (event.button!==0) return;
    formPad.setPointerCapture(event.pointerId);
    pointerOnPad(event);
  };
  formPad.onpointermove = event => {if (formPad.hasPointerCapture(event.pointerId)) pointerOnPad(event);};
  formPad.onkeydown = event => {
    const move = {ArrowLeft:[-.25,0],ArrowRight:[.25,0],ArrowUp:[0,-.25],ArrowDown:[0,.25]}[event.key];
    if (!move) return;
    event.preventDefault();
    updatePad(pad[0]+move[0],pad[1]+move[1]);
  };
  chairModes.onclick = event => {
    const button = event.target.closest('button');
    if (!button) return;
    const modes = [...chairModes.children];
    chairMode = modes.indexOf(button);
    modes.forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
    updatePad(...pad);
  };
  const moods = ['Angry','Happy','Surprised','Silly','Calm','Indifferent'];
  $('chairMood').oninput = event => {
    const index = Number(event.target.value);
    $('moodLabel').value = moods[index];
    showChair(index+12);
  };
  const angles = ['Front','Bottom Front Left','Right','Rear Right','Rear','Rear Left','Left','Front Left'];
  for (const [index,angle] of angles.entries()) $('chairAngle').add(new Option(angle,index));
  $('chairAngle').onchange = event => showChair(Number(event.target.value)+18);
  $('resetChair').onclick = () => showChair(0);
  $('chairAnimate').onsubmit = event => {
    event.preventDefault();
    chairImage.hidden = true;
    chairVideo.hidden = false;
    chairVideo.currentTime = 0;
    play(chairVideo);
  };
  chairVideo.onended = () => showChair(0);

  function updateHero() {
    const progress = clamp(-hero.getBoundingClientRect().top / Math.max(1,hero.offsetHeight-innerHeight));
    const shift = clamp((progress-.45)/.4);
    const cut = Math.max(heroCut,clamp((progress-.27)/.46));
    hero.style.setProperty('--headline',String(1-shift));
    hero.style.setProperty('--head-shift',reduced.matches?'0px':(-shift*100)+'px');
    slides.forEach((slide,index) => {
      const active = index===activeSlide;
      slide.style.setProperty('--cut',active?(cut*100)+'%':'0%');
      slide.style.setProperty('--slide-alpha',active?'1':String(1-shift));
      slide.style.setProperty('--slide-scale',active&&!reduced.matches?1+shift*.28:1);
    });
  }
  function updateStory(now) {
    const box = story.getBoundingClientRect(), duration = timeLength();
    const progress = clamp(-box.top/duration);
    const pinned = box.top<=2 && box.bottom>=innerHeight-2;
    if (document.body.dataset.pinned!==String(pinned)) {
      document.body.dataset.pinned=String(pinned);
      if (pinned) openNav(-1);
    }
    const oldStage = stage;
    stage = steps.slice(0,4).findLastIndex(start=>progress>=start);
    if (oldStage!==stage) {
      if (!playbackStart) layerChoice=null;
      if (stage!==1) {playbackStart=0;replayed=false;pickedResult=-1;}
      if (stage!==2) {batchStart=0;batchReady=false;}
    }
    story.dataset.step=stage;
    const part = clamp((progress-steps[stage])/(steps[stage+1]-steps[stage]));
    for (const [index,button] of buttons.entries()) {
      button.setAttribute('aria-selected',String(index===stage));
      button.tabIndex=index===stage?0:-1;
      const fill = index<stage?1:index===stage?Math.max(.13,part):0;
      button.style.setProperty('--fill',(fill*100)+'%');
    }
    studio.hidden=stage>1;
    iterate.hidden=stage!==2;
    real.hidden=stage!==3;

    if (stage<=1) {
      const running = playbackStart>0 && stage===1;
      const elapsed = running?clamp((now-playbackStart)/1900):replayed?1:part;
      const fill = stage===1?clamp(elapsed*3.58):0;
      const layer = Math.min(4,1+Math.floor(fill*3));
      const count = stage===1?Math.min(4,Math.floor(clamp((elapsed-.28)/.58)*4)):0;
      syncLayers(layer);
      $('resultPanel').hidden=stage===0;
      syncResults(count);
      const useResult = pickedResult>=0 && stage===1;
      const selectedLayer = layerChoice ?? layer;
      shoeBase.hidden = selectedLayer===0;
      if (!shoeBase.hidden) assign(shoeBase,useResult?renderImages[pickedResult]:'layer-'+selectedLayer+'.webp');
      shoeReveal.hidden = stage===0 || layerChoice!==null || layer>=4 || useResult;
      if (!shoeReveal.hidden) assign(shoeReveal,'layer-'+(layer+1)+'.webp');
      story.style.setProperty('--reveal',(fill*3%1*100)+'%');
      story.style.setProperty('--cue',running?'0':'1');
      if (running && elapsed===1) {playbackStart=0;replayed=true;}
    } else if (stage===2) {
      const count = batchStart ? Math.min(28,Math.floor((now-batchStart)/38)+1) : batchReady?28:Math.min(28,Math.floor(part*39)+1);
      for (const [i,tile] of variantTiles.entries()) {
        const waiting = i>=count;
        tile.classList.toggle('is-waiting',waiting);
        tile.disabled=waiting;
      }
      if (batchStart&&count===28) {batchStart=0;batchReady=true;}
    } else {
      assign($('chosenImage'),'variant-'+variant+'.webp');
      const show = clamp((part-.14)/.30);
      real.style.setProperty('--travel',reduced.matches?'0px':(1-show)*-12+'vw');
      real.style.setProperty('--motion-slide',reduced.matches?'0px':(1-show)*18+'vw');
      real.style.setProperty('--motion-in',String(show));
      real.dataset.focused = String(part>.82);
      if (pinned&&show>.55&&!reduced.matches) play(shoeVideo);
    }
    if ((stage!==3 || !pinned) && !shoeVideo.paused) shoeVideo.pause();
    if ((playbackStart&&stage===1)||(batchStart&&stage===2)) requestUpdate();
  }
  function update(now) {
    raf=0;
    updateHero();
    updateStory(now);
  }
  function requestUpdate() {
    if (!raf) raf=requestAnimationFrame(update);
  }
  window.addEventListener('scroll',requestUpdate,{passive:true});
  window.addEventListener('resize',requestUpdate,{passive:true});
  window.addEventListener('hashchange',() => {
    const index=stageAnchors.indexOf(location.hash.slice(1));
    if (index>=0) stageScroll(index,index===3?.55:.06,true);
  });
  window.addEventListener('load',() => {
    const index=stageAnchors.indexOf(location.hash.slice(1));
    if (index>=0) stageScroll(index,index===3?.55:.06,true);
  },{once:true});
  showSlide(0);
})();
