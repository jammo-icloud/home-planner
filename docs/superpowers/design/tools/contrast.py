"""Contrast audit for site/tokens.css.

Usage: python3 docs/superpowers/design/tools/contrast.py site/tokens.css

Resolves each scheme (and the Placitas place layer) over the base core, in
light and dark, and checks every pairing that carries text or a control edge
against WCAG 2.1 AA: 4.5:1 for text, 3:1 for control edges and marks. Exits
non-zero on any failure.
"""
import re, sys
css = open(sys.argv[1]).read()
def block(sel_regex):
    m = re.search(sel_regex + r"\s*\{(.*?)\n\s*\}", css, re.S)
    return dict(re.findall(r"(--[\w-]+):\s*(#[0-9A-Fa-f]{6})", m.group(1))) if m else {}
base_light = block(r':where\(:root, \[data-mode="light"\]\)')
base_dark  = block(r':where\(\[data-mode="dark"\]\)')
schemes = {"quartz": ({}, {})}
for s in ("lapis","iolite","graphite"):
    schemes[s] = (block(r':where\(\[data-scheme="%s"\]\)' % s), block(r':where\(\[data-scheme="%s"\]\[data-mode="dark"\]\)' % s))
schemes["placitas (place)"] = (block(r':where\(\[data-place="placitas"\]\)'), block(r':where\(\[data-place="placitas"\]\[data-mode="dark"\]\)'))
def lum(h):
    c=[int(h[i:i+2],16)/255 for i in (1,3,5)]
    c=[x/12.92 if x<=0.03928 else ((x+0.055)/1.055)**2.4 for x in c]
    return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
def cr(a,b):
    la,lb=sorted([lum(a),lum(b)],reverse=True); return (la+0.05)/(lb+0.05)
# (fg, bg, min, why)
pairs = [
 ("--ink","--surface",4.5,"body"),("--ink-soft","--surface",4.5,"secondary"),("--ink-faint","--surface",4.5,"timestamps"),
 ("--ink-faint","--surface-raised",4.5,"timestamps on card"),("--ink-faint","--surface-sunken",4.5,"faint in well"),
 ("--ink-soft","--surface-sunken",4.5,"soft in well"),
 ("--accent-ink","--surface",4.5,"link"),("--accent-ink","--surface-raised",4.5,"link on card"),("--accent-ink","--accent-tint",4.5,"selected text"),
 ("--on-accent","--accent-fill",4.5,"primary button"),("--on-accent","--accent-fill-hover",4.5,"primary hover"),
 ("--ink","--accent-tint",4.5,"own message"),
 ("--line-strong","--surface-raised",3.0,"control edge"),("--line-strong","--surface",3.0,"control edge on page"),
 ("--accent","--surface",3.0,"focus/selected mark"),("--focus","--surface-raised",3.0,"focus ring"),
 ("--good","--surface-raised",4.5,"good"),("--good","--good-tint",4.5,"good chip"),("--good","--surface",4.5,"good on page"),
 ("--caution","--surface-raised",4.5,"caution"),("--caution","--caution-tint",4.5,"caution chip"),("--caution","--surface",4.5,"caution on page"),
 ("--problem","--surface-raised",4.5,"problem"),("--problem","--problem-tint",4.5,"problem chip"),("--problem","--surface",4.5,"problem on page"),
 ("--claude-ink","--claude-paper",4.5,"claude byline"),("--ink","--claude-paper",4.5,"claude text"),("--ink-soft","--claude-paper",4.5,"claude soft"),
 ("--claude-line","--claude-paper",1.0,"(claude rule, info)"),
 ("--provisional","--surface-raised",3.0,"dash edge"),("--provisional","--surface",3.0,"dash on page"),("--provisional","--claude-paper",3.0,"dash on paper"),
 ("--src-mine-ink","--src-mine-fill",4.5,"mine event"),("--src-other-ink","--src-other-fill",4.5,"other member's event"),
 ("--src-household-ink","--src-household-fill",4.5,"household event"),
 ("--src-other-line","--src-other-fill",3.0,"other member's rule"),("--src-household-line","--src-household-fill",3.0,"household rule"),
 ("--src-mine-fill","--surface-raised",3.0,"mine block edge"),("--src-other-line","--surface-raised",3.0,"other edge on grid"),
 ("--src-household-line","--surface-raised",3.0,"household edge on grid"),
 ("--caution","--surface-raised",3.0,"drift outline (offset)"),("--problem","--surface-raised",3.0,"clash outline (offset)"),("--problem","--surface",3.0,"clash outline on page"),
 # The roles (tokens.css 3c) point at other tokens and this reads hex values only, so each pair is written against
 # the token its role points at: --state-doing is --accent, --mark-fill is --accent-line.
 ("--accent","--surface",3.0,"state doing"),("--accent","--surface-raised",3.0,"state doing on card"),
 ("--accent","--surface-sunken",3.0,"state doing in well"),
 ("--ink","--accent-line",4.5,"mark fill"),
 ("--line-strong","--surface",3.0,"small hatch mark"),
]
# Measured and printed, not failed: pairs the audit found short, whose fix is a rule rather than a token.
known = [
 # Faint text inside a search hit's mark. The fix is `mark { color: var(--ink) }` (visual audit, Contrast findings).
 ("--ink-faint","--accent-tint",4.5,"faint on accent tint"),
]
fails=0
for s,(sl,sd) in schemes.items():
    for mode,b,ov in (("light",base_light,sl),("dark",base_dark,sd)):
        t=dict(b); t.update(ov)
        bad=[]
        for fg,bg,mn,why in pairs:
            if fg not in t or bg not in t: bad.append(f"MISSING {fg} {bg}"); continue
            r=cr(t[fg],t[bg])
            if r<mn: bad.append(f"{why:24} {fg} on {bg} = {r:.2f} (< {mn})")
        short=[f"{why:24} {fg} on {bg} = {cr(t[fg],t[bg]):.2f} (< {mn})" for fg,bg,mn,why in known if cr(t[fg],t[bg])<mn]
        print(f"{s:9}{mode:6} {'ok' if not bad else str(len(bad))+' fail'}{'' if not short else ', '+str(len(short))+' known'}")
        for x in bad: print("    ",x)
        for x in short: print("     known:",x)
        fails+=len(bad)
# hue distance between accents and semantics, and partner
import colorsys
def hue(h):
    r,g,b=[int(h[i:i+2],16)/255 for i in (1,3,5)]; return colorsys.rgb_to_hls(r,g,b)[0]*360
print("\nhues (light): accents", {s:round(hue((schemes[s][0] or base_light).get('--accent',base_light['--accent']))) for s in schemes})
for k in ("--good","--caution","--problem","--claude-mark","--src-other-line","--src-household-line"):
    print(" ",k, round(hue(base_light[k])))
print("TOTAL FAILS", fails)
sys.exit(1 if fails else 0)
