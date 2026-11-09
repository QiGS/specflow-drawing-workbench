/** Import model evidence into the browser workspace. No credential or network access. */
import {deriveVisionFacts} from './vision-facts.mjs';

const clone=value=>structuredClone(value);
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const fail=message=>{throw new Error(message);};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max=100000)=>typeof value==='string'&&value.length<=max;
const array=(value,max)=>Array.isArray(value)&&value.length<=max;
const clean=s=>String(s??'').normalize('NFKC').replace(/\s/g,'').toLowerCase();
function region(value){
  if(value==null)return null;
  if(!plain(value)||!['x','y','width','height'].every(k=>Number.isFinite(value[k]))||value.x<0||value.y<0||value.width<=0||value.height<=0||value.x+value.width>1.000001||value.y+value.height>1.000001)fail('来源区域超出页面范围。');
  return Object.fromEntries(['x','y','width','height'].map(k=>[k,value[k]]));
}
function rotate(r,degrees){
  if(!r)return null;
  if(degrees===90)return{x:1-r.y-r.height,y:r.x,width:r.height,height:r.width};
  if(degrees===180)return{x:1-r.x-r.width,y:1-r.y-r.height,width:r.width,height:r.height};
  if(degrees===270)return{x:r.y,y:1-r.x-r.width,width:r.height,height:r.width};
  return r;
}
function sourceRegion(observation,source,page){
  const r=region(observation.region);if(!r)return null;
  const roi=region(source.roi_normalized)||{x:0,y:0,width:1,height:1};
  const mapped={x:roi.x+r.x*roi.width,y:roi.y+r.y*roi.height,width:r.width*roi.width,height:r.height*roi.height};
  const angle=source.rotation_clockwise||0;if(![0,90,180,270].includes(angle))fail('不支持此来源旋转记录。');
  const display=page.rotation||0;if(![0,90,180,270].includes(display))fail('页面预览方向无效。');
  return region(rotate(rotate(mapped,(360-angle)%360),display));
}
function numericSupported(raw,observations){
  if(raw==null)return true;
  if(!text(raw,200))return false;
  const escaped=raw.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp('(?<![0-9.,+\\-−])'+escaped+'(?![0-9.,])').test(observations.filter(o=>o.kind==='visible_text'&&o.legibility!=='unreadable').map(o=>o.raw_text||'').join(' '));
}
function fieldIssue(f,observations){
  if(!plain(f)||!text(f.id,200)||!text(f.name,500)||!text(f.value_raw)||!array(f.evidence_ids,100)||!f.evidence_ids.length)return '字段缺少名称、原文或证据引用';
  if(!f.evidence_ids.every(id=>observations.has(id)))return '字段包含不存在的来源引用';
  const cited=f.evidence_ids.map(id=>observations.get(id));
  if(new Set(cited.map(o=>o.image_id)).size!==1)return '跨页面字段须分别确认来源';
  if(!numericSupported(f.nominal_raw,cited))return '数值与引用的可读原文不一致';
  if(f.unit_raw!=null&&(!text(f.unit_raw,100)||!cited.some(o=>o.kind==='visible_text'&&o.legibility!=='unreadable'&&clean(o.raw_text).includes(clean(f.unit_raw)))))return '单位缺少可读原文引用';
  if(f.tolerance){
    const t=f.tolerance;
    if(!plain(t)||!text(t.raw,500)||!array(t.evidence_ids,100)||!t.evidence_ids.length||!t.evidence_ids.every(id=>observations.has(id)))return '公差缺少有效证据引用';
    const refs=t.evidence_ids.map(id=>observations.get(id));
    if(refs.some(o=>o.image_id!==cited[0].image_id)||!refs.some(o=>o.legibility!=='unreadable'&&o.kind==='visible_text'&&clean(o.raw_text).includes(clean(t.raw))))return '公差与同页可读原文不一致';
    if(t.kind==='symmetric'&&(!text(t.amplitude_raw,100)||t.upper_raw!=null||t.lower_raw!=null||!/±|\+\//.test(t.raw)||!numericSupported(t.amplitude_raw,refs.map(o=>({...o,raw_text:(o.raw_text||'').replace(/±/g,' ')})))))return '对称公差结构无效';
  }
  for(const k of ['object','view','state'])if(f[k]!=null&&(!text(f[k],500)||f[k].trim()))return '几何对象、视图或状态请在网页逐项人工关联';
  return null;
}
function mappedField(f,observation,source,doc,runId){
  const page=doc.pages.find(p=>p.page===source.page);
  const nominal=f.nominal_raw!=null&&/^[+\-−]?\d*(?:\.\d+)?$/.test(f.nominal_raw)?Number(f.nominal_raw.replace('−','-')):null;
  return {id:`vision-${runId.slice(0,12)}-${f.id}`,name:f.name,value:f.value_raw,category:f.category||'other',page:source.page,file:doc.name,
    evidence:observation.raw_text||'',region:sourceRegion(observation,source,page),status:'pending',method:'vlm-import',
    numericValue:Number.isFinite(nominal)?nominal:null,numericValues:Number.isFinite(nominal)?[nominal]:[],nominalRaw:f.nominal_raw??null,
    unit:f.unit_raw||'',tolerance:clone(f.tolerance??null),limit:f.limit_raw?f.limit_raw.toLowerCase():null,object:null,view:null,state:null,
    sourceCategory:'model_evidence',visionRunId:runId,visionFieldId:f.id,rawVisionField:clone(f),geometryAssociationStatus:'unconfirmed',
    provenance:{documentSha256:source.document_sha256,imageId:source.image_id,evidenceIds:[...f.evidence_ids],coordinates:'model_estimate_unreviewed'}};
}

export async function validateAndMapVision(doc,input){
  if(!plain(doc)||!hash(doc.contentId)||!array(doc.pages,500))fail('请先导入原始图纸，再导入对应的视觉结果。');
  if(!plain(input)||JSON.stringify(input).length>10*1024*1024)fail('视觉结果应为10 MiB以内的JSON对象。');
  const r=input.result||input;
  if(!plain(r)||r.schema_version!=='1.0'||!['valid_unreviewed','partial_valid_unreviewed'].includes(r.status)||r.operation!=='extract_page')fail('只支持已保存的整页视觉提取结果；不接受失败响应或纯文本转写。');
  const p=r.model_payload_before_item_validation||r.payload;
  if(!plain(p)||!array(p.fields,600)||!array(p.bom,600)||!array(p.observations,2000)||!array(r.sources,8)||!r.sources.length)fail('提取结果结构不完整或超出大小限制。');
  const sources=new Map();
  for(const s of r.sources){
    if(!plain(s)||!text(s.image_id,200)||sources.has(s.image_id)||s.document_sha256?.toLowerCase()!==doc.contentId.toLowerCase()||!doc.pages.some(p=>p.page===s.page))fail('结果的文件内容标识或页码与当前图纸不匹配。');
    sources.set(s.image_id,s);
  }
  const observations=new Map();
  for(const o of p.observations){
    if(!plain(o)||!text(o.id,200)||observations.has(o.id)||!sources.has(o.image_id)||!(o.raw_text==null||text(o.raw_text))||!(o.description==null||text(o.description)))fail('观察记录重复、过长或引用了未知页面。');
    sourceRegion(o,sources.get(o.image_id),doc.pages.find(p=>p.page===sources.get(o.image_id).page));observations.set(o.id,o);
  }
  const runId=await digest(JSON.stringify({source:doc.contentId,payload:p,sources:r.sources}));
  const fields=[],quarantined=[],seen=new Set();
  const alreadyRejected=new Map((r.rejected_fields||[]).map(x=>[x.item?.id,x.error||'原后端校验未通过']));
  for(const f of p.fields){
    if(!plain(f)||!text(f.id,200)||seen.has(f.id))fail('字段ID重复或无效。');seen.add(f.id);
    const reason=alreadyRejected.get(f.id)||fieldIssue(f,observations);
    const observation=observations.get(f.evidence_ids?.[0]);const source=observation&&sources.get(observation.image_id);
    if(reason){quarantined.push({id:`q-${runId.slice(0,12)}-${f.id}`,item:clone(f),error:reason,error_code:'import_review_required',page:source?.page??null,region:source?sourceRegion(observation,source,doc.pages.find(p=>p.page===source.page)):null,evidence:observation?.raw_text||'',runId});continue;}
    fields.push(mappedField(f,observation,source,doc,runId));
  }
  // A model's table label is not proof of assembly composition. Keep separate from production BOM.
  for(const b of p.bom){
    if(!plain(b)||!text(b.id,200)||seen.has(b.id))fail('表格ID重复或无效。');seen.add(b.id);
    const o=observations.get(b.evidence_ids?.[0]);const s=o&&sources.get(o.image_id);
    quarantined.push({id:`q-${runId.slice(0,12)}-${b.id}`,item:clone(b),error:'表格尚未确认是装配BOM、包装数量或料号变体；请分类后录入。',error_code:'table_classification_required',page:s?.page??null,region:s?sourceRegion(o,s,doc.pages.find(p=>p.page===s.page)):null,evidence:o?.raw_text||'',runId});
  }
  const derived=await deriveVisionFacts({...r,payload:{...p,fields:[],bom:[]}});
  const refSource=s=>{const o=observations.get(s.observation_id),so=sources.get(s.image_id);return {page:s.page,observationId:s.observation_id,documentSha256:doc.contentId,region:o&&so?sourceRegion(o,so,doc.pages.find(p=>p.page===so.page)):null,raw:s.observation_raw_text_sha256};};
  const referenceSuggestions=(derived.referenceSuggestions||[]).map(s=>({id:`ref-${runId.slice(0,12)}-${s.id}`,kind:s.kind==='global_unit_declaration'?'unit_declaration':'general_tolerance',raw:s.raw_text,source:refSource(s.source),status:'pending_review',appliedToFieldIds:[],units:[s.primary_unit_raw,s.secondary_unit_raw].filter(Boolean),rawSuggestion:clone(s),runId}));
  const packagingVariants=(derived.packagingVariants||[]).map(s=>({id:`pack-${runId.slice(0,12)}-${s.id}`,partNumber:s.part_number_raw,quantityRaw:s.package_quantity_raw,quantityCellRaw:s.quantity_cell_raw,packageType:s.package_type_raw,notesRaw:s.unassigned_prefix_raw,obsolete:/\bOBSOLETE\b/i.test(s.raw_text)?'原文标有OBSOLETE，适用性待确认':null,raw:s.raw_text,page:s.source.page,region:refSource(s.source).region,status:'pending',source:refSource(s.source),rawVariant:clone(s),runId}));
  const record={id:runId,model:String(r.model_returned||r.model_requested||'未标明').slice(0,300),promptVersion:String(input.audit?.prompt_version||r.prompt_version||'未标明').slice(0,200),sourceSha256:doc.contentId,at:new Date().toISOString(),counts:{accepted:fields.length,quarantined:quarantined.length,total:p.fields.length+p.bom.length},sourceCategory:'imported_model_result',networkCallPerformedByThisImport:false,geometryAssociationPerformed:false,rawResponseSha256:hash(r.raw_response_sha256)?r.raw_response_sha256:null,rawTexts:(p.image_texts||[]).filter(x=>sources.has(x.image_id)&&text(x.raw_text)).map(x=>({page:sources.get(x.image_id).page,text:x.raw_text})),sources:clone(r.sources)};
  return {fields,quarantined,referenceSuggestions,packagingVariants,record};
}

export function mergeVisionResult(doc,mapped){
  if((doc.visionRuns||[]).some(r=>r.id===mapped.record.id))fail('这份视觉结果已经导入，未重复添加。');
  const result=clone(doc);result.fields||=[];result.history||=[];
  for(const f of mapped.fields){
    const possible=result.fields.filter(old=>old.page===f.page&&(old.name===f.name||old.category==='dimension'&&f.category==='dimension'&&old.numericValue===f.numericValue));
    result.fields.push({...clone(f),requiresReconciliation:possible.length>0,possibleReviewedFieldIds:possible.map(old=>old.id)});
  }
  for(const [key,value] of [['visionRuns',[mapped.record]],['visionQuarantine',mapped.quarantined],['referenceSuggestions',mapped.referenceSuggestions],['packagingVariants',mapped.packagingVariants]])result[key]=[...(result[key]||[]),...clone(value)];
  result.history.push({at:new Date().toISOString(),action:'导入视觉识图结果',runId:mapped.record.id,counts:clone(mapped.record.counts),sourceSha256:doc.contentId});
  return result;
}

export function applyReferenceSuggestion(doc,suggestionId,fieldIds,options={}){
  if(options.confirmed!==true||!Array.isArray(fieldIds)||!fieldIds.length||new Set(fieldIds).size!==fieldIds.length)fail('请选择字段并明确确认已核对来源。');
  const result=clone(doc),suggestion=result.referenceSuggestions?.find(s=>s.id===suggestionId);if(!suggestion)fail('来源建议不存在。');result.history||=[];
  const fields=fieldIds.map(id=>result.fields.find(f=>f.id===id));
  if(fields.some(f=>!f||f.category!=='dimension'||f.page!==suggestion.source.page))fail('只能关联本页的尺寸字段。');
  if(suggestion.kind==='unit_declaration'){
    const unit=String(options.unit||'').trim();if(!unit||unit.length>32||!suggestion.units.some(u=>clean(u)===clean(unit)))fail('请填写该来源声明中明确出现的单位，不自动进行单位换算。');
    for(const f of fields){const before=f.unit;f.unit=unit;f.unitSource=clone(suggestion.source);f.unitEvidence=suggestion.raw;f.status='pending';f.userEdited=true;result.history.push({at:new Date().toISOString(),action:'人工确认单位来源',fieldId:f.id,suggestionId,before,after:unit});}
  }else{
    for(const f of fields){f.generalToleranceReferences=[...new Set([...(f.generalToleranceReferences||[]),suggestionId])];f.status='pending';f.userEdited=true;result.history.push({at:new Date().toISOString(),action:'人工关联通用公差参考',fieldId:f.id,suggestionId,explicitToleranceUnchanged:true});}
  }
  suggestion.appliedToFieldIds=[...new Set([...suggestion.appliedToFieldIds,...fieldIds])];suggestion.status='manually_linked_pending_review';return result;
}
