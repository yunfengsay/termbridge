"""Create a source-only archive for a Windows build machine; never includes pairing/VM state."""
import pathlib,zipfile,argparse
root=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('output',type=pathlib.Path);args=p.parse_args()
with zipfile.ZipFile(args.output,'w',zipfile.ZIP_DEFLATED) as z:
 for name in ['Directory.Build.props','README.md','LICENSE','requirements-windows.in','requirements-windows.txt','THIRD_PARTY_NOTICES.md','TermBridge.App','TermBridge.Core','TermBridge.Cli','TermBridge.Tests','assets','scripts','installer']:
  path=root/name
  for file in ([path] if path.is_file() else path.rglob('*')):
   if file.is_file() and not {'bin','obj','__pycache__'}&set(file.parts):z.write(file,file.relative_to(root))

# The desktop sources consume the shared Chrome extension without a second implementation.
with zipfile.ZipFile(args.output,'a',zipfile.ZIP_DEFLATED) as z:
 for name in ['bridge.mjs','extension']:
  path=root.parent/'browser-extension'/name
  for file in ([path] if path.is_file() else path.rglob('*')):
   if file.is_file():z.write(file,pathlib.Path('browser-extension')/file.relative_to(root.parent/'browser-extension'))
