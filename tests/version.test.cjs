const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const desktop=path.join(__dirname,'../desktop');
const read=p=>fs.readFileSync(path.join(desktop,p),'utf8');

test('every manifest that carries the release version agrees',()=>{
  const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'));
  const conf=JSON.parse(read('src-tauri/tauri.conf.json'));
  const cargo=/^\[package\][^[]*?^version = "([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1];
  const cargoLock=/\[\[package\]\]\nname = "fast-gallery"\nversion = "([^"]+)"/.exec(read('src-tauri/Cargo.lock').replaceAll('\r',''))?.[1];
  const versions={'package.json':pkg.version,'package-lock.json':lock.version,'package-lock.json root':lock.packages[''].version,
    'tauri.conf.json':conf.version,'Cargo.toml':cargo,'Cargo.lock':cargoLock};
  assert.match(conf.version,/^\d+\.\d+\.\d+$/);
  for(const [file,v] of Object.entries(versions))assert.equal(v,conf.version,`${file} has ${v}, expected ${conf.version}`);
});
