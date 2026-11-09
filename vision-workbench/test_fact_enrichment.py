import copy
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from contract import partition_validated_items
from fact_enrichment import enrich_observed_facts,validate_derived_candidates
from provider import Config,ProviderFailure,build_request_schema,run
from test_provider import sample,field,response


SOURCES=[{'image_id':'image_001','page':1,'document_sha256':'a'*64,'original_image_sha256':'b'*64}]


def add_observation(payload,id,text,image_id='image_001'):
    row=copy.deepcopy(payload['observations'][0]);row.update(id=id,raw_text=text,image_id=image_id)
    payload['observations'].append(row)
    return row


def observed_case():
    payload=sample();payload['fields']=[field()]
    add_observation(payload,'general','UNLESS SPECIFIED DIMENSIONS IN mm [INCHES] TOLERANCES ON: 2 PLC DEC ± 0.12[.004] 3 PLC DEC ± - ANGLES ± -')
    add_observation(payload,'packages','QUANTITY PACKAGE TYPE PART NO')
    add_observation(payload,'package_row','8 6 1200 ON TAPE, REEL P-EXAMPLE-9')
    add_observation(payload,'missing_quantity','6 4 - LOOSE PIECE P-EXAMPLE-2')
    return payload


class FactEnrichmentTests(unittest.TestCase):
    def test_supported_note_labels_pass_without_rewriting_values_but_wrong_note_is_rejected(self):
        payload=sample();item=field();payload['fields']=[item]
        payload['observations'][0]['raw_text']='2 THICKNESS 4.00 ±0.1'
        schema=build_request_schema('extract_page')
        for name in ('Note 2','注2','注释 2'):
            with self.subTest(name=name):
                item['name']=name;before=copy.deepcopy(payload)
                accepted,_,rejected,counts=partition_validated_items(payload,SOURCES,'extract_page',request_schema=schema)
                self.assertEqual(counts['accepted'],1);self.assertEqual(accepted['fields'],before['fields'])
                self.assertEqual(payload,before)
        item['name']='Note 3'
        _,_,rejected,counts=partition_validated_items(payload,SOURCES,'extract_page',request_schema=schema)
        self.assertEqual(counts['rejected'],1)
        self.assertIn('same visible note number',rejected['fields'][0]['error'])

    def test_decimal_value_or_note_number_on_an_unrelated_observation_is_not_note_evidence(self):
        payload=sample();item=field();item['name']='Note 2';payload['fields']=[item]
        add_observation(payload,'unrelated','2 SOME OTHER NOTE')
        _,_,rejected,counts=partition_validated_items(payload,SOURCES,'extract_page',request_schema=build_request_schema('extract_page'))
        self.assertEqual(counts['rejected'],1)

    def test_global_unit_and_tolerance_suggestions_never_apply_to_individual_fields(self):
        payload=observed_case();before=copy.deepcopy(payload)
        derived=enrich_observed_facts(payload,SOURCES)
        self.assertEqual(payload,before)
        suggestions=derived['reference_suggestions'];self.assertEqual(len(suggestions),4)
        unit=next(x for x in suggestions if x['kind']=='global_unit_declaration')
        self.assertEqual((unit['primary_unit_raw'],unit['secondary_unit_raw']),('mm','INCHES'))
        tolerances=[x for x in suggestions if x['kind']=='general_tolerance_declaration']
        self.assertEqual(tolerances[0]['amplitude_raw'],'0.12')
        self.assertEqual(tolerances[0]['secondary_amplitude_raw'],'.004')
        self.assertEqual(sum(x['value_status']=='not_provided' for x in tolerances),2)
        for item in suggestions:
            self.assertEqual(item['applied_to_field_ids'],[])
            self.assertFalse(item['engineering_value_approved'])
            self.assertEqual(item['status'],'pending_review')
        self.assertIsNone(payload['fields'][0]['unit_raw'])
        self.assertIsNone(payload['fields'][0]['tolerance'])

    def test_packaging_rows_keep_literal_quantity_part_and_unassigned_note_prefix(self):
        derived=enrich_observed_facts(observed_case(),SOURCES)
        rows=derived['packaging_variants'];self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]['package_quantity_raw'],'1200')
        self.assertEqual(rows[0]['part_number_raw'],'P-EXAMPLE-9')
        self.assertEqual(rows[0]['unassigned_prefix_raw'],'8 6 ')
        self.assertEqual(rows[1]['quantity_cell_raw'],'-')
        self.assertIsNone(rows[1]['package_quantity_raw'])
        for item in rows:
            self.assertIsNone(item['assembly_quantity_raw']);self.assertIsNone(item['item_number_raw'])
            self.assertEqual(item['quantity_meaning'],'packaging_amount_not_per_assembly')

    def test_ambiguous_headers_and_unrecognized_layout_are_preserved_unparsed(self):
        payload=observed_case();add_observation(payload,'second_header','QTY PACKAGING TYPE PART NUMBER')
        derived=enrich_observed_facts(payload,SOURCES)
        self.assertEqual(derived['packaging_variants'],[])
        self.assertEqual(len(derived['table_analysis']['unparsed_table_rows']),2)
        self.assertTrue(all(x['reason']=='ambiguous_packaging_header' for x in derived['table_analysis']['unparsed_table_rows']))

    def test_derived_validation_rejects_changed_literals_and_autoapproval(self):
        payload=observed_case();derived=enrich_observed_facts(payload,SOURCES)
        for mutate in (lambda d:d['packaging_variants'][0].update(part_number_raw='OTHER'),
                       lambda d:d['reference_suggestions'][0].update(applied_to_field_ids=['f1']),
                       lambda d:d['packaging_variants'][0].update(assembly_quantity_raw='1200')):
            damaged=copy.deepcopy(derived);mutate(damaged)
            tables={**damaged['table_analysis'],'packaging_variants':damaged['packaging_variants']}
            with self.assertRaises(ValueError):validate_derived_candidates(damaged['reference_suggestions'],tables,payload,SOURCES)

    def test_packaging_quantity_cannot_be_accepted_as_assembly_BOM(self):
        payload=observed_case()
        payload['bom']=[{'id':'b1','item_raw':None,'part_number_raw':'P-EXAMPLE-9','name_raw':None,
                         'quantity_raw':'1200','unit_raw':None,'material_raw':None,
                         'evidence_ids':['package_row','packages'],'review_status':'pending'}]
        accepted,_,rejected,counts=partition_validated_items(payload,SOURCES,'extract_page',request_schema=build_request_schema('extract_page'))
        self.assertEqual(accepted['bom'],[])
        self.assertEqual(rejected['bom'][0]['error_code'],'table_classification_violation')
        self.assertEqual(rejected['bom'][0]['item'],payload['bom'][0])

    def test_provider_exposes_separate_derived_arrays_and_audit_without_modifying_payload(self):
        payload=observed_case();before=copy.deepcopy(payload)
        with tempfile.TemporaryDirectory() as tmp:
            image=Path(tmp)/'synthetic.png';Image.new('RGB',(100,80),'white').save(image)
            result,audit=run(Config(model='qwen3.8-max',api_key='unit-test-env-secret'),[{'path':str(image)}],transport=lambda *args:response(payload))
        self.assertEqual(result['payload'],before)
        self.assertEqual(result['reference_suggestions'],audit['reference_suggestions'])
        self.assertEqual(len(result['packaging_variants']),2)
        self.assertFalse(result['derived_facts_validation']['field_values_modified'])


if __name__=='__main__':unittest.main()
