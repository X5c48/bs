"""Install the Wuying LTX-Video preset's two verified weights into shared ComfyUI models."""

import argparse, concurrent.futures, hashlib, os, pathlib, re, subprocess, time
from itertools import zip_longest

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--comfy-shared-dir", type=pathlib.Path, default=pathlib.Path(r"D:\Comfy-Desktop\ComfyUI-Shared"),
                    help="Existing ComfyUI shared folder with models/checkpoints and models/text_encoders.")
parser.add_argument("--workers", type=int, choices=range(1, 25), default=12)
args = parser.parse_args()
root = args.comfy_shared_dir.resolve(strict=True)
if not (root / "models" / "checkpoints").is_dir() or not (root / "models" / "text_encoders").is_dir():
    parser.error("The shared folder does not contain both required ComfyUI model folders.")
cache = root / ".wuying-model-downloads"
cache.mkdir(exist_ok=True)
base = "https://modelscope.cn/api/v1/models/"
mirror = "https://hf-mirror.com/"
models = [
    ("checkpoints", "ltxv-2b-0.9.6-distilled-04-25.safetensors",
     "94891bd4bd08de30d484befbfc54fdcffe6d1596a131baad700b9baa5e1de86b", "AI-ModelScope/LTX-Video",
     "Lightricks/LTX-Video/resolve/546bfd3f6075620075038ce2c899771e1581fbf8/"),
    ("text_encoders", "t5xxl_fp8_e4m3fn.safetensors",
     "7d330da4816157540d6bb7838bf63a0f02f573fc48ca4d8de34bb0cbfd514f09", "AI-ModelScope/flux_text_encoders",
     "comfyanonymous/flux_text_encoders/resolve/2f74b39/"),
]
range_header = re.compile(rb"^content-range:\s*bytes (\d+)-(\d+)/(\d+)\s*$", re.I | re.M)
chunk_size = 16 * 1024 * 1024
def urls(model):
    folder, name, digest, project, alternate = model
    return [base+project+"/repo?Revision=master&FilePath="+name, mirror+alternate+name]

def request(url, first, last, out):
    result = subprocess.run(["curl.exe","--silent","--show-error","--fail","--location","--range",f"{first}-{last}",
        "--max-filesize",str(last-first+1),"--connect-timeout","12","--max-time","100","--speed-time","30","--speed-limit","65536",
        "--dump-header","-","--output",str(out),"--",url], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    matches=range_header.findall(result.stdout)
    if result.returncode != 0 or not matches:
        raise OSError(f"range {first}-{last} curl exit {result.returncode}")
    reported_first, reported_last, size = map(int, matches[-1])
    if reported_first != first or reported_last != last or not pathlib.Path(out).exists() or pathlib.Path(out).stat().st_size!=last-first+1:
        raise OSError("range length mismatch")
    return size

def save_part(task):
    model, i, first, last, size, scratch = task
    part=scratch/f"{i:04d}.chunk"
    if part.exists() and part.stat().st_size==last-first+1:
        return model[1], last-first+1
    pending=part.with_suffix(".receiving")
    for attempt in range(6):
        for url in urls(model):
            try:
                if request(url, first, last, pending)!=size:
                    raise OSError("total length changed")
                os.replace(pending,part)
                return model[1], last-first+1
            except OSError as exc:
                err=exc
        time.sleep(attempt+1)
    raise OSError(f"{model[1]} part {i}: {err}")

def sha(path):
    digest=hashlib.sha256()
    with path.open("rb") as source:
        for piece in iter(lambda:source.read(8*1024*1024),b""):
            digest.update(piece)
    return digest.hexdigest()

def install(data):
    model, total, scratch, target = data
    count=(total+chunk_size-1)//chunk_size
    building=target.with_suffix(".verifying")
    digest=hashlib.sha256()
    with building.open("wb") as output:
        for i in range(count):
            with (scratch/f"{i:04d}.chunk").open("rb") as source:
                for piece in iter(lambda:source.read(4*1024*1024),b""):
                    output.write(piece); digest.update(piece)
    if digest.hexdigest()!=model[2] or building.stat().st_size!=total:
        raise ValueError(f"{model[1]} checksum failed. Held without installing.")
    if target.exists():
        if sha(target)!=model[2]:
            raise ValueError(f"{target} already exists with different contents")
        building.unlink()
    else:
        building.rename(target)
    print("VERIFIED", target, total, flush=True)
    for i in range(count):
        (scratch/f"{i:04d}.chunk").unlink(missing_ok=True)

pending_models = {}
batch=[]
for model in models:
    folder,name,digest,project,alternate=model
    target=(root/"models"/folder/name).resolve()
    assert target.is_relative_to(root/"models") and target.parent.is_dir()
    if target.exists():
        if sha(target)!=digest:
            raise ValueError(f"{target} has different contents")
        print("VERIFIED", target, target.stat().st_size, flush=True)
        continue
    scratch=cache/name
    scratch.mkdir(exist_ok=True)
    for url in urls(model):
        try:
            total=request(url,0,0,scratch/"header-length.receiving")
            break
        except OSError:
            pass
    else:
        raise OSError(f"{name} size not available")
    (scratch/"header-length.receiving").unlink(missing_ok=True)
    chunks=[(model,i,first,min(first+chunk_size,total)-1,total,scratch) for i,first in enumerate(range(0,total,chunk_size))]
    pending_models[name]=(model,total,scratch,target)
    batch.append(chunks)
    print("DOWNLOAD",name,total,"bytes",len(chunks),"chunks",flush=True)

tasks=[task for row in zip_longest(*batch) for task in row if task is not None]
written={name:0 for name in pending_models}
emit={}
with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
    actions=[pool.submit(save_part,task) for task in tasks]
    for action in concurrent.futures.as_completed(actions):
        name,size=action.result()
        written[name]+=size
        data=pending_models[name]
        now=time.monotonic()
        if now-emit.get(name,0)>=20 or written[name]==data[1]:
            print(f"PROGRESS {name} {100*written[name]/data[1]:.1f}% ({written[name]}/{data[1]})",flush=True)
            emit[name]=now
        if written[name]==data[1]:
            install(data)
