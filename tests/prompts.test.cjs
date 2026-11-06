const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),zlib=require('node:zlib');
const html=fs.readFileSync(path.join(__dirname,'../fast-gallery.html'),'utf8').replaceAll('\r','');
function source(a,b){const start=html.indexOf(a),end=html.indexOf(b,start+a.length);assert(start>=0&&end>start,`missing ${a}`);return html.slice(start,end);}
// Values created inside a vm context have foreign prototypes; compare plain copies.
const plain=v=>JSON.parse(JSON.stringify(v));

// Synthetic PNG with only text chunks: the reader never needs pixel data.
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type,'latin1'),data]);
  const crc=Buffer.alloc(4);crc.writeUInt32BE(zlib.crc32(td));return Buffer.concat([len,td,crc]);}
const tEXt=(k,v)=>chunk('tEXt',Buffer.concat([Buffer.from(k,'latin1'),Buffer.from([0]),Buffer.from(v,'latin1')]));
// Pillow's add_text falls back to an uncompressed iTXt chunk for non-Latin-1 text.
const iTXt=(k,v)=>chunk('iTXt',Buffer.concat([Buffer.from(k,'latin1'),Buffer.from([0,0,0,0,0]),Buffer.from(v,'utf8')]));
function png(...texts){const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),...texts,chunk('IEND',Buffer.alloc(0))]);}

function extractor(){
  const c=vm.createContext({Blob,Response,TextDecoder,DecompressionStream,JSON});
  vm.runInContext(source('const COMFY_PROMPT_INPUT_FIELDS','// PNG chunk + JPEG EXIF reading'),c);
  vm.runInContext(source('// PNG chunk + JPEG EXIF reading','async function readJpegMetadata('),c);
  vm.runInContext('const PNG_TEXT_MAX_SCAN = 8 * 1024 * 1024;',c);
  return async bytes=>plain(c.extractPromptsFromInfo(await c.readPngTextChunks(new Blob([bytes]))));
}

// Key layout written by JustRayzist (app/storage/png_output.py): plain-text
// tEXt chunks, "prompt" as the user prompt, "prompt_effective" after
// wildcard expansion, and *_json / numeric provenance fields alongside.
function justRayzist({prompt,effective,itxt=false}){
  const text=itxt?iTXt:tEXt;
  return png(tEXt('timestamp','2026-03-05T17:22:16+00:00'),text('prompt',prompt),tEXt('application_name','JustRayzist'),
    tEXt('application_version','1.0'),tEXt('generated_with','Rayzist'),tEXt('width','2048'),tEXt('height','3072'),
    tEXt('steps','8'),tEXt('seed','123456789'),tEXt('loras_json','[{"name":"synthetic-style","weight":0.8}]'),
    tEXt('wildcards_json','{"__color__":"neon green"}'),text('prompt_effective',effective));
}

test('JustRayzist prompts are extracted from their plain-text prompt chunk',async()=>{
  const extract=extractor(),p='pop art poster of a synthetic test subject, bold neon green offset print';
  assert.deepEqual(await extract(justRayzist({prompt:p,effective:p})),[p],'identical effective prompt is not repeated');
});

test('a JustRayzist wildcard expansion is offered as a second prompt, provenance fields are not',async()=>{
  const extract=extractor(),p='portrait in __color__ tones, offset print',e='portrait in neon green tones, offset print';
  assert.deepEqual(await extract(justRayzist({prompt:p,effective:e})),[p,e]);
});

test('JustRayzist prompts outside Latin-1 survive the iTXt fallback',async()=>{
  const extract=extractor(),p='東京の夜景、ネオン — café crème, synthetic 🌃';
  assert.deepEqual(await extract(justRayzist({prompt:p,effective:p,itxt:true})),[p]);
});
