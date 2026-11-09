"""Conservative, traceable candidates derived only from existing observations.

These rules never assign a unit/tolerance to a field, approve an engineering
value, infer geometry, or turn packaging quantities into assembly quantities.
"""
import copy
import hashlib
import re

RULES_VERSION='drawing-observed-facts-v1.0'
_UNIT=r'(?:mm|cm|m|[µμu]m|inches|inch|in|毫米|厘米|米|英寸)'
UNIT_DECL=re.compile(r'(?:\bDIMENSIONS?\s+(?:ARE\s+)?IN\s+|\bUNITS?\s*[:=]\s*|尺寸单位\s*[:：]?\s*)'
                     r'(?P<primary>'+_UNIT+r')(?![A-Za-z])(?:\s*\[\s*(?P<secondary>'+_UNIT+r')\s*\])?',re.I)
GENERAL_TOL=re.compile(r'(?P<label>(?P<places>[1-9][0-9]*)\s*(?:PLC|PLACES?)\s*DEC(?:IMAL)?S?|ANGLES?|角度)'
                       r'\s*(?:[:：]\s*)?(?:±|\+/-)\s*(?P<amplitude>(?:[0-9]*\.[0-9]+|[0-9]+|[-−–—]))'
                       r'(?:\s*\[\s*(?P<secondary>[0-9]*\.[0-9]+|[0-9]+|[-−–—])\s*\])?',re.I)
PACKAGE_WORD=re.compile(r'\b(?:REEL|BAG|BOX|TRAY|BULK|LOOSE\s+(?:PC|PCS|PIECE|PIECES))\b|卷盘|散装|袋装|盒装|托盘',re.I)
PACKAGE_ROW=re.compile(r'^(?P<prefix>.*?)(?P<quantity>[0-9][0-9,]*|[-−–—])\s+'
                       r'(?P<package>ON\s+TAPE\s*,?\s*REEL|TAPE\s*(?:AND|&|,)?\s*REEL|'
                       r'LOOSE\s+(?:PIECES?|PCS?)(?:\s*,?\s*(?:BAG|BOX))?|BAG|BOX|TRAY|REEL|BULK|卷盘|散装|袋装|盒装|托盘)'
                       r'\s+(?P<part>[A-Za-z0-9][A-Za-z0-9_.\-/]*)\s*$',re.I)
ASSEMBLY_HEADER=re.compile(r'\b(?:BILL\s+OF\s+MATERIALS|ASSEMBLY\s+(?:BOM|PARTS|COMPONENTS)|PARTS\s+LIST)\b|装配明细|装配组成|装配物料',re.I)
PER_ASSEMBLY=re.compile(r'\b(?:QTY|QUANTITY)\s*(?:PER\s+|/\s*)(?:ASSEMBLY|ASSY|UNIT)\b|每(?:台|套|装配)用量|单台用量|装配用量',re.I)


def _sha(value):return hashlib.sha256(value.encode('utf8')).hexdigest()


def packaging_header(text):
    return bool(re.search(r'\b(?:PACKAGE|PACKAGING)\s+TYPE\b|包装(?:方式|类型)',text,re.I)
                and re.search(r'\bPART\s*(?:NO\.?|NUMBER)\b|料号|零件号',text,re.I)
                and re.search(r'\b(?:QUANTITY|QTY)\b|数量',text,re.I))


def bom_evidence_issue(item,observations):
    rows=[observations[ref] for ref in item['evidence_ids']]
    text='\n'.join(row['raw_text'] or '' for row in rows if row['kind']=='visible_text' and row['legibility']!='unreadable')
    if packaging_header(text) or any(PACKAGE_ROW.fullmatch((row['raw_text'] or '').strip()) for row in rows):
        return 'Packaging/variant rows cannot be assembly BOM items; preserve them as other fields or packaging candidates'
    if not ASSEMBLY_HEADER.search(text) or not PER_ASSEMBLY.search(text):
        return 'Assembly BOM requires cited component-table and per-assembly-quantity headings; this row remains unclassified'
    return None


def _source(row,sources):
    source=sources[row['image_id']]
    return {'image_id':row['image_id'],'observation_id':row['id'],'page':source.get('page'),
            'document_sha256':source.get('document_sha256'),'original_image_sha256':source.get('original_image_sha256'),
            'observation_raw_text_sha256':_sha(row['raw_text'] or ''),'region':copy.deepcopy(row.get('region'))}


def _base(row,sources,kind,match):
    return {'id':kind+'-'+_sha(row['image_id']+'\0'+row['id']+'\0'+str(match.start()))[:16],
            'kind':kind,'source_category':'server_rule_suggestion','rules_version':RULES_VERSION,
            'status':'pending_review','engineering_value_approved':False,'applicability':'requires_review',
            'applied_to_field_ids':[],'source':_source(row,sources),'evidence_ids':[row['id']],
            'raw_text':row['raw_text'],'matched_text':match.group(0),'match_span':[match.start(),match.end()],'span_encoding':'unicode_code_points'}


def build_reference_suggestions(payload,sources):
    """No decimal-place guessing, unit conversion, or automatic field application."""
    source_map={source['image_id']:source for source in sources};out=[]
    for row in payload['observations']:
        if row['kind']!='visible_text' or row['legibility']=='unreadable' or not row['raw_text']:continue
        raw=row['raw_text']
        for match in UNIT_DECL.finditer(raw):
            item=_base(row,source_map,'global_unit_declaration',match)
            item.update(primary_unit_raw=match.group('primary'),secondary_unit_raw=match.group('secondary'))
            out.append(item)
        if re.search(r'\bTOLERANCES?\b|公差',raw,re.I):
            for match in GENERAL_TOL.finditer(raw):
                item=_base(row,source_map,'general_tolerance_declaration',match)
                amplitude=match.group('amplitude');secondary=match.group('secondary')
                item.update(label_raw=match.group('label'),decimal_places_raw=match.group('places'),
                            amplitude_raw=amplitude if re.search(r'[0-9]',amplitude) else None,
                            secondary_amplitude_raw=secondary if secondary and re.search(r'[0-9]',secondary) else None,
                            value_status='observed' if re.search(r'[0-9]',amplitude) else 'not_provided',
                            units_assigned=False)
                out.append(item)
    return out


def build_table_candidates(payload,sources):
    """Parse only explicit packaging headings plus unambiguous complete row text.

    Leading tokens stay unassigned: the parser does not invent note/item numbers.
    Multiple candidate packaging headers on one image remain ambiguous.
    """
    source_map={source['image_id']:source for source in sources}
    readable=[row for row in payload['observations'] if row['kind']=='visible_text' and row['legibility']!='unreadable' and row['raw_text']]
    headers=[row for row in readable if packaging_header(row['raw_text'])]
    header_ids={row['id'] for row in headers};packaging=[];unparsed=[]
    for row in readable:
        if row['id'] in header_ids or not PACKAGE_WORD.search(row['raw_text']):continue
        candidates=[header for header in headers if header['image_id']==row['image_id']]
        if not candidates:continue
        source=_source(row,source_map)
        raw=row['raw_text']
        match=PACKAGE_ROW.fullmatch(raw) if '\n' not in raw and '\r' not in raw else None
        if len(candidates)!=1 or match is None:
            unparsed.append({'raw_text':raw,'source':source,'evidence_ids':[row['id']],
                             'status':'pending_review','reason':'ambiguous_packaging_header' if len(candidates)!=1 else 'unsupported_row_layout'})
            continue
        header=candidates[0];quantity=match.group('quantity')
        values={'package_quantity_raw':quantity if re.search(r'[0-9]',quantity) else None,
                'quantity_cell_raw':quantity,'package_type_raw':match.group('package'),'part_number_raw':match.group('part'),
                'unassigned_prefix_raw':match.group('prefix'),'assembly_quantity_raw':None,'item_number_raw':None}
        packaging.append({'id':'package-'+_sha(row['image_id']+'\0'+row['id'])[:16],
                          'classification':'packaging_variant','classification_status':'pending_review',
                          'source_category':'server_rule_candidate','rules_version':RULES_VERSION,
                          'raw_text':raw,'source':source,'header_source':_source(header,source_map),
                          'header_raw_text':header['raw_text'],'evidence_ids':[header['id'],row['id']],
                          'engineering_value_approved':False,'quantity_meaning':'packaging_amount_not_per_assembly',
                          'span_encoding':'unicode_code_points',
                          'literal_spans':{key:list(match.span(group)) for key,group in [('quantity_cell_raw','quantity'),('package_type_raw','package'),('part_number_raw','part'),('unassigned_prefix_raw','prefix')]},
                          **values})
    return {'packaging_variants':packaging,'unparsed_table_rows':unparsed,
            'packaging_headers':[{'raw_text':row['raw_text'],'source':_source(row,source_map)} for row in headers],
            'assembly_bom_candidates_unchanged':True,'classification_is_human_verified':False}


def validate_derived_candidates(suggestions,tables,payload,sources):
    """Require every derived string/span to be an exact slice of cited raw text."""
    observations={row['id']:row for row in payload['observations']}
    source_map={source['image_id']:source for source in sources}
    for item in suggestions:
        row=observations[item['source']['observation_id']]
        if row['image_id'] not in source_map or item['source']!=_source(row,source_map):
            raise ValueError('Derived suggestion source mismatch')
        start,end=item['match_span']
        if item['raw_text']!=row['raw_text'] or item['matched_text']!=row['raw_text'][start:end]:
            raise ValueError('Derived suggestion does not match its cited text')
        if item['applied_to_field_ids'] or item['engineering_value_approved'] or item['status']!='pending_review':
            raise ValueError('Reference suggestions cannot apply or approve engineering values')
        for key in ('primary_unit_raw','secondary_unit_raw','amplitude_raw','secondary_amplitude_raw','label_raw','decimal_places_raw'):
            value=item.get(key)
            if value is not None and value not in item['matched_text']:
                raise ValueError('Derived literal is absent from the matched source text')
    for item in tables['packaging_variants']:
        row=observations[item['source']['observation_id']];header=observations[item['header_source']['observation_id']]
        if item['source']!=_source(row,source_map) or item['header_source']!=_source(header,source_map):
            raise ValueError('Packaging candidate source identity mismatch')
        if row['image_id']!=header['image_id'] or not packaging_header(header['raw_text']):
            raise ValueError('Packaging candidate needs a same-image explicit packaging heading')
        if item['raw_text']!=row['raw_text'] or item['header_raw_text']!=header['raw_text']:
            raise ValueError('Packaging candidate raw text mismatch')
        for key,(start,end) in item['literal_spans'].items():
            if item[key]!=row['raw_text'][start:end]:raise ValueError('Packaging candidate contains an unsupported literal')
        if item['package_quantity_raw'] not in (None,item['quantity_cell_raw']):raise ValueError('Packaging quantity was changed')
        if item['assembly_quantity_raw'] is not None or item['item_number_raw'] is not None or item['engineering_value_approved']:
            raise ValueError('Packaging candidate cannot infer assembly quantities or item numbers')
    return {'literal_provenance_valid':True,'field_values_modified':False,'image_content_verified':False,'engineering_value_approved':False}


def enrich_observed_facts(payload,sources):
    suggestions=build_reference_suggestions(payload,sources)
    tables=build_table_candidates(payload,sources)
    validation=validate_derived_candidates(suggestions,tables,payload,sources)
    return {'reference_suggestions':suggestions,'packaging_variants':tables['packaging_variants'],
            'table_analysis':{key:value for key,value in tables.items() if key!='packaging_variants'},
            'derived_facts_validation':validation,'derived_facts_rules_version':RULES_VERSION}
