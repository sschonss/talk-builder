# Talk Builder — Schema de slides.json

Engine reutilizável pra transformar JSON em apresentação Keynote/PowerPoint.

## Estrutura raiz

```json
{
  "presentation": {
    "title": "Nome da Talk",
    "author": "Seu Nome",
    "event": "Onde vai apresentar"
  },
  "theme": {
    "config": {
      "colors": {
        "background": "#000000",
        "primary":    "#FFFFFF",
        "secondary":  "#FF4013",
        "text":       "#FFFFFF"
      },
      "fonts": {
        "heading": "Inter",
        "body":    "Inter",
        "code":    "Menlo"
      }
    }
  },
  "slides": [
    { "order": 0, "template": "cover", "data": {...} },
    { "order": 1, "template": "content", "data": {...} }
  ]
}
```

`theme` é **opcional** (defaults: fundo preto, texto branco, accent laranja `#FF4013`, fonte Inter/Menlo).

## Templates disponíveis

Cada slide tem `template` + `data`. Campos em **negrito** são obrigatórios.

### `cover` — capa
```json
{ "template": "cover", "data": {
  "title": "Microservices",
  "subtitle": "Criando aplicações de alta escala",
  "author": "Luiz Schons",
  "event": "Tech Talk 2026"
}}
```

### `bio` — quem é o palestrante
```json
{ "template": "bio", "data": {
  "name": "Luiz Schons",
  "role": "Software Engineer @ PicPay",
  "bullets": ["10+ anos em sistemas distribuídos", "Trabalhei com Kafka, Go, Java"],
  "github": "sschonss",
  "linkedin": "luizschons",
  "photo_url": "(opcional, URL)"
}}
```
Aliases aceitos: `title` ↔ `name`, `github_username` ↔ `github`.

### `agenda` — sumário
```json
{ "template": "agenda", "data": {
  "title": "O que vamos ver hoje",
  "items": ["O monolito", "Microservices", "Padrões de resiliência", "Observabilidade"]
}}
```

### `section` — separador de seção (texto grande)
```json
{ "template": "section", "data": { "number": "01", "title": "O Cenário" }}
```
Aliases para `number`: `block`, `section_number`.

### `question` — slide-pergunta (texto centralizado, sem resposta)
```json
{ "template": "question", "data": { "question": "O que são microservices de verdade?" }}
```

### `answer` — resposta de uma question
```json
{ "template": "answer", "data": {
  "question": "O que são microservices de verdade?",
  "bullets": ["Serviços pequenos e independentes", "Comunicação via rede", "Deploy independente"]
}}
```

### `content` — slide padrão de bullets (o mais usado)
```json
{ "template": "content", "data": {
  "title": "Aplicações Stateless",
  "subtitle": "(opcional)",
  "bullets": ["Não guarda estado local", "Qualquer réplica responde", "Escala horizontal trivial"],
  "quote": "(opcional) Pearl de sabedoria no rodapé",
  "glossary": [
    {"term": "Stateless", "def": "Sem estado entre requisições"},
    {"term": "Round-robin", "def": "Distribuição cíclica"}
  ]
}}
```
`glossary` é opcional (até 4 itens, renderiza em painel 2x2 no rodapé).

### `comparison` — duas colunas lado a lado
Aceita dois formatos equivalentes:

**Aninhado:**
```json
{ "template": "comparison", "data": {
  "title": "Monolito vs Microservices",
  "left":  { "title": "Monolito",      "bullets": ["Simples", "Acoplado"] },
  "right": { "title": "Microservices", "bullets": ["Complexo", "Independente"] }
}}
```
**Plano (também funciona):**
```json
{ "template": "comparison", "data": {
  "title": "Monolito vs Microservices",
  "left_title": "Monolito",       "left_items":  ["Simples", "Acoplado"],
  "right_title": "Microservices", "right_items": ["Complexo", "Independente"]
}}
```

### `diagram` — slide com diagrama Mermaid (renderizado automaticamente em PNG)
```json
{ "template": "diagram", "data": {
  "title": "Circuit Breaker",
  "caption": "(opcional) Texto abaixo do diagrama",
  "mermaid_code": "graph LR\n  A[Client] --> B[Service]\n  B -->|falha| C[Fallback]"
}}
```
⚠️ **Mermaid gotchas**: parênteses em labels quebram. Use aspas: `-->|"label · texto"|`.

### `code` — bloco de código
```json
{ "template": "code", "data": {
  "title": "Idempotency key",
  "language": "go",
  "code": "if cache.Has(key) {\n  return cache.Get(key)\n}\nresult := process()\ncache.Set(key, result)"
}}
```

### `story` — timeline / história
```json
{ "template": "story", "data": {
  "title": "A noite em que tudo caiu",
  "steps": [
    {"time": "23:42", "event": "Spike de tráfego 10x"},
    {"time": "23:45", "event": "Pool de conexões esgotado"},
    {"time": "00:12", "event": "Cascading failure"}
  ]
}}
```

### `metrics` — 4 stats antes/depois (cards grandes)
```json
{ "template": "metrics", "data": {
  "title": "Resultados",
  "stats": [
    {"label": "Latência p99", "before": "1200ms", "after": "180ms"},
    {"label": "Deploys/dia",  "before": "1",      "after": "40"},
    {"label": "MTTR",         "before": "4h",     "after": "12min"},
    {"label": "Disponibilidade","before": "99.5%","after": "99.95%"}
  ],
  "footnote": "MTTR = Mean Time To Recovery. Números ilustrativos."
}}
```

### `takeaways` — lista numerada de aprendizados
```json
{ "template": "takeaways", "data": {
  "title": "O que levar pra casa",
  "items": ["Resiliência > escala", "Idempotência salva", "Observabilidade desde o dia 1"]
}}
```

### `transition` — slide curto entre seções
```json
{ "template": "transition", "data": { "text": "Vamos pra parte prática" }}
```

### `closing` — frase final gigante
```json
{ "template": "closing", "data": { "text": "Obrigado!" }}
```

### `credits` — agradecimentos / referências
```json
{ "template": "credits", "data": {
  "title": "Obrigado!",
  "contacts": ["github.com/sschonss", "linkedin.com/in/luizschons"],
  "references": ["Building Microservices, Sam Newman", "Release It!, Michael Nygard"]
}}
```

## Speaker notes

Qualquer slide pode ter `"notes": "..."` dentro de `data`. Vai pra `output/slides.notes.md` (Keynote não importa notes embutidas).

## Como rodar

```bash
# Pasta da talk: precisa ter slides.json na raiz
mkdir ~/Documents/talks/minha-talk
# Coloca slides.json lá

# Build full (renderiza mermaid + gera pptx)
~/Documents/talk-builder/build.sh ~/Documents/talks/minha-talk

# Build quick (pula mermaid se já tem cache)
~/Documents/talk-builder/build.sh ~/Documents/talks/minha-talk quick

# Abre no Keynote
open -a "/Applications/Keynote.app" ~/Documents/talks/minha-talk/output/slides.pptx
```

## Dicas

- Em-dashes (`—`) parecem texto gerado por IA. Evite.
- `content` é o template mais flexível. Comece tudo nele e migre pra templates específicos só quando fizer sentido.
- Diagramas mermaid são cacheados pelo SHA1 do código. Mudou 1 caractere = re-renderiza.
- 16:9 widescreen (13.333" × 7.5"). Imagens são auto-fit preservando aspect ratio.
- Pra um slide sem rodapé/número, use `cover`, `closing` ou `credits`.
