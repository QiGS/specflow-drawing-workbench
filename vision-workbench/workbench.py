#!/usr/bin/env python3
"""Local drawing workbench: python workbench.py --port 8765.

Bind is always 127.0.0.1. The printed one-use bootstrap URL establishes an
HttpOnly local session; its random token is unrelated to the provider key.
Provider credentials/configuration come only from the parent process environment.
PDF support is optional: install PyMuPDF in the deployment environment to enable it.
"""
from __future__ import annotations
import argparse
import base64
from dataclasses import dataclass, field
import hashlib
import hmac
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import math
import os
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

from PIL import Image, ImageOps, UnidentifiedImageError
import app
from contract import strict_json
from provider import Config, ProviderFailure, redact
import geometry
import geometry_config

ROOT = Path(__file__).resolve().parent
MAX_UPLOAD = 30 * 1024 * 1024
MAX_PAGES = 20
MAX_RENDER_PIXELS = 50_000_000
MAX_EDGE = 4000
COOKIE = 'drawing_workbench_session'
SESSION_SECONDS = 8 * 3600
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"


class InputError(ValueError):
    def __init__(self, message, status=400, code='invalid_input'):
        super().__init__(message); self.status=status; self.code=code


def pdf_module():
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        return None


def sha(data): return hashlib.sha256(data).hexdigest()


@dataclass
class Page:
    number: int
    width: int
    height: int
    png: bytes
    preprocessing: dict = field(default_factory=dict)


@dataclass
class Document:
    id: str
    name: str
    source_sha256: str
    source_bytes: int
    kind: str
    pages: list[Page]

    def public(self):
        return {'id':self.id,'name':self.name,'source_sha256':self.source_sha256,
                'source_bytes':self.source_bytes,'kind':self.kind,'page_count':len(self.pages),
                'scope':'full_page_only','pages':[{'page':p.number,'width':p.width,'height':p.height,
                'image_sha256':sha(p.png),'preprocessing':p.preprocessing,'preview_url':f'/api/page/{self.id}/{p.number}.png'} for p in self.pages]}


def safe_name(name):
    value=unquote(name or '未命名文件').replace('\\','/').split('/')[-1]
    value=''.join(c for c in value if ord(c)>=32 and c not in '\u202a\u202b\u202d\u202e\u2066\u2067\u2068\u2069')
    return value[:180] or '未命名文件'


def validated_result_state(result):
    """Accept only the provider's strictly validated subset, never promote rejects."""
    status=result.get('status');validation=result.get('validation',{})
    if status not in ('valid_unreviewed','partial_valid_unreviewed') or not validation.get('schema_valid') or not validation.get('reference_links_valid'):
        raise InputError('后端结果未通过格式与引用校验，未作为结构化字段展示。',502,'unvalidated_backend_result')
    rejected_fields=result.get('rejected_fields',[]);rejected_bom=result.get('rejected_bom',[])
    if status=='valid_unreviewed':
        if rejected_fields or rejected_bom:raise InputError('后端拒收计数与结果状态不一致。',502,'unvalidated_backend_result')
        return 'validated_unreviewed'
    payload=result.get('payload',{});counts=result.get('item_validation_counts',{})
    original=result.get('model_payload_before_item_validation')
    if (validation.get('scope')!='accepted_fields_and_bom_only' or validation.get('complete_document_valid') is not False
            or not isinstance(original,dict) or not isinstance(rejected_fields,list) or not isinstance(rejected_bom,list)):
        raise InputError('部分结果缺少完整候选或逐项校验记录。',502,'unvalidated_backend_result')
    accepted_total=0;rejected_total=0
    for key,rejected in [('fields',rejected_fields),('bom',rejected_bom)]:
        accepted=payload.get(key,[]);count=counts.get(key,{})
        if (not isinstance(accepted,list) or not isinstance(original.get(key),list)
                or any(not isinstance(r,dict) or 'item' not in r or not isinstance(r.get('error'),str) for r in rejected)
                or count.get('accepted')!=len(accepted) or count.get('rejected')!=len(rejected)
                or count.get('total')!=len(accepted)+len(rejected) or len(original[key])!=count.get('total')):
            raise InputError('部分结果的候选、拒收记录与计数不一致。',502,'unvalidated_backend_result')
        accepted_total+=len(accepted);rejected_total+=len(rejected)
    if (accepted_total<1 or rejected_total<1 or counts.get('accepted')!=accepted_total
            or counts.get('rejected')!=rejected_total or counts.get('total')!=accepted_total+rejected_total):
        raise InputError('部分结果必须同时有通过及拒收条目。',502,'unvalidated_backend_result')
    return 'partial_validated_unreviewed'


def decode_document(data, name, content_type):
    if not data or len(data)>MAX_UPLOAD: raise InputError('文件须小于或等于30 MiB。',413,'file_too_large')
    pages=[]
    if data.startswith(b'%PDF-'):
        module=pdf_module()
        if module is None:
            raise InputError('当前部署环境未安装PyMuPDF，PDF尚未解析。请安装依赖后重试，或先上传页面图片。',501,'pdf_dependency_missing')
        try:
            with module.open(stream=data,filetype='pdf') as pdf:
                if pdf.needs_pass: raise InputError('暂不支持加密PDF，请上传可直接读取的文件。')
                if not 1<=pdf.page_count<=MAX_PAGES: raise InputError('PDF须为1–20页；请先拆分较长文件。',413,'pdf_page_limit')
                settings=[]; projected=0
                for p in pdf:
                    rect=p.rect
                    if not math.isfinite(rect.width+rect.height) or min(rect.width,rect.height)<=0:
                        raise InputError('PDF页面尺寸无效。')
                    scale=MAX_EDGE/max(rect.width,rect.height)
                    w,h=math.ceil(rect.width*scale),math.ceil(rect.height*scale)
                    projected+=w*h;settings.append(scale)
                if projected>MAX_RENDER_PIXELS:
                    raise InputError('PDF全部页面的渲染像素超过50M，请拆分文件后上传。',413,'pdf_pixel_limit')
                actual=0
                for number,scale in enumerate(settings,1):
                    pix=pdf[number-1].get_pixmap(matrix=module.Matrix(scale,scale),colorspace=module.csRGB,alpha=False)
                    actual+=pix.width*pix.height
                    if actual>MAX_RENDER_PIXELS:raise InputError('PDF渲染像素超过50M。',413,'pdf_pixel_limit')
                    rect=pdf[number-1].rect
                    pages.append(Page(number,pix.width,pix.height,pix.tobytes('png'),
                                      {'operation':'pdf_page_render','page_size_points':[rect.width,rect.height],
                                       'scale':scale,'rendered_size':[pix.width,pix.height],'max_edge':MAX_EDGE}))
        except InputError:raise
        except Exception as exc:raise InputError('PDF读取失败，未生成解析结果。') from exc
        kind='pdf'
    else:
        if content_type=='application/pdf':raise InputError('文件不是有效PDF。')
        try:
            with Image.open(io.BytesIO(data)) as raw:
                if raw.format not in ('PNG','JPEG','WEBP'):
                    raise InputError('仅支持PNG、JPG、WebP图片和PDF。',415,'unsupported_file')
                if getattr(raw,'n_frames',1)!=1:raise InputError('暂不支持动图或多帧图片。')
                if raw.width*raw.height>MAX_RENDER_PIXELS:raise InputError('图片像素超过50M。',413,'image_pixel_limit')
                original_size=list(raw.size);orientation=raw.getexif().get(274)
                image=ImageOps.exif_transpose(raw).convert('RGB');canonical_size=list(image.size)
                resized=max(image.size)>MAX_EDGE
                if resized:
                    scale=MAX_EDGE/max(image.size)
                    image=image.resize((max(1,round(image.width*scale)),max(1,round(image.height*scale))),Image.Resampling.LANCZOS)
                buffer=io.BytesIO();image.save(buffer,format='PNG')
                pages=[Page(1,image.width,image.height,buffer.getvalue(),
                            {'operation':'exif_transpose_rgb_optional_resize_png','original_size':original_size,
                             'exif_orientation':orientation,'canonical_size':canonical_size,'rendered_size':list(image.size),
                             'resize_applied':resized,'scale_x':image.width/canonical_size[0],'scale_y':image.height/canonical_size[1],
                             'max_edge':MAX_EDGE,'source_hash_basis':'original_uploaded_file_bytes'})]
        except InputError:raise
        except (UnidentifiedImageError,OSError,ValueError,Image.DecompressionBombError) as exc:
            raise InputError('无法读取图片，请检查文件格式和完整性。') from exc
        kind='image'
    return Document(secrets.token_hex(16),safe_name(name),sha(data),len(data),kind,pages)


class WorkbenchState:
    def __init__(self, dispatch=None,geometry_options=None):
        self.bootstrap_token=secrets.token_urlsafe(32)
        self.session_token=None;self.session_expires=0
        self.document=None
        self.stage_one={}
        self.geometry_options=dict(geometry_options or {})
        self.lock=threading.Lock();self.slot=threading.BoundedSemaphore(1)
        self.dispatch=dispatch or app.dispatch

    def redeem(self, token):
        with self.lock:
            if not self.bootstrap_token or not isinstance(token,str) or not hmac.compare_digest(token,self.bootstrap_token):return None
            self.bootstrap_token=None;self.session_token=secrets.token_urlsafe(32)
            self.session_expires=time.monotonic()+SESSION_SECONDS
            return self.session_token

    def authenticated(self, cookie_header):
        try:
            cookie=SimpleCookie();cookie.load(cookie_header or '')
            value=cookie[COOKIE].value if COOKIE in cookie else ''
        except CookieError:return False
        return bool(self.session_token and time.monotonic()<self.session_expires and hmac.compare_digest(value,self.session_token))


class Handler(BaseHTTPRequestHandler):
    server_version='DrawingWorkbench/1.0'
    protocol_version='HTTP/1.0'

    @property
    def state(self):return self.server.state
    @property
    def origin(self):return f'http://127.0.0.1:{self.server.server_port}'

    def send(self,status,body,mime='application/json; charset=utf-8',extra=None):
        if isinstance(body,(dict,list)):
            body=json.dumps(redact(body,os.environ.get('DRAWING_VLM_API_KEY','')),ensure_ascii=False).encode()
        elif isinstance(body,str):body=body.encode()
        self.send_response(status)
        headers={'Content-Type':mime,'Content-Length':str(len(body)),'Cache-Control':'no-store',
                 'Pragma':'no-cache','Content-Security-Policy':CSP,'X-Content-Type-Options':'nosniff',
                 'X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'}
        headers.update(extra or {})
        for k,v in headers.items():self.send_header(k,v)
        self.end_headers();self.wfile.write(body)

    def host_ok(self):
        hosts=self.headers.get_all('Host',[])
        if len(hosts)!=1 or hosts[0]!=f'127.0.0.1:{self.server.server_port}':
            self.send(403,{'error':'invalid_host','message':'只允许当前127.0.0.1地址访问。'});return False
        return True

    def session_ok(self):
        if not self.state.authenticated(self.headers.get('Cookie')):
            self.send(401,{'error':'session_required','message':'请使用启动终端显示的一次性入口登录；会话过期后重新启动工作台。'});return False
        return True

    def do_GET(self):
        if not self.host_ok():return
        parsed=urlsplit(self.path)
        if parsed.path=='/bootstrap':
            params=parse_qs(parsed.query,keep_blank_values=True)
            if set(params)!={'token'} or len(params['token'])!=1:
                self.send(403,{'error':'invalid_bootstrap'});return
            token=self.state.redeem(params['token'][0])
            if not token:self.send(403,{'error':'bootstrap_used_or_invalid','message':'入口已使用或无效，请使用已有会话或重新启动。'});return
            self.send(303,b'',extra={'Location':'/','Set-Cookie':f'{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}'})
            return
        if parsed.path=='/health' and not parsed.query:
            try:geometry_config.from_env(**self.state.geometry_options);configured=True
            except (ValueError,TypeError):configured=False
            self.send(200,{'service':'local-drawing-workbench','configured':configured,'provider_connectivity_tested':False})
            return
        if not self.session_ok():return
        if parsed.query:self.send(404,{'error':'not_found'});return
        assets={'/':('workbench.html','text/html; charset=utf-8'),'/workbench.js':('workbench.js','text/javascript; charset=utf-8'),'/workbench.css':('workbench.css','text/css; charset=utf-8')}
        if parsed.path in assets:
            name,mime=assets[parsed.path];self.send(200,(ROOT/'static'/name).read_bytes(),mime);return
        if parsed.path=='/api/session':
            try:geometry_config.from_env(**self.state.geometry_options);configured=True
            except (ValueError,TypeError):configured=False
            settings=geometry_config.public_settings(geometry_config.from_env(**self.state.geometry_options)) if configured else None
            self.send(200,{'configured':configured,'model':os.environ.get('DRAWING_VLM_MODEL',''),'geometry_configuration':settings,
                          'pdf_supported':pdf_module() is not None,'provider_connectivity_tested':False,
                          'credential_expires':os.environ.get('DRAWING_VLM_CREDENTIAL_EXPIRES') if re.fullmatch(r'\d{4}-\d{2}-\d{2}',os.environ.get('DRAWING_VLM_CREDENTIAL_EXPIRES','')) else None,
                          'full_page_only':True,'limits':{'file_bytes':MAX_UPLOAD,'pdf_pages':MAX_PAGES,'render_pixels':MAX_RENDER_PIXELS}});return
        match=re.fullmatch(r'/api/page/([0-9a-f]{32})/([1-9][0-9]*)\.png',parsed.path)
        if match:
            doc=self.state.document;page=int(match[2])
            if not doc or doc.id!=match[1] or not 1<=page<=len(doc.pages):self.send(404,{'error':'page_not_found'});return
            self.send(200,doc.pages[page-1].png,'image/png');return
        self.send(404,{'error':'not_found'})

    def read_body(self,limit):
        lengths=self.headers.get_all('Content-Length',[])
        if self.headers.get('Transfer-Encoding') or len(lengths)!=1:
            raise InputError('请求必须使用明确的Content-Length。')
        try:size=int(lengths[0])
        except ValueError:raise InputError('请求长度无效。') from None
        if not 0<size<=limit:raise InputError('请求大小超出限制。',413,'request_too_large')
        self.connection.settimeout(30);body=self.rfile.read(size)
        if len(body)!=size:raise InputError('上传未完成，请重新选择文件。')
        return body

    def do_POST(self):
        if not self.host_ok():return
        origins=self.headers.get_all('Origin',[])
        if len(origins)!=1 or origins[0]!=self.origin:
            self.send(403,{'error':'same_origin_required','message':'拒绝跨来源请求。'});return
        if not self.session_ok():return
        if self.path not in ('/api/upload','/api/extract','/api/geometry','/api/stage-one'):
            self.send(404,{'error':'not_found'});return
        if not self.state.slot.acquire(blocking=False):
            self.send(429,{'error':'busy','message':'已有处理任务，请等待完成。'});return
        try:
            if self.path=='/api/upload':
                content=self.headers.get_content_type()
                if content not in ('application/pdf','image/png','image/jpeg','image/webp','application/octet-stream'):
                    raise InputError('仅支持PDF、PNG、JPG和WebP。',415,'unsupported_file')
                doc=decode_document(self.read_body(MAX_UPLOAD),self.headers.get('X-File-Name'),content)
                self.state.document=doc
                self.state.stage_one={}
                self.send(200,{'document':doc.public(),'message':'文件已在本机读取，尚未调用模型。'});return
            if self.headers.get_content_type()!='application/json':raise InputError('提取请求必须为JSON。')
            value=strict_json(self.read_body(10*1024*1024 if self.path=='/api/stage-one' else 4096))
            if self.path=='/api/stage-one':
                if not isinstance(value,dict) or set(value)!={'document_id','page','result'}:raise InputError('导入仅接受当前文档ID、页码和结果。')
                doc=self.state.document;page=value['page'];result=value['result']
                if not doc or value['document_id']!=doc.id or type(page) is not int or not 1<=page<=len(doc.pages):raise InputError('导入文档或页码无效。')
                validated_result_state(result)
                geometry.stage_observations(result,doc.source_sha256,page)
                self.state.stage_one[page]=result
                self.send(200,{'state':'imported_unreviewed','result':result,'selected_page':page});return
            if not isinstance(value,dict) or set(value)!={'document_id','page'}:
                raise InputError('仅接受已上传文档ID和页码；不接受路径、endpoint、模型或额外提示参数。')
            doc=self.state.document;page=value['page']
            if not doc or value['document_id']!=doc.id or type(page) is not int or not 1<=page<=len(doc.pages):
                raise InputError('文档或页码无效，请重新上传或选择页面。')
            p=doc.pages[page-1]
            if self.path=='/api/geometry':
                stage=self.state.stage_one.get(page)
                config=geometry_config.from_env(**self.state.geometry_options)
                result,audit=geometry.run_prepared(config,p.png,doc.source_sha256,stage,page)
                self.send(200,{'state':'geometry_candidates','result':result,'audit':audit,'selected_page':page});return
            request={'images':[{'image_base64':base64.b64encode(p.png).decode(),
                               'image_id':f'doc_{doc.id}_p{page}','page':page,
                               'source_document_sha256':doc.source_sha256}], 'operation':'extract_page'}
            response=self.state.dispatch(request)
            result=response.get('result',{})
            display_state=validated_result_state(result)
            self.state.stage_one[page]=result
            self.send(200,{'state':display_state,'document':doc.public(),'selected_page':page,
                           'result':result,'audit':response.get('audit',{}),'scope':'full_page_only'})
        except ProviderFailure as exc:
            self.send(502,{'state':'failed_candidate','error':exc.code,'message':str(exc),'audit':exc.audit,
                           'human_review_required':True,'structured_fields_accepted':False})
        except InputError as exc:self.send(exc.status,{'state':'failed_candidate','error':exc.code,'message':str(exc)})
        except (ValueError,OSError,KeyError,TypeError) as exc:
            self.send(400,{'state':'failed_candidate','error':'invalid_request_or_configuration',
                           'message':redact(str(exc),os.environ.get('DRAWING_VLM_API_KEY',''))})
        finally:self.state.slot.release()

    def do_OPTIONS(self):
        if self.host_ok():self.send(405,{'error':'method_not_allowed'})

    def log_message(self,*args):pass  # Never log bootstrap query tokens or input content.


def create_server(port=8765,dispatch=None,geometry_options=None):
    if type(port) is not int or not 0<=port<=65535:raise ValueError('Invalid port')
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler);server.daemon_threads=True
    server.state=WorkbenchState(dispatch,geometry_options)
    return server


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--port',type=int,default=8765)
    geometry_config.add_cli_arguments(p,prefix='geometry-');a=p.parse_args()
    server=create_server(a.port,geometry_options=geometry_config.cli_options(a,prefix='geometry-'))
    print(f'本机图纸工作台：http://127.0.0.1:{server.server_port}/bootstrap?token={server.state.bootstrap_token}',flush=True)
    print('仅本机监听；入口token为一次性会话凭据，不是模型密钥。尚未调用模型。',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()


if __name__=='__main__':main()
