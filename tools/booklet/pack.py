import zipfile,sys
src,docxml,out=sys.argv[1],sys.argv[2],sys.argv[3]
z=zipfile.ZipFile(src)
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as o:
    for info in z.infolist():
        if info.filename.endswith('/'): continue
        data=open(docxml,'rb').read() if info.filename=='word/document.xml' else open('work/'+info.filename,'rb').read()
        o.writestr(info,data)
