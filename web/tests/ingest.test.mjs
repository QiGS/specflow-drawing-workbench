import test from 'node:test';
import assert from 'node:assert/strict';
import { regionsFromPDFItems, regionsFromOCR, classifyPage, parseOCRPages, readFile, INGEST_LIMITS } from '../ingest.mjs';

const viewport = { transform: [1,0,0,-1,0,200], scale: 1, width: 200, height: 200 };
test('PDF text item geometry maps baseline and font ascent to normalized top-left coordinates', () => {
  const [r] = regionsFromPDFItems([{ str:'Voltage 12V', transform:[10,0,0,10,20,150], width:60, height:10, fontName:'f' }], {f:{ascent:.8,descent:-.2}}, viewport);
  assert.equal(r.text, 'Voltage 12V'); assert.equal(r.x, .1); assert.equal(r.y, .21);
  assert.ok(Math.abs(r.width-.3)<1e-9); assert.ok(Math.abs(r.height-.05)<1e-9);
});
test('PDF rotation and out-of-page text boxes stay normalized', () => {
  const regions = regionsFromPDFItems([{str:'Rotated',transform:[10,0,0,10,20,150],width:60,height:10}], {}, {transform:[0,1,1,0,0,0],scale:1,width:200,height:200});
  assert.equal(regions.length,1);
  for(const r of regions) { assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=1&&r.y+r.height<=1); }
  assert.deepEqual(regionsFromPDFItems([{str:'Missing geometry'}],{},viewport),[]);
  assert.deepEqual(regionsFromPDFItems([{str:'Outside',transform:[10,0,0,10,300,150],width:60,height:10}],{},viewport),[]);
});
test('OCR uses real line boxes and does not invent regions when blocks are absent', () => {
  const data={blocks:[{paragraphs:[{lines:[{text:'12 ± 0.1',bbox:{x0:10,y0:20,x1:110,y1:40}}]}]}]};
  const [r]=regionsFromOCR(data,200,100);
  assert.equal(r.text,'12 ± 0.1'); assert.equal(r.x,.05); assert.equal(r.y,.2); assert.equal(r.width,.5); assert.equal(r.height,.2);
  assert.deepEqual(regionsFromOCR({text:'No coordinates'},200,100),[]);
});
test('explicit page selections validate ranges without truncation', () => {
  assert.deepEqual([...parseOCRPages('1,3-5',500)],[1,3,4,5]);
  assert.deepEqual([...parseOCRPages([1,1,500],500)],[1,500]);
  assert.equal(parseOCRPages(null,50),null);
  for(const value of ['0','501','9-1','1-900','foo',[],[1.5]]) assert.throws(()=>parseOCRPages(value,500));
});
test('page classification remains unknown unless document cues support it', () => {
  assert.equal(classifyPage('DRAWING NO AX-42 THIRD ANGLE TOLERANCE ±0.1'),'engineering');
  assert.equal(classifyPage('Datasheet Rated voltage 12V Operating temperature 50C'),'specification');
  assert.equal(classifyPage('Installation instructions: disconnect power'),'technical');
  assert.equal(classifyPage('hello'),'unknown'); assert.equal(classifyPage(''),'unknown');
});
test('text ingestion preserves page schema and content SHA256', async () => {
  const file = new File(['Rated voltage: 12V\nDatasheet'], 'motor.txt');
  const doc=await readFile(file);
  assert.match(doc.contentId,/^[a-f0-9]{64}$/);
  assert.equal(doc.pages[0].type,'specification'); assert.equal(doc.pages[0].method,'text');
  assert.deepEqual(doc.pages[0].regions,[]); assert.equal(doc.pages[0].width,0);
  assert.equal((await readFile(file)).contentId,doc.contentId);
});
test('cancel and file limits fail explicitly before parsing', async () => {
  const controller=new AbortController(); controller.abort();
  await assert.rejects(()=>readFile(new File(['abc'],'x.txt'),null,{signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(()=>readFile({name:'big.pdf',size:INGEST_LIMITS.bytes+1,arrayBuffer(){ throw new Error('must not read'); }}),/200 MB/);
  await assert.rejects(()=>readFile(new File(['x'],'x.dwg')),/DWG/);
  await assert.rejects(()=>readFile(new File([],'x.pdf')),/为空/);
});

test('rotation input accepts only orthogonal degrees and transforms region geometry', async () => {
  const { validateRotation, rotateRegions } = await import('../ingest.mjs');
  for (const angle of [0,90,180,270]) assert.equal(validateRotation(angle),angle);
  for (const angle of [-90,45,360,'90',NaN]) assert.throws(()=>validateRotation(angle));
  const region={text:'Voltage',x:.1,y:.2,width:.3,height:.1};
  const turned=rotateRegions([region],90)[0];
  assert.ok(Math.abs(turned.x-.7)<1e-9); assert.equal(turned.y,.1);
  assert.equal(turned.width,.1); assert.equal(turned.height,.3);
  const restored=rotateRegions([turned],270)[0];
  for(const key of ['x','y','width','height']) assert.ok(Math.abs(restored[key]-region[key])<1e-9);
  await assert.rejects(()=>readFile(new File(['abc'],'x.txt'),null,{rotation:45}),/旋转/);
});

// Synthetic geometry fixtures below; real-corpus results are recorded separately by the audit.
const atom = (text,x,y,width=30) => ({text,x,y,width,height:10});
const headerAtoms = y => [atom('ITEM',20,y,20),atom('PART',70,y,25),atom('NUMBER',100,y,45),atom('DESCRIPTION',210,y,75),atom('QTY.',360,y,25)];
const pdfItem = a => ({str:a.text,transform:[10,0,0,10,a.x,500-a.y],width:a.width,height:a.height});
const ocrData = (rows,text) => ({text,blocks:[{paragraphs:rows.flatMap(row=>row.map(a=>({lines:[{text:a.text,bbox:{x0:a.x,y0:a.y,x1:a.x+a.width,y1:a.y+a.height},words:[{text:a.text,bbox:{x0:a.x,y0:a.y,x1:a.x+a.width,y1:a.y+a.height}}]}]})))}]});
test('PDF BOM reconstruction uses header columns even when item and part number have a tight gap', async () => {
  const {textFromItems}=await import('../ingest.mjs');
  const atoms=[...headerAtoms(20),atom('1',25,40,5),atom('PX-100',49,40,55),atom('Hex clamp',190,40,75),atom('2',365,40,6),atom('Diagram label',-100,40,80)];
  const text=textFromItems(atoms.map(pdfItem));
  assert.match(text,/ITEM \| PART NUMBER \| DESCRIPTION \| QTY\./);
  assert.match(text,/1 \| PX-100 \| Hex clamp \| 2/);
  assert.match(text,/Diagram label/); assert.equal(text.match(/PX-100/g).length,1);
});
test('OCR BOM columns recover across separate OCR blocks and preserve prose verbatim', async () => {
  const {textFromOCR}=await import('../ingest.mjs');
  const data=ocrData([headerAtoms(20),[atom('1',25,40,5),atom('PX-100',70,40,55),atom('Hex clamp',190,40,75),atom('2',365,40,6)]], 'Safety note: keep dry.\nITEM PART NUMBER DESCRIPTION QTY.\n1 PX-100 Hex clamp 2');
  const text=textFromOCR(data);
  assert.ok(text.startsWith(data.text+'\n\n'));
  assert.match(text,/1 \| PX-100 \| Hex clamp \| 2/);
  const composite=regionsFromOCR(data,500,100).find(r=>r.text==='1 | PX-100 | Hex clamp | 2');
  assert.ok(composite); assert.equal(composite.y,.4); assert.ok(composite.width>0);
});
test('BOM preprocessing preserves measured length quantities and refuses ambiguous nonnumeric quantities', async () => {
  const {textFromOCR}=await import('../ingest.mjs');
  const data=ocrData([headerAtoms(20),[atom('1',25,40,5),atom('TUBE-7',70,40,55),atom('Tube',190,40,30),atom('162.36',350,40,35),atom('in.',390,40,15)]],'Original OCR');
  assert.match(textFromOCR(data),/1 \| TUBE-7 \| Tube \| 162\.36 in\./);
  const bad=ocrData([headerAtoms(20),[atom('1',25,40,5),atom('TUBE-7',70,40,55),atom('Tube',190,40,30),atom('O',365,40,6)]],'Original OCR');
  assert.equal(textFromOCR(bad),'Original OCR');
});
test('no header or pre-existing delimited BOM leaves OCR prose/table untouched', async () => {
  const {textFromOCR}=await import('../ingest.mjs');
  const prose='Part numbers and quantities must be checked.\nNever infer missing quantities.';
  assert.equal(textFromOCR(ocrData([[atom('Part',20,20),atom('numbers',55,20),atom('and',100,20),atom('quantities',140,20)]],prose)),prose);
  const existing='ITEM | PART NUMBER | DESCRIPTION | QTY.\n1 | A | Bolt | 2';
  assert.equal(textFromOCR(ocrData([headerAtoms(20),[atom('1',25,40,5),atom('A',70,40,10),atom('Bolt',190,40),atom('2',365,40,6)]],existing)),existing);
  assert.equal(textFromOCR({text:'QTY 2\nPART NUMBER A',blocks:[]}), 'QTY 2\nPART NUMBER A');
});
test('multiline description associates only neighboring description-column source words', async () => {
  const {textFromItems}=await import('../ingest.mjs');
  const atoms=[...headerAtoms(20),atom('Upper',190,34,40),atom('1',25,42,5),atom('PX-200',70,42,55),atom('assembly',190,42,60),atom('1',365,42,6),atom('Lower',190,50,40)];
  const text=textFromItems(atoms.map(pdfItem));
  assert.match(text,/1 \| PX-200 \| Upper assembly Lower \| 1/);
});

test('PDF extraction excludes text outside actual clip and restores visibility after graphics restore', async () => {
  const {filterVisiblePDFItems}=await import('../ingest.mjs');
  const OPS={save:1,constructPath:2,clip:3,endPath:4,showText:5,restore:6,setTextRenderingMode:7};
  const content={items:[
    {str:'HIDDEN BOM',transform:[10,0,0,10,120,150],width:60,height:10},
    {str:'VISIBLE',transform:[10,0,0,10,20,150],width:50,height:10},
    {str:'RESTORED',transform:[10,0,0,10,120,150],width:60,height:10},
    {str:'INVISIBLE',transform:[10,0,0,10,20,130],width:50,height:10},
  ],styles:{}};
  const ops={fnArray:[1,2,3,4,5,5,6,5,7,5],argsArray:[null,[[19],[0,0,100,200],[0,0,100,200]],null,null,[[{unicode:'HIDDEN BOM'}]],[[{unicode:'VISIBLE'}]],null,[[{unicode:'RESTORED'}]],[3],[[{unicode:'INVISIBLE'}]]]};
  const result=filterVisiblePDFItems(content,ops,OPS,{...viewport,viewBox:[0,0,200,200]});
  assert.deepEqual(result.items.map(i=>i.str),['VISIBLE','RESTORED']);
  assert.equal(result.removedTextItems,2);assert.equal(result.unmappedTextItems,0);
});
test('PDF clip filtering matches split text items and respects transformed clip rectangles', async () => {
  const {filterVisiblePDFItems}=await import('../ingest.mjs');
  const OPS={transform:1,constructPath:2,clip:3,endPath:4,showText:5};
  const ops={fnArray:[1,2,3,4,5],argsArray:[[1,0,0,1,100,0],[[19],[0,0,100,200],[0,0,100,200]],null,null,[[{unicode:'Hidden Visible'}]]]};
  const content={items:[{str:'Hidden',transform:[10,0,0,10,20,150],width:30,height:10},{str:'Visible',transform:[10,0,0,10,120,150],width:40,height:10}],styles:{}};
  assert.deepEqual(filterVisiblePDFItems(content,ops,OPS,{...viewport,viewBox:[0,0,200,200]}).items.map(i=>i.str),['Visible']);
});

test('OCR language/region options validate local models and map crop evidence into whole-page coordinates', async () => {
  const {validateOCRLanguage,validateOCRRegion,mapRegionsToPage}=await import('../ingest.mjs');
  assert.equal(validateOCRLanguage(),'eng+chi_sim');assert.equal(validateOCRLanguage('eng'),'eng');
  assert.throws(()=>validateOCRLanguage('random-remote-model'));
  const area={x:.65,y:.46,width:.32,height:.41};assert.deepEqual(validateOCRRegion(area),area);
  for(const invalid of [{x:-1,y:0,width:1,height:1},{x:.9,y:0,width:.2,height:1},{x:0,y:0,width:0,height:1}])assert.throws(()=>validateOCRRegion(invalid));
  const [r]=mapRegionsToPage([{text:'QTY',x:.5,y:.2,width:.1,height:.1}],area);
  assert.ok(Math.abs(r.x-.81)<1e-9);assert.ok(Math.abs(r.y-.542)<1e-9);assert.ok(Math.abs(r.width-.032)<1e-9);assert.ok(Math.abs(r.height-.041)<1e-9);
  await assert.rejects(()=>readFile(new File(['abc'],'x.txt'),null,{ocrLanguage:'fra'}),/OCR 语言/);
});

test('optional table cleanup removes long thin rules but preserves character strokes and thick black blocks', async () => {
  const {removeTableLines}=await import('../ingest.mjs');
  const width=240,height=160,data=new Uint8ClampedArray(width*height*4).fill(255);
  const fill=(x,y,w,h)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){const i=(yy*width+xx)*4;data[i]=data[i+1]=data[i+2]=0;}};
  fill(10,20,220,2);fill(20,10,2,140); // thin long horizontal and vertical rules
  fill(70,60,3,18);fill(70,60,14,3);fill(70,68,12,3); // synthetic letter-like strokes
  fill(80,110,100,12); // wide thick filled block must survive
  const cleaned=removeTableLines({data,width,height});
  const value=(x,y)=>cleaned.data[(y*width+x)*4];
  assert.equal(value(100,20),255);assert.equal(value(20,80),255);
  assert.equal(value(70,72),0);assert.equal(value(78,61),0);assert.equal(value(100,115),0);
  assert.ok(cleaned.removedPixels>400);
  // Input is immutable so evidence preview can continue displaying original pixels.
  assert.equal(data[(20*width+100)*4],0);
});
test('table cleanup protects text that touches a detected grid line', async () => {
  const {removeTableLines}=await import('../ingest.mjs');
  const width=200,height=100,data=new Uint8ClampedArray(width*height*4).fill(255);
  const black=(x,y)=>{const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;};
  for(let x=5;x<195;x++)black(x,50);
  for(let y=40;y<=50;y++)for(let x=79;x<=81;x++)black(x,y);
  const cleaned=removeTableLines({data,width,height});
  assert.equal(cleaned.data[(50*width+80)*4],0);assert.equal(cleaned.data[(50*width+150)*4],255);
});

test('drawing OCR windows cover the selected page area and overlap at every grid boundary', async () => {
  const {drawingOCRPlan}=await import('../ingest.mjs');
  const selected={x:.1,y:.2,width:.7,height:.6},passes=drawingOCRPlan(4800,3100,selected);
  assert.equal(passes.length,7);assert.deepEqual(passes[0].area,selected);
  assert.equal(new Set(passes.map(p=>p.id)).size,passes.length);
  assert.deepEqual(passes.slice(0,3).map(p=>p.psm),[11,3,3]);
  assert.equal(passes.filter(p=>p.cleanup).length,1);
  const tiles=passes.filter(p=>p.kind==='tile');assert.equal(tiles.length,4);
  for(const pass of passes) {
    if(pass.kind==='tile')assert.equal(pass.psm,6);
    const r=pass.area;
    assert.ok(r.x>=selected.x&&r.y>=selected.y);
    assert.ok(r.x+r.width<=selected.x+selected.width+1e-10&&r.y+r.height<=selected.y+selected.height+1e-10);
  }
  for(let y=0;y<=20;y++)for(let x=0;x<=20;x++) {
    const px=selected.x+selected.width*x/20,py=selected.y+selected.height*y/20;
    assert.ok(tiles.some(({area:r})=>px>=r.x-1e-10&&py>=r.y-1e-10&&px<=r.x+r.width+1e-10&&py<=r.y+r.height+1e-10));
  }
  const left=tiles[0].area,right=tiles[1].area,below=tiles[2].area;
  assert.ok(left.x+left.width>right.x);assert.ok(left.y+left.height>below.y);
  assert.throws(()=>drawingOCRPlan(0,100));
});

test('enhanced PDF render reaches requested detail beyond 3x while bounding canvas pixels', async () => {
  const {pdfRenderScale}=await import('../ingest.mjs');
  assert.equal(pdfRenderScale(792,612,4800),3);
  const scale=pdfRenderScale(792,612,4800,true);
  assert.equal(792*scale,4800);assert.ok(scale>3);
  const square=pdfRenderScale(1000,1000,4800,true);
  assert.ok(1000*1000*square*square<=18_000_001);
  assert.throws(()=>pdfRenderScale(0,10,4800,true));
});

test('drawing passes preserve conflicting numeric text, actual word boxes and original confidence', async () => {
  const {drawingOCRPass}=await import('../ingest.mjs');
  const original={text:'11.83 MIN\n',confidence:67,blocks:[{paragraphs:[{lines:[{text:'11.83 MIN',confidence:72,bbox:{x0:100,y0:50,x1:300,y1:90},words:[
    {text:'11.83',confidence:54,bbox:{x0:100,y0:50,x1:210,y1:90}},
    {text:'MIN',confidence:93,bbox:{x0:220,y0:50,x1:300,y1:90}},
  ]}]}]}]};
  const pass=drawingOCRPass(original,1000,500,{id:'tile-1-1',kind:'tile',psm:11,area:{x:.2,y:.3,width:.5,height:.4}});
  assert.equal(pass.text,'11.83 MIN\n');assert.equal(pass.confidence,67);
  assert.equal(pass.regions[0].x,.25);assert.ok(Math.abs(pass.regions[0].y-.34)<1e-10);
  assert.equal(pass.regions[0].sourcePass,'tile-1-1');assert.equal(pass.regions[0].sourceConfidence,72);
  assert.equal(pass.words[0].text,'11.83');assert.equal(pass.words[0].sourceConfidence,54);
  const alternative=drawingOCRPass({...original,text:'11.89 MIN\n'},1000,500,{id:'whole',area:{x:0,y:0,width:1,height:1}});
  assert.equal(pass.text,'11.83 MIN\n');assert.equal(alternative.text,'11.89 MIN\n');
  const noBoxes=drawingOCRPass({text:'5.00 ± .01'},1000,500,{id:'whole',area:{x:0,y:0,width:1,height:1}});
  assert.deepEqual(noBoxes.regions,[]);assert.deepEqual(noBoxes.words,[]);assert.equal(noBoxes.confidence,null);
});

test('drawing line cleanup keeps short plus/minus strokes while removing a long isolated dimension line', async () => {
  const {removeTableLines}=await import('../ingest.mjs');
  const width=500,height=260,data=new Uint8ClampedArray(width*height*4).fill(255);
  const black=(x,y)=>{const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;};
  for(let x=20;x<480;x++)black(x,150);
  const symbol=[];
  for(let x=210;x<=224;x++)for(const y of [85,98]){black(x,y);symbol.push([x,y]);}
  for(let y=79;y<=91;y++){black(217,y);symbol.push([217,y]);}
  const cleaned=removeTableLines({width,height,data},{minRun:100,minFraction:.03,maxThickness:5});
  assert.ok(cleaned.removedPixels>400);assert.equal(cleaned.data[(150*width+400)*4],255);
  for(const [x,y]of symbol)assert.equal(cleaned.data[(y*width+x)*4],0);
});
test('explicit drawing projection and dimension notation take priority over electrical ratings',()=>{
  assert.equal(classifyPage('DRAWING MADE IN THIRD ANGLE PROJECTION\n8.33 DIA\n11.89 MIN\nOPERATING TEMPERATURE\nVOLTAGE RATING'),'engineering');
});
