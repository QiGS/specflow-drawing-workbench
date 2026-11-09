"""Explicit-image CLI. Never accepts an API key as a command-line argument."""
import argparse,json,sys
from pathlib import Path
from contract import strict_json
from provider import Config,ProviderFailure,run

def save(path,value):
    with Path(path).open('x',encoding='utf8') as stream:json.dump(value,stream,ensure_ascii=False,indent=2);stream.write('\n')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    source=p.add_mutually_exclusive_group(required=True)
    source.add_argument('--image',action='append',help='Explicit PNG/JPEG/WebP; repeat for full-page multi-image input')
    source.add_argument('--input',help='JSON object {images:[{path,page,image_id,roi_px,rotation_cw}]} for mixed page/ROI input; no labels')
    p.add_argument('--roi',help='Single --image only: x,y,width,height in clockwise-rotated image pixels')
    p.add_argument('--rotation',type=int,choices=[0,90,180,270],default=0)
    p.add_argument('--operation',choices=['extract_page','transcribe_line'],default='extract_page')
    p.add_argument('--product-name')
    p.add_argument('--model',help='Account-available model; defaults to DRAWING_VLM_MODEL')
    p.add_argument('--output',required=True,help='New audit/result directory; never overwritten')
    p.add_argument('--max-edge',type=int,default=4096)
    p.add_argument('--max-tokens',type=int,default=8192,help='Application token limit; sent as max_completion_tokens for qwen3.8, max_tokens for other models')
    p.add_argument('--timeout',type=float,default=90)
    p.add_argument('--json-mode',action='store_true',help='Opt in only if provider/model supports response_format=json_object')
    a=p.parse_args();out=Path(a.output).expanduser().resolve()
    try:
        if out.exists():raise ValueError('Output directory already exists; choose a new path')
        if a.input:
            if a.roi or a.rotation:raise ValueError('For --input specify ROI/rotation inside each image record')
            input_path=Path(a.input).expanduser().resolve();value=strict_json(input_path.read_text())
            if not isinstance(value,dict) or set(value)!={'images'}:raise ValueError('Input JSON must contain only images; never an annotation manifest')
            specs=value['images']
            for item in specs:
                if 'path' in item and not Path(item['path']).is_absolute():item['path']=str((input_path.parent/item['path']).resolve())
        else:
            specs=[{'path':name,'rotation_cw':a.rotation} for name in a.image]
            if a.roi:
                if len(specs)!=1:raise ValueError('--roi requires one --image; use --input for per-image ROIs')
                parts=a.roi.split(',')
                if len(parts)!=4:raise ValueError('ROI must be x,y,width,height')
                specs[0]['roi_px']=[int(v) for v in parts]
        config=Config.from_env(a.model,timeout=a.timeout,max_tokens=a.max_tokens,json_mode=a.json_mode,max_edge=a.max_edge)
        config.validate()
        out.mkdir(parents=True)
        result,audit=run(config,specs,a.operation,a.product_name)
        save(out/'audit.json',audit);save(out/'result.json',result)
        print(json.dumps({'status':result['status'],'output':str(out),'model_returned':result['model_returned'],
                          'fields':len(result['payload']['fields']),'bom_rows':len(result['payload']['bom']),
                          'missing_fields':len(result['validation']['missing_fields']),'human_review_required':True},ensure_ascii=False))
        return 0
    except ProviderFailure as exc:
        if out.is_dir():save(out/'failed-audit.json',{'status':'failed','code':exc.code,'message':str(exc),'audit':exc.audit})
        print(f'{exc.code}: {exc}',file=sys.stderr);return 2
    except (ValueError,OSError,KeyError,TypeError) as exc:
        print(f'Input/configuration error: {exc}',file=sys.stderr);return 2

if __name__=='__main__':raise SystemExit(main())
