import json,threading,unittest,urllib.error,urllib.request
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from app import Handler

class LocalHTTPTests(unittest.TestCase):
    def test_real_loopback_health_auth_and_filesystem_boundary_without_provider_call(self):
        with patch.dict('os.environ',{'DRAWING_VLM_GATEWAY_TOKEN':'local-test-gateway-token'},clear=True):
            server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
            worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
            url=f'http://127.0.0.1:{server.server_port}'
            try:
                with urllib.request.urlopen(url+'/health',timeout=3) as response:
                    status=json.load(response)
                self.assertEqual(status['status'],'configuration_incomplete')
                self.assertFalse(status['provider_connectivity_tested'])
                body=json.dumps({'images':[{'path':'/not-readable-by-HTTP'}]}).encode()
                request=urllib.request.Request(url+'/api/vision-extract',data=body,headers={'Content-Type':'application/json'})
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request,timeout=3)
                self.assertEqual(error.exception.code,401)
                request.add_header('Authorization','Bearer local-test-gateway-token')
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request,timeout=3)
                self.assertEqual(error.exception.code,400)
                self.assertIn('filesystem paths',error.exception.read().decode())
                with patch.dict('os.environ',{},clear=True):
                    with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(request,timeout=3)
                    self.assertEqual(error.exception.code,401)
            finally:
                server.shutdown();server.server_close();worker.join(timeout=3)

if __name__=='__main__':unittest.main()
