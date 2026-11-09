import {validateGeometryImport} from './geometry-ui.mjs?v=11';
/** Restore JSON data only. Original files and generated output are never restored or fetched. */
import {parseDocument} from './engine.mjs?v=9';
import {generateInstructions, defaultRules, defaultTemplate} from './instructions.mjs?v=10';

const fail = (path, reason) => { throw new TypeError(`备份格式无效：${path} ${reason}`); };
const own = (obj, key) => Object.hasOwn(obj, key);
function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, '必须是普通对象');
}
function array(value, path) {
  if (!Array.isArray(value)) fail(path, '必须是数组');
  for(let i=0;i<value.length;i++)if(!own(value,i))fail(path,'数组不能包含空缺项');
}
function string(value, path) { if (typeof value !== 'string') fail(path, '必须是文本'); }
function number(value, path, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(path, `必须是有效数值${min===0?'（不能为负数）':''}`);
}
function bool(value, path) { if (typeof value !== 'boolean') fail(path, '必须是布尔值'); }
function strings(obj, keys, path) { for (const key of keys) if (own(obj, key)) string(obj[key], `${path}.${key}`); }
function stringArray(value, path) { array(value,path);value.forEach((v,i)=>string(v,`${path}[${i+1}]`)); }
function date(value, path) { string(value,path);if (!Number.isFinite(Date.parse(value))) fail(path,'必须是有效日期'); }

// Backups contain application data, never provider requests, credentials or raw
// response audits. Keep hashes and the existing human `history` records instead.
const privateKeys = new Set(['audit','rawaudit','modelaudit','rawmodelaudit','rawresponse','rawresponsetext','rawresponsetextredacted','rawrequest','requestbody','requestpayload','apikey','authorization','bearer','secret','secretkey','clientsecret','secrets','credentials','accesstoken','refreshtoken','authtoken','password','token','imageurl','imagedata','base64','headers']);
const privateKey = key => privateKeys.has(key.replace(/[_-]/g,'').toLowerCase());
const visualKeys = new Set(['visionRuns','visionQuarantine','referenceSuggestions','packagingVariants','rawVisionField','provenance','unitSource','geometryResult']);
const visualField = value => value && (value.method==='vlm-import'||value.sourceCategory==='model_evidence'||own(value,'visionRunId')||own(value,'rawVisionField'));
function boundedText(value,path,max=200000) {
  string(value,path);if(value.length>max)fail(path,`文本不能超过 ${max} 字符`);
  if(/data:[^\s,;]+(?:;[^,]*)?;base64,/i.test(value))fail(path,'视觉记录不能包含图像或其他 base64 数据');
}
function list(value,path,max) {if(Array.isArray(value)&&value.length>max)fail(path,`条目不能超过 ${max} 项`);array(value,path);}
function sha256(value,path) {string(value,path);if(!/^[a-f0-9]{64}$/i.test(value))fail(path,'必须是 SHA-256 内容标识');}
function sameSha(value,expected,path) {sha256(value,path);if(value.toLowerCase()!==expected?.toLowerCase())fail(path,'文件内容标识不匹配');}
function identifier(value,path) {boundedText(value,path,300);if(!value.trim())fail(path,'标识不能为空');}
function ids(value,path,max=100) {list(value,path,max);value.forEach((v,i)=>identifier(v,`${path}[${i+1}]`));if(new Set(value).size!==value.length)fail(path,'标识不能重复');}
function only(obj,keys,path) {object(obj,path);for(const k of Object.keys(obj))if(!keys.includes(k))delete obj[k];return obj;}

// Use only own JSON values. Reject prototype keys and cycles rather than copying them into app state.
function jsonClone(value, path, ancestors = new Set(), depth = 0, budget={nodes:0,chars:0,visualChars:0}, visual=false) {
  if (depth > 50) fail(path, '嵌套层级过深');
  if(++budget.nodes>1000000)fail(path,'备份数据节点过多');
  if(typeof value==='string') {
    budget.chars+=value.length;if(budget.chars>200*1024*1024)fail(path,'备份文本总量超过 200 MiB');
    if(visual){boundedText(value,path);budget.visualChars+=value.length;if(budget.visualChars>20*1024*1024)fail(path,'视觉文本总量超过 20 MiB');}
    return value;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { number(value,path);return value; }
  if (typeof value !== 'object') fail(path, '只能包含 JSON 数据');
  if (ancestors.has(value)) fail(path, '不能循环引用');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {list(value,path,visual?6000:50000);result=value.map((v,i)=>jsonClone(v,`${path}[${i+1}]`,ancestors,depth+1,budget,visual));}
  else {
    object(value,path);result={};
    if(Object.keys(value).length>500)fail(path,'对象属性过多');
    const modelField=visualField(value);
    for (const [key,v] of Object.entries(value)) {
      if (['__proto__','prototype','constructor'].includes(key)) fail(`${path}.${key}`,'包含不允许的属性');
      if(key.length>500)fail(path,'属性名称过长');
      if(privateKey(key))continue;
      result[key]=jsonClone(v,`${path}.${key}`,ancestors,depth+1,budget,visual||visualKeys.has(key)||(modelField&&key!=='sourceSnapshot'));
    }
  }
  ancestors.delete(value);return result;
}
function thumbnail(value,path) {
  string(value,path);
  if (value && !/^data:image\/(?:png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(path,'只允许内嵌 PNG、JPEG 或 WebP 缩略图');
}
function hash(value,path) { string(value,path);if(value&&!/^[01]{64}$/.test(value))fail(path,'必须是 64 位图像指纹'); }
function pageRef(value,path,pages) {
  if (!Number.isInteger(value) || value<1 || (pages && !pages.has(value))) fail(path,'必须引用资料中存在的正整数页码');
}
function region(value,path) {
  if(value===null)return;
  object(value,path);
  if(own(value,'boxes')) { array(value.boxes,path+'.boxes');value.boxes.forEach((b,i)=>region(b,`${path}.boxes[${i+1}]`));return; }
  for(const key of ['x','y'])number(value[key],`${path}.${key}`,0,1);
  const w=own(value,'width')?'width':'w',h=own(value,'height')?'height':'h';
  number(value[w],`${path}.${w}`,0,1);number(value[h],`${path}.${h}`,0,1);
  if(value.x+value[w]>1.000001||value.y+value[h]>1.000001)fail(path,'来源区域超出页面范围');
  if(own(value,'text'))string(value.text,path+'.text');
}
function source(item,path,pages) {
  pageRef(item.page,path+'.page',pages);
  strings(item,['id','evidence','file','sourceName','model','category','unit'],path);
  for(const key of ['object','view','state'])if(own(item,key)&&item[key]!==null)string(item[key],path+'.'+key);
  for(const key of ['region','bbox'])if(own(item,key))region(item[key],path+'.'+key);
  if(own(item,'status')&&!['pending','approved','rejected'].includes(item.status))fail(path+'.status','必须是 pending、approved 或 rejected');
}
function field(item,path,pages) {
  object(item,path);string(item.name,path+'.name');string(item.value,path+'.value');source(item,path,pages);
  if(item.sourceSnapshot){object(item.sourceSnapshot,path+'.sourceSnapshot');thumbnail(item.sourceSnapshot.preview,path+'.sourceSnapshot.preview');}
  if(own(item,'numericValue')&&item.numericValue!==null)number(item.numericValue,path+'.numericValue');
  if(own(item,'numericValues')){array(item.numericValues,path+'.numericValues');item.numericValues.forEach((v,i)=>number(v,`${path}.numericValues[${i+1}]`));}
  if(item.tolerance!==undefined&&item.tolerance!==null){object(item.tolerance,path+'.tolerance');strings(item.tolerance,['raw'],path+'.tolerance');for(const key of ['plus','minus'])if(own(item.tolerance,key))number(item.tolerance[key],path+'.tolerance.'+key);}
  if(own(item,'measurements')){array(item.measurements,path+'.measurements');item.measurements.forEach((m,i)=>{const p=`${path}.measurements[${i+1}]`;object(m,p);number(m.value,p+'.value');strings(m,['unit','raw'],p);});}
  for(const key of ['sourcePasses','unresolvedAnnotations'])if(own(item,key))stringArray(item[key],path+'.'+key);
  if(own(item,'alternateMeasurements')){
    array(item.alternateMeasurements,path+'.alternateMeasurements');
    item.alternateMeasurements.forEach((m,i)=>{const p=`${path}.alternateMeasurements[${i+1}]`;object(m,p);number(m.value,p+'.value');strings(m,['unit','raw'],p);if(m.tolerance){object(m.tolerance,p+'.tolerance');strings(m.tolerance,['raw'],p);for(const k of ['plus','minus'])if(own(m.tolerance,k))number(m.tolerance[k],p+'.tolerance.'+k);}});
  }
  for(const key of ['otherCandidates','reparseCandidates'])if(own(item,key)){
    array(item[key],path+'.'+key);
    item[key].forEach((c,i)=>{const p=`${path}.${key}[${i+1}]`;object(c,p);string(c.value,p+'.value');strings(c,['evidence'],p);if(own(c,'region'))region(c.region,p+'.region');});
  }
}
function bom(item,path,pages) {
  object(item,path);source(item,path,pages);strings(item,['item','partNumber','name','material'],path);
  number(item.qty,path+'.qty',0,Number.MAX_SAFE_INTEGER);
}

function visionSource(value,path,doc,pages) {
  only(value,['image_id','source_name','original_image_sha256','document_sha256','document_hash_basis','page','canonical_size','exif_orientation_original','exif_transposed','rotation_clockwise','rotated_full_size','roi_pixels_xywh','roi_normalized','rendered_size','rendered_image_sha256','rendered_image_bytes','mime_type'],path);
  identifier(value.image_id,path+'.image_id');sameSha(value.document_sha256,doc.contentId,path+'.document_sha256');pageRef(value.page,path+'.page',pages);
  for(const key of ['source_name','document_hash_basis','mime_type'])if(own(value,key))boundedText(value[key],path+'.'+key,1000);
  for(const key of ['original_image_sha256','rendered_image_sha256'])if(own(value,key)&&value[key]!==null)sha256(value[key],path+'.'+key);
  if(own(value,'rotation_clockwise')&&![0,90,180,270].includes(value.rotation_clockwise))fail(path+'.rotation_clockwise','旋转角度无效');
  if(own(value,'roi_normalized'))region(value.roi_normalized,path+'.roi_normalized');
  for(const key of ['canonical_size','rotated_full_size','rendered_size','roi_pixels_xywh'])if(own(value,key)){
    list(value[key],path+'.'+key,4);const n=key==='roi_pixels_xywh'?4:2;
    if(value[key].length!==n)fail(path+'.'+key,'坐标数量无效');
    value[key].forEach((v,i)=>{number(v,path+'.'+key,0,1000000);if(!Number.isInteger(v)||(n===2||i>=2)&&v===0)fail(path+'.'+key,'像素坐标无效');});
  }
  if(own(value,'exif_transposed'))bool(value.exif_transposed,path+'.exif_transposed');
  if(own(value,'exif_orientation_original')&&value.exif_orientation_original!==null){number(value.exif_orientation_original,path+'.exif_orientation_original',1,8);if(!Number.isInteger(value.exif_orientation_original))fail(path,'EXIF 方向无效');}
  if(own(value,'rendered_image_bytes'))number(value.rendered_image_bytes,path+'.rendered_image_bytes',0,50*1024*1024);
}
function referenceSource(value,path,doc,pages) {
  only(value,['page','observationId','documentSha256','region','raw'],path);
  pageRef(value.page,path+'.page',pages);identifier(value.observationId,path+'.observationId');sameSha(value.documentSha256,doc.contentId,path+'.documentSha256');
  if(own(value,'region'))region(value.region,path+'.region');sha256(value.raw,path+'.raw');
}
function rawSource(value,path,doc,pages) {
  only(value,['image_id','observation_id','page','document_sha256','original_image_sha256','observation_raw_text_sha256','region'],path);
  identifier(value.image_id,path+'.image_id');identifier(value.observation_id,path+'.observation_id');pageRef(value.page,path+'.page',pages);
  sameSha(value.document_sha256,doc.contentId,path+'.document_sha256');sha256(value.observation_raw_text_sha256,path+'.observation_raw_text_sha256');
  if(value.original_image_sha256!=null)sha256(value.original_image_sha256,path+'.original_image_sha256');if(own(value,'region'))region(value.region,path+'.region');
}
// Candidate snapshots remain candidates. This never changes numeric/engineering
// values, and deliberately does not attempt to re-approve quarantined content.
function pendingCandidate(item,path) {
  object(item,path);identifier(item.id,path+'.id');
  if(own(item,'review_status'))item.review_status='pending';
  if(own(item,'status'))item.status='pending';
  if(own(item,'engineering_value_approved'))item.engineering_value_approved=false;
}
function restoreVision(doc,path,pages) {
  const visual=doc.fields.filter(visualField),keys=['visionRuns','visionQuarantine','referenceSuggestions','packagingVariants'];
  if(!visual.length&&!keys.some(k=>own(doc,k)))return;
  list(visual,path+'.视觉字段',6000);
  sha256(doc.contentId,path+'.contentId');
  const runs=new Map(),fieldIds=new Map(),suggestions=new Map(),lastFieldEvent=new Map();
  for(const event of doc.history)if(event.fieldId)lastFieldEvent.set(event.fieldId,event);
  for(const f of doc.fields){if(own(f,'id')){identifier(f.id,path+'.fields.id');if(fieldIds.has(f.id))fail(path+'.fields','字段标识不能重复');fieldIds.set(f.id,f);}}
  for(const key of keys)if(own(doc,key))list(doc[key],path+'.'+key,key==='visionRuns'?100:6000);
  for(const [i,run] of (doc.visionRuns||[]).entries()){
    const p=`${path}.visionRuns[${i+1}]`;
    only(run,['id','model','promptVersion','sourceSha256','at','counts','sourceCategory','networkCallPerformedByThisImport','geometryAssociationPerformed','rawResponseSha256','rawTexts','sources'],p);
    sha256(run.id,p+'.id');if(runs.has(run.id))fail(p+'.id','运行标识不能重复');sameSha(run.sourceSha256,doc.contentId,p+'.sourceSha256');date(run.at,p+'.at');
    boundedText(run.model,p+'.model',300);boundedText(run.promptVersion,p+'.promptVersion',200);
    if(run.sourceCategory!=='imported_model_result')fail(p+'.sourceCategory','视觉运行来源类别无效');
    for(const key of ['networkCallPerformedByThisImport','geometryAssociationPerformed'])if(run[key]!==false)fail(p+'.'+key,'导入记录不能宣称已调用网络或确认几何关系');
    only(run.counts,['accepted','quarantined','total'],p+'.counts');for(const key of ['accepted','quarantined','total']){number(run.counts[key],p+'.counts.'+key,0,1200);if(!Number.isInteger(run.counts[key]))fail(p+'.counts','计数须为整数');}
    if(run.counts.accepted+run.counts.quarantined!==run.counts.total)fail(p+'.counts','运行计数不一致');
    if(run.rawResponseSha256!==null)sha256(run.rawResponseSha256,p+'.rawResponseSha256');
    list(run.sources,p+'.sources',8);if(!run.sources.length)fail(p+'.sources','至少需要一个来源');
    const sourceIds=new Set();run.sources.forEach((s,n)=>{visionSource(s,`${p}.sources[${n+1}]`,doc,pages);if(sourceIds.has(s.image_id))fail(p+'.sources','来源图像标识重复');sourceIds.add(s.image_id);});
    list(run.rawTexts,p+'.rawTexts',8);run.rawTexts.forEach((row,n)=>{const q=`${p}.rawTexts[${n+1}]`;only(row,['page','text'],q);pageRef(row.page,q+'.page',pages);if(!run.sources.some(s=>s.page===row.page))fail(q,'文字不属于本次运行页面');boundedText(row.text,q+'.text');});
    runs.set(run.id,run);
  }
  function fromRun(id,p,page,imageId){
    sha256(id,p);const run=runs.get(id);if(!run)fail(p,'引用了不存在的视觉运行');
    if(page!=null&&!run.sources.some(s=>s.page===page&&(imageId==null||s.image_id===imageId)))fail(p,'页面或图像不属于引用的视觉运行');return run;
  }
  const candidateIds=new Set();
  for(const [i,q] of (doc.visionQuarantine||[]).entries()){
    const p=`${path}.visionQuarantine[${i+1}]`;
    only(q,['id','item','error','error_code','page','region','evidence','runId'],p);
    identifier(q.id,p+'.id');if(candidateIds.has(q.id))fail(p+'.id','隔离候选标识重复');candidateIds.add(q.id);
    if(q.page!==null)pageRef(q.page,p+'.page',pages);fromRun(q.runId,p+'.runId',q.page);
    boundedText(q.error,p+'.error',20000);boundedText(q.error_code,p+'.error_code',200);boundedText(q.evidence,p+'.evidence');region(q.region,p+'.region');pendingCandidate(q.item,p+'.item');
  }
  for(const [i,s] of (doc.referenceSuggestions||[]).entries()){
    const p=`${path}.referenceSuggestions[${i+1}]`;
    only(s,['id','kind','raw','source','status','appliedToFieldIds','units','rawSuggestion','runId'],p);
    identifier(s.id,p+'.id');if(suggestions.has(s.id))fail(p+'.id','参考建议标识重复');suggestions.set(s.id,s);
    if(!['unit_declaration','general_tolerance'].includes(s.kind))fail(p+'.kind','参考建议类别无效');
    boundedText(s.raw,p+'.raw');referenceSource(s.source,p+'.source',doc,pages);fromRun(s.runId,p+'.runId',s.source.page);
    ids(s.appliedToFieldIds,p+'.appliedToFieldIds',6000);list(s.units,p+'.units',8);s.units.forEach((u,n)=>boundedText(u,`${p}.units[${n+1}]`,100));
    for(const id of s.appliedToFieldIds){const f=fieldIds.get(id);if(!f||f.page!==s.source.page||f.category!=='dimension')fail(p+'.appliedToFieldIds','参考只能关联已有同页尺寸字段');}
    if(!['pending_review','manually_linked_pending_review'].includes(s.status))s.status='pending_review';
    const raw=s.rawSuggestion;object(raw,p+'.rawSuggestion');rawSource(raw.source,p+'.rawSuggestion.source',doc,pages);
    if(raw.source.page!==s.source.page||raw.source.observation_id!==s.source.observationId||raw.source.observation_raw_text_sha256!==s.source.raw||raw.raw_text!==s.raw)fail(p+'.rawSuggestion','原始参考来源不一致');
    const expected=s.kind==='unit_declaration'?'global_unit_declaration':'general_tolerance_declaration';
    if(raw.kind!==expected)fail(p+'.rawSuggestion.kind','原始参考类别不一致');
    ids(raw.evidence_ids,p+'.rawSuggestion.evidence_ids');if(!raw.evidence_ids.includes(s.source.observationId))fail(p+'.rawSuggestion','原始参考缺少来源引用');
    for(const key of ['primary_unit_raw','secondary_unit_raw','label_raw','decimal_places_raw','amplitude_raw','secondary_amplitude_raw'])if(own(raw,key)&&raw[key]!==null)boundedText(raw[key],p+'.rawSuggestion.'+key,1000);
    fromRun(s.runId,p+'.runId',raw.source.page,raw.source.image_id);raw.status='pending_review';raw.engineering_value_approved=false;raw.applied_to_field_ids=[];
  }
  const packageIds=new Set();
  for(const [i,v] of (doc.packagingVariants||[]).entries()){
    const p=`${path}.packagingVariants[${i+1}]`;
    only(v,['id','partNumber','quantityRaw','quantityCellRaw','packageType','notesRaw','obsolete','raw','page','region','status','source','rawVariant','runId'],p);
    identifier(v.id,p+'.id');if(packageIds.has(v.id))fail(p+'.id','包装候选标识重复');packageIds.add(v.id);
    for(const key of ['partNumber','quantityCellRaw','packageType','notesRaw','raw'])boundedText(v[key],p+'.'+key);
    for(const key of ['quantityRaw','obsolete'])if(v[key]!==null)boundedText(v[key],p+'.'+key,1000);
    pageRef(v.page,p+'.page',pages);region(v.region,p+'.region');referenceSource(v.source,p+'.source',doc,pages);if(v.source.page!==v.page)fail(p+'.source','包装行来源页不一致');fromRun(v.runId,p+'.runId',v.page);
    const raw=v.rawVariant;object(raw,p+'.rawVariant');rawSource(raw.source,p+'.rawVariant.source',doc,pages);rawSource(raw.header_source,p+'.rawVariant.header_source',doc,pages);
    if(raw.classification!=='packaging_variant'||raw.quantity_meaning!=='packaging_amount_not_per_assembly'||raw.assembly_quantity_raw!==null||raw.item_number_raw!==null)fail(p+'.rawVariant','包装数量不能作为装配用量');
    if(raw.source.page!==v.page||raw.source.observation_id!==v.source.observationId||raw.source.observation_raw_text_sha256!==v.source.raw||raw.header_source.image_id!==raw.source.image_id||raw.header_source.page!==v.page)fail(p+'.rawVariant','包装行与表头来源不一致');
    boundedText(raw.header_raw_text,p+'.rawVariant.header_raw_text');ids(raw.evidence_ids,p+'.rawVariant.evidence_ids');
    if(!raw.evidence_ids.includes(raw.source.observation_id)||!raw.evidence_ids.includes(raw.header_source.observation_id))fail(p+'.rawVariant','包装行缺少行或表头引用');
    for(const [key,rawKey] of [['raw','raw_text'],['partNumber','part_number_raw'],['quantityRaw','package_quantity_raw'],['quantityCellRaw','quantity_cell_raw'],['packageType','package_type_raw'],['notesRaw','unassigned_prefix_raw']])if(v[key]!==raw[rawKey])fail(p+'.'+key,'包装行与原始候选不一致');
    fromRun(v.runId,p+'.runId',v.page,raw.source.image_id);v.status='pending';raw.classification_status='pending_review';raw.engineering_value_approved=false;
  }
  for(const [i,f] of doc.fields.entries()){
    const p=`${path}.fields[${i+1}]`;
    if(visualField(f)){
      identifier(f.visionFieldId,p+'.visionFieldId');const provenance=f.provenance;
      only(provenance,['documentSha256','imageId','evidenceIds','coordinates'],p+'.provenance');sameSha(provenance.documentSha256,doc.contentId,p+'.provenance.documentSha256');identifier(provenance.imageId,p+'.provenance.imageId');ids(provenance.evidenceIds,p+'.provenance.evidenceIds');
      if(!provenance.evidenceIds.length||provenance.coordinates!=='model_estimate_unreviewed')fail(p+'.provenance','视觉来源记录无效');
      fromRun(f.visionRunId,p+'.visionRunId',f.page,provenance.imageId);pendingCandidate(f.rawVisionField,p+'.rawVisionField');
      if(f.rawVisionField.id!==f.visionFieldId)fail(p+'.rawVisionField','原字段标识不一致');
      boundedText(f.rawVisionField.name,p+'.rawVisionField.name',500);boundedText(f.rawVisionField.value_raw,p+'.rawVisionField.value_raw');
      for(const key of ['nominal_raw','unit_raw','object','view','state'])if(own(f.rawVisionField,key)&&f.rawVisionField[key]!==null)boundedText(f.rawVisionField[key],p+'.rawVisionField.'+key,2000);
      ids(f.rawVisionField.evidence_ids,p+'.rawVisionField.evidence_ids');
      if(JSON.stringify(f.rawVisionField.evidence_ids)!==JSON.stringify(provenance.evidenceIds))fail(p+'.provenance','字段来源引用不一致');
      if(own(f,'geometryAssociationStatus'))boundedText(f.geometryAssociationStatus,p+'.geometryAssociationStatus',100);
      // History is existing unsigned application history, not an authenticity
      // certificate. A bare model `approved` flag cannot restore an approval.
      const last=lastFieldEvent.get(f.id);
      const reviewed=last?.action==='复核'&&last.decision===f.status&&last.value===f.value&&last.page===f.page&&(!own(last,'field')||last.field===f.name);
      if(!['approved','rejected'].includes(f.status)||!reviewed)f.status='pending';
    }
    if(own(f,'generalToleranceReferences')){
      ids(f.generalToleranceReferences,p+'.generalToleranceReferences',6000);
      for(const id of f.generalToleranceReferences){const s=suggestions.get(id);if(!s||s.kind!=='general_tolerance'||s.source.page!==f.page||!s.appliedToFieldIds.includes(f.id))fail(p+'.generalToleranceReferences','通用公差引用缺少同页来源与关联记录');}
    }
    if(own(f,'unitSource')&&visualField(f)&&f.unitSource!==null&&typeof f.unitSource!=='object')boundedText(f.unitSource,p+'.unitSource',1000);
    if(f.unitSource&&typeof f.unitSource==='object'&&(visualField(f)||own(f.unitSource,'documentSha256'))){
      referenceSource(f.unitSource,p+'.unitSource',doc,pages);if(f.unitSource.page!==f.page)fail(p+'.unitSource','单位来源与字段页码不一致');
      const linked=[...suggestions.values()].some(s=>s.kind==='unit_declaration'&&s.source.page===f.page&&
        s.source.observationId===f.unitSource.observationId&&s.source.raw===f.unitSource.raw&&
        s.source.documentSha256.toLowerCase()===f.unitSource.documentSha256.toLowerCase()&&s.appliedToFieldIds.includes(f.id));
      if(!linked)fail(p+'.unitSource','单位引用缺少匹配的单位声明与字段关联记录');
    }
  }
}
function quote(value,path) {
  object(value,path);array(value.rows,path+'.rows');object(value.options,path+'.options');
  value.rows.forEach((r,i)=>{
    const p=`${path}.rows[${i+1}]`;object(r,p);
    strings(r,['partNumber','name','material','unit','priceSource'],p);
    if(!['bom','manual'].includes(r.source))fail(p+'.source','必须是 bom 或 manual');
    // Incomplete drafts legitimately contain null quantities or prices.
    for(const key of ['qty','unitPrice'])if(r[key]!==null)number(r[key],p+'.'+key,0,Number.MAX_SAFE_INTEGER);
  });
  for(const key of ['labor','overheadPercent','marginPercent','taxPercent'])number(value.options[key],path+'.options.'+key,0,key==='labor'?Number.MAX_SAFE_INTEGER/100:100);
  if(value.options.marginPercent>=100)fail(path+'.options.marginPercent','必须小于 100');
  strings(value,['bomSignature','priceReference','currency','id','document','contentId','status','basis'],path);
  for(const key of ['needsReview','duplicateBOM'])if(own(value,key))bool(value[key],path+'.'+key);
  if(own(value,'at'))date(value.at,path+'.at');
  if(own(value,'result')){
    object(value.result,path+'.result');strings(value.result,['currency'],path+'.result');
    for(const key of ['material','labor','overhead','cost','subtotal','profit','tax','total'])if(own(value.result,key))number(value.result[key],path+'.result.'+key,0);
  }
}

/** Validate the complete v1 backup atomically, preserving reviewed values and audit data. */
export function restoreBackup(data) {
  object(data,'根节点');
  if(data.version!==1)fail('version','必须是受支持的版本 1');
  list(data.documents,'documents',1000);
  const budget={nodes:0,chars:0,visualChars:0};
  return data.documents.map((input,index)=>{
    const path=`第 ${index+1} 份资料`;object(input,path);
    // Drop these before cloning: neither a File object nor a stored path becomes an original file.
    const retained={};
    for(const [key,value] of Object.entries(input))if(!['file','generated'].includes(key)){
      if(['__proto__','prototype','constructor'].includes(key))fail(path+'.'+key,'包含不允许的属性');
      retained[key]=value;
    }
    const doc=jsonClone(retained,path,new Set(),0,budget);
    string(doc.name,path+'.name');if(!doc.name.trim())fail(path+'.name','不能为空');
    strings(doc,['id','contentId'],path);
    if(own(doc,'createdAt'))date(doc.createdAt,path+'.createdAt');
    if(own(doc,'demo'))bool(doc.demo,path+'.demo');
    for(const [key,check] of [['thumbnail',thumbnail],['hash',hash]])if(own(doc,key))check(doc[key],path+'.'+key);
    array(doc.pages,path+'.pages');if(!doc.pages.length)fail(path+'.pages','至少需要一页');
    const pages=new Set();
    doc.pages.forEach((page,i)=>{
      const p=`${path}.pages[${i+1}]`;object(page,p);pageRef(page.page,p+'.page');
      if(pages.has(page.page))fail(p+'.page','不能重复');pages.add(page.page);string(page.text,p+'.text');
      strings(page,['method','type','file','fileName'],p);
      if(own(page,'hash'))hash(page.hash,p+'.hash');if(own(page,'thumbnail'))thumbnail(page.thumbnail,p+'.thumbnail');if(own(page,'preview'))thumbnail(page.preview,p+'.preview');
      for(const key of ['width','height'])if(own(page,key))number(page[key],p+'.'+key,0);
      if(own(page,'ocrConfidence'))number(page.ocrConfidence,p+'.ocrConfidence',0,100);
      if(own(page,'rotation')&&![0,90,180,270].includes(page.rotation))fail(p+'.rotation','必须是 0、90、180 或 270');
      if(own(page,'regions')){array(page.regions,p+'.regions');page.regions.forEach((r,j)=>region(r,`${p}.regions[${j+1}]`));}
      if(own(page,'ocrRegion'))region(page.ocrRegion,p+'.ocrRegion');
      if(page.drawingOCR){
        object(page.drawingOCR,p+'.drawingOCR');array(page.drawingOCR.passes,p+'.drawingOCR.passes');
        page.drawingOCR.passes.forEach((pass,j)=>{const q=`${p}.drawingOCR.passes[${j+1}]`;object(pass,q);strings(pass,['id','text'],q);for(const k of ['regions','words'])if(own(pass,k)){array(pass[k],q+'.'+k);pass[k].forEach((r,n)=>region(r,`${q}.${k}[${n+1}]`));}});
      }
    });
    if(doc.geometryResult)doc.geometryResult=validateGeometryImport(doc,doc.geometryResult);
    if(doc.geometryPreview){object(doc.geometryPreview,path+'.geometryPreview');pageRef(doc.geometryPreview.page,path+'.geometryPreview.page',pages);thumbnail(doc.geometryPreview.data,path+'.geometryPreview.data');if(doc.geometryPreview.rotation!==0)fail(path,'几何预览需为原始方向');}
    // Only legacy backups without fields are reparsed. Existing edits/rejections are authoritative.
    if(!own(doc,'fields')){
      const parsed=parseDocument(doc.pages);doc.fields=parsed.fields;
      if(!own(doc,'bom'))doc.bom=parsed.bom;
      if(!own(doc,'warnings'))doc.warnings=parsed.warnings;
    }
    array(doc.fields,path+'.fields');doc.fields.forEach((f,i)=>field(f,`${path}.fields[${i+1}]`,pages));
    if(!own(doc,'bom'))doc.bom=[];
    array(doc.bom,path+'.bom');doc.bom.forEach((b,i)=>bom(b,`${path}.bom[${i+1}]`,pages));
    if(!own(doc,'warnings'))doc.warnings=[];stringArray(doc.warnings,path+'.warnings');
    if(!own(doc,'history'))doc.history=[];
    array(doc.history,path+'.history');doc.history.forEach((h,i)=>{
      const p=`${path}.history[${i+1}]`;object(h,p);date(h.at,p+'.at');string(h.action,p+'.action');
      // Earlier review events may refer to pages removed by a later manual text revision.
      if(own(h,'page'))pageRef(h.page,p+'.page');
      strings(h,['fieldId','field','name','key'],p);
    });
    restoreVision(doc,path,pages);
    if(own(doc,'quote'))quote(doc.quote,path+'.quote');
    if(own(doc,'quoteHistory')){array(doc.quoteHistory,path+'.quoteHistory');doc.quoteHistory.forEach((q,i)=>quote(q,`${path}.quoteHistory[${i+1}]`));}
    if(own(doc,'instructionRules')||own(doc,'instructionTemplate')){
      try{generateInstructions({name:doc.name,fields:[],bom:[]},{rules:doc.instructionRules??defaultRules,template:doc.instructionTemplate??defaultTemplate});}
      catch(error){fail(path+'.作业指导书配置',error.message);}
      for(const key of ['instructionRules','instructionTemplate'])if(own(doc,key)&&doc[key]===null)fail(path+'.'+key,'必须是对象');
    }
    return doc;
  });
}
