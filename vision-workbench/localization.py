"""Offline exact-text localization audits for geometry-2.0.

This module has no OCR engine, network, model call, or credential dependency.
It matches caller-supplied full-page OCR lines and emits independent suggestions.
It never changes annotation_region, object_region, leader_points, or dimensions.

CLI: python localization.py --geometry result.json --ocr-json apple-output.json \
       --ocr-format apple --output localization-audit.json
Add --embed to write a copy of result with localization_audit attached instead.
The caller must supply OCR from the same original document/page. OCR source
metadata is an assertion of provenance, not an independent verification.

geometry_sha256 hashes a projection containing schema_version,
document_sha256, page, parameters, observations, and unmapped_annotations.
Canonical bytes are UTF-8 JSON with sorted object keys, retained list order,
ensure_ascii=False, separators=(',', ':'), and allow_nan=False. Embedded audits
and unrelated top-level runtime metadata are deliberately outside that digest.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import unicodedata
from pathlib import Path

VERSION = 'localization-audit-1.0'
MATCHER_VERSION = 'exact-normalized-lines-1.0'
COORDINATES = 'full_page_normalized_top_left'
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_LINES = 1000
MAX_PARAMETERS = 300
MAX_TEXT = 6000
SHA = re.compile(r'[0-9a-f]{64}')
IDENTIFIER = re.compile(r'[A-Za-z0-9_-]{1,100}')


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False)


def _digest(value):
    return hashlib.sha256(canonical_json(value).encode('utf-8')).hexdigest()


def normalize_text(value):
    """Keep every digit and engineering modifier; never repair OCR mistakes."""
    value = unicodedata.normalize('NFKC', value).upper()
    value = value.translate(str.maketrans({'⌀': 'Ø', '∅': 'Ø', '−': '-', '–': '-', '—': '-'}))
    return re.sub(r'\s+', '', value)


def _contains_annotation(container, value):
    """A complete cited line may enclose the value, but not inside another number."""
    container, value = normalize_text(container), normalize_text(value)
    if not value:
        return False
    for occurrence in re.finditer(re.escape(value), container):
        before = container[occurrence.start() - 1] if occurrence.start() else ''
        after = container[occurrence.end()] if occurrence.end() < len(container) else ''
        if (value[0].isdigit() or value[0] == '.') and before and (before.isdigit() or before == '.'):
            continue
        if (value[-1].isdigit() or value[-1] == '.') and after and (after.isdigit() or after == '.'):
            continue
        if value[-1].isalpha() and after and after.isdigit():
            continue  # e.g. mm must not silently match the mm2 area unit.
        return True
    return False


def _text(value, name, allow_empty=False):
    if not isinstance(value, str) or len(value) > MAX_TEXT or (not allow_empty and not value.strip()):
        raise ValueError(f'{name} must be bounded text')
    return value


def _id(value, name):
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError(f'{name} must be a bounded string identifier')
    return value


def _box(value, name, nullable=False):
    if nullable and value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'x', 'y', 'width', 'height'}:
        raise ValueError(f'{name} requires a full-page normalized box')
    if any(type(v) not in (int, float) or not math.isfinite(v) for v in value.values()):
        raise ValueError(f'{name} has a non-finite coordinate')
    if (value['x'] < 0 or value['y'] < 0 or value['width'] <= 0 or value['height'] <= 0
            or value['x'] + value['width'] > 1.000001 or value['y'] + value['height'] > 1.000001):
        raise ValueError(f'{name} extends outside the page')
    return copy.deepcopy(value)


def _validate_geometry(result):
    if not isinstance(result, dict) or result.get('schema_version') != 'geometry-2.0':
        raise ValueError('A geometry-2.0 result is required')
    if not isinstance(result.get('document_sha256'), str) or not SHA.fullmatch(result['document_sha256']):
        raise ValueError('Original document SHA256 is required')
    if type(result.get('page')) is not int or result['page'] < 1:
        raise ValueError('Original page must be a positive integer')
    parameters = result.get('parameters')
    observations = result.get('observations')
    if not isinstance(parameters, list) or len(parameters) > MAX_PARAMETERS:
        raise ValueError('Parameters must be a bounded list')
    if not isinstance(observations, list) or len(observations) > MAX_LINES:
        raise ValueError('Observations must be a bounded list')
    ids = set()
    for o in observations:
        if not isinstance(o, dict):
            raise ValueError('Observation must be an object')
        oid = _id(o.get('id'), 'Observation ID')
        if oid in ids:
            raise ValueError('Duplicate observation ID')
        ids.add(oid)
        _text(o.get('raw_text'), 'Observation raw_text')
    parameter_ids = set()
    for p in parameters:
        if not isinstance(p, dict):
            raise ValueError('Parameter must be an object')
        pid = _id(p.get('id'), 'Parameter ID')
        if pid in parameter_ids:
            raise ValueError('Duplicate parameter ID')
        parameter_ids.add(pid)
        _id(p.get('key'), 'Parameter key')
        if p.get('status') not in ('candidate', 'ambiguous', 'not_provided', 'not_applicable'):
            raise ValueError('Unsupported parameter status')
        if p.get('value_raw') is not None:
            _text(p['value_raw'], 'Parameter value_raw', allow_empty=True)
        evidence_ids = p.get('evidence_ids', [])
        if not isinstance(evidence_ids, list) or len(evidence_ids) > 32 or any(not isinstance(i, str) or i not in ids for i in evidence_ids):
            raise ValueError('Parameter evidence_ids do not resolve to observations')
        _box(p.get('annotation_region'), 'Original annotation region', nullable=True)
        _box(p.get('object_region'), 'Original object region', nullable=True)
        points = p.get('leader_points', [])
        if not isinstance(points, list) or len(points) > 32:
            raise ValueError('Leader points must be bounded')
        for point in points:
            if not isinstance(point, dict) or set(point) != {'x', 'y'} or any(
                type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in point.values()
            ):
                raise ValueError('Invalid original leader point')


def geometry_sha256(result):
    _validate_geometry(result)
    return _digest({name: result.get(name, []) if name == 'unmapped_annotations' else result[name]
                    for name in ('schema_version', 'document_sha256', 'page', 'parameters',
                                 'observations', 'unmapped_annotations')})


def apple_vision_source(payload, *, document_sha256, page, image_sha256=None):
    """Adapt existing Apple Vision output; provenance is explicitly caller supplied."""
    rows = payload.get('observations', [])
    if not isinstance(rows, list) or len(rows) > MAX_LINES:
        raise ValueError('Too many Apple Vision rows')
    source = {
        'engine': payload.get('engine', 'Apple Vision'),
        'revision': str(payload.get('revision', 'unknown')),
        'width': payload.get('width'), 'height': payload.get('height'),
        'document_sha256': document_sha256, 'page': page,
        'image_sha256': image_sha256, 'coordinate_space': COORDINATES,
        'binding_provenance': 'caller_supplied_document_page',
        'lines': []}
    for row in rows:
        if not isinstance(row, dict) or type(row.get('index')) is not int or row['index'] < 0:
            raise ValueError('Invalid Apple Vision observation index')
        source['lines'].append({'id': f"ocr_{row['index']}", 'text': row.get('candidate_text'),
                                'confidence': row.get('confidence'),
                                'region': copy.deepcopy(row.get('bbox_top_left_normalized'))})
    return source


def _validate_ocr(source, result):
    if not isinstance(source, dict):
        raise ValueError('OCR source must be an object')
    if source.get('document_sha256') != result['document_sha256'] or source.get('page') != result['page']:
        raise ValueError('OCR document SHA/page does not match the geometry result')
    if source.get('coordinate_space') != COORDINATES:
        raise ValueError('OCR coordinates must use the full page and top-left origin')
    for name in ('width', 'height'):
        if type(source.get(name)) is not int or not 1 <= source[name] <= 50000:
            raise ValueError('Invalid OCR image dimensions')
    if source.get('image_sha256') is not None and (
        not isinstance(source['image_sha256'], str) or not SHA.fullmatch(source['image_sha256'])
    ):
        raise ValueError('Invalid OCR image SHA256')
    engine = _text(source.get('engine'), 'OCR engine')
    revision = _text(str(source.get('revision', 'unknown')), 'OCR revision')
    lines = source.get('lines')
    if not isinstance(lines, list) or len(lines) > MAX_LINES:
        raise ValueError('OCR lines must be a bounded list')
    ids = set()
    clean = []
    for row in lines:
        if not isinstance(row, dict):
            raise ValueError('OCR line must be an object')
        identifier = _id(row.get('id'), 'OCR line ID')
        if identifier in ids:
            raise ValueError('Duplicate OCR line ID')
        ids.add(identifier)
        confidence = row.get('confidence')
        if confidence is not None and (type(confidence) not in (int, float)
                or not math.isfinite(confidence) or not 0 <= confidence <= 1):
            raise ValueError('OCR confidence must be null or finite within 0..1')
        clean.append({'id': identifier, 'text': _text(row.get('text'), 'OCR line text'),
                      'confidence': confidence, 'region': _box(row.get('region'), 'OCR region')})
    return {'engine': engine, 'revision': revision, 'width': source['width'], 'height': source['height'],
            'document_sha256': result['document_sha256'], 'page': result['page'],
            'image_sha256': source.get('image_sha256'), 'coordinate_space': COORDINATES,
            'binding_provenance': 'caller_supplied_document_page', 'lines': clean}


def _union(boxes):
    if len(boxes) == 1:
        return copy.deepcopy(boxes[0])
    x = min(b['x'] for b in boxes)
    y = min(b['y'] for b in boxes)
    return {'x': x, 'y': y, 'width': max(b['x'] + b['width'] for b in boxes) - x,
            'height': max(b['y'] + b['height'] for b in boxes) - y}


def _neighboring(first, second, width, height):
    a, b = first['region'], second['region']
    ax, ay, aw, ah = [a[k] * scale for k, scale in [('x', width), ('y', height), ('width', width), ('height', height)]]
    bx, by, bw, bh = [b[k] * scale for k, scale in [('x', width), ('y', height), ('width', width), ('height', height)]]
    overlap_y = max(0, min(ay + ah, by + bh) - max(ay, by))
    overlap_x = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    horizontal = overlap_y >= .5 * min(ah, bh) and 0 <= bx - (ax + aw) <= 4 * max(ah, bh)
    vertical = overlap_x >= .5 * min(aw, bw) and 0 <= by - (ay + ah) <= 1.5 * max(ah, bh)
    return horizontal or vertical


def _index(source):
    """Only complete lines or at most three adjacent complete lines, in source order."""
    index = {}
    rows = source['lines']
    for start in range(len(rows)):
        for size in range(1, 4):
            window = rows[start:start + size]
            if len(window) != size:
                break
            if size > 1 and not all(_neighboring(a, b, source['width'], source['height'])
                                    for a, b in zip(window, window[1:])):
                break
            raw = '\n'.join(row['text'] for row in window)
            if len(raw) > MAX_TEXT:
                continue
            confidence = [row['confidence'] for row in window]
            match = {'ocr_line_ids': [row['id'] for row in window], 'ocr_text': raw,
                     'ocr_confidences': confidence,
                     'confidence_min': min(confidence) if all(v is not None for v in confidence) else None,
                     'region': _union([row['region'] for row in window]),
                     'window_size': size}
            index.setdefault(normalize_text(raw), []).append(match)
    return index


def _matching(text, index):
    matches = index.get(normalize_text(text), []) if text else []
    status = 'exact_unique' if len(matches) == 1 else 'ambiguous' if matches else 'unmatched'
    return status, matches


def create_localization_audit(result, ocr_source):
    digest = geometry_sha256(result)
    source = _validate_ocr(ocr_source, result)
    index = _index(source)
    observations = {o['id']: o for o in result['observations']}
    observation_audits = []
    observation_matches = {}
    for oid, observation in observations.items():
        status, matches = _matching(observation['raw_text'], index)
        observation_matches[oid] = (status, matches)
        observation_audits.append({'observation_id': oid, 'raw_text': observation['raw_text'],
                                  'status': status, 'candidate_count': len(matches),
                                  'suggested_annotation_region': copy.deepcopy(matches[0]['region']) if status == 'exact_unique' else None,
                                  'ocr_matches': copy.deepcopy(matches)})
    parameter_audits = []
    for p in result['parameters']:
        item = {'parameter_id': p['id'], 'key': p['key'], 'raw_text': p.get('value_raw'),
                'evidence_ids': copy.deepcopy(p.get('evidence_ids', [])),
                'original_annotation_region': copy.deepcopy(p.get('annotation_region')),
                'original_object_region': copy.deepcopy(p.get('object_region')),
                'original_leader_points': copy.deepcopy(p.get('leader_points', [])),
                'suggested_annotation_region': None, 'matched_observation_ids': [],
                'match_target': None, 'candidate_count': 0, 'ocr_matches': []}
        if p['status'] != 'candidate':
            item['status'] = 'not_candidate'
            parameter_audits.append(item)
            continue
        status, matches = _matching(p.get('value_raw'), index)
        target = 'complete_parameter_value' if matches else None
        cited = []
        if status == 'unmatched':
            # The whole cited observation must match. A bare nominal substring is
            # never searched against arbitrary OCR lines and no nearest box wins.
            value = normalize_text(p.get('value_raw') or '')
            candidates = []
            for oid in p.get('evidence_ids', []):
                observation = observations[oid]
                if not value or not _contains_annotation(observation['raw_text'], p.get('value_raw') or ''):
                    continue
                obs_status, obs_matches = observation_matches[oid]
                if obs_status == 'exact_unique':
                    candidates.extend((oid, m) for m in obs_matches)
                elif obs_status == 'ambiguous':
                    # Keep all occurrences: a duplicate may never disappear just
                    # because another cited observation happened to be unique.
                    candidates.extend((oid, m) for m in obs_matches)
            unique = {tuple(m['ocr_line_ids']): m for _, m in candidates}
            if unique:
                matches = list(unique.values())
                status = 'exact_unique' if len(matches) == 1 else 'ambiguous'
                cited = list(dict.fromkeys(oid for oid, _ in candidates))
                target = 'explicitly_cited_complete_observation'
        item.update(status=status, candidate_count=len(matches), match_target=target,
                    matched_observation_ids=cited, ocr_matches=copy.deepcopy(matches))
        if status == 'exact_unique':
            item['suggested_annotation_region'] = copy.deepcopy(matches[0]['region'])
        parameter_audits.append(item)
    return {'schema_version': VERSION, 'matcher_version': MATCHER_VERSION,
            'document_sha256': result['document_sha256'], 'page': result['page'],
            'geometry_sha256': digest, 'geometry_digest_definition': 'UTF-8 sorted-key compact JSON; schema_version/document_sha256/page/parameters/observations/unmapped_annotations; list order retained; embedded audit excluded',
            'ocr_sha256': _digest(source), 'ocr_source': source,
            'coordinate_space': COORDINATES, 'applied': False, 'human_review_required': True,
            'geometry_positions': 'model_estimate_unverified',
            'normalization': 'NFKC, uppercase, whitespace removal, canonical diameter/dash glyphs; no digit or +/- correction',
            'scope': 'Only unique exact complete OCR text matches propose annotation boxes. Objects and leaders remain original model estimates. Confidence is not correctness.',
            'observations': observation_audits, 'parameters': parameter_audits,
            'summary': {'parameter_count': len(parameter_audits),
                        **{status: sum(p['status'] == status for p in parameter_audits)
                           for status in ('exact_unique', 'ambiguous', 'unmatched', 'not_candidate')},
                        'observation_count': len(observation_audits),
                        'observation_exact_unique': sum(o['status'] == 'exact_unique' for o in observation_audits)}}


def validate_localization_audit(result, audit):
    """Recompute from preserved OCR rows; reject stale geometry or forged proposals."""
    if not isinstance(audit, dict) or audit.get('schema_version') != VERSION:
        raise ValueError('Unsupported localization audit schema')
    if audit.get('geometry_sha256') != geometry_sha256(result):
        raise ValueError('Localization audit is stale: geometry/evidence digest differs')
    expected = create_localization_audit(result, audit.get('ocr_source'))
    if canonical_json(expected) != canonical_json(audit):
        raise ValueError('Localization audit content does not match deterministic recomputation')
    return copy.deepcopy(audit)


def attach_localization_audit(result, audit):
    checked = validate_localization_audit(result, audit)
    copied = copy.deepcopy(result)
    copied['localization_audit'] = checked
    return copied


def _no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def _load(path):
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError('JSON input exceeds 16 MiB')
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=_no_duplicate_keys,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-finite JSON number')))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--geometry', type=Path, required=True)
    parser.add_argument('--ocr-json', type=Path, required=True)
    parser.add_argument('--ocr-format', choices=('normalized', 'apple'), default='normalized')
    parser.add_argument('--image-sha256', help='Optional SHA256 of the OCR source image; provenance supplied by caller')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--embed', action='store_true', help='Write a copy of geometry with localization_audit; never replace original regions')
    args = parser.parse_args(argv)
    result, source = _load(args.geometry), _load(args.ocr_json)
    if args.ocr_format == 'apple':
        source = apple_vision_source(source, document_sha256=result.get('document_sha256'),
                                     page=result.get('page'), image_sha256=args.image_sha256)
    audit = create_localization_audit(result, source)
    output = attach_localization_audit(result, audit) if args.embed else audit
    # Exclusive creation protects previous results and cannot overwrite the input.
    with args.output.open('x', encoding='utf-8') as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write('\n')
    print(json.dumps({'output': str(args.output), 'summary': audit['summary'], 'applied': False}))


if __name__ == '__main__':
    main()
