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

## Modos de edição (planner vs clássico)

Decks grandes (100+ slides) sofrem com a estratégia clássica, onde o LLM regenera o `slides.json` inteiro a cada turno. Isso gera timeouts, perde trabalho parcial e força o modelo a repensar o deck todo só para mexer em 3 slides.

O **planner** quebra isso: o LLM faz duas passagens, e cada passagem trabalha com pouco contexto.

### Como funciona

1. **Planner** (`POST /api/talks/:slug/plan`): recebe o pedido do usuário e o resumo do deck (só `idx`, `title`, `template` de cada slide). Devolve um plano com `preamble` + lista de ações:
   - `edit_slide(idx, instruction)` — muda 1 slide
   - `add_slides(after, count, topic, template_hint?)` — insere N novos
   - `remove_slide(idx)` — apaga (DESTRUTIVA)
   - `move_slide(from, to)` — reordena
   - `set_meta(patch)` — muda título/autor/tema
   - `bulk_edit(filter, transform)` — aplica transformação em vários (filter: `{template?, idx_range?, title_contains?}`)
   - `replace_section(start, end, instruction)` — substitui faixa (DESTRUTIVA)
   - `regenerate_slide(idx, instruction)` — regenera do zero
2. **UI mostra o plano** como cartão: preâmbulo + lista de ações + botões `[Cancelar] [Executar]` e checkbox "Sempre executar nesta sessão" (apenas em memória, reseta no reload).
3. **Executor** (`POST /api/talks/:slug/execute/stream`, SSE): roda uma ação por vez. Para ações que exigem LLM (`edit_slide`, `add_slides`, etc.), monta um prompt focado no slide afetado + vizinhos imediatos + resumo compacto do deck (sem o JSON completo). Aplica o resultado, salva snapshot, e segue.
4. **Retry**: se uma ação falhar (JSON inválido), tenta uma segunda vez com o erro anterior anexado ao prompt. Se falhar de novo, para e mostra `[Tentar essa ação de novo] [Remandar prompt do zero]`.

### Configuração

Em **Configurações → Modo de edição**:

| Modo | Comportamento |
|------|---------------|
| `auto` (padrão) | Usa planner quando o deck tem ≥ `planner_threshold` slides (padrão 30) |
| `classic` | Sempre clássico (regenera deck inteiro) |
| `planner` | Sempre planner |

### Confirmação

- Por padrão o plano sempre pede confirmação.
- Marcando "Sempre executar nesta sessão" o plano roda automaticamente — **exceto** se contiver ações destrutivas (`remove_slide`, `replace_section`), que sempre exigem confirmação explícita.

### Segurança

- `backupBeforeLLM` corre antes do planner *e* antes do executor.
- Cada ação aplicada rotaciona um snapshot regular (`.history/slides-1/2/3.json`).
- Se o planner devolver um JSON estruturalmente inválido, o endpoint retorna 422 sem tocar em nada.

### Resumir / aplicar mais tarde

Quando você manda um pedido em modo planner, o servidor:
1. Salva o plano em `chat.json` como mensagem `kind: 'plan'` (status `awaiting`).
2. Mantém o estado em memória (`server/plans.js`).
3. Recarregar a página: `openTalk` chama `GET /plan/state`; se houver plano ativo, reconecta no `GET /plan/stream` e o cartão volta com o progresso atual.

Cancelar: `POST /plan/cancel` levanta a flag — a execução para entre ações.

Tokens consumidos (estimativa `chars / 4`) são reportados por ação e somados no rodapé do cartão. Provedores CLI não devolvem contagem real.

### Contexto e compactação

Botão `ctx Nk` no header mostra a estimativa de quanto contexto vai por turno:

- **Prompt clássico** = todo o chat + slides.json completo
- **Prompt planner** = resumo do deck + últimas 6 mensagens

`POST /api/talks/:slug/chat/compact` chama o LLM pra resumir todas as mensagens menos as N mais recentes (`keep_last`, padrão 4) em uma única mensagem `system`. Útil pra decks usados há muito tempo, onde o histórico fica caro no modo clássico.

Quando o chat passa de `autocompact_threshold_tokens` (padrão 8000), aparece um banner sugerindo a compactação antes do próximo turno.

---

## Themes (estilo por talk)

Cada talk tem uma identidade visual própria no `slides.json` (`theme.id` + `theme.config.{colors,fonts}`), consumida pelo `build_pptx.py`.

8 temas curados em `server/themes.js`: `midnight`, `paper`, `ocean`, `forest`, `sunset`, `mono`, `terminal`, `newsprint`.

- Talks novas escolhem um tema deterministicamente pelo hash do título.
- Botão `tema X` no header abre o seletor visual.
- API: `GET /api/themes`, `POST /api/talks/:slug/theme {id}`.

---

## Cache de LLM

`server/cache.js` guarda `sha256(provider + model + prompt) → reply` em `~/Documents/talks/.llm-cache/`. TTL de 7 dias, LRU de no máximo 2000 arquivos.

- Toda chamada do executor passa pelo cache antes de bater no provider.
- Útil em retries (mesmo prompt sai do cache) e em desenvolvimento.
- Cada ação no cartão mostra um badge `cache` quando a resposta veio dali.
- API: `GET /api/cache/stats`, `POST /api/cache/clear`.
- Override de diretório: `TALK_CACHE_DIR=...`.
- Desligar via Settings → Cache e contexto.

---

## Paralelização e streaming por ação

O executor agrupa ações **não-shifting** (`edit_slide`, `regenerate_slide`, `set_meta`) em lotes de até `planner_concurrency` (padrão 3, máx 8) que rodam o LLM em paralelo (`Promise.all`) sobre um snapshot. Aplicação no `slides.json` continua sequencial dentro do lote para preservar a ordem.

Ações que mexem em índice (`add_slides`, `remove_slide`, `move_slide`, `replace_section`, `bulk_edit`) sempre rodam sozinhas.

Cada ação usa `streamProvider`: SSE emite `action_chunk { i, text, len, cached }`. O cartão mostra os chars acumulados em tempo real (`... tentativa 1 · Nc`).

---

## Edição do plano antes de executar

Enquanto o plano está com status `awaiting`, você pode:

- **Editar a instrução** de qualquer ação (botão `editar` na linha)
- **Remover** uma ação (botão `×`)

Persistência via `PATCH /api/talks/:slug/plan { actions }`. Editar resetando `progress`. Não é permitido durante execução.

---

## Modelo separado pro planner

`planner_provider` e `planner_model` (opcionais) deixam o planner rodar num modelo diferente do executor. Vazio = mesmo do executor. Útil pra usar um modelo barato/rápido só pra estruturar o JSON.

---

---

## Vetorização (embeddings)

Worker background em `server/embeddings.js` chama Ollama (`nomic-embed-text`, 768 dimensões) a cada 15s para vetorizar registros pendentes (`embedding IS NULL`). Vetores são guardados como BLOB Float32 nas colunas `chats.embedding` e `slides.embedding` do SQLite.

### Setup (macOS)

```bash
# 1. Instala (uma vez)
brew install ollama

# 2. Sobe o daemon
open -a Ollama          # ou: ollama serve &

# 3. Baixa o modelo (~274 MB, uma vez)
ollama pull nomic-embed-text

# 4. Confere
curl -s http://localhost:11434/api/tags
```

A partir daí o worker do talk-chat detecta sozinho (poll a cada 15s) e começa a processar.

### Status

Rodapé da sidebar mostra:
```
● ollama on · 423/598 vetorizados
```

Endpoint: `GET /api/index/embed-status` → `{pending_chats, pending_slides, done_chats, done_slides, ollama: {ok, error, model}}`.

### Forçar processamento

Por padrão o worker processa 10 chats + 10 slides por tick (15s). Para vetorizar tudo rápido:

```bash
# Dispara um batch agora
curl -X POST http://localhost:5174/api/index/embed-now

# Ou em loop até zerar
while true; do
  r=$(curl -s -X POST http://localhost:5174/api/index/embed-now)
  echo "$r" | grep -q '"pending_slides":0' && break
done
```

### Slides vazios

Se algum slide tem `content` vazio (length 0), o Ollama recusa e o worker fica re-tentando para sempre. Marca manualmente como ignorado:

```bash
sqlite3 ~/Documents/talks/.index.db \
  "UPDATE slides SET embedding = X'00' WHERE length(content) = 0;"
```

(Um BLOB de 1 byte serve como sentinela "tentei e não tem conteúdo".)

### Sem Ollama

Tudo degrada graciosamente: FTS continua funcionando, painéis semânticos ficam vazios, worker tenta a cada 15s sem crashar.

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
