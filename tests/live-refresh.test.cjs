const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../fast-gallery.html'), 'utf8').replaceAll('\r', '');
function source(from, to) {
  const start = html.indexOf(from), end = html.indexOf(to, start + from.length);
  assert(start >= 0 && end > start);
  return html.slice(start, end);
}
const entry = name => ({name, path:name, ext:'png'});
function harness({index = 0, loading = false} = {}) {
  let finishWalk;
  const events = {favoritesReads:0, opened:[], closed:0, decoded:[], filmstrips:0};
  const state = new Set(['open', ...(loading ? ['loading'] : [])]);
  const files = ['01.png', '02.png', '03.png'].map(entry);
  const c = vm.createContext({
    files, dims:files.map(()=>({w:100,h:200})), dimsP:[], prompts:[], promptsP:[], colors:[],
    fileGeneration:1, viewerOpenId:0, currentRootHandle:{name:'synthetic-root'}, currentIndex:index, currentViewPos:index,
    selected:new Set(), favorites:new Set(), rootKey:'synthetic', lastSelectedK:-1,
    deleteInProgress:false, _pendingOpenName:'', viewer:{classList:{contains:n=>state.has(n)}},
    viewerTitle:{}, legacyFavoritesBanner:{style:{}}, sidecarCache:new Map(),
    empty:{style:{}}, document:{body:{classList:{toggle(){}}}}, countEl:{},
    window:{scrollY:0, scrollTo(){}}, filterState:{currentPath:'', favoritesOnly:false},
    filmstripOn:false, prefetchActive:false, prefetchColorsActive:false, slots:[],
    zoomS:2, panX:30, panY:-40, viewerRotation:90, bmp:{retained:true}, isFullRes:false, fullResLimited:false,
    isValidIndex:i=>Number.isInteger(i)&&i>=0&&i<c.files.length,
    invalidateFileWork(){c.fileGeneration++;},
    loadFavoritesFor:async()=>{events.favoritesReads++;return new Set();},
    buildView:()=>c.files.map((_,i)=>i), applyFilters(){c.view=c.buildView();},
    refreshFormatChips(){}, renderFolderStrip(){}, updateSelectionUI(){}, updatePrefetchUI(){}, updatePrefetchColorsUI(){},
    loaderHide(){}, refreshStatus(){}, offerLegacyFavorites:async()=>{}, showQuotaToast(){},
    ensureFirstDimsInBackground(){}, ensureDims:async()=>({w:100,h:200}), saveScrollAnchor:()=>null, resetSidecars(){},
    legacyFavoriteKeysFor:()=>[], fsPanelRefreshTitle(){}, updateFavButton(){},
    renderFilmstrip(){events.filmstrips++;}, renderFilmstripVisible(){}, schedulePrefetchFilmstrip(){},
    updateViewerButtons(){}, useVideoOverlay:()=>false, usesOwnControls:()=>false, useImgOverlay:()=>false,
    startDecode:(...args)=>events.decoded.push(args),
    openViewer(i,k){events.opened.push(c.files[i].path);c.currentIndex=i;c.currentViewPos=k;},
    closeViewer(){events.closed++;state.delete('open');c.currentIndex=-1;},
    setTimeout(){},
    walkDirectoryFSA:(_root,onBatch)=>new Promise(resolve=>{finishWalk=()=>{onBatch(c.incoming);resolve();};}),
  });
  c.view=c.files.map((_,i)=>i);
  c.incoming=[...files,entry('04.png')];
  vm.runInContext(source('async function resetAndLoadFiles(', 'let dimensionLayoutTimer ='),c);
  vm.runInContext(source('let _fgRefreshInFlight = false;', '// Debounce fs-change'),c);
  vm.runInContext(source('function nextInView()', "viewerClose.addEventListener('click'"),c);
  return {c,events,finish:()=>finishWalk()};
}

test('a file arriving while the viewer advances keeps the latest image and Next reaches the new file', async()=>{
  const h=harness(), pending=h.c.refreshFilesFromRoot();
  h.c.currentIndex=2;h.c.currentViewPos=2;
  h.finish();await pending;
  assert.equal(h.c.files[h.c.currentIndex].path,'03.png');
  assert.equal(h.c.currentViewPos,2);assert.match(h.c.viewerTitle.textContent,/^3 \/ 4/);
  assert.equal(h.c.zoomS,2);assert.equal(h.c.panX,30);assert.equal(h.c.panY,-40);assert.equal(h.c.viewerRotation,90);
  assert.equal(h.c.bmp.retained,true);assert.equal(h.events.opened.length,0);
  h.c.nextInView();assert.deepEqual(h.events.opened,['04.png']);
});

test('inserting before the active file remaps its index and filtered navigation position by path', async()=>{
  const h=harness({index:2}), pending=h.c.refreshFilesFromRoot();
  h.c.incoming.unshift(entry('00.png'));
  h.finish();await pending;
  assert.equal(h.c.files[h.c.currentIndex].path,'03.png');assert.equal(h.c.currentIndex,3);assert.equal(h.c.currentViewPos,3);
  h.c.nextInView();assert.deepEqual(h.events.opened,['04.png']);
});

test('closing the viewer while a folder scan runs does not restore its old active image', async()=>{
  const h=harness({index:2}), pending=h.c.refreshFilesFromRoot();
  h.c.closeViewer();h.finish();await pending;
  assert.equal(h.c.currentIndex,-1);assert.equal(h.events.closed,1);assert.equal(h.events.opened.length,0);
});

test('refresh preserves selection and favorite edits made during the scan without reloading storage', async()=>{
  const h=harness(), pending=h.c.refreshFilesFromRoot();
  h.c.selected.add(2);h.c.favorites.add('03.png');
  h.finish();await pending;
  assert.deepEqual([...h.c.selected],[2]);assert.equal(h.c.favorites.has('03.png'),true);assert.equal(h.events.favoritesReads,0);
});

test('a canceled pending decode resumes on the retained image and an open filmstrip gets its new extent', async()=>{
  const h=harness({index:2,loading:true});h.c.filmstripOn=true;
  const pending=h.c.refreshFilesFromRoot();h.finish();await pending;
  assert.deepEqual(h.events.decoded,[[2,false]]);assert.equal(h.events.filmstrips,1);
});

test('a file removed during refresh closes the viewer rather than selecting a different image', async()=>{
  const h=harness({index:2}), pending=h.c.refreshFilesFromRoot();
  h.c.incoming=h.c.incoming.filter(f=>f.path!=='03.png');h.finish();await pending;
  assert.equal(h.events.closed,1);assert.equal(h.events.opened.length,0);
});

test('refresh follows the active file in a filtered descending order', async()=>{
  const h=harness({index:2});
  h.c.buildView=()=>h.c.files.map((_,i)=>i).filter(i=>h.c.files[i].path!=='02.png').reverse();
  h.c.view=h.c.buildView();h.c.currentViewPos=0;
  const pending=h.c.refreshFilesFromRoot();h.finish();await pending;
  assert.equal(h.c.files[h.c.currentIndex].path,'03.png');assert.equal(h.c.currentViewPos,1);
  h.c.prevInView();assert.deepEqual(h.events.opened,['04.png']);
});

test('a refresh does not consume a pending external-open request', async()=>{
  const h=harness({index:2});h.c._pendingOpenName='01.png';
  const pending=h.c.refreshFilesFromRoot();h.finish();await pending;
  assert.equal(h.events.opened.length,0);assert.equal(h.c._pendingOpenName,'01.png');
});

test('a refresh does not relax saved filters while metadata caches are temporarily empty', async()=>{
  const h=harness({index:2});h.c.filterState.currentPath='nested';h.c.filterState.favoritesOnly=true;
  h.c.buildView=()=>h.c.dims[2]?[2]:[];
  const pending=h.c.refreshFilesFromRoot();h.finish();await pending;
  assert.equal(h.c.filterState.currentPath,'nested');assert.equal(h.c.filterState.favoritesOnly,true);
  assert.equal(h.c.currentViewPos,0);
});

test('resuming a pending decode cannot repaint an image selected after refresh', async()=>{
  const h=harness({index:2,loading:true});let finishDims;
  h.c.ensureDims=()=>new Promise(resolve=>{finishDims=resolve;});
  const pending=h.c.refreshFilesFromRoot();h.finish();await pending;
  h.c.currentIndex=0;h.c.viewerOpenId++;finishDims();await new Promise(setImmediate);
  assert.equal(h.events.decoded.length,0);
});

test('gallery scrolling during a scan preserves the latest path anchor when an earlier file is inserted', async()=>{
  const h=harness();h.c.closeViewer();
  h.c.saveScrollAnchor=()=>({index:Math.floor(h.c.window.scrollY/100),offsetY:0});
  h.c.window.scrollTo=(_x,y)=>{h.c.window.scrollY=y;};
  h.c.applyFilters=()=>{h.c.view=h.c.buildView();h.c.slots=h.c.view.map(index=>({index,top:index*100}));};
  const pending=h.c.refreshFilesFromRoot();h.c.window.scrollY=200;h.c.incoming.unshift(entry('00.png'));
  h.finish();await pending;
  assert.equal(h.c.window.scrollY,300);
});
