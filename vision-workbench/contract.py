"""Strict validation for the bundled, deliberately limited JSON Schema vocabulary."""
from __future__ import annotations
import copy, json, math, re
from pathlib import Path
from fact_enrichment import bom_evidence_issue

ROOT = Path(__file__).resolve().parent
SCHEMA_PATH = ROOT / 'extraction.schema.json'
NEUTRAL_DIMENSION_NAME_PATTERN=r'^(?:尺寸标注[1-9][0-9]*|(?:[Nn][Oo][Tt][Ee][ \t]+|注(?:释|号)?[ \t]*)[1-9][0-9]*)$'

class ContractError(ValueError):
    pass

def strict_json(text):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise ContractError(f'Duplicate JSON key: {key}')
            out[key] = value
        return out
    def constant(value):
        raise ContractError('Non-finite JSON number is forbidden')
    def finite_float(value):
        result=float(value)
        if not math.isfinite(result):raise ContractError('Non-finite JSON number is forbidden')
        return result
    def bounded_int(value):
        if len(value)>256:raise ContractError('JSON integer exceeds the contract digit limit')
        return int(value)
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=constant, parse_float=finite_float, parse_int=bounded_int)
    except (json.JSONDecodeError, UnicodeError, OverflowError) as exc:
        raise ContractError('Expected one strict JSON document without Markdown fences or trailing prose') from exc

def finite_number(value):
    if type(value) not in (int,float):return False
    try:return math.isfinite(value)
    except OverflowError:return False

def comparable_text(value):
    return ' '.join((value or '').split()).casefold()

def contains_term(text,term):
    # Only whitespace/case are compared here; punctuation and numeric characters
    # are never corrected or converted, and no model value is rewritten.
    text=comparable_text(text);term=comparable_text(term)
    return bool(term) and re.search(r'(?<![A-Za-z])'+re.escape(term)+r'(?![A-Za-z])',text) is not None

def validate_associations(field,observations):
    assignments=[field.get(k) for k in ('object','view','state') if field.get(k)]
    if not assignments:return
    ids=field.get('association_evidence_ids',[])
    if not ids:raise ContractError('Object/view/state assignment needs explicit evidence references')
    primary=[observations[ref] for ref in field['evidence_ids']]
    rows=[observations[ref] for ref in ids]
    images={row['image_id'] for row in primary}
    if any(row['image_id'] not in images for row in rows):
        raise ContractError('Association evidence must belong to an image cited by the field')
    if field.get('category')=='dimension':
        primary_ids=set(field['evidence_ids'])
        if field.get('tolerance'):primary_ids.update(field['tolerance']['evidence_ids'])
        primary_texts={comparable_text(observations[ref]['raw_text']) for ref in primary_ids if observations[ref]['kind']=='visible_text'}
        if set(ids)&primary_ids or any(row['kind']=='visible_text' and comparable_text(row['raw_text']) in primary_texts for row in rows):
            raise ContractError('Dimension observations cannot be reused or cloned as independent association evidence')
    for assignment in assignments:
        supported=False
        for row in rows:
            if row['legibility']=='unreadable' or not contains_term(row['raw_text'],assignment):continue
            if row['kind']=='visible_text':supported=True
            if row['kind']=='visual_structure' and row['region'] is not None and comparable_text(row['raw_text'])!=comparable_text(assignment):supported=True
        if not supported:
            raise ContractError('Object/view/state lacks an explicit label or described independent visual association')

def validate_dimension_units(field,observations):
    if field.get('category')!='dimension':return
    rows=[observations[ref] for ref in field['evidence_ids']]
    reported=' '.join(row['raw_text'] or '' for row in rows if row['kind']=='visible_text' and row['legibility']!='unreadable')
    unit=field['unit_raw']
    if unit is not None:
        if re.search(r'(?i)\b(?:dia(?:meter)?|min(?:imum)?|max(?:imum)?|rad(?:ius)?)\b|[Øø⌀]',unit) or comparable_text(unit) in {'r','metric','imperial','公制','英制'}:
            raise ContractError('Dimension modifiers or unit-system labels are not units')
        if not unit.strip() or not contains_term(reported,unit):
            raise ContractError('Dimension unit must be explicitly present in cited readable text; otherwise null')
    name=field.get('name','')
    for label,aliases,units in [('metric',('metric','公制'),{'mm','cm','m','μm','um','毫米','厘米','米'}),
                                ('imperial',('imperial','英制'),{'in','inch','inches','ft','foot','feet','"','英寸','英尺'})]:
        if any(contains_term(name,term) for term in aliases):
            if comparable_text(unit) not in units and not any(contains_term(reported,term) for term in aliases):
                raise ContractError('A dimension name cannot infer a unit system without explicit cited unit evidence')

def validate_neutral_note_name(field,observations):
    if field.get('category')!='dimension':return
    note=re.fullmatch(r'(?:note\s+|注(?:释|号)?\s*)([1-9][0-9]*)',field['name'],re.I)
    if not note:return
    number=note.group(1)
    pattern=re.compile(r'^\s*(?:(?:NOTE|注释|注号|注)\s*)?(?:[△▲(（]\s*)?'+re.escape(number)+r'(?:\s*[)）:：.、])?(?:\s+|$)',re.I|re.M)
    rows=[observations[ref] for ref in field['evidence_ids']]
    if not any(row['kind']=='visible_text' and row['legibility']!='unreadable' and pattern.search(row['raw_text'] or '') for row in rows):
        raise ContractError('Neutral note name must cite the same visible note number; no renumbering or inferred label')

def validate_schema(value, schema, root=None, path='$'):
    root = root or schema
    allowed = {'$schema','title','description','type','additionalProperties','required','properties','const','enum',
               'allOf','if','then','anyOf','$defs','$ref','items','minItems','maxItems','uniqueItems','minLength',
               'maxLength','pattern','minimum','maximum','exclusiveMinimum','exclusiveMaximum'}
    if set(schema)-allowed:
        raise ContractError('Unsupported schema keyword; validator must be extended explicitly')
    if '$ref' in schema:
        ref=schema['$ref']
        if not ref.startswith('#/$defs/') or ref.count('/')!=2:
            raise ContractError('Only bundled local schema references are allowed')
        return validate_schema(value, root['$defs'][ref.split('/')[-1]], root, path)
    types={'null': lambda v:v is None,'object':lambda v:isinstance(v,dict),'array':lambda v:isinstance(v,list),
           'string':lambda v:isinstance(v,str),'number':finite_number,
           'integer':lambda v:type(v) is int,'boolean':lambda v:type(v) is bool}
    if 'type' in schema:
        requested=schema['type'] if isinstance(schema['type'],list) else [schema['type']]
        if not any(types[t](value) for t in requested):raise ContractError(f'{path}: wrong type')
    if 'const' in schema and value!=schema['const']:raise ContractError(f'{path}: unexpected constant')
    if 'enum' in schema and value not in schema['enum']:raise ContractError(f'{path}: unexpected enum value')
    if 'anyOf' in schema:
        valid=False
        for branch in schema['anyOf']:
            try:validate_schema(value,branch,root,path);valid=True;break
            except ContractError:pass
        if not valid:raise ContractError(f'{path}: no permitted schema branch')
    for branch in schema.get('allOf',[]):validate_schema(value,branch,root,path)
    if 'if' in schema:
        try:validate_schema(value,schema['if'],root,path)
        except ContractError:pass
        else:validate_schema(value,schema.get('then',{}),root,path)
    if isinstance(value,dict):
        if set(schema.get('required',[]))-set(value):raise ContractError(f'{path}: missing required properties')
        props=schema.get('properties',{})
        if schema.get('additionalProperties') is False and set(value)-set(props):raise ContractError(f'{path}: unknown properties')
        for key,item in value.items():
            if key in props:validate_schema(item,props[key],root,f'{path}.{key}')
    if isinstance(value,list):
        if len(value)<schema.get('minItems',0) or len(value)>schema.get('maxItems',float('inf')):raise ContractError(f'{path}: array length out of bounds')
        if schema.get('uniqueItems') and len({json.dumps(v,sort_keys=True,ensure_ascii=False) for v in value})!=len(value):raise ContractError(f'{path}: repeated items')
        if 'items' in schema:
            for i,item in enumerate(value):validate_schema(item,schema['items'],root,f'{path}[{i}]')
    if isinstance(value,str):
        if len(value)<schema.get('minLength',0) or len(value)>schema.get('maxLength',float('inf')):raise ContractError(f'{path}: text length out of bounds')
        if 'pattern' in schema and re.search(schema['pattern'],value) is None:raise ContractError(f'{path}: invalid text pattern')
    if type(value) in (int,float):
        if not finite_number(value):raise ContractError(f'{path}: non-finite number')
        for key,ok in [('minimum',lambda a,b:a>=b),('maximum',lambda a,b:a<=b),('exclusiveMinimum',lambda a,b:a>b),('exclusiveMaximum',lambda a,b:a<b)]:
            if key in schema and not ok(value,schema[key]):raise ContractError(f'{path}: number out of bounds')

def validate_document_structure_and_sources(payload, sources, operation):
    """Global failures are never downgraded to isolated item failures."""
    schema=strict_json(SCHEMA_PATH.read_text())
    validate_schema(payload,schema)
    if payload['operation']!=operation:raise ContractError('Response operation differs from request')
    expected={s['image_id'] for s in sources}
    texts=[r['image_id'] for r in payload['image_texts']]
    if len(set(texts))!=len(texts) or set(texts)!=expected:raise ContractError('image_texts must cover each requested image exactly once')
    observations={}
    for r in payload['observations']:
        if r['id'] in observations:raise ContractError('Duplicate observation id')
        if r['image_id'] not in expected:raise ContractError('Observation references an unknown input image')
        b=r['region']
        if b and (b['x']+b['width']>1+1e-9 or b['y']+b['height']>1+1e-9):raise ContractError('Evidence region extends outside supplied image')
        observations[r['id']]=r
    seen=set()
    for field in payload['fields']+payload['bom']:
        if field['id'] in seen:raise ContractError('Duplicate field/BOM id')
        seen.add(field['id'])
        references=field['evidence_ids']+field.get('association_evidence_ids',[])
        if field.get('tolerance'):references+=field['tolerance']['evidence_ids']
        if any(ref not in observations for ref in references):raise ContractError('Dangling evidence reference')
        source_images={observations[ref]['image_id'] for ref in field['evidence_ids']}
        if any(observations[ref]['image_id'] not in source_images for ref in field.get('association_evidence_ids',[])):
            raise ContractError('Association evidence must belong to an image cited by the field')
    return observations

def validate_item(field,observations):
        """Apply the unchanged engineering-evidence rules to one schema-valid item."""
        missing=[]
        validate_associations(field,observations)
        validate_dimension_units(field,observations)
        numeric_values=[field[k] for k in ('nominal_raw','quantity_raw') if field.get(k) is not None]
        if numeric_values:
            source_rows=[observations[ref] for ref in field['evidence_ids']]
            if field.get('certainty','clear')=='clear' and any(r['legibility']=='unreadable' for r in source_rows):
                raise ContractError('Unreadable observations cannot support a definite numeric field')
            reported=' '.join(r['raw_text'] or '' for r in source_rows if r['legibility']!='unreadable')
            for raw in numeric_values:
                pattern=r'(?<![0-9.,+\-−])'+re.escape(raw)+r'(?![0-9.,])'
                if re.search(pattern,reported) is None:
                    raise ContractError('Numeric string is inconsistent with its reported evidence text')
        if field.get('category')=='dimension':
            for key in ('nominal_raw','unit_raw','tolerance','object','view','state'):
                if field[key] is None:missing.append({'field_id':field['id'],'attribute':key,'status':'not_provided_or_unresolved'})
        if 'quantity_raw' in field and field['quantity_raw'] is None:missing.append({'field_id':field['id'],'attribute':'quantity_raw','status':'not_provided_or_unresolved'})
        tolerance=field.get('tolerance')
        if tolerance and tolerance['kind']=='symmetric' and (tolerance['amplitude_raw'] is None or tolerance['upper_raw'] is not None or tolerance['lower_raw'] is not None):
            raise ContractError('Symmetric tolerance needs raw amplitude, not fabricated upper/lower strings')
        if tolerance and tolerance['kind']=='asymmetric' and (tolerance['upper_raw'] is None or tolerance['lower_raw'] is None):
            raise ContractError('Incomplete asymmetric tolerance must remain uncertain')
        if tolerance:
            texts=' '.join(observations[ref]['raw_text'] or '' for ref in tolerance['evidence_ids'] if observations[ref]['kind']=='visible_text' and observations[ref]['legibility']!='unreadable')
            if comparable_text(tolerance['raw']) not in comparable_text(texts):
                raise ContractError('Tolerance raw text is inconsistent with its cited readable observation')
            if tolerance['kind']=='symmetric':
                amplitude=tolerance['amplitude_raw']
                if not amplitude or amplitude[:1] in '+-−±' or not ('±' in tolerance['raw'] or '+/-' in tolerance['raw']):
                    raise ContractError('Symmetric tolerance needs the visible unsigned amplitude and plus/minus marker')
                if re.search(r'(?<![0-9.,])'+re.escape(amplitude)+r'(?![0-9.,])',tolerance['raw']) is None:
                    raise ContractError('Symmetric amplitude must preserve the visible numeric characters')
        return missing

def validate_payload(payload, sources, operation):
    observations=validate_document_structure_and_sources(payload,sources,operation)
    missing=[]
    for field in payload['fields']+payload['bom']:
        missing.extend(validate_item(field,observations))
    return {'schema_valid':True,'reference_links_valid':True,'prediction_consistency':{'numeric_strings_match_reported_evidence':True,'image_content_verified':False},'missing_fields':missing,
            'accuracy_verified':False,'engineering_value_approved':False}

def partition_validated_items(payload,sources,operation,request_schema=None):
    """Preserve rejected engineering claims explicitly, never repair their values."""
    observations=validate_document_structure_and_sources(payload,sources,operation)
    accepted=copy.deepcopy(payload)
    rejected={'fields':[],'bom':[]}
    counts={}
    for group in ('fields','bom'):
        accepted[group]=[]
        for item in payload[group]:
            phase='item_contract_violation'
            try:
                if group=='fields' and request_schema is not None:
                    phase='task_scope_violation'
                    validate_schema(item,request_schema['$defs']['field'],request_schema)
                    validate_neutral_note_name(item,observations)
                phase='item_contract_violation'
                validate_item(item,observations)
                if group=='bom' and request_schema is not None and operation=='extract_page':
                    phase='table_classification_violation'
                    issue=bom_evidence_issue(item,observations)
                    if issue:raise ContractError(issue)
            except ContractError as error:
                reason=('Visible-annotation task requires a neutral dimension name and unconfirmed object/view/state: '+str(error)
                        if phase=='task_scope_violation' else str(error))
                rejected[group].append({'item':copy.deepcopy(item),'error':reason,
                                        'error_code':phase,'status':'rejected_unreviewed'})
            else:accepted[group].append(copy.deepcopy(item))
        counts[group]={'total':len(payload[group]),'accepted':len(accepted[group]),'rejected':len(rejected[group])}
    for key in ('total','accepted','rejected'):
        counts[key]=sum(counts[group][key] for group in ('fields','bom'))
    # The accepted subset must still pass the original full strict contract.
    validation=validate_payload(accepted,sources,operation)
    if request_schema is not None:
        validate_schema(accepted,request_schema)
        validation['request_schema_valid']=True
    validation.update(scope='accepted_fields_and_bom_only' if counts['rejected'] else 'all_items',
                      complete_document_valid=not bool(counts['rejected']))
    return accepted,validation,rejected,counts
