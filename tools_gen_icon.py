import struct, zlib, math, os
def lerp(a,b,t): return int(a+(b-a)*t)
def render(S):
    BG1=(255,140,60); BG2=(226,84,0); FG=(255,255,255)  # dégradé orange RSS, glyphe blanc
    ox,oy=0.32*S,0.70*S
    rings=[(0.19*S,0.075*S),(0.35*S,0.075*S)]; dotr=0.058*S
    px=bytearray()
    for y in range(S):
        px.append(0)
        for x in range(S):
            t=y/S; r,g,b=lerp(BG1[0],BG2[0],t),lerp(BG1[1],BG2[1],t),lerp(BG1[2],BG2[2],t)
            fg=False
            if math.hypot(x-ox,y-oy)<=dotr: fg=True
            dx=x-ox; dy=oy-y
            if dx>=-1 and dy>=-1:
                dist=math.hypot(dx,dy)
                for R,th in rings:
                    if R-th<=dist<=R: fg=True
            if fg: r,g,b=FG
            px.extend((r,g,b))
    raw=bytes(px)
    def ch(tp,d): c=struct.pack('>I',len(d))+tp+d; return c+struct.pack('>I',zlib.crc32(tp+d)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+ch(b'IHDR',struct.pack('>IIBBBBB',S,S,8,2,0,0,0))+ch(b'IDAT',zlib.compress(raw,9))+ch(b'IEND',b'')
def w(path,S): os.makedirs(os.path.dirname(path),exist_ok=True); open(path,'wb').write(render(S))
w('www/img/icon-512.png',512); w('www/img/icon-192.png',192)
A='android/app/src/main/res'
leg={'mdpi':48,'hdpi':72,'xhdpi':96,'xxhdpi':144,'xxxhdpi':192}
fg={'mdpi':108,'hdpi':162,'xhdpi':216,'xxhdpi':324,'xxxhdpi':432}
for d,s in leg.items(): w(f'{A}/mipmap-{d}/ic_launcher.png',s); w(f'{A}/mipmap-{d}/ic_launcher_round.png',s)
for d,s in fg.items(): w(f'{A}/mipmap-{d}/ic_launcher_foreground.png',s)
print("flux-rss : icônes générées")
