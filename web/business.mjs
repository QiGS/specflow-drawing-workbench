/** Traceable commercial drafts and review samples; no inferred prices or model training. */
const clone = value => JSON.parse(JSON.stringify(value));
const norm = value => String(value ?? '').trim();
const identity = row => JSON.stringify([norm(row.partNumber), norm(row.name || row.partNumber), norm(row.material), norm(row.unit)]);
export const bomSignature = bom => JSON.stringify((bom || []).filter(r=>r.status!=='rejected').map(r => [identity(r), r.qty, r.item || '', r.page || 1]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));

export function reconcileQuote(doc) {
  const previous = doc.quote, signature = bomSignature(doc.bom), changed = previous && previous.bomSignature !== signature;
  if (previous?.bomSignature === signature) return clone(previous);
  const buckets = new Map();
  for (const row of previous?.rows || []) if (row.source === 'bom') {
    const key = identity(row); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row);
  }
  const accepted=(doc.bom || []).filter(row=>row.status!=='rejected');
  const repeated=accepted.some((r,i)=>accepted.slice(0,i).some(p=>r.item && p.item===r.item && p.page!==r.page));
  const rows = accepted.map(row => {
    const prior = buckets.get(identity(row))?.shift();
    return { partNumber:row.partNumber || '', name:row.name || row.partNumber, material:row.material || '', unit:row.unit || '', qty:row.qty, unitPrice:prior?.unitPrice ?? null, priceSource:prior?.priceSource || '', source:'bom' };
  });
  rows.push(...(previous?.rows || []).filter(r=>r.source==='manual').map(clone));
  return { rows, options:clone(previous?.options || {labor:0,overheadPercent:0,marginPercent:0,taxPercent:0}), bomSignature:signature, needsReview:Boolean(changed), duplicateBOM:repeated, priceReference:previous?.priceReference || '', currency:'CNY' };
}

export function quoteIssues(quote) {
  const issues=[];
  if (quote.duplicateBOM) issues.push('不同页面有重复 BOM 项号，请在 BOM 复核中否决重复行后报价，避免重复计费');
  if (quote.needsReview) issues.push('BOM 已变化，请重新核对数量、物料和费用后确认');
  if (!quote.rows?.length) issues.push('报价尚无项目');
  for (const [i,row] of (quote.rows || []).entries()) {
    if (row.qty === null || row.qty === '' || !Number.isFinite(Number(row.qty)) || Number(row.qty)<=0) issues.push(`第 ${i+1} 项用量须为正数`);
    if (row.unitPrice === null || row.unitPrice === '' || !Number.isFinite(Number(row.unitPrice)) || Number(row.unitPrice)<=0) issues.push(`第 ${i+1} 项缺少有效单价`);
  }
  if (!norm(quote.priceReference)) issues.push('请填写价格来源或测算依据');
  return issues;
}

export function applyHistoricalPrices(quote, snapshot) {
  const next=clone(quote), prices=new Map();
  for (const row of snapshot.rows || []) if (row.source==='bom' && Number(row.unitPrice)>0) {
    const key=identity(row); const existing=prices.get(key);
    prices.set(key, existing && existing.price!==Number(row.unitPrice) ? {ambiguous:true} : {price:Number(row.unitPrice),ambiguous:existing?.ambiguous});
  }
  let matched=0;
  next.rows=next.rows.map(row=>{const price=prices.get(identity(row)); if(row.source!=='bom'||!price||price.ambiguous)return row; matched++;return {...row,unitPrice:price.price,priceSource:`历史报价 ${snapshot.document} · ${snapshot.at}`};});
  next.needsReview=true;
  next.priceReference=`参考历史报价 ${snapshot.document} · ${snapshot.at}。${matched} 项按料号、名称、材料、单位匹配；适用性待确认。`;
  return {quote:next,matched};
}

export function reviewSamples(documents) {
  return documents.flatMap(doc=>(doc.fields || []).filter(f=>['approved','rejected'].includes(f.status)).map(field=>({
    schemaVersion:1, task:'engineering_field_review', document:{id:doc.id,name:doc.name,contentId:doc.contentId || null},
    page:field.page, region:field.region || null, evidence:field.evidence || '',
    decision:field.status, field:clone(field),
    // Parsing numbers fields again from field-1, so an ID alone cannot establish provenance.
    // Incomplete legacy/edit events stay in the document history, not a different field's sample.
    reviewEvents:(doc.history || []).filter(h=>norm(field.id) && h.fieldId===field.id && norm(field.name) && norm(field.value) &&
      Number.isInteger(field.page) && field.page>0 &&
      norm(h.field ?? h.name)===norm(field.name) && h.page===field.page &&
      h.value!==undefined && norm(h.value)===norm(field.value)).map(clone),
    trainingStatus:'not_trained', note:'人工复核记录；采纳表示本用户接受候选，不代表独立专家标注。'
  })));
}
