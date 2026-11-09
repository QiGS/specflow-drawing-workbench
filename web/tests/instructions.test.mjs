import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultRules,defaultTemplate,generateInstructions} from '../instructions.mjs';
const makeField=(name,value,extra={})=>({id:name,name,value,page:2,evidence:`${name}: ${value}`,status:'pending',...extra});
const doc={id:'doc-1',name:'AX42.pdf',fields:[makeField('图号','AX42'),makeField('材料','SUS304',{region:{x:12,y:30,w:80,h:10}}),makeField('尺寸','25 ± 0.1 mm',{state:'OPEN'}),makeField('扭矩','99 N·m',{status:'rejected'})],bom:[]};
test('eight sections identify fixed content, original evidence, and rules',()=>{
  const result=generateInstructions(doc);
  assert.equal(result.sections.length,8);
  assert.deepEqual([...new Set(result.sections.flatMap(s=>s.items.map(i=>i.category)))].sort(),['evidence','fixed','rule']);
  assert.ok(result.markdown.includes('【固定模板】')); assert.ok(result.markdown.includes('【图纸证据】')); assert.ok(result.markdown.includes('【规则生成】'));
});
test('provenance retains source name, page, region and field ID',()=>{
  const result=generateInstructions(doc); const source=result.provenance.find(p=>p.fieldIds.includes('材料'));
  assert.deepEqual(source,{sourceName:'AX42.pdf',documentId:'doc-1',page:2,region:{x:12,y:30,w:80,h:10},fieldIds:['材料'],evidence:'材料: SUS304'});
  assert.ok(result.markdown.includes('OPEN / 尺寸'));
});
test('rejected values are omitted and pending is never approved',()=>{
  const result=generateInstructions(doc);
  assert.ok(!result.markdown.includes('99 N')); assert.ok(!result.html.includes('99 N'));
  assert.equal(result.status,'draft'); assert.ok(result.markdown.includes('待复核'));
  assert.equal(result.sections.flatMap(s=>s.items).filter(i=>i.category==='evidence').every(i=>i.reviewStatus==='pending'),true);
});
test('approved sources do not grant an approved document status',()=>{
  const result=generateInstructions({name:'reviewed',fields:[makeField('图号','A',{status:'approved'})]},{rules:{...defaultRules,requiredFields:['图号']}});
  assert.equal(result.status,'draft'); assert.equal(result.exportBlocked,false); assert.ok(result.markdown.includes('该来源已复核'));
});
test('missing information is explicit and configured export rule is honored',()=>{
  const result=generateInstructions(doc); assert.deepEqual(result.missing,['版本','技术要求','作业步骤']); assert.equal(result.exportBlocked,true);
  const unblocked=generateInstructions(doc,{rules:{...defaultRules,blockExportOnMissing:false}}); assert.equal(unblocked.exportBlocked,false); assert.deepEqual(unblocked.missing,result.missing);
});
test('does not invent process torque, temperature, time, equipment or step order',()=>{
  const result=generateInstructions({name:'empty',fields:[]});
  assert.equal(result.provenance.length,0);
  assert.ok(!/\d\s*(?:N[·.]m|℃|°C|min|秒|分钟)/.test(result.markdown));
  assert.ok(!result.markdown.includes('钻床')); assert.ok(!result.markdown.includes('先加工'));
  assert.equal(result.sections.find(s=>s.id==='steps').items.some(i=>i.category==='evidence'),false);
});
test('step instructions are copied only from explicit evidence',()=>{
  const result=generateInstructions({name:'steps',fields:[makeField('作业步骤','按已批准工艺卡 A 执行。')]});
  assert.ok(result.sections.find(s=>s.id==='steps').items.some(i=>i.category==='evidence'&&i.text.includes('按已批准工艺卡 A 执行。')));
});
test('HTML and Markdown escape hostile names, evidence, title and template text',()=>{
  const template=structuredClone(defaultTemplate); template.sections[0].title='<img src=x onerror=alert(1)>'; template.sections[0].fixedText='<script>alert(1)</script>';
  const result=generateInstructions({name:'<svg onload=alert(1)>',fields:[makeField('图号','[x](javascript:alert(1))',{evidence:'<script>bad()</script>'})]},{template});
  assert.ok(!result.html.includes('<script>')); assert.ok(!result.html.includes('<img')); assert.ok(!result.html.includes('<svg'));
  assert.ok(result.html.includes('&lt;script&gt;')); assert.ok(result.markdown.includes('\\[x\\]'));
});
test('invalid configurations fail explicitly',()=>{
  for(const rules of [null,[],{...defaultRules,requiredFields:'图号'},{...defaultRules,blockExportOnMissing:'true'},{...defaultRules,version:''}]) assert.throws(()=>generateInstructions(doc,{rules}));
  for(const template of [{version:'1',sections:[]},{version:'1',sections:Array(8).fill({title:'x',fieldNames:'图号'})},null]) assert.throws(()=>generateInstructions(doc,{template}));
});
test('BOM provenance and rejected exclusion, without mutating original objects',()=>{
  const sample={name:'bom',fields:[],bom:[{id:'r1',name:'支架',qty:2,page:3,evidence:'支架 | 2',status:'pending'},{id:'r2',name:'rejected part',qty:1,status:'rejected'}]};
  const before=JSON.stringify(sample); const result=generateInstructions(sample);
  assert.ok(result.markdown.includes('支架')); assert.ok(!result.markdown.includes('rejected part')); assert.deepEqual(result.provenance[0].fieldIds,['r1']);
  assert.equal(JSON.stringify(sample),before);
});

test('long region evidence remains structured without overwhelming the instruction text',()=>{
  const region={boxes:Array.from({length:4},(_,i)=>({x:.65+i*.05,y:.49,width:.04,height:.01,text:'cell'}))};
  const result=generateInstructions({name:'table',bom:[{id:'r',name:'Valve',qty:1,page:2,evidence:'Valve | 1',region}]});
  assert.deepEqual(result.provenance[0].region,region);
  assert.ok(result.markdown.includes('4 处来源区域'));
  assert.ok(!result.markdown.includes('"boxes"'));
});

test('default template maps VLM neutral dimensions and category facts without inventing steps',()=>{
  const fields=[
    makeField('尺寸标注1','8.33 ±0.13 DIA',{category:'dimension',object:null,view:null,state:null,unit:null,geometryAssociationStatus:'unconfirmed'}),
    makeField('Drawing Number','C-34065',{category:'identity'}),makeField('Copper Body','COPPER',{category:'material'}),
    makeField('Surface note','TIN PLATED',{category:'process'}),makeField('Specification','UL 486',{category:'standard'}),
    makeField('Connection','RING TERMINAL',{category:'structure'}),makeField('Performance','600 V',{category:'performance'}),
  ];
  const result=generateInstructions({name:'visual',fields});
  const idsIn=section=>result.sections.find(s=>s.id===section).items.filter(i=>i.category==='evidence').flatMap(i=>i.source.fieldIds);
  assert.deepEqual(idsIn('quality'),['尺寸标注1']);assert.deepEqual(idsIn('applicable'),['Drawing Number','Connection']);
  assert.deepEqual(idsIn('materials'),['Copper Body']);assert.deepEqual(idsIn('technical'),['Surface note','Specification','Performance']);
  assert.deepEqual(idsIn('steps'),[]);assert(result.missing.includes('作业步骤'));
  assert(result.markdown.includes('对象：待确认'));assert(result.markdown.includes('单位：未提供，待确认'));assert(result.markdown.includes('状态：待确认'));
  assert(result.markdown.includes('几何关联待确认'));assert.equal(result.fieldSelectionMode,'default_name_and_category');
});
test('explicit default field names retain their original chapters before category fallback',()=>{
  const result=generateInstructions({fields:[makeField('作业步骤','按指定工艺卡执行',{category:'process'}),makeField('公差标准','ISO 2768',{category:'standard'})]});
  const text=id=>result.sections.find(s=>s.id===id).items.filter(i=>i.category==='evidence').map(i=>i.text).join(' ');
  assert(text('steps').includes('按指定工艺卡'));assert(text('quality').includes('ISO 2768'));
  assert(!text('technical').includes('按指定工艺卡'));assert(!text('technical').includes('ISO 2768'));
});
test('custom templates use only exact explicit fieldNames, even with default-like content',()=>{
  const template=structuredClone(defaultTemplate);template.sections[4].fieldNames=['尺寸标注2'];
  const result=generateInstructions({fields:[makeField('尺寸标注1','8.33',{category:'dimension'}),makeField('尺寸标注2','13.49',{category:'dimension'}),makeField('Copper Body','C11000',{category:'material'})]},{template});
  assert.equal(result.fieldSelectionMode,'custom_field_names');
  assert.deepEqual(result.provenance.flatMap(p=>p.fieldIds),['尺寸标注2']);assert(!result.markdown.includes('8.33'));assert(!result.markdown.includes('C11000'));
});
test('manual units and tolerance references retain source evidence without changing explicit dimensions',()=>{
  const source={page:2,observationId:'units-1',region:{x:.1,y:.8,width:.3,height:.1},documentSha256:'a'.repeat(64)};
  const field=makeField('尺寸标注1','8.33 ±0.13',{category:'dimension',unit:'MM',object:null,view:null,state:null,tolerance:{raw:'±0.13'},unitSource:source,unitEvidence:'DIMENSIONS IN MILLIMETERS',generalToleranceReferences:['tol-1'],geometryAssociationStatus:'unconfirmed',provenance:{documentSha256:'a'.repeat(64),imageId:'page_2',evidenceIds:['dim-1'],coordinates:'model_estimate_unreviewed'}});
  const sample={id:'source',name:'vision.pdf',fields:[field],referenceSuggestions:[{id:'tol-1',raw:'UNLESS OTHERWISE SPECIFIED .XX ±.02',source,status:'manually_linked_pending_review',appliedToFieldIds:[field.id]}],history:[{at:'2026-11-09T10:00:00Z',action:'人工确认单位来源',fieldId:field.id,before:'',after:'MM'}]};
  const before=JSON.stringify(sample),result=generateInstructions(sample),evidence=result.provenance[0];
  assert.equal(evidence.documentSha256,'a'.repeat(64));assert.deepEqual(evidence.evidenceIds,['dim-1']);assert.equal(evidence.unitEvidence,'DIMENSIONS IN MILLIMETERS');
  assert.equal(evidence.generalToleranceReferences[0].id,'tol-1');assert.equal(evidence.manualAssociations[0].after,'MM');
  assert(result.markdown.includes('单位来源：第 2 页'));assert(result.html.includes('人工确认单位来源'));assert(result.html.includes('证据引用：dim-1'));
  assert(result.markdown.includes('未替代专用公差，未计算公差数值'));assert(result.markdown.includes('公差：±0.13'));
  assert.equal(JSON.stringify(sample),before);assert.equal(result.sections[4].items.find(i=>i.category==='evidence').reviewStatus,'pending');
});
test('packaging and quarantined candidates never become instruction material or production quantities',()=>{
  const pack={id:'pack-row',name:'PACKAGE-SENTINEL',qty:2500,quantityRaw:'2500',status:'pending'};
  const candidate={id:'raw-candidate',name:'REJECTED-SENTINEL',qty:999,status:'pending'};
  const sample={name:'separate',fields:[makeField('尺寸标注1','3.5',{category:'dimension'})],bom:[pack,candidate,{id:'manual-bom',name:'人工支架',qty:2,status:'pending'}],packagingVariants:[pack],visionQuarantine:[{id:'quarantine-wrapper',item:candidate,error:'Not assembly BOM'}]};
  const result=generateInstructions(sample);
  for(const value of ['PACKAGE-SENTINEL','REJECTED-SENTINEL','2500','999']){assert(!result.markdown.includes(value));assert(!result.html.includes(value));}
  assert(result.markdown.includes('人工支架'));assert(result.markdown.includes('不作为作业步骤、装配物料或生产用量'));
  assert(!result.provenance.some(p=>p.fieldIds.includes('pack-row')||p.fieldIds.includes('raw-candidate')));
});

test('default required fields recognize explicit English aliases while absent revision and steps stay missing',()=>{
 const fields=[makeField('Drawing Number','C-34065',{category:'identity'}),makeField('Material','COPPER',{category:'material'}),makeField('尺寸标注1','8.33',{category:'dimension'}),makeField('Note 4','TIN PLATED',{category:'process'})];
 const result=generateInstructions({fields});assert.deepEqual(result.missing,['版本','作业步骤']);assert.equal(result.exportBlocked,true);
 assert(result.sections.find(s=>s.id==='steps').items.every(i=>i.category!=='evidence'));
 const explicit=generateInstructions({fields:[...fields,makeField('Revision','B',{category:'identity'}),makeField('Operation Steps','Follow approved card A') ]});
 assert.deepEqual(explicit.missing,[]);assert.equal(explicit.status,'draft');
 assert(explicit.sections.find(s=>s.id==='steps').items.some(i=>i.category==='evidence'&&i.text.includes('Follow approved card A')));
});
test('default technical requirement presence accepts a cited standard but not identity, structure or packaging',()=>{
 const fields=[makeField('Drawing No.','D-2'),makeField('Material','Steel'),makeField('Dimensions','2.0'),makeField('Reference standard','ISO 2768',{category:'standard'})];
 assert.deepEqual(generateInstructions({fields}).missing,['版本','作业步骤']);
 const noTechnical={fields:fields.slice(0,3).concat(makeField('Product name','Standard component',{category:'identity'})),packagingVariants:[{id:'p',raw:'TECHNICAL REQUIREMENTS',quantityRaw:'2500'}]};
 assert(generateInstructions(noTechnical).missing.includes('技术要求'));
 const rejected=fields.map(f=>f.category==='standard'?{...f,status:'rejected'}:f);assert(generateInstructions({fields:rejected}).missing.includes('技术要求'));
});
test('custom required rules do not silently adopt default aliases or category matching',()=>{
 const fields=[makeField('Drawing Number','D-2'),makeField('Material','Steel'),makeField('Note 4','TIN PLATED',{category:'process'})];
 const rules={...defaultRules,requiredFields:['图号','材料','技术要求']};
 assert.deepEqual(generateInstructions({fields},{rules}).missing,['图号','材料','技术要求']);
 const explicit={...rules,requiredFields:['Drawing Number','Material','Note 4']};assert.deepEqual(generateInstructions({fields},{rules:explicit}).missing,[]);
});
