import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDocument,editDimension} from '../engine.mjs';
import {generateInstructions} from '../instructions.mjs';

const page={page:3,text:'Custom: preserve me',drawingOCR:{passes:[{id:'whole',text:'DIMENSIONS IN mm [INCHES]\n20.32 MAX\n[.800]\nCustom: preserve me'}]}};
test('enhanced drawing route preserves file, page, custom rules and disabled defaults',()=>{
  const result=parseDocument([page],{file:'drawing.pdf',rules:[{name:'客户要求',label:'Custom'}]});
  const dim=result.fields.find(f=>f.category==='dimension');
  assert.equal(dim.numericValue,20.32);assert.equal(dim.limit,'max');assert.equal(dim.file,'drawing.pdf');assert.equal(dim.page,3);
  assert.equal(result.fields.find(f=>f.name==='客户要求').value,'preserve me');
  assert.equal(new Set(result.fields.map(f=>f.id)).size,result.fields.length);
  assert(!parseDocument([page],{disabledRules:['尺寸标注']}).fields.some(f=>f.category==='dimension'));
  assert.equal(parseDocument([page],{includeDefaults:false}).fields.length,0);
});
test('manual dimension edits recompute limits and units and clear stale OCR uncertainty',()=>{
  const edited=editDimension({page:1,object:'孔',view:'正视图'},'6.35 ±0.05 mm [.250 ±.002 in]');
  assert.equal(edited.numericValue,6.35);assert.equal(edited.unit,'mm');assert.deepEqual(edited.tolerance,{plus:.05,minus:-.05,raw:'±0.05'});
  assert.equal(edited.alternateMeasurements[0].value,.25);assert.equal(edited.limit,null);assert.equal(edited.ocrConflict,false);
  assert.equal(editDimension({},'12 mm MIN').limit,'min');
});
test('drawing fields reach configured instruction chapters with uncertainty and source',()=>{
  const doc={name:'drawing.pdf',fields:[
    {name:'直径标注',value:'6.35 mm DIA',category:'dimension',page:1,evidence:'6.35 DIA',limit:'min',ocrConflict:true},
    {name:'舌片厚度',value:'1.4 mm',category:'dimension',page:1,evidence:'TONGUE MATERIAL THK:1.4'},
    {name:'表面处理要求',value:'TIN PLATE',category:'process',page:1,evidence:'TIN PLATE'},
  ]};
  const result=generateInstructions(doc);
  assert.equal(result.sections.find(s=>s.id==='quality').items.filter(i=>i.category==='evidence').length,2);
  assert(result.sections.find(s=>s.id==='technical').items.some(i=>i.text.includes('TIN PLATE')));
  assert(result.markdown.includes('OCR 存在不同候选'));assert(result.markdown.includes('最小值'));
  assert(result.missing.includes('作业步骤'));assert.equal(result.status,'draft');
});
