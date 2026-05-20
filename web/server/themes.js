export const THEMES = {
  midnight: {
    label: 'Midnight Red',
    config: {
      colors: { background: '#000000', primary: '#FFFFFF', secondary: '#FF4013', text: '#FFFFFF' },
      fonts: { heading: 'Inter', body: 'Inter', code: 'Menlo' },
    },
  },
  paper: {
    label: 'Paper White',
    config: {
      colors: { background: '#FAFAF7', primary: '#1A1A1A', secondary: '#C8553D', text: '#1A1A1A' },
      fonts: { heading: 'Georgia', body: 'Georgia', code: 'Menlo' },
    },
  },
  ocean: {
    label: 'Deep Ocean',
    config: {
      colors: { background: '#0B1F3A', primary: '#E8F1FF', secondary: '#5BC0EB', text: '#E8F1FF' },
      fonts: { heading: 'Inter', body: 'Inter', code: 'JetBrains Mono' },
    },
  },
  forest: {
    label: 'Forest',
    config: {
      colors: { background: '#10241C', primary: '#F2E8CF', secondary: '#A7C957', text: '#F2E8CF' },
      fonts: { heading: 'Inter', body: 'Inter', code: 'Menlo' },
    },
  },
  sunset: {
    label: 'Sunset',
    config: {
      colors: { background: '#2D1B2E', primary: '#FFE8D6', secondary: '#FFB997', text: '#FFE8D6' },
      fonts: { heading: 'Inter', body: 'Inter', code: 'Menlo' },
    },
  },
  mono: {
    label: 'Mono Mint',
    config: {
      colors: { background: '#FFFFFF', primary: '#0A2F23', secondary: '#28A745', text: '#0A2F23' },
      fonts: { heading: 'Helvetica Neue', body: 'Helvetica Neue', code: 'Menlo' },
    },
  },
  terminal: {
    label: 'Terminal',
    config: {
      colors: { background: '#0A0A0A', primary: '#39FF14', secondary: '#FFB000', text: '#C8E6C9' },
      fonts: { heading: 'JetBrains Mono', body: 'JetBrains Mono', code: 'JetBrains Mono' },
    },
  },
  newsprint: {
    label: 'Newsprint',
    config: {
      colors: { background: '#F4EFE6', primary: '#1F1B16', secondary: '#8B2A2A', text: '#1F1B16' },
      fonts: { heading: 'Playfair Display', body: 'Georgia', code: 'Menlo' },
    },
  },
}

export function listThemes() {
  return Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label, config: t.config }))
}

export function getTheme(id) {
  return THEMES[id] || null
}

function hashStr(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return Math.abs(h)
}

export function pickThemeForTitle(title) {
  const ids = Object.keys(THEMES)
  const h = hashStr(String(title || 'talk'))
  return ids[h % ids.length]
}
