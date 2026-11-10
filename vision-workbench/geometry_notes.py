"""Offline enrichment from explicitly named notes; never a new model inference.

This rule module preserves existing geometry candidates and only adds readable,
explicitly labelled thickness, conductor-area and wire-gauge notes. Source OCR
and prior geometry remain unreviewed. No filenames or expected values are rules.
"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import sys

from contract import strict_json, validate_payload
from geometry import validate_legacy
from geometry_v2 import DEFINITIONS, VERSION, HAN, region, validate

RULE_VERSION='explicit-note-1.0'
NUMBER=r'(?:\d+(?:\.\d+)?|\.\d+)'
TOL=rf'(?:\s*±\s*{NUMBER})?'
THICKNESS=re.compile(rf'\bTONGUE\s+(?:MATERIAL\s+)?(?:THK|THICKNESS)\s*:?\s*(?P<value>(?P<nominal>{NUMBER})(?P<tolerance>\s*±\s*{NUMBER})?(?:\s*(?P<unit>mm|cm|inches|inch|in))?(?:\s*\[(?:[^\]\r\n]){{1,80}}\])?)',re.I)
AREA=re.compile(rf'\b(?:CIRCULAR\s+MIL\s+AREA|CONDUCTOR\s+(?:CROSS[ -]?SECTION(?:AL)?\s+AREA|AREA))\s*:?\s*(?P<value>(?P<nominal>{NUMBER})(?P<range>\s*[-–]\s*{NUMBER})?\s*(?P<unit>mm²|mm\^2|mm2))',re.I)
AWG=re.compile(rf'\b(?:WIRE\s+(?:RANGE|SIZE)|CONDUCTOR\s+(?:RANGE|SIZE))\s*:?\s*(?P<value>(?P<nominal>{NUMBER})(?P<range>\s*[-–]\s*{NUMBER})?\s*(?P<unit>AWG))\b',re.I)
GENERAL_MM=re.compile(r'\bDIMENSIONS\s+IN\s+(?P<unit>mm)\s*\[\s*INCH(?:ES)?\s*\]',re.I)
PARAMETER_FIELDS={'id','key','instance_label','status','value_raw','nominal_raw','unit_raw','tolerance_raw','limit','annotation_region','object_region','leader_points','reason','evidence_text','evidence_ids','component','view','evidence_mode','missing_reason'}
LEGACY_FIELDS={'key','status','value_raw','nominal_raw','unit_raw','tolerance_raw','limit','annotation_region','object_region','leader_points','reason','evidence_text','evidence_ids'}


def canonical_sha(value):
    return hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def stage_result(stage):
    if isinstance(stage,dict) and 'result' in stage:
        stage=stage['result']
    if not isinstance(stage,dict) or stage.get('status') not in ('valid_unreviewed','partial_valid_unreviewed'):
        raise ValueError('Stage-one input must contain a validated candidate result')
    validation=stage.get('validation',{})
    if validation.get('schema_valid') is not True or validation.get('reference_links_valid') is not True:
        raise ValueError('Stage-one input has no positive schema/reference validation record')
    # Re-run the actual accepted payload contract, not just its declared status.
    validate_payload(stage.get('payload'),stage.get('sources'),stage.get('payload',{}).get('operation'))
    return stage

def full_region(observation,source):
    box=observation.get('region')
    if not box:
        return None
    box={k:box[k] for k in ('x','y','width','height')}
    region(box,'Source observation')
    roi=source.get('roi_normalized') or {'x':0,'y':0,'width':1,'height':1}
    region(roi,'Source image ROI')
    b={'x':roi['x']+box['x']*roi['width'],'y':roi['y']+box['y']*roi['height'],'width':box['width']*roi['width'],'height':box['height']*roi['height']}
    rotation=source.get('rotation_clockwise',0)
    if rotation==90:b={'x':b['y'],'y':1-b['x']-b['width'],'width':b['height'],'height':b['width']}
    elif rotation==180:b={'x':1-b['x']-b['width'],'y':1-b['y']-b['height'],'width':b['width'],'height':b['height']}
    elif rotation==270:b={'x':1-b['y']-b['height'],'y':b['x'],'width':b['height'],'height':b['width']}
    elif rotation!=0:raise ValueError('Source rotation is unsupported')
    return region(b,'Full-page observation')

def prior_payload(previous):
    if isinstance(previous,dict) and 'geometryResult' in previous:
        previous=previous['geometryResult']
    if not isinstance(previous,dict) or previous.get('schema_version') not in ('geometry-1.0',VERSION):
        raise ValueError('Previous geometry must be version 1.0 or 2.0')
    observations={}
    for observation in previous.get('observations',[]):
        if not isinstance(observation,dict) or not isinstance(observation.get('id'),str) or observation['id'] in observations:
            raise ValueError('Previous observations have invalid or duplicated identifiers')
        observations[observation['id']]=copy.deepcopy(observation)
    sha=previous.get('document_sha256');page=previous.get('page')
    if previous['schema_version']=='geometry-1.0':
        payload={'schema_version':'geometry-1.0','observations':[],'parameters':[{k:v for k,v in p.items() if k in LEGACY_FIELDS} for p in previous.get('parameters',[])]}
        checked=validate_legacy(payload,observations,sha,page)
        parameters=[]
        for p in checked['parameters']:
            item={k:copy.deepcopy(v) for k,v in p.items() if k in LEGACY_FIELDS}
            item.update(id='legacy_'+p['key'],instance_label=DEFINITIONS[p['key']]['label'],evidence_mode='explicit_note' if p['object_region'] is None and p['status']=='candidate' else 'leader')
            if item['status']=='unknown':item['status']='ambiguous'
            if not HAN.search(item['reason']):
                item['reason']='沿用既有模型的候选关联，尚未重新判断尺寸与部位。'
            parameters.append(item)
        payload={'schema_version':VERSION,'observations':[],'parameters':parameters,'unmapped_annotations':[]}
    else:
        payload={'schema_version':VERSION,'observations':[],'parameters':[{k:copy.deepcopy(v) for k,v in p.items() if k in PARAMETER_FIELDS} for p in previous.get('parameters',[])],'unmapped_annotations':copy.deepcopy(previous.get('unmapped_annotations',[]))}
        if previous.get('part_description'):payload['part_description']=previous['part_description']
    validate(payload,observations,sha,page)
    return previous,payload,observations,sha,page

def enrich(stage,previous):
    stage=stage_result(stage)
    previous,payload,observations,sha,page=prior_payload(previous)
    sources={s['image_id']:s for s in stage['sources'] if s.get('document_sha256')==sha and s.get('page')==page}
    if not sources:
        raise ValueError('Stage-one and previous geometry must reference the same original SHA/page')
    readable=[]
    for o in stage['payload']['observations']:
        if o.get('image_id') not in sources or o.get('kind')!='visible_text' or o.get('legibility')!='clear':
            continue
        mapped=full_region(o,sources[o['image_id']])
        if o['id'] in observations:
            if observations[o['id']]['raw_text']!=o['raw_text']:
                raise ValueError('Same observation identifier has conflicting source text')
            if observations[o['id']].get('region') is None and mapped:
                observations[o['id']]['region']=mapped
        else:
            observations[o['id']]={'id':o['id'],'raw_text':o['raw_text'],'region':mapped,'origin':'stage_one'}
        readable.append((o,mapped))
    general=[(o,GENERAL_MM.search(o['raw_text'])) for o,_ in readable if GENERAL_MM.search(o['raw_text'])]
    # The single explicit mm[INCHES] convention can support a bracketed material
    # thickness note. It never supports an unbracketed wire-insulation range.
    general_mm=general[0] if len(general)==1 else None
    added=[];skipped=[]
    existing={(p['key'],p.get('unit_raw'),p.get('nominal_raw'),p.get('value_raw')) for p in payload['parameters'] if p['status']=='candidate'}
    used_ids={p['id'] for p in payload['parameters']}
    for observation,box in readable:
        raw=observation['raw_text']
        for key,pattern,label,reason in [
            ('tongue_thickness',THICKNESS,'舌片材料厚度','原文明确写出舌片材料厚度；按文字标签补充，未推断几何位置。'),
            ('conductor_cross_section',AREA,'适用导体截面积范围','原文明确写出导体截面积与平方毫米单位，不作为绝缘外径。'),
            ('conductor_cross_section',AWG,'适用线规范围','原文线规栏明确写出适用线规；保留原代号，不换算成直径。'),
        ]:
            match=pattern.search(raw)
            if not match:continue
            if box is None:
                skipped.append({'observation_id':observation['id'],'key':key,'reason':'没有可用原文区域，未生成候选。'});continue
            value=match.group('value').strip();groups=match.groupdict();unit=groups.get('unit')
            refs=[observation['id']];evidence=raw
            if key=='tongue_thickness' and unit is None and '[' in value and ']' in value and general_mm:
                unit=general_mm[1].group('unit');refs.append(general_mm[0]['id']);evidence+='\n'+general_mm[0]['raw_text']
            is_range=bool(groups.get('range'))
            nominal=None if is_range else groups.get('nominal')
            tolerance=(groups.get('tolerance') or '').strip() or None
            # One explicit header per source; repeated identically worded labels
            # do not add duplicate business values. Conflicting existing values
            # remain separate instances, with provenance, never overwritten.
            identity=(key,unit,nominal,value)
            if identity in existing:continue
            if any(p['key']==key and p['status']=='candidate' and observation['id'] in p.get('evidence_ids',[]) for p in payload['parameters']):continue
            suffix=hashlib.sha256((observation['id']+'\0'+key+'\0'+value).encode()).hexdigest()[:12]
            pid='note_'+key+'_'+suffix
            if pid in used_ids:continue
            item={'id':pid,'key':key,'instance_label':label,'status':'candidate','value_raw':value,'nominal_raw':nominal,'unit_raw':unit,'tolerance_raw':tolerance,'limit':'range' if is_range else None,'annotation_region':copy.deepcopy(box),'object_region':None,'leader_points':[],'reason':reason,'evidence_text':evidence,'evidence_ids':refs,'evidence_mode':'explicit_note','view':'技术说明或参数栏'}
            payload['parameters'].append(item);used_ids.add(pid);existing.add(identity);added.append(pid)
    result=validate(payload,observations,sha,page)
    retained_rule_ids=[identifier for identifier in previous.get('added_parameter_ids',[]) if isinstance(identifier,str) and identifier in {p['id'] for p in payload['parameters']}] if previous.get('processing_method')=='local_explicit_note_enrichment' else []
    result.update(operation='local_explicit_note_enrichment',processing_method='local_explicit_note_enrichment',network_call_performed=False,rule_version=RULE_VERSION,added_parameter_ids=list(dict.fromkeys(retained_rule_ids+added)))
    if isinstance(previous.get('model'),str):result['model']=previous['model']
    audit={'operation':'local_explicit_note_enrichment','rule_version':RULE_VERSION,'network_call_performed':False,'stage_one_sha256':canonical_sha(stage),'previous_geometry_sha256':canonical_sha(previous),'document_sha256':sha,'page':page,'retained_parameter_count':len(previous['parameters']),'added_parameter_ids':added,'skipped':skipped,'previous_model':previous.get('model'),'validation_scope':'numeric_citations_and_explicit_text_labels_only_not_image_or_geometry_verification'}
    return result,audit

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage-one',required=True);parser.add_argument('--geometry',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args()
    try:
        out=Path(args.output).expanduser().resolve()
        if out.exists():raise ValueError('Output directory exists; use a new directory')
        inputs=[]
        for name in (args.stage_one,args.geometry):
            path=Path(name)
            if path.stat().st_size>10*1024*1024:raise ValueError('Input JSON exceeds 10 MiB')
            inputs.append(strict_json(path.read_text(encoding='utf-8')))
        result,audit=enrich(*inputs);out.mkdir(parents=True)
        for name,value in [('result.json',result),('audit.json',audit)]:
            with (out/name).open('x',encoding='utf-8') as stream:json.dump(value,stream,ensure_ascii=False,indent=2)
        print(json.dumps({'processing_method':result['processing_method'],'network_call_performed':False,'total_parameters':len(result['parameters']),'added':len(audit['added_parameter_ids']),'output':str(out)},ensure_ascii=False));return 0
    except (ValueError,KeyError,TypeError,OSError) as error:
        print(str(error),file=sys.stderr);return 2

if __name__=='__main__':raise SystemExit(main())
