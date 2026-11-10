import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from localization import (COORDINATES, apple_vision_source, attach_localization_audit,
                          canonical_json, create_localization_audit, geometry_sha256,
                          main, normalize_text, validate_localization_audit)

SHA = 'c' * 64
BOX = {'x': .2, 'y': .2, 'width': .1, 'height': .02}


def geometry(value='4.00'):
    return {'schema_version': 'geometry-2.0', 'document_sha256': SHA, 'page': 3,
            'parameters': [{'id': 'p1', 'key': 'terminal_pitch', 'status': 'candidate',
                            'value_raw': value, 'nominal_raw': '4.00', 'unit_raw': 'mm',
                            'tolerance_raw': None, 'limit': None,
                            'evidence_ids': ['o1'], 'evidence_text': value,
                            'annotation_region': {'x': .3, 'y': .1, 'width': .1, 'height': .02},
                            'object_region': {'x': .4, 'y': .3, 'width': .2, 'height': .2},
                            'leader_points': [{'x': .4, 'y': .3}, {'x': .6, 'y': .3}]}],
            'observations': [{'id': 'o1', 'raw_text': value, 'region': copy.deepcopy(BOX)}],
            'unmapped_annotations': []}


def line(identifier='line1', text='4.00', **box):
    return {'id': identifier, 'text': text, 'confidence': .75, 'region': {**BOX, **box}}


def source(lines=None):
    return {'engine': 'test fixture', 'revision': '1', 'width': 1000, 'height': 1000,
            'document_sha256': SHA, 'page': 3, 'coordinate_space': COORDINATES,
            'lines': lines if lines is not None else [line()]}


class LocalizationTests(unittest.TestCase):
    def test_unique_exact_suggestion_preserves_input_and_geometric_estimates(self):
        result, ocr = geometry(), source()
        before_result, before_ocr = copy.deepcopy(result), copy.deepcopy(ocr)
        audit = create_localization_audit(result, ocr)
        self.assertEqual(result, before_result)
        self.assertEqual(ocr, before_ocr)
        self.assertFalse(audit['applied'])
        self.assertTrue(audit['human_review_required'])
        self.assertEqual(audit['geometry_positions'], 'model_estimate_unverified')
        proposal = audit['parameters'][0]
        self.assertEqual(proposal['status'], 'exact_unique')
        self.assertEqual(proposal['suggested_annotation_region'], BOX)
        self.assertEqual(proposal['raw_text'], '4.00')
        self.assertEqual(proposal['evidence_ids'], ['o1'])
        self.assertEqual(proposal['original_object_region'], result['parameters'][0]['object_region'])
        self.assertEqual(proposal['original_leader_points'], result['parameters'][0]['leader_points'])
        self.assertEqual(proposal['ocr_matches'][0]['confidence_min'], .75)
        attached = attach_localization_audit(result, audit)
        self.assertEqual(attached['parameters'], result['parameters'])
        self.assertNotIn('localization_audit', result)
        attached['localization_audit']['parameters'][0]['suggested_annotation_region']['x'] = .9
        self.assertEqual(audit['parameters'][0]['suggested_annotation_region'], BOX)

    def test_duplicate_text_occurrences_are_not_chosen_by_proximity_or_order(self):
        audit = create_localization_audit(geometry(), source([line(), line('line2', y=.8)]))
        p = audit['parameters'][0]
        self.assertEqual(p['status'], 'ambiguous')
        self.assertEqual(p['candidate_count'], 2)
        self.assertIsNone(p['suggested_annotation_region'])
        self.assertEqual(p['ocr_matches'][1]['ocr_line_ids'], ['line2'])

    def test_no_numeric_substrings_or_ocr_character_repairs(self):
        for target, observed in [('4.00', 'Ø4.00 ±0.05'), ('4.00±0.05', '4.00+0.05'),
                                 ('Ø0.90', '•0.90'), ('1.50', 'I.50'), ('0.68 REF.', '0.68')]:
            with self.subTest(target=target, observed=observed):
                a = create_localization_audit(geometry(target), source([line(text=observed)]))
                self.assertEqual(a['parameters'][0]['status'], 'unmatched')
                self.assertIsNone(a['parameters'][0]['suggested_annotation_region'])

    def test_canonical_punctuation_and_whitespace_do_not_drop_symbols(self):
        r = geometry('Ø 2.30 ± 0.05')
        a = create_localization_audit(r, source([line(text='⌀2.30±0.05')]))
        self.assertEqual(a['parameters'][0]['status'], 'exact_unique')
        self.assertEqual(a['parameters'][0]['ocr_matches'][0]['ocr_text'], '⌀2.30±0.05')
        self.assertEqual(normalize_text('Ａ mm²'), 'AMM2')
        # Full normalized annotation includes its unit; mm2 cannot match plain mm.
        a = create_localization_audit(geometry('4.00 mm²'), source([line(text='4.00 mm')]))
        self.assertEqual(a['parameters'][0]['status'], 'unmatched')

    def test_complete_cited_note_can_match_but_uncited_substring_cannot(self):
        note = 'WORKING HEIGHT 4.60mm (PER CONTACT): 63±15g'
        r = geometry('4.60mm')
        r['observations'][0]['raw_text'] = note
        a = create_localization_audit(r, source([line(text=note)]))
        p = a['parameters'][0]
        self.assertEqual(p['status'], 'exact_unique')
        self.assertEqual(p['matched_observation_ids'], ['o1'])
        self.assertEqual(p['match_target'], 'explicitly_cited_complete_observation')
        r['parameters'][0]['evidence_ids'] = []
        a = create_localization_audit(r, source([line(text=note)]))
        self.assertEqual(a['parameters'][0]['status'], 'unmatched')

    def test_ambiguous_cited_note_never_disappears_from_candidate_set(self):
        note = 'HEIGHT 4.60mm FORCE 63±15g'
        r = geometry('4.60mm')
        r['observations'][0]['raw_text'] = note
        a = create_localization_audit(r, source([line(text=note), line('line2', note, y=.8)]))
        self.assertEqual(a['parameters'][0]['status'], 'ambiguous')
        self.assertEqual(a['parameters'][0]['candidate_count'], 2)
        self.assertIsNone(a['parameters'][0]['suggested_annotation_region'])

    def test_citation_fallback_does_not_match_inside_a_different_number_or_area_unit(self):
        for value, note in [('4.00', 'HEIGHT 14.00 mm'), ('4.00', 'HEIGHT 4.001 mm'),
                            ('4.00mm', 'AREA 4.00mm2')]:
            r = geometry(value)
            r['observations'][0]['raw_text'] = note
            a = create_localization_audit(r, source([line(text=note)]))
            self.assertEqual(a['parameters'][0]['status'], 'unmatched')

    def test_adjacent_full_line_windows_are_bounded_and_spatial(self):
        target = 'DIMENSION STYLE\nMM ONLY'
        rows = [line(text='DIMENSION STYLE', width=.2), line('line2', 'MM ONLY', y=.225, width=.15)]
        a = create_localization_audit(geometry(target), source(rows))
        self.assertEqual(a['parameters'][0]['ocr_matches'][0]['window_size'], 2)
        self.assertEqual(a['parameters'][0]['ocr_matches'][0]['ocr_line_ids'], ['line1', 'line2'])
        rows[1]['region']['y'] = .8
        self.assertEqual(create_localization_audit(geometry(target), source(rows))['parameters'][0]['status'], 'unmatched')

    def test_non_candidate_never_receives_suggestion_even_when_text_matches(self):
        r = geometry()
        r['parameters'][0]['status'] = 'ambiguous'
        a = create_localization_audit(r, source())
        self.assertEqual(a['parameters'][0]['status'], 'not_candidate')
        self.assertIsNone(a['parameters'][0]['suggested_annotation_region'])

    def test_digest_is_defined_stable_and_excludes_embedded_audit(self):
        r = geometry()
        projection = {k: r[k] for k in ['schema_version', 'document_sha256', 'page', 'parameters', 'observations', 'unmapped_annotations']}
        expected = hashlib.sha256(canonical_json(projection).encode('utf-8')).hexdigest()
        self.assertEqual(geometry_sha256(r), expected)
        reordered = json.loads(json.dumps(r, sort_keys=True))
        self.assertEqual(geometry_sha256(reordered), expected)
        audit = create_localization_audit(r, source())
        embedded = attach_localization_audit(r, audit)
        embedded['elapsed_seconds'] = 42
        self.assertEqual(geometry_sha256(embedded), expected)
        self.assertEqual(validate_localization_audit(embedded, embedded['localization_audit']), audit)

    def test_stale_parameter_value_unit_evidence_or_geometry_is_rejected(self):
        r = geometry()
        audit = create_localization_audit(r, source())
        mutations = [lambda x: x['parameters'][0].update(value_raw='5.00'),
                     lambda x: x['parameters'][0].update(unit_raw='in'),
                     lambda x: x['parameters'][0].update(evidence_ids=[]),
                     lambda x: x['observations'][0].update(raw_text='changed'),
                     lambda x: x['parameters'][0]['object_region'].update(x=.5)]
        for mutate in mutations:
            changed = copy.deepcopy(r)
            mutate(changed)
            with self.assertRaisesRegex(ValueError, 'stale'):
                attach_localization_audit(changed, audit)

    def test_modified_audit_fields_and_boxes_are_rejected_by_recomputation(self):
        r = geometry()
        a = create_localization_audit(r, source())
        mutations = [lambda x: x['parameters'][0].update(raw_text='5.00'),
                     lambda x: x['parameters'][0].update(evidence_ids=[]),
                     lambda x: x['parameters'][0]['suggested_annotation_region'].update(x=.8),
                     lambda x: x.update(applied=True), lambda x: x.update(geometry_positions='verified')]
        for mutate in mutations:
            changed = copy.deepcopy(a)
            mutate(changed)
            with self.assertRaisesRegex(ValueError, 'recomputation'):
                validate_localization_audit(r, changed)

    def test_page_binding_coordinates_confidence_and_duplicate_ids_checked(self):
        changes = [lambda x: x.update(document_sha256='d'*64), lambda x: x.update(page=2),
                   lambda x: x.update(coordinate_space='crop_normalized'),
                   lambda x: x['lines'][0]['region'].update(x=1.1),
                   lambda x: x['lines'][0].update(confidence=float('nan')),
                   lambda x: x['lines'][0].update(confidence=True),
                   lambda x: x['lines'].append(copy.deepcopy(x['lines'][0]))]
        for change in changes:
            s = source()
            change(s)
            with self.assertRaises(ValueError):
                create_localization_audit(geometry(), s)

    def test_apple_adapter_retains_engine_and_raw_confidence(self):
        payload = {'engine': 'Apple Vision', 'revision': 3, 'width': 2000, 'height': 1546,
                   'observations': [{'index': 4, 'candidate_text': '4.00', 'confidence': .3,
                                     'bbox_top_left_normalized': BOX}]}
        s = apple_vision_source(payload, document_sha256=SHA, page=3, image_sha256='e'*64)
        self.assertEqual(s['lines'][0]['id'], 'ocr_4')
        self.assertEqual(s['lines'][0]['confidence'], .3)
        a = create_localization_audit(geometry(), s)
        self.assertEqual(a['summary']['exact_unique'], 1)
        self.assertEqual(a['ocr_source']['image_sha256'], 'e'*64)

    def test_cli_output_can_embed_without_overwriting_input_or_prior_audit(self):
        with tempfile.TemporaryDirectory() as td:
            directory = Path(td)
            original, ocr, output = [directory / name for name in ['result.json', 'ocr.json', 'copy.json']]
            original.write_text(json.dumps(geometry()))
            original_bytes = original.read_bytes()
            ocr.write_text(json.dumps(source()))
            argv = ['--geometry', str(original), '--ocr-json', str(ocr), '--output', str(output), '--embed']
            main(argv)
            embedded = json.loads(output.read_text())
            self.assertIn('localization_audit', embedded)
            self.assertEqual(original.read_bytes(), original_bytes)
            validate_localization_audit(embedded, embedded['localization_audit'])
            with self.assertRaises(FileExistsError):
                main(argv)


if __name__ == '__main__':
    unittest.main()
