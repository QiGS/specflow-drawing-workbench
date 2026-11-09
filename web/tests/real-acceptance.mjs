/**
 * Read-only, manually labelled real-document acceptance checks.
 * Usage: node tests/real-acceptance.mjs /path/to/工程图纸资料_2026-11-04 /path/to/swagelok-gsl5.pdf [report.json]
 * This deliberately exits 1 for unmet gold checks. It is not an OCR or browser test.
 * The selected documents are external; neither PDF bytes nor full source text are written to the repository.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { readPDFText } from '../ingest.mjs';
import { parseDocument, calculateQuote } from '../engine.mjs';
import { generateInstructions } from '../instructions.mjs';

const [root, publicPDF, output] = process.argv.slice(2);
if (!root || !publicPDF) throw new Error('Usage: node tests/real-acceptance.mjs /path/to/工程图纸资料_2026-11-04 /path/to/swagelok-gsl5.pdf [report.json]');
pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const canonical = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s_]/g, '').replaceAll('−', '-');
const exact = (actual, expected) => canonical(actual) === canonical(expected);
const field = (names, value, model) => ({ label: `${model ? `${model} / ` : ''}${names[0]} = ${value}`, names, value, model });
// Gold values were read from rendered source pages, not copied from engine output or filenames.
// A value in page text alone does not pass: it must have the correct field name and product association.
const samples = [
  { id:'motor-1hp', file:'杰牌独立图纸与模型/D129_jdess1-18-56c.pdf', page:1, checks:[
    field(['产品型号'], 'JDESS1-18-56C'),
    field(['额定电压','工作电压','电压','Voltage'], '208-230/460', 'JDESS1-18-56C'),
    field(['防护等级','IP'], '69K', 'JDESS1-18-56C'),
    field(['材料','轴材料','Shaft Material'], '304 Stainless Steel', 'JDESS1-18-56C'),
  ] },
  { id:'motor-575v', file:'杰牌独立图纸与模型/D130_jdess1-18-575-56c.pdf', page:1, checks:[
    field(['产品型号'], 'JDESS1-18-575-56C'),
    field(['额定电压','工作电压','电压','Voltage'], '575', 'JDESS1-18-575-56C'),
    field(['防护等级','IP'], '69K', 'JDESS1-18-575-56C'),
  ] },
  { id:'motor-2hp', file:'杰牌独立图纸与模型/D139_jdess2-18-56c.pdf', page:1, checks:[
    // The source says JDPESS; the filename says jdess. The source is the ground truth.
    field(['产品型号'], 'JDPESS2-18-56C'),
  ] },
  { id:'motor-143tc', file:'杰牌独立图纸与模型/D128_jdess1-18-143tcrd.pdf', page:1, checks:[
    field(['产品型号'], 'JDESS1-18-143TCRD'),
  ] },
  { id:'bearing-table', file:'原始资料/S02_索特回转支承产品手册.pdf', page:19, checks:[
    field(['产品型号'], 'SSN0250/25CWH'),
    field(['滚道直径','直径'], '250', 'SSN0250/25CWH'),
    field(['总重量','重量'], '25.5', 'SSN0250/25CWH'),
    field(['总高度','高度'], '60', 'SSN0250/25CWH'),
  ] },
  { id:'cylinder-table', file:'原始资料/S04_中兴液压油缸产品手册.pdf', page:10, checks:[
    field(['产品型号'], '对中油缸'),
    field(['缸径','直径'], '90', '对中油缸'),
    field(['杆径'], '50', '对中油缸'),
    field(['工作压力','压力'], '18', '对中油缸'),
  ] },
  { id:'installation-notes', file:'杰牌产品目录与说明书/D023_worm-gear-unit-user-manual.pdf', page:6, checks:[
    { label:'安装注意事项保留禁止锤击带轮/联轴器的原文', names:['技术要求','注意事项','警告'], pattern:/never use hammer.*belt pulleys/i },
  ] },
];

const result = {
  generatedAt:new Date().toISOString(), mode:'PDF visible text via production readPDFText (clip filtering + layout reconstruction) + production rule engine; NO OCR',
  annotation:'Small, purpose-selected, manually inspected challenge set; not a representative accuracy benchmark. Public BOM used in fixes is regression data.',
  sourceURL:'https://www.swagelok.com/-/media/distributor-media/l-n/london/services/grab-sampling-systems/data-sheets/13-gsl5.ashx',
  documents:[], checks:[], errors:[],
};
function check(group, name, passed, details) {
  result.checks.push({group, name, passed:Boolean(passed), ...(details ? {details} : {})});
}
async function readSelected(file, pageNumber) {
  const bytes=await fs.readFile(file);
  const task=pdfjs.getDocument({data:new Uint8Array(bytes), verbosity:0,
    cMapUrl:new URL('../vendor/pdfjs/cmaps/',import.meta.url).pathname, cMapPacked:true,
    standardFontDataUrl:new URL('../vendor/pdfjs/standard_fonts/',import.meta.url).pathname });
  try {
    const pdf=await task.promise, selectedPages=pageNumber===null?Array.from({length:pdf.numPages},(_,i)=>i+1):[pageNumber], pages=[];
    for(const num of selectedPages) {
      const page=await pdf.getPage(num), extracted=await readPDFText(page);
      pages.push({page:num,...extracted,method:'pdf-text'});
    }
    const parsed=parseDocument(pages);
    return {id:path.basename(file), name:path.basename(file), ...parsed,
      audit:{file:path.basename(file),selectedPages,pageCount:pdf.numPages,sha256:createHash('sha256').update(bytes).digest('hex'),textCharacters:pages.reduce((n,p)=>n+p.text.length,0),candidateFields:parsed.fields.length,candidateBOMRows:parsed.bom.length,
        visibility:pages.map(p=>({page:p.page,removedTextItems:p.removedTextItems,unmappedTextItems:p.unmappedTextItems}))}};
  } finally { await task.destroy(); }
}
for (const sample of samples) {
  try {
    const doc=await readSelected(path.join(root,sample.file),sample.page);
    result.documents.push({...doc.audit, dataset:'new-corpus-challenge'});
    for (const gold of sample.checks) {
      const matches=doc.fields.filter(f => f.page===sample.page && gold.names.some(n=>exact(f.name,n)) &&
        (gold.pattern ? gold.pattern.test(f.value) : exact(f.value,gold.value)) && (!gold.model || exact(f.model,gold.model)));
      check('new-corpus-field-gold',`${doc.name} p${sample.page}: ${gold.label}`,matches.length>0);
    }
    if(doc.fields.length) check('provenance',`${doc.name}: 候选均有原文/页码且待复核`,doc.fields.every(f=>f.evidence?.trim() && f.page===sample.page && f.status==='pending'));
    else result.checks.push({group:'provenance',name:`${doc.name}: 无候选，不能验证候选来源`,passed:null,skipped:true});
    if(sample.id==='cylinder-table') check('false-positive-guard',`${doc.name}: 表头不是产品型号`,
      !doc.fields.some(f=>f.name==='产品型号'&&/工作温度|工作压力|缸径|杆径/.test(f.value)),
      {observedModelValues:doc.fields.filter(f=>f.name==='产品型号').map(f=>f.value)});
    if(sample.id==='installation-notes') {
      const draft=generateInstructions(doc);
      check('instruction-workflow','真实安装手册草稿仍为8章、draft、缺失必填项时阻断导出',draft.sections.length===8&&draft.status==='draft'&&draft.missing.length>0&&draft.exportBlocked);
    }
  } catch(error) { result.errors.push({file:sample.file,error:error.message}); }
}

try {
  // Read the WHOLE document: checking only p2 misses false BOM rows created from p1 diagrams and prose.
  const doc=await readSelected(publicPDF,null);
  result.documents.push({...doc.audit,dataset:'official-public-BOM-regression'});
  check('BOM-regression','Swagelok全2页: 仅24个明细行',doc.bom.length===24,{actual:doc.bom.length});
  check('BOM-regression','Swagelok p1无BOM，不能将流程数字与操作文本当作明细行',!doc.bom.some(r=>r.page===1));
  const goldRows=[
    ['1','SS-43YTLF2-10147',1,''],['2','PGI-63S-BG1-BAQX-G',1,''],
    ['3','VAF-G2-05L-1-0-WZ',2,''],['4','KPR1CJA412A60000',1,''],
    ['5','KPR1FJA412A60000',1,''],['6','PGI-63S-BG10-BAQX-G',1,''],
    ['7','SS-MVS-32OZ-32-S4-S4-VI',1,''],['17','SS-400-61',5,''],
    ['23','98164A106',10,''],['24','SS-T4-S-035-20',162.36,'in.'],
  ];
  for(const [item,partNumber,qty,unit] of goldRows) {
    const row=doc.bom.find(r=>r.page===2&&String(r.item)===item);
    check('BOM-regression',`Swagelok p2 BOM item ${item}: 料号、数量、单位`,
      row&&exact(row.partNumber,partNumber)&&row.qty===qty&&exact(row.unit,unit),{expected:{item,partNumber,qty,unit},actual:row?{partNumber:row.partNumber,qty:row.qty,unit:row.unit}:null});
  }
  check('provenance','Swagelok: 每个BOM行有p2原文且待复核',doc.bom.every(r=>r.page===2&&r.evidence?.trim()&&r.status==='pending'));
  const tube=doc.bom.find(r=>r.page===2&&String(r.item)==='24');
  if(tube) {
    // A declared test price, not a price inferred from the source or a market quotation.
    const quote=calculateQuote([{...tube,unitPrice:1}]);
    check('quote-workflow','162.36 in × 测试单价1 CNY/in = 162.36 CNY',quote.material===162.36&&quote.total===162.36,{priceOrigin:'explicit test input, not source or market pricing'});
    const draft=generateInstructions(doc);
    check('instruction-workflow','真实BOM指导书保留162.36 in.及p2来源',draft.sections[2].items.some(i=>i.category==='evidence'&&/162\.36 in\./.test(i.text)&&i.source.page===2));
    check('instruction-workflow','BOM不能自动推导作业步骤',draft.sections[3].items.every(i=>i.category!=='evidence')&&draft.status==='draft');
  }
} catch(error) { result.errors.push({file:path.basename(publicPDF),error:error.message}); }

result.summary={passed:result.checks.filter(c=>c.passed===true).length,failed:result.checks.filter(c=>c.passed===false).length,skipped:result.checks.filter(c=>c.skipped).length,errors:result.errors.length};
result.byGroup=Object.fromEntries([...new Set(result.checks.map(c=>c.group))].map(group=>[group,{passed:result.checks.filter(c=>c.group===group&&c.passed===true).length,failed:result.checks.filter(c=>c.group===group&&c.passed===false).length,skipped:result.checks.filter(c=>c.group===group&&c.skipped).length}]));
const json=JSON.stringify(result,null,2)+'\n';
if(output) await fs.writeFile(output,json);
console.log(JSON.stringify({summary:result.summary,byGroup:result.byGroup,documents:result.documents,failures:result.checks.filter(c=>c.passed===false),errors:result.errors},null,2));
if(result.summary.failed||result.summary.errors) process.exitCode=1;
