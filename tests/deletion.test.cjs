const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../fast-gallery.html'), 'utf8').replaceAll('\r', '');
function source(from, to) {
  const start = html.indexOf(from), end = html.indexOf(to, start + from.length);
  assert(start >= 0 && end > start, 'Source section exists');
  return html.slice(start, end);
}
const tick = () => new Promise(setImmediate);

function deletionHarness({ outcomes = ['ok', 'ok', 'ok'], viewing = true, viewerIndex = 1 } = {}) {
  const events = { disk: [], invalidations: 0, saved: [], opened: [], closed: 0, timers: [], logs: [], resets: 0 };
  const files = outcomes.map((outcome, i) => ({
    name: `synthetic-${i}.png`, path: `nested/synthetic-${i}.png`, handle: outcome === 'list' ? null : {},
    parent: { async removeEntry() {
      events.disk.push(i);
      if (typeof outcome === 'function') return outcome();
      if (outcome === 'fail') throw new Error('Synthetic native error detail must not reach UI or logs');
    } },
  }));
  const c = vm.createContext({
    files, dims: files.map((_, i) => ({w:100+i,h:200})), dimsP: [], prompts: files.map((_,i)=>[`prompt-${i}`]), promptsP: [],
    colors: files.map((_,i)=>({bucket:`color-${i}`})), selected: new Set(files.map((_,i)=>i)),
    favorites: new Set(files.map(e=>e.path)), view: files.map((_,i)=>i), rootKey: 'synthetic', lastSelectedK: 0,
    currentRootHandle: {name:'synthetic-root'}, fileGeneration: 1, currentIndex: viewerIndex, currentViewPos: viewerIndex,
    deleteToast: {style:{},dataset:{}}, deleteToastText: {},
    viewer: {classList:{contains:()=>viewing}}, countEl:{}, empty:{style:{}}, document:{body:{classList:{toggle(){}}}},window:{scrollY:0},
    prefetched:false, prefetchActive:false, prefetchColorsActive:false, filmstripOn:false,
    _fgRefreshQueued:false, _fgRefreshInFlight:false,
    isValidIndex:i=>Number.isInteger(i) && i>=0 && i<c.files.length,
    invalidateFileWork(){events.invalidations++;c.fileGeneration++;},
    saveFavoritesFor(key, values){events.saved.push([...values]);},
    refreshFormatChips(){},renderFolderStrip(){},updateSelectionUI(){},
    applyFilters(){c.view=c.files.map((_,i)=>i);},ensureFirstDimsInBackground(){},
    startPrefetchPrompts(){},startPrefetchColors(){},
    openViewer(i,k){events.opened.push({i,k,name:c.files[i].name});c.currentIndex=i;c.currentViewPos=k;},
    closeViewer(){events.closed++;viewing=false;},
    openConfirmModal(options){events.dialog=options;},
    setTimeout(fn){events.timers.push(fn);},
    refreshFilesFromRoot(){events.resets++;},
    console:{warn:(...args)=>events.logs.push(args),error:(...args)=>events.logs.push(args)},
  });
  vm.runInContext(source('function canDeleteFromDisk(', '// Viewer (canvas)'), c);
  return {c,events,read:code=>vm.runInContext(code,c)};
}

test('failed disk deletions leave gallery, viewer, favorites and selection intact', async () => {
  const {c,events}=deletionHarness({outcomes:['fail','fail']});
  const files=c.files, dims=c.dims;
  await c.performDeleteIndexes([0,1]);
  assert.equal(c.files,files);assert.equal(c.dims,dims);
  assert.deepEqual([...c.selected],[0,1]);assert.equal(c.favorites.size,2);
  assert.equal(events.invalidations,0);assert.equal(events.saved.length,0);
  assert.equal(events.opened.length,0);assert.equal(events.closed,0);
  assert.equal(c.deleteToast.dataset.state,'error');
  assert.match(c.deleteToastText.textContent,/Couldn't delete 2 files/);
  assert.match(c.deleteToastText.textContent,/remain in the gallery/);
  assert.doesNotMatch(c.deleteToastText.textContent,/Synthetic native error detail/);
  assert.deepEqual(events.logs,[]);
});

test('mixed results remove only successes and disclosed list-only items, retaining failed viewer identity', async () => {
  const {c,events}=deletionHarness({outcomes:['ok','fail','list','ok']});
  const failed=c.files[1], untouched=c.files[3];
  await c.performDeleteIndexes([2,0,1,1,-1]);
  assert.deepEqual(Array.from(c.files),[failed,untouched]);
  assert.deepEqual(events.disk,[0,1]);assert.equal(events.invalidations,1);
  assert.deepEqual([...c.selected],[0,1]);
  assert.deepEqual([...c.favorites],[failed.path,untouched.path]);
  assert.equal(c.dims[0].w,101);assert.equal(c.dims[1].w,103);
  assert.deepEqual(Array.from(c.prompts[0]),['prompt-1']);assert.equal(c.colors[0].bucket,'color-1');
  assert.equal(c.dimsP.length,2);assert.equal(c.promptsP.length,2);
  assert.deepEqual(events.opened,[{i:0,k:0,name:failed.name}]);
  assert.equal(events.saved.length,1);
  assert.match(c.deleteToastText.textContent,/Deleted 1 file from disk/);
  assert.match(c.deleteToastText.textContent,/Removed 1 file from the gallery only/);
  assert.match(c.deleteToastText.textContent,/Couldn't delete 1 file/);
});

test('successful deletion of the whole collection clears its state and closes the viewer', async () => {
  const {c,events}=deletionHarness();
  await c.performDeleteIndexes([0,1,2]);
  assert.equal(c.files.length,0);assert.equal(c.selected.size,0);assert.equal(c.favorites.size,0);
  assert.equal(events.closed,1);assert.equal(events.opened.length,0);
  assert.equal(c.deleteToast.dataset.state,'done');assert.match(c.deleteToastText.textContent,/Deleted 3 files from disk/);
});

test('browser-only removal stays explicitly disclosed in confirmation and result', async () => {
  const {c,events}=deletionHarness({outcomes:['list'],viewing:false});
  c.confirmAndDeleteIndexes([0]);
  assert.match(events.dialog.message,/removed from the gallery only/);
  await events.dialog.onConfirm();
  assert.deepEqual(events.disk,[]);assert.equal(c.files.length,0);
  assert.match(c.deleteToastText.textContent,/gallery only/);
  assert.doesNotMatch(c.deleteToastText.textContent,/from disk/);
});

test('confirmation cannot delete replacement entries after dataset or root changes', async () => {
  for(const change of [c=>c.fileGeneration++,c=>c.currentRootHandle={},c=>c.files[0]={...c.files[0]}]) {
    const {c,events}=deletionHarness();
    c.confirmAndDeleteIndexes([0]);change(c);
    await events.dialog.onConfirm();
    assert.deepEqual(events.disk,[]);assert.equal(c.files.length,3);
    assert.match(c.deleteToastText.textContent,/folder contents changed/);
  }
});

test('another deletion cannot overlap an active batch', async () => {
  let finish;
  const {c,events,read}=deletionHarness({outcomes:[()=>new Promise(r=>{finish=r;}),'ok']});
  const first=c.performDeleteIndexes([0]);await tick();
  await c.performDeleteIndexes([1]);c.confirmAndDeleteIndexes([1]);
  assert.deepEqual(events.disk,[0]);assert.equal(events.dialog,undefined);
  assert.match(c.deleteToastText.textContent,/in progress/);
  finish();await first;
  assert.equal(c.files.length,1);assert.equal(read('deleteInProgress'),false);
});

test('switching dataset during deletion stops the remaining disk operations and stale UI writes', async () => {
  let finish;
  const {c,events,read}=deletionHarness({outcomes:[()=>new Promise(r=>{finish=r;}),'ok']});
  const pending=c.performDeleteIndexes([0,1]);await tick();
  c.files=[{name:'replacement.png'}];c.fileGeneration++;
  finish();await pending;
  assert.deepEqual(events.disk,[0]);assert.equal(c.files[0].name,'replacement.png');
  assert.equal(events.invalidations,0);assert.equal(c.deleteToast.style.display,'none');
  assert.equal(read('deleteInProgress'),false);
});

function installRefresh(h) {
  h.c.saveScrollAnchor=()=>null;
  h.c.resetSidecars=()=>{};
  h.c.resetAndLoadFiles=async()=>{throw new Error('Unexpected root reset during deletion');};
  vm.runInContext(source('let _fgRefreshInFlight = false;', '// Debounce fs-change'),h.c);
}

test('watch refreshes wait for a deletion batch and coalesce into one queued refresh', async () => {
  let finish;
  const h=deletionHarness({outcomes:[()=>new Promise(r=>{finish=r;})]});
  installRefresh(h);
  const pending=h.c.performDeleteIndexes([0]);await tick();
  await h.c.refreshFilesFromRoot();await h.c.refreshFilesFromRoot();
  assert.equal(h.read('_fgRefreshQueued'),true);assert.equal(h.read('_fgRefreshInFlight'),false);
  finish();await pending;
  assert.equal(h.events.timers.length,1);assert.equal(h.read('_fgRefreshQueued'),false);
});

test('a refresh already walking when deletion begins cannot replace the batch dataset', async () => {
  let finishWalk,finishDelete;
  const h=deletionHarness({outcomes:[()=>new Promise(r=>{finishDelete=r;})]});
  installRefresh(h);
  h.c.walkDirectoryFSA=()=>new Promise(r=>{finishWalk=r;});
  const refresh=h.c.refreshFilesFromRoot();await tick();
  const pending=h.c.performDeleteIndexes([0]);await tick();
  finishWalk();await refresh;
  assert.equal(h.read('_fgRefreshQueued'),true);assert.equal(h.events.timers.length,0);
  finishDelete();await pending;
  assert.equal(h.events.timers.length,1);assert.equal(h.c.files.length,0);
});

test('a refresh finishing after successful deletion requeues instead of applying its stale snapshot', async () => {
  let finishWalk;
  const h=deletionHarness();
  installRefresh(h);
  h.c.walkDirectoryFSA=()=>new Promise(r=>{finishWalk=r;});
  const refresh=h.c.refreshFilesFromRoot();await tick();
  await h.c.performDeleteIndexes([0]);
  assert.equal(h.events.timers.length,0);
  finishWalk();await refresh;
  assert.equal(h.events.timers.length,1);assert.equal(h.c.files.length,2);
});
