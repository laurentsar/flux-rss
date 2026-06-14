import struct, zlib, math

def png(path, S):
    # couleurs
    BG=(15,23,42); BG2=(30,41,59); FG=(242,101,34)
    # glyphe RSS : coin bas-gauche du repère arcs, centré
    cx, cy = 0.34*S, 0.66*S          # point d'origine des arcs
    dot_c = (0.34*S, 0.66*S)
    dot_r = 0.055*S
    rings = [(0.20*S,0.085*S),(0.40*S,0.085*S)]  # (rayon, épaisseur)
    px=bytearray()
    for y in range(S):
        px.append(0)  # filtre
        for x in range(S):
            # fond dégradé vertical + coins arrondis
            t=y/S
            r=int(BG[0]+(BG2[0]-BG[0])*t); g=int(BG[1]+(BG2[1]-BG[1])*t); b=int(BG[2]+(BG2[2]-BG[2])*t)
            # coins arrondis (rayon 18%)
            rad=0.18*S
            inx = min(x, S-1-x); iny=min(y,S-1-y)
            if inx<rad and iny<rad:
                dd=math.hypot(rad-inx,rad-iny)
                if dd>rad: r,g,b=BG  # hors carte -> on garde fond (icône pleine de toute façon)
            # glyphe
            dx=x-cx; dy=cy-y
            isfg=False
            if dx>=-dot_r and dy>=-dot_r:
                if math.hypot(x-dot_c[0], y-dot_c[1])<=dot_r: isfg=True
            if dx>=0 and dy>=0:
                dist=math.hypot(dx,dy)
                for R,th in rings:
                    if R-th<=dist<=R: isfg=True
            if isfg: r,g,b=FG
            px+=bytes((r,g,b))
    raw=bytes(px)
    def chunk(typ,data):
        c=struct.pack('>I',len(data))+typ+data
        return c+struct.pack('>I',zlib.crc32(typ+data)&0xffffffff)
    sig=b'\x89PNG\r\n\x1a\n'
    ihdr=struct.pack('>IIBBBBB',S,S,8,2,0,0,0)
    out=sig+chunk(b'IHDR',ihdr)+chunk(b'IDAT',zlib.compress(raw,9))+chunk(b'IEND',b'')
    open(path,'wb').write(out)
    print("écrit",path,S)

png('www/img/icon-512.png',512)
png('www/img/icon-192.png',192)
