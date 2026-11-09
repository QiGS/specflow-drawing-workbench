import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from contract import validate_payload
from provider import Config, ProviderFailure, canonical_payload_sha, run
from test_provider import field, response, sample


class PartialValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.image=Path(self.tmp.name)/'synthetic.png';Image.new('RGB',(100,80),'white').save(self.image)
        self.config=Config(model='qwen3.8-max',api_key='unit-test-env-secret')

    def invoke(self,payload):
        status,raw=response(payload)
        result,audit=run(self.config,[{'path':str(self.image)}],transport=lambda *args:(status,raw))
        self.assertEqual(audit['raw_response_sha256'],hashlib.sha256(raw).hexdigest())
        self.assertFalse(result['network_call_performed'])
        return result,audit

    def test_mixed_fields_keep_complete_rejected_candidate_and_strict_accepted_subset(self):
        payload=sample();good=field();bad=copy.deepcopy(good)
        bad.update(id='bad',object='Unsubstantiated object',association_evidence_ids=[])
        payload['fields']=[good,bad];before=copy.deepcopy(payload)
        result,audit=self.invoke(payload)
        self.assertEqual(result['status'],'partial_valid_unreviewed')
        self.assertEqual(result['payload']['fields'],[good])
        self.assertEqual(result['rejected_fields'][0]['item'],bad)
        self.assertEqual(result['rejected_fields'][0]['error_code'],'task_scope_violation')
        self.assertEqual(result['model_payload_before_item_validation'],before)
        self.assertEqual(result['model_payload_before_item_validation_sha256'],canonical_payload_sha(before))
        self.assertEqual(result['item_validation_counts']['fields'],{'total':2,'accepted':1,'rejected':1})
        self.assertEqual(audit['rejected_fields'],result['rejected_fields'])
        self.assertEqual(payload,before)
        self.assertEqual(result['validation']['scope'],'accepted_fields_and_bom_only')
        self.assertFalse(result['validation']['complete_document_valid'])
        self.assertTrue(validate_payload(result['payload'],result['sources'],'extract_page')['schema_valid'])

    def test_bom_acceptance_counts_toward_partial_and_bad_quantity_is_not_repaired(self):
        payload=sample();payload['observations'][0]['raw_text']='7 COMPONENT P7'
        header=copy.deepcopy(payload['observations'][0]);header.update(id='bom_header',raw_text='ASSEMBLY COMPONENTS QTY PER ASSEMBLY PART NO')
        payload['observations'].append(header)
        good={'id':'bom_good','item_raw':None,'part_number_raw':'P7','name_raw':'COMPONENT',
              'quantity_raw':'7','unit_raw':None,'material_raw':None,'evidence_ids':['o1','bom_header'],'review_status':'pending'}
        bad={**good,'id':'bom_bad','quantity_raw':'9'}
        payload['bom']=[good,bad]
        result,_=self.invoke(payload)
        self.assertEqual(result['status'],'partial_valid_unreviewed')
        self.assertEqual(result['payload']['bom'],[good])
        self.assertEqual(result['rejected_bom'][0]['item']['quantity_raw'],'9')
        self.assertEqual(result['item_validation_counts']['accepted'],1)
        self.assertEqual(result['item_validation_counts']['rejected'],1)

    def test_all_rejected_remains_failure_with_full_isolation_details(self):
        payload=sample();bad=field();bad.update(object='Unsupported',association_evidence_ids=[])
        payload['fields']=[bad]
        with self.assertRaises(ProviderFailure) as error:self.invoke(payload)
        self.assertEqual(error.exception.code,'no_valid_items')
        audit=error.exception.audit
        self.assertEqual(audit['item_validation_counts']['accepted'],0)
        self.assertEqual(audit['rejected_fields'][0]['item'],bad)
        self.assertEqual(audit['model_payload_before_item_validation'],payload)

    def test_global_schema_source_and_reference_errors_still_fail_whole_response(self):
        mutations=[lambda p:p['observations'][0].update(image_id='unknown'),
                   lambda p:p['fields'][1].update(evidence_ids=['missing']),
                   lambda p:p['fields'][1].update(id=p['fields'][0]['id']),
                   lambda p:p['fields'][1].update(nominal_raw=4.00),
                   lambda p:p['observations'][0]['region'].update(x=.99)]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                payload=sample();one=field();two={**field(),'id':'two'}
                payload['fields']=[one,two];mutate(payload)
                with self.assertRaises(ProviderFailure) as error:self.invoke(payload)
                self.assertEqual(error.exception.code,'invalid_model_output')
                self.assertNotIn('item_validation_counts',error.exception.audit)


if __name__=='__main__':unittest.main()
