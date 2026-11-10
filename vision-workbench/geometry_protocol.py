"""Bounded, auditable protocol normalization; never corrects engineering claims."""
from __future__ import annotations
import copy
import re
from geometry_v2 import HAN, norm, region

VERSION='geometry-protocol-1.0'
TRANSLATIONS={
    'CONTACT PIN':'接触针', 'BACK COVER':'后盖', 'HOUSING':'壳体', 'BODY':'本体',
    'TERMINAL':'端子', 'INSULATOR':'绝缘体', 'SPRING':'弹簧', 'SHELL':'外壳',
    'FRONT VIEW':'前视图', 'TOP VIEW':'俯视图', 'SIDE VIEW':'侧视图',
    'BOTTOM VIEW':'底视图', 'REAR VIEW':'后视图', 'SECTION VIEW':'剖视图',
    'DETAIL VIEW':'局部详图', 'NOTES':'技术说明', 'TECHNICAL NOTES':'技术说明',
    'RECOMMEND PCB LAYOUT COMPONENT SIDE':'推荐印制板布局（元件侧）',
    'RECOMMENDED PCB LAYOUT COMPONENT SIDE':'推荐印制板布局（元件侧）',
    'RECOMMEND PCB LAYOUT':'推荐印制板布局',
    'RECOMMENDED PCB LAYOUT':'推荐印制板布局',
    'COMPONENT SIDE':'元件侧',
}

def translate(value):
    if not isinstance(value,str) or HAN.search(value):return None
    key=' '.join(value.split()).upper()
    if key in TRANSLATIONS:return TRANSLATIONS[key]
    match=re.fullmatch(r'([1-9][0-9]{0,2})\s+PIN\s+POGO\s+PIN\s+CONNECTOR',key)
    if match:return match[1]+' 针弹簧针连接器'
    return None

def adapt(payload,old_observations):
    """Return a deep copy plus changes; leave unsupported deviations for rejection."""
    value=copy.deepcopy(payload);changes=[]
    if not isinstance(value,dict) or value.get('schema_version')!='geometry-2.0':return value,changes
    observations=copy.deepcopy(old_observations)
    for observation in value.get('observations',[]):
        if isinstance(observation,dict) and isinstance(observation.get('id'),str):
            if observation['id'] in observations:raise ValueError('Protocol adapter cannot overwrite an existing observation')
            observations[observation['id']]=observation
    parameters=value.get('parameters')
    if not isinstance(parameters,list):return value,changes
    def change(item,index,key,new,basis):
        old=copy.deepcopy(item.get(key));item[key]=copy.deepcopy(new)
        changes.append({'path':f'/parameters/{index}/{key}','old':old,'new':copy.deepcopy(new),'basis':basis})
    for index,p in enumerate(parameters):
        if not isinstance(p,dict):continue
        if p.get('status')=='provided':
            change(p,index,'status','candidate','Nonstandard provided status is downgraded to unreviewed candidate; never approved.')
        if type(p.get('id')) is int and 0<p['id']<=1_000_000:
            change(p,index,'id','p_'+str(p['id']),'Positive integer identifier converted to a string protocol identifier; duplicate check remains mandatory.')
        refs=p.get('evidence_ids',[])
        cited=[observations[i] for i in refs if isinstance(i,str) and i in observations] if isinstance(refs,list) else []
        quoted='\n'.join(o.get('raw_text','') for o in cited if isinstance(o.get('raw_text'),str))
        evidence=p.get('evidence_text')
        if isinstance(evidence,str) and '\\n' in evidence:
            decoded=evidence.replace('\\n','\n')
            if all(norm(line) in norm(quoted) for line in decoded.splitlines() if line.strip()):
                change(p,index,'evidence_text',decoded,'Literal newline separators decoded only when every resulting quote already occurs in cited source text.')
        if p.get('evidence_mode')=='explicit_note' and p.get('annotation_region') is None and len(cited)==1 and cited[0].get('region'):
            source_region=cited[0]['region']
            safe={key:source_region[key] for key in ('x','y','width','height') if key in source_region}
            checked=region(safe,'Cited explicit note region')
            change(p,index,'annotation_region',checked,'Exact region copied from the sole cited observation '+cited[0]['id']+'; no new object location inferred.')
        for key in ('component','view'):
            translated=translate(p.get(key))
            if translated is not None:
                change(p,index,key,translated,'Exact engineering-label dictionary translation; original English preserved in this audit entry.')
    ids=[p.get('id') for p in parameters if isinstance(p,dict)]
    if all(isinstance(i,str) for i in ids) and len(set(ids))!=len(ids):
        raise ValueError('Protocol identifier normalization would create duplicate ids')
    return value,changes
