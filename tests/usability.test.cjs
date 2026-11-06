const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../fast-gallery.html'),'utf8').replaceAll('\r','');
function source(a,b){const start=html.indexOf(a),end=html.indexOf(b,start+a.length);assert(start>=0&&end>start);return html.slice(start,end);}
const tick=()=>new Promise(setImmediate);
test('columns 9 through 12 produce distinct layouts at the desktop minimum width',()=>{
  const c=vm.createContext({grid:{clientWidth:800},GAP:12,desiredCols:9});vm.runInContext(source('function computeLayout()','function computeSlots()'),c);
  const widths=[];for(let n=9;n<=12;n++){c.desiredCols=n;const layout=c.computeLayout();assert.equal(layout.cols,n);widths.push(layout.colW);assert(layout.colW>0);}assert.equal(new Set(widths).size,4);
});
test('zoom can go below fit and pan can bring every image corner to the viewport center, including rotated images',()=>{
  const c=vm.createContext({viewerRotation:0,bmpW:600,bmpH:1000,baseScale:.5,zoomS:2,panX:9999,panY:-9999,stageRect:()=>({w:1200,h:800,left:0,top:0}),clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),ZMIN:.05,ZMAX:32,scheduleDragDraw(){}});
  vm.runInContext(source('function clampPan()','function resizeViewerCanvas()'),c);c.clampPan();assert.equal(c.panX,300);assert.equal(c.panY,-500);
  c.viewerRotation=90;c.panX=9999;c.panY=9999;c.clampPan();assert.equal(c.panX,500);assert.equal(c.panY,300);
  vm.runInContext(source('function zoomAt(','viewerStage.addEventListener(\'wheel\''),c);c.zoomS=1;c.zoomAt(600,400,.5);assert.equal(c.zoomS,.5);
});
test('subfolders default off, migrate the old implicit default and preserve subsequent explicit preferences',()=>{
  for(const [saved,expected] of [[null,false],[{recursive:true},false],[{recursive:true,recursivePreferenceVersion:2},true],[{recursive:false,recursivePreferenceVersion:2},false]]){
    const c=vm.createContext({localStorage:{getItem:()=>saved?JSON.stringify(saved):null}});vm.runInContext(source('const filterState =','function saveFilterState()')+'\nresult=filterState.recursive;',c);assert.equal(c.result,expected);
  }
});
test('slideshow interval supports shorter and longer durations, persists, and restarts a running timer without rewriting input',()=>{
  const intervals=[],saved=[];const c=vm.createContext({slideshowTimer:5,slideshowIntervalMs:3000,slideshowTick(){},clearInterval(){},setInterval:(fn,ms)=>{intervals.push(ms);return 6;},localStorage:{setItem:(k,v)=>saved.push(v)}});
  vm.runInContext(source('function setSlideshowSeconds(','slideshowSeconds.addEventListener('),c);
  assert.equal(c.setSlideshowSeconds(.5),true);assert.equal(c.setSlideshowSeconds(12.5),true);assert.deepEqual(intervals,[500,12500]);assert.deepEqual(saved,['500','12500']);
  for(const n of [0,-1,NaN,3601])assert.equal(c.setSlideshowSeconds(n),false);
});
test('image clipboard encodes original image bounds rather than the viewport, and rejects huge sources before reading bytes',async()=>{
  let reads=0,closed=0,drawn;const canvas={getContext:()=>({drawImage:(...args)=>{drawn=args;}}),toBlob:fn=>fn({type:'image/png'})};
  const c=vm.createContext({files:[{name:'synthetic.png'}],fileGeneration:1,ensureDims:async()=>({w:640,h:960}),getFileForEntry:async()=>{reads++;return {};},createImageBitmap:async()=>({width:640,height:960,close(){closed++;}}),document:{createElement:()=>canvas}});
  vm.runInContext(source('async function clipboardImageBlob(','async function copyCurrentImage()'),c);await c.clipboardImageBlob(0);
  assert.equal(canvas.width,640);assert.equal(canvas.height,960);assert.equal(drawn[1],0);assert.equal(drawn[2],0);assert.equal(closed,1);
  c.ensureDims=async()=>({w:12000,h:26000});await assert.rejects(c.clipboardImageBlob(0));assert.equal(reads,1);
});
test('native fullscreen uses the window API and an exit queued during entry wins',async()=>{
  let native=false,finish;const calls=[],states=[];
  const win={isFullscreen:async()=>native,setFullscreen:on=>{calls.push(on);return new Promise(r=>{finish=()=>{native=on;r();};});}};
  const c=vm.createContext({fullscreenRequested:false,fullscreenRequestId:0,fullscreenWork:Promise.resolve(),window:{__FG_NATIVE__:true,__TAURI__:{window:{getCurrentWindow:()=>win}}},applyFullscreenState:on=>states.push(on),showActionNotice(){}});
  vm.runInContext(source('function setFullscreen(on)','document.addEventListener(\'fullscreenchange\''),c);
  const entering=c.setFullscreen(true);await tick();const exiting=c.setFullscreen(false);finish();await entering;await tick();finish();await exiting;
  assert.deepEqual(calls,[true,false]);assert.equal(native,false);assert.deepEqual(states,[true,false]);
});
test('browser fullscreen calls request/exit and does not pretend success after permission denial',async()=>{
  const states=[],notices=[];const doc={fullscreenElement:null,documentElement:{async requestFullscreen(){doc.fullscreenElement={};}},async exitFullscreen(){doc.fullscreenElement=null;}};
  const c=vm.createContext({fullscreenOn:false,fullscreenRequested:false,fullscreenRequestId:0,fullscreenWork:Promise.resolve(),window:{},document:doc,applyFullscreenState:on=>states.push(on),showActionNotice:s=>notices.push(s)});
  vm.runInContext(source('function setFullscreen(on)','document.addEventListener(\'fullscreenchange\''),c);await c.setFullscreen(true);await c.setFullscreen(false);assert.deepEqual(states,[true,false]);
  doc.documentElement.requestFullscreen=async()=>{throw Error('Synthetic denial');};await c.setFullscreen(true);assert.deepEqual(states,[true,false]);assert.equal(notices.length,1);
});
test('external file open clears old viewer and prepares the new target before presenting the native window',async()=>{
  const events=[];let opened=true;
  const c=vm.createContext({folderLoadingRoot:null,window:{__fgOpenPathAsRoot:async()=>({}),__fgPresent:async()=>events.push('present')},files:[{}],currentRootHandle:{name:'Images',absPath:'Q:/synthetic/Images'},viewer:{classList:{contains:()=>opened}},closeViewer(){opened=false;events.push('clear');},maybeAutoOpenFromBoot:async()=>events.push('target'),reopenBanner:{style:{}},_pendingOpenName:''});
  vm.runInContext(source('let externalOpenId =','window.addEventListener(\'fg-boot-open\''),c);await c.handleFgBootOpen({root:'Q:/synthetic/Images',file:'new.png'});assert.deepEqual(events,['clear','target','present']);
});

test('viewer clears the retained bitmap before waiting for dimensions',async()=>{
  const events=[];let finish;
  const c=vm.createContext({files:[{}],hasViewerCanvas:true,isValidIndex:()=>true,stopHoverPreview(){},cancelViewerDecode(){},viewerOpenId:0,fileGeneration:1,
    viewer:{classList:{contains:()=>true,add(){}}},hideImgOverlay(){},hideVideoOverlay(){},hidePdfOverlay(){},bmp:{old:true},bmpW:600,bmpH:900,
    closeBitmap:()=>events.push('close'),drawViewer:()=>events.push('clear'),currentIndex:0,currentViewPos:0,viewerRotation:0,
    ensureDims:()=>{events.push('wait');return new Promise(r=>{finish=r;});}});
  vm.runInContext(source('async function openViewer(','function closeViewer()'),c);const opening=c.openViewer(0,0);
  assert.deepEqual(events,['close','clear','wait']);assert.equal(c.bmp,null);
  c.fileGeneration++;finish();await opening;
});
