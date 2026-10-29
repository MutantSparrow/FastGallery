const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const html=fs.readFileSync(path.join(__dirname,'../fast-gallery.html'),'utf8').replaceAll('\r','');
function source(from,to){const a=html.indexOf(from),b=html.indexOf(to,a+from.length);assert(a>=0&&b>a);return html.slice(a,b);}
const tick=()=>new Promise(setImmediate);

function favoritesHarness(overrides={}) {
  const stores={favorites:new Map(),roots:new Map()},writes=[],notices=[];
  const c=vm.createContext({TextEncoder,Uint8Array,window:{crypto:webcrypto},STORE_FAVORITES:'favorites',STORE_ROOTS:'roots',
    files:[{path:'sample.png'}],favorites:new Set(),rootKey:'new-root',fileGeneration:1,
    legacyFavoritesBanner:{style:{}},legacyFavoritesText:{},legacyFavoritesImport:{},legacyFavoritesDismiss:{},
    idbGet:async(store,key)=>stores[store].get(key),idbGetAll:async store=>[...stores[store].values()],
    idbPut:async(store,value,key)=>{writes.push({store,value,key});stores[store].set(key,value);return true;},
    showQuotaToast:message=>notices.push(message),applyFilters(){},updateFavButton(){},...overrides});
  vm.runInContext(source('const FAVORITES_READ_FAILED =', '// Utility'),c);
  return {c,stores,writes,notices,read:s=>vm.runInContext(s,c)};
}

test('native favorites use stable opaque keys and isolate identically named folders',async()=>{
  const {c,writes}=favoritesHarness();
  const key=await c.favoritesKeyForHandle({kind:'directory',_rootId:'session-1',name:'Images',absPath:'Q:\\synthetic\\alpha\\Images'});
  const again=await c.favoritesKeyForHandle({kind:'directory',_rootId:'session-2',name:'Images',absPath:'q:/synthetic/alpha/images/'});
  const other=await c.favoritesKeyForHandle({kind:'directory',_rootId:'session-3',name:'Images',absPath:'Q:\\synthetic\\beta\\Images'});
  assert.match(key,/^native:v2:[a-f0-9]{64}$/);assert.equal(key,again);assert.notEqual(key,other);
  await c.saveFavoritesFor(key,new Set(['sample.png']));
  assert.deepEqual([...await c.loadFavoritesFor(again)],['sample.png']);assert.equal((await c.loadFavoritesFor(other)).size,0);
  assert(!JSON.stringify(writes).includes('synthetic\\alpha'));
});

test('browser roots use isSameEntry across handle instances, including concurrent registration',async()=>{
  const {c,stores}=favoritesHarness();
  const handle=token=>({kind:'directory',name:'Images',token,async isSameEntry(other){return token===other.token;}});
  const [a,b]=await Promise.all([c.favoritesKeyForHandle(handle('alpha')),c.favoritesKeyForHandle(handle('alpha'))]);
  const other=await c.favoritesKeyForHandle(handle('beta'));
  assert.equal(a,b);assert.notEqual(a,other);assert.equal(stores.roots.size,2);
  assert.equal(await c.favoritesKeyForHandle(handle('alpha')),a);
});

test('imports without durable identity never share a persisted favorite key',async()=>{
  const {c,stores,notices}=favoritesHarness();
  assert.equal(await c.favoritesKeyForHandle(null),'');
  assert.equal(await c.favoritesKeyForHandle({kind:'file',name:'sample.png'}),'');
  assert.equal(await c.saveFavoritesFor('',new Set(['sample.png'])),false);
  assert.equal(stores.favorites.size,0);assert.match(notices[0],/temporary/);
});

test('a failed read cannot overwrite existing favorites with an incomplete set',async()=>{
  const {c,stores,notices}=favoritesHarness({idbGet:async(store,key,fallback)=>fallback});
  stores.favorites.set('new-root',['preserved.png']);
  assert.equal((await c.loadFavoritesFor('new-root')).size,0);
  assert.equal(await c.saveFavoritesFor('new-root',new Set(['new.png'])),false);
  assert.deepEqual(stores.favorites.get('new-root'),['preserved.png']);assert.match(notices[0],/Reopen this folder/);
  c.idbGet=async(store,key)=>stores[store].get(key);
  assert.deepEqual([...await c.loadFavoritesFor('new-root')],['preserved.png']);
  assert.equal(await c.saveFavoritesFor('new-root',new Set(['preserved.png','new.png'])),true);
});

test('ambiguous old favorites are offered for import without automatic assignment or removal',async()=>{
  const {c,stores}=favoritesHarness();
  stores.favorites.set('fsa:Images',['sample.png','missing.png']);
  await c.offerLegacyFavorites('new-root',['fsa:Images'],1);
  assert.equal(c.favorites.size,0);assert.equal(c.legacyFavoritesBanner.style.display,'flex');
  assert.match(c.legacyFavoritesText.textContent,/1 matching old favorite found/);
  await c.finishLegacyFavorites(true);
  assert.deepEqual([...c.favorites],['sample.png']);assert.equal(c.legacyFavoritesBanner.style.display,'none');
  assert.deepEqual(stores.favorites.get('fsa:Images'),['sample.png','missing.png']);
  assert.deepEqual(Array.from(stores.favorites.get('new-root')),['sample.png']);
  assert.equal(stores.roots.get('new-root').legacyHandled,true);
});

test('migration merges legacy aliases, strips fallback prefixes and preserves stored browser handles',async()=>{
  const {c,stores}=favoritesHarness();c.files=[{path:'sample.png'},{path:'nested/other.png'}];c.favorites.add('already.png');
  stores.roots.set('new-root',{id:'new-root',handle:{token:'synthetic'}});
  stores.favorites.set('drop:Images',['Images/sample.png']);stores.favorites.set('webkit:Images',['Images/nested/other.png']);
  await c.offerLegacyFavorites('new-root',['drop:Images','webkit:Images'],1);await c.finishLegacyFavorites(true);
  assert.deepEqual([...c.favorites],['already.png','sample.png','nested/other.png']);
  assert.equal(stores.roots.get('new-root').handle.token,'synthetic');
});

test('dismissing migration affects only this folder and does not delete legacy data',async()=>{
  const {c,stores}=favoritesHarness();stores.favorites.set('fsa:Images',['sample.png']);
  await c.offerLegacyFavorites('new-root',['fsa:Images'],1);await c.finishLegacyFavorites(false);
  assert.equal(c.favorites.size,0);assert.equal(stores.favorites.has('new-root'),false);
  await c.offerLegacyFavorites('new-root',['fsa:Images'],1);assert.equal(c.legacyFavoritesBanner.style.display,'none');
  c.rootKey='other-root';await c.offerLegacyFavorites('other-root',['fsa:Images'],1);
  assert.equal(c.legacyFavoritesBanner.style.display,'flex');assert.deepEqual(stores.favorites.get('fsa:Images'),['sample.png']);
});

test('a stale migration offer cannot import into a replacement dataset',async()=>{
  const {c,stores}=favoritesHarness();stores.favorites.set('fsa:Images',['sample.png']);
  await c.offerLegacyFavorites('new-root',['fsa:Images'],1);c.fileGeneration++;
  await c.finishLegacyFavorites(true);assert.equal(c.favorites.size,0);assert.equal(stores.favorites.has('new-root'),false);
});

test('failed import save stays retryable and leaves legacy records unclaimed',async()=>{
  const {c,stores}=favoritesHarness({idbPut:async()=>false});stores.favorites.set('fsa:Images',['sample.png']);
  await c.offerLegacyFavorites('new-root',['fsa:Images'],1);await c.finishLegacyFavorites(true);
  assert.equal(stores.roots.has('new-root'),false);assert.equal(c.legacyFavoritesBanner.style.display,'flex');
  assert.equal(c.legacyFavoritesImport.disabled,false);assert.deepEqual(stores.favorites.get('fsa:Images'),['sample.png']);
});

function persistenceHarness() {
  const opens=[],transactions=[],notices=[];
  const db={objectStoreNames:{contains:()=>false},created:[],createObjectStore(name){this.created.push(name);},close(){},
    transaction(){const request={},tx={objectStore:()=>({put:()=>request,get:()=>request,getAll:()=>request})};transactions.push({tx,request});return tx;}};
  const c=vm.createContext({indexedDB:{open(name,version){const request={result:db};opens.push({name,version,request});return request;}},
    quotaToast:{style:{}},quotaToastShown:false,document:{getElementById:()=>({})}});
  vm.runInContext(source("const IDB_NAME =", '// File System Access API + fallback'),c);
  c.showQuotaToast=message=>notices.push(message);
  return {c,opens,transactions,db,notices};
}

test('database upgrade repairs all stores and resets a failed opener so the next call can retry',async()=>{
  const h=persistenceHarness();const first=h.c.openIdb();
  h.opens[0].request.error=new Error('Synthetic open failure');h.opens[0].request.onerror();await assert.rejects(first);
  const next=h.c.openIdb();assert.equal(h.opens.length,2);assert.equal(h.opens[1].version,2);
  h.opens[1].request.onupgradeneeded();assert.deepEqual(h.db.created,['handles','favorites','roots']);
  h.opens[1].request.onsuccess();assert.equal(await next,h.db);
});

test('favorite writes report success only on transaction commit, including abort after request success',async()=>{
  const h=persistenceHarness();let settled=false;
  const save=h.c.idbPut('favorites',['sample.png'],'synthetic').then(result=>{settled=true;return result;});
  h.opens[0].request.onsuccess();await tick();
  const {tx,request}=h.transactions[0];request.onsuccess?.();await tick();assert.equal(settled,false);
  tx.onabort();assert.equal(await save,false);assert.equal(h.notices.length,1);
  const committed=h.c.idbPut('favorites',[],'synthetic');await tick();h.transactions[1].tx.oncomplete();assert.equal(await committed,true);
});

test('favorite reads ignore data from an aborted transaction',async()=>{
  const h=persistenceHarness();const read=h.c.idbGet('favorites','synthetic');h.opens[0].request.onsuccess();await tick();
  h.transactions[0].request.result=['sample.png'];h.transactions[0].request.onsuccess();h.transactions[0].tx.onabort();
  assert.equal(await read,undefined);
});
