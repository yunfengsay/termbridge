"""Assemble pinned offline dependencies for the native x64 app.
Requires an explicitly reviewed CLI npm tarball containing `tb desktop`.
"""
import argparse,hashlib,json,pathlib,shutil,subprocess,sys,tarfile,urllib.request,zipfile
root=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--cli',type=pathlib.Path,required=True);args=parser.parse_args()
cache=root/'.cache';runtime=cache/'runtime';runtime.mkdir(parents=True,exist_ok=True)
dependencies=[
 ('node-v24.20.0-win-x64.zip','https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip','6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba'),
 ('python-3.13.7-embed-amd64.zip','https://www.python.org/ftp/python/3.13.7/python-3.13.7-embed-amd64.zip','f6cca216a359be84797cabb54149ce5e062afb16cc7567eb7fc51cacb2d86b65')]
manifest=[]
for name,url,digest in dependencies:
 path=cache/name
 if not path.exists():
  temp=path.with_suffix('.partial')
  with urllib.request.urlopen(url,timeout=120) as src,temp.open('wb') as dst:shutil.copyfileobj(src,dst)
  temp.replace(path)
 if hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise RuntimeError('Checksum mismatch: '+name)
 manifest.append(dict(name=name,url=url,sha256=digest))
 with zipfile.ZipFile(path) as archive:
  for entry in archive.infolist():
   part=pathlib.PurePosixPath(entry.filename)
   if part.is_absolute() or '..' in part.parts:raise RuntimeError('Invalid dependency archive')
   relative=pathlib.Path(*part.parts[1:]) if name.startswith('node-') else pathlib.Path(*part.parts)
   if entry.is_dir() or not relative.parts:continue
   target=runtime/('node' if name.startswith('node-') else 'python')/relative
   target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.read(entry))
python=runtime/'python';(python/'python313._pth').write_text('python313.zip\n.\nLib/site-packages\nimport site\n')
site=python/'Lib/site-packages'
subprocess.run(['uv','pip','install','--python-version','3.13','--python-platform','x86_64-pc-windows-msvc','--only-binary',':all:','--require-hashes','--target',str(site),'-r',str(root/'requirements-windows.txt')],check=True)
(site/'sitecustomize.py').write_text("import os, pathlib\np=pathlib.Path(__file__).parent/'pywin32_system32'\n_dll_cookie=os.add_dll_directory(str(p)) if p.exists() and hasattr(os,'add_dll_directory') else None\n")
subprocess.run([sys.executable,str(root/'scripts/patch-computer-input.py'),str(site)],check=True)
(runtime/'compatibility-patches.json').write_text(json.dumps({'windowsMcpVersion':'0.8.5','patch':'Literal Unicode and multiline clipboard typing','sourceSha256':hashlib.sha256((site/'windows_mcp/desktop/service.py').read_bytes()).hexdigest()},indent=2)+'\n')
with tarfile.open(args.cli) as archive:
 for entry in archive.getmembers():
  part=pathlib.PurePosixPath(entry.name)
  if part.is_absolute() or '..' in part.parts or entry.issym() or entry.islnk():raise RuntimeError('Invalid CLI archive')
  if not entry.isfile():continue
  target=runtime/'tb'/pathlib.Path(*part.parts[1:]);target.parent.mkdir(parents=True,exist_ok=True)
  with archive.extractfile(entry) as src,target.open('wb') as dst:shutil.copyfileobj(src,dst)
cli=runtime/'tb/dist/cli.js'
if 'desktop' not in cli.read_text():raise RuntimeError('CLI does not include the native desktop bridge')
package=json.loads((runtime/'tb/package.json').read_text())
(runtime/'native-cli.json').write_text(json.dumps({'baseVersion':package['version'],'desktopApiVersion':1,'localBuild':True,'archiveSha256':hashlib.sha256(args.cli.read_bytes()).hexdigest(),'sha256':hashlib.sha256(cli.read_bytes()).hexdigest()},indent=2)+'\n')
manifest.append(dict(name=args.cli.name,sha256=hashlib.sha256(args.cli.read_bytes()).hexdigest()))
(runtime/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Offline native runtime ready')
