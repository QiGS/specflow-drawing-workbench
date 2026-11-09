/**
 * Acceptance checks against manually read drawings; does NOT run or import extraction code.
 * Usage: node tests/real-drawing-acceptance.mjs actual-browser-export.json manual-gold.json [report.json]
 * Accepts the UI field export ({name,fields,bom,history}) or backup ({version:1,documents:[...]}).
 * A successful value check is not a successful object-association or full-drawing accuracy claim.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [actualPath,goldPath,outputPath]=process.argv.slice(2);
if(!actualPath||!goldPath)throw new Error('Usage: node tests/real-drawing-acceptance.mjs actual-browser-export.json manual-gold.json [report.json]');
const [actualBytes,goldBytes]=await Promise.all([fs.readFile(actualPath),fs.readFile(goldPath)]);
const actual=JSON.parse(actualBytes),inputGold=JSON.parse(goldBytes);
const documents=Array.isArray(actual)?actual:Array.isArray(actual.documents)?actual.documents:[actual];
const goldDocuments=Array.isArray(inputGold)?inputGold:[inputGold];
const clean=v=>String(v??'').normalize('NFKC').replace(/[−–—]/g,'-').replace(/\s+/g,' ').trim();
const fold=v=>clean(v).toLowerCase();
const same=(a,b)=>fold(a).replace(/\s+/g,'')===fold(b).replace(/\s+/g,'');
const near=(a,b)=>typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<1e-8;
const unit=v=>/^(?:in\.?|inches|inch)$/i.test(clean(v))?'in':fold(v);
const boxes=f=>(f?.region?.boxes||[f?.region||f?.bbox]).filter(b=>b&&[b.x,b.y,b.width??b.w,b.height??b.h].every(Number.isFinite)).map(b=>({...b,width:b.width??b.w,height:b.height??b.h}));
function overlap(b,r){return Math.max(0,Math.min(b.x+b.width,r.x+r.width)-Math.max(b.x,r.x))*Math.max(0,Math.min(b.y+b.height,r.y+r.height)-Math.max(b.y,r.y));}
function sameSourcePosition(a,b){return boxes(a).some(x=>boxes(b).some(y=>overlap(x,y)/Math.min(x.width*x.height,y.width*y.height)>.5));}
function located(f,g){
  const bs=boxes(f).filter(b=>b.x>=0&&b.y>=0&&b.width>0&&b.height>0&&b.x+b.width<=1.001&&b.y+b.height<=1.001&&b.width*b.height<.25);
  if(!g.region)return bs.length>0;
  // Gold rectangles are manually selected text regions. Small padding accommodates glyph extents.
  const r={x:g.region.x-.012,y:g.region.y-.008,width:g.region.width+.024,height:g.region.height+.016};
  return bs.some(b=>overlap(b,r)/(b.width*b.height)>.5);
}
const primaryValue=f=>typeof f.numericValue==='number'?f.numericValue:undefined;
// Compare an explicitly extracted measurement in either position of a dual-unit pair.
// This is an evaluation view; it does not rewrite the browser export or calculate an absent value.
function measurementView(f,expected){
  if(near(primaryValue(f),expected.value))return f;
  const alt=(f.alternateMeasurements||[]).find(a=>near(a.value??a.numericValue,expected.value));
  if(!alt)return null;
  return {...f,numericValue:alt.value??alt.numericValue,unit:alt.unit,tolerance:alt.tolerance,
    alternateMeasurements:[{value:f.numericValue,unit:f.unit,tolerance:f.tolerance},...(f.alternateMeasurements||[]).filter(a=>a!==alt)],
    evaluationSelection:{kind:'explicit-alternate-measurement',originalPrimary:{value:f.numericValue,unit:f.unit,tolerance:f.tolerance}}};
}
const dimension=f=>f.category==='dimension';
const tolerance=t=>t?{plus:t.plus??t.upper,minus:t.minus??t.lower}:null;
function equalTolerance(actual,expected){
  if(!expected)return actual===null||actual===undefined;
  const t=tolerance(actual);return !!t&&near(t.plus,expected.plus)&&near(t.minus,expected.minus);
}
const numericEvidence=(f,value)=>[...String(f.evidence??'').matchAll(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/g)].some(m=>Math.abs(Number(m[0])-value)<1e-8);
const pendingObject=v=>!clean(v)||/待关联|待确认|未知|未识别|unknown|unassigned/i.test(v);
const candidateSummary=f=>f?{id:f.id,name:f.name,value:f.value,page:f.page,numericValue:f.numericValue,unit:f.unit,tolerance:f.tolerance,limit:f.limit,object:f.object,view:f.view,method:f.method,evidence:f.evidence,region:f.region,alternateMeasurements:f.alternateMeasurements,ocrConflict:f.ocrConflict,otherCandidates:f.otherCandidates,evaluationSelection:f.evaluationSelection}:null;
const result={generatedAt:new Date().toISOString(),mode:'Read actual browser export only; no OCR or parser executed by this acceptance script',
  input:{actual:path.basename(actualPath),actualSHA256:createHash('sha256').update(actualBytes).digest('hex'),gold:path.basename(goldPath),goldSHA256:createHash('sha256').update(goldBytes).digest('hex')},
  scope:'Purpose-selected manual checks. Counts are not general drawing accuracy. Already disclosed/tuned samples are regression data.',documents:[],dimensionGroups:[],checks:[],errors:[]};
function check(document,group,label,status,details={},required=true){result.checks.push({document,group,label,status,required,...details});}
function valueState(candidates,correct){return correct?'success':candidates.length?'conflict':'missing';}
function fieldCheck(doc,group,label,names,predicate){
  const candidates=doc.fields.filter(f=>names.some(n=>n instanceof RegExp?n.test(f.name):same(f.name,n))&&f.status!=='rejected');
  const matches=candidates.filter(predicate),status=valueState(candidates,matches.length>0);
  check(doc.name,group,label,status,{observed:candidates.map(candidateSummary)});
  if(matches.length)check(doc.name,'provenance',`${label}：页码和原文`,matches.every(f=>Number.isInteger(f.page)&&f.page>0&&clean(f.evidence))?'success':'conflict');
}
for(const gold of goldDocuments){
  const expectedName=gold.file||path.basename(gold.source||''),doc=documents.find(d=>d.name===expectedName);
  if(!doc){result.errors.push({document:expectedName,error:'实际导出中缺少对应文件；不将其他文件结果替代。'});continue;}
  if(!Array.isArray(doc.fields)||!Array.isArray(doc.bom)){result.errors.push({document:expectedName,error:'实际导出必须包含 fields 与 bom 数组'});continue;}
  const page=gold.page||1,fields=doc.fields.filter(f=>f.page===page&&f.status!=='rejected'),dims=fields.filter(dimension);
  const info=gold.document||gold;
  result.documents.push({name:doc.name,contentId:doc.contentId||null,checkedPage:page,pagesAvailable:Array.isArray(doc.pages),fields:doc.fields.length,dimensionCandidates:dims.length,bomRows:doc.bom.length,
    methods:[...new Set(fields.map(f=>f.method||'not recorded'))],ocrRuns:doc.pages?.map(p=>({page:p.page,method:p.method,passes:p.drawingOCR?.passes?.length??null}))||null});
  const restricted={...doc,fields};
  if(info.drawingNumber)fieldCheck(restricted,'identity','印刷图号',['图号','Drawing Number','Drawing No'],f=>same(f.value,info.drawingNumber));
  if(info.revision)fieldCheck(restricted,'identity','修订版本',['版本','版次','Revision'],f=>same(f.value,info.revision));
  if(info.projection)fieldCheck(restricted,'identity','第三角投影声明',['投影法'],f=>/第三角|third.angle/i.test(f.value));
  if(info.dimensionConvention)fieldCheck(restricted,'identity','尺寸单位声明',['尺寸单位'],f=>/mm/i.test(f.value)&&/\bin\b|inch/i.test(f.value));
  if(info.name)fieldCheck(restricted,'identity','名称',['名称','零件名称','产品名称'],f=>fold(f.value).replace(/[^a-z0-9]/g,'').includes(fold(info.name).replace(/[^a-z0-9]/g,'')));
  for(const [index,g]of (gold.dimensions||[]).entries()){
    const startCheck=result.checks.length;
    const label=g.name||g.object||`尺寸 ${index+1}`,expectedTolerance=g.tolerance||(g.plus!==undefined?{plus:g.plus,minus:g.minus}:null);
    const valueCandidates=dims.map(f=>measurementView(f,g)).filter(Boolean);
    const regional=dims.filter(f=>located(f,g)),candidates=valueCandidates.length?valueCandidates:g.region?regional:[];
    const candidateScore=f=>(located(f,g)?8:0)+(unit(f.unit)===unit(g.unit)?4:0)+(equalTolerance(f.tolerance,expectedTolerance)?2:0)+(g.limit&&fold(f.limit)===g.limit?1:0);
    const best=[...valueCandidates].sort((a,b)=>candidateScore(b)-candidateScore(a))[0];
    const validValue=!!best;
    check(doc.name,'dimension-value',`${label}：标注数值`,valueState(candidates,validValue),{expected:g.value,observed:candidates.map(candidateSummary)});
    check(doc.name,'dimension-unit',`${label}：单位`,!best?'missing':unit(best.unit)===unit(g.unit)?'success':clean(best.unit)?'conflict':'missing',{expected:g.unit,actual:best?.unit||null});
    check(doc.name,'dimension-tolerance',`${label}：显式公差`,!best?'missing':equalTolerance(best.tolerance,expectedTolerance)?'success':best.tolerance?'conflict':'missing',{expected:expectedTolerance,actual:best?.tolerance||null});
    if(g.limit)check(doc.name,'dimension-limit',`${label}：${g.limit.toUpperCase()} 限值`,!best?'missing':fold(best.limit)===g.limit?'success':best.limit?'conflict':'missing',{expected:g.limit,actual:best?.limit||null});
    if(g.reference)check(doc.name,'dimension-limit',`${label}：REF 参考尺寸`,!best?'missing':best.reference===true||fold(best.limit)==='ref'?'success':'missing');
    const expectedAlt=g.alternate||(g.alternateValue!==undefined?{value:g.alternateValue,unit:g.alternateUnit}:null);
    if(expectedAlt){
      const alts=best?.alternateMeasurements||[];
      const matching=alts.find(a=>near(a.value??a.numericValue,expectedAlt.value));
      const good=matching&&unit(matching.unit)===unit(expectedAlt.unit)&&equalTolerance(matching.tolerance,expectedAlt.plus!==undefined?{plus:expectedAlt.plus,minus:expectedAlt.minus}:null);
      check(doc.name,'dimension-alternate',`${label}：英制／公制对照及公差`,good?'success':alts.length?'conflict':'missing',{expected:expectedAlt,actual:alts});
    }
    check(doc.name,'dimension-provenance',`${label}：正确页码、原文数值及标注区域`,!best?'missing':best.page===page&&numericEvidence(best,g.value)&&located(best,g)?'success':'conflict',{expectedRegion:g.region||null,actual:best?{page:best.page,evidence:best.evidence,region:best.region}:null});
    // A non-empty object is only an association candidate, not proof of semantic correctness.
    const association=!best||pendingObject(best.object)?'missing':'manual-review';
    check(doc.name,'object-association',`${label}：对象关联`,association,{expected:g.object,actual:best?.object||null,note:'非空对象仍须目视核对；通用“直径/尺寸”名称不等于已追踪引线。'},false);
    if(best?.ocrConflict||best?.otherCandidates?.length)check(doc.name,'ocr-disagreement',`${label}：多次 OCR 候选分歧`,'manual-review',{selected:candidateSummary(best),note:'即使选中值符合人工标准，原始 OCR 分歧仍保留为人工复核项；不代表已确认。'},false);
    // The same nominal can legitimately occur on two different objects (e.g. lip and thickness).
    // Count conflicting repeats only when their source positions overlap.
    const repeated=best?valueCandidates.filter(f=>sameSourcePosition(best,f)):[];
    if(repeated.length>1&&repeated.some(f=>unit(f.unit)!==unit(g.unit)||!equalTolerance(f.tolerance,expectedTolerance)))
      check(doc.name,'duplicate-conflict',`${label}：同位置同值候选不能出现冲突的单位或公差`,'conflict',{observed:repeated.map(candidateSummary)});
    const requiredChecks=result.checks.slice(startCheck).filter(c=>c.required);
    result.dimensionGroups.push({document:doc.name,label,expectedObject:g.object,status:requiredChecks.every(c=>c.status==='success')?'success':requiredChecks.some(c=>c.status==='conflict')?'conflict':'missing',valueRecognized:validValue,valueAndSourceRecognized:!!best&&best.page===page&&numericEvidence(best,g.value)&&located(best,g),failedProperties:requiredChecks.filter(c=>c.status!=='success').map(c=>({group:c.group,status:c.status})),objectAssociation:association});
  }
  if(gold.packaging||gold.packagingNotBOM){
    check(doc.name,'false-positive-guard','包装规格表不作为装配 BOM',doc.bom.length===0?'success':'conflict',{actualBOM:doc.bom.map(b=>({partNumber:b.partNumber,qty:b.qty,page:b.page,evidence:b.evidence}))});
  }
  if(gold.requirements?.some(r=>r.name==='material'))fieldCheck(restricted,'technical','铜材料及 PVC',['材料'],f=>/COPPER/i.test(f.value)&&/ASTM\s*B\s*-?\s*152/i.test(f.value)&&/PVC/i.test(f.value));
  if(gold.requirements?.some(r=>r.name==='maxOperatingTemperature')){
    const expected=gold.requirements.find(r=>r.name==='maxOperatingTemperature');
    fieldCheck(restricted,'technical','最高工作温度',['工作温度','最高工作温度'],f=>numericEvidence({evidence:f.value},expected.value)&&/C|℃/.test(f.value)&&/MAX|最高|最大/i.test(f.value));
  }
  const note4=gold.requirements?.find(r=>r.name==='note4');
  if(note4)fieldCheck(restricted,'technical','镀锡技术要求',[/表面处理|技术要求/],f=>/TIN\s+PLATE/i.test(f.value)&&/ASTM\s+B\s*-?\s*545/i.test(f.value));
  const note5=gold.requirements?.find(r=>r.name==='note5');
  if(note5)fieldCheck(restricted,'technical','镀金和底镀镍要求',[/表面处理|技术要求/],f=>/GOLD\s+FLASH/i.test(f.value)&&/MIL\s*-?\s*G\s*-?\s*45204/i.test(f.value)&&/NICKEL\s+PLATE/i.test(f.value)&&/QQ\s*-?\s*N\s*-?\s*290/i.test(f.value));
}
const summarize=checks=>({success:checks.filter(c=>c.status==='success').length,missing:checks.filter(c=>c.status==='missing').length,conflict:checks.filter(c=>c.status==='conflict').length,manualReview:checks.filter(c=>c.status==='manual-review').length});
result.summary={...summarize(result.checks.filter(c=>c.required)),errors:result.errors.length,dimensionGroups:summarize(result.dimensionGroups),dimensionValuesWithSource:result.dimensionGroups.filter(g=>g.valueAndSourceRecognized).length,optionalAssociations:summarize(result.checks.filter(c=>c.group==='object-association')),ocrDisagreements:result.checks.filter(c=>c.group==='ocr-disagreement').length};
result.byGroup=Object.fromEntries([...new Set(result.checks.map(c=>c.group))].map(group=>[group,summarize(result.checks.filter(c=>c.group===group))]));
const json=JSON.stringify(result,null,2)+'\n';if(outputPath)await fs.writeFile(outputPath,json);
console.log(JSON.stringify({summary:result.summary,byGroup:result.byGroup,documents:result.documents,failures:result.checks.filter(c=>c.required&&c.status!=='success').map(({document,group,label,status,expected,actual})=>({document,group,label,status,expected,actual})),errors:result.errors},null,2));
if(result.summary.missing||result.summary.conflict||result.errors.length)process.exitCode=1;
