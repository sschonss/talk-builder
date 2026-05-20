# talk-builder

Engine pra transformar `slides.json` em `.pptx` (que abre no Keynote).
Reutilizável: cada talk vira uma pasta com 1 JSON.

## Setup (1x)

```bash
pip3 install python-pptx Pillow
# Mermaid: precisa de Node.js. O build chama via npx, sem instalar global.
```

## Uso

```bash
# 1. Cria pasta da talk
mkdir -p ~/Documents/talks/minha-talk
# 2. Cria slides.json (veja SCHEMA.md e examples/minimal.json)
cp ~/Documents/talk-builder/examples/minimal.json ~/Documents/talks/minha-talk/slides.json
# 3. Build
~/Documents/talk-builder/build.sh ~/Documents/talks/minha-talk
# 4. Abre
open -a "/Applications/Keynote.app" ~/Documents/talks/minha-talk/output/slides.pptx
```

Opção `quick` pula a renderização dos diagramas (usa cache):
```bash
~/Documents/talk-builder/build.sh ~/Documents/talks/minha-talk quick
```

## Documentação

- `SCHEMA.md` — todos os templates com exemplos
- `examples/minimal.json` — exemplo mínimo (6 slides)

## Estrutura

```
talk-builder/
├── build.sh                    ← entrypoint
├── SCHEMA.md
├── scripts/
│   ├── render_mermaid.py       ← mermaid → png (cache por sha1)
│   └── build_pptx.py           ← json → pptx
├── assets/
│   ├── mermaid-config.json     ← tema escuro do mermaid
│   └── puppeteer.json          ← args do chrome headless
└── examples/minimal.json

talks/<sua-talk>/
├── slides.json                 ← único arquivo que você edita
├── assets/diagrams/            ← gerado (cache de pngs)
└── output/
    ├── slides.pptx             ← deliverable
    └── slides.notes.md         ← speaker notes (Keynote não importa embutido)
```

## Atalho global (opcional)

```bash
ln -s ~/Documents/talk-builder/build.sh /usr/local/bin/talk-build
# Agora: talk-build ~/Documents/talks/minha-talk
```
