#!/usr/bin/env python3
"""Génère www/data/rugby_tv.json à partir d'un EPG XMLTV public (toutes chaînes).

Filtre les programmes dont le titre/catégorie mentionne le rugby, normalise les
noms de chaînes, déduplique (même programme diffusé sur plusieurs déclinaisons
Canal+/UHD…), exclut l'outre-mer et ne garde que l'à-venir (~12 jours).

Aucune dépendance externe (urllib + gzip + ElementTree en streaming, pour tenir
dans la RAM limitée du serveur). Source = epgshare01 (XMLTV FR).
"""
import gzip, io, json, os, re, sys, urllib.request, datetime
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

EPG_URL = "https://epgshare01.online/epgshare01/epg_ripper_FR1.xml.gz"
PARIS = ZoneInfo("Europe/Paris")
HORIZON_DAYS = 12
OUT = os.path.join(os.path.dirname(__file__), "..", "www", "data", "rugby_tv.json")

# Préfixes de "statut" EPG = doublons des vraies diffusions -> on les jette.
SKIP_PREFIXES = ("a venir", "à venir", "termin", "en cours", "prochainement", "bientôt")


QUALITE = re.compile(r"\s+(?:UHD|HDR|FHD|HD|4K)\b.*$", re.I)


def norm_channel(name):
    """Nom de chaîne PRÉCIS (« beIN Sports 3 », « Canal+ Sport 360 »,
    « France 3 - Limousin »), ou None pour exclure (outre-mer /
    international). On ne fusionne plus les déclinaisons entre elles : le
    lecteur IPTV doit pouvoir ouvrir directement la bonne chaîne. Seules les
    variantes de qualité (« CANAL+ UHD ») rejoignent la chaîne d'origine."""
    n = re.sub(r"\s+", " ", (name or "").replace("&apos;", "'")).strip()
    u = n.upper().replace(" ", "")
    if "POLYN" in u or "TV5" in u or "1ÈRE" in u or "1ERE" in u or "DROM" in u:
        return None
    n = QUALITE.sub("", n).strip()
    # Graphies collées ou en capitales de la source : « CANAL+SPORT360 »,
    # « CANAL+LIVE 5 », « beIN SPORTS MAX 4 ».
    m = re.match(r"(?i)^canal\+\s*(.*)$", n)
    if m:
        rest = m.group(1).strip()
        rest = re.sub(r"(?i)^sport\s*360$", "Sport 360", rest)
        rest = re.sub(r"(?i)^(sport|live|foot|kids|docs|series|séries)\s*(\d*)$",
                      lambda x: x.group(1).capitalize() + (" " + x.group(2) if x.group(2) else ""), rest)
        return ("Canal+ " + rest).strip()
    m = re.match(r"(?i)^bein\s*sports?\s*(.*)$", n)
    if m:
        return ("beIN Sports " + m.group(1).upper()).strip()
    if "EQUIPE" in u or "ÉQUIPE" in u:
        return "La Chaîne L'Équipe"
    return n


def parse_start(s):
    base, off = s.split(" ")
    dt = datetime.datetime.strptime(base, "%Y%m%d%H%M%S")
    sign = 1 if off[0] == "+" else -1
    tz = datetime.timezone(sign * datetime.timedelta(hours=int(off[1:3]), minutes=int(off[3:5])))
    return dt.replace(tzinfo=tz).astimezone(PARIS)


def main():
    if os.environ.get("EPG_FILE"):  # essai local, sans téléchargement
        raw = open(os.environ["EPG_FILE"], "rb").read()
    else:
        print("Téléchargement EPG :", EPG_URL)
        req = urllib.request.Request(EPG_URL, headers={"User-Agent": "flux-rss-epg/1.0"})
        raw = urllib.request.urlopen(req, timeout=90).read()
    xml = gzip.decompress(raw)
    print("XML :", len(xml) // 1024 // 1024, "Mo")

    now = datetime.datetime.now(PARIS)
    floor = now - datetime.timedelta(hours=2)
    horizon = now + datetime.timedelta(days=HORIZON_DAYS)

    chan = {}
    agg = {}
    for ev, el in ET.iterparse(io.BytesIO(xml), events=("end",)):
        if el.tag == "channel":
            dn = el.findtext("display-name")
            chan[el.get("id")] = dn or el.get("id")
            el.clear()
        elif el.tag == "programme":
            title = (el.findtext("title") or "").strip()
            cats = [e.text or "" for e in el.findall("category")]
            if "rugby" in (title + " " + " ".join(cats)).lower():
                low = title.lower()
                if not any(low.startswith(p) for p in SKIP_PREFIXES):
                    ch = norm_channel(chan.get(el.get("channel"), ""))
                    if ch:
                        try:
                            st = parse_start(el.get("start"))
                        except Exception:
                            st = None
                        if st and floor <= st <= horizon:
                            key = (title, st.strftime("%Y-%m-%d %H:%M"))
                            e = agg.setdefault(key, {
                                "title": title,
                                "date": st.strftime("%Y-%m-%d"),
                                "time": st.strftime("%H:%M"),
                                "desc": (el.findtext("desc") or (cats[0] if cats else "")).strip()[:140],
                                "chaine": set(),
                                "tvg": {},
                            })
                            e["chaine"].add(ch)
                            # Identifiants XMLTV de la chaîne (« beIN.SPORTS.3.fr »),
                            # repris tels quels comme tvg-id par beaucoup de
                            # playlists : la clé la plus sûre pour le lecteur IPTV.
                            # La source en a parfois deux pour une même chaîne
                            # (« CANAL+SPORT.fr », « Canal+.Sport.fr ») : on garde tout.
                            cid = el.get("channel") or ""
                            ids = e["tvg"].setdefault(ch, [])
                            if cid and cid not in ids:
                                ids.append(cid)
            el.clear()

    out = []
    for e in sorted(agg.values(), key=lambda x: (x["date"], x["time"])):
        e["chaine"] = sorted(e["chaine"])
        e["tvg"] = {c: sorted(i) for c, i in sorted(e["tvg"].items())}
        e["cats"] = ["rugby"]
        e["approx"] = False
        out.append(e)

    if not out:
        print("ERREUR : 0 programme rugby — on n'écrit pas (EPG vide ?).", file=sys.stderr)
        sys.exit(1)

    payload = {
        "generated": now.isoformat(timespec="seconds"),
        "source": EPG_URL,
        "count": len(out),
        "programmes": out,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"OK : {len(out)} programmes -> {os.path.relpath(OUT)}")
    print("chaînes :", sorted({c for e in out for c in e["chaine"]}))


if __name__ == "__main__":
    main()
