const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../fast-gallery.html'),'utf8').replaceAll('\r','');
const start=html.indexOf('let confirmPending ='),end=html.indexOf('function canDeleteFromDisk(',start);
assert(start>=0 && end>start);

function confirmationHarness() {
  const document={activeElement:null};let confirmed=0;
  const makeNode=()=>{
    const values=new Set(),listeners={};
    return {isConnected:true,disabled:false,
      classList:{contains:n=>values.has(n),add:(...ns)=>ns.forEach(n=>values.add(n)),remove:(...ns)=>ns.forEach(n=>values.delete(n)),toggle:(n,on)=>on?values.add(n):values.delete(n)},
      focus(){document.activeElement=this;},setAttribute(){},addEventListener(type,fn){listeners[type]=fn;},
      click(){return listeners.click?.({target:this});}};
  };
  const c=vm.createContext({document,confirmModal:makeNode(),confirmCancel:makeNode(),confirmOk:makeNode(),confirmTitle:{},confirmMsg:{},confirmList:{}});
  vm.runInContext(html.slice(start,end),c);
  const launcher=makeNode();launcher.focus();
  const open=()=>c.openConfirmModal({title:'Synthetic confirmation',message:'Synthetic action',onConfirm:()=>{confirmed++;}});
  const key=(key,options={})=>{
    const event={key,target:document.activeElement,repeat:false,prevented:false,stopped:false,
      preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...options};
    event.handled=c.handleConfirmKeydown(event);return event;
  };
  return {c,document,launcher,open,key,confirmed:()=>confirmed};
}

test('confirmation focuses Cancel immediately and restores its invoking control on close',()=>{
  const h=confirmationHarness();h.open();assert.equal(h.document.activeElement,h.c.confirmCancel);
  h.c.closeConfirmModal();assert.equal(h.document.activeElement,h.launcher);assert.equal(h.confirmed(),0);
});

test('Enter delegates to the focused button without programmatically confirming',()=>{
  const h=confirmationHarness();h.open();
  const cancel=h.key('Enter');assert.equal(cancel.prevented,false);assert.equal(h.confirmed(),0);
  h.c.confirmOk.focus();const ok=h.key('Enter');assert.equal(ok.prevented,false);assert.equal(h.confirmed(),0);
  assert.equal(cancel.handled,true);assert.equal(ok.handled,true);
});

test('Tab and Shift+Tab cycle through the confirmation buttons',()=>{
  const h=confirmationHarness();h.open();
  assert.equal(h.key('Tab').prevented,true);assert.equal(h.document.activeElement,h.c.confirmOk);
  h.key('Tab');assert.equal(h.document.activeElement,h.c.confirmCancel);
  h.key('Tab',{shiftKey:true});assert.equal(h.document.activeElement,h.c.confirmOk);
  h.key('Tab',{shiftKey:true});assert.equal(h.document.activeElement,h.c.confirmCancel);
});

test('Enter outside the dialog and repeated activation keys cannot confirm',()=>{
  const h=confirmationHarness();h.open();h.launcher.focus();
  assert.equal(h.key('Enter').prevented,true);assert.equal(h.document.activeElement,h.c.confirmCancel);
  h.c.confirmOk.focus();
  for(const key of ['Enter',' ','y','Y'])assert.equal(h.key(key,{repeat:true}).prevented,true);
  assert.equal(h.confirmed(),0);assert.equal(h.c.confirmModal.classList.contains('open'),true);
});

test('N and Escape cancel without invoking the destructive callback',()=>{
  for(const key of ['n','N','Escape']){
    const h=confirmationHarness();h.open();assert.equal(h.key(key).prevented,true);
    assert.equal(h.confirmed(),0);assert.equal(h.c.confirmModal.classList.contains('open'),false);
    assert.equal(h.document.activeElement,h.launcher);
  }
});

test('explicit Y confirms once but modified Y shortcuts do not',()=>{
  for(const modifier of ['ctrlKey','altKey','metaKey']){
    const h=confirmationHarness();h.open();h.key('y',{[modifier]:true});assert.equal(h.confirmed(),0);
  }
  const h=confirmationHarness();h.open();h.key('y');assert.equal(h.confirmed(),1);
  assert.equal(h.c.confirmModal.classList.contains('open'),false);assert.equal(h.key('y',{repeat:true}).handled,false);
});

test('ordinary keys stay out of gallery shortcuts while the dialog is open',()=>{
  const h=confirmationHarness();h.open();
  for(const key of ['ArrowRight','Delete','?','m'])assert.equal(h.key(key).handled,true);
  h.c.closeConfirmModal();assert.equal(h.key('ArrowRight').handled,false);
});
