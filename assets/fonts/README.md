# Bundled fonts

Embedded (subset) into signed document PDFs by `src/documents/pdf-stamper.ts`.
All three are licensed under the SIL Open Font License 1.1; each licence file sits next to its font.

| File | Used for | Source | Licence |
|---|---|---|---|
| `NotoSansSC-Regular.otf` | Field values and the audit page (Latin + Simplified Chinese) | [notofonts/noto-cjk](https://github.com/notofonts/noto-cjk) `Sans/SubsetOTF/SC/NotoSansSC-Regular.otf` at commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c` (static Noto Sans CJK SC subset) | `NotoSansSC-OFL.txt` (`Sans/LICENSE`) |
| `DancingScript-Variable.ttf` | Typed signatures and initials in Latin script | [google/fonts](https://github.com/google/fonts) `ofl/dancingscript/DancingScript[wght].ttf` at commit `7380f7cebbf2250460c23fd301b51bcbab162edf` (renamed; default instance, weight 400) | `DancingScript-OFL.txt` |
| `MaShanZheng-Regular.ttf` | Typed signatures and initials containing CJK | [google/fonts](https://github.com/google/fonts) `ofl/mashanzheng/MaShanZheng-Regular.ttf` at commit `406197b91ff39a93061c2c2eeaee67ddf2ae1f0d` | `MaShanZheng-OFL.txt` |

SHA-256:

```
faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9  NotoSansSC-Regular.otf
21808625578fe8d8cd10cb684be546dca077b27cd03a53a2f1ec11dc743c924c  DancingScript-Variable.ttf
6d2546bb189c732a8ca29af9e22457b152387d158aa459e4ac2ce1e51788b7fb  MaShanZheng-Regular.ttf
```
