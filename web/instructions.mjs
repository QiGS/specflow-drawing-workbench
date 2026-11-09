/** Evidence-bound instruction drafts. Never invents process parameters or grants approval. */
const ids = ['applicable', 'preparation', 'materials', 'steps', 'quality', 'technical', 'precautions', 'missing'];
export const defaultRules = Object.freeze({
  version: '1.1', requiredFields: Object.freeze(['图号', '版本', '材料', '尺寸', '技术要求', '作业步骤']), blockExportOnMissing: true,
});
export const defaultTemplate = Object.freeze({
  version: '1.1', sections: Object.freeze([
    { title: '适用产品与引用资料', fieldNames: ['产品型号', '名称', '图号', '零件号', '新零件号', '旧零件号', '版本', '结构', '安装方式', '回路数', '回路数(已装载)', '回路数(最大)'], fixedText: '本文件为作业指导书草稿，适用范围与引用资料需由负责人确认。' },
    { title: '作业准备', fieldNames: ['作业准备', '准备要求', '作业条件'], fixedText: '作业前核对当前图纸版本、适用产品及本文件审核状态。' },
    { title: '材料与工具', fieldNames: ['材料', '工具', '工装', '设备'], fixedText: '仅引用已记录的物料与工具信息。未提供的设备、工装或工具由负责人补充。' },
    { title: '作业步骤', fieldNames: ['作业步骤', '操作步骤', '工艺步骤', '装配步骤'], fixedText: '仅引用资料中明确记录的操作，不根据尺寸或外观推导工序与顺序。' },
    { title: '关键尺寸与质量要求', fieldNames: ['尺寸', '尺寸标注', '直径', '长度', '宽度', '高度', '间隙', '间距', '配合间距', '公差', '公差标准', '粗糙度', '检验要求', '检测方法'], fixedText: '按原文核对尺寸、单位、状态与适用位置。' },
    { title: '技术要求', fieldNames: ['技术要求', '技术标准', '表面处理', '热处理', '投影法', '额定电压', '工作电压', '额定电流', '额定功率', '工作温度', '防护等级'], fixedText: '本节保持原文含义，数值范围与单位不进行自动改写。' },
    { title: '注意事项', fieldNames: ['注意事项', '安全要求', '防护要求', '警告'], fixedText: '待复核内容需要人工确认；本草稿不能替代经批准的工艺或安全操作规程。' },
    { title: '缺失信息与人工确认', fixedText: '由工艺负责人补齐缺失信息，并完成编制、审核和批准。自动生成不会赋予批准状态。' },
  ].map(s => Object.freeze({ ...s, ...(s.fieldNames ? {fieldNames: Object.freeze(s.fieldNames)} : {}) }))),
});
const clean = value => String(value ?? '').trim();
const htmlEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const mdEscape = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/[\[\]`*_{}()#!|]/g, '\\$&').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, ' / ');
const labels = {fixed:'固定模板', evidence:'图纸证据', rule:'规则生成'};
const aliases={'直径标注':'直径','舌片厚度':'尺寸','材料厚度':'尺寸','表面处理要求':'表面处理','结构标注':'结构','未注公差说明':'公差','尺寸单位':'尺寸'};
const defaultCategorySections={identity:0,structure:0,mounting:0,material:2,dimension:4,process:5,standard:5,performance:5};
const requiredName=value=>clean(value).normalize('NFKC').toLowerCase().replace(/[\s._:#-]+/g,'');
const defaultRequiredAliases={
  '图号':['Drawing Number','Drawing No','DWG No'],
  '版本':['Revision','Revision No','Rev','Version'],
  '材料':['Material','Base Material','Body Material'],
  '尺寸':['Dimension','Dimensions'],
  '技术要求':['Technical Requirements','Technical Requirement','Technical Notes','Process Requirements'],
  '作业步骤':['Work Steps','Operation Steps','Assembly Steps','Manufacturing Steps','Operation Sequence'],
};
function satisfiesRequired(name,field,rules){
  if(clean(field.name)===name||(name==='尺寸'&&field.category==='dimension'))return true;
  if(rules!==defaultRules)return false;
  if((defaultRequiredAliases[name]||[]).some(alias=>requiredName(alias)===requiredName(field.name)))return true;
  return name==='技术要求'&&['process','standard'].includes(field.category);
}
const namedMatch=(section,field)=>(section.fieldNames||[]).map(clean).some(name=>name===clean(field.name)||name===aliases[clean(field.name)]||(defaultRequiredAliases[name]||[]).some(alias=>requiredName(alias)===requiredName(field.name)));
function selectedForSection(template,section,index,field){
  // A caller-provided template is a user's explicit field selection, including
  // JSON copies of the default template. Never expand it by category silently.
  if(template!==defaultTemplate)return (section.fieldNames||[]).map(clean).includes(clean(field.name));
  if(namedMatch(section,field))return true;
  if(template.sections.some(s=>namedMatch(s,field)))return false;
  return defaultCategorySections[field.category]===index;
}
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} 必须是对象`); }
function text(value, label, allowEmpty=false) { if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length>20000) throw new TypeError(`${label} 必须是有效文本`); return value.trim(); }
function config(rules, template) {
  object(rules, '规则'); object(template, '模板');
  text(rules.version, '规则版本'); text(template.version, '模板版本');
  if (!Array.isArray(rules.requiredFields) || rules.requiredFields.length>200) throw new TypeError('requiredFields 必须是字段名数组');
  rules.requiredFields.forEach(x=>text(x, '必填字段名'));
  if (typeof rules.blockExportOnMissing !== 'boolean') throw new TypeError('blockExportOnMissing 必须是布尔值');
  if (!Array.isArray(template.sections) || template.sections.length!==8) throw new TypeError('模板必须保留 8 个章节');
  template.sections.forEach((s,i)=>{
    object(s, `第 ${i+1} 章`); text(s.title, '章节标题');
    if(s.fieldNames!==undefined){
      if(!Array.isArray(s.fieldNames) || s.fieldNames.length>200) throw new TypeError('fieldNames 必须是字段名数组');
      s.fieldNames.forEach(x=>text(x, '字段名'));
    }
    if(s.fixedText!==undefined) text(s.fixedText, '固定内容', true);
  });
}
function sourceFor(doc, item, fallback) {
  const region=item.region ?? item.bbox ?? null;
  const source={sourceName:clean(item.sourceName || doc.name) || '未命名资料', documentId:clean(doc.id), page:Number.isInteger(item.page)&&item.page>0?item.page:null,
    region:region===null ? null : JSON.parse(JSON.stringify(region)), fieldIds:[clean(item.id)||fallback], evidence:clean(item.evidence)};
  if(item.provenance){
    source.documentSha256=clean(item.provenance.documentSha256||doc.contentId);
    source.imageId=clean(item.provenance.imageId);
    source.evidenceIds=[...(item.provenance.evidenceIds||[])];
    source.coordinates=clean(item.provenance.coordinates);
  }
  if(item.unitEvidence){source.unitEvidence=clean(item.unitEvidence);source.unitSource=structuredClone(item.unitSource??null);}
  const manual=(doc.history||[]).filter(h=>h.fieldId===item.id&&['人工确认单位来源','人工单位确认','人工标注关联'].includes(h.action));
  if(manual.length)source.manualAssociations=structuredClone(manual);
  const references=(doc.referenceSuggestions||[]).filter(r=>(item.generalToleranceReferences||[]).includes(r.id)&&(r.appliedToFieldIds||[]).includes(item.id));
  if(references.length)source.generalToleranceReferences=references.map(r=>({id:r.id,raw:clean(r.raw),source:structuredClone(r.source??null),status:clean(r.status)}));
  return source;
}
function sourceText(source) {
  const r=source.region;
  const region=r===null?'区域未标注':typeof r==='string'?r:r.boxes?`${r.boxes.length} 处来源区域（详见结构化溯源）`:[r.x,r.y,r.width??r.w,r.height??r.h].every(Number.isFinite)?`区域 [${[r.x,r.y,r.width??r.w,r.height??r.h].map(n=>Number(n.toFixed(3))).join(', ')}]`:'区域坐标见结构化溯源';
  return `${source.sourceName} · ${source.page===null?'页码未标注':`第 ${source.page} 页`} · ${region} · 字段 ${source.fieldIds.join(', ')}`;
}
function referenceText(source){
  const references=[];
  if(source.documentSha256)references.push(`文件SHA256：${source.documentSha256}${source.evidenceIds?.length?`；证据引用：${source.evidenceIds.join('、')}`:''}`);
  if(source.unitEvidence)references.push(`单位来源：${source.unitSource?.page?`第 ${source.unitSource.page} 页；`:''}${source.unitEvidence}；仅适用于已人工核对的目标字段`);
  for(const r of source.generalToleranceReferences||[])references.push(`人工关联通用公差参考：${r.source?.page?`第 ${r.source.page} 页；`:''}${r.raw}；未替代专用公差，未计算公差数值`);
  for(const h of source.manualAssociations||[])references.push(`人工记录：${h.action}${h.key?` / ${h.key}`:''}；${clean(h.before)||'未填写'} → ${clean(h.after)||'未填写'}${h.at?`；${h.at}`:''}`);
  return references;
}
function dimensionText(field){
  const geometry=field.geometryAssociationStatus==='unconfirmed'||!clean(field.object)||!clean(field.view);
  const limit=field.limit?`；限值：${field.limit==='min'?'最小值':field.limit==='max'?'最大值':clean(field.limit)}`:'';
  return `；对象：${clean(field.object)||'待确认'}；视图：${clean(field.view)||'待确认'}；状态：${clean(field.state)||'待确认'}；单位：${clean(field.unit)||'未提供，待确认'}；公差：${clean(field.tolerance?.raw)||'未提供，待确认'}${limit}${geometry?'；几何关联待确认（未自动验证）':''}`;
}
export function generateInstructions(doc={}, {rules=defaultRules,template=defaultTemplate}={}) {
  object(doc,'资料'); config(rules,template);
  if(doc.fields!==undefined && !Array.isArray(doc.fields)) throw new TypeError('fields 必须是数组');
  if(doc.bom!==undefined && !Array.isArray(doc.bom)) throw new TypeError('bom 必须是数组');
  const excludedIds=new Set([...(doc.visionQuarantine||[]),...(doc.packagingVariants||[])].map(r=>r.id).filter(Boolean));
  const quarantined=(doc.visionQuarantine||[]).filter(q=>q.item&&typeof q.item==='object');
  const isQuarantined=item=>quarantined.some(q=>q.item.id===item.id&&(
    q.runId&&(item.visionRunId||item.runId)?q.runId===(item.visionRunId||item.runId):JSON.stringify(q.item)===JSON.stringify(item)));
  const allowed=item=>item&&typeof item==='object'&&!excludedIds.has(item.id)&&!isQuarantined(item)&&!['rejected','quarantined','rejected_unreviewed'].includes(item.status);
  const fields=(doc.fields||[]).filter(f=>allowed(f) && !f.requiresReconciliation && clean(f.name) && clean(f.value));
  const bom=(doc.bom||[]).filter(allowed);
  const required=[...new Set(rules.requiredFields.map(clean))];
  const missing=required.filter(name=>!fields.some(f=>satisfiesRequired(name,f,rules)));
  const provenance=[];
  const sections=template.sections.map((s,index)=>{
    const items=[];
    if(s.fixedText?.trim()) items.push({category:'fixed',text:s.fixedText.trim()});
    for(const field of fields.filter(f=>selectedForSection(template,s,index,f))){
      const source=sourceFor(doc,field,`field-${(doc.fields||[]).indexOf(field)+1}`);
      provenance.push(source);
      items.push({category:'evidence', text:`${[clean(field.model),clean(field.state),clean(field.name)].filter(Boolean).join(' / ')}：${clean(field.value)}${field.category==='dimension'?dimensionText(field):''}${field.ocrConflict?'；OCR 存在不同候选，待核对原图':''}${field.dualUnitValidation?.status==='mismatch'?'；双单位换算不一致，待核对原图':''}${field.unresolvedAnnotations?.length?'；部分标注字符未解析，待核对原图':''}`, source, reviewStatus:field.status==='approved'?'approved':'pending'});
    }
    if(index===2) for(const row of bom){
      const source=sourceFor(doc,row,`bom-${(doc.bom||[]).indexOf(row)+1}`); provenance.push(source);
      items.push({category:'evidence',text:`物料：${[clean(row.partNumber),clean(row.name)].filter(Boolean).join(' ')}；数量：${row.qty===undefined?'未提供':clean(row.qty)} ${clean(row.unit)}${row.material?`；材料：${clean(row.material)}`:''}`,source,reviewStatus:row.status==='approved'?'approved':'pending'});
    }
    if(index===7){
      if(missing.length) items.push(...missing.map(name=>({category:'rule',text:`缺少必填信息：${name}。请查阅原始资料或由负责人补充。`})))
      else items.push({category:'rule',text:'配置的必填字段已出现，仍需核对原文、适用性并由负责人审核。'});
      const pending=fields.filter(f=>f.status!=='approved').length+bom.filter(b=>b.status!=='approved').length;
      items.push({category:'rule',text:`当前资料有 ${pending} 项非批准的候选内容。生成结果始终为草稿。`});
      if((doc.visionQuarantine||[]).length||(doc.packagingVariants||[]).length)items.push({category:'rule',text:'证据不完整候选与包装／产品变体表已排除，不作为作业步骤、装配物料或生产用量。'});
    } else if(!items.some(x=>x.category==='evidence')) items.push({category:'rule',text:'本章节没有可引用的字段，需由负责人补充。'});
    return {id:ids[index],title:s.title,items};
  });
  const title=`${clean(doc.name)||'图纸'} — 作业指导书草稿`;
  const statusText='状态：草稿 / 待人工审核。固定模板、图纸证据与规则生成内容已分别标注。';
  const versionText=`规则版本：${rules.version}；模板版本：${template.version}`;
  const markdown=[`# ${mdEscape(title)}`,'',statusText,versionText,...sections.flatMap(s=>['',`## ${mdEscape(s.title)}`,...s.items.flatMap(item=>[
    `- 【${labels[item.category]}】${mdEscape(item.text)}${item.category==='evidence'?`（${item.reviewStatus==='approved'?'该来源已复核':'待复核'}）`:''}`,
    ...(item.source?[`  来源：${mdEscape(sourceText(item.source))}`,`  原文：${mdEscape(item.source.evidence || '未提供原文，需人工核实')}`,...referenceText(item.source).map(line=>'  '+mdEscape(line))]:[]),
  ])])].join('\n');
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${htmlEscape(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:20px;line-height:1.8;color:#263c30}section{break-inside:avoid;margin-top:24px}li{margin-bottom:12px}.source{font-size:12px;color:#617466;white-space:pre-wrap}small{color:#856a38}h1{font-size:24px}h2{font-size:18px}</style></head><body><h1>${htmlEscape(title)}</h1><p>${htmlEscape(statusText)}</p><p>${htmlEscape(versionText)}</p>${sections.map(s=>`<section><h2>${htmlEscape(s.title)}</h2><ul>${s.items.map(item=>`<li><b>【${labels[item.category]}】</b>${htmlEscape(item.text)}${item.category==='evidence'?` <small>${item.reviewStatus==='approved'?'该来源已复核':'待复核'}</small>`:''}${item.source?`<div class="source">来源：${htmlEscape(sourceText(item.source))}<br>原文：${htmlEscape(item.source.evidence || '未提供原文，需人工核实')}${referenceText(item.source).map(line=>'<br>'+htmlEscape(line)).join('')}</div>`:''}</li>`).join('')}</ul></section>`).join('')}</body></html>`;
  return {title,markdown,html,missing,sections,provenance,ruleVersion:rules.version,templateVersion:template.version,fieldSelectionMode:template===defaultTemplate?'default_name_and_category':'custom_field_names',status:'draft',exportBlocked:rules.blockExportOnMissing&&missing.length>0};
}
