/** Browser/Node engineering text utilities. Deterministic extraction, not VLM inference. */
import {extractDrawingFields} from './drawing.mjs?v=9';
const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const fold = value => normalize(value).toLocaleLowerCase();
const definitions = [
  ['旧零件号','identity',['旧零件号','旧料号','Old Part Number','Previous Part Number']],
  ['新零件号','identity',['新零件号','新料号','New Part Number']],
  ['图号','identity',['图号','Drawing No.','Drawing No','Drawing Number']],
  ['零件号','identity',['零件号','Part No.','Part No','Part Number']],
  ['产品型号','identity',['产品型号','型号','Model Number','Model']],
  ['名称','identity',['零件名称','产品名称','名称','Title','Part Name','Description']],
  ['版本','identity',['版本','版次','Revision','Rev.','Rev']],
  ['材料','material',['材料','材质','Material - Metal','Material - Housing','Material - Insulation','Material']],
  ['公差','standard',['一般公差','未注公差','公差','General Tolerances','General Tolerance','Tolerances','Tolerance']],
  ['粗糙度','process',['表面粗糙度','粗糙度','Surface Roughness','Roughness']],
  ['表面处理','process',['表面处理','Material - Plating Mating','Material - Plating Termination','Material - Plating','Surface Treatment','Surface Finish','Finish','Plating']],
  ['热处理','process',['热处理','Heat Treatment']],
  ['技术标准','standard',['技术标准','执行标准','Applicable Standards','Applicable Standard','Technical Standards','Standard']],
  ['结构','structure',['结构形式','结构','Construction','Structure','Configuration']],
  ['安装方式','mounting',['安装方式','安装类型','Mounting Type','Mounting Style','Mounting']],
  ['尺寸','dimension',['外形尺寸','尺寸','Overall Dimensions','Dimensions','Dimension']],
  ['直径','dimension',['直径','Diameter']], ['长度','dimension',['长度','Length']],
  ['宽度','dimension',['宽度','Width']], ['高度','dimension',['高度','Height']],
  ['间隙','dimension',['间隙','Gap','Clearance']], ['间距','dimension',['间距','节距','Pitch']],
  ['配合间距','dimension',['Pitch - Mating Interface (in)','Pitch - Mating Interface (mm)','Pitch - Mating Interface'],{object:'配合接口'}],
  ['端接间距','dimension',['Pitch - Term. Interface (in)','Pitch - Termination Interface (in)'],{object:'端接接口',unitHint:'in'}],
  ['端接间距','dimension',['Pitch - Term. Interface (mm)','Pitch - Termination Interface (mm)'],{object:'端接接口',unitHint:'mm'}],
  ['配合面最小镀层厚度','dimension',['Plating min: Mating (μin)','Plating min: Mating (µin)'],{object:'配合面',unitHint:'μin'}],
  ['配合面最小镀层厚度','dimension',['Plating min: Mating (μm)','Plating min: Mating (µm)'],{object:'配合面',unitHint:'μm'}],
  ['端接面最小镀层厚度','dimension',['Plating min: Termination (μin)','Plating min: Termination (µin)'],{object:'端接面',unitHint:'μin'}],
  ['端接面最小镀层厚度','dimension',['Plating min: Termination (μm)','Plating min: Termination (µm)'],{object:'端接面',unitHint:'μm'}],
  ['额定电压','performance',['额定电压','Rated Voltage']],
  ['工作电压','performance',['工作电压','供电电压','Operating Voltage','Supply Voltage']],
  ['额定电流','performance',['额定电流','Rated Current']],
  ['额定功率','performance',['额定功率','Rated Power']],
  ['转速','performance',['空载转速','额定转速','转速','No-load Speed','No Load Speed','Rated Speed','Speed']],
  ['扭矩','performance',['额定扭矩','扭矩','转矩','Rated Torque','Torque']],
  ['工作温度','performance',['工作温度','Operating Temperature']],
  ['防护等级','performance',['防护等级','Ingress Protection','IP Rating']],
  ['重量','performance',['净重','重量','Weight','Mass']],
  ['回路数','structure',['回路数','电路数','Circuits','Number of Circuits']],
  ['回路数(已装载)','structure',['Circuits (Loaded)']],
  ['回路数(最大)','structure',['Circuits (maximum)']],
  ['回路明细','structure',['Circuits Detail']],
  ['技术要求','requirement',['技术要求','技术说明','Technical Requirements','Technical Requirement','Technical Notes','Technical Note']]
];
const escapePattern = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compileRules(options) {
  const disabled = new Set(options.disabledRules || []), custom = [];
  for (const rule of options.rules || []) {
    if (!rule || rule.enabled === false || !normalize(rule.name)) continue;
    const labels = Array.isArray(rule.labels || rule.label) ? (rule.labels || rule.label) : [rule.label || rule.name];
    const safeLabels = labels.map(normalize).filter(x => x.length && x.length <= 100);
    if (!safeLabels.length) continue;
    custom.push({name: normalize(rule.name), category: rule.dimension ? 'dimension' : rule.category || 'requirement', labels:safeLabels});
  }
  const base = options.includeDefaults === false ? [] : definitions.filter(([name]) => !disabled.has(name) && !custom.some(r=>r.name===name)).map(([name,category,labels,extras])=>({name,category,labels,...extras}));
  return [...custom,...base].flatMap(rule=>rule.labels.map(label=>({...rule,labels:[label]}))).sort((a,b)=>b.labels[0].length-a.labels[0].length).map(rule=>({...rule, pattern:new RegExp(`^(?:${[...rule.labels].sort((a,b)=>b.length-a.length).map(escapePattern).join('|')})(?:\\s*[:：=#|]\\s*|\\s+)(.+)$`,'i'), heading:new RegExp(`^(?:${rule.labels.map(escapePattern).join('|')})\\s*[:：=#|]?\\s*$`,'i')}));
}
function isFieldHeading(value, rules) {
  const cell=normalize(value).replace(/[:：]$/,'').trim();
  if(rules.some(r=>r.heading.test(cell)))return true;
  const withUnit=cell.match(/^(.+?)\s*[([]\s*([^\])]+)\s*[)\]]$/);
  if(!withUnit)return false;
  const label=withUnit[1].trim(), unit=withUnit[2].trim();
  // Unit-bearing adjacent column headings are not values, even for a field we do not extract yet.
  const engineeringUnit=/^(?:°?[CFK]|μ?m|µm|mm|cm|in|ft|MPa|kPa|Pa|bar|psi|k?N|N[·.]?m|kg|g|V|m?A|k?W|Hz|rpm|%|mm\/s|m\/s)$/i;
  return engineeringUnit.test(unit) && (rules.some(r=>r.heading.test(label)) || /^[A-Za-z\u4e00-\u9fff][A-Za-z\u4e00-\u9fff\s/-]*$/.test(label));
}
const viewOf = line => {
  const explicit = line.match(/^(?:视图|view)\s*[:：=]\s*(.+)$/i);
  if (explicit) return normalize(explicit[1]);
  return /^(?:主视图|俯视图|左视图|右视图|后视图|底视图|剖视图(?:\s*[A-Z]-[A-Z])?|front view|top view|left view|right view|bottom view|rear view|section\s+[A-Z]-[A-Z])\s*[:：]?$/i.test(line) ? line.replace(/[:：]$/,'') : '';
};
function regionFor(pageData, evidence) {
  const evidenceLines = String(evidence).split(/\r?\n/).map(fold).filter(Boolean);
  const regions = (pageData.regions || []).map(region=>({region,text:fold(region.text || region.str || '')})).filter(r=>r.text);
  const counts=new Map();for(const {text} of regions)counts.set(text,(counts.get(text)||0)+1);
  const selected=new Set();
  const hasRect=r=>[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.width>0&&r.height>0;
  const sameRow=(a,b)=>hasRect(a)&&hasRect(b)&&Math.abs(a.y+a.height/2-b.y-b.height/2)<=Math.min(a.height,b.height)*.5;
  const nearby=(a,b)=>sameRow(a,b)&&Math.max(0,a.x-(b.x+b.width),b.x-(a.x+a.width))<=Math.max(a.height,b.height)*8;
  const wordChar=ch=>Boolean(ch)&&/[\p{L}\p{N}_]/u.test(ch);
  const containsText=(line,text)=>{
    let start=line.indexOf(text);
    while(start!==-1){
      if((!wordChar(text[0])||!wordChar(line[start-1]))&&(!wordChar(text.at(-1))||!wordChar(line[start+text.length])))return true;
      start=line.indexOf(text,start+1);
    }
    return false;
  };
  const specific=text=>(text.length>=4&&/[\p{L}]/u.test(text))||/^\d{6,}$/.test(text)||/[\u4e00-\u9fff]{2}/.test(text);
  for(const line of evidenceLines){
    const exact=regions.filter(r=>r.text===line);
    // A complete provider line is stronger evidence than unrelated fragments elsewhere.
    if(exact.length){if(exact.length===1)selected.add(exact[0]);continue;}
    const cells=line.split(/[|\t]/).map(s=>s.trim()).filter(Boolean);
    const candidates=regions.filter(r=>containsText(line,r.text));
    const anchors=candidates.filter(r=>specific(r.text)&&counts.get(r.text)===1);
    for(const anchor of anchors)selected.add(anchor);
    // Short/repeated cells require a specific anchor on the same geometric row. In particular,
    // a BOM quantity must not select drawing balloons or another row merely containing "1".
    for(const candidate of candidates){
      if(selected.has(candidate))continue;
      if(cells.length>1&&!cells.includes(candidate.text))continue;
      if(anchors.some(anchor=>nearby(candidate.region,anchor.region)))selected.add(candidate);
    }
  }
  const matches=[...selected].map(r=>r.region);
  if (!matches.length) return null;
  if (matches.length === 1) return {...matches[0]};
  // Preserve separate boxes when the provider does not supply one comparable coordinate system.
  return { boxes: matches.map(r=>({...r})) };
}
function dimensionParts(value, object, view, unitHint = '') {
  const normalized = normalize(value).replaceAll('−','-');
  const numberPattern = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
  const nominal = normalized.match(new RegExp(`[+\\-]?${numberPattern}`));
  const symmetric = normalized.match(new RegExp(`(?:±|\\+\\s*\\/\\s*-)\\s*(${numberPattern})`));
  const asymmetric = normalized.match(new RegExp(`\\+\\s*(${numberPattern})\\s*(?:\\/\\s*)?-\\s*(${numberPattern})`));
  const unitPattern = /(?:^|[^a-z])(μin|µin|uin|mm|cm|μm|µm|um|in(?:ch(?:es)?)?|m)(?=$|[^a-z])/i;
  const unitMatch = normalized.match(unitPattern);
  const tolerance = symmetric ? {plus:Number(symmetric[1]),minus:-Number(symmetric[1]),raw:symmetric[0]} : asymmetric ? {plus:Number(asymmetric[1]),minus:-Number(asymmetric[2]),raw:asymmetric[0]} : null;
  const unit=unitMatch?.[1]?.toLowerCase() || unitHint;
  const pieces=normalized.split(/\s*(?:[,;，；]|[x×](?=\s*[+\-\d.]))\s*/i);
  const multi=pieces.length>1;
  const measurements=pieces.map(raw=>{
    const n=raw.match(new RegExp(`[+\\-]?${numberPattern}`));
    return n?{value:Number(n[0]),unit:raw.match(unitPattern)?.[1]?.toLowerCase() || unit,raw}:null;
  }).filter(Boolean);
  return {numericValue:nominal && !multi ? Number(nominal[0]) : null,numericValues:measurements.map(m=>m.value),measurements,unit,tolerance,object:object || '待关联',view:view || '待关联'};
}

function splitCells(line, delimiter) {
  const cells = []; let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted) quoted = false;
      else if (!cell.trim()) quoted = true;
      else cell += ch; // An inch mark inside 1/4" is literal, not a quoted CSV field.
    } else if (ch === delimiter && !quoted) { cells.push(normalize(cell)); cell = ''; }
    else cell += ch;
  }
  cells.push(normalize(cell));
  if (delimiter === '|' && line.trimStart().startsWith('|')) {
    if (!cells[0]) cells.shift();
    if (line.trimEnd().endsWith('|') && !cells.at(-1)) cells.pop();
  }
  return cells;
}
const headerNames = {
  item: /^(?:item|item\s*no\.?|序号|项次)$/i,
  partNumber: /^(?:part\s*(?:no\.?|number)|零件号|图号|物料号|料号)$/i,
  name: /^(?:description|name|part\s*name|名称|零件名称|品名)$/i,
  qty: /^(?:qty\.?|quantity|数量|用量)$/i,
  unit: /^(?:unit|单位)$/i,
  material: /^(?:material|材料|材质)$/i
};
function headerOf(line) {
  const delimiter = ['|', '\t', ',', ';'].find(d => line.includes(d));
  if (!delimiter) return null;
  const cells = splitCells(line, delimiter), columns = {};
  cells.forEach((cell, i) => { for (const [name, pattern] of Object.entries(headerNames)) if (pattern.test(cell)) columns[name] = i; });
  return columns.qty !== undefined && (columns.partNumber !== undefined || columns.name !== undefined) ? { delimiter, columns, size: cells.length } : null;
}
const quantityUnit = value => {
  const key=fold(value).replace(/\.$/,'');
  const aliases={inch:'in',inches:'in',foot:'ft',feet:'ft',米:'m',毫米:'mm',厘米:'cm',英寸:'in',英尺:'ft',piece:'pcs',pieces:'pcs',pc:'pcs',units:'unit',ea:'each'};
  return aliases[key] || key;
};
function bomQuantity(raw, separateUnit='') {
  // Quantities such as "162.36 in." are measurements; fractional piece counts are invalid.
  const match=normalize(raw).match(/^((?:\d+(?:\.\d+)?|\.\d+))\s*([A-Za-zμµ\u4e00-\u9fff.]+)?$/);
  if(!match)return null;
  const qty=Number(match[1]), inlineUnit=match[2]||'', unit=normalize(separateUnit)||inlineUnit;
  if(inlineUnit&&separateUnit&&quantityUnit(inlineUnit)!==quantityUnit(separateUnit))return null;
  if(!Number.isFinite(qty)||qty<0||qty>Number.MAX_SAFE_INTEGER)return null;
  const fractionalUnits=new Set(['in','ft','mm','cm','m','μm','µm','um']);
  const countUnits=new Set(['pcs','unit','each','个','件','只','套']);
  if(inlineUnit&&!fractionalUnits.has(quantityUnit(inlineUnit))&&!countUnits.has(quantityUnit(inlineUnit)))return null;
  if(!Number.isInteger(qty)&&!fractionalUnits.has(quantityUnit(unit)))return null;
  return {qty,unit};
}
function stateOf(line) {
  if (/\bCLOSED\b|关门|关闭状态|闭合状态/i.test(line)) return 'CLOSED';
  if (/\bOPEN\b|开门|开启状态|打开状态/i.test(line)) return 'OPEN';
  return '';
}
const removeState = line => line.replace(/^\s*(?:\[|【|\()?\s*(?:OPEN|CLOSED|开门(?:状态)?|关门(?:状态)?|关闭状态|闭合状态|开启状态|打开状态)\s*(?:\]|】|\))?\s*[:：-]?\s*/i, '').trim();

export function parseDocument(pages = [], options = {}) {
  if (!Array.isArray(pages)) throw new TypeError('pages must be an array');
  const rules = compileRules(options), fields = [], bom = [], warnings = [];
  let model = '';
  for (let p = 0; p < pages.length; p++) {
    const pageData=pages[p] || {}, page = Number.isInteger(pageData.page) && pageData.page > 0 ? pageData.page : p+1;
    if(pageData.drawingOCR?.passes?.length){
      const custom=parseDocument([{...pageData,drawingOCR:undefined,page}],{...options,includeDefaults:false});
      const overridden=new Set((options.rules||[]).filter(r=>r&&r.enabled!==false).map(r=>normalize(r.name)));
      const disabled=new Set(options.disabledRules||[]);
      const drawing=options.includeDefaults===false?{fields:[],warnings:[]}:extractDrawingFields({...pageData,page});
      for(const f of [...drawing.fields.filter(f=>!disabled.has(f.name)&&!overridden.has(f.name)),...custom.fields.filter(f=>overridden.has(f.name))])
        fields.push({...f,id:`field-${fields.length+1}`,file:pageData.file||pageData.fileName||options.file||''});
      for(const item of custom.bom)bom.push({...item,id:`bom-${bom.length+1}`});
      warnings.push(...drawing.warnings);
      continue;
    }
    const text = String(pageData.text ?? ''), lines = text.split(/\r?\n/);
    if (!text.trim()) warnings.push(`第 ${page} 页没有可解析文本，需要 OCR 或人工录入。`);
    let table=null, state='', view='', object='';
    const add = (name,value,evidence,category,context={}) => {
      const f={id:`field-${fields.length+1}`,name,value:normalize(value),page,evidence:String(evidence).trim(),status:'pending',model, state:context.state ?? state,category, file:pageData.file || pageData.fileName || options.file || '', region:regionFor(pageData,evidence)};
      if(category==='dimension') Object.assign(f,dimensionParts(value,context.object || object,context.view || view,context.unitHint));
      fields.push(f);
    };
    for (let i=0;i<lines.length;i++) {
      const original=lines[i], line=normalize(original);
      if (!line) {table=null;state='';view='';object='';continue;}
      const header=headerOf(original); if(header){table=header;continue;}
      if(table){
        const cells=splitCells(original,table.delimiter);
        if(cells.every(c=>/^:?-+:?$/.test(c))) continue;
        if(cells.length===table.size){
          const get=name=>cells[table.columns[name]]||'', quantity=bomQuantity(get('qty'),get('unit'));
          if(quantity&&(get('partNumber')||get('name'))){
            bom.push({id:`bom-${bom.length+1}`,item:get('item'),partNumber:get('partNumber'),name:get('name'),qty:quantity.qty,unit:quantity.unit,material:get('material'),page,evidence:original.trim(),status:'pending',model,file:pageData.file||pageData.fileName||options.file||'',region:regionFor(pageData,original)});continue;
          }
          warnings.push(`第 ${page} 页有一行 BOM 无法可靠解析，已跳过：${line.slice(0,90)}`);continue;
        }
        table=null;
      }
      const explicitState=stateOf(line), body=removeState(line);
      if(explicitState&&!body){state=explicitState;continue;}
      const v=viewOf(body); if(v){view=v;continue;}
      const obj=body.match(/^(?:对象|尺寸对象|标注对象|object|dimension object)\s*[:：=]\s*(.+)$/i);
      if(obj){object=normalize(obj[1]);continue;}
      const context={state:explicitState||state};
      let captured=false;
      const bodyIsHeading=isFieldHeading(body,rules);
      for(const rule of rules){
        let match=bodyIsHeading?null:body.match(rule.pattern), evidence=original, value=match?.[1];
        if(!match&&rule.heading.test(body)&&i+1<lines.length){
          const next=normalize(lines[i+1]);
          const nextIsLabel=isFieldHeading(next,rules)||rules.some(r=>r.pattern.test(next));
          if(next&&!nextIsLabel&&!stateOf(next)&&!viewOf(next)&&!headerOf(lines[i+1])&&!/^(?:对象|object)\s*[:：]/i.test(next)){
            value=next;evidence=original+'\n'+lines[++i];
          }
        }
        if(!value?.trim())continue;
        // PDF text rows can contain unrelated neighboring table columns. Keep the first value cell, retaining the complete evidence.
        value=String(value).split('|').map(normalize).find(Boolean)||'';
        if(!value)continue;
        // Generic labels must not swallow section headings such as Material Info or FINISH NOTES.
        if(/^(?:info(?:rmation)?|notes?|date)\s*[:：]?$/i.test(value))continue;
        if(rule.name==='材料' && /^(?:info(?:rmation)?\b|no\.?\b|number\b|[-–])/i.test(value))continue;
        if(rule.name==='表面处理' && /^min(?:imum)?\s*[:：]/i.test(value))continue;
        if(rule.category==='dimension' && !/[\d]/.test(value))continue;
        if(/^回路数/.test(rule.name) && !/^\d+$/.test(value))continue;
        if(rule.name==='版本') {
          const revision=value.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,15})(?:\s|$)/);
          if(!revision)continue;
          value=revision[1];
        }
        // A naked adjacent heading must never become this field's value.
        if(isFieldHeading(value,rules))continue;
        if(['产品型号','图号','零件号','新零件号'].includes(rule.name)){model=normalize(value);state='';view='';object='';context.state='';}
        add(rule.name,value,evidence,rule.category,{...context,object:rule.object,unitHint:rule.unitHint});captured=true;break;
      }
      if(captured)continue;
      const count=body.match(/^(\d+)\s+Circuits?\b/i);
      if(count){add('回路数',count[1],original,'structure',context);continue;}
      if(/\b(?:FIRST|THIRD)[ -]ANGLE(?:\s+PROJECTION)?\b|第一角(?:投影)?|第三角(?:投影)?/i.test(line)){
        add('投影法',/\bFIRST[ -]ANGLE\b|第一角/i.test(line)?'第一角投影':'第三角投影',original,'standard',context);continue;
      }
      const rough=line.match(/\bRa\s*\d+(?:\.\d+)?\s*(?:μm|µm|um)?/i);
      const dim=line.match(/[Ø⌀Φφ]\s*\d+(?:\.\d+)?(?:\s*(?:±\s*\d+(?:\.\d+)?|\+\s*\d+(?:\.\d+)?\s*\/?\s*-\s*\d+(?:\.\d+)?))?(?:\s*(?:mm|cm|in))?/);
      const iso=line.match(/\b(?:ISO\s*2768(?:[- ]?[a-z]+)?|ASME\s*Y14\.5(?:[- ]\d{4})?|DIN\s*\d+|GB\/?T\s*\d+(?:\.\d+)?)\b/i);
      for(const [name,match,category]of[['粗糙度',rough,'process'],['尺寸标注',dim,'dimension'],['公差标准',iso,'standard']])if(match)add(name,match[0],original,category,context);
    }
  }
  if(!fields.length)warnings.push('未识别到支持的工程字段；请检查文字层和参数标签。');
  if(!bom.length)warnings.push('未找到带有“名称/料号”和“数量”列的分隔表格，BOM 需要人工补录或复核。');
  warnings.push('所有提取项均为待复核。图形、引线关联、形位公差和复杂表格未做视觉语义识别。');
  return {fields,bom,warnings};
}

/** Recompute editable dimensions without retaining stale OCR candidates or limits. */
export function editDimension(field, value) {
  const parsed=extractDrawingFields({page:field.page||1,text:String(value)}).fields.find(f=>f.category==='dimension');
  const parts=parsed||dimensionParts(value,field.object,field.view);
  return {numericValue:parts.numericValue??null,numericValues:parts.numericValues||[],measurements:parts.measurements||[],unit:parts.unit||'',tolerance:parts.tolerance||null,limit:parts.limit||null,alternateMeasurements:parts.alternateMeasurements||[],otherCandidates:[],ocrConflict:false,dualUnitValidation:parts.dualUnitValidation||null,unresolvedAnnotations:parts.unresolvedAnnotations||[],unitEvidence:'',unitSource:null,sourcePasses:[],ocrConfidence:null,supportingEvidence:[],selectionReason:'人工修订',toleranceStatus:parts.toleranceStatus||'',method:'manual'};
}

function words(value) { return fold(value).match(/[a-z0-9]+(?:[-_][a-z0-9]+)*|[\u4e00-\u9fff]+/g) || []; }
const documentText = doc => [doc.name, ...(doc.pages || []).map(p => p.text), ...(doc.fields || []).flatMap(f => [f.name, f.value, f.model, f.state])].join(' ');
function visualSimilarity(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[01]{64}$/.test(a) || !/^[01]{64}$/.test(b)) return null;
  return 1 - [...a].filter((bit, i) => bit !== b[i]).length / 64;
}
const listOf = value => value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
const pageFields = (doc,page) => (doc?.fields || []).filter(f=>f.status!=='rejected' && (f.page==null || Number(f.page)===Number(page)));
function structureSignature(fields) {
  return new Set(fields.filter(f=>['structure','mounting','material','process','standard','dimension'].includes(f.category) || /结构|安装|材料|公差|粗糙度|尺寸|间距/.test(f.name)).map(f=>`${fold(f.name)}=${fold(f.value)}`));
}
function structureSimilarity(a,b) {
  if(!a.size || !b.size)return null;
  const intersection=[...a].filter(v=>b.has(v)).length;
  return intersection/(new Set([...a,...b]).size);
}
function inScope(doc,page,fields,scope) {
  const fileIds=listOf(scope?.fileIds);
  if(fileIds.length&&!fileIds.includes(doc.id))return false;
  const types=listOf(scope?.pageType).map(fold);
  if(types.length&&!types.includes(fold(page.pageType||page.type||doc.pageType||doc.type)))return false;
  const categories=listOf(scope?.category).map(fold);
  if(categories.length&&!categories.some(c=>[doc.category,page.category,...fields.map(f=>f.category)].some(v=>fold(v)===c)))return false;
  return true;
}
export function searchDocuments(docs = [], query = '', referenceDoc = null, visualWeight = 0.5, options = {}) {
  const weight=Math.max(0,Math.min(1,Number(visualWeight)||0));
  const requested=options.weights || {text:1-weight,visual:weight,structure:0};
  const weights=Object.fromEntries(['text','visual','structure'].map(k=>[k,Number.isFinite(Number(requested[k])) ? Math.max(0,Number(requested[k])) : 0]));
  const results=[];
  for(const doc of docs){
    if(options.excludeIdentical&&referenceDoc?.contentId&&doc.contentId===referenceDoc.contentId)continue;
    if(options.excludeQuery!==false&&referenceDoc&&doc.id&&doc.id===referenceDoc.id)continue;
    const matches=[];
    for(const page of (doc.pages?.length?doc.pages:[{page:1,text:'',hash:doc.hash}])){
      const fields=pageFields(doc,page.page);
      if(!inScope(doc,page,fields,options.scope))continue;
      const contents=new Set(words([doc.name,page.text,...fields.flatMap(f=>[f.name,f.value,f.model,f.state])].join(' ')));
      const signature=structureSignature(fields);
      const refs=referenceDoc?.pages?.length?referenceDoc.pages:referenceDoc?[{page:1,text:'',hash:referenceDoc.hash}]:[null];
      let best=null;
      for(const rp of refs){
        const terms=[...new Set(words([query,options.includeReferenceText===false?'':rp?.text||''].join(' ')))];
        const matchedTerms=terms.filter(term=>contents.has(term)||(/^[\u4e00-\u9fff]+$/.test(term)&&[...contents].some(w=>w.includes(term))));
        const textScore=terms.length?matchedTerms.length/terms.length:0;
        const visualScore=referenceDoc?visualSimilarity(page.hash||doc.hash,rp?.hash||referenceDoc.hash):null;
        const referenceFields=referenceDoc?pageFields(referenceDoc,rp?.page||1):[];
        const structureScore=referenceDoc?structureSimilarity(signature,structureSignature(referenceFields)):null;
        if(!textScore&&visualScore===null&&structureScore===null)continue;
        const channels=[['text',terms.length?textScore:null],['visual',visualScore],['structure',structureScore]].filter(([,v])=>v!==null);
        const denominator=channels.reduce((n,[k])=>n+weights[k],0);
        // Never resurrect a channel explicitly disabled by the user when the selected channels are missing.
        if(!denominator)continue;
        const score=channels.reduce((n,[k,v])=>n+weights[k]*v,0)/denominator;
        const evidence=String(page.text||'').split(/\r?\n/).filter(line=>matchedTerms.some(t=>words(line).includes(t))).slice(0,4);
        const differences=referenceDoc?compareDocuments({fields:referenceFields},{fields}).fields:[];
        const result={score,textScore,visualScore,structureScore,matchedTerms,page:page.page,queryPage:rp?.page||null,evidence,differences,pageType:page.pageType||page.type||doc.pageType||doc.type||'',category:page.category||doc.category||''};
        if(!best||score>best.score)best=result;
      }
      if(best)matches.push(best);
    }
    matches.sort((a,b)=>b.score-a.score||a.page-b.page);
    if(matches.length)results.push({doc,...matches[0],pageMatches:matches.slice(0,Math.max(1,Math.min(20,Number(options.maxPageMatches)||5)))});
  }
  return results.sort((a,b)=>b.score-a.score||String(a.doc.name).localeCompare(String(b.doc.name)));
}

function collect(items, key, value) {
  const map = new Map();
  for (const item of items || []) {
    if (item.status === 'rejected') continue;
    const k = key(item); const prior = map.get(k) || [];
    prior.push(value(item)); map.set(k, prior);
  }
  return map;
}
function diffMaps(a, b, keyName) {
  return [...new Set([...a.keys(), ...b.keys()])].flatMap(key => {
    const before = a.get(key) || [], after = b.get(key) || [];
    // Reordering duplicate labels or BOM rows is not an engineering change. Preserve multiplicity.
    const comparable=items=>items.map(item=>JSON.stringify(item)).sort();
    if (JSON.stringify(comparable(before)) === JSON.stringify(comparable(after))) return [];
    return [{ [keyName]: key, before, after, kind: !before.length ? 'added' : !after.length ? 'removed' : 'changed' }];
  });
}
export function compareDocuments(a = {}, b = {}) {
  const associated=v=>normalize(v) && normalize(v)!=='待关联' ? normalize(v) : '';
  const fieldKey = f => [f.model, f.state, f.name, associated(f.object)?`对象:${associated(f.object)}`:'',associated(f.view)?`视图:${associated(f.view)}`:''].filter(Boolean).join(' · ');
  const fieldValue = f => ({ value: f.value, page: f.page, evidence: f.evidence,object:f.object,view:f.view });
  // Compare values; evidence movement alone is not an engineering change.
  const af = collect(a.fields, fieldKey, f => f.value), bf = collect(b.fields, fieldKey, f => f.value);
  const fields = diffMaps(af, bf, 'name').map(d => ({...d, beforeEvidence: (a.fields || []).filter(f => f.status!=='rejected' && fieldKey(f) === d.name).map(fieldValue), afterEvidence: (b.fields || []).filter(f => f.status!=='rejected' && fieldKey(f) === d.name).map(fieldValue)}));
  const bomKey = row => row.partNumber || row.name;
  const bomValue = row => ({ name: row.name, qty: row.qty, unit: row.unit, material: row.material });
  const bom = diffMaps(collect(a.bom, bomKey, bomValue), collect(b.bom, bomKey, bomValue), 'key');
  return { fields, bom, summary: { fieldChanges: fields.length, bomChanges: bom.length, total: fields.length + bom.length } };
}

export function buildInstructions(doc = {}) {
  const fields = (doc.fields || []).filter(f => f.status !== 'rejected');
  const bom = (doc.bom || []).filter(row => row.status !== 'rejected');
  const out = [`# ${normalize(doc.name) || '图纸'} — 作业核对草稿`, '', '状态：待工程师审核。以下内容仅整理图纸要求，不构成已批准的制造工艺或安全操作规程。', '', '## 图纸要求核对'];
  if (!fields.length) out.push('暂无可引用要求。请补录并核实图纸信息。');
  for (const f of fields) out.push(`- [ ] ${[f.model, f.state, f.name].filter(Boolean).join(' / ')}：${f.value}（第 ${f.page} 页；${f.status === 'approved' ? '已复核' : '待复核'}）\n  原文：${normalize(f.evidence)}`);
  out.push('', '## 物料核对');
  if (!bom.length) out.push('未解析到 BOM。');
  for (const row of bom) out.push(`- [ ] ${row.partNumber || ''} ${row.name || ''}：${row.qty} ${row.unit || ''}（第 ${row.page} 页）`);
  out.push('', '## 工艺负责人补充', '- 工序顺序：待填写', '- 设备、工装和检测方法：待填写', '- 作业风险与防护：待填写', '- 编制 / 审核 / 日期：待填写');
  return out.join('\n');
}

function number(value, name, fallback, maximum = Infinity) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()))) throw new TypeError(`${name} 必须是非负数`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > maximum) throw new RangeError(`${name} 超出有效范围`);
  return n;
}
const money = n => Math.round((n + Number.EPSILON) * 100) / 100;
export function calculateQuote(rows = [], options = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows 必须是数组');
  const material = money(rows.reduce((sum, row) => {
    const qty = number(row.qty, '数量');
    if (qty>Number.MAX_SAFE_INTEGER) throw new RangeError('数量过大');
    const value = sum + qty * number(row.unitPrice, '单价');
    if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER / 100) throw new RangeError('金额过大');
    return value;
  }, 0));
  const labor = money(number(options.labor, '人工费', 0));
  const overheadPercent = number(options.overheadPercent, '间接费用率', 0, 100);
  const marginPercent = number(options.marginPercent, '毛利率', 0, 100);
  if (marginPercent >= 100) throw new RangeError('毛利率必须小于 100%');
  const taxPercent = number(options.taxPercent, '税率', 0, 100);
  const overhead = money((material + labor) * overheadPercent / 100);
  const cost = money(material + labor + overhead);
  const subtotal = money(cost / (1 - marginPercent / 100));
  const profit = money(subtotal - cost), tax = money(subtotal * taxPercent / 100), total = money(subtotal + tax);
  if (![labor, overhead, cost, subtotal, profit, tax, total].every(n => Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER / 100)) throw new RangeError('金额过大');
  return { material, labor, overhead, cost, profit, subtotal, tax, total, currency: 'CNY' };
}
