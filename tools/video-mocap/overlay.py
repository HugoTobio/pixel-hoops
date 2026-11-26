import sys, json, cv2, numpy as np
src, pj, out = sys.argv[1:4]
d=json.load(open(pj)); F=d['frames']
E=[(11,12),(11,13),(13,15),(12,14),(14,16),(11,23),(12,24),(23,24),(23,25),(25,27),(27,31),(24,26),(26,28),(28,32),(27,29),(28,30),(0,11),(0,12)]
pick=list(range(0,len(F),24))[:12]
cap=cv2.VideoCapture(src); tiles=[]; i=0
while True:
    ok,img=cap.read()
    if not ok: break
    if i in pick and F[i]['w']:
        h,w=img.shape[:2]; n=F[i]['n']
        P=[(int(x*w),int(y*h)) for x,y in n]
        for a,b in E:
            col=(255,200,0) if a%2 else (0,140,255)  # izquierda impares en MP
            cv2.line(img,P[a],P[b],col,8)
        # mundo 3D vista lateral (x,y) y cenital (x,z) en recuadro
        W=np.array(F[i]['w'])[:,:3]
        def inset(ox,ax2,title):
            cv2.rectangle(img,(ox,20),(ox+420,460),(30,30,30),-1)
            cv2.putText(img,title,(ox+10,55),cv2.FONT_HERSHEY_SIMPLEX,1.1,(255,255,255),2)
            for a,b in E:
                pa=(int(ox+210+W[a,0]*200),int(240+W[a,ax2]*200*(1 if ax2==1 else 1)))
                pb=(int(ox+210+W[b,0]*200),int(240+W[b,ax2]*200))
                cv2.line(img,pa,pb,(255,200,0) if a%2 else (0,140,255),5)
        inset(w-880,1,'frente XY'); inset(w-440,2,'cenital XZ')
        cv2.putText(img,f'f{i}',(30,h-40),cv2.FONT_HERSHEY_SIMPLEX,3,(0,255,0),6)
        tiles.append(cv2.resize(img,(640,int(640*h/w))))
    i+=1
while len(tiles)%4: tiles.append(np.zeros_like(tiles[0]))
rows=[np.hstack(tiles[k:k+4]) for k in range(0,len(tiles),4)]
cv2.imwrite(out,np.vstack(rows))
