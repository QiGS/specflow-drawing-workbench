import copy
import unittest
from geometry_protocol import adapt
from geometry_v2 import validate
from test_geometry_v2 import fixture, candidate, SHA, BOX

class GeometryProtocolTests(unittest.TestCase):
    def test_normalizes_protocol_status_and_id_without_changing_engineering_values(self):
        payload,obs=fixture();p=payload['parameters'][0];p['status']='provided';p['id']=12
        before=copy.deepcopy(payload);result,changes=adapt(payload,obs)
        self.assertEqual(payload,before);self.assertEqual(result['parameters'][0]['id'],'p_12')
        self.assertEqual(result['parameters'][0]['status'],'candidate');self.assertEqual(len(changes),2)
        for key in ('key','value_raw','nominal_raw','unit_raw','tolerance_raw','limit','object_region','leader_points','reason','evidence_ids'):
            self.assertEqual(result['parameters'][0][key],before['parameters'][0][key])
        self.assertEqual(validate(result,obs,SHA,1)['parameters'][0]['status'],'candidate')
    def test_does_not_promote_approved_or_other_unknown_status(self):
        for status in ('approved','confirmed','valid'):
            payload,obs=fixture();payload['parameters'][0]['status']=status
            result,changes=adapt(payload,obs)
            self.assertEqual(result['parameters'][0]['status'],status)
            with self.assertRaises(ValueError):validate(result,obs,SHA,1)
    def test_integer_conversion_collision_and_bool_are_not_silently_accepted(self):
        payload,obs=fixture();payload['parameters'][0]['id']=1;payload['parameters'].append(candidate(id='p_1'))
        with self.assertRaisesRegex(ValueError,'duplicate'):adapt(payload,obs)
        payload,obs=fixture();payload['parameters'][0]['id']=True
        result,_=adapt(payload,obs)
        with self.assertRaises(ValueError):validate(result,obs,SHA,1)
    def test_literal_newline_decoding_requires_exact_cited_quotes(self):
        payload,obs=fixture();payload['parameters'][0]['evidence_text']='8.33 ±0.13 DIA\\nDIMENSIONS IN mm'
        result,changes=adapt(payload,obs)
        self.assertEqual(result['parameters'][0]['evidence_text'],'8.33 ±0.13 DIA\nDIMENSIONS IN mm')
        self.assertEqual(len(changes),1);validate(result,obs,SHA,1)
        payload['parameters'][0]['evidence_text']='88.33 ±0.13 DIA\\nDIMENSIONS IN mm'
        result,changes=adapt(payload,obs);self.assertEqual(changes,[])
        with self.assertRaises(ValueError):validate(result,obs,SHA,1)
    def test_english_dictionary_only_translates_known_context_labels(self):
        for component,translated in [('CONTACT PIN','接触针'),('BACK COVER','后盖'),('2 PIN POGO PIN CONNECTOR','2 针弹簧针连接器')]:
            payload,obs=fixture();payload['parameters'][0]['component']=component
            payload['parameters'][0]['view']='RECOMMEND PCB LAYOUT COMPONENT SIDE'
            result,changes=adapt(payload,obs);self.assertEqual(result['parameters'][0]['component'],translated)
            self.assertEqual(result['parameters'][0]['view'],'推荐印制板布局（元件侧）')
            self.assertIn(component,[x['old'] for x in changes])
            validate(result,obs,SHA,1)
        payload,obs=fixture();payload['parameters'][0]['component']='UNKNOWN_SPECIAL_PART'
        result,changes=adapt(payload,obs);self.assertEqual(changes,[])
        with self.assertRaises(ValueError):validate(result,obs,SHA,1)
    def test_explicit_note_region_copies_one_source_and_never_infers_object(self):
        payload,obs=fixture();obs={'note':{'id':'note','raw_text':'WORKING HEIGHT 4.80mm','region':BOX}}
        payload['parameters']=[candidate(key='working_mating_height',value_raw='4.80',nominal_raw='4.80',unit_raw='mm',tolerance_raw=None,evidence_mode='explicit_note',annotation_region=None,object_region=None,leader_points=[],evidence_text='WORKING HEIGHT 4.80mm',evidence_ids=['note'],reason='文字明确标出工作高度，未推断实体位置。')]
        result,changes=adapt(payload,obs)
        self.assertEqual(result['parameters'][0]['annotation_region'],BOX);self.assertIsNone(result['parameters'][0]['object_region']);self.assertEqual(result['parameters'][0]['leader_points'],[])
        self.assertIn('sole cited observation note',changes[0]['basis']);validate(result,obs,SHA,1)
        obs['note2']=dict(obs['note'],id='note2');payload['parameters'][0]['evidence_ids'].append('note2')
        result,changes=adapt(payload,obs);self.assertIsNone(result['parameters'][0]['annotation_region'])
        with self.assertRaises(ValueError):validate(result,obs,SHA,1)
    def test_unsupported_bad_geometry_and_invented_units_are_never_fixed(self):
        payload,obs=fixture();payload['parameters'][0].update(object_region=None,unit_raw='inch')
        result,changes=adapt(payload,obs);self.assertEqual(result,payload);self.assertEqual(changes,[])
        with self.assertRaises(ValueError):validate(result,obs,SHA,1)

if __name__=='__main__':unittest.main()
