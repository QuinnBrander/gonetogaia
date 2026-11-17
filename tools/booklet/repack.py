"""Copy a .docx, replacing only word/document.xml.
Usage: python -I repack.py <source.docx> <document.xml> <out.docx>"""
import sys, zipfile
src, doc, out = sys.argv[1:4]
z = zipfile.ZipFile(src)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as o:
    for info in z.infolist():
        if info.filename.endswith('/'):
            continue
        o.writestr(info, open(doc, 'rb').read() if info.filename == 'word/document.xml' else z.read(info.filename))
