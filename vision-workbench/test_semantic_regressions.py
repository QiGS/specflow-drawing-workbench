"""Regression shapes observed in the redacted 20261109 Qwen R02 API response.

Numbers below are a model-output fixture, not a ground-truth image label. They
are never part of PROMPT and never sent to a live model by these tests.
"""
import copy
import os
import unittest
from unittest.mock import patch
from app import dispatch
from contract import ContractError, validate_payload
from test_provider import field, sample


def case():
    payload=sample()
    text='8.33 ±0.13 DIA'
    payload['raw_text']=text
    payload['image_texts'][0]['raw_text']=text
    payload['observations'][0]['raw_text']=text
    item=field()
    item.update(name='Diameter',value_raw=text,nominal_raw='8.33',certainty='clear',
                tolerance={'raw':'±0.13','kind':'symmetric','amplitude_raw':'0.13',
                           'upper_raw':None,'lower_raw':None,'evidence_ids':['o1']})
    payload['fields']=[item]
    return payload


def check(payload):
    return validate_payload(payload,[{'image_id':'image_001'}],'extract_page')


class SemanticRegressionTests(unittest.TestCase):
    def test_real_failure_shape_stays_rejected_without_postprocessing(self):
        payload=case()
        item=payload['fields'][0]
        item.update(unit_raw='DIA',object='Eyelet Hole',view='Front View',association_evidence_ids=['o1'])
        item['tolerance'].update(upper_raw='+0.13',lower_raw='-0.13')
        before=copy.deepcopy(payload)
        with self.assertRaises(ContractError):check(payload)
        self.assertEqual(payload,before)

    def test_symmetric_tolerance_preserves_amplitude_and_rejects_invented_bounds(self):
        self.assertFalse(check(case())['engineering_value_approved'])
        for changes in ({'upper_raw':'+0.13','lower_raw':'-0.13'},
                        {'amplitude_raw':'+0.13'},{'amplitude_raw':'0.130'},
                        {'raw':'±0.14','amplitude_raw':'0.14'}):
            with self.subTest(changes=changes):
                payload=case();payload['fields'][0]['tolerance'].update(changes)
                with self.assertRaises(ContractError):check(payload)

    def test_modifiers_and_unprinted_units_cannot_become_dimension_units(self):
        for unit in ('DIA','DIA.','MIN','MAX','Ø','mm','in'):
            with self.subTest(unit=unit):
                payload=case();payload['fields'][0]['unit_raw']=unit
                with self.assertRaises(ContractError):check(payload)
        payload=case()
        unit_note=copy.deepcopy(payload['observations'][0])
        unit_note.update(id='units',raw_text='DIMENSIONS IN mm')
        payload['observations'].append(unit_note)
        payload['fields'][0].update(unit_raw='mm',name='Diameter (Metric)',evidence_ids=['o1','units'])
        self.assertTrue(check(payload)['schema_valid'])

    def test_brackets_or_decimal_values_do_not_authorize_metric_or_imperial_names(self):
        for name in ('Hole Diameter (Imperial)','Diameter Metric','直径（英制）','直径 公制'):
            with self.subTest(name=name):
                payload=case();payload['fields'][0]['name']=name
                with self.assertRaises(ContractError):check(payload)

    def test_dimension_observation_cannot_be_reused_or_cloned_as_association(self):
        payload=case();item=payload['fields'][0]
        item.update(view='Front View',association_evidence_ids=['o1'])
        with self.assertRaisesRegex(ContractError,'reused or cloned'):check(payload)
        duplicate=copy.deepcopy(payload['observations'][0]);duplicate['id']='clone'
        payload['observations'].append(duplicate);item['association_evidence_ids']=['clone']
        with self.assertRaisesRegex(ContractError,'reused or cloned'):check(payload)

    def test_association_needs_explicit_label_or_described_visual_relation(self):
        payload=case();item=payload['fields'][0]
        visual=copy.deepcopy(payload['observations'][0])
        visual.update(id='visual',kind='visual_structure',raw_text=None)
        payload['observations'].append(visual)
        item.update(object='circular hole',association_evidence_ids=['visual'])
        with self.assertRaises(ContractError):check(payload)
        visual['raw_text']='A visible leader joins the dimension callout to the circular hole.'
        self.assertFalse(check(payload)['prediction_consistency']['image_content_verified'])
        item['view']='Front View'
        with self.assertRaises(ContractError):check(payload)
        label=copy.deepcopy(payload['observations'][0]);label.update(id='view_label',raw_text='Front View')
        payload['observations'].append(label);item['association_evidence_ids'].append('view_label')
        self.assertTrue(check(payload)['reference_links_valid'])

    def test_http_json_mode_is_server_owned_and_true_by_default(self):
        for setting,expected in [(None,True),('0',False),('true',True)]:
            env={} if setting is None else {'DRAWING_VLM_JSON_MODE':setting}
            with self.subTest(setting=setting),patch.dict(os.environ,env,clear=True),patch('app.run',return_value=({},{})) as fake:
                dispatch({'images':[{'image_base64':'placeholder'}]})
                self.assertIs(fake.call_args.args[0].json_mode,expected)
        with self.assertRaises(ValueError):dispatch({'images':[],'json_mode':True})
        with patch.dict(os.environ,{'DRAWING_VLM_JSON_MODE':'unexpected'},clear=True):
            with self.assertRaises(ValueError):dispatch({'images':[{'image_base64':'placeholder'}]})


if __name__=='__main__':unittest.main()
