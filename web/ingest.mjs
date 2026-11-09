/** Browser-only document ingestion. Dependencies and OCR models are served locally. */
export const INGEST_LIMITS = Object.freeze({ bytes: 200 * 1024 * 1024, pdfPages: 500, implicitOCRPages: 10 });
let pdfModule;
const local = path => new URL(path, import.meta.url).href;
const notify = (callback, message) => { if (typeof callback === 'function') callback(message); };
const abortError = () => new DOMException('文件处理已取消。', 'AbortError');
function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
async function abortable(promise, signal, cancel) {
  if (!signal) return promise;
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); Promise.resolve().then(cancel).catch(() => {}); throw abortError(); }
  let listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      listener = () => { Promise.resolve().then(cancel).catch(() => {}); reject(abortError()); };
      signal.addEventListener('abort', listener, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', listener); }
}
const releaseCanvas = canvas => { if (canvas) { canvas.width = 1; canvas.height = 1; } };
export function validateRotation(value) {
  if (value == null) return 0;
  if (![0, 90, 180, 270].includes(value)) throw new Error('旋转角度只能为 0、90、180、270。');
  return value;
}
export function validateOCRLanguage(value = 'eng+chi_sim') {
  if (!['eng','chi_sim','eng+chi_sim'].includes(value)) throw new Error('OCR 语言只能选择 eng、chi_sim 或 eng+chi_sim。');
  return value;
}
export function validateOCRRegion(value) {
  if (value == null) return null;
  const {x,y,width,height}=value;
  if (![x,y,width,height].every(Number.isFinite)||x<0||y<0||width<=0||height<=0||x+width>1.000001||y+height>1.000001) throw new Error('OCR 区域必须是页面内的归一化矩形 x/y/width/height（0 到 1）。');
  return {x,y,width:Math.min(width,1-x),height:Math.min(height,1-y)};
}
export function mapRegionsToPage(regions, area) {
  if (!area) return regions;
  return regions.map(r=>({...r,x:area.x+r.x*area.width,y:area.y+r.y*area.height,width:r.width*area.width,height:r.height*area.height}));
}
/** Layout-independent overlapping windows: each pixel is covered, without guessing drawing fields. */
export function drawingOCRPlan(width, height, selectedArea = null) {
  if (![width,height].every(n=>Number.isFinite(n)&&n>0)) throw new Error('Invalid drawing dimensions');
  const area=validateOCRRegion(selectedArea)||{x:0,y:0,width:1,height:1};
  const columns=2, rows=2;
  const passes=[{id:'whole',kind:'whole',psm:11,area},
    {id:'layout',kind:'whole',psm:3,area},
    {id:'layout-clean',kind:'whole',psm:3,area,cleanup:true}];
  const overlap=.12;
  for(let row=0;row<rows;row++)for(let column=0;column<columns;column++) {
    const x=Math.max(0,column/columns-overlap/2),y=Math.max(0,row/rows-overlap/2);
    const right=Math.min(1,(column+1)/columns+overlap/2),bottom=Math.min(1,(row+1)/rows+overlap/2);
    passes.push({id:`tile-${row+1}-${column+1}`,kind:'tile',psm:6,area:{x:area.x+x*area.width,y:area.y+y*area.height,width:(right-x)*area.width,height:(bottom-y)*area.height}});
  }
  return passes;
}
function cropCanvas(source, area) {
  const left=Math.max(0,Math.floor(area.x*source.width)),top=Math.max(0,Math.floor(area.y*source.height));
  const right=Math.min(source.width,Math.ceil((area.x+area.width)*source.width)),bottom=Math.min(source.height,Math.ceil((area.y+area.height)*source.height));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,right-left);canvas.height=Math.max(1,bottom-top);
  canvas.getContext('2d').drawImage(source,left,top,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
  return {canvas,area:{x:left/source.width,y:top/source.height,width:canvas.width/source.width,height:canvas.height/source.height}};
}
/** Remove only long, thin dark rules. Thick blocks and neighboring non-rule glyph pixels are protected. */
export function removeTableLines(image, options = {}) {
  const {width,height}=image, source=image.data;
  if (!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||source.length!==width*height*4) throw new Error('Invalid image pixels');
  const maxThickness=options.maxThickness||4;
  const dark=new Uint8Array(width*height), mask=new Uint8Array(width*height);
  for(let i=0;i<dark.length;i++)dark[i]=source[i*4+3]>128&&(source[i*4]*.299+source[i*4+1]*.587+source[i*4+2]*.114)<160?1:0;
  const scan=(vertical)=>{
    const length=vertical?height:width,lines=vertical?width:height,minRun=Math.max(options.minRun||60,Math.round(length*(options.minFraction??.3)));
    const index=(line,pos)=>vertical?pos*width+line:line*width+pos;
    for(let line=0;line<lines;line++) {
      let start=0;
      while(start<length){
        while(start<length&&!dark[index(line,start)])start++;
        let end=start;while(end<length&&dark[index(line,end)])end++;
        if(end-start>=minRun){
          let thinnest=Infinity;
          for(const fraction of [.25,.5,.75]){
            const pos=Math.min(end-1,start+Math.floor((end-start)*fraction));let before=line,after=line;
            while(before>0&&dark[index(before-1,pos)]&&line-before<=maxThickness)before--;
            while(after+1<lines&&dark[index(after+1,pos)]&&after-line<=maxThickness)after++;
            thinnest=Math.min(thinnest,after-before+1);
          }
          if(thinnest<=maxThickness)for(let pos=start;pos<end;pos++)mask[index(line,pos)]=1;
        }
        start=end+1;
      }
    }
  };
  scan(false);scan(true);
  const data=new Uint8ClampedArray(source);let removedPixels=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=y*width+x;if(!mask[i])continue;
    let touchesGlyph=false;
    for(let d=1;d<=maxThickness+1&&!touchesGlyph;d++)for(const [dx,dy]of[[0,-d],[0,d],[-d,0],[d,0]]){
      const nx=x+dx,ny=y+dy;if(nx<0||nx>=width||ny<0||ny>=height)continue;
      const n=ny*width+nx;if(dark[n]&&!mask[n]){touchesGlyph=true;break;}
    }
    if(!touchesGlyph){data[i*4]=255;data[i*4+1]=255;data[i*4+2]=255;removedPixels++;}
  }
  return {data,width,height,removedPixels};
}
function prepareTableCanvas(source) {
  const ctx=source.getContext('2d',{willReadFrequently:true});
  const cleaned=removeTableLines(ctx.getImageData(0,0,source.width,source.height));
  const temporary=document.createElement('canvas');temporary.width=source.width;temporary.height=source.height;
  temporary.getContext('2d').putImageData(new ImageData(cleaned.data,cleaned.width,cleaned.height),0,0);
  const scale=Math.max(1,Math.min(2,2400/Math.max(source.width,source.height),Math.sqrt(4_000_000/(source.width*source.height))));
  if(scale<=1.01)return {canvas:temporary,removedPixels:cleaned.removedPixels,scale:1};
  const canvas=document.createElement('canvas');canvas.width=Math.round(source.width*scale);canvas.height=Math.round(source.height*scale);
  const target=canvas.getContext('2d');target.imageSmoothingEnabled=true;target.imageSmoothingQuality='high';target.drawImage(temporary,0,0,canvas.width,canvas.height);
  releaseCanvas(temporary);return {canvas,removedPixels:cleaned.removedPixels,scale};
}
function prepareDrawingCanvas(source) {
  const cleaned=removeTableLines(source.getContext('2d',{willReadFrequently:true}).getImageData(0,0,source.width,source.height),{minRun:100,minFraction:.03,maxThickness:5});
  const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
  canvas.getContext('2d').putImageData(new ImageData(cleaned.data,source.width,source.height),0,0);
  return {canvas,removedPixels:cleaned.removedPixels,scale:1};
}
function ocrEvidence(data, canvas) {
  return mapRegionsToPage(regionsFromOCR(data,data?.ocrSpace?.width||canvas.width,data?.ocrSpace?.height||canvas.height),data?.ocrSpace?.area);
}
function rotatedCanvas(source, rotation, maxEdge = Infinity) {
  const quarter = rotation === 90 || rotation === 270;
  const naturalWidth = quarter ? source.height : source.width;
  const naturalHeight = quarter ? source.width : source.height;
  const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(naturalWidth * scale)); canvas.height = Math.max(1, Math.round(naturalHeight * scale));
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(rotation * Math.PI / 180);
  ctx.drawImage(source, -source.width * scale / 2, -source.height * scale / 2, source.width * scale, source.height * scale);
  return canvas;
}
export function rotateRegions(regions, rotation) {
  validateRotation(rotation);
  return regions.map(r => {
    if (rotation === 90) return { ...r, x: 1 - r.y - r.height, y: r.x, width: r.height, height: r.width };
    if (rotation === 180) return { ...r, x: 1 - r.x - r.width, y: 1 - r.y - r.height };
    if (rotation === 270) return { ...r, x: r.y, y: 1 - r.x - r.width, width: r.height, height: r.width };
    return { ...r };
  });
}

export function hashCanvas(canvas) {
  const small = document.createElement('canvas'); small.width = 9; small.height = 8;
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 9, 8); ctx.drawImage(canvas, 0, 0, 9, 8);
  const data = ctx.getImageData(0, 0, 9, 8).data;
  const gray = i => data[i * 4] * .299 + data[i * 4 + 1] * .587 + data[i * 4 + 2] * .114;
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray(y * 9 + x) > gray(y * 9 + x + 1) ? '1' : '0';
  releaseCanvas(small); return bits;
}
function thumbnail(canvas, edge = 400) {
  const thumb = document.createElement('canvas');
  const scale = Math.min(1, edge / Math.max(canvas.width, canvas.height));
  thumb.width = Math.max(1, Math.round(canvas.width * scale)); thumb.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = thumb.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, thumb.width, thumb.height);
  ctx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  const result = thumb.toDataURL('image/jpeg', .76); releaseCanvas(thumb); return result;
}
function validate(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择本地文件。');
  if (file.size > INGEST_LIMITS.bytes) throw new Error('文件超过 200 MB，请先拆分或压缩。');
  if (!file.size) throw new Error('文件为空。');
  const ext = (file.name || '').split('.').pop().toLowerCase();
  if (!['pdf', 'png', 'jpg', 'jpeg', 'txt', 'csv', 'md'].includes(ext)) throw new Error('支持 PDF、PNG、JPG、TXT、CSV、MD；DWG 请先导出为 PDF。');
  return ext;
}
async function loadPdf(buffer, signal) {
  checkAbort(signal);
  if (!pdfModule) {
    pdfModule = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfModule.GlobalWorkerOptions.workerSrc = local('./vendor/pdfjs/pdf.worker.min.mjs');
  }
  checkAbort(signal);
  const task = pdfModule.getDocument({
    data: new Uint8Array(buffer), cMapUrl: local('./vendor/pdfjs/cmaps/'), cMapPacked: true,
    standardFontDataUrl: local('./vendor/pdfjs/standard_fonts/'), isEvalSupported: false,
  });
  try { return await abortable(task.promise, signal, () => task.destroy()); }
  catch (error) {
    await task.destroy().catch(() => {});
    if (signal?.aborted || error.name === 'AbortError') throw abortError();
    if (error.name === 'PasswordException') throw new Error('PDF 受密码保护，请先解密后导入。');
    throw new Error(`PDF 无法解析：${error.message || '文件可能损坏'}`);
  }
}
function transformedBounds(bounds, matrix) {
  if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite)) return null;
  const [x0,y0,x1,y1]=bounds;
  const points=[[x0,y0],[x1,y0],[x0,y1],[x1,y1]].map(([x,y])=>[matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]]);
  return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];
}
function intersectBounds(a,b) { if(!a)return b;if(!b)return a;return[Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])]; }
function unionBounds(a,b) { if(!a)return b;if(!b)return a;return[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[2],b[2]),Math.max(a[3],b[3])]; }
const glyphKey = text => String(text||'').normalize('NFKC').replace(/[\s\u200b\u00ad]/g,'');
/**
 * PDF.js text extraction includes text outside active clipping paths. Match text items to
 * operator glyph order and remove only items proven wholly outside the active clip box,
 * outside the page, or explicitly invisible. Arbitrary clip paths use conservative bounds.
 */
export function filterVisiblePDFItems(content, operatorList, OPS, viewport) {
  const names=Object.fromEntries(Object.entries(OPS).map(([name,code])=>[code,name]));
  let state={matrix:[1,0,0,1,0,0],clip:viewport.viewBox?Array.from(viewport.viewBox):null,mode:0,fillAlpha:1,strokeAlpha:1};
  const stack=[], runs=[]; let path=null, stream='';
  const copyState=()=>({...state,matrix:[...state.matrix],clip:state.clip?[...state.clip]:null});
  const appendText=args=>{
    const collect=value=>Array.isArray(value)?value.map(collect).join(''):value&&typeof value==='object'?value.unicode||'':'';
    const text=glyphKey(collect(args));if(!text)return;
    const mode=state.mode&3;
    const invisible=mode===3||(mode===0&&state.fillAlpha===0)||(mode===1&&state.strokeAlpha===0)||(mode===2&&state.fillAlpha===0&&state.strokeAlpha===0);
    runs.push({start:stream.length,end:stream.length+text.length,clip:state.clip?[...state.clip]:null,invisible});stream+=text;
  };
  for(let i=0;i<operatorList.fnArray.length;i++) {
    const name=names[operatorList.fnArray[i]],args=operatorList.argsArray[i]||[];
    if(name==='save')stack.push(copyState());
    else if(name==='restore'){if(stack.length)state=stack.pop();}
    else if(name==='transform')state.matrix=multiply(state.matrix,args);
    else if(name==='paintFormXObjectBegin'){
      stack.push(copyState());if(args[0])state.matrix=multiply(state.matrix,args[0]);
      if(args[1])state.clip=intersectBounds(state.clip,transformedBounds(args[1],state.matrix));
    }else if(name==='paintFormXObjectEnd'){if(stack.length)state=stack.pop();}
    else if(name==='beginGroup'){
      stack.push(copyState());const group=args[0]||{};
      const groupMatrix=group.matrix?multiply(state.matrix,group.matrix):state.matrix;
      if(group.bbox)state.clip=intersectBounds(state.clip,transformedBounds(group.bbox,groupMatrix));
      state.fillAlpha=1;state.strokeAlpha=1;
    }else if(name==='endGroup'){if(stack.length)state=stack.pop();}
    else if(name==='constructPath'){
      if(args[2])path=unionBounds(path,transformedBounds(Array.from(args[2]),state.matrix));
    }else if(name==='rectangle')path=unionBounds(path,transformedBounds([args[0],args[1],args[0]+args[2],args[1]+args[3]],state.matrix));
    else if(name==='clip'||name==='eoClip'){if(path)state.clip=intersectBounds(state.clip,path);}
    else if(['endPath','stroke','closeStroke','fill','eoFill','fillStroke','eoFillStroke','closeFillStroke','closeEOFillStroke'].includes(name))path=null;
    else if(name==='setTextRenderingMode')state.mode=args[0];
    else if(name==='setGState')for(const [key,value]of args[0]||[]){if(key==='ca')state.fillAlpha=value;if(key==='CA')state.strokeAlpha=value;}
    else if(['showText','showSpacedText','nextLineShowText','nextLineSetSpacingShowText'].includes(name))appendText(args);
  }
  let cursor=0,runCursor=0,removedTextItems=0,unmappedTextItems=0;
  const items=[];
  for(const item of content.items||[]) {
    const key=glyphKey(item.str);if(!key){items.push(item);continue;}
    const start=stream.indexOf(key,cursor);
    if(start<0){unmappedTextItems++;items.push(item);continue;}
    const end=start+key.length;cursor=end;
    while(runCursor<runs.length&&runs[runCursor].end<=start)runCursor++;
    const region=regionsFromPDFItems([item],content.styles||{},viewport)[0];
    if(!region){removedTextItems++;continue;}
    let visible=false;
    for(let r=runCursor;r<runs.length&&runs[r].start<end;r++){
      const run=runs[r];if(run.invisible)continue;
      if(!run.clip){visible=true;break;}
      if(run.clip[2]<=run.clip[0]||run.clip[3]<=run.clip[1])continue;
      const b=transformedBounds(run.clip,viewport.transform);
      const x0=region.x*viewport.width,y0=region.y*viewport.height,x1=(region.x+region.width)*viewport.width,y1=(region.y+region.height)*viewport.height;
      if(b&&x1>b[0]&&x0<b[2]&&y1>b[1]&&y0<b[3]){visible=true;break;}
    }
    if(visible)items.push(item);else removedTextItems++;
  }
  return {items,removedTextItems,unmappedTextItems};
}
/** Shared production/audit path: read only visibly eligible PDF text, preserving evidence regions. */
export async function readPDFText(page, options={}) {
  const signal=options.signal;checkAbort(signal);
  const content=await abortable(page.getTextContent(),signal);
  const operatorList=await abortable(page.getOperatorList(),signal);
  const {OPS}=await import('./vendor/pdfjs/pdf.min.mjs');
  const viewport=page.getViewport({scale:1});
  const visible=filterVisiblePDFItems(content,operatorList,OPS,viewport);
  return {text:textFromItems(visible.items),regions:regionsFromPDFItems(visible.items,content.styles,viewport),removedTextItems:visible.removedTextItems,unmappedTextItems:visible.unmappedTextItems};
}
// BOM reconstruction is intentionally gated on explicit headings and measured columns.
const BOM_HEADINGS = {
  item: /^(?:item|item\s*no\.?|序号|项次)$/i,
  partNumber: /^(?:part\s*(?:no\.?|number)|零件号|图号|物料号|料号)$/i,
  name: /^(?:description|name|part\s*name|名称|零件名称|品名)$/i,
  qty: /^(?:qty\.?|quantity|数量|用量)$/i,
  unit: /^(?:unit|单位)$/i,
  material: /^(?:material|材料|材质)$/i,
};
const cleanText = value => String(value || '').normalize('NFKC').trim();
function atomsToRows(atoms) {
  const rows = [];
  for (const atom of atoms.filter(a => a.text && [a.x,a.y,a.width,a.height].every(Number.isFinite)).sort((a,b) => a.y-b.y || a.x-b.x)) {
    const center = atom.y + atom.height / 2;
    let row = rows.find(r => Math.abs(r.center - center) <= Math.max(2, Math.min(r.height, atom.height) * .48));
    if (!row) { row = { center, y: atom.y, height: atom.height, atoms: [] }; rows.push(row); }
    row.atoms.push(atom);
  }
  return rows.sort((a,b) => a.center-b.center).map(row => ({ ...row, atoms: row.atoms.sort((a,b)=>a.x-b.x) }));
}
function headingCells(atoms) {
  const tokens = atoms.filter(a => !/^[|│]+$/.test(a.text));
  const cells = [];
  for (let i = 0; i < tokens.length;) {
    let found;
    for (let length = Math.min(4, tokens.length-i); length >= 1; length--) {
      const group = tokens.slice(i,i+length);
      if (group.some((a,j)=>j && a.x-group[j-1].x-group[j-1].width > Math.max(a.height,group[j-1].height)*1.8)) continue;
      const phrase = group.map(a=>a.text).join(' ');
      const candidates = [cleanText(phrase), cleanText(phrase).replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g,'$1')];
      for (const text of candidates) {
        const key = Object.keys(BOM_HEADINGS).find(key=>BOM_HEADINGS[key].test(text));
        if (key) { found={key,text,x:group[0].x,right:group.at(-1).x+group.at(-1).width,height:Math.max(...group.map(a=>a.height)),length}; break; }
      }
      if (found) break;
    }
    if (!found || cells.some(cell=>cell.key===found.key)) return null;
    cells.push(found); i += found.length;
  }
  if (!cells.some(c=>c.key==='qty') || !cells.some(c=>c.key==='partNumber'||c.key==='name')) return null;
  if (cells.length < 2 || cells.some((cell,i)=>i && cell.x-cells[i-1].right < Math.max(2,cell.height*.35))) return null;
  return cells;
}
/** Returns only rows confirmed by explicit BOM headers, numeric quantities and aligned source atoms. */
function recoverBOMTables(rows) {
  const tables=[];
  for (let h=0;h<rows.length;h++) {
    const columns=headingCells(rows[h].atoms); if(!columns)continue;
    const cuts=columns.slice(1).map((c,i)=>(columns[i].right+c.x)/2);
    const extentLeft=columns[0].x-Math.max(columns[0].height*2,(columns[1].x-columns[0].x)/2);
    const extentRight=columns.at(-1).right+Math.max(columns.at(-1).height*2,(columns.at(-1).x-columns.at(-2).x)/2);
    const anchors=[], continuations=[]; let previous=rows[h];
    for(let r=h+1;r<rows.length;r++) {
      const row=rows[r];
      const atoms=row.atoms.filter(a=>!/^[-─|│]+$/.test(a.text)&&a.x+a.width/2>=extentLeft&&a.x+a.width/2<=extentRight);
      if(!atoms.length)continue; // Adjacent diagram labels are outside the measured table span.
      if(row.y-previous.y>Math.max(row.height,previous.height)*4)break;
      if(headingCells(atoms))break;
      const values=columns.map(()=>[]);
      for(const atom of atoms) {
        const center=atom.x+atom.width/2;
        let col=cuts.findIndex(cut=>center<cut); if(col<0)col=columns.length-1;
        values[col].push(atom);
      }
      const textValues=values.map(value=>value.map(a=>a.text).join(' ').trim());
      const qty=textValues[columns.findIndex(c=>c.key==='qty')];
      const unit=textValues[columns.findIndex(c=>c.key==='unit')]||'';
      const count=/^\d+$/.test(qty)&&Number.isSafeInteger(Number(qty));
      const length=/^\d+(?:\.\d+)?\s*(?:mm|cm|m|in\.?|inch(?:es)?|ft|feet|米|毫米|厘米)$/i.test((qty+' '+unit).trim());
      const identifier=columns.some((c,i)=>(c.key==='partNumber'||c.key==='name')&&textValues[i]);
      const validItem=!columns.some((c,i)=>c.key==='item'&&textValues[i]&&!/^\d+[A-Za-z]?$/.test(textValues[i]));
      if((count||length)&&identifier&&validItem) anchors.push({index:r,values,atoms,y:row.y,height:row.height});
      else {
        const occupied=values.map((v,i)=>v.length?i:-1).filter(i=>i>=0);
        if(occupied.length===1&&columns[occupied[0]].key==='name')continuations.push({index:r,atoms,y:row.y,height:row.height,column:occupied[0]});
        else break; // Ambiguous cells remain source text, rather than guessed BOM rows.
      }
      previous=row;
    }
    if(!anchors.length)continue;
    for(const continuation of continuations) {
      const nearest=[...anchors].sort((a,b)=>Math.abs(a.y-continuation.y)-Math.abs(b.y-continuation.y))[0];
      if(Math.abs(nearest.y-continuation.y)<=Math.max(nearest.height,continuation.height)*1.5) {
        nearest.values[continuation.column].push(...continuation.atoms); nearest.atoms.push(...continuation.atoms);
      }
    }
    const recovered=anchors.map(anchor=>({...anchor,text:anchor.values.map(value=>value.sort((a,b)=>a.y-b.y||a.x-b.x).map(a=>a.text).join(' ').trim()).join(' | ')}));
    tables.push({header:{index:h,text:columns.map(c=>c.text).join(' | '),atoms:rows[h].atoms},rows:recovered});
    h=anchors.at(-1).index;
  }
  return tables;
}
export function textFromItems(items) {
  // Baseline grouping preserves existing PDF text order. BOM reconstruction only changes confirmed table rows.
  const rows = [];
  for (const item of items) {
    if (!item.str?.trim() || !item.transform) continue;
    const x=item.transform[4], y=item.transform[5], height=Math.abs(item.height||8);
    let row=rows.find(row=>Math.abs(row.baseline-y)<Math.max(2,height*.25));
    if(!row){row={baseline:y,y:-y,height,atoms:[]};rows.push(row);}
    row.atoms.push({x,y:-y,width:item.width||0,height,text:item.str});
  }
  rows.sort((a,b)=>b.baseline-a.baseline); rows.forEach(row=>row.atoms.sort((a,b)=>a.x-b.x));
  const tables=recoverBOMTables(rows), consumed=new Set();
  for(const table of tables) for(const row of [table.header,...table.rows])for(const atom of row.atoms)consumed.add(atom);
  const ordinary=rows.map(row=>row.atoms.filter(a=>!consumed.has(a))).filter(atoms=>atoms.length).map(atoms=>atoms.map((cell,i)=>{
    const previous=atoms[i-1];
    return(i?(cell.x-previous.x-previous.width>35?' | ':' '):'')+cell.text;
  }).join('')).join('\n');
  return ordinary+(tables.length?'\n\n'+tables.map(table=>[table.header,...table.rows].map(row=>row.text).join('\n')).join('\n\n'):'');
}
function ocrAtoms(data) {
  const atoms=[];
  for(const block of data?.blocks||[])for(const paragraph of block.paragraphs||[])for(const line of paragraph.lines||[]) {
    // Individual words are needed for measurable column positions. A whole line must never be split by guessed widths.
    for(const word of line.words||[]) {
      const b=word.bbox, text=cleanText(word.text); if(!b||!text)continue;
      atoms.push({text,x:b.x0,y:b.y0,width:b.x1-b.x0,height:b.y1-b.y0});
    }
  }
  return atoms;
}
function ocrTables(data) { return recoverBOMTables(atomsToRows(ocrAtoms(data))); }
/** Preserve original OCR prose verbatim, appending measured BOM tables only when raw OCR lacks delimiters. */
export function textFromOCR(data) {
  const raw=String(data?.text||'');
  // Already-delimited tables are left untouched to avoid duplicating BOM rows.
  if(raw.split(/\r?\n/).some(line=>{
    if(!/[|\t;]/.test(line))return false;
    const cells=line.split(/[|\t;]/).map(cleanText);
    return cells.some(cell=>BOM_HEADINGS.qty.test(cell))&&cells.some(cell=>BOM_HEADINGS.partNumber.test(cell)||BOM_HEADINGS.name.test(cell));
  }))return raw;
  const tables=ocrTables(data); if(!tables.length)return raw;
  return raw+'\n\n'+tables.map(table=>[table.header,...table.rows].map(row=>row.text).join('\n')).join('\n\n');
}

function multiply(a, b) {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
function normalizedRect(text, left, top, right, bottom, width, height) {
  if (!text?.trim() || ![left,top,right,bottom,width,height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const x = Math.max(0, Math.min(1, left / width)), y = Math.max(0, Math.min(1, top / height));
  const x2 = Math.max(0, Math.min(1, right / width)), y2 = Math.max(0, Math.min(1, bottom / height));
  if (x2 <= x || y2 <= y) return null;
  return { text: text.trim(), x, y, width: x2 - x, height: y2 - y };
}
/** Text-item boxes are derived from PDF transforms/font metrics, not inferred field locations. */
export function regionsFromPDFItems(items, styles = {}, viewport) {
  if (!viewport?.transform || !viewport.width || !viewport.height) return [];
  return items.flatMap(item => {
    if (!item.str?.trim() || !item.transform || !Number.isFinite(item.width)) return [];
    const t = multiply(viewport.transform, item.transform), style = styles[item.fontName] || {};
    let angle = Math.atan2(t[1], t[0]);
    if (style.vertical) angle += Math.PI / 2;
    const fontHeight = Math.hypot(t[2], t[3]);
    if (!fontHeight) return [];
    const ascent = fontHeight * (Number.isFinite(style.ascent) ? style.ascent : Number.isFinite(style.descent) ? 1 + style.descent : 1);
    const itemWidth = (style.vertical ? item.height : item.width) * (viewport.scale || 1);
    if (!Number.isFinite(itemWidth) || itemWidth <= 0) return [];
    const x = t[4] + ascent * Math.sin(angle), y = t[5] - ascent * Math.cos(angle);
    const dx = Math.cos(angle) * itemWidth, dy = Math.sin(angle) * itemWidth;
    const hx = -Math.sin(angle) * fontHeight, hy = Math.cos(angle) * fontHeight;
    const xs = [x,x+dx,x+hx,x+dx+hx], ys = [y,y+dy,y+hy,y+dy+hy];
    const region = normalizedRect(item.str, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), viewport.width, viewport.height);
    return region ? [region] : [];
  });
}
/** Tesseract v6 returns line boxes only when blocks output is requested. */
export function regionsFromOCR(data, width, height) {
  const regions = [];
  for (const block of data?.blocks || []) {
    const lines = (block.paragraphs || []).flatMap(paragraph => paragraph.lines || []);
    for (const line of lines.length ? lines : [block]) {
      const b = line.bbox;
      if (!b) continue;
      const region = normalizedRect(line.text, b.x0, b.y0, b.x1, b.y1, width, height);
      if (region) regions.push(region);
    }
  }
  for (const table of ocrTables(data)) for (const row of [table.header,...table.rows]) {
    const a=row.atoms;
    const region=normalizedRect(row.text, Math.min(...a.map(v=>v.x)), Math.min(...a.map(v=>v.y)), Math.max(...a.map(v=>v.x+v.width)), Math.max(...a.map(v=>v.y+v.height)), width, height);
    if(region)regions.push(region);
  }
  return regions;
}
/** Keep alternate OCR readings verbatim. Consumers can compare passes; no character or number repair occurs here. */
export function drawingOCRPass(data, width, height, metadata) {
  const area=validateOCRRegion(metadata.area)||{x:0,y:0,width:1,height:1};
  const decorate=(region,confidence)=>({...region,sourcePass:metadata.id,sourceConfidence:Number.isFinite(confidence)?confidence:null});
  const lines=[],words=[];
  for(const block of data?.blocks||[]) {
    const candidates=(block.paragraphs||[]).flatMap(paragraph=>paragraph.lines||[]);
    for(const line of candidates.length?candidates:[block]) {
      const b=line.bbox;
      const region=b&&normalizedRect(line.text,b.x0,b.y0,b.x1,b.y1,width,height);
      if(region)lines.push(decorate(region,line.confidence));
      for(const word of line.words||[]) {
        const box=word.bbox, r=box&&normalizedRect(word.text,box.x0,box.y0,box.x1,box.y1,width,height);
        if(r)words.push(decorate(r,word.confidence));
      }
    }
  }
  return {...metadata,area,text:String(data?.text||''),confidence:Number.isFinite(data?.confidence)?data.confidence:null,
    width,height,regions:mapRegionsToPage(lines,area),words:mapRegionsToPage(words,area)};
}
/** Coarse text-based page classification; it is not a visual model prediction. */
export function classifyPage(text) {
  const source = String(text || '');
  if (!source.trim()) return 'unknown';
  if(/drawing[^\n]{0,45}(?:first|third)[ -]angle/i.test(source)&&/\b(?:DIA|MIN|MAX)\b/i.test(source))return 'engineering';
  const engineering = [/(?:first|third)[ -]angle|第一角|第三角|投影法/i, /tolerance|公差|形位|GD\s*&\s*T/i, /drawing\s*(?:no|number)|图号|图纸编号/i, /surface\s*finish|粗糙度|Ra\s*\d/i, /(?:scale|比例)\s*[:：]?\s*\d\s*[:：]\s*\d/i].filter(pattern => pattern.test(source)).length;
  const specification = [/datasheet|specification|规格书|技术参数|performance/i, /voltage|current|电压|电流/i, /rated|nominal|额定|标称/i, /operating\s*temperature|工作温度/i, /model\s*(?:no|number)|型号/i].filter(pattern => pattern.test(source)).length;
  if (engineering >= 2 && engineering >= specification) return 'engineering';
  if (specification >= 2) return 'specification';
  if (/installation|maintenance|instruction|procedure|safety|warning|安装|维护|操作|说明|步骤|警告|注意事项/i.test(source)) return 'technical';
  return 'unknown';
}
export function parseOCRPages(selection, pageCount) {
  if (selection == null) return null;
  let requested;
  if (Array.isArray(selection)) requested = selection;
  else if (typeof selection === 'string' && selection.trim()) {
    requested = [];
    for (const token of selection.split(/[,，\s]+/).filter(Boolean)) {
      const match = token.match(/^(\d+)(?:-(\d+))?$/);
      if (!match) throw new Error('OCR 页码格式应为 1,3-5。');
      const start = Number(match[1]), end = Number(match[2] || match[1]);
      if (end < start || end - start > INGEST_LIMITS.pdfPages || start < 1 || end > pageCount) throw new Error('OCR 页码超出文档范围。');
      for (let p = start; p <= end; p++) requested.push(p);
    }
  } else throw new Error('请提供非空的 OCR 页码，例如 1,3-5。');
  if (!requested.length || requested.some(p => !Number.isInteger(p) || p < 1 || p > pageCount)) throw new Error('OCR 页码超出文档范围。');
  return new Set(requested);
}
export function pdfRenderScale(width,height,edge,highResolution=false) {
  if (![width,height,edge].every(n=>Number.isFinite(n)&&n>0)) throw new Error('Invalid page dimensions');
  return Math.min(edge/Math.max(width,height),highResolution?Infinity:3,Math.sqrt(18_000_000/(width*height)));
}
async function renderPage(page, edge, signal, highResolution=false) {
  checkAbort(signal);
  const unit = page.getViewport({ scale: 1 });
  const scale = pdfRenderScale(unit.width,unit.height,edge,highResolution);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const task = page.render({ canvasContext: ctx, viewport, background: '#ffffff' });
  try { await abortable(task.promise, signal, () => task.cancel()); return canvas; }
  catch (error) { releaseCanvas(canvas); if (signal?.aborted) throw abortError(); throw error; }
}
async function imageCanvas(file, signal, maxEdge = 3000) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image(); img.src = url;
    await abortable(img.decode(), signal, () => { img.src = ''; });
    if (img.naturalWidth * img.naturalHeight > 60_000_000) throw new Error('图片像素过大，请缩小到 6000 万像素以内。');
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { canvas, width: img.naturalWidth, height: img.naturalHeight };
  } catch(error) { if (signal?.aborted || error.name === 'AbortError') throw abortError(); throw new Error(`图片无法读取：${error.message}`); }
  finally { URL.revokeObjectURL(url); }
}
async function createOCR(onProgress, signal, language) {
  checkAbort(signal); notify(onProgress, `加载本地 OCR 引擎与 ${language} 模型…`);
  const { default: Tesseract } = await import('./vendor/tesseract/tesseract.esm.min.mjs');
  checkAbort(signal);
  const pending = Tesseract.createWorker(language, 1, {
    workerPath: local('./vendor/tesseract/worker.min.js'), corePath: local('./vendor/tesseract'), langPath: local('./vendor/tessdata'),
    workerBlobURL: false, gzip: true,
    logger: event => { if (!signal?.aborted) notify(onProgress, `OCR · ${event.status} ${Math.round((event.progress || 0) * 100)}%`); },
  });
  const worker = await abortable(pending, signal, () => pending.then(w => w.terminate()));
  try {
    await abortable(worker.setParameters({ preserve_interword_spaces: '1' }), signal, () => worker.terminate());
    return worker;
  } catch (error) { await worker.terminate().catch(() => {}); throw error; }
}
function emptyPage(page, method = 'pdf-text') {
  return { page, text: '', method, hash: '', thumbnail: '', width: 0, height: 0, type: 'unknown', regions: [] };
}

/** options: {ocr,autoOCR,drawingOCR,ocrPages:[1,3] or '1,3-5',signal:AbortSignal}. */
export async function readFile(file, onProgress, options = {}) {
  const ext = validate(file), signal = options.signal, requestedRotation = validateRotation(options.rotation);
  const drawingMode=options.drawingOCR===true;
  const ocrLanguage = validateOCRLanguage(options.ocrLanguage??(drawingMode?'eng':'eng+chi_sim')), ocrRegion = validateOCRRegion(options.ocrRegion);
  checkAbort(signal); notify(onProgress, '读取文件并计算内容指纹…');
  // Read once. PDF.js transfers this buffer to its worker after digesting it.
  let buffer = await abortable(file.arrayBuffer(), signal);
  const digest = await abortable(crypto.subtle.digest('SHA-256', buffer), signal);
  const result = { name: file.name, pages: [], thumbnail: '', hash: '', warnings: [], contentId: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') };
  const explicitOCR = Boolean(options.ocr) || options.ocrPages != null || Boolean(ocrRegion);
  const autoOCR = options.autoOCR === true || (ext !== 'pdf' && options.autoOCR !== false);
  if (['txt', 'csv', 'md'].includes(ext)) {
    const text = new TextDecoder().decode(buffer).replace(/^\uFEFF/, '');
    result.pages = [{ ...emptyPage(1, 'text'), text, type: classifyPage(text) }]; return result;
  }
  let worker, pdf, ocrUnavailable = false, usedOCR = false;
  async function recognize(canvas, label, passOptions=null) {
    if (ocrUnavailable) return null;
    checkAbort(signal);
    let cropped, prepared;
    try {
      worker ||= await createOCR(onProgress, signal, ocrLanguage);
      notify(onProgress, `${label}：识别文字…`);
      const selectedArea=passOptions?.area||ocrRegion;
      if (selectedArea) cropped = cropCanvas(canvas, selectedArea);
      let input = cropped?.canvas || canvas;
      if(options.ocrTable === true&&!passOptions){
        prepared=prepareTableCanvas(input);input=prepared.canvas;
        notify(onProgress, `${label}：表格模式已清理 ${prepared.removedPixels} 个细线像素…`);
        await abortable(worker.setParameters({tessedit_pageseg_mode:'6'}),signal,()=>worker.terminate());
      }
      if(passOptions?.cleanup){prepared=prepareDrawingCanvas(input);input=prepared.canvas;}
      if(passOptions) await abortable(worker.setParameters({tessedit_pageseg_mode:String(passOptions.psm)}),signal,()=>worker.terminate());
      const { data } = await abortable(worker.recognize(input, {}, { text: true, blocks: true }), signal, () => worker.terminate());
      usedOCR = true;
      return cropped || prepared ? {...data,ocrSpace:{width:input.width,height:input.height,area:cropped?.area||{x:0,y:0,width:1,height:1}},tableProcessing:prepared&&!passOptions?{removedPixels:prepared.removedPixels,scale:prepared.scale}:null,drawingProcessing:prepared&&passOptions?{removedPixels:prepared.removedPixels,scale:prepared.scale}:null} : data;
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw abortError();
      result.warnings.push(`${label} OCR 失败：${error.message || '引擎不可用'}。保留原页面供人工检查。`);
      ocrUnavailable = true;
      if (worker) { await worker.terminate().catch(() => {}); worker = null; }
      return null;
    } finally { if (prepared) releaseCanvas(prepared.canvas); if (cropped) releaseCanvas(cropped.canvas); }
  }
  async function recognizeDrawing(canvas,label) {
    const plan=drawingOCRPlan(canvas.width,canvas.height,ocrRegion),passes=[];
    let primaryData=null,primaryId=null;
    for(const pass of plan) {
      checkAbort(signal);
      notify(onProgress,`${label}：工程图增强 ${passes.length+1} / ${plan.length}（${pass.kind==='whole'?'全页':'局部'}）…`);
      const data=await recognize(canvas,`${label} · ${pass.id}`,pass);
      if(!data)break;
      const space=data.ocrSpace||{width:canvas.width,height:canvas.height,area:pass.area};
      const evidence=drawingOCRPass(data,space.width,space.height,{...pass,area:space.area,language:ocrLanguage,removedPixels:data.drawingProcessing?.removedPixels||0});
      passes.push(evidence);
      if(!primaryData||(!primaryData.text?.trim()&&data.text?.trim())){primaryData=data;primaryId=pass.id;}
    }
    if(!primaryData)return null;
    return {...primaryData,drawingOCR:{version:1,language:ocrLanguage,width:canvas.width,height:canvas.height,
      primaryPass:primaryId,passes,complete:passes.length===plan.length,plannedPasses:plan.length,
      reconciliation:'independent-evidence',preprocessing:'original-render+separate-line-cleanup-pass'}};
  }
  function applyOCR(output,data,canvas) {
    output.text=textFromOCR(data);output.method='ocr';output.regions=ocrEvidence(data,canvas);
    output.ocrRegion=data.ocrSpace?.area||null;output.ocrConfidence=data.confidence;output.tableProcessing=data.tableProcessing||null;
    if(data.drawingOCR){
      output.drawingOCR=data.drawingOCR;
      output.regions=data.drawingOCR.passes.find(pass=>pass.id===data.drawingOCR.primaryPass)?.regions||output.regions;
    }
  }
  try {
    if (ext === 'pdf') {
      notify(onProgress, '读取 PDF 文本与页面…'); pdf = await loadPdf(buffer, signal); buffer = null;
      if (pdf.numPages > INGEST_LIMITS.pdfPages) throw new Error(`PDF 共 ${pdf.numPages} 页，当前最多支持 ${INGEST_LIMITS.pdfPages} 页，请拆分后导入。`);
      const selectedPages = parseOCRPages(options.ocrPages, pdf.numPages);
      if (explicitOCR && !selectedPages && pdf.numPages > INGEST_LIMITS.implicitOCRPages) throw new Error(`PDF 共 ${pdf.numPages} 页；请指定 OCR 页码（例如 1,3-5），或启用仅扫描页自动 OCR。`);
      if (selectedPages) result.warnings.push(`已选择对第 ${[...selectedPages].sort((a,b)=>a-b).join('、')} 页执行 OCR，其余页保留文本层${autoOCR ? '，无文本页仍自动识别' : ''}。`);
      let skippedOCR = 0;
      for (let i = 1; i <= pdf.numPages; i++) {
        checkAbort(signal); notify(onProgress, `读取第 ${i} / ${pdf.numPages} 页…`);
        let page, canvas;
        const output = emptyPage(i);
        try {
          page = await abortable(pdf.getPage(i), signal);
          const viewport = page.getViewport({ scale: 1 }); output.width = viewport.width; output.height = viewport.height;
          try {
            const extracted = await readPDFText(page, { signal });
            output.text = extracted.text; output.regions = extracted.regions;
            if (extracted.removedTextItems) result.warnings.push(`第 ${i} 页已排除 ${extracted.removedTextItems} 个位于裁剪范围外或不可见的 PDF 文本项。`);
            if (extracted.unmappedTextItems) result.warnings.push(`第 ${i} 页有 ${extracted.unmappedTextItems} 个文本项未能匹配绘制指令，裁剪可见性未确认，请核对原页。`);
          } catch (error) {
            if (signal?.aborted) throw abortError();
            result.warnings.push(`第 ${i} 页文本层读取失败：${error.message}。`);
          }
          // Every page receives a low-resolution thumbnail/hash; no full-size canvas is retained.
          try {
            canvas = await renderPage(page, 720, signal);
            output.thumbnail = thumbnail(canvas); output.hash = hashCanvas(canvas);
          } catch (error) {
            if (signal?.aborted) throw abortError();
            result.warnings.push(`第 ${i} 页预览渲染失败：${error.message}。`);
          }
          const shouldOCR = (explicitOCR && (!selectedPages || selectedPages.has(i))) || (autoOCR && !output.text.trim());
          if (shouldOCR && ocrUnavailable) skippedOCR++;
          else if (shouldOCR) {
            releaseCanvas(canvas); canvas = null;
            try {
              canvas = await renderPage(page, drawingMode?4000:(ocrRegion ? 4200 : 2400), signal,drawingMode);
              if (requestedRotation) {
                const turned = rotatedCanvas(canvas, requestedRotation); releaseCanvas(canvas); canvas = turned;
                output.regions = rotateRegions(output.regions, requestedRotation);
                if (requestedRotation === 90 || requestedRotation === 270) [output.width, output.height] = [output.height, output.width];
                output.thumbnail = thumbnail(canvas); output.hash = hashCanvas(canvas); output.rotation = requestedRotation;
              }
              if(drawingMode)output.preview=thumbnail(canvas,2400);
              const data = await (drawingMode?recognizeDrawing:recognize)(canvas, `第 ${i} / ${pdf.numPages} 页`);
              if (data?.text?.trim()) applyOCR(output,data,canvas);
              else if(data?.drawingOCR)output.drawingOCR=data.drawingOCR;
              if (requestedRotation) result.warnings.push(`第 ${i} 页按选择顺时针旋转 ${requestedRotation}° 识别，OCR 置信度 ${Number.isFinite(data?.confidence) ? Math.round(data.confidence) + '%' : '不可用'}。`);
              if (data && !data.text?.trim()) result.warnings.push(`第 ${i} 页 OCR 没有识别出文字${output.text.trim() ? '，已保留原文本层' : ''}。`);
            } catch (error) {
              if (signal?.aborted) throw abortError();
              result.warnings.push(`第 ${i} 页 OCR 渲染失败：${error.message}。`);
            }
          }
          if (!output.text.trim()) result.warnings.push(`第 ${i} 页没有可用文本${shouldOCR ? '，请人工核对' : '，可启用自动 OCR'}。`);
          output.type = classifyPage(output.text);
        } catch (error) {
          if (signal?.aborted || error.name === 'AbortError') throw abortError();
          output.method = 'error'; result.warnings.push(`第 ${i} 页处理失败：${error.message}。`);
        } finally {
          releaseCanvas(canvas); if (page) page.cleanup();
        }
        result.pages.push(output);
        // Yield between pages so cancel controls remain usable on large catalogs.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (skippedOCR) result.warnings.push(`OCR 引擎失败后，另有 ${skippedOCR} 页未执行 OCR；页面预览已保留。`);
    } else {
      buffer = null;
      const image = await imageCanvas(file, signal, drawingMode?4000:(ocrRegion ? 6000 : 3000));
      let canvas = image.canvas, rotation = requestedRotation;
      if (rotation) { canvas = rotatedCanvas(image.canvas, rotation); releaseCanvas(image.canvas); }
      const quarter = rotation === 90 || rotation === 270;
      const output = { ...emptyPage(1, 'image'), width: quarter ? image.height : image.width, height: quarter ? image.width : image.height, rotation };
      try {
        if (explicitOCR || autoOCR) {
          let data = await (drawingMode?recognizeDrawing:recognize)(canvas, '图片');
          // Probe only when OCR reports poor confidence and no orientation was explicitly selected.
          if (!drawingMode && !ocrRegion && options.rotation == null && Number.isFinite(data?.confidence) && data.confidence < 55 && !ocrUnavailable) {
            const candidates = [];
            for (const angle of [0,90,270,180]) {
              checkAbort(signal); const probe = rotatedCanvas(canvas, angle, 1000);
              try {
                notify(onProgress, `文字方向检测：顺时针 ${angle}°…`);
                const candidate = await recognize(probe, `方向检测 ${angle}°`);
                if (Number.isFinite(candidate?.confidence) && candidate?.text?.trim()) candidates.push({ angle, confidence: candidate.confidence });
              } finally { releaseCanvas(probe); }
            }
            candidates.sort((a,b) => b.confidence - a.confidence);
            const best = candidates[0], base = candidates.find(c => c.angle === 0);
            if (best && best.angle !== 0 && best.confidence > (base?.confidence || 0) + 3) {
              rotation = best.angle; const turned = rotatedCanvas(canvas, rotation); releaseCanvas(canvas); canvas = turned;
              data = await recognize(canvas, `按 ${rotation}° 方向重新识别`);
              output.rotation = rotation;
              if (rotation === 90 || rotation === 270) { output.width = image.height; output.height = image.width; }
            }
            result.warnings.push(`低置信度方向检测选择顺时针 ${rotation}°，最终 OCR 置信度 ${Number.isFinite(data?.confidence) ? Math.round(data.confidence) + '%' : '不可用'}；请人工核对方向与文字。`);
          } else if (rotation) result.warnings.push(`图片按选择顺时针旋转 ${rotation}° 识别。`);
          if (data) applyOCR(output,data,canvas);
          if(drawingMode)output.preview=thumbnail(canvas,2400);
          if (!output.text.trim()) result.warnings.push('未识别出图片文字，请检查清晰度并人工核对。');
        } else result.warnings.push('图片已建立外观索引；启用 OCR 可提取文字。');
        output.thumbnail = thumbnail(canvas); output.hash = hashCanvas(canvas);
        output.type = classifyPage(output.text); result.pages.push(output);
      } finally { releaseCanvas(canvas); }
    }
    checkAbort(signal);
    const cover = result.pages.find(page => page.thumbnail);
    result.thumbnail = cover?.thumbnail || ''; result.hash = cover?.hash || '';
    if (usedOCR) result.warnings.push(`OCR 语言：${ocrLanguage}。OCR 结果未经人工确认；尺寸、公差和特殊符号需逐项核对。`);
    if (usedOCR && options.ocrTable === true&&!drawingMode) result.warnings.push('已启用表格 OCR：清理长细网格线并按单文本块识别；字符与料号仍须对照原图核验。');
    if (usedOCR && drawingMode) result.warnings.push('工程图增强 OCR 已保存全页与重叠网格的独立识别证据、文字框及置信度；不同轮次的数值或符号差异须复核，未自动修正数字。旋转方向以所选方向为准。');
    if (usedOCR && ocrRegion) result.warnings.push('本次 OCR 识别范围限于所选区域；未识别到文字时 PDF 保留原文本层。原整页预览保留，识别框已映射回整页；区域坐标以旋转后的页面为准。');
    result.warnings.push('页面类型由文字规则粗分；文本框来自 PDF 字体度量或 OCR 检测框，不能代替工程语义定位。');
    return result;
  } finally {
    buffer = null;
    if (worker) await worker.terminate().catch(() => {});
    if (pdf) await pdf.destroy().catch(() => {});
  }
}
export function ocrDocument(file, onProgress, options = {}) { return readFile(file, onProgress, { ...options, ocr: true }); }

/** Prepare only the selected source page for a server-side VLM. No upload occurs here. */
export async function renderVisionPage(file,pageNumber=1,{signal}={}) {
  if(!file||typeof file.arrayBuffer!=='function')throw new Error('当前资料没有原始文件，请重新导入原图。');
  const ext=validate(file);if(!['pdf','png','jpg','jpeg','webp'].includes(ext))throw new Error('视觉提取支持PDF或图片。');
  if(!Number.isInteger(pageNumber)||pageNumber<1)throw new Error('请选择有效页码。');
  let data=await abortable(file.arrayBuffer(),signal),pdf,page,canvas;
  const sha=await abortable(crypto.subtle.digest('SHA-256',data),signal);
  const source_document_sha256=Array.from(new Uint8Array(sha),b=>b.toString(16).padStart(2,'0')).join('');
  try {
    if(ext==='pdf'){
      pdf=await loadPdf(data,signal);data=null;
      if(pageNumber>pdf.numPages)throw new Error('视觉提取页码超出文档范围。');
      page=await abortable(pdf.getPage(pageNumber),signal);canvas=await renderPage(page,4000,signal,true);
    }else{
      if(pageNumber!==1)throw new Error('图片仅有一页。');
      canvas=(await imageCanvas(file,signal,4000)).canvas;
    }
    checkAbort(signal);const image_base64=canvas.toDataURL('image/png').split(',')[1];
    if(image_base64.length>28*1024*1024)throw new Error('该页渲染图像过大，请压缩原图或拆分页面后重试。');
    return {image_base64,width:canvas.width,height:canvas.height,source_document_sha256,page:pageNumber};
  }finally{releaseCanvas(canvas);if(page)page.cleanup();if(pdf)await pdf.destroy().catch(()=>{});data=null;}
}
