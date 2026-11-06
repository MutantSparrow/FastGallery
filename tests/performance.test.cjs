const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../fast-gallery.html'), 'utf8').replaceAll('\r', '');
const shim = fs.readFileSync(path.join(__dirname, '../desktop/src/shim.js'), 'utf8');
function source(from, to) {
  const start = html.indexOf(from), end = html.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, 'Source section exists');
  return html.slice(start, end);
}
const tick = () => new Promise(setImmediate);
function classes(...initial) {
  const values = new Set(initial);
  return { contains:n=>values.has(n), add:(...ns)=>ns.forEach(n=>values.add(n)),
    remove:(...ns)=>ns.forEach(n=>values.delete(n)), toggle:(n,on)=>on?values.add(n):values.delete(n) };
}
function shimHarness() {
  const calls = [], pending = [], blobs = [];
  const invoke = (command, args) => new Promise(resolve => { calls.push({command,args}); pending.push(resolve); });
  const context = vm.createContext({ Blob, File, DOMException, AbortController, setTimeout,
    console:{log(){}}, indexedDB:{open:()=>({})},
    URL:{createObjectURL:b=>{blobs.push(b);return 'blob:synthetic';}},
    window:{__TAURI__:{core:{invoke},event:{listen(){}}},dispatchEvent(){}} });
  vm.runInContext(shim, context);
  return {api:context.window,calls,pending,blobs};
}

test('native decodes are serialized and a viewer overtakes queued thumbnails', async () => {
  const h = shimHarness();
  const a = h.api.__fgThumbUrl('root','first.png',512);
  const b = h.api.__fgThumbUrl('root','next.png',512);
  const preview = h.api.__fgPreviewUrl('root','current.png',4096,16000000);
  assert.equal(h.calls.length,1);
  assert.equal(h.api.__fgDecodeStats().queued,2);
  h.pending.shift()(new Uint8Array([1])); await a; await tick();
  assert.equal(h.calls[1].command,'fs_preview');
  h.pending.shift()(new Uint8Array([2])); await preview; await tick();
  assert.equal(h.blobs[1].type,'image/png');
  assert.equal(h.calls[2].args.rel,'next.png');
  h.pending.shift()(new Uint8Array([3])); await b; await tick();
  assert.equal(h.api.__fgDecodeStats().active,0);
});

test('obsolete queued work is removed and canceled active work produces no URL', async () => {
  const h = shimHarness(), first = new AbortController(), queued = new AbortController();
  const a = h.api.__fgThumbUrl('root','first.png',512,{signal:first.signal});
  const b = h.api.__fgThumbUrl('root','old.png',512,{signal:queued.signal});
  queued.abort(); first.abort();
  assert.equal(await b,''); assert.equal(h.api.__fgDecodeStats().queued,0);
  h.pending.shift()(new Uint8Array([1])); assert.equal(await a,''); await tick();
  assert.equal(h.calls.length,1); assert.equal(h.blobs.length,0);
});

function viewerHarness(overrides = {}) {
  const entry = {name:'large.png',ext:'png',size:40000000,handle:{_rootId:'root',_rel:'large.png'}};
  const events = {reads:0,bitmaps:0,native:[],revoked:[],badges:[]};
  const c = vm.createContext({ Blob, DOMException, AbortController,
    window:{devicePixelRatio:1,__fgPreviewUrl:async(...args)=>{events.native.push(args);return 'blob:preview';}},
    URL:{revokeObjectURL:u=>events.revoked.push(u)},
    files:[entry],dims:[{w:12000,h:26000}],fileGeneration:1,currentIndex:0,
    isValidIndex:i=>Number.isInteger(i) && i>=0 && i<c.files.length,
    viewer:{classList:classes('open')},viewerBadge:{classList:classes()},
    hasViewerCanvas:true,PREVIEW_MAX_DIM:8192,PREVIEW_MAX_PIXELS:16000000,PREVIEW_OVERSAMPLE:2,FULLRES_MAX_PIXELS:96000000,
    stageRect:()=>({w:1920,h:1080}),
    bmp:null,bmpW:1,bmpH:1,isFullRes:false,fullResLimited:false,
    thumbUrlByIdx:new Map(),
    getFileForEntry:async()=>{events.reads++;return new Blob(['synthetic']);},
    fetch:async()=>({blob:async()=>new Blob(['synthetic'])}),
    createImageBitmap:async()=>{events.bitmaps++;return {width:2048,height:1024,close(){}};},
    computeBaseScale:()=>1,drawViewer(){},updateViewerButtons(){},onFileAccessError(){},
    ...overrides });
  vm.runInContext(source('function createDecodeWorker()', 'function updateViewerButtons('),c);
  return {c,events,entry};
}

test('huge desktop viewer previews never request original file bytes', async () => {
  const {c,events} = viewerHarness();
  await c.startDecode(0,false);
  assert.equal(events.reads,0); assert.equal(events.native.length,1);
  assert(events.native[0][3] <= 16000000);
  assert(events.native[0][2] <= 8192);
  assert.equal(c.bmp.width,2048); assert.equal(c.isFullRes,false);
  assert.deepEqual(events.revoked,['blob:preview']);
  assert.equal(c.viewer.classList.contains('loading'),false);
});

test('native preview failure does not retry the huge original in Chromium', async () => {
  const {c,events} = viewerHarness();
  c.window.__fgPreviewUrl = async()=>'';
  await c.startDecode(0,false);
  assert.equal(events.reads,0); assert.equal(events.bitmaps,0);
  assert.equal(c.viewerBadge.textContent,'Preview unavailable');
});

test('a cached thumbnail remains visible while a larger preview is decoding', async () => {
  let resolveNative;
  const {c}=viewerHarness();
  c.thumbUrlByIdx.set(0,'blob:cached');
  c.window.__fgPreviewUrl=()=>new Promise(r=>{resolveNative=r;});
  const pending=c.startDecode(0,false); await tick();
  assert(c.bmp); assert.equal(c.viewer.classList.contains('loading'),true);
  resolveNative('blob:preview'); await pending;
  assert.equal(c.viewer.classList.contains('loading'),false);
});

test('full-resolution target respects both pixel and edge limits', () => {
  const {c} = viewerHarness();
  for (const [w,h] of [[12000,26000],[32768,1000],[20000,20000],[400,800]]) {
    c.dims=[{w,h}]; const target=c.computeDecodeTarget(0,true);
    assert(target.rw*target.rh <= 96000000);
    assert(Math.max(target.rw,target.rh) <= 16384);
    assert(target.rw<=w && target.rh<=h);
  }
});

test('large animation overlays cannot bypass the viewer pixel budget', () => {
  const c=vm.createContext({files:[{ext:'gif'},{ext:'webp',size:1000}],dims:[{w:12000,h:26000},{w:400,h:800}],
    PREVIEW_MAX_PIXELS:16000000,isValidIndex:i=>i===0||i===1});
  vm.runInContext(source('function useImgOverlay(', 'function hideImgOverlay('),c);
  assert.equal(c.useImgOverlay(0),false); assert.equal(c.useImgOverlay(1),true);
  c.dims[0]={w:400,h:800}; assert.equal(c.useImgOverlay(0),true);
});

test('a capped full-resolution request records that further retries cannot add detail', async () => {
  const {c}=viewerHarness();
  await c.startDecode(0,true);
  assert.equal(c.fullResLimited,true); assert.equal(c.isFullRes,false);
  assert.match(c.viewerBadge.textContent,/^Capped /);
});

test('ordinary browser decode failure reaches the native rescue path', async () => {
  let attempts=0;
  const {c,events}=viewerHarness({createImageBitmap:async()=>{
    if(++attempts===1) throw new Error('Synthetic browser failure');
    return {width:400,height:800,close(){}};
  }});
  c.files[0].size=10; c.dims=[{w:400,h:800}];
  await c.startDecode(0,false);
  assert.equal(attempts,2); assert.equal(events.native.length,1);
  assert.equal(c.bmp.width,400);
});

test('a closed viewer does not start a worker after a late file read', async () => {
  let resolveFile;
  const {c,events} = viewerHarness({getFileForEntry:()=>new Promise(r=>{resolveFile=r;})});
  c.files[0].size=10; c.dims=[{w:400,h:800}];
  const pending=c.startDecode(0,false);
  c.cancelViewerDecode(); c.viewer.classList.remove('open');
  resolveFile(new Blob(['synthetic'])); await pending;
  assert.equal(events.bitmaps,0); assert.equal(c.bmp,null);
});

test('late native results are revoked and cannot change a replacement viewer', async () => {
  let resolveNative;
  const {c,events}=viewerHarness();
  c.window.__fgPreviewUrl=()=>new Promise(r=>{resolveNative=r;});
  const pending=c.startDecode(0,false);
  c.cancelViewerDecode(); c.fileGeneration++; c.files=[{name:'new.png'}];
  resolveNative('blob:obsolete'); await pending;
  assert.equal(c.bmp,null); assert.equal(events.bitmaps,0);
  assert.deepEqual(events.revoked,['blob:obsolete']);
  assert.equal(c.viewer.classList.contains('loading'),true);
});

test('bounded worker decode failure never retries an unrestricted bitmap', async () => {
  const urls=new Map(); let urlId=0;
  const {c}=viewerHarness({Worker:class {terminate(){}},URL:{
    createObjectURL:b=>{const u=`blob:${++urlId}`;urls.set(u,b);return u;},revokeObjectURL(){} }});
  c.window.Worker=true; c.window.createImageBitmap=true;
  const worker=c.createDecodeWorker();
  const calls=[],messages=[];
  const w=vm.createContext({self:{postMessage:m=>messages.push(m)},
    createImageBitmap:async(...args)=>{calls.push(args);throw new Error('Synthetic limit');}});
  vm.runInContext(await urls.get(worker._url).text(),w);
  await w.self.onmessage({data:{reqId:1,file:{},rw:1000,rh:2000}});
  assert.equal(calls.length,1); assert.equal(calls[0][1].resizeWidth,1000);
  assert.equal(messages[0].ok,false);
});

test('late dimensions do not populate a replacement dataset', async () => {
  let resolveDims;
  const c=vm.createContext({files:[{name:'old.png',handle:{_rootId:'old',_rel:'old.png'}}],
    dims:[],dimsP:[],fileGeneration:1,isVideo:()=>false,
    window:{__fgDims:()=>new Promise(r=>{resolveDims=r;})}});
  vm.runInContext(source('async function ensureDims(', '// =====================================================================\n// Prompt extraction'),c);
  const pending=c.ensureDims(0);
  c.files=[{name:'new.png'}]; c.dims=[]; c.dimsP=[]; c.fileGeneration++;
  resolveDims({w:12000,h:26000}); await pending;
  assert.equal(c.dims[0],undefined);
});

test('nested walks retain native stat metadata without reading image files', async () => {
  const c=vm.createContext({IMAGE_EXT_RE:/\.png$/i,extOf:n=>'.png',registerSidecar(){}});
  vm.runInContext(source('async function walkDirectoryFSA(', 'async function restoreLastHandle('),c);
  const file={kind:'file',_size:40000000,_mtimeMs:123,getFile(){throw new Error('Unexpected full read');}};
  const child={kind:'directory',async *entries(){yield ['sample.png',file];}};
  const root={async *entries(){for(let i=0;i<300;i++)yield [`nested-${i}`,child];}};
  const entries=[];
  await c.walkDirectoryFSA(root,b=>entries.push(...b),new AbortController().signal,{});
  assert.equal(entries.length,300); assert.equal(entries[0].size,40000000);
  assert.equal(entries[0].lastModified,123); assert.equal(entries[0].folderLc,'nested-0');
});

test('a superseded nested walk stops at its next batch boundary', async () => {
  const c=vm.createContext({IMAGE_EXT_RE:/\.png$/i,extOf:()=>'.png',registerSidecar(){}});
  vm.runInContext(source('async function walkDirectoryFSA(', 'async function restoreLastHandle('),c);
  const root={async *entries(){for(let i=0;i<1000;i++)yield [`sample-${i}.png`,{kind:'file'}];}};
  const controller=new AbortController(); let count=0;
  await c.walkDirectoryFSA(root,b=>{count+=b.length;controller.abort();},controller.signal,{});
  assert.equal(count,200);
});

test('dimension completion recomputes layout even when there is no second batch', async () => {
  let layouts=0;
  const c=vm.createContext({files:[{},{}],fileGeneration:1,fileWorkAbort:new AbortController(),
    refreshStatus(){},applyFilters(){layouts++;},waitForBackground:async()=>{},ensureDims:async()=>{},setTimeout,clearTimeout});
  vm.runInContext(source('let dimensionLayoutTimer =', 'async function loadViaFSA('),c);
  c.ensureFirstDimsInBackground(2); await tick();
  assert(layouts>=1); assert.equal(c.dimsActive,false); assert.equal(c.dimsDone,2);
});

test('tall overlapping masonry tiles are retained by visibility search', () => {
  const slots=[{top:0,height:4000},...Array.from({length:30},(_,i)=>({top:i*112,height:100}))];
  let bottom=0; for(const s of slots)s.maxBottom=bottom=Math.max(bottom,s.top+s.height);
  const c=vm.createContext({slotsByTop:slots});
  vm.runInContext(source('function firstVisibleSlotIndex(', '// Only the hovered'),c);
  assert.equal(c.firstVisibleSlotIndex(1700),0);
});

test('background scans pause for the viewer and wake on resume or cancellation', async () => {
  const c=vm.createContext({viewer:{classList:classes('open')}});
  vm.runInContext(source('const backgroundWaiters =', 'let multiselect ='),c);
  const signal=new AbortController(); let done=false;
  const pending=c.waitForBackground(signal.signal).then(()=>{done=true;});
  await tick(); assert.equal(done,false);
  c.resumeBackgroundWork(); await pending; assert.equal(done,true);
  const aborted=new AbortController(); const next=c.waitForBackground(aborted.signal);
  aborted.abort(); await next;
  assert.equal(vm.runInContext('backgroundWaiters.size',c),0);
});

test('re-rendering a pending tile does not enqueue duplicate heavy decodes', async () => {
  let calls=0,resolveThumb; const revoked=[];
  const entry={name:'sample.png',handle:{_rootId:'root',_rel:'sample.png'}};
  const c=vm.createContext({files:[entry],fileGeneration:1,AbortController,isVideo:()=>false,isPdf:()=>false,
    window:{__fgThumbUrl:()=>{calls++;return new Promise(r=>{resolveThumb=r;});}},
    thumbUrlByIdx:new Map(),URL:{revokeObjectURL:u=>revoked.push(u)}});
  vm.runInContext(source('function loadThumbForNode(', 'function renderVisible('),c);
  const img={},node={classList:classes(),dataset:{}};
  c.loadThumbForNode(node,0,img); c.loadThumbForNode(node,0,img);
  assert.equal(calls,1);
  node._thumbAbort.abort(); resolveThumb('blob:old'); await tick();
  assert.equal(img.src,undefined); assert.deepEqual(revoked,['blob:old']);
});

function gridHarness() {
  const events={appends:0,removes:0,srcWrites:0,requests:[],revoked:[]};
  const children=new Set();
  const grid={clientWidth:960,style:{},
    appendChild(node){events.appends++;children.add(node);node.parentNode=grid;node.isConnected=true;},
    removeChild(node){events.removes++;children.delete(node);node.parentNode=null;node.isConnected=false;}};
  function makeTileNode() {
    let src=''; const listeners=[];
    const img={get src(){return src;},set src(value){events.srcWrites++;src=value;},
      addEventListener(type,fn){if(type==='load')listeners.push(fn);},
      removeAttribute(name){if(name==='src')src='';},
      fireLoad(){for(const fn of listeners.splice(0))fn();}};
    const fields=new Map([['img.thumb',img],['.num',{}],['.dim',{}],['.fchip',{}],['.sel',{dataset:{}}]]);
    return {img,dataset:{},style:{},classList:classes(),isConnected:false,parentNode:null,
      querySelector:key=>fields.get(key)};
  }
  const c=vm.createContext({AbortController,grid,makeTileNode,
    files:[0,1,2].map(i=>({name:`sample-${i}.png`,path:`sample-${i}.png`,handle:{_rootId:'root',_rel:`sample-${i}.png`}})),
    view:[0,1,2],dims:[],prompts:[],colors:[],selected:new Set(),favorites:new Set(),
    desiredCols:3,GAP:8,MIN_COL_W:100,fileGeneration:1,hoverPreview:null,
    stopHoverPreview(){},folderOf:()=>'',depthOf:()=>0,fmtDimsFor:i=>c.dims[i]?`${c.dims[i].w}x${c.dims[i].h}`:'',isVideo:()=>false,isPdf:()=>false,
    thumbUrlByIdx:new Map(),rememberThumbUrl(i,url){c.thumbUrlByIdx.set(i,url);},computeColorSignature:()=>null,
    URL:{revokeObjectURL:u=>events.revoked.push(u)},
    window:{scrollY:0,innerHeight:800,scrollTo(x,y){this.scrollY=y;},
      __fgThumbUrl:(root,rel,edge,options)=>new Promise(resolve=>events.requests.push({rel,signal:options.signal,resolve}))}});
  vm.runInContext(source('let slots = [];','// Only the hovered'),c);
  vm.runInContext(source('function applyTileData(','// Cached blob-URL'),c);
  vm.runInContext(source('function loadThumbForNode(','function renderVisible('),c);
  vm.runInContext(source('function renderVisible()',"window.addEventListener('scroll', onScrollOrResize"),c);
  return {c,events,children,mounted:vm.runInContext('mounted',c)};
}

test('dimension updates keep pending and loaded thumbnails mounted without blinking', async () => {
  const {c,events,mounted}=gridHarness();
  c.rebuildLayout(false);
  const nodes=[...mounted.values()];
  c.dims[0]={w:400,h:200}; c.rebuildLayout(false);
  assert.equal(events.requests.length,3);
  assert(events.requests.every(r=>!r.signal.aborted));
  assert.deepEqual([...mounted.values()],nodes);
  assert.equal(nodes[0].style.height,'157px');
  for(const [i,r] of events.requests.entries())r.resolve(`blob:thumb-${i}`);
  await tick(); nodes.forEach(n=>n.img.fireLoad()); await tick();
  for(let i=0;i<4;i++){c.dims[1]={w:200,h:300+i*10};c.rebuildLayout(true);}
  assert.equal(events.removes,0); assert.equal(events.appends,3);
  assert.equal(events.srcWrites,3); assert.equal(events.requests.length,3);
  assert(nodes.every(n=>n.classList.contains('loaded')));
  assert.equal(nodes[0].querySelector('.dim').textContent,'400x200');
});

test('view reordering retains thumbnail identity and filtering still cancels removed tiles', async () => {
  const {c,events,mounted,children}=gridHarness();
  c.rebuildLayout(false);
  const nodes=[...mounted.values()];
  c.view=[2,0,1]; c.rebuildLayout(true);
  for(let i=0;i<3;i++)assert.equal(mounted.get(i),nodes[i]);
  assert.equal(nodes[2].dataset.k,'0'); assert.equal(nodes[0].dataset.k,'1');
  assert.equal(c.saveScrollAnchor().index,2);
  assert.equal(events.removes,0); assert.equal(events.requests.length,3);
  c.view=[2]; c.rebuildLayout(false);
  assert.equal(children.size,1); assert.equal(mounted.get(2),nodes[2]);
  assert.equal(events.removes,2);
  assert(events.requests[0].signal.aborted); assert(events.requests[1].signal.aborted);
  assert.equal(events.requests[2].signal.aborted,false);
  for(const [i,r] of events.requests.entries())r.resolve(`blob:thumb-${i}`);
  await tick();
  assert.deepEqual(events.revoked,['blob:thumb-0','blob:thumb-1']);
  assert.equal(nodes[2].img.src,'blob:thumb-2');
  c.view=[];c.rebuildLayout(false);
  assert.equal(children.size,0);assert.equal(mounted.size,0);
});

test('closed filmstrip rejects late thumbnails and bounds its URL cache', async () => {
  let resolveThumb; const revoked=[];
  const c=vm.createContext({files:[{name:'sample.png',handle:{_rootId:'root',_rel:'sample.png'}}],
    fileGeneration:1,AbortController,isVideo:()=>false,
    URL:{revokeObjectURL:u=>revoked.push(u)},window:{__fgThumbUrl:()=>new Promise(r=>{resolveThumb=r;})}});
  vm.runInContext(source('const FS_CELL_W =', 'function makeFsCell('),c);
  const pending=c.ensureFilmstripThumb(0); c.revokeAllFilmstripUrls();
  resolveThumb('blob:obsolete'); assert.equal(await pending,'');
  assert.equal(vm.runInContext('filmstripUrls.size',c),0);
  for(let i=0;i<260;i++)c.rememberFilmstripUrl(i,`blob:${i}`);
  assert.equal(vm.runInContext('filmstripUrls.size',c),256);
  assert.equal(revoked.length,5);
});
