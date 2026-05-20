<script setup>
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import mermaid from 'mermaid'

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  themeVariables: {
    primaryColor: '#1a1a1a',
    primaryTextColor: '#ffffff',
    primaryBorderColor: '#FF4013',
    lineColor: '#FF4013',
    fontFamily: 'Inter, sans-serif',
  },
})

const props = defineProps({
  slide: { type: Object, required: true },
  theme: { type: Object, default: () => ({}) },
})

const colors = computed(() => {
  const c = (props.theme && props.theme.config && props.theme.config.colors) || {}
  return {
    bg: c.background || '#000000',
    primary: c.primary || '#FFFFFF',
    secondary: c.secondary || '#FF4013',
    text: c.text || '#FFFFFF',
  }
})

const stage = ref(null)
const scale = ref(1)
const mermaidSvg = ref('')
const mermaidErr = ref('')
let mermaidCounter = 0

async function renderMermaid() {
  mermaidErr.value = ''
  mermaidSvg.value = ''
  if (props.slide.template !== 'diagram') return
  const code = props.slide.data?.mermaid_code
  if (!code || !code.trim()) return
  try {
    const id = `mmd-${++mermaidCounter}`
    const { svg } = await mermaid.render(id, code)
    mermaidSvg.value = svg
  } catch (e) {
    mermaidErr.value = e.message || String(e)
  }
}

watch(() => [props.slide.template, props.slide.data?.mermaid_code], renderMermaid, { immediate: false })

function fit() {
  if (!stage.value) return
  const wrap = stage.value.parentElement
  if (!wrap) return
  const w = wrap.clientWidth
  const h = wrap.clientHeight
  const s = Math.min(w / 1280, h / 720)
  scale.value = s > 0 ? s : 1
}

let ro
onMounted(() => {
  fit()
  ro = new ResizeObserver(fit)
  if (stage.value && stage.value.parentElement) ro.observe(stage.value.parentElement)
  renderMermaid()
})
onBeforeUnmount(() => { if (ro) ro.disconnect() })

const data = computed(() => props.slide.data || {})
const tpl = computed(() => props.slide.template)
</script>

<template>
  <div class="fidel-wrap">
    <div
      ref="stage"
      class="fidel-stage"
      :style="{
        transform: `scale(${scale})`,
        background: colors.bg,
        color: colors.text,
      }"
    >
      <!-- COVER -->
      <div v-if="tpl === 'cover'" class="layout-cover">
        <div class="accent-bar" :style="{ background: colors.secondary }"></div>
        <h1 :style="{ color: colors.primary }">{{ data.title }}</h1>
        <h2 v-if="data.subtitle" :style="{ color: colors.secondary }">{{ data.subtitle }}</h2>
        <p v-if="data.author" class="cover-author">{{ data.author }}</p>
        <p v-if="data.event" class="cover-event">{{ data.event }}</p>
      </div>

      <!-- SECTION -->
      <div v-else-if="tpl === 'section'" class="layout-section">
        <div class="section-num" :style="{ color: colors.secondary }" v-if="data.number">{{ data.number }}</div>
        <h1 :style="{ color: colors.primary }">{{ data.title }}</h1>
        <p v-if="data.subtitle">{{ data.subtitle }}</p>
      </div>

      <!-- QUESTION -->
      <div v-else-if="tpl === 'question'" class="layout-question">
        <p v-if="data.label" class="q-label" :style="{ color: colors.secondary }">{{ data.label }}</p>
        <h1 :style="{ color: colors.primary }">{{ data.question }}</h1>
      </div>

      <!-- CLOSING -->
      <div v-else-if="tpl === 'closing'" class="layout-closing">
        <h1 :style="{ color: colors.primary }">{{ data.text }}</h1>
        <p v-if="data.author">— {{ data.author }}</p>
      </div>

      <!-- COMPARISON -->
      <div v-else-if="tpl === 'comparison'" class="layout-default">
        <h2 v-if="data.title" :style="{ color: colors.primary }">{{ data.title }}</h2>
        <div class="comp-cols">
          <div class="comp-col">
            <h3 :style="{ color: colors.secondary }">{{ data.left_title }}</h3>
            <ul>
              <li v-for="(x, i) in (data.left_items || [])" :key="i">
                <span class="bullet" :style="{ color: colors.secondary }">•</span>{{ x }}
              </li>
            </ul>
          </div>
          <div class="comp-col">
            <h3 :style="{ color: colors.secondary }">{{ data.right_title }}</h3>
            <ul>
              <li v-for="(x, i) in (data.right_items || [])" :key="i">
                <span class="bullet" :style="{ color: colors.secondary }">•</span>{{ x }}
              </li>
            </ul>
          </div>
        </div>
      </div>

      <!-- METRICS -->
      <div v-else-if="tpl === 'metrics'" class="layout-default">
        <h2 v-if="data.title" :style="{ color: colors.primary }">{{ data.title }}</h2>
        <div class="metrics-grid">
          <div v-for="(st, i) in (data.stats || [])" :key="i" class="metric-card">
            <div class="metric-label">{{ st.label }}</div>
            <div class="metric-row">
              <span class="before">{{ st.before }}</span>
              <span class="arrow" :style="{ color: colors.secondary }">→</span>
              <span class="after" :style="{ color: colors.secondary }">{{ st.after }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- STORY -->
      <div v-else-if="tpl === 'story'" class="layout-default">
        <h2 v-if="data.title" :style="{ color: colors.primary }">{{ data.title }}</h2>
        <div class="story-steps">
          <div v-for="(st, i) in (data.steps || [])" :key="i" class="story-row">
            <span class="story-time" :style="{ color: colors.secondary }">{{ st.time }}</span>
            <span class="story-event">{{ st.event }}</span>
          </div>
        </div>
      </div>

      <!-- CODE -->
      <div v-else-if="tpl === 'code'" class="layout-default">
        <h2 v-if="data.title" :style="{ color: colors.primary }">{{ data.title }}</h2>
        <pre class="code-block"><code>{{ data.code }}</code></pre>
        <p v-if="data.caption" class="caption">{{ data.caption }}</p>
      </div>

      <!-- DIAGRAM -->
      <div v-else-if="tpl === 'diagram'" class="layout-default">
        <h2 v-if="data.title" :style="{ color: colors.primary }">{{ data.title }}</h2>
        <div class="diag-render" v-if="mermaidSvg" v-html="mermaidSvg"></div>
        <div class="diag-placeholder" v-else>
          <p class="diag-tag" :style="{ color: colors.secondary }">{{ mermaidErr ? 'erro no mermaid' : '[ diagrama mermaid ]' }}</p>
          <pre v-if="mermaidErr">{{ mermaidErr }}</pre>
          <pre v-else-if="data.mermaid_code">{{ data.mermaid_code }}</pre>
        </div>
        <p v-if="data.caption" class="caption">{{ data.caption }}</p>
      </div>

      <!-- CREDITS -->
      <div v-else-if="tpl === 'credits'" class="layout-default">
        <h2 v-if="data.title" :style="{ color: colors.primary }">{{ data.title }}</h2>
        <ul class="credits-list" v-if="data.contacts">
          <li v-for="(c, i) in data.contacts" :key="i">
            <span class="bullet" :style="{ color: colors.secondary }">•</span>{{ c }}
          </li>
        </ul>
        <p v-if="data.references" class="caption">
          {{ data.references.length }} referência{{ data.references.length === 1 ? '' : 's' }}
        </p>
      </div>

      <!-- CONTENT / DEFAULT -->
      <div v-else class="layout-default">
        <h2 v-if="data.title" :style="{ color: colors.primary }">{{ data.title }}</h2>
        <p v-if="data.subtitle" class="subtitle">{{ data.subtitle }}</p>
        <ul v-if="Array.isArray(data.bullets)">
          <li v-for="(b, i) in data.bullets" :key="i">
            <span class="bullet" :style="{ color: colors.secondary }">•</span>{{ b }}
          </li>
        </ul>
        <ul v-if="Array.isArray(data.items)">
          <li v-for="(b, i) in data.items" :key="i">
            <span class="bullet" :style="{ color: colors.secondary }">•</span>{{ b }}
          </li>
        </ul>
        <p v-if="data.quote" class="quote">"{{ data.quote }}"</p>
        <p v-if="data.footnote" class="footnote">{{ data.footnote }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fidel-wrap {
  width: 100%;
  aspect-ratio: 16 / 9;
  position: relative;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: #000;
}
.fidel-stage {
  position: absolute;
  top: 0;
  left: 0;
  width: 1280px;
  height: 720px;
  transform-origin: top left;
  font-family: Inter, -apple-system, system-ui, sans-serif;
  padding: 64px 96px;
  box-sizing: border-box;
  overflow: hidden;
}

/* COVER */
.layout-cover { display: flex; flex-direction: column; justify-content: center; height: 100%; }
.accent-bar { width: 80px; height: 8px; margin-bottom: 32px; }
.layout-cover h1 { font-size: 72px; font-weight: 800; line-height: 1.1; margin: 0 0 24px; }
.layout-cover h2 { font-size: 36px; font-weight: 500; margin: 0 0 48px; }
.cover-author { font-size: 22px; opacity: 0.8; margin: 0 0 8px; }
.cover-event { font-size: 18px; opacity: 0.6; margin: 0; }

/* SECTION */
.layout-section { display: flex; flex-direction: column; justify-content: center; height: 100%; }
.section-num { font-size: 28px; font-weight: 700; letter-spacing: 2px; margin-bottom: 16px; }
.layout-section h1 { font-size: 84px; font-weight: 800; margin: 0 0 16px; line-height: 1.05; }
.layout-section p { font-size: 26px; opacity: 0.7; margin: 0; }

/* QUESTION */
.layout-question { display: flex; flex-direction: column; justify-content: center; height: 100%; }
.q-label { font-size: 22px; letter-spacing: 4px; text-transform: uppercase; margin: 0 0 24px; }
.layout-question h1 { font-size: 64px; font-weight: 700; line-height: 1.2; margin: 0; }

/* CLOSING */
.layout-closing { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; height: 100%; }
.layout-closing h1 { font-size: 56px; font-weight: 600; font-style: italic; line-height: 1.3; margin: 0 0 24px; max-width: 900px; }
.layout-closing p { font-size: 22px; opacity: 0.7; margin: 0; }

/* DEFAULT / CONTENT */
.layout-default h2 { font-size: 44px; font-weight: 700; margin: 0 0 32px; line-height: 1.15; }
.subtitle { font-size: 22px; opacity: 0.75; margin: -16px 0 24px; }
.layout-default ul { list-style: none; padding: 0; margin: 0; }
.layout-default li { font-size: 24px; line-height: 1.45; margin-bottom: 16px; display: flex; gap: 14px; align-items: flex-start; }
.bullet { font-size: 28px; font-weight: 700; flex-shrink: 0; line-height: 1; margin-top: 2px; }
.quote { font-size: 22px; font-style: italic; opacity: 0.85; border-left: 4px solid currentColor; padding-left: 16px; margin: 24px 0 0; }
.footnote { font-size: 14px; opacity: 0.55; margin-top: 24px; }

/* COMPARISON */
.comp-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; }
.comp-col h3 { font-size: 28px; font-weight: 700; margin: 0 0 20px; }
.comp-col ul { list-style: none; padding: 0; margin: 0; }
.comp-col li { font-size: 20px; line-height: 1.4; margin-bottom: 12px; display: flex; gap: 12px; align-items: flex-start; }

/* METRICS */
.metrics-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.metric-card { background: #141414; border: 1px solid #333; border-radius: 12px; padding: 24px; }
.metric-label { font-size: 16px; opacity: 0.65; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
.metric-row { display: flex; align-items: baseline; gap: 16px; }
.before { font-size: 26px; opacity: 0.55; text-decoration: line-through; }
.arrow { font-size: 28px; }
.after { font-size: 40px; font-weight: 800; }

/* STORY */
.story-steps { display: flex; flex-direction: column; gap: 16px; }
.story-row { display: grid; grid-template-columns: 140px 1fr; align-items: baseline; gap: 24px; padding: 12px 0; border-bottom: 1px solid #222; }
.story-time { font-size: 20px; font-weight: 700; }
.story-event { font-size: 22px; line-height: 1.4; }

/* CODE */
.code-block { background: #0a0a0a; border: 1px solid #222; border-radius: 8px; padding: 24px; font-family: Menlo, Consolas, monospace; font-size: 18px; line-height: 1.5; color: #b8e6c8; overflow: hidden; max-height: 480px; margin: 0; }
.caption { font-size: 16px; opacity: 0.65; margin: 16px 0 0; font-style: italic; }

/* DIAGRAM */
.diag-render { display: flex; justify-content: center; align-items: center; max-height: 480px; }
.diag-render :deep(svg) { max-width: 100%; max-height: 480px; }
.diag-placeholder { border: 2px dashed #333; border-radius: 12px; padding: 32px; text-align: center; }
.diag-tag { font-size: 18px; letter-spacing: 2px; margin: 0 0 16px; }
.diag-placeholder pre { font-family: Menlo, monospace; font-size: 14px; text-align: left; color: #888; max-height: 320px; overflow: hidden; margin: 0; }

/* CREDITS */
.credits-list { list-style: none; padding: 0; margin: 0 0 24px; }
.credits-list li { font-size: 22px; line-height: 1.4; margin-bottom: 12px; display: flex; gap: 12px; }
</style>
