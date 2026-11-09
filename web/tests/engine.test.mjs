import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, searchDocuments, compareDocuments, buildInstructions, calculateQuote } from '../engine.mjs';

test('different product models retain scope and separate values', () => {
  const result = parseDocument([{page: 1, text: 'Model: MX-42\nRated voltage: 12 V\nModel: MX-420\nRated voltage: 24 V'}]);
  assert.deepEqual(result.fields.filter(f => f.name === '额定电压').map(f => [f.model,f.value]), [['MX-42','12 V'],['MX-420','24 V']]);
  assert.equal(searchDocuments([{id:'a',name:'MX-420.pdf',pages:[]}], 'MX-42').length, 0);
  assert.equal(searchDocuments([{id:'a',name:'MX-42.pdf',pages:[]}], 'MX-42').length, 1);
});
test('OPEN/CLOSED dimensions retain state and evidence', () => {
  const {fields} = parseDocument([{page:2,text:'OPEN Gap: 12 mm\nCLOSED Gap: 0.5 mm\n\nMaterial: Steel'}]);
  assert.deepEqual(fields.filter(f=>f.name==='间隙').map(f=>[f.state,f.value]), [['OPEN','12 mm'],['CLOSED','0.5 mm']]);
  assert.equal(fields[2].state, ''); assert.equal(fields[0].page,2); assert.equal(fields[0].evidence,'OPEN Gap: 12 mm');
});
test('BOM requires explicit headers and preserves quoted CSV cells', () => {
  const {bom,warnings} = parseDocument([{page:1,text:'1,SCR-1,Screw,8\nItem,Part Number,Description,Qty,Unit\n1,SCR-1,"Screw, plated",8,pcs\n2,NUT-1,Nut,NaN,pcs'}]);
  assert.equal(bom.length,1); assert.equal(bom[0].qty,8); assert.equal(bom[0].name,'Screw, plated');
  assert(warnings.some(w=>w.includes('无法可靠解析')));
});
test('empty pages and unsupported drawing content do not fabricate engineering fields', () => {
  const r=parseDocument([{page:1,text:''},{page:2,text:'Large unknown shape 12345'}]);
  assert.equal(r.fields.length,0); assert.equal(r.bom.length,0); assert(r.warnings.some(w=>w.includes('OCR')));
});
test('projection, roughness and tolerance text have evidence', () => {
  const r=parseDocument([{page:1,text:'THIRD ANGLE PROJECTION\nRa 1.6 um\nISO 2768-m\nØ20 ±0.05 mm'}]);
  assert(r.fields.some(f=>f.name==='投影法'&&f.value==='第三角投影'));
  assert(r.fields.some(f=>f.name==='粗糙度')); assert(r.fields.some(f=>f.name==='尺寸标注'));
});
test('visual and keyword scores remain separate; identical reference is excluded', () => {
  const ref={id:'a',name:'reference',hash:'0'.repeat(64)};
  const docs=[ref,{id:'b',name:'bracket',hash:'0'.repeat(64)},{id:'c',name:'motor',hash:'1'.repeat(64)}];
  const result=searchDocuments(docs,'motor',ref,0.8);
  assert.equal(result[0].doc.id,'b'); assert.equal(result[0].visualScore,1); assert.equal(result[0].textScore,0);
  assert.equal(searchDocuments(docs,'nonexistent').length,0);
});
test('field/BOM revision comparisons report values and quantities, ignoring page movement', () => {
  const a={fields:[{name:'间隙',state:'OPEN',value:'12 mm',page:1}],bom:[{partNumber:'S1',name:'Screw',qty:4,unit:'pcs'}]};
  const b={fields:[{name:'间隙',state:'OPEN',value:'15 mm',page:2}],bom:[{partNumber:'S1',name:'Screw',qty:6,unit:'pcs'}]};
  const r=compareDocuments(a,b); assert.equal(r.summary.total,2); assert.deepEqual(r.fields[0].before,['12 mm']);
  assert.equal(compareDocuments(a,{...a,fields:[{...a.fields[0],page:9}]}).summary.total,0);
});
test('instruction draft quotes evidence and excludes rejected results', () => {
  const text=buildInstructions({name:'drawing',fields:[{name:'材料',value:'Steel',page:2,evidence:'Material: Steel',status:'accepted'},{name:'秘密',value:'bad',status:'rejected'}]});
  assert(text.includes('Material: Steel')); assert(text.includes('待工程师审核')); assert(!text.includes('秘密'));
});
test('quote uses margin on sale price and separately accounts for overhead and tax', () => {
  const r=calculateQuote([{qty:2,unitPrice:50}],{labor:20,overheadPercent:10,marginPercent:20,taxPercent:13});
  assert.equal(r.material,100); assert.equal(r.overhead,12); assert.equal(r.cost,132); assert.equal(r.subtotal,165); assert.equal(r.tax,21.45); assert.equal(r.total,186.45);
});
test('invalid prices, invalid quantities and 100% margins are rejected', () => {
  for (const unitPrice of [-1,NaN,Infinity,'',null,true]) assert.throws(()=>calculateQuote([{qty:1,unitPrice}]));
  assert.equal(calculateQuote([{qty:0.5,unitPrice:1}]).total,.5);
  for(const qty of [-1,NaN,Infinity,'',null,true])assert.throws(()=>calculateQuote([{qty,unitPrice:1}]));
  assert.throws(()=>calculateQuote([],{marginPercent:100}));
  assert.equal(calculateQuote([{qty:0,unitPrice:1}]).total,0);
});

test('page-level search chooses best page and excludes identical content copies', () => {
 const doc={id:'db',name:'candidate.pdf',contentId:'same',pages:[{page:1,text:'',hash:'0'.repeat(64)},{page:2,text:'VALVE',hash:'1'.repeat(64)}]};
 const ref={name:'query.pdf',contentId:'other',pages:[{page:1,text:'VALVE',hash:'1'.repeat(64)}]};
 const results=searchDocuments([doc],'',ref,.5,{excludeIdentical:true});
 assert.equal(results.length,1); assert.equal(results[0].page,2); assert.equal(results[0].visualScore,1);
 assert.deepEqual(searchDocuments([doc],'',{...ref,contentId:'same'},.5,{excludeIdentical:true}),[]);
});

test('datasheet headings without colons preserve old and new part identities', () => {
  const {fields}=parseDocument([{page:1,file:'spec.pdf',text:'Part Number 0471190001\nPitch 4.00 mm\n2 Circuits\nOld Part Number 4809CP902BF\nNew Part Number 0097000001'}]);
  assert.equal(fields.find(f=>f.name==='零件号').value,'0471190001');
  const pitch=fields.find(f=>f.name==='间距');
  assert.equal(pitch.numericValue,4);assert.equal(pitch.unit,'mm');assert.equal(pitch.object,'待关联');assert.equal(pitch.file,'spec.pdf');assert.equal(pitch.model,'0471190001');
  assert.equal(fields.find(f=>f.name==='回路数').value,'2');
  assert.equal(fields.find(f=>f.name==='旧零件号').value,'4809CP902BF');
  assert.equal(fields.find(f=>f.name==='新零件号').value,'0097000001');
  assert.equal(fields.find(f=>f.name==='新零件号').model,'0097000001');
});
test('drawing and part numbers remain distinct and ordinary part numbers are not renamed as new',async()=>{
  const {fields}=parseDocument([{page:1,file:'connector.pdf',text:'Drawing No. DWG-A42\nPart Number 0097000001\nOld Part Number 4809CP902BF\nPitch 4.00 mm'}]);
  assert.equal(fields.find(f=>f.name==='图号').value,'DWG-A42');
  assert.equal(fields.find(f=>f.name==='零件号').value,'0097000001');
  assert.equal(fields.find(f=>f.name==='旧零件号').value,'4809CP902BF');
  assert(!fields.some(f=>f.name==='新零件号'));
  assert(fields.every(f=>f.page===1&&f.file==='connector.pdf'));
  assert.equal(fields.find(f=>f.name==='旧零件号').model,'0097000001');
  assert.equal(fields.find(f=>f.name==='间距').model,'0097000001');
  const {generateInstructions}=await import('../instructions.mjs');
  const chapter=generateInstructions({name:'connector.pdf',fields}).sections[0];
  for(const name of ['图号','零件号','旧零件号'])assert(chapter.items.some(item=>item.category==='evidence'&&item.text.includes(`${name}：`)));
});
test('multiline values never consume another recognized label or cross a page',()=>{
  const {fields}=parseDocument([{page:1,text:'Material\nMounting Type\nThrough Hole\nPitch'},{page:2,text:'4.00 mm\nSurface Finish\nTin plating'}]);
  assert(!fields.some(f=>f.name==='材料'));assert(!fields.some(f=>f.name==='间距'));
  assert.equal(fields.find(f=>f.name==='安装方式').value,'Through Hole');
  assert.equal(fields.find(f=>f.name==='表面处理').value,'Tin plating');
  assert.equal(fields.find(f=>f.name==='安装方式').evidence,'Mounting Type\nThrough Hole');
});
test('dimensions retain explicit object/view, nominal, units, tolerance and region',()=>{
  const {fields}=parseDocument([{page:3,regions:[{text:'OPEN Gap: 12 ±0.5 mm',bbox:[1,2,30,40]}],text:'View: Front view\nObject: Door edge\nOPEN Gap: 12 ±0.5 mm\n\nDiameter: 20 +0.2/-0.1 mm'}]);
  const gap=fields[0];assert.equal(gap.numericValue,12);assert.equal(gap.state,'OPEN');assert.equal(gap.object,'Door edge');assert.equal(gap.view,'Front view');
  assert.deepEqual(gap.tolerance,{plus:.5,minus:-.5,raw:'±0.5'});assert.deepEqual(gap.region.bbox,[1,2,30,40]);
  assert.equal(fields[1].object,'待关联');assert.equal(fields[1].view,'待关联');assert.equal(fields[1].region,null);
  assert.deepEqual(fields[1].tolerance,{plus:.2,minus:-.1,raw:'+0.2/-0.1'});
});
test('configurable rules use literal labels and optional default disabling',()=>{
  const {fields}=parseDocument([{page:1,text:'Custom (A): 33 mm\nMaterial: Steel\nIgnored: 12'}],{rules:[{name:'专用尺寸',label:'Custom (A)',dimension:true},{name:'忽略',label:'Ignored',enabled:false}],disabledRules:['材料']});
  assert.equal(fields.length,1);assert.equal(fields[0].name,'专用尺寸');assert.equal(fields[0].category,'dimension');assert.equal(fields[0].numericValue,33);
});
test('multi-axis dimensions preserve original value without assigning false scalar',()=>{
  const {fields}=parseDocument([{page:1,text:'Dimensions: 42 × 24 × 18 mm\nStructure: Right angle\nStandard: IEC 60529'}]);
  assert.equal(fields[0].numericValue,null);assert.equal(fields[0].value,'42 × 24 × 18 mm');
  assert.equal(fields[1].category,'structure');assert.equal(fields[2].category,'standard');
});
test('search scope narrows file, page type and category while returning matched pages',()=>{
  const docs=[{id:'a',name:'valve.pdf',pages:[{page:1,pageType:'drawing',text:'Steel'},{page:2,pageType:'datasheet',text:'Copper'}],fields:[{name:'材料',value:'Steel',page:1,category:'material'}]},{id:'b',name:'other.pdf',pages:[{page:1,text:'Steel',pageType:'drawing'}]}];
  const result=searchDocuments(docs,'Steel',null,.5,{scope:{fileIds:['a'],pageType:'drawing',category:'material'}});
  assert.equal(result.length,1);assert.equal(result[0].page,1);assert.deepEqual(result[0].evidence,['Steel']);assert.equal(result[0].pageMatches.length,1);
  assert.equal(searchDocuments(docs,'Steel',null,.5,{scope:{fileIds:['a'],pageType:'datasheet'}}).length,0);
});
test('query exclusion is configurable and structured similarity is distinct from visual match',()=>{
  const fields=[{name:'安装方式',value:'Through hole',category:'mounting',page:1}];
  const ref={id:'query',contentId:'same',name:'query.pdf',pages:[{page:1,text:'',hash:'0'.repeat(64)}],fields};
  const docs=[ref,{id:'match',name:'match.pdf',pages:[{page:1,text:'',hash:'1'.repeat(64)}],fields},{id:'visual',name:'visual.pdf',pages:[{page:1,text:'',hash:'0'.repeat(64)}],fields:[{name:'安装方式',value:'Panel',category:'mounting',page:1}]}];
  const r=searchDocuments(docs,'',ref,.5,{weights:{text:0,visual:0,structure:1}});
  assert.equal(r[0].doc.id,'match');assert.equal(r[0].structureScore,1);assert.equal(r[0].visualScore,0);
  assert(searchDocuments(docs,'',ref,.5,{excludeQuery:false}).some(x=>x.doc.id==='query'));
  assert(!searchDocuments(docs,'',ref,.5,{excludeQuery:false,excludeIdentical:true}).some(x=>x.doc.id==='query'));
  assert(r.find(x=>x.doc.id==='visual').differences.some(d=>d.name==='安装方式'));
});

test('PDF column separators isolate values without losing full source evidence',()=>{
  const {fields}=parseDocument([{page:2,text:'Part Number: | 0097000001\nOld Part Number | 4809CP902BF | 0.04mm (.025") pins\nMaterial - Metal | Brass | Halogen-Free\nMaterial - Plating Mating | Tin | Need more information\nRevision D 2026-11-08 Footer'}]);
  assert.equal(fields.find(f=>f.name==='零件号').value,'0097000001');
  assert.equal(fields.find(f=>f.name==='旧零件号').value,'4809CP902BF');
  assert.equal(fields.find(f=>f.name==='材料').value,'Brass');
  assert.equal(fields.find(f=>f.name==='表面处理').value,'Tin');
  assert.equal(fields.find(f=>f.name==='版本').value,'D');
  assert(fields.find(f=>f.name==='旧零件号').evidence.includes('0.04mm'));
});
test('generic field labels do not turn section headings into material or finish values',()=>{
  const {fields}=parseDocument([{page:1,text:'Material Info | Molex Incorporated\nFINISH NOTES:\nAdditional text\nRevision Date'}]);
  assert(!fields.some(f=>['材料','表面处理','版本'].includes(f.name)));
});

test('Molex mating pitch and populated/maximum circuit labels retain independent values',()=>{
  const text='Circuits (Loaded) | 2 | Need more information on product\nCircuits (maximum) | 2 | environmental compliance?\nPitch - Mating Interface (in) | 0.157 In\nPitch - Mating Interface (mm) | 4.00 mm';
  const {fields}=parseDocument([{page:1,text}]);
  assert.equal(fields.find(f=>f.name==='回路数(已装载)').value,'2');
  assert.equal(fields.find(f=>f.name==='回路数(最大)').value,'2');
  const pitch=fields.filter(f=>f.name==='配合间距');
  assert.equal(pitch.length,2);
  assert.deepEqual(pitch.map(f=>[f.numericValue,f.unit,f.object,f.view]),[[.157,'in','配合接口','待关联'],[4,'mm','配合接口','待关联']]);
  assert(pitch[1].evidence.includes('4.00 mm'));
});

// Regression fixtures transcribed from the user's PDFs; these are not held-out accuracy benchmarks.
test('real datasheet header and subtype regressions preserve numeric values and units',()=>{
  const {fields}=parseDocument([{page:3,text:'Material No | TEMPLATE FILENAME: PRODUCT_SPEC [SIZE_A](V.1). DOC\nMaterial No\n\nPitch - Term. Interface (in) | 0.050 In\nPitch - Term. Interface (mm) | 1.27 mm\nPlating min: Mating (μin) | 0.76\nPlating min: Termination (μm) | 2.54\nCircuits Detail | Power Alpha 24, Signal 10'}]);
  assert(!fields.some(f=>f.name==='材料'));
  assert.deepEqual(fields.filter(f=>f.name==='端接间距').map(f=>[f.numericValue,f.unit]),[[.05,'in'],[1.27,'mm']]);
  assert.equal(fields.find(f=>f.name==='配合面最小镀层厚度').numericValue,.76);
  assert.equal(fields.find(f=>f.name==='配合面最小镀层厚度').unit,'μin');
  assert.equal(fields.find(f=>f.name==='端接面最小镀层厚度').unit,'μm');
  assert.equal(fields.find(f=>f.name==='回路明细').value,'Power Alpha 24, Signal 10');
  assert(!fields.some(f=>f.name==='回路数'));
});
test('multiple pitches remain separate measurements instead of a false scalar',()=>{
  const {fields}=parseDocument([{page:1,text:'Pitch - Mating Interface (mm) | 2.54 mm, 3.18 mm, 5.08 mm\nDimensions: 42 × 24 × 18 mm\nGap: 12 +/-0.5 mm'}]);
  assert.equal(fields[0].numericValue,null);assert.deepEqual(fields[0].numericValues,[2.54,3.18,5.08]);
  assert.deepEqual(fields[0].measurements.map(m=>m.unit),['mm','mm','mm']);
  assert.deepEqual(fields[1].numericValues,[42,24,18]);
  assert.equal(fields[2].numericValue,12);assert.deepEqual(fields[2].numericValues,[12]);assert.equal(fields[2].tolerance.plus,.5);
});
test('a missing selected search channel cannot resurrect a zero-weight channel',()=>{
  const doc={id:'candidate',name:'candidate.txt',pages:[{page:1,text:'Steel'}]};
  const ref={id:'query',pages:[{page:1,text:'Steel',hash:'01'.repeat(32)}]};
  assert.deepEqual(searchDocuments([doc],'Steel',ref,.5,{weights:{text:0,visual:1,structure:0}}),[]);
  assert.deepEqual(searchDocuments([doc],'Steel',ref,.5,{weights:{text:0,visual:0,structure:0}}),[]);
  assert.equal(searchDocuments([doc],'Steel',ref,.5,{weights:{text:1,visual:1,structure:0}})[0].score,1);
});
test('comparison reports dimension association changes and ignores unknown-vs-empty associations',()=>{
  const field={name:'直径',value:'20 mm',object:'shaft',view:'front',state:'OPEN',model:'A'};
  const objectChange=compareDocuments({fields:[field]},{fields:[{...field,object:'hole'}]});
  assert.equal(objectChange.summary.fieldChanges,2);
  assert(objectChange.fields.some(d=>d.kind==='removed'&&d.name.includes('shaft')));
  assert(objectChange.fields.some(d=>d.kind==='added'&&d.name.includes('hole')));
  assert.equal(compareDocuments({fields:[field]},{fields:[{...field,view:'top'}]}).summary.fieldChanges,2);
  assert.equal(compareDocuments({fields:[{name:'间隙',value:'12 mm'}]},{fields:[{name:'间隙',value:'12 mm',object:'待关联',view:'待关联'}]}).summary.total,0);
});
test('comparison treats repeated field/BOM ordering as a multiset but preserves multiplicity',()=>{
  const fields=[{name:'材料',value:'Brass'},{name:'材料',value:'Plastic'}];
  const bom=[{partNumber:'S1',name:'Screw',qty:2},{partNumber:'S1',name:'Screw',qty:4}];
  assert.equal(compareDocuments({fields,bom},{fields:[...fields].reverse(),bom:[...bom].reverse()}).summary.total,0);
  assert.equal(compareDocuments({fields:[fields[0],fields[0]]},{fields:[fields[0]]}).summary.fieldChanges,1);
  assert.equal(compareDocuments({bom},{bom:[bom[0]]}).summary.bomChanges,1);
});

test('real user PDFs regression: header rejection, terminal pitch, plating and multi-pitch', {skip:!process.env.SPECFLOW_REAL_DRAWINGS}, async()=>{
  const fs=await import('node:fs/promises');const path=await import('node:path');
  const pdfjs=await import('../vendor/pdfjs/pdf.min.mjs');const {textFromItems}=await import('../ingest.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc=new URL('../vendor/pdfjs/pdf.worker.min.mjs',import.meta.url).href;
  const read=async name=>{
    const task=pdfjs.getDocument({data:new Uint8Array(await fs.readFile(path.join(process.env.SPECFLOW_REAL_DRAWINGS,name))),cMapUrl:new URL('../vendor/pdfjs/cmaps/',import.meta.url).pathname,cMapPacked:true,standardFontDataUrl:new URL('../vendor/pdfjs/standard_fonts/',import.meta.url).pathname,verbosity:0});
    try {const pdf=await task.promise,pages=[];for(let page=1;page<=pdf.numPages;page++)pages.push({page,text:textFromItems((await (await pdf.getPage(page)).getTextContent()).items)});return parseDocument(pages).fields;}finally{await task.destroy();}
  };
  const materials=await read('424910303.pdf');assert(!materials.some(f=>f.name==='材料'&&f.value==='No'));
  const identity=await read('0471190001.pdf');assert(identity.some(f=>f.name==='零件号'&&f.value==='0471190001'));
  assert(!identity.some(f=>f.name==='新零件号'||(f.name==='图号'&&f.value==='0471190001')));
  const connector=await read('0908163506.pdf');assert(connector.some(f=>f.name==='端接间距'&&f.numericValue===1.27&&f.unit==='mm'));
  assert(connector.some(f=>f.name==='配合面最小镀层厚度'&&f.numericValue===.76&&f.unit==='μin'));
  const multi=await read('879252000.pdf');assert(multi.some(f=>f.name==='回路明细'&&f.value==='Power Alpha 24, Signal 10'));
  const pitches=multi.find(f=>f.name==='配合间距'&&f.unit==='mm');assert.equal(pitches.numericValue,null);assert.deepEqual(pitches.numericValues,[2.54,3.18,5.08]);
});

test('BOM length quantities support explicit units without permitting fractional piece counts',()=>{
  const text='Item | Part Number | Description | Qty | Unit\n1 | T1 | Tube | 162.36 in. |\n2 | T2 | Wire | .5 | m\n3 | T3 | Cable | 2.75 | 米\n4 | C1 | Bolt | 0.5 | pcs\n5 | C2 | Bolt | 0.5 | each\n6 | C3 | Bolt | 0.5 |\n7 | C4 | Bolt | 2 unit |\n8 | BAD | Tube | 3.2 in. | mm\n9 | BAD2 | Tube | NaN | m\n10 | BAD3 | Tube | 2 nonsense |';
  const {bom,warnings}=parseDocument([{page:2,text}]);
  assert.deepEqual(bom.map(r=>[r.partNumber,r.qty,r.unit]),[['T1',162.36,'in.'],['T2',.5,'m'],['T3',2.75,'米'],['C4',2,'unit']]);
  assert.equal(warnings.filter(w=>w.includes('BOM 无法可靠解析')).length,6);
  assert(bom[0].evidence.includes('162.36 in.'));
});
test('fractional BOM measurements survive quote and sourced instruction output',()=>{
  const row={partNumber:'SS-T4-S-035-20',name:'SS TUBING',qty:162.36,unit:'in.',page:2,evidence:'162.36 in.'};
  const quote=calculateQuote([{...row,unitPrice:2}],{});
  assert.equal(quote.material,324.72);assert.equal(quote.total,324.72);
  assert(buildInstructions({name:'GSL5',bom:[row]}).includes('162.36 in.'));
});

test('inch marks in unquoted BOM descriptions do not hide remaining columns or rows',()=>{
 const text='ITEM | PART NUMBER | DESCRIPTION | QTY.\n10 | SS-4-TA-1-2 | 1/4" TA MALE ADAPTER | 3\n11 | SS-400-1-2 | 400 SERIES MALE CONNECTOR | 1\n24 | SS-T4-S-035-20 | 1/4" X .035 SS TUBING | 162.36 in.';
 const {bom}=parseDocument([{page:2,text}]);assert.equal(bom.length,3);assert.equal(bom[0].name,'1/4" TA MALE ADAPTER');assert.equal(bom[2].qty,162.36);assert.equal(bom[2].unit,'in.');
});

// Official Swagelok GSL5 drawing, both pages. Once used to repair extraction this is a regression, not a held-out benchmark.
// Source: https://www.swagelok.com/-/media/distributor-media/l-n/london/services/grab-sampling-systems/data-sheets/13-gsl5.ashx
// Enable with SPECFLOW_SWAGELOK_PDF=/absolute/path/to/swagelok-gsl5.pdf; the PDF is not bundled or published.
test('official Swagelok full PDF rejects clipped BOM text and restores 24 visible rows', {skip:!process.env.SPECFLOW_SWAGELOK_PDF}, async()=>{
  const fs=await import('node:fs/promises');const pdfjs=await import('../vendor/pdfjs/pdf.min.mjs');const {readPDFText}=await import('../ingest.mjs');const {generateInstructions}=await import('../instructions.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc=new URL('../vendor/pdfjs/pdf.worker.min.mjs',import.meta.url).href;
  const task=pdfjs.getDocument({data:new Uint8Array(await fs.readFile(process.env.SPECFLOW_SWAGELOK_PDF)),verbosity:0});
  try {
    const pdf=await task.promise;assert.equal(pdf.numPages,2);
    const pages=[];
    for(let page=1;page<=pdf.numPages;page++)pages.push({page,...await readPDFText(await pdf.getPage(page))});
    // Page 1 has clipped copies of drawing text; only the visible page 2 BOM may enter the result.
    assert(pages[0].removedTextItems>0);assert.equal(pages[0].unmappedTextItems,0);
    assert.equal(parseDocument([pages[0]]).bom.length,0);
    const {bom}=parseDocument(pages);
    assert.equal(bom.length,24);
    assert(bom.every(row=>row.page===2));
    for(const [item,part,qty] of [['1','SS-43YTLF2-10147',1],['2','PGI-63S-BG1-BAQX-G',1],['3','VAF-G2-05L-1-0-WZ',2],['4','KPR1CJA412A60000',1],['5','KPR1FJA412A60000',1],['6','PGI-63S-BG10-BAQX-G',1],['7','SS-MVS-32OZ-32-S4-S4-VI',1],['17','SS-400-61',5],['23','98164A106',10],['24','SS-T4-S-035-20',162.36]]){
      const row=bom.find(r=>r.item===item);assert(row);assert.equal(row.partNumber,part);assert.equal(row.qty,qty);assert.equal(row.page,2);
    }
    const tube=bom.find(r=>r.item==='24');assert.equal(tube.unit,'in.');assert(tube.evidence.includes('162.36'));
    for(const [item,y] of [['1',.4937],['24',.8426]]){
      const source=bom.find(r=>r.item===item).region,boxes=source?.boxes||[source];
      assert.equal(boxes.length,4); // item, specific part number, description and quantity on one visible row
      assert(boxes.every(box=>box&&box.x>.65&&Math.abs(box.y-y)<.003));
    }
    assert.equal(calculateQuote([{qty:tube.qty,unitPrice:2}],{}).material,324.72); // Arithmetic check with illustrative price.
    assert(generateInstructions({name:'Swagelok GSL5',fields:[],bom}).markdown.includes('162.36 in.'));
  } finally {await task.destroy();}
});

test('evidence regions prefer the complete source line over repeated fragments',()=>{
  const exact={text:'Length: 12 mm',x:.5,y:.4,width:.2,height:.02};
  const {fields}=parseDocument([{page:1,text:exact.text,regions:[{text:'1',x:.1,y:.1,width:.01,height:.02},{text:'12',x:.2,y:.2,width:.02,height:.02},exact]}]);
  assert.deepEqual(fields[0].region,exact);
});
test('BOM evidence locates neighboring cells through unique text rather than numeric substrings',()=>{
  const cell=(text,x,y,width=.04)=>({text,x,y,width,height:.01});
  const regions=[cell('1',.1,.5),cell('2',.2,.5),cell('1',.67,.5),cell('PN-12345',.7,.5,.07),cell('Specific valve',.79,.5,.1),cell('1',.94,.5),cell('1',.94,.52),cell('123',.67,.53)];
  const {bom}=parseDocument([{page:1,text:'Item | Part Number | Description | Qty\n1 | PN-12345 | Specific valve | 1',regions}]);
  assert.equal(bom[0].region.boxes.length,4);
  assert(bom[0].region.boxes.every(r=>r.x>.65&&r.y===.5));
});
test('ambiguous repeated evidence does not invent a region',()=>{
  const parse=regions=>parseDocument([{page:1,text:'Length: 12 mm',regions}]).fields[0].region;
  assert.equal(parse([{text:'12',x:.1,y:.2,width:.02,height:.01},{text:'12',x:.8,y:.7,width:.02,height:.01}]),null);
  assert.equal(parse([{text:'Length: 12 mm',x:.1,y:.2,width:.2,height:.01},{text:'Length: 12 mm',x:.8,y:.7,width:.2,height:.01}]),null);
  assert.deepEqual(parse([{text:'Length',bbox:[1,2,3,4]},{text:'12',bbox:[7,8,9,10]}]),{text:'Length',bbox:[1,2,3,4]});
});

test('adjacent unit-bearing column headings are not product model values',()=>{
  const {fields}=parseDocument([{page:10,text:'产品型号 | 工作温度（℃）\nModel\nWorking Pressure (MPa)\nModel: AX42(C)'}]);
  assert.deepEqual(fields.filter(f=>f.name==='产品型号').map(f=>f.value),['AX42(C)']);
  assert(!fields.some(f=>f.value==='工作温度(°C)'||f.value==='Working Pressure (MPa)'));
});

// This previously unseen manual revealed a false positive; after this repair it is a regression case.
test('real hydraulic manual rejects neighboring temperature heading as model', {skip:!process.env.SPECFLOW_REAL_CORPUS}, async()=>{
  const fs=await import('node:fs/promises');const path=await import('node:path');const pdfjs=await import('../vendor/pdfjs/pdf.min.mjs');const {textFromItems}=await import('../ingest.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc=new URL('../vendor/pdfjs/pdf.worker.min.mjs',import.meta.url).href;
  const task=pdfjs.getDocument({data:new Uint8Array(await fs.readFile(path.join(process.env.SPECFLOW_REAL_CORPUS,'原始资料','S04_中兴液压油缸产品手册.pdf'))),cMapUrl:new URL('../vendor/pdfjs/cmaps/',import.meta.url).pathname,cMapPacked:true,verbosity:0});
  try{const pdf=await task.promise,page=await pdf.getPage(10),text=textFromItems((await page.getTextContent()).items);assert(text.includes('产品型号'));assert(text.includes('工作温度'));const {fields}=parseDocument([{page:10,text}]);assert(!fields.some(f=>f.name==='产品型号'&&f.value.includes('工作温度')));}finally{await task.destroy();}
});
