/** Keep reviewed/manual data authoritative when a new extraction is reconciled. */
const text=v=>String(v??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const key=v=>text(v).toLocaleLowerCase();
const clone=v=>structuredClone(v);
const samePage=(a,b)=>Number(a.page)===Number(b.page);
const editedFieldActions=new Set(['修改字段','修改字段名','人工标注关联']);
const fieldEvents=(doc,f)=>(doc.history||[]).filter(h=>editedFieldActions.has(h.action)&&h.fieldId===f.id);
const reviewed=f=>f.status==='approved'||f.status==='rejected';
const protectedField=(doc,f)=>reviewed(f)||f.method==='manual'||f.userEdited===true||fieldEvents(doc,f).length>0||f.evidence==='人工补充';
function boxes(item){
  const r=item.region??item.bbox;
  return (r?.boxes||[r]).filter(Boolean).map(b=>({x:b.x,y:b.y,width:b.width??b.w,height:b.height??b.h}))
    .filter(b=>[b.x,b.y,b.width,b.height].every(Number.isFinite)&&b.width>0&&b.height>0);
}
function positionScore(a,b){
  let best=0;
  for(const x of boxes(a))for(const y of boxes(b)){
    const area=Math.max(0,Math.min(x.x+x.width,y.x+y.width)-Math.max(x.x,y.x))*Math.max(0,Math.min(x.y+x.height,y.y+y.height)-Math.max(x.y,y.y));
    const fraction=area/Math.min(x.width*x.height,y.width*y.height);
    if(fraction>.4)best=Math.max(best,2+fraction);
    const dx=Math.abs(x.x+x.width/2-y.x-y.width/2),dy=Math.abs(x.y+x.height/2-y.y-y.height/2);
    if(dx<.012&&dy<.008)best=Math.max(best,1-(dx/.012+dy/.008)/3);
  }
  return best;
}
function fieldNames(doc,f){
  return new Set([f.name,...fieldEvents(doc,f).filter(h=>h.action==='修改字段名').flatMap(h=>[h.before,h.after])].filter(Boolean).map(key));
}
function fieldScore(doc,old,next){
  if(!samePage(old,next)||!fieldNames(doc,old).has(key(next.name)))return 0;
  const score=positionScore(old,next);
  if(score||boxes(old).length&&boxes(next).length)return score;
  // Exact evidence is useful for manually supplied text, but only a unique match is accepted below.
  return text(old.evidence)&&key(old.evidence)===key(next.evidence) ? .25 : 0;
}
function uniqueBest(scored){
  const sorted=scored.filter(s=>s.score>0).sort((a,b)=>b.score-a.score);
  return sorted.length&&(!sorted[1]||sorted[0].score-sorted[1].score>.05)?sorted[0]:null;
}
const sameValue=(a,b)=>key(a.value)===key(b.value)&&key(a.unit)===key(b.unit)&&JSON.stringify(a.tolerance??null)===JSON.stringify(b.tolerance??null)&&key(a.limit)===key(b.limit);
function keepWithCandidates(old,matched){
  const kept={...clone(old),preservedByReparse:true},changed=matched.filter(f=>!sameValue(old,f));
  if(changed.length){
    const prior=kept.reparseCandidates||[],seen=new Set(prior.map(c=>JSON.stringify([c.value,c.evidence,c.region])));
    kept.reparseCandidates=[...prior];
    for(const item of changed){
      const candidate=clone(item),signature=JSON.stringify([candidate.value,candidate.evidence,candidate.region]);
      if(!seen.has(signature)){seen.add(signature);kept.reparseCandidates.push(candidate);}
    }
    kept.reparseConflict=true;
  }
  return kept;
}
function uniqueIds(items,reserved,prefix){
  const used=new Set();let sequence=1;
  return items.map(({item,keep})=>{
    const result=item;let id=text(result.id)||`${prefix}-${sequence++}`;
    if(!keep&&(reserved.has(id)||used.has(id)))do{id=`${prefix}-candidate-${sequence++}`;}while(reserved.has(id)||used.has(id));
    // Preserve all original reviewed IDs; malformed duplicate originals are not silently rewritten.
    result.id=id;used.add(id);return result;
  });
}
function reconcileFields(doc,incoming,warnings){
  const protectedItems=(doc.fields||[]).filter(f=>protectedField(doc,f));
  const matched=new Map(protectedItems.map(f=>[f,[]])),assignments=new Map();
  for(const next of incoming){
    const selected=uniqueBest(protectedItems.map(old=>({old,score:fieldScore(doc,old,next)})));
    if(selected&&(selected.score!==.25||incoming.filter(other=>fieldScore(doc,selected.old,other)===.25).length===1)){
      assignments.set(next,selected.old);matched.get(selected.old).push(next);
    }
  }
  const emitted=new Set(),items=[];
  for(const next of incoming){
    const old=assignments.get(next);
    if(old){if(!emitted.has(old)){items.push({item:keepWithCandidates(old,matched.get(old)),keep:true});emitted.add(old);}continue;}
    const fresh={...clone(next),status:'pending',preservedByReparse:false,requiresReconciliation:false,possibleReviewedFieldIds:[]};
    const possible=protectedItems.filter(f=>samePage(f,next)&&fieldNames(doc,f).has(key(next.name))&&
      (!boxes(f).length||!boxes(next).length||positionScore(f,next)>0));
    if(possible.length){fresh.requiresReconciliation=true;fresh.possibleReviewedFieldIds=possible.map(f=>f.id);}
    items.push({item:fresh,keep:false});
  }
  for(const old of protectedItems)if(!emitted.has(old))items.push({item:{...clone(old),preservedByReparse:true},keep:true});
  if(protectedItems.length)warnings.push(`重新解析保留 ${protectedItems.length} 项人工修订或已复核字段；已否决项目不会因新 OCR 编号而恢复。`);
  const unknown=items.filter(x=>x.item.requiresReconciliation).length;
  if(unknown)warnings.push(`${unknown} 项新候选与现有人工字段无法可靠关联，已分别保留，需核对来源后取舍。`);
  const changed=[...matched].filter(([old,rows])=>rows.some(row=>!sameValue(old,row))).length;
  if(changed)warnings.push(`${changed} 项新识别与人工值不同：保留人工值和原复核状态，新结果存于 reparseCandidates。`);
  return uniqueIds(items,new Set(protectedItems.map(f=>text(f.id)).filter(Boolean)),'field');
}
function bomEvents(doc,row){
  return (doc.history||[]).filter(h=>h.action==='修改BOM'&&(!h.before?.id||h.before.id===row.id)||h.action==='BOM复核'&&h.rowId===row.id);
}
const protectedBOM=(doc,row)=>reviewed(row)||row.method==='manual'||row.userEdited===true||row.evidence==='人工补充'||bomEvents(doc,row).length>0;
function bomScore(doc,old,next){
  if(!samePage(old,next))return 0;
  const past=bomEvents(doc,old).map(h=>h.before).filter(Boolean);
  const identities=[old,...past];
  if(!identities.some(r=>key(r.partNumber)&&key(r.partNumber)===key(next.partNumber)||key(r.name)&&key(r.name)===key(next.name)))return 0;
  const score=positionScore(old,next);
  if(score||boxes(old).length&&boxes(next).length)return score;
  return text(old.evidence)&&key(old.evidence)===key(next.evidence) ? .25 : 0;
}
function reconcileBOM(doc,incoming,warnings){
  const prior=doc.bom||[],protectedRows=prior.filter(r=>protectedBOM(doc,r));
  if(!protectedRows.length)return uniqueIds(incoming.map(item=>({item:{...clone(item),status:'pending'},keep:false})),new Set(),'bom');
  const matched=new Map(),used=new Set();
  for(const old of protectedRows){
    const selected=uniqueBest(incoming.map(next=>({next,score:bomScore(doc,old,next)})));
    if(!selected||used.has(selected.next)){
      warnings.push('新 BOM 无法与人工修订/已复核行可靠对应，已完整保留原 BOM；新识别未覆盖原数量、料号和复核状态。');
      return clone(prior);
    }
    used.add(selected.next);matched.set(selected.next,old);
  }
  warnings.push(`重新解析保留 ${protectedRows.length} 行人工修订或已复核 BOM。`);
  return uniqueIds(incoming.map(next=>({item:matched.has(next)?clone(matched.get(next)):{...clone(next),status:'pending'},keep:matched.has(next)})),new Set(protectedRows.map(r=>text(r.id)).filter(Boolean)),'bom');
}

/** Pure reconciliation: does not mutate doc, result, audit history, or source pages. */
export function reconcileExtraction(doc={},result={}){
  const warnings=[...(result.warnings||[])];
  const fields=reconcileFields(doc,result.fields||[],warnings),bom=reconcileBOM(doc,result.bom||[],warnings);
  return {fields,bom,warnings:[...new Set(warnings)]};
}
