import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDrawingFields } from '../drawing.mjs';

const line=(text,x,y,width=.15,height=.012,extra={})=>({text,x,y,width,height,...extra});
const parse=regions=>extractDrawingFields({page:3,regions,text:regions.map(r=>r.text).join('\n')});
const dims=result=>result.fields.filter(f=>f.category==='dimension');

test('free callouts retain dual units, limits and evidence without inferring objects',()=>{
  const regions=[line('DIMENSIONS IN mm [INCHES]',.7,.9,.25),line('12.70 ±0.25 DIA',.3,.2),line('[.500 ±.010]',.3,.217),line('25.40 MAX',.1,.5),line('[1.000]',.1,.517),line('15.24',.5,.3),line('[.600]',.5,.317)];
  const result=parse(regions),fields=dims(result);
  assert.equal(fields.length,3);
  const diameter=fields.find(f=>f.name==='直径标注');
  assert.equal(diameter.numericValue,12.7);assert.equal(diameter.unit,'mm');
  assert.deepEqual(diameter.tolerance,{plus:.25,minus:-.25,raw:'±0.25'});
  assert.equal(diameter.alternateMeasurements[0].value,.5);assert.equal(diameter.alternateMeasurements[0].unit,'in');
  assert.equal(diameter.dualUnitValidation.status,'consistent');
  assert.equal(diameter.evidence,'12.70 ±0.25 DIA\n[.500 ±.010]');
  assert.equal(diameter.region.boxes.length,2);
  assert.equal(fields.find(f=>f.numericValue===25.4).limit,'max');
  assert(fields.every(f=>f.object==='待关联'&&f.view==='待关联'&&f.status==='pending'&&f.page===3));
  assert(fields.every(f=>!f.value.includes('总长')));
});

test('dimension pairing uses coordinates instead of the next unrelated text row',()=>{
  const result=parse([line('25.4 MAX',.1,.2),line('[999]',.8,.21),line('[1.000 in]',.1,.22)]);
  assert.equal(dims(result)[0].alternateMeasurements[0].value,1);
  assert.equal(dims(result)[0].unit,'');
  assert.equal(dims(result)[0].alternateMeasurements[0].unit,'in');
});

test('numeric OCR text and packaging quantities are not fabricated dimensions or BOM',()=>{
  const result=parse([line('1500',.6,.5),line('ON TAPE, REEL',.7,.5),line('A-123',.85,.5),line('QUANTITY',.6,.7),line('PACKAGE TYPE',.7,.7),line('PART NO',.85,.7),line('12345',.1,.2),line('A',.1,.3)]);
  assert.equal(result.fields.length,0);assert(result.warnings.some(w=>w.includes('包装规格表')));
  assert.equal(result.bom,undefined);
});

test('explicit title block labels associate only with the nearby column beneath',()=>{
  const result=parse([line('NAME',.65,.7,.3),line('QUANTITY',.2,.7),line('OTHER CELL',.2,.72),line('TERMINAL, RING TONGUE',.65,.72,.3),line('DRAWING NO',.7,.85),line('C-AB927',.7,.87),line('MATERIAL',.4,.7),line('COPPER PER ASTM B-152',.4,.72,.2),line('PVC',.4,.736),line('REV',.9,.85,.04),line('Q',.9,.87,.04)]);
  assert.equal(result.fields.find(f=>f.name==='名称').value,'TERMINAL, RING TONGUE');
  assert.equal(result.fields.find(f=>f.name==='图号').value,'C-AB927');
  assert.equal(result.fields.find(f=>f.name==='材料').value,'COPPER PER ASTM B-152 / PVC');
  assert.equal(result.fields.find(f=>f.name==='版本').value,'Q');
  assert(!result.fields.some(f=>f.value.includes('OTHER CELL')));
});

test('named material thickness and explicit numbered notes preserve source semantics',()=>{
  const result=parse([line('3 TONGUE MATERIAL THK: 1.50 ±0.05 [.059 ±.002]',.6,.3,.35),line('4 TIN PLATE PER ASTM B 545',.6,.4,.35),line('5 GOLD FLASH PER MIL-G-45204 OVER',.6,.43,.35),line('NICKEL PLATE PER QQ-N-290',.6,.45,.35),line('6 YELLOW INSULATION',.6,.48),line('7 REMOVE ALL BURRS',.6,.52),line('INSULATION',.1,.2),line('SERRATIONS',.2,.2),line('BODY',.3,.5),line('DRAWING MADE IN first angle PROJECTION',.1,.05,.4)]);
  assert.equal(result.fields.find(f=>f.name==='舌片厚度').object,'舌片');
  assert.equal(result.fields.find(f=>f.name==='舌片厚度').numericValue,1.5);
  assert(result.fields.some(f=>f.value==='GOLD FLASH PER MIL-G-45204 OVER NICKEL PLATE PER QQ-N-290'&&f.region.boxes.length===2));
  assert.equal(result.fields.filter(f=>f.name==='结构标注').length,3);
  assert.equal(result.fields.find(f=>f.name==='投影法').value,'第一角投影');
  assert(result.fields.some(f=>f.value==='REMOVE ALL BURRS'));
});

test('symmetric and asymmetric tolerance signs are not confused with nominal values',()=>{
  const result=parse([line('20 +0.2/-0.1 mm',.1,.2),line('10 +/- .5 mm MIN',.3,.4)]);
  assert.deepEqual(dims(result)[0].tolerance,{plus:.2,minus:-.1,raw:'+0.2/-0.1'});
  assert.equal(dims(result)[1].limit,'min');assert.equal(dims(result)[1].tolerance.minus,-.5);
});

test('stacked tolerance deviations require spatial adjacency and retain all boxes',()=>{
  const result=parse([line('10.00',.2,.2,.06,.02),line('+0.02',.265,.19,.04,.012),line('-0.01',.265,.21,.04,.012),line('+99',.8,.2),line('-88',.8,.22)]);
  assert.equal(dims(result).length,1);
  assert.deepEqual(dims(result)[0].tolerance,{plus:.02,minus:-.01,raw:'+0.02/-0.01'});
  assert.equal(dims(result)[0].region.boxes.length,3);
});

test('multi-pass conflicts retain losing evidence and prefer explicit dual-unit consistency',()=>{
  const wrong=[line('12.80 MAX',.2,.3,.15,.012,{sourceConfidence:99}),line('[.500]',.2,.318,.1,.012,{sourceConfidence:99})];
  const right=[line('12.70 MAX',.202,.3,.15,.012,{sourceConfidence:80}),line('[.500]',.202,.318,.1,.012,{sourceConfidence:80}),line('DIMENSIONS IN mm [INCHES]',.7,.9,.2)];
  const result=extractDrawingFields({page:1,drawingOCR:{passes:[{id:'whole',regions:wrong},{id:'tile',regions:right}]}});
  const dimension=dims(result)[0];assert.equal(dims(result).length,1);
  assert.equal(dimension.numericValue,12.7);assert.equal(dimension.dualUnitValidation.status,'consistent');
  assert.equal(dimension.otherCandidates[0].numericValue,12.8);assert.equal(dimension.otherCandidates[0].dualUnitValidation.status,'mismatch');
  assert.equal(dimension.otherCandidates[0].evidence,'12.80 MAX\n[.500]');
  assert.deepEqual(dimension.sourcePasses,['tile']);assert.equal(dimension.status,'pending');
  assert(result.warnings.some(w=>w.includes('分歧')));
});

test('independent OCR agreement merges provenance and separates the same number in another position',()=>{
  const r=[line('40 mm MIN',.2,.3),line('40 mm MIN',.2,.6)];
  const result=extractDrawingFields({page:1,drawingOCR:{passes:[{id:'a',regions:r},{id:'b',regions:r.map(l=>({...l,x:l.x+.001}))}]}});
  assert.equal(dims(result).length,2);assert(dims(result).every(f=>f.sourcePasses.length===2&&!f.otherCandidates));
});

test('ambiguous units stay unspecified and incompatible dual values are never corrected',()=>{
  const a=parse([line('9.82 MAX',.1,.3),line('[.300]',.1,.32)]);
  assert.equal(dims(a)[0].unit,'');assert.equal(dims(a)[0].alternateMeasurements[0].unit,'');assert.equal(dims(a)[0].dualUnitValidation,undefined);
  const b=parse([line('9.82 MAX',.1,.3),line('[.300]',.1,.32),line('DIMENSIONS IN mm [INCHES]',.7,.9,.25)]);
  assert.equal(dims(b)[0].numericValue,9.82);assert.equal(dims(b)[0].dualUnitValidation.status,'mismatch');assert(b.warnings.some(w=>w.includes('换算不一致')));
});

test('inline title cells are parsed, while material thickness remains a dimensional annotation',()=>{
  const result=parse([line('DRAWING NO: DWG-A99',.7,.8),line('NAME TERMINAL',.7,.7),line('MATERIAL COPPER',.5,.7),line('MATERIAL THK: 2 mm',.5,.6),line('REV: A2',.9,.8,.07),line('| 12.5 mm MAX |',.1,.3)]);
  assert.equal(result.fields.find(f=>f.name==='图号').value,'DWG-A99');
  assert.equal(result.fields.find(f=>f.name==='材料').value,'COPPER');
  assert.equal(result.fields.filter(f=>f.name==='材料').length,1);
  assert.equal(result.fields.find(f=>f.name==='材料厚度').numericValue,2);
  assert.equal(result.fields.find(f=>f.name==='版本').value,'A2');
  assert(dims(result).some(f=>f.numericValue===12.5&&f.limit==='max'));
});

test('large zero-confidence graphics and distant footnote digits cannot borrow bracket dimensions',()=>{
  const result=parse([line('3',.24,.39,.11,.095,{sourceConfidence:0}),line('2',.35,.39,.06,.095,{sourceConfidence:0}),line('[.468]',.146,.555,.044,.013),line('2',.584,.35,.006,.012),line('[.531]',.47,.40,.044,.013)]);
  assert.equal(dims(result).length,0);
});

test('sparse horizontal OCR fragments retain MAX and unresolved tolerance symbols without inventing signs',()=>{
  const result=parse([line('17.20',.2,.3,.04,.013),line('MAX',.26,.3,.025,.013),line('[.677]',.2,.32,.05,.013),line('9.25',.4,.15,.032,.013),line('+£0.20',.44,.14,.04,.013),line('DIA',.49,.15,.024,.013)]);
  assert.equal(dims(result).length,2);
  assert.equal(dims(result).find(f=>f.numericValue===17.2).limit,'max');
  const uncertain=dims(result).find(f=>f.numericValue===9.25);
  assert.equal(uncertain.name,'直径标注');assert.equal(uncertain.tolerance,null);
  assert.deepEqual(uncertain.unresolvedAnnotations,['+£0.20']);assert(uncertain.value.includes('待复核'));
  assert.equal(uncertain.region.boxes.length,3);
});

test('shared units cite a complete declaration instead of selecting truncated OCR evidence',()=>{
  const result=extractDrawingFields({page:1,drawingOCR:{passes:[
    {id:'cropped',regions:[line('DIMENSIONS IN r',.5,.8,.1,.01,{sourceConfidence:99}),line('12.7 MAX',.2,.3)]},
    {id:'complete',regions:[line('DIMENSIONS IN mm [INCHES]',.5,.8,.2,.01,{sourceConfidence:70})]}
  ]}});
  const units=result.fields.filter(f=>f.name==='尺寸单位');assert.equal(units.length,1);
  assert.equal(units[0].evidence,'DIMENSIONS IN mm [INCHES]');
  assert.equal(dims(result)[0].unitSource.evidence,'DIMENSIONS IN mm [INCHES]');
  assert.equal(dims(result)[0].unitSource.region.sourceConfidence,70);
});

test('complete material evidence beats cropped confidence and a footer revision sentence is not a title',()=>{
  const head=line('MATERIAL',.5,.8,.04,.007),short=line('COPPER PER',.5,.82,.07,.01,{sourceConfidence:99});
  const complete=line('COPPER PER ASTM B-123 [PRODUCT SPEC',.5,.82,.2,.02,{sourceConfidence:65});
  const result=extractDrawingFields({page:1,drawingOCR:{passes:[{id:'a',regions:[head,short,line('REVISION.',.4,.95,.04,.007),line('d',.4,.98,.006,.01)]},{id:'b',regions:[head,complete,line('PVC',.55,.84,.02,.01)]}]}});
  assert(!result.fields.some(f=>f.name==='版本'));
  assert.equal(result.fields.find(f=>f.name==='材料').value,'COPPER PER ASTM B-123 / PVC');
  assert.equal(result.fields.find(f=>f.name==='材料').otherCandidates[0].value,'COPPER PER');
});

test('word geometry isolates callouts from graph lines and the drawing ID from the neighboring code cell',()=>{
  const words=[line('|',0,.3,.005),line('21.80',.2,.3,.04),line('MIN-»=',.25,.3,.035),line('OTHER',.65,.3,.05),line('CAGE',.7,.8,.03,.007),line('DRAWING',.82,.8,.035,.007),line('NO',.86,.8,.01,.007),line('00981',.7,.82,.06,.02),line('D=',.82,.82,.02,.02),line('72910',.845,.82,.055,.02)];
  const result=extractDrawingFields({page:1,drawingOCR:{passes:[{id:'layout',text:'',regions:[line('| 21.80 MIN-»= OTHER',0,.3,.7)],words}]}});
  assert.equal(dims(result)[0].numericValue,21.8);assert.equal(dims(result)[0].limit,'min');
  const drawing=result.fields.find(f=>f.name==='图号');assert.equal(drawing.value,'D=72910');assert(!drawing.evidence.includes('00981'));
  assert(!drawing.region.boxes.some(r=>r.text==='00981'));
});

test('title-zone numbers with grossly inconsistent paired units do not become dimensions',()=>{
  const result=parse([line('6 [14].',.5,.04,.09,.04),line('DIMENSIONS IN mm [INCHES]',.5,.8,.2,.01)]);
  assert.equal(dims(result).length,0);
});

test('explicit inline primary and alternate units work without a global unit declaration',()=>{
  const result=extractDrawingFields({page:1,text:'6.35 ±0.05 mm [.250 ±.002 in]'});
  assert.equal(dims(result).length,1);assert.equal(dims(result)[0].unit,'mm');
  assert.equal(dims(result)[0].alternateMeasurements[0].value,.25);assert.equal(dims(result)[0].alternateMeasurements[0].unit,'in');
});

test('an explicit thickness label permits a legible nominal with unreadable tolerance preserved',()=>{
  const result=parse([line('TONGUE MATERIAL THK: 1.75%0-05 [.069%002]',.6,.3,.35),line('DIMENSIONS IN mm [INCHES]',.5,.8,.2,.01)]);
  const field=dims(result)[0];assert.equal(field.name,'舌片厚度');assert.equal(field.object,'舌片');assert.equal(field.numericValue,1.75);assert.equal(field.unit,'mm');
  assert.equal(field.tolerance,null);assert.equal(field.toleranceStatus,'待复核');assert.deepEqual(field.unresolvedAnnotations,['%0-05 [.069%002]']);
  assert(!field.value.includes('±'));
});

test('numbered notes and unnumbered OCR share the nominal-value position when merging thickness',()=>{
  const common=[line('TONGUE',.61,.39,.048),line('MATERIAL',.67,.39,.065),line('THK:',.745,.39,.03),line('1.75%0-05',.788,.39,.06)];
  const result=extractDrawingFields({page:1,drawingOCR:{passes:[{id:'a',words:common,regions:[]},{id:'b',words:[line('3',.584,.39,.006),...common],regions:[]}]}});
  assert.equal(dims(result).length,1);assert.deepEqual(dims(result)[0].sourcePasses,['a','b']);
});
