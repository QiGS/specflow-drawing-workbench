/** Semantic geometry candidates: numbers remain linked to visible drawing evidence. */
export const GEOMETRY_PARAMETERS = Object.freeze([
  {key:'mounting_hole_diameter',label:'安装孔径',description:'端子舌片内孔的直径'},
  {key:'tongue_width',label:'舌片外宽',description:'接触舌片外轮廓的宽度'},
  {key:'insulation_length',label:'绝缘套最小长度',description:'绝缘套沿导线方向的最小长度'},
  {key:'noncontact_length',label:'非接触端最大长度',description:'后端至安装孔中心的最大距离；以图中尺寸界线为准'},
  {key:'total_length',label:'端子总长度',description:'端子两个最远端之间的整体长度'},
  {key:'wire_insulation_diameter',label:'导线绝缘层外径范围',description:'允许接入导线的绝缘层外径，不是导体截面积'},
]);
const keys=new Set(GEOMETRY_PARAMETERS.map(p=>p.key));
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=message=>{throw Error('几何参数结果无效：'+message);};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const norm=value=>String(value??'').normalize('NFKC').replace(/\s/g,'').replace(/[−–]/g,'-');
const numbers=value=>String(value??'').match(/(?:\d+(?:\.\d+)?|\.\d+)/g)||[];
function box(value){if(value==null)return null;if(!plain(value)||!['x','y','width','height'].every(k=>typeof value[k]==='number'&&Number.isFinite(value[k]))||value.x<0||value.y<0||value.width<=0||value.height<=0||value.x+value.width>1.000001||value.y+value.height>1.000001)fail('区域必须位于原图范围内');return Object.fromEntries(['x','y','width','height'].map(k=>[k,value[k]]));}
function numericEvidence(raw,evidence){const available=numbers(evidence);return numbers(raw).every(n=>available.includes(n));}
/** Whitelist copied properties: imports never change existing OCR fields or approve candidates. */
export function validateGeometryImport(doc,input){
  const data=input?.geometryResult||input;
  if(!plain(data)||data.schema_version!=='geometry-1.0')fail('不支持此数据格式');
  if(!text(data.document_sha256,64)||!/^[a-f0-9]{64}$/i.test(data.document_sha256)||data.document_sha256.toLowerCase()!==doc?.contentId?.toLowerCase())fail('原文件 SHA-256 不匹配');
  if(!Number.isInteger(data.page)||!doc.pages?.some(p=>p.page===data.page))fail('来源页不存在');
  if(!Array.isArray(data.parameters)||data.parameters.length>6)fail('最多支持六种参数');
  if(data.model!=null&&!text(data.model,200))fail('模型名称无效');
  if(data.elapsed_seconds!=null&&(typeof data.elapsed_seconds!=='number'||!Number.isFinite(data.elapsed_seconds)||data.elapsed_seconds<0||data.elapsed_seconds>86400))fail('处理耗时无效');
  const observations=Array.isArray(data.observations)?data.observations.map(o=>{if(!plain(o)||!text(o.id,200)||!text(o.raw_text,10000))fail('原文观察无效');return {id:o.id,raw_text:o.raw_text,region:box(o.region)};}):[];
  if(observations.length>100||new Set(observations.map(o=>o.id)).size!==observations.length)fail('原文观察过多或重复');
  const seen=new Set(),parameters=data.parameters.map(p=>{
    if(!plain(p)||!keys.has(p.key)||seen.has(p.key))fail('参数类型未知或重复');seen.add(p.key);
    for(const k of ['value_raw','unit_raw','nominal_raw','tolerance_raw','limit'])if(p[k]!=null&&!text(p[k],1000))fail(k+'必须为文本或空值');
    if(!text(p.reason??'',4000)||!text(p.evidence_text??'',10000))fail('依据文本过长或类型错误');
    if(p.nominal_raw!=null&&!/^[+\-−]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(p.nominal_raw))fail('名义尺寸格式错误');
    if(!['candidate','missing','unknown','unresolved'].includes(p.status))fail('模型结果必须待复核或未识别');
    const limit=p.limit==null?null:p.limit.toLowerCase();if(![null,'min','max','range'].includes(limit))fail('限值类型只允许 min、max 或 range');
    const annotation_region=box(p.annotation_region),object_region=box(p.object_region);
    const status=p.status==='candidate'?'candidate':'missing';
    const evidence_ids=p.evidence_ids??[];if(!Array.isArray(evidence_ids)||evidence_ids.length>20||!evidence_ids.every(id=>typeof id==='string'&&observations.some(o=>o.id===id)))fail('原文引用不存在');
    const leader_points=p.leader_points??[];if(!Array.isArray(leader_points)||leader_points.length>20||!leader_points.every(pt=>plain(pt)&&Number.isFinite(pt.x)&&Number.isFinite(pt.y)&&pt.x>=0&&pt.x<=1&&pt.y>=0&&pt.y<=1))fail('引线端点超出页面');
    if(status==='candidate'){
      if(evidence_ids.length&&!numericEvidence(p.value_raw,evidence_ids.map(id=>observations.find(o=>o.id===id).raw_text).join(' ')))fail('数值不在引用观察中');
      if(!p.value_raw?.trim()||!p.evidence_text?.trim()||!p.reason?.trim())fail('参数缺少原文或几何关联依据');
      if(!numbers(p.value_raw).length||!numericEvidence(p.value_raw,p.evidence_text)||!numericEvidence(p.nominal_raw,p.evidence_text)||!numericEvidence(p.tolerance_raw,p.evidence_text))fail('数值不在引用原文中');
      if(p.unit_raw&&!norm(p.evidence_text).toLowerCase().includes(norm(p.unit_raw).toLowerCase()))fail('单位缺少引用原文');
      if(p.tolerance_raw&&!norm(p.evidence_text).includes(norm(p.tolerance_raw)))fail('公差缺少引用原文');
      if(p.key==='wire_insulation_diameter'&&/(?:mm\s*[²2]|AWG|circular\s+mil)/i.test(p.value_raw))fail('导体截面积或线规不能当作绝缘层外径');
    }else if(p.value_raw||p.nominal_raw||p.tolerance_raw||p.unit_raw)fail('未识别参数不能同时给出数值');
    return {key:p.key,label:GEOMETRY_PARAMETERS.find(x=>x.key===p.key).label,value_raw:p.value_raw??null,unit_raw:p.unit_raw??null,nominal_raw:p.nominal_raw??null,tolerance_raw:p.tolerance_raw??null,limit,annotation_region,object_region,reason:p.reason||'',evidence_text:p.evidence_text||'',evidence_ids:[...evidence_ids],leader_points:leader_points.map(pt=>({x:pt.x,y:pt.y})),status};
  });
  return {schema_version:'geometry-1.0',document_sha256:data.document_sha256.toLowerCase(),page:data.page,observations,parameters,...(data.model!=null?{model:data.model}:{}),...(data.elapsed_seconds!=null?{elapsed_seconds:data.elapsed_seconds}:{})};
}
function rotate(b,rotation){if(!b)return b;if(rotation===90)return {x:1-b.y-b.height,y:b.x,width:b.height,height:b.width};if(rotation===180)return {x:1-b.x-b.width,y:1-b.y-b.height,width:b.width,height:b.height};if(rotation===270)return {x:b.y,y:1-b.x-b.width,width:b.height,height:b.width};return b;}
function overlays(parameters,selected,rotation){return parameters.filter(p=>p.status==='candidate').map(p=>{const i=GEOMETRY_PARAMETERS.findIndex(k=>k.key===p.key)+1;const a=rotate(p.annotation_region,rotation),o=rotate(p.object_region,rotation),active=p.key===selected;return `<g class="geometry-overlay ${active?'is-active':''}">${p.leader_points?.length?`<polyline class="geometry-leader" points="${p.leader_points.map(pt=>{const r=rotate({x:pt.x,y:pt.y,width:0,height:0},rotation);return `${r.x*1000},${r.y*1000}`;}).join(' ')}"/>`:''}${o?`<rect class="geometry-object" x="${o.x*1000}" y="${o.y*1000}" width="${o.width*1000}" height="${o.height*1000}"/>`:''}${a?`<rect class="geometry-annotation" x="${a.x*1000}" y="${a.y*1000}" width="${a.width*1000}" height="${a.height*1000}"/><text x="${Math.max(14,a.x*1000)}" y="${Math.max(28,a.y*1000-8)}">${i}</text>`:''}</g>`;}).join('');}
function displayValue(p){const prefix=p.key==='mounting_hole_diameter'?'Ø ':'';const limit=String(p.limit||'').toUpperCase();return prefix+(/MIN|最小/.test(limit)?'≥ ': /MAX|最大/.test(limit)?'≤ ':'')+(p.nominal_raw||p.value_raw);}
export function geometryPanel(doc,selectedKey=''){
  let result=null,error='';if(doc?.geometryResult){try{result=validateGeometryImport(doc,doc.geometryResult);}catch(e){error=e.message;}}
  const candidates=result?.parameters||[],selected=keys.has(selectedKey)?selectedKey:(candidates.find(p=>p.status==='candidate')?.key||GEOMETRY_PARAMETERS[0].key);
  const parameter=candidates.find(p=>p.key===selected),definition=GEOMETRY_PARAMETERS.find(p=>p.key===selected),page=doc?.pages?.find(p=>p.page===(result?.page||doc?.pages?.[0]?.page))||{},hires=doc?.geometryPreview?.page===page.page?doc.geometryPreview:null,preview=hires?.data||page.preview||page.thumbnail||(page.page===1?doc?.thumbnail:'');
  const safePreview=typeof preview==='string'&&/^(data:image\/(?:png|jpe?g|webp);base64,|blob:)/i.test(preview)?preview:'';
  const cards=GEOMETRY_PARAMETERS.map((d,i)=>{const p=candidates.find(p=>p.key===d.key),found=p?.status==='candidate';return `<button type="button" class="geometry-card ${selected===d.key?'is-selected':''} ${found?'':'is-missing'}" data-geometry-key="${d.key}" aria-pressed="${selected===d.key}"><span class="geometry-card-label"><b>${i+1}</b>${d.label}</span><span class="geometry-card-value">${found?escape(displayValue(p)):'未识别'}${found&&p.unit_raw?`<small>${escape(p.unit_raw)}</small>`:(found?'<small>单位待确认</small>':'')}</span>${found?`<span class="geometry-card-meta">${escape([p.tolerance_raw,p.limit].filter(Boolean).join(' · ')||'未标注专用公差')} · 待复核</span>`:'<span class="geometry-card-meta">等待图像语义提取结果</span>'}</button>`;}).join('');
  return `<section class="panel geometry-panel"><div class="geometry-header"><div><h2>几何参数 · 对照原图</h2><p>点击参数卡片，查看数值标注和对应部位。</p></div><div class="flex"><button id="geometryImportButton" type="button">导入几何识别结果</button><input id="geometryImport" type="file" accept=".json,application/json" hidden><button id="geometryExport" type="button" ${result?'':'disabled'}>导出参数</button></div></div>${error?`<p class="notice">${escape(error)}</p>`:''}<div class="geometry-cards">${cards}</div><div class="geometry-comparison"><div class="geometry-drawing"><div class="geometry-drawing-caption"><strong>原图 · 第 ${Number(page.page)||1} 页</strong><label class="geometry-zoom-label">放大 <select id="geometryZoom" aria-label="原图放大倍数"><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><span><i class="geometry-legend-annotation"></i>尺寸标注 <i class="geometry-legend-object"></i>对应部位</span></div>${safePreview?`<div class="geometry-image-viewport"><div class="geometry-image-wrap" id="geometryImageWrap"><img src="${escape(safePreview)}" alt="原始图纸，第 ${Number(page.page)||1} 页"><svg viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label="尺寸标注和几何部位高亮，位置为模型候选">${overlays(candidates,selected,hires?(hires.rotation||0):(page.rotation||0))}</svg></div></div>`:'<div class="geometry-no-preview">请先导入原 PDF 或图片以查看图形位置。</div>'}</div><div class="geometry-detail" aria-live="polite"><span class="geometry-detail-eyebrow">${GEOMETRY_PARAMETERS.findIndex(p=>p.key===selected)+1} / 6 · ${parameter?.status==='candidate'?'语义关联候选':'尚未识别'}</span><h3>${definition.label}</h3><p class="geometry-definition">${definition.description}</p>${parameter?.status==='candidate'?`<div class="geometry-detail-value">${escape(displayValue(parameter))} <small>${escape(parameter.unit_raw||'单位未确认')}</small></div><dl><dt>公差</dt><dd>${escape(parameter.tolerance_raw||'未标注专用公差')}</dd><dt>限值</dt><dd>${escape(parameter.limit||'无明确限值')}</dd></dl><h4>为什么对应这里</h4><p>${escape(parameter.reason)}</p><h4>图上原文</h4><blockquote>${escape(parameter.evidence_text)}</blockquote>${!parameter.annotation_region||!parameter.object_region?'<p class="notice">部分区域未可靠定位，请在原图上进一步核对。</p>':''}`:`<p class="geometry-empty-reason">${escape(parameter?.reason||'现有标注尚未建立与该部位的可靠对应。请运行几何语义识别，再导入结果；不会按数值大小自动猜测部位。')}</p>`}<p class="geometry-review-note">模型提供的数值和部位关联均需复核。位置框为近似区域，不代表精确几何测量。</p></div></div></section>`;
}
