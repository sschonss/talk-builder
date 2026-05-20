# Talk Chat

Web app local para criar palestras conversando com um LLM. Cada talk vira um `slides.json` em `~/Documents/talks/<slug>/` e pode ser exportada para `.pptx` (abre direto no Keynote) via talk-builder com um clique.

Suporta múltiplos provedores de LLM, streaming de respostas, busca semântica entre todas as suas talks, snapshots automáticos e auto-contexto a partir do seu histórico.

---

## Requisitos

- Node 18+
- talk-builder em `~/Documents/talk-builder/` com `build.sh` + dependências (Python, python-pptx, mermaid-cli)
- Pelo menos um provedor de LLM configurado:
  - `copilot` CLI (recomendado, gratuito com plano Copilot)
  - `claude` CLI
  - `opencode` CLI
  - API key Anthropic
  - API key OpenAI
- Opcional, para vetorização: [Ollama](https://ollama.com) + `ollama pull nomic-embed-text`

## Rodar

```bash
cd ~/Documents/talk-builder/web
npm install
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:5174

Abra sempre no Chrome para garantir compatibilidade com SSE e renderização de SVG do mermaid.

---

## Fluxo básico

1. Crie uma talk (título na sidebar).
2. Converse: descreva tema, público, duração. Peça pesquisa, peça pra adicionar/editar slides.
3. Toda resposta do LLM que muda o deck regrava `slides.json` automaticamente.
4. Acompanhe o **Preview Fiel** (renderiza slide a slide igual ao pptx final, com diagramas mermaid renderizados em SVG) ou o **Resumo** (vista de filmstrip rápida).
5. Quando estiver bom: **Build rápido** (usa cache de diagramas) ou **Build completo** (renderiza tudo do zero).
6. **Abrir Keynote** para revisar.

---

## Provedores de LLM

Configurável em **Configurações** (engrenagem no header).

| Provedor   | Tipo | Streaming real | Observações                                  |
|------------|------|----------------|----------------------------------------------|
| copilot    | CLI  | parcial        | Default Claude Sonnet 4.7. Dropdown de modelos pré-definidos. |
| claude     | CLI  | parcial        | Default Sonnet 4.5. Modelo livre.            |
| opencode   | CLI  | parcial        | Agnóstico. Formato `provider/model`.         |
| anthropic  | API  | sim            | Token-by-token via SSE upstream.             |
| openai     | API  | sim            | Token-by-token via SSE upstream.             |

> CLIs emitem texto perto do fim (depois de tool calls), então o "streaming" mostra chunks de stdout, não tokens individuais.

### Salvar configuração

Só é possível salvar após o botão **Testar** retornar OK. O teste roda um prompt mínimo (`Responda apenas com a palavra: pong`) com timeout de 30s e mede latência. Mudou qualquer campo? O teste invalida e força novo teste.

Config persiste em `~/Documents/talks/.config.json` (modo 600, API keys nunca commitadas).

---

## Streaming

### Chat
`POST /api/talks/:slug/message/stream` (SSE)

Eventos: `start`, `chunk` (delta de texto), `log` (stderr), `done` (slides finais + slides_mtime), `error`.

A mensagem do assistente aparece progressivamente no chat. A animação de "pensando" some assim que chega o primeiro chunk.

### Build
`POST /api/talks/:slug/build/stream` (SSE)

Stdout/stderr do `build.sh` viram eventos `log`. Aparecem em um overlay no rodapé do chat-pane com auto-scroll. Fecha sozinho ~2s após `done`.

---

## Snapshots + backup

Toda gravação de `slides.json` aciona rotação em `<talk>/.history/`:
- `slides-1.json` ← versão sendo substituída (mais recente do histórico)
- `slides-2.json` ← penúltima
- `slides-3.json` ← antepenúltima (oldest, descartada na próxima rotação)

Antes de **toda** chamada ao LLM, o `slides.json` atual é copiado para `<talk>/.history/latest.bak.json`. Se a resposta do LLM voltar com JSON estruturalmente inválido (sem `presentation` ou `slides`), o `.bak` é restaurado automaticamente.

Os 3 snapshots são injetados no prompt como contexto ("Versões anteriores deste deck"), dando ao LLM noção da evolução. Não há UI de "desfazer" por design — é só contexto.

---

## Vetorização (embeddings)

Worker background em `server/embeddings.js` chama Ollama (`nomic-embed-text`, 768 dimensões) a cada 15s para vetorizar registros pendentes (`embedding IS NULL`). Vetores são guardados como BLOB Float32 nas colunas `chats.embedding` e `slides.embedding` do SQLite.

### Status

Rodapé da sidebar mostra:
```
● ollama on · 423/598 vetorizados
```

Endpoint: `GET /api/index/embed-status` → `{pending_chats, pending_slides, done_chats, done_slides, ollama: {ok, error, model}}`.

Forçar processamento agora: `POST /api/index/embed-now`.

### Sem Ollama

Tudo degrada graciosamente: FTS continua funcionando, painéis semânticos ficam vazios, worker tenta a cada 15s sem crashar.

Para ativar:
```bash
brew install ollama
ollama serve &
ollama pull nomic-embed-text
```

---

## Busca

Input na sidebar (debounce 300ms) chama `GET /api/search?q=...&semantic=1&limit=10`.

Três seções de resultado:
- **Semântica** — top hits por cosine similarity entre o embedding da query e os embeddings de chats/slides
- **Slides (texto)** — FTS5 nos slides com snippets `<mark>highlighted</mark>`
- **Chats** — FTS5 nas mensagens

Cada hit é clicável e abre a talk + slide correspondente.

---

## Talks parecidas

Ao abrir uma talk: `GET /api/talks/:slug/similar?limit=5` retorna top N talks por cosine similarity entre embeddings médios dos decks. Painel aparece na sidebar com % de similaridade.

---

## Auto-contexto

Antes de cada chamada ao LLM, `buildSimilarContext` busca os top 3 slides mais relevantes ao input do usuário **em outras talks** (threshold cosine > 0.5) e injeta no system prompt como "talks anteriores relevantes". Permite reaproveitar narrativas e padrões sem o usuário precisar lembrar.

---

## Endpoints

| Método | Path                                  | O quê                                          |
|--------|---------------------------------------|------------------------------------------------|
| GET    | `/api/health`                         | Status do provedor ativo                       |
| GET    | `/api/providers`                      | Lista provedores + config atual                |
| PUT    | `/api/providers`                      | Salva config                                   |
| POST   | `/api/providers/test`                 | Testa config draft sem persistir               |
| GET    | `/api/talks`                          | Lista talks                                    |
| POST   | `/api/talks`                          | Cria talk `{title}`                            |
| GET    | `/api/talks/:slug`                    | slides + messages + slides_mtime               |
| PATCH  | `/api/talks/:slug`                    | Renomeia `{title}`                             |
| DELETE | `/api/talks/:slug`                    | Apaga talk                                     |
| POST   | `/api/talks/:slug/message`            | Manda mensagem (sync, sem streaming)           |
| POST   | `/api/talks/:slug/message/stream`     | Manda mensagem com streaming SSE               |
| POST   | `/api/talks/:slug/build`              | Build sync                                     |
| POST   | `/api/talks/:slug/build/stream`       | Build com log SSE                              |
| POST   | `/api/talks/:slug/open`               | Abre pptx no Keynote                           |
| GET    | `/api/talks/:slug/similar?limit=N`    | Talks parecidas                                |
| GET    | `/api/search?q=...&semantic=1`        | Busca FTS + opcional semântica                 |
| GET    | `/api/index/embed-status`             | Status do worker                               |
| POST   | `/api/index/embed-now`                | Roda batch já                                  |

---

## Arquitetura

```
web/
├── server/
│   ├── index.js         # Express + rotas + SSE + snapshots
│   ├── providers.js     # 5 providers, cada um com run + stream
│   ├── config.js        # ~/Documents/talks/.config.json (chmod 600)
│   ├── db.js            # SQLite + FTS5 + embedding BLOBs
│   ├── embeddings.js    # Worker Ollama (nomic-embed-text, 768d)
│   └── similar.js       # cosine, KNN, auto-contexto
└── src/
    ├── App.vue          # UI principal (chat + sidebar + busca + similar)
    ├── FidelitySlide.vue # Preview fiel (1280×720 escalado, mermaid SVG)
    └── ...
```

### Armazenamento
```
~/Documents/talks/
├── .config.json         # provedores + API keys (chmod 600)
├── .index.db            # SQLite (chats, slides, FTS5, embeddings)
└── <slug>/
    ├── slides.json      # source of truth
    ├── chat.json        # histórico de mensagens
    ├── slides.pptx      # gerado pelo build
    └── .history/
        ├── latest.bak.json   # backup pré-LLM (restaurado se JSON inválido)
        ├── slides-1.json     # snapshot mais recente
        ├── slides-2.json
        └── slides-3.json     # mais antigo
```

---

## Decisões técnicas

- **SSE em vez de WebSocket** — comunicação one-way LLM→cliente. SSE é mais simples e suficiente.
- **EventSource não é usado** — só suporta GET; usamos `fetch` + `ReadableStream` + parser manual de `event:/data:` (helper `sseRequest()` em App.vue).
- **better-sqlite3** — API síncrona, native bindings, WAL mode. Mais previsível que `sqlite3`.
- **Embeddings como BLOB Float32** — `Buffer.from(Float32Array.buffer)`. Decode: `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength/4)`.
- **Worker desacoplado do save** — não bloqueia request; registros novos só esperam o próximo tick (≤15s).
- **Salvar só após testar** — botão Save desabilitado até `testResult.ok === true`. Mudou um campo? Invalida o teste.
- **Sem emojis na UI** — política da casa.
- **Mermaid tema dark + accent `#FF4013`** — combina com a paleta do app.

---

## Variáveis de ambiente

| Var              | Default                             | O quê                                 |
|------------------|-------------------------------------|---------------------------------------|
| `OLLAMA_URL`     | `http://localhost:11434`            | Endpoint do Ollama                    |
| `EMBED_MODEL`    | `nomic-embed-text`                  | Modelo de embedding. String vazia desabilita o worker. |
| `TALKS_DIR`      | `~/Documents/talks`                 | Pasta raiz das talks                  |
| `TALK_BUILDER`   | `~/Documents/talk-builder`          | Pasta do talk-builder                 |
| `PORT`           | `5174`                              | Porta da API                          |

---

## Troubleshooting

**"Ollama offline" no rodapé** — Ollama não está rodando. `ollama serve &` ou ignore (degrade gracioso).

**Build falha sem mensagem clara** — abra o overlay de log; stdout do `build.sh` aparece em tempo real.

**LLM corrompeu meu slides.json** — restauração automática do `.bak` já cobre. Snapshots em `.history/slides-N.json` se precisar voltar manualmente.

**Streaming "trava"** — copilot CLI faz tool calls antes de emitir texto; é normal demorar 5-15s no primeiro chunk.

**Save desabilitado** — clica em Testar primeiro. Mudou campo depois do teste? Testa de novo.
