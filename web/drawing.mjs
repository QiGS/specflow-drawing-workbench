/** Evidence-bound engineering-drawing OCR candidates. No document-specific answer tables. */
const clean = v => String(v ?? '').normalize('NFKC').replace(/[−–—]/g,'-').replace(/\s+/g,' ').trim();
const num=String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const unitPattern=String.raw`(?:mm|cm|in(?:ch(?:es)?)?|μm|µm|um)`;
const normalizeUnit = u => /^in/i.test(u||'')?'in':String(u||'').toLowerCase();
const rect = r => r && [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width>0 && r.height>0;
const overlapX=(a,b)=>Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x));
const centerX=r=>r.x+r.width/2;
function regionOf(lines) {
  const boxes=lines.flatMap(l=>l.regions||[]).filter(rect);
  if(!boxes.length)return null;
  const unique=boxes.filter((r,i)=>boxes.findIndex(b=>b.x===r.x&&b.y===r.y&&b.width===r.width&&b.height===r.height&&b.text===r.text)===i);
  return unique.length===1?{...unique[0]}:{boxes:unique.map(r=>({...r}))};
}
function wordLines(words){
  const usable=(words||[]).filter(r=>rect(r)&&clean(r.text)&&!/^[-_=~|¦]+$/.test(clean(r.text)));
  if(!usable.length)return [];
  const heights=usable.map(w=>w.height).sort((a,b)=>a-b),median=heights[Math.floor(heights.length/2)];
  const rows=[];
  for(const w of usable.filter(w=>!((w.sourceConfidence??100)<20&&w.height>median*3)).sort((a,b)=>(a.y+a.height/2)-(b.y+b.height/2)||a.x-b.x)){
    const row=rows.find(r=>Math.abs((r[0].y+r[0].height/2)-(w.y+w.height/2))<Math.min(r[0].height,w.height)*.45&&Math.max(r[0].height,w.height)/Math.min(r[0].height,w.height)<1.65);
    if(row)row.push(w);else rows.push([w]);
  }
  const result=[];
  for(const row of rows){
    row.sort((a,b)=>a.x-b.x);const chunks=[];
    for(const w of row){const chunk=chunks.at(-1),last=chunk?.at(-1);if(last&&w.x-(last.x+last.width)<=Math.min(w.height,last.height)*2.8)chunk.push(w);else chunks.push([w]);}
    for(const chunk of chunks){
      const x=Math.min(...chunk.map(w=>w.x)),y=Math.min(...chunk.map(w=>w.y));
      result.push({text:clean(chunk.map(w=>w.text).join(' ')).replace(/(?<=\d)\s*\.\s*(?=\d)/g,'.'),regions:chunk,x,y,width:Math.max(...chunk.map(w=>w.x+w.width))-x,height:Math.max(...chunk.map(w=>w.y+w.height))-y});
    }
  }
  return result;
}
function linesOf(page) {
  // Provider lines are preferable to page-wide text matching: identical numbers elsewhere are unrelated.
  const providers=(page.drawingOCR?.regions||page.regions||[]).filter(r=>rect(r)&&clean(r.text||r.str));
  const wordSources=wordLines(page.words);
  const sources=wordSources.length?wordSources:providers.length ? providers.map(r=>({text:clean(r.text||r.str),regions:[r],x:r.x,y:r.y,width:r.width,height:r.height})) :
    String(page.drawingOCR?.text??page.text??'').split(/\r?\n/).map((text,i)=>({text:clean(text),regions:[],order:i})).filter(l=>l.text);
  sources.sort((a,b)=>(a.y??a.order)-(b.y??b.order)||(a.x??0)-(b.x??0));
  const consumed=new Set(),assembled=[];
  // Sparse-text OCR sometimes emits each word as its own line. Join only short gaps on
  // the same baseline, and only for recognized callout/note starts; never join table rows.
  const start=/^(?:\d+(?:\.\d+)?|\.\d+|STAMP\b.*|WIRE|(?:TONGUE\s+)?MATERIAL\s+THK\.?\s*:?(?:\s.*)?|YELLOW|RED|BLUE|BLACK|WHITE)$/i;
  for(const line of sources){
    if(consumed.has(line))continue;
    if(!rect(line)||!start.test(line.text)||(line.regions[0]?.sourceConfidence??100)===0){assembled.push(line);continue;}
    const parts=[line];let last=line;
    for(let step=0;step<4;step++){
      const next=sources.filter(l=>!consumed.has(l)&&!parts.includes(l)&&rect(l)&&l.x>=last.x+last.width-.001&&l.x-(last.x+last.width)<Math.min(line.height,l.height)*2.8&&Math.abs((line.y+line.height/2)-(l.y+l.height/2))<Math.min(line.height,l.height)*.9&&Math.max(line.height,l.height)/Math.min(line.height,l.height)<1.9).sort((a,b)=>a.x-b.x)[0];
      if(!next)break;parts.push(next);last=next;
    }
    const text=parts.map(p=>p.text).join(' ');
    const allowed=parts.length>1&&(!new RegExp(`^${num}$`).test(line.text)||/\b(?:MIN|MAX|DIA(?:METER)?)\b/i.test(text));
    if(allowed){
      const x=Math.min(...parts.map(p=>p.x)),y=Math.min(...parts.map(p=>p.y));
      assembled.push({text,regions:parts.flatMap(p=>p.regions),x,y,width:Math.max(...parts.map(p=>p.x+p.width))-x,height:Math.max(...parts.map(p=>p.y+p.height))-y});
      parts.slice(1).forEach(p=>consumed.add(p));
    }else assembled.push(line);
  }
  return assembled;
}
function follows(a,b,distance=3.5) {
  if(!rect(a)||!rect(b))return true;
  return b.y>=a.y+a.height*.2 && b.y-(a.y+a.height)<=Math.max(a.height,b.height)*distance &&
    (overlapX(a,b)>=Math.min(a.width,b.width)*.1 || Math.abs(centerX(a)-centerX(b))<Math.max(a.height,b.height)*4 || Math.abs(a.x-b.x)<Math.max(a.height,b.height)*2.5);
}
function neighbors(lines,line,count=3) {
  const index=lines.indexOf(line);
  if(!rect(line))return lines.slice(index+1,index+1+count);
  return lines.filter(other=>other!==line&&follows(line,other)).sort((a,b)=>a.y-b.y||Math.abs(centerX(a)-centerX(line))-Math.abs(centerX(b)-centerX(line))).slice(0,count);
}
function nearbyAlternate(a,b){
  if(!rect(a)||!rect(b))return true;
  const ratio=a.height/b.height;
  return ratio>=.5&&ratio<=2&&b.y>=a.y+a.height*.4&&b.y-(a.y+a.height)<=Math.min(a.height,b.height)*2&&Math.abs(centerX(a)-centerX(b))<=Math.max(a.width,b.width)*.65&&overlapX(a,b)>0;
}
function unitsOf(text) {
  const t=clean(text);
  if(/DIMENSIONS?\s+(?:ARE\s+)?IN\s+(?:mm|MILLIMET(?:ER|RE)S?)\s*\[\s*INCH(?:ES)?\s*\]/i.test(t))return {primary:'mm',alternate:'in',evidence:t.match(/DIMENSIONS?\s+(?:ARE\s+)?IN\s+(?:mm|MILLIMET(?:ER|RE)S?)\s*\[\s*INCH(?:ES)?\s*\]/i)[0]};
  if(/DIMENSIONS?\s+(?:ARE\s+)?IN\s+(?:INCH(?:ES)?|IN\b)/i.test(t))return {primary:'in',alternate:'',evidence:'图纸尺寸单位声明'};
  if(/DIMENSIONS?\s+(?:ARE\s+)?IN\s+(?:mm|MILLIMET(?:ER|RE)S?)/i.test(t))return {primary:'mm',alternate:'',evidence:'图纸尺寸单位声明'};
  if(/尺寸单位\s*[:：]?\s*(?:mm|毫米)/i.test(t))return {primary:'mm',alternate:'',evidence:'图纸尺寸单位声明'};
  return {primary:'',alternate:'',evidence:''};
}
function measurement(raw,defaultUnit='') {
  const text=clean(raw).replace(/^[|¦~<>_=]+\s*|\s*[|¦~<>_=»←→]+$/g,'').replace(/((?:MIN|MAX))[-~—=<>»←→]+$/i,'$1').replace(/\s*\[.*$/,'');
  const match=text.match(new RegExp(`^(?:(?:DIA(?:METER)?\\.?|[Ø⌀Φφ])\\s*)?(${num})(?:\\s*(±|\\+\\s*\\/\\s*-)\\s*(${num})|\\s*\\+\\s*(${num})\\s*\\/?\\s*-\\s*(${num}))?\\s*(${unitPattern})?\\s*(MIN(?:IMUM)?|MAX(?:IMUM)?)?\\s*(DIA(?:METER)?\\.?)?$`,'i'));
  if(!match)return null;
  const tolerance=match[2]?{plus:Number(match[3]),minus:-Number(match[3]),raw:`${match[2]}${match[3]}`} :match[4]?{plus:Number(match[4]),minus:-Number(match[5]),raw:`+${match[4]}/-${match[5]}`} :null;
  return {numericValue:Number(match[1]),unit:normalizeUnit(match[6])||defaultUnit,tolerance,limit:match[7]?/^MIN/i.test(match[7])?'min':'max':null,diameter:/\bDIA|[Ø⌀Φφ]/i.test(text),raw:clean(raw)};
}
const alternateText = text => {
  const t=clean(text);if(!t.startsWith('[')&&!t.endsWith(']'))return null;
  if(!t.startsWith('[')&&t.includes('['))return null;
  const content=t.replace(/^\[\s*/,'').replace(/\s*\]$/,'');
  return measurement(content)?content:null;
};
function compactValue(m, alternate) {
  const tolerance=m.tolerance?` ${m.tolerance.raw}`:'';
  return `${m.numericValue}${tolerance}${m.unit?' '+m.unit:''}${m.limit?' '+m.limit.toUpperCase():''}${m.diameter?' DIA':''}${alternate?` [${alternate.numericValue}${alternate.tolerance?' '+alternate.tolerance.raw:''}${alternate.unit?' '+alternate.unit:''}]`:''}`;
}

/** Parse one OCR pass. Independent passes must not be concatenated into synthetic callouts. */
function extractPass(pageData={}, sharedUnits) {
  const page=Number.isInteger(pageData.page)?pageData.page:1,lines=linesOf(pageData),whole=lines.map(l=>l.text).join('\n'),localUnits=unitsOf(whole),localUnitLine=lines.find(l=>unitsOf(l.text).primary),units=localUnits.primary?{...localUnits,source:localUnitLine?{page,evidence:localUnitLine.text,region:regionOf([localUnitLine])}:sharedUnits?.source}:(sharedUnits||localUnits),fields=[],warnings=[],used=new Set();
  const add=(name,value,category,source,extra={})=>{
    const evidence=source.map(l=>l.text).join('\n');
    if(!value||!evidence)return;
    const region=regionOf(source);
    if(fields.some(f=>f.name===name&&f.value===value&&JSON.stringify(f.region)===JSON.stringify(region)))return;
    fields.push({id:`drawing-${page}-${fields.length+1}`,name,value:clean(value),category,page,evidence,status:'pending',method:'drawing-ocr-rules',region,model:'',state:'',...extra});
  };
  const addDimension=(line,raw,name='尺寸标注',object='待关联',defaultUnit=units.primary)=>{
    const inline=raw.match(/\[\s*([^\]]+)\s*\]/);let m=measurement(raw,defaultUnit),unresolved=[];
    if(!m){
      const partial=clean(raw).match(new RegExp(`^(${num})\\s+(.+?)\\s+(DIA(?:METER)?|MIN|MAX)$`,'i'));
      if(partial&&/[+±£%]/.test(partial[2])){m=measurement(`${partial[1]} ${partial[3]}`,defaultUnit);unresolved=[partial[2]];}
      if(!m&&name!=='尺寸标注'){
        const namedPartial=clean(raw).match(new RegExp(`^(${num})\\s*([+±%£-].+)$`));
        if(namedPartial){m=measurement(namedPartial[1],defaultUnit);unresolved=[namedPartial[2]];}
      }
    }
    if(!m)return false;
    // Stacked signed upper/lower deviations need coordinate evidence beside the nominal.
    const stacked=[];
    if(!m.tolerance&&rect(line)){
      const right=line.x+line.width,h=line.height;
      const signs=lines.filter(l=>rect(l)&&/^[+-]\s*(?:\d+(?:\.\d+)?|\.\d+)$/.test(l.text)&&l.x>=right-h&&l.x<=right+3*h&&Math.abs(l.y-line.y)<=2*h);
      const upper=signs.find(l=>l.text.startsWith('+'));
      const lower=upper&&signs.find(l=>l.text.startsWith('-')&&l.y>upper.y&&Math.abs(centerX(l)-centerX(upper))<2*h);
      if(upper&&lower){m.tolerance={plus:Number(upper.text.replace(/\s/g,'')),minus:Number(lower.text.replace(/\s/g,'')),raw:`${upper.text}/${lower.text}`};stacked.push(upper,lower);}
    }
    let other,altRaw=inline?.[1];
    if(!altRaw){other=neighbors(lines,line,8).find(l=>alternateText(l.text)!==null&&nearbyAlternate(line,l));if(other)altRaw=alternateText(other.text);}
    const alternate=altRaw?measurement(altRaw,units.alternate):null;
    // An isolated integer/decimal is not a dimension without engineering notation, a unit, or a paired secondary unit.
    if(!m.diameter&&!m.limit&&!m.tolerance&&!alternate&&!new RegExp(`\\b${unitPattern}\\b`,'i').test(raw)&&name==='尺寸标注')return false;
    // Brackets alone are weak evidence (drawing-zone cells also contain numbers).
    // Reject an otherwise unmarked pair when its explicit dual units are grossly incompatible.
    const unmarked=!m.diameter&&!m.limit&&!m.tolerance&&!new RegExp(`\\b${unitPattern}\\b`,'i').test(raw)&&name==='尺寸标注';
    if(unmarked&&alternate){
      if(m.unit==='mm'&&alternate.unit==='in'&&Math.abs(m.numericValue-alternate.numericValue*25.4)>Math.max(m.numericValue,alternate.numericValue*25.4)*.1)return false;
      if(!m.unit&&!alternate.unit&&Number.isInteger(m.numericValue)&&Number.isInteger(alternate.numericValue))return false;
    }
    const sources=[line,...stacked,...(other&&alternate?[other]:[])];
    add(m.diameter&&name==='尺寸标注'?'直径标注':name,compactValue(m,alternate)+(unresolved.length?` （标注待复核：${unresolved.join(' ')}）`:''),'dimension',sources,{numericValue:m.numericValue,numericValues:[m.numericValue],measurements:[{value:m.numericValue,unit:m.unit,raw:m.raw}],unit:m.unit,tolerance:m.tolerance,limit:m.limit,object,view:'待关联',alternateMeasurements:alternate?[{value:alternate.numericValue,unit:alternate.unit,tolerance:alternate.tolerance,raw:altRaw}]:[],unitEvidence:m.unit===units.primary?units.evidence:'',unitSource:m.unit===units.primary?units.source:undefined,...(unresolved.length?{unresolvedAnnotations:unresolved,toleranceStatus:'待复核'}:{})});
    for(const source of sources.slice(1))used.add(source);return true;
  };
  // Explicit document declarations remain separate from dimension values.
  for(const line of lines){
    if(/\b(?:FIRST|THIRD)[ -]ANGLE(?:\s+PROJECTION)?\b|第一角(?:投影)?|第三角(?:投影)?/i.test(line.text))add('投影法',/\bFIRST[ -]ANGLE\b|第一角/i.test(line.text)?'第一角投影':'第三角投影','standard',[line]);
    const declared=unitsOf(line.text);
    if(declared.primary)add('尺寸单位',`${declared.primary}${declared.alternate?` [${declared.alternate}]`:''}`,'standard',[line]);
  }
  // Titles and material headers must be explicit and geometrically above their value.
  const headings=[['图号',/^(?:DRAWING\s*(?:NO\.?|NUMBER)|DWG\.?\s*NO\.?|图号)\s*[:：]?$/i,'identity'],['名称',/^(?:NAME|PART\s+NAME|TITLE|名称|零件名称)\s*[:：]?$/i,'identity'],['材料',/^(?:MATERIAL|材料|材质)\s*[:：]?$/i,'material'],['表面处理',/^(?:FINISH|SURFACE\s+FINISH|表面处理)\s*[:：]?$/i,'process'],['版本',/^(?:REV\.?|REVISION|版本)\s*[:：]?$/i,'identity']];
  const looksHeading=t=>headings.some(h=>h[1].test(t))||/^(?:SIZE|SCALE|SHEET|REV(?:ISION)?|CAGE CODE|DRAWN|CHECKED|QUANTITY|PACKAGE TYPE|PART NO|PRODUCT SPEC|APPLICATION SPEC)\b/i.test(t);
  for(const line of lines)for(const [name,pattern,category]of headings)if(pattern.test(line.text)){
    const candidates=neighbors(lines,line,3).filter(l=>!looksHeading(l.text)&&(name==='版本'||!/^[-\d.\s]+$/.test(l.text))&&!/^(?:DRAWN|CHK|AP[P]?D)\b/i.test(l.text));
    let next=candidates[0];if(!next)continue;
    if(name==='图号'&&next.regions?.length>1&&rect(line)){
      const ownColumn=next.regions.filter(r=>centerX(r)>=line.x-line.height*1.5);
      if(ownColumn.length){const x=Math.min(...ownColumn.map(r=>r.x)),y=Math.min(...ownColumn.map(r=>r.y));next={...next,text:ownColumn.map(r=>r.text).join(' ').replace(/\s*=\s*/g,'='),regions:ownColumn,x,y,width:Math.max(...ownColumn.map(r=>r.x+r.width))-x,height:Math.max(...ownColumn.map(r=>r.y+r.height))-y};}
    }
    const identityValue=next.text.replace(/^[|¦]\s*|\s*[|¦]$/g,'');
    if(name==='图号'&&!/^[A-Z0-9][A-Z0-9 .=_/-]{2,35}$/i.test(identityValue))continue;
    if(name==='名称'&&next.text.replace(/[^\p{L}\p{N}]/gu,'').length<3)continue;
    if(name==='版本'&&(!/^[A-Z0-9][A-Z0-9.-]{0,3}$/.test(next.text)||!follows(line,next,1.8)))continue;
    const source=[line,next];
    // A second explicit material line is allowed; unrelated neighboring title cells are not.
    if(name==='材料'){
      const extra=neighbors(lines,next,2).find(l=>/^(?:PVC|PTFE|PBT|PA\d*|NYLON|COPPER|BRASS|STEEL|ALUMINUM|ALUMINIUM|SUS\d+)\b/i.test(l.text)&&follows(next,l,1.5));
      if(extra)source.push(extra);
    }
    const values=source.slice(1).map(l=>name==='材料'?l.text.split(/\s+[|\[]/)[0]:name==='图号'?l.text.replace(/^[|¦]\s*|\s*[|¦]$/g,''):l.text);
    add(name,values.join(' / '),category,source);source.forEach(l=>used.add(l));
  }
  // Explicit inline labels are also common when OCR retains the complete title-block cell.
  for(const line of lines){
    const matches=[
      ['图号',line.text.match(/^(?:DRAWING\s*(?:NO\.?|NUMBER)|DWG\.?\s*NO\.?|图号)\s*[:：]?\s+([A-Z0-9][A-Z0-9._/-]{2,35})$/i),'identity'],
      ['名称',line.text.match(/^(?:NAME|PART\s+NAME|TITLE|名称|零件名称)\s*[:：]?\s+(.+)$/i),'identity'],
      ['材料',line.text.match(/^(?:MATERIAL|材料|材质)\s*[:：]?\s+(?!THK\b|THICKNESS\b)(.+)$/i),'material'],
      ['版本',line.text.match(/^(?:REV(?:ISION)?\.?|版本)\s*[:：]?\s+([A-Z0-9.-]{1,4})$/i),'identity']
    ];
    for(const [name,match,category]of matches)if(match){add(name,match[1],category,[line]);used.add(line);}
  }
  for(const line of lines){
    if(used.has(line))continue;
    const text=line.text;
    if(alternateText(text)!==null)continue;
    // Only explicit named thickness is assigned to a component; drawing positions do not establish object identity.
    const thickness=text.match(/(?:TONGUE\s+)?MATERIAL\s+THK\.?\s*[:：]?\s*(.+)$/i);
    if(thickness&&addDimension(line,thickness[1],/TONGUE/i.test(text)?'舌片厚度':'材料厚度',/TONGUE/i.test(text)?'舌片':'材料'))continue;
    if(addDimension(line,text))continue;
    const bare=text.replace(/^\s*(?:[△▲Δ]?\s*\d+[.)]?|[△▲Δ])\s+(?=[A-Z])/i,'');
    if(/^(?:STAMP\b|WIRE\s+INSULATION\s+DIA\b|TIN\s+PLATE\b|GOLD\s+FLASH\b|NICKEL\s+PLATE\b|(?:YELLOW|RED|BLUE|BLACK|WHITE)\s+INSULATION\b|DO\s+NOT\s+SCALE\b)/i.test(bare)){
      const source=[line];let value=bare;
      if(/\bOVER\s*$/i.test(value)){
        const next=neighbors(lines,line,2).find(l=>/^NICKEL\s+PLATE\b/i.test(l.text));
        if(next){source.push(next);value+=' '+next.text;used.add(next);}
      }
      add(/\bPLATE|\bFLASH/i.test(value)?'表面处理要求':'技术要求',value,/\bPLATE|\bFLASH/i.test(value)?'process':'requirement',source);
    } else if(bare!==text && /\b(?:SHALL|MUST|REMOVE|DEBURR|CHAMFER|TREAT|CLEAN|COAT|PAINT|MATERIAL|WELD|HEAT|TOLERANCE)\b/i.test(bare)){
      add('技术要求',bare,'requirement',[line]);
    }
    if(/^(?:INSULATION|SERRATIONS|BODY)$/i.test(text))add('结构标注',text,'structure',[line]);
    if(/\b(?:ASTM\s+[A-Z]\s*-?\s*\d+|MIL-[A-Z]-\d+|QQ-[A-Z]-\d+)\b/i.test(text)){
      for(const m of text.matchAll(/\b(?:ASTM\s+[A-Z]\s*-?\s*\d+|MIL-[A-Z]-\d+|QQ-[A-Z]-\d+)\b/gi))add('技术标准',m[0],'standard',[line]);
    }
    if(/^\d\s+(?:PLC|PL[AC])\s+DEC\b/i.test(text))add('未注公差说明',text,'standard',[line]);
  }
  // Preserve explicit maximum temperature, including a separate header/value pair.
  for(const line of lines)if(/(?:MAX(?:IMUM)?\s+RECOMMENDED\s+)?OPERATING\s+TEMPERATURE\b/i.test(line.text)){
    const own=line.text.match(/([+-]?\d+(?:\.\d+)?)\s*°?\s*([CF])\s*(MAX)?\b/i);
    const next=own?line:neighbors(lines,line,3).find(l=>/^[+-]?\d+(?:\.\d+)?\s*°?\s*[CF]\s*(?:MAX)?$/i.test(l.text));
    if(next)add('工作温度',own?own[0]:next.text,'performance',own?[line]:[line,next]);
  }
  if(/\bPACKAGE\s+TYPE\b/i.test(whole)&&/\b(?:ON\s+TAPE|LOOSE\s+P(?:C|IECE)|REEL)\b/i.test(whole))warnings.push('识别到包装规格表；包装数量和产品变体不作为装配 BOM 用量。');
  if(fields.some(f=>f.category==='dimension'))warnings.push('图纸尺寸来自 OCR 标注候选；未自动追踪引线，标注对象、视图与 OCR 数字须人工核对。');
  return {fields,warnings};
}

const boxesOf=f=>f.region?.boxes||[f.region].filter(rect);
const anchorOf=f=>{
  const boxes=boxesOf(f);
  if(f.category==='dimension')return boxes.find(r=>{const m=clean(r.text).match(new RegExp(`^(${num})`));return m&&Number(m[1])===f.numericValue;})||boxes[0];
  if(boxes.length<2)return boxes[0];
  const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));
  return {x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y};
};
function sameLocation(a,b){
  const x=anchorOf(a),y=anchorOf(b);
  if(!rect(x)||!rect(y))return false;
  const vertical=Math.max(0,Math.min(x.y+x.height,y.y+y.height)-Math.max(x.y,y.y));
  return vertical/Math.min(x.height,y.height)>.45 && overlapX(x,y)/Math.min(x.width,y.width)>.45 && Math.abs((x.y+x.height/2)-(y.y+y.height/2))<Math.max(x.height,y.height);
}
function precision(raw){
  const n=String(raw).match(new RegExp(num));if(!n)return 0;
  return .5*Math.pow(10,-(n[0].split('.')[1]?.length||0));
}
function dualUnitCheck(field){
  if(field.category!=='dimension')return undefined;
  const alt=field.alternateMeasurements?.[0];
  if(!alt||!field.unit||!alt.unit)return undefined;
  const scale={mm:1,in:25.4,cm:10,'μm':.001,'µm':.001,um:.001};
  if(!scale[field.unit]||!scale[alt.unit])return undefined;
  const deviation=Math.abs(field.numericValue*scale[field.unit]-alt.value*scale[alt.unit]);
  const roundingAllowance=precision(field.measurements?.[0]?.raw)*scale[field.unit]+precision(alt.raw)*scale[alt.unit];
  return {status:deviation<=roundingAllowance+1e-9?'consistent':'mismatch',deviationMm:deviation,roundingAllowanceMm:roundingAllowance,method:'explicit-unit-rounded-conversion'};
}
function fingerprint(f){
  return f.category==='dimension'?JSON.stringify([f.numericValue,f.unit,f.tolerance?.plus,f.tolerance?.minus,f.limit,f.alternateMeasurements?.map(m=>[m.value,m.unit,m.tolerance?.plus,m.tolerance?.minus]),f.unresolvedAnnotations]):clean(f.value).toUpperCase().replace(/[.。]$/,'');
}
function confidence(f){
  const header=/^(?:DRAWING|DWG\.?|NO\.?|NUMBER|NAME|PART|TITLE|MATERIAL|FINISH|REV(?:ISION)?\.?|图号|名称|材料|版本)$/i;
  const boxes=boxesOf(f),values=['identity','material'].includes(f.category)?boxes.filter(r=>!header.test(clean(r.text))):boxes;
  const found=(values.length?values:boxes).map(r=>r.sourceConfidence??r.confidence).filter(Number.isFinite);
  return found.length?found.reduce((a,b)=>a+b,0)/found.length:0;
}
const candidateOf=f=>({value:f.value,numericValue:f.numericValue,unit:f.unit,tolerance:f.tolerance,limit:f.limit,alternateMeasurements:f.alternateMeasurements,evidence:f.evidence,region:f.region,sourcePasses:f.sourcePasses,ocrConfidence:f.ocrConfidence,dualUnitValidation:f.dualUnitValidation});

/**
 * Extract evidence-bound candidates from one page. Every result needs human review.
 * drawingOCR.passes preserves independent OCR evidence; contradictions remain in otherCandidates.
 */
export function extractDrawingFields(pageData={}){
  const passes=pageData.drawingOCR?.passes?.filter(p=>Array.isArray(p.regions)||p.text);
  if(!passes?.length){
    const result=extractPass(pageData);
    for(const f of result.fields){f.dualUnitValidation=dualUnitCheck(f);f.ocrConfidence=confidence(f);}
    if(result.fields.some(f=>f.dualUnitValidation?.status==='mismatch'))result.warnings.push('双单位标注换算不一致，已保留 OCR 原值；请核对原图。');
    return result;
  }
  const sharedUnits=unitsOf(passes.map(p=>p.text||p.regions.map(r=>r.text).join('\n')).join('\n'));
  const unitLine=passes.flatMap(p=>linesOf({regions:p.regions,words:p.words,text:p.text})).find(r=>unitsOf(r.text).primary&&unitsOf(r.text).primary===sharedUnits.primary&&unitsOf(r.text).alternate===sharedUnits.alternate);
  if(unitLine)sharedUnits.source={page:pageData.page||1,evidence:unitLine.text,region:regionOf([unitLine])};
  const groups=[],warnings=[];
  for(const [index,pass]of passes.entries()){
    const result=extractPass({...pageData,drawingOCR:undefined,text:pass.text,regions:pass.regions,words:pass.words},sharedUnits);
    warnings.push(...result.warnings);
    for(const f of result.fields){
      f.sourcePasses=[pass.id||`pass-${index+1}`];f.ocrConfidence=confidence(f);f.dualUnitValidation=dualUnitCheck(f);
      const group=groups.find(g=>g[0].category===f.category&&(g[0].name===f.name||(f.category==='dimension'&&['尺寸标注','直径标注'].includes(g[0].name)&&['尺寸标注','直径标注'].includes(f.name)))&&sameLocation(g[0],f));
      if(group)group.push(f);else groups.push([f]);
    }
  }
  let conflicts=0;
  const fields=groups.map((group,index)=>{
    const alternatives=[];
    for(const f of group){
      const same=alternatives.find(a=>fingerprint(a)===fingerprint(f));
      if(same){same.sourcePasses=[...new Set([...same.sourcePasses,...f.sourcePasses])];same.supportingEvidence=[...(same.supportingEvidence||[]),{evidence:f.evidence,region:f.region}];same.ocrConfidence=Math.max(same.ocrConfidence,f.ocrConfidence);}
      else alternatives.push(f);
    }
    const completeness=f=>f.name==='材料'?(/\b(?:ASTM|MIL-|QQ-)\b/i.test(f.value)?500:0)+(/\s\/\s/.test(f.value)?150:0)+Math.min(f.value.length,80):0;
    const partial=f=>f.category!=='dimension'&&alternatives.some(a=>a!==f&&a.value.toUpperCase().startsWith(f.value.toUpperCase())&&a.value.length>f.value.length+2);
    const score=f=>(f.dualUnitValidation?.status==='consistent'?10000:f.dualUnitValidation?.status==='mismatch'?-10000:0)+f.sourcePasses.length*100+f.ocrConfidence+(f.alternateMeasurements?.length?10:0)+completeness(f)-(partial(f)?1000:0);
    alternatives.sort((a,b)=>score(b)-score(a));
    const chosen=alternatives[0];
    if(alternatives.length>1){chosen.otherCandidates=alternatives.slice(1).map(candidateOf);chosen.ocrConflict=true;chosen.selectionReason=chosen.dualUnitValidation?.status==='consistent'?'双单位换算一致性优先，再比较 OCR 支持次数与置信度':'可读字段完整度优先，再比较 OCR 支持次数与值区域置信度';conflicts++;}
    return {...chosen,id:`drawing-${pageData.page||1}-${index+1}`};
  });
  if(conflicts)warnings.push(`${conflicts} 处 OCR 结果存在分歧，已保留其他候选及原文，均待人工复核。`);
  if(fields.some(f=>f.dualUnitValidation?.status==='mismatch'))warnings.push('双单位标注换算不一致，已保留 OCR 原值；请核对原图。');
  if(fields.some(f=>f.unresolvedAnnotations?.length))warnings.push('部分标注包含未识别符号，已保留原文并标记待复核，未自动补写公差符号。');
  return {fields,warnings:[...new Set(warnings)]};
}
