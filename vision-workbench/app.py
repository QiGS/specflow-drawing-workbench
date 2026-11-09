"""Small authenticated HTTP entry for the existing workspace's hosted Runner."""
import argparse,hmac,json,os,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from provider import Config,ProviderFailure,run
from contract import SCHEMA_PATH,strict_json

MAX_BODY=45*1024*1024
SLOTS=threading.BoundedSemaphore(2)

def dispatch(value):
    allowed={'images','operation','product_name'}
    if not isinstance(value,dict) or set(value)-allowed or 'images' not in value:raise ValueError('Request must contain images and optional operation/product_name')
    images=value['images']
    if not isinstance(images,list) or any(not isinstance(i,dict) or 'path' in i or 'image_base64' not in i for i in images):
        raise ValueError('HTTP requests accept inline image_base64 only, never server filesystem paths')
    json_setting=os.environ.get('DRAWING_VLM_JSON_MODE','1').strip().lower()
    if json_setting not in ('1','true','0','false'):raise ValueError('DRAWING_VLM_JSON_MODE must be 1/true or 0/false')
    config=Config.from_env(timeout=float(os.environ.get('DRAWING_VLM_TIMEOUT','90')),
                           max_tokens=int(os.environ.get('DRAWING_VLM_MAX_TOKENS','8192')),json_mode=json_setting in ('1','true'))
    result,audit=run(config,images,value.get('operation','extract_page'),value.get('product_name'))
    return {'result':result,'audit':audit}

class Handler(BaseHTTPRequestHandler):
    server_version='DrawingVLM/2.0'
    def respond(self,status,value):
        body=json.dumps(value,ensure_ascii=False).encode()
        self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(body)));self.send_header('Cache-Control','no-store');self.end_headers()
        self.wfile.write(body)
    def authorized(self):
        token=os.environ.get('DRAWING_VLM_GATEWAY_TOKEN','')
        return bool(token) and hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+token)
    def do_GET(self):
        if self.path=='/health':
            try:Config.from_env().validate();configured=bool(os.environ.get('DRAWING_VLM_GATEWAY_TOKEN'))
            except ValueError:configured=False
            self.respond(200,{'service':'drawing-vlm','status':'ready' if configured else 'configuration_incomplete',
                              'provider_credentials_configured':configured,'provider_connectivity_tested':False});return
        if self.path=='/schema' and self.authorized():self.respond(200,strict_json(SCHEMA_PATH.read_text()));return
        self.respond(404,{'error':'not_found'})
    def do_POST(self):
        if self.path!='/api/vision-extract':self.respond(404,{'error':'not_found'});return
        if not self.authorized():self.respond(401,{'error':'gateway_authentication_required'});return
        if not SLOTS.acquire(blocking=False):self.respond(429,{'error':'too_many_requests'});return
        try:
            if self.headers.get_content_type()!='application/json':raise ValueError('Content-Type must be application/json')
            if self.headers.get('Transfer-Encoding'):raise ValueError('Chunked bodies are not accepted')
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=MAX_BODY:raise ValueError('Request size must be within the 45 MiB application limit')
            self.connection.settimeout(30)
            body=self.rfile.read(size)
            if len(body)!=size:raise ValueError('Incomplete request body')
            self.respond(200,dispatch(strict_json(body)))
        except ProviderFailure as exc:self.respond(502,{'error':exc.code,'message':str(exc),'audit':exc.audit})
        except (ValueError,OSError,KeyError,TypeError) as exc:self.respond(400,{'error':'invalid_request_or_configuration','message':str(exc)})
        finally:SLOTS.release()
    def log_message(self,*args):pass

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--host',default='127.0.0.1');p.add_argument('--port',type=int,default=int(os.environ.get('PORT','8080')));a=p.parse_args()
    if a.host not in ('127.0.0.1','localhost') and not os.environ.get('DRAWING_VLM_GATEWAY_TOKEN'):
        p.error('Non-loopback binding requires DRAWING_VLM_GATEWAY_TOKEN in the server environment')
    if not 1<=a.port<=65535:p.error('Invalid port')
    server=ThreadingHTTPServer((a.host,a.port),Handler);server.daemon_threads=True
    print(f'Drawing VLM service listening on {a.host}:{a.port}; no provider call has been made.',flush=True)
    server.serve_forever()

if __name__=='__main__':main()
