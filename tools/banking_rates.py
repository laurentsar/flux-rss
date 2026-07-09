#!/usr/bin/env python3
"""Génère www/data/banking.json avec les meilleurs taux bancaires du moment.

Sources :
  - Livrets réglementés : toutsurmesfinances.com (tableau stable)
  - Primes de bienvenue : comparabanques.fr
  - Livrets boostés    : francetransactions.com

Aucune dépendance externe (urllib + re + html.parser).
Exécuté via cron GitHub Actions (hebdomadaire, le lundi matin).
"""
import json, os, re, sys, urllib.request, datetime, html as _html
from zoneinfo import ZoneInfo

PARIS = ZoneInfo("Europe/Paris")
OUT = os.path.join(os.path.dirname(__file__), "..", "www", "data", "banking.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0"
    ),
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr,fr-FR;q=0.8,en-US;q=0.5,en;q=0.3",
}

# ---------------------------------------------------------------------------
# Taux de repli (mis à jour manuellement si le scraping échoue durablement)
# ---------------------------------------------------------------------------
FALLBACK_LIVRETS = [
    {"nom": "Livret A",  "taux": "1,50 %", "plafond": "22 950 €", "net": True,  "note": "Garanti, disponible, défiscalisé"},
    {"nom": "LDDS",      "taux": "1,50 %", "plafond": "12 000 €", "net": True,  "note": "Résidents fiscaux FR uniquement"},
    {"nom": "LEP",       "taux": "2,50 %", "plafond": "10 000 €", "net": True,  "note": "Sous conditions de revenus"},
    {"nom": "PEL",       "taux": "2,25 %", "plafond": "61 200 €", "net": False, "note": "Taux brut — bloqué 4 ans minimum (ouvertures 2024+)"},
    {"nom": "CEL",       "taux": "1,00 %", "plafond": "15 300 €", "net": False, "note": "Taux brut — lié à un PEL"},
]

FALLBACK_PRIMES = [
    {"banque": "Hello bank!",  "offre": "Compte + Hello Prime offerte", "prime": "jusqu'à 300 €", "fin": "2026-08-10", "cond": "Voir conditions sur le site", "lien": "https://www.hellobank.fr"},
    {"banque": "BNP Paribas",  "offre": "Compte courant",               "prime": "jusqu'à 270 €", "fin": "2026-12-31", "cond": "Voir conditions sur le site", "lien": "https://mabanque.bnpparibas.com"},
    {"banque": "Fortuneo",     "offre": "Compte + CB (25 ans)",          "prime": "jusqu'à 250 €", "fin": "2026-12-31", "cond": "Mobilité bancaire neoChange", "lien": "https://www.fortuneo.fr"},
    {"banque": "Monabanq",     "offre": "Compte courant",                "prime": "jusqu'à 200 €", "fin": "2026-12-31", "cond": "80 € souscription + CB Visa Premier", "lien": "https://www.monabanq.com"},
]

FALLBACK_PRIMES_EPARGNE = [
    {"banque": "Cashbee",          "offre": "Livret Cashbee Plus",   "prime": "50 €",          "fin": "2026-12-31", "cond": "Prime parrainage + taux boosté 3 mois",   "lien": "https://www.cashbee.fr"},
    {"banque": "Fortuneo",         "offre": "Livret Fortuneo+",      "prime": "jusqu'à 80 €",  "fin": "2026-12-31", "cond": "Offre couplée à l'ouverture d'un compte", "lien": "https://www.fortuneo.fr"},
    {"banque": "BoursoBank",       "offre": "Livret BoursoLivret",   "prime": "voir site",     "fin": "2026-12-31", "cond": "Conditions selon offre en cours",          "lien": "https://www.boursobank.com"},
    {"banque": "Placement Direct", "offre": "Livret bienvenue",      "prime": "taux boosté",   "fin": "2026-12-31", "cond": "Taux préférentiel garanti 3 mois",         "lien": "https://www.placementdirect.fr"},
]

FALLBACK_BOOSTES = [
    {"banque": "Distingo Bank",    "taux": "voir site", "duree": "boosté", "plafond": "150 000 €", "lien": "https://www.distingo.com"},
    {"banque": "Zesto (Renault)",  "taux": "voir site", "duree": "boosté", "plafond": "100 000 €", "lien": "https://www.renaultbank.fr"},
    {"banque": "Cashbee",          "taux": "voir site", "duree": "boosté", "plafond": "75 000 €",  "lien": "https://www.cashbee.fr"},
    {"banque": "Placement Direct", "taux": "voir site", "duree": "boosté", "plafond": "100 000 €", "lien": "https://www.placementdirect.fr"},
    {"banque": "Meilleurtaux",     "taux": "voir site", "duree": "boosté", "plafond": "100 000 €", "lien": "https://placement.meilleurtaux.com"},
]

FALLBACK_TOP_ACTIONS = [
    {"nom": "Orange",           "ticker": "ORA",  "rendement": "~8,5 %", "dividende": "0,70 €", "secteur": "Télécom",    "lien": "https://www.boursorama.com/cours/1rPORA/"},
    {"nom": "BNP Paribas",      "ticker": "BNP",  "rendement": "~8,0 %", "dividende": "4,60 €", "secteur": "Banque",     "lien": "https://www.boursorama.com/cours/1rPBNP/"},
    {"nom": "Société Générale", "ticker": "GLE",  "rendement": "~7,5 %", "dividende": "1,75 €", "secteur": "Banque",     "lien": "https://www.boursorama.com/cours/1rPGLE/"},
    {"nom": "Crédit Agricole",  "ticker": "ACA",  "rendement": "~7,0 %", "dividende": "1,05 €", "secteur": "Banque",     "lien": "https://www.boursorama.com/cours/1rPACA/"},
    {"nom": "Engie",            "ticker": "ENGI", "rendement": "~6,8 %", "dividende": "0,68 €", "secteur": "Énergie",    "lien": "https://www.boursorama.com/cours/1rPENGI/"},
    {"nom": "Klépierre",        "ticker": "LI",   "rendement": "~6,5 %", "dividende": "1,75 €", "secteur": "Immobilier", "lien": "https://www.boursorama.com/cours/1rPLI/"},
    {"nom": "TotalEnergies",    "ticker": "TTE",  "rendement": "~5,8 %", "dividende": "3,22 €", "secteur": "Énergie",    "lien": "https://www.boursorama.com/cours/1rPFP/"},
    {"nom": "AXA",              "ticker": "CS",   "rendement": "~5,5 %", "dividende": "1,98 €", "secteur": "Assurance",  "lien": "https://www.boursorama.com/cours/1rPCS/"},
    {"nom": "Sanofi",           "ticker": "SAN",  "rendement": "~3,8 %", "dividende": "3,76 €", "secteur": "Santé",      "lien": "https://www.boursorama.com/cours/1rPSAN/"},
    {"nom": "Publicis",         "ticker": "PUB",  "rendement": "~3,5 %", "dividende": "3,40 €", "secteur": "Médias",     "lien": "https://www.boursorama.com/cours/1rPPUB/"},
]


# ---------------------------------------------------------------------------
# Helpers réseau / parsing
# ---------------------------------------------------------------------------

def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        charset = "utf-8"
        ct = r.headers.get_content_charset()
        if ct:
            charset = ct
        return raw.decode(charset, errors="replace")


def strip_tags(s):
    """Supprime les balises HTML basiques."""
    return re.sub(r"<[^>]+>", " ", s)


def clean(s):
    """Décode les entités HTML et normalise les espaces."""
    return re.sub(r"\s+", " ", _html.unescape(strip_tags(s))).strip()


def find_rate(text, keywords, window=300):
    """Cherche le premier taux (X,XX %) dans les 'window' chars après un keyword."""
    for kw in keywords:
        idx = text.lower().find(kw.lower())
        if idx < 0:
            continue
        snippet = text[idx: idx + window]
        m = re.search(r"(\d)[,.](\d{1,2})\s*%", snippet)
        if m:
            dec = m.group(2).ljust(2, "0")
            return f"{m.group(1)},{dec} %"
    return None


# ---------------------------------------------------------------------------
# Scraper : livrets réglementés — toutsurmesfinances.com
# ---------------------------------------------------------------------------

def scrape_livrets_reglementes():
    url = (
        "https://www.toutsurmesfinances.com/placements/"
        "livret-a-ldd-lep-pel-les-taux-des-livrets-d-epargne.html"
    )
    print(f"  → {url}")
    html = fetch(url)

    livret_a = find_rate(html, ["livret a", "livret-a", "taux du livret a"])
    ldds     = find_rate(html, ["ldds", "ldd ", "livret développement"])
    lep      = find_rate(html, ["lep ", "livret d'épargne populaire", "livret epargne populaire"])
    pel      = find_rate(html, ["pel ", "plan épargne logement", "plan epargne logement"])
    cel      = find_rate(html, ["cel ", "compte épargne logement"])

    print(f"    Livret A={livret_a}  LDDS={ldds}  LEP={lep}  PEL={pel}  CEL={cel}")

    # Si au moins Livret A et LEP sont trouvés → on considère le scraping OK
    if not livret_a or not lep:
        raise ValueError("Taux Livret A ou LEP non trouvés")

    results = list(FALLBACK_LIVRETS)  # copie
    mapping = {
        "Livret A": livret_a,
        "LDDS":     ldds or livret_a,   # LDDS = Livret A toujours
        "LEP":      lep,
        "PEL":      pel,
        "CEL":      cel,
    }
    for item in results:
        if mapping.get(item["nom"]):
            item = dict(item)
            item["taux"] = mapping[item["nom"]]
    # reconstruit la liste en appliquant les taux trouvés
    updated = []
    for item in results:
        d = dict(item)
        if mapping.get(d["nom"]):
            d["taux"] = mapping[d["nom"]]
        updated.append(d)
    return updated


# ---------------------------------------------------------------------------
# Scraper : primes de bienvenue — comparabanques.fr
# ---------------------------------------------------------------------------

def scrape_primes():
    url = "https://www.comparabanques.fr/offres-promotionnelles-du-moment"
    print(f"  → {url}")
    html = fetch(url)

    primes = []
    # Cherche des blocs contenant "€ offerts" ou "prime" avec un nom de banque
    # Pattern : montant €, nom banque, conditions
    blocks = re.findall(
        r'(?:class="[^"]*(?:offre|prime|bonus|bank)[^"]*"[^>]*>)(.*?)(?:</(?:div|article|li)>)',
        html, re.DOTALL | re.IGNORECASE
    )

    known_banks = [
        ("hello bank", "Hello bank!", "https://www.hellobank.fr"),
        ("boursobank", "BoursoBank",  "https://www.boursobank.com"),
        ("fortuneo",   "Fortuneo",    "https://www.fortuneo.fr"),
        ("monabanq",   "Monabanq",    "https://www.monabanq.com"),
        ("bnp paribas","BNP Paribas", "https://mabanque.bnpparibas.com"),
        ("orange bank","Orange Bank", "https://www.orangebank.fr"),
        ("n26",        "N26",         "https://n26.com/fr-fr"),
        ("revolut",    "Revolut",     "https://www.revolut.com/fr"),
        ("lydia",      "Lydia",       "https://www.lydia-app.com"),
        ("sumeria",    "Sumeria",     "https://www.sumeria.com"),
    ]

    found = set()
    for block in blocks:
        text = clean(block)
        if not text:
            continue
        m_amount = re.search(r"(jusqu['’]à\s+)?(\d+)\s*€", text)
        if not m_amount:
            continue
        amount = m_amount.group(0).strip()
        for slug, display, link in known_banks:
            if slug in text.lower() and slug not in found:
                found.add(slug)
                primes.append({
                    "banque": display,
                    "offre":  "Compte courant",
                    "prime":  amount,
                    "fin":    "",
                    "cond":   "Voir conditions sur le site",
                    "lien":   link,
                })
                break

    if len(primes) < 2:
        raise ValueError(f"Seulement {len(primes)} prime(s) trouvée(s)")
    print(f"    {len(primes)} primes trouvées")
    return primes[:6]


# ---------------------------------------------------------------------------
# Scraper : livrets boostés — francetransactions.com
# ---------------------------------------------------------------------------

def scrape_livrets_boostes():
    url = "https://www.francetransactions.com/placements-epargne-finance/compte-livret-promos.html"
    print(f"  → {url}")
    html = fetch(url)

    known = [
        ("distingo",          "Distingo Bank",    "https://www.distingo.com"),
        ("zesto",             "Zesto (Renault)",  "https://www.renaultbank.fr"),
        ("cashbee",           "Cashbee",          "https://www.cashbee.fr"),
        ("placement direct",  "Placement Direct", "https://www.placementdirect.fr"),
        ("placement-direct",  "Placement Direct", "https://www.placementdirect.fr"),
        ("meilleurtaux",      "Meilleurtaux",     "https://placement.meilleurtaux.com"),
        ("ramify",            "Ramify",           "https://www.ramify.fr"),
        ("goodvest",          "Goodvest",         "https://goodvest.fr"),
        ("lbp",               "La Banque Postale","https://www.labanquepostale.fr"),
    ]

    results = []
    found = set()

    for slug, display, link in known:
        idx = html.lower().find(slug)
        if idx < 0:
            continue
        if slug in found:
            continue
        found.add(slug)
        snippet = html[max(0, idx-50): idx+300]
        rate = find_rate(snippet, [slug, "%"])
        duree_m = re.search(r"(\d+)\s*mois", snippet, re.IGNORECASE)
        duree = f"{duree_m.group(1)} mois" if duree_m else "boosté"
        plafond_m = re.search(r"([\d\s]+)\s*[€$]?\s*(?:de\s+)?plafond|plafond[^<]{0,30}([\d\s]+)\s*€", snippet, re.IGNORECASE)
        plafond = "voir site"
        if plafond_m:
            raw_p = (plafond_m.group(1) or plafond_m.group(2) or "").strip()
            plafond = raw_p + " €" if raw_p else "voir site"
        results.append({
            "banque":  display,
            "taux":    rate or "voir site",
            "duree":   duree,
            "plafond": plafond,
            "lien":    link,
        })

    if len(results) < 2:
        raise ValueError(f"Seulement {len(results)} livret(s) boosté(s) trouvé(s)")
    print(f"    {len(results)} livrets boostés trouvés")
    return results[:6]


# ---------------------------------------------------------------------------
# Résumé / note contextuelle (hausse ou baisse prévue)
# ---------------------------------------------------------------------------

def build_note(livrets):
    """Génère une note si une révision de taux est à venir (1er fév ou 1er août)."""
    now = datetime.datetime.now(PARIS)
    month, day = now.month, now.day
    # Pré-annonce dans les 30 jours avant le 1er fév ou le 1er août
    upcoming = None
    for (target_m, target_d) in [(2, 1), (8, 1)]:
        target = datetime.datetime(now.year, target_m, target_d, tzinfo=PARIS)
        if target < now:
            target = datetime.datetime(now.year + 1, target_m, target_d, tzinfo=PARIS)
        delta = (target - now).days
        if delta <= 30:
            upcoming = target
            break
    if upcoming:
        date_str = upcoming.strftime("1er %B %Y").replace("February", "février").replace("August", "août")
        return f"⚠️ Révision des taux prévue le {date_str} — vérifiez les nouveaux taux"
    return ""


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    now_str = datetime.datetime.now(PARIS).isoformat(timespec="seconds")
    data = {"generated": now_str, "livrets": None, "primes": None, "primes_epargne": None, "livrets_boostes": None, "top_actions": None, "note": ""}

    print("=== Livrets réglementés ===")
    try:
        data["livrets"] = scrape_livrets_reglementes()
    except Exception as e:
        print(f"  ÉCHEC scraping livrets ({e}) → repli sur données hardcodées")
        data["livrets"] = FALLBACK_LIVRETS

    print("=== Primes de bienvenue ===")
    try:
        data["primes"] = scrape_primes()
    except Exception as e:
        print(f"  ÉCHEC scraping primes ({e}) → repli sur données hardcodées")
        data["primes"] = FALLBACK_PRIMES

    print("=== Primes d'épargne ===")
    # Pas de scraping dédié pour l'instant — utilise le fallback hardcodé
    data["primes_epargne"] = FALLBACK_PRIMES_EPARGNE
    print(f"    {len(FALLBACK_PRIMES_EPARGNE)} primes épargne (hardcodées)")

    print("=== Livrets boostés ===")
    try:
        data["livrets_boostes"] = scrape_livrets_boostes()
    except Exception as e:
        print(f"  ÉCHEC scraping boostés ({e}) → repli sur données hardcodées")
        data["livrets_boostes"] = FALLBACK_BOOSTES

    print("=== Top actions à dividende ===")
    # Pas de scraping temps-réel — rendements indicatifs mis à jour manuellement
    data["top_actions"] = FALLBACK_TOP_ACTIONS
    print(f"    {len(FALLBACK_TOP_ACTIONS)} actions (hardcodées)")

    data["note"] = build_note(data["livrets"])

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"\n✓ Écrit dans {OUT}  ({len(json.dumps(data))} octets)")


if __name__ == "__main__":
    main()
