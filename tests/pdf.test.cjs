const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'fast-gallery.html'),'utf8').replaceAll('\r','');
const shim=fs.readFileSync(path.join(root,'desktop/src/shim.js'),'utf8');
function source(a,b){const start=html.indexOf(a),end=html.indexOf(b,start+a.length);assert(start>=0&&end>start,`missing ${a}`);return html.slice(start,end);}
const tick=()=>new Promise(setImmediate);
// Top-level consts are lexical in a vm context, not properties of it.
const get=(c,name)=>vm.runInContext(name,c);
// Values created inside a vm context have foreign prototypes; compare plain copies.
const plain=v=>JSON.parse(JSON.stringify(v));
function classes(...initial){const v=new Set(initial);return{contains:n=>v.has(n),add:(...ns)=>ns.forEach(n=>v.add(n)),remove:(...ns)=>ns.forEach(n=>v.delete(n))};}
function typeContext(extra={}){
  const c=vm.createContext({files:[],dims:[],encodeURIComponent,...extra});
  vm.runInContext(source('const IMAGE_EXT_RE','const PREVIEW_MAX_PIXELS'),c);
  return c;
}
// Synthetic PDF text: only the structure the head scan looks at.
const pdfText=body=>`%PDF-1.7\n1 0 obj\n${body}\nendobj\n%%EOF\n`;
function syntheticFile(name,text){
  let sliced=null;const bytes=Buffer.from(text,'latin1');
  return {name,get sliced(){return sliced;},slice(a,b){sliced=[a,b];const sub=bytes.subarray(a,b);
    return{arrayBuffer:async()=>sub.buffer.slice(sub.byteOffset,sub.byteOffset+sub.length)};}};
}

test('PDFs pass every discovery gate in the browser and the desktop shim',()=>{
  const c=typeContext();
  const isPdf=get(c,'isPdf');
  for(const name of ['report.pdf','SCAN.PDF','a/b/c.Pdf'])assert.ok(get(c,'IMAGE_EXT_RE').test(name)&&isPdf(name),name);
  assert.equal(isPdf('pdf.png'),false);assert.equal(get(c,'isVideo')('report.pdf'),false);
  c.files=[{name:'x.pdf'},{name:'y.png'},{ext:'pdf'}];
  assert.deepEqual([0,1,2].map(i=>c.isPdfIndex(i)),[true,false,true]);
  assert.match(shim,/IMG_RE = \/\\\.\([^)]*\|pdf\)\$\/i/);
  const lib=fs.readFileSync(path.join(root,'desktop/src-tauri/src/lib.rs'),'utf8');
  assert.match(lib,/"webm" \| "pdf"\)/,'external open accepts PDF arguments');
  const assoc=fs.readFileSync(path.join(root,'desktop/src-tauri/src/assoc.rs'),'utf8');
  assert.match(assoc,/const EXTS[^;]*"\.pdf"/,'Open-with registration includes .pdf');
});

test('first-page MediaBox parsing handles rotation, offsets and malformed boxes',()=>{
  const c=vm.createContext({});vm.runInContext(source('const PDF_HEAD_SCAN','async function getPdfDims('),c);
  const box=t=>plain(c.parsePdfMediaBox(t));
  assert.deepEqual(box('<< /Type /Page /MediaBox [0 0 612 792] >>'),{w:612,h:792});
  assert.deepEqual(box('<< /Type /Page /MediaBox [0 0 612 792] /Rotate 90 >>'),{w:792,h:612});
  assert.deepEqual(box('<< /Rotate -270 /MediaBox[ 10.5 -20 605.5 822 ] >>'),{w:842,h:595},'offset origin, negative quarter turn');
  assert.deepEqual(box('<< /Rotate 180 /MediaBox [0 0 612 792] >>'),{w:612,h:792},'half turns keep orientation');
  assert.deepEqual(box('<< /MediaBox [0 0 400 300] >> << /Rotate 90 >>'),{w:400,h:300},'rotation from another dictionary is ignored');
  for(const bad of ['no box here','/MediaBox [0 0 0 792]','/MediaBox [0 0 9e9 1]','/MediaBox [0 0 612]'])assert.equal(c.parsePdfMediaBox(bad),null,bad);
});

test('browser PDF dimensions read only the file head and fall back to A4',async()=>{
  const c=vm.createContext({TextDecoder});vm.runInContext(source('const PDF_HEAD_SCAN','async function getDims(file)'),c);
  const dimsOf=async f=>plain(await c.getPdfDims(f));
  const letter=syntheticFile('a.pdf',pdfText('<< /Type /Page /MediaBox [0 0 612 792] >>'));
  assert.deepEqual(await dimsOf(letter),{w:612,h:792});assert.deepEqual(letter.sliced,[0,1024*1024]);
  assert.deepEqual(await dimsOf(syntheticFile('b.pdf',pdfText('<< /Type /ObjStm /N 3 >>'))),{w:595,h:842});
  assert.deepEqual(await dimsOf(syntheticFile('c.pdf','junk\n'+pdfText('<< /MediaBox [0 0 100 50] >>'))),{w:100,h:50});
  await assert.rejects(c.getPdfDims(syntheticFile('d.pdf','<html>not a pdf</html>')));
});

test('PDF sizes are labelled in points while images keep pixel labels',()=>{
  const c=typeContext();vm.runInContext(source('function fmtDims(d)','\n}\n')+'\n}\n'+source('// Tiles and the viewer label PDF sizes','\n}\n')+'\n}',c);
  c.files=[{name:'a.pdf'},{name:'b.png'},{name:'c.pdf'}];c.dims=[{w:612,h:792},{w:640,h:480},null];
  assert.equal(c.fmtDimsFor(0),'612×792 pt');assert.equal(c.fmtDimsFor(1),'640×480');assert.equal(c.fmtDimsFor(2),'—');
});

function tileHarness({native,thumb}={}){
  const events={reads:0,thumbRequests:0,revoked:[]};
  const pname={textContent:''},img={addEventListener(){},set src(v){this._src=v;},get src(){return this._src;}};
  const node={classList:classes(),dataset:{},querySelector:k=>k==='.pname'?pname:null};
  const c=typeContext({fileGeneration:1,AbortController,thumbUrlByIdx:new Map(),colors:[],
    URL:{revokeObjectURL:u=>events.revoked.push(u)},computeColorSignature:()=>null,
    rememberThumbUrl(i,u){c.thumbUrlByIdx.set(i,u);},getFileForEntry:async()=>{events.reads++;return{};},
    window:native?{__fgThumbUrl:async()=>{events.thumbRequests++;return thumb;}}:{}});
  vm.runInContext(source('function loadThumbForNode(','function renderVisible('),c);
  c.files=[{name:'Quarterly report.pdf',handle:native?{_rootId:'root',_rel:'Quarterly report.pdf'}:{}}];
  return {c,events,node,img,pname};
}

test('browser PDF tiles show the document card without reading the file',()=>{
  const h=tileHarness();h.c.loadThumbForNode(h.node,0,h.img);
  assert.equal(h.img.src,get(h.c,'PDF_CARD_URL'));assert.match(h.img.src,/^data:image\/svg\+xml,/);
  assert.equal(h.node.dataset.pdfcard,'1');assert.equal(h.pname.textContent,'Quarterly report.pdf');
  assert.ok(h.node.classList.contains('loaded'));assert.equal(h.events.reads,0);
});

test('desktop PDF tiles use the native page render and fall back to the card when it fails',async()=>{
  const ok=tileHarness({native:true,thumb:'blob:page-1'});ok.c.loadThumbForNode(ok.node,0,ok.img);await tick();
  assert.equal(ok.img.src,'blob:page-1');assert.equal(ok.node.dataset.pdfcard,'0');assert.equal(ok.events.thumbRequests,1);
  const locked=tileHarness({native:true,thumb:''});locked.c.loadThumbForNode(locked.node,0,locked.img);await tick();
  assert.equal(locked.img.src,get(locked.c,'PDF_CARD_URL'));assert.equal(locked.node.dataset.pdfcard,'1');
  assert.ok(locked.node.classList.contains('loaded'));assert.equal(locked.node.classList.contains('errored'),false);
});

test('prompt extraction never reads PDFs',async()=>{
  let reads=0;const c=typeContext({prompts:[],promptsP:[],fileGeneration:1,getFileForEntry:async()=>{reads++;return{};},
    window:{__fgReadHead:async()=>{reads++;return null;}},extractPromptsForFile:async()=>['x'],sidecarEntryForIndex:async()=>null});
  vm.runInContext(source('function ensurePrompts(i)','// ====='),c);
  c.files=[{name:'a.pdf',handle:{_rootId:'root',_rel:'a.pdf'}}];
  assert.deepEqual(plain(await c.ensurePrompts(0)),[]);assert.equal(reads,0);assert.deepEqual(plain(c.prompts[0]),[]);
});

test('the PDF viewer frame is replaced per document, typed, and fully released on hide',()=>{
  const revoked=[],frames=[],blobs=[];
  const stage={insertBefore(f){frames.push(f);f.removed=false;},querySelector:()=>({})};
  const c=typeContext({viewerStage:stage,viewerCanvas:{style:{}},viewerImgOverlay:{style:{}},
    viewer:{classList:classes('loading')},isValidIndex:i=>!!c.files[i],useVideoOverlay:()=>false,
    document:{createElement:()=>({remove(){this.removed=true;}})},
    Blob:class{constructor(parts,opts){this.type=opts.type;this.parts=parts;}},
    URL:{createObjectURL:b=>{blobs.push(b);return `blob:${blobs.length}`;},revokeObjectURL:u=>revoked.push(u)}});
  vm.runInContext(source('let viewerPdfFrame = null;','function setZoomClasses()'),c);
  c.files=[{name:'a.pdf'},{name:'b.png'}];
  assert.equal(c.usesOwnControls(0),true);assert.equal(c.usesOwnControls(1),false);
  const untyped=c.pdfObjectUrl({type:''});assert.equal(blobs[0].type,'application/pdf');
  const typed={type:'application/pdf'};c.pdfObjectUrl(typed);assert.equal(blobs[1],typed,'already-typed Files are not copied');
  c.showPdfOverlay(untyped,true);
  assert.equal(frames.length,1);assert.equal(frames[0].src,untyped);assert.equal(frames[0].id,'viewerPdfOverlay');
  assert.equal(c.viewerCanvas.style.display,'none');assert.equal(c.viewer.classList.contains('loading'),false);
  c.showPdfOverlay('asset://next.pdf',false);
  assert.equal(frames.length,2);assert.equal(frames[0].removed,true);assert.deepEqual(revoked,[untyped]);
  c.hidePdfOverlay();
  assert.equal(frames[1].removed,true);assert.deepEqual(revoked,[untyped],'asset URLs are not revoked');
  assert.equal(c.viewerCanvas.style.display,'');
});
